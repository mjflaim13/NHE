# RX Scoreboard

A fully static "big board" visualizing U.S. Medicare drug spending with extrapolated live counters derived from CMS Part B and Part D drug spending workbooks plus NHE Table 01.

## Quickstart
1. **Create a virtual environment**
   ```bash
   python3 -m venv .venv && source .venv/bin/activate
   ```
2. **Install ETL dependencies**
   ```bash
   pip install pandas openpyxl
   ```
3. **Run the ETL pipeline** (supply your own downloaded files)
   ```bash
   python etl/prep.py \
     --partd "/mnt/data/DSD_PTD_RY25_DYT23_Web - 250415.xlsx" \
     --partb "/mnt/data/DSD_PTB_RY25_P06_V10_DYT23_WebExport - 250430.xlsx" \
     --nhe "/mnt/data/Table 01 National Health Expenditures; Aggregate and Per Capita Amounts.xlsx"
   ```
4. **Open the scoreboard**
   ```
   open index.html  # or double-click the file
   ```

If you need to target a different report year, append `--year 2023` (for example). Use `--outdir` to emit JSON to a different folder.

## Scope & methodology
- Covers **Medicare Part D (retail prescription)** and **Medicare Part B (physician-administered drugs)** only.
- "Live" counters are honest extrapolations: the latest full-year totals are pro-rated by the elapsed seconds in the selected calendar year (if the year has already ended, totals stay fixed).
- National health expenditure (NHE) retail prescription drug totals provide **contextual headlines only**; they are not blended into Medicare calculations.
- Drug names, spending, claims, and beneficiary fields mirror the CMS data dictionary naming (`Brnd_Name`, `Gnrc_Name`, `Tot_Spndng_YYYY`, `Tot_Clms_YYYY`, `Tot_Benes_YYYY`).

## Column mapping cribsheet
The ETL looks for the following stems (case-insensitive, ignoring spaces/hyphens):

| Dataset | Required columns |
| --- | --- |
| Part D | `Brnd_Name`, `Gnrc_Name`, `Tot_Spndng_YYYY`, `Tot_Clms_YYYY`, `Tot_Benes_YYYY` |
| Part B | `Brnd_Name`, `Gnrc_Name`, `HCPCS_Desc`, `Tot_Spndng_YYYY`, `Tot_Clms_YYYY`, `Tot_Benes_YYYY` |

A prior-year spending column (`Tot_Spndng_(YYYY-1)`) is used when present to compute year-over-year changes.

## Troubleshooting
- **Missing columns**: The script lists close matches when a required column stem is absent. Verify that your workbooks come directly from CMS and that the requested year matches the suffix (e.g., `_2023`).
- **Explicit year selection**: Use `--year` when your file contains multiple year columns but you want a specific one.
- **Custom paths/output**: Supply absolute or relative paths to any downloaded files. Use `--outdir` to emit JSON elsewhere (defaults to `data/`).
- **Empty dashboard**: If `/data` is empty, the frontend shows guidance on running the ETL instead of blank panels.

## License
MIT License — see [LICENSE](LICENSE).
