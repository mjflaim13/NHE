# ETL Notes

`prep.py` ingests the official CMS Medicare Part D and Part B drug spending public use files together with the National Health Expenditure (NHE) Table 01 workbook.

## Column stems searched
All matches are case-insensitive and ignore whitespace, underscores, and hyphens. The script trims column headers and tolerates Unicode spacing quirks.

### Medicare Part D
- `Brnd_Name`
- `Gnrc_Name`
- `Tot_Spndng_YYYY`
- `Tot_Clms_YYYY`
- `Tot_Benes_YYYY`

### Medicare Part B
- `Brnd_Name`
- `Gnrc_Name`
- `HCPCS_Desc`
- `Tot_Spndng_YYYY`
- `Tot_Clms_YYYY`
- `Tot_Benes_YYYY`

If a matching `Tot_Spndng_(YYYY-1)` column exists it is captured for year-over-year deltas.

### NHE Table 01
The script looks for the row whose first column contains both "retail" and "prescription" and for all four-digit column headers representing calendar years.

## Usage examples

Select a specific report year and a custom output directory:
```bash
python etl/prep.py \
  --year 2023 \
  --partd /path/to/partd.xlsx \
  --partb /path/to/partb.xlsx \
  --nhe /path/to/nhe_table01.xlsx \
  --outdir /tmp/rx-json
```

Run with default year autodetection while emitting to the bundled `data/` folder:
```bash
python etl/prep.py --partd ~/Downloads/partd.xlsx --partb ~/Downloads/partb.xlsx --nhe ~/Downloads/nhe.xlsx
```
