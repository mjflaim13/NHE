#!/usr/bin/env python3
"""ETL for the RX Scoreboard project."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import pandas as pd

GLP1_PATTERN = re.compile(
    r"(semaglutide|tirzepatide|liraglutide|dulaglutide|exenatide|glp\s*-?\s*1|incretin)",
    re.IGNORECASE,
)


class ColumnLookupError(RuntimeError):
    """Raised when a required column is missing."""


def sanitize_key(value: str) -> str:
    """Normalize column headers for matching."""
    return re.sub(r"[\s\-_]+", "", value.strip().lower())


def find_column(
    columns: Sequence[str],
    stem: str,
    year: Optional[int] = None,
) -> Tuple[Optional[str], List[str]]:
    """Return the matching column name, if any, and nearby suggestions."""
    normalized = {col: sanitize_key(str(col)) for col in columns}
    base_key = sanitize_key(stem)
    suggestions = [col for col, key in normalized.items() if key.startswith(base_key)]

    if year is None:
        target = base_key
        matches = [col for col, key in normalized.items() if key == target]
    else:
        target = f"{base_key}{year}"
        matches = [
            col
            for col, key in normalized.items()
            if key == target or key.startswith(target)
        ]
    if len(matches) > 1:
        raise ColumnLookupError(
            f"Multiple columns matched '{stem}'{f' for {year}' if year else ''}: {matches}"
        )
    if matches:
        return matches[0], suggestions
    return None, suggestions


def require_column(
    columns: Sequence[str],
    stem: str,
    dataset: str,
    year: Optional[int] = None,
) -> str:
    column, suggestions = find_column(columns, stem, year=year)
    if column is None:
        suffix = f"_{year}" if year is not None else ""
        hint = f" Similar columns: {', '.join(suggestions)}" if suggestions else ""
        raise ColumnLookupError(
            f"{dataset}: unable to locate column matching '{stem}{suffix}'.{hint}"
        )
    return column


def to_float(value) -> Optional[float]:
    if pd.isna(value):
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        cleaned = stripped.replace(",", "")
        try:
            return float(cleaned)
        except ValueError:
            return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value) -> Optional[int]:
    num = to_float(value)
    if num is None:
        return None
    try:
        return int(round(num))
    except (ValueError, OverflowError):
        return None


def normalize_text(value) -> Optional[str]:
    if pd.isna(value):
        return None
    text = str(value).strip()
    if not text:
        return None
    return re.sub(r"\s+", " ", text)


def pick_display_name(row: pd.Series, columns: Sequence[str]) -> Optional[str]:
    for col in columns:
        if col is None:
            continue
        name = normalize_text(row.get(col))
        if name:
            return name
    return None


def extract_available_years(columns: Iterable[str], stem: str) -> List[int]:
    base = sanitize_key(stem)
    years: List[int] = []
    for col in columns:
        key = sanitize_key(str(col))
        if base in key:
            matches = re.findall(r"(19|20)\d{2}", key)
            for match in matches:
                year = int(match)
                if year not in years:
                    years.append(year)
    return years


def ensure_year_available(
    part_label: str, columns: Sequence[str], stem: str, year: int
) -> None:
    column, _ = find_column(columns, stem, year=year)
    if column is None:
        available = extract_available_years(columns, stem)
        available_str = ", ".join(str(y) for y in sorted(available)) or "none"
        raise ColumnLookupError(
            f"{part_label}: column for '{stem}_{year}' not found. Available years: {available_str}."
        )


def prepare_part(
    df: pd.DataFrame,
    year: int,
    part_label: str,
    dataset_name: str,
) -> List[Dict[str, object]]:
    columns = list(df.columns)
    brand_col = require_column(columns, "Brnd_Name", dataset_name)
    generic_col = require_column(columns, "Gnrc_Name", dataset_name)
    hcpcs_col = None
    if part_label == "B":
        hcpcs_col = require_column(columns, "HCPCS_Desc", dataset_name)
    spend_col = require_column(columns, "Tot_Spndng", dataset_name, year=year)
    claims_col = require_column(columns, "Tot_Clms", dataset_name, year=year)
    benes_col = require_column(columns, "Tot_Benes", dataset_name, year=year)

    prev_year = year - 1
    prev_col, _ = find_column(columns, "Tot_Spndng", year=prev_year)

    records: List[Dict[str, object]] = []
    for _, row in df.iterrows():
        display_name = pick_display_name(row, (brand_col, generic_col, hcpcs_col))
        if not display_name:
            continue
        spend = to_float(row.get(spend_col))
        if spend is None or spend <= 0:
            continue
        claims = to_int(row.get(claims_col))
        benes = to_int(row.get(benes_col))
        prev_spend = to_float(row.get(prev_col)) if prev_col else None
        record = {
            "year": year,
            "part": part_label,
            "display_name": display_name,
            "spend_total_usd": float(spend),
            "claims": claims,
            "beneficiaries": benes,
            "prev_year": prev_year if prev_spend is not None else None,
            "prev_spend_total_usd": float(prev_spend) if prev_spend is not None else None,
            "is_glp1": bool(GLP1_PATTERN.search(display_name)),
        }
        records.append(record)
    return records


def process_nhe(nhe_path: Path) -> Dict[str, object]:
    nhe_df = pd.read_excel(nhe_path, engine="openpyxl")
    if nhe_df.empty:
        raise RuntimeError("NHE workbook appears to be empty.")
    nhe_df.columns = [str(col).strip() for col in nhe_df.columns]
    first_col = nhe_df.columns[0]
    mask = nhe_df[first_col].astype(str).str.contains("retail", case=False, na=False)
    mask &= nhe_df[first_col].astype(str).str.contains("prescription", case=False, na=False)
    target_rows = nhe_df[mask]
    if target_rows.empty:
        raise RuntimeError(
            "Unable to locate a row containing both 'retail' and 'prescription' in NHE Table 01."
        )
    row = target_rows.iloc[0]
    year_values: Dict[int, float] = {}
    for col in nhe_df.columns[1:]:
        key = str(col)
        match = re.search(r"(19|20)\d{2}", key)
        if not match:
            continue
        year = int(match.group(0))
        value = to_float(row.get(col))
        if value is None:
            continue
        year_values[year] = float(value)
    if not year_values:
        raise RuntimeError("No usable year columns were found in the NHE table.")
    latest_year = max(year_values)
    latest_value = year_values[latest_year]
    series_years = sorted(year_values)[-5:]
    series = [
        {"year": year, "value_usd": float(year_values[year])}
        for year in series_years
    ]
    return {
        "latest_year": latest_year,
        "value_usd": float(latest_value),
        "series": series,
    }


def detect_year(partd_cols: Sequence[str], partb_cols: Sequence[str], explicit: Optional[int]) -> int:
    if explicit is not None:
        return explicit
    years = set(extract_available_years(partd_cols, "Tot_Spndng"))
    years.update(extract_available_years(partb_cols, "Tot_Spndng"))
    if not years:
        raise ColumnLookupError(
            "Unable to detect a year suffix from Tot_Spndng columns in either workbook."
        )
    return max(years)


def load_dataframe(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path, engine="openpyxl")
    df.columns = [str(col).strip() for col in df.columns]
    return df


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare Medicare drug spending JSON extracts.")
    parser.add_argument("--partd", required=True, help="Path to the Medicare Part D by drug workbook")
    parser.add_argument("--partb", required=True, help="Path to the Medicare Part B by drug workbook")
    parser.add_argument("--nhe", required=True, help="Path to the NHE Table 01 workbook")
    parser.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent / "data"))
    parser.add_argument("--year", type=int, help="Four-digit report year to extract")
    args = parser.parse_args(argv)

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    partd_path = Path(args.partd)
    partb_path = Path(args.partb)
    nhe_path = Path(args.nhe)

    partd_df = load_dataframe(partd_path)
    partb_df = load_dataframe(partb_path)

    year = detect_year(partd_df.columns, partb_df.columns, args.year)

    ensure_year_available("Part D", partd_df.columns, "Tot_Spndng", year)
    ensure_year_available("Part B", partb_df.columns, "Tot_Spndng", year)

    d_records = prepare_part(partd_df, year, "D", "Part D")
    b_records = prepare_part(partb_df, year, "B", "Part B")

    if not d_records and not b_records:
        raise RuntimeError(
            f"No spending rows were extracted for year {year}. Check that the workbooks contain data for this year."
        )

    output_records = d_records + b_records
    output_path = outdir / f"medicare_drugs_{year}.json"
    with output_path.open("w", encoding="utf-8") as fh:
        json.dump(output_records, fh, indent=2)

    nhe_payload = process_nhe(nhe_path)
    nhe_path_out = outdir / "nhe_retail_rx.json"
    with nhe_path_out.open("w", encoding="utf-8") as fh:
        json.dump(nhe_payload, fh, indent=2)

    print(f"Wrote {len(output_records)} Medicare drug rows for {year} to {output_path}")
    print(
        f"Wrote NHE retail prescription series ({nhe_payload['latest_year']}) to {nhe_path_out}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ColumnLookupError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
