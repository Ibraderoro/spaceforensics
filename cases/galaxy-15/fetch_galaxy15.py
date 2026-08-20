"""
fetch_galaxy15.py
-----------------
Downloads raw GOES-11 data from NASA CDAWeb for the Galaxy 15 anomaly window
(2010-04-05 08:00–11:00 UTC), parses the responses, and writes a normalised
evidence CSV at cases/galaxy-15/normalized/galaxy15_evidence.csv.

Usage (from project root):
    source venv/bin/activate
    python cases/galaxy-15/fetch_galaxy15.py

API reference: https://cdaweb.gsfc.nasa.gov/WebServices/REST/
"""

import json
import math
import os

import pandas as pd
import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WINDOW_START = "20100405T080000Z"
WINDOW_END   = "20100405T110000Z"

# CDAWeb REST API — data endpoint:
#   GET /WS/cdasr/1/dataviews/sp_phys/datasets/{id}/data/{start},{end}/{var}?format=json
BASE_URL = "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets"

# Confirmed variable names from CDAWeb catalogue (2025-07):
#   GOES11_K0_EP8    E2        Electron flux >2 MeV  (scalar float, particles/cm2/s/sr)
#   GOES11_K0_MAG    B_GSM_c   B-field in GSM        (3-component, space-separated string, nT)
#   GOES11_EPHEMERIS_SSC RADIUS Radial distance        (scalar double, Re)
DATASETS = [
    {
        "dataset_id":  "GOES11_K0_EP8",
        "variable":    "E2",
        "source":      "GOES11_EP8",
        "measurement": "e_flux",
        "unit":        "particles/cm2/s/sr",
        "resolution":  "5min",
        "vector":      False,
    },
    {
        "dataset_id":  "GOES11_K0_MAG",
        "variable":    "B_GSM_c",
        "source":      "GOES11_MAG",
        "measurement": "b_gsm",
        "unit":        "nT",
        "resolution":  "1min",
        "vector":      True,   # value is space-separated "Bx By Bz"; we store |B|
    },
    {
        "dataset_id":  "GOES11_EPHEMERIS_SSC",
        "variable":    "RADIUS",
        "source":      "GOES11_EPHEMERIS",
        "measurement": "position",
        "unit":        "Re",
        "resolution":  "3min",
        "vector":      False,
    },
]

ANCHOR_EVENT = {
    "timestamp":   "2010-04-05T09:48:00Z",
    "source":      "CASE",
    "measurement": "galaxy15_anomaly",
    "value":       "1",
    "unit":        "event",
    "resolution":  "event",
}

# CDAWeb fill / pad sentinel for GOES data (-1.0E30 or -1.0E31 depending on dataset)
FILL_ABS_THRESHOLD = 1.0e29   # any value more negative than this is a fill

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
RAW_DIR      = os.path.join(SCRIPT_DIR, "raw")
NORM_DIR     = os.path.join(SCRIPT_DIR, "normalized")
EVIDENCE_CSV = os.path.join(NORM_DIR, "galaxy15_evidence.csv")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_fill(value) -> bool:
    """Return True if value is a CDAWeb fill sentinel."""
    try:
        fv = float(value)
        return fv < -FILL_ABS_THRESHOLD
    except (TypeError, ValueError):
        return True


def _normalise_timestamp(raw_ts: str) -> str:
    """Convert CDAWeb timestamp string to 'YYYY-MM-DDTHH:MM:SSZ'."""
    ts = pd.Timestamp(raw_ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    else:
        ts = ts.tz_convert("UTC")
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def _find_variable(variables: list, name: str) -> dict | None:
    """Find a variable block by name in the CDF variable list."""
    for v in variables:
        if v.get("name") == name:
            return v
    return None


# ---------------------------------------------------------------------------
# Fetch layer
# ---------------------------------------------------------------------------

def fetch_dataset(dataset_id: str, variable: str, out_path: str) -> None:
    """
    Fetch one CDAWeb dataset for the configured time window and save the raw
    JSON response to out_path.  Skips if out_path already exists (idempotent).

    URL pattern (confirmed working):
      https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/
        {dataset_id}/data/{WINDOW_START},{WINDOW_END}/{variable}?format=json
    """
    if os.path.exists(out_path):
        print(f"  [SKIP]  {dataset_id} — cached at {out_path}")
        return

    url = f"{BASE_URL}/{dataset_id}/data/{WINDOW_START},{WINDOW_END}/{variable}"
    print(f"  [FETCH] {dataset_id}/{variable}")
    print(f"          {url}?format=json")

    response = requests.get(url, params={"format": "json"}, timeout=180)
    response.raise_for_status()

    payload = response.json()
    os.makedirs(RAW_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    print(f"  [SAVED] {out_path}")


def fetch_all() -> None:
    print("\n=== FETCH PHASE ===")
    for ds in DATASETS:
        out_path = os.path.join(RAW_DIR, f"{ds['dataset_id']}.json")
        fetch_dataset(ds["dataset_id"], ds["variable"], out_path)


# ---------------------------------------------------------------------------
# Parse / normalise layer
# ---------------------------------------------------------------------------

def _extract_records_from_payload(payload: dict, ds: dict) -> list[dict]:
    """
    Extract time-series records from a CDAWeb JSON-format CDF payload.

    Confirmed CDAWeb CDF-JSON structure (2025-07):
      payload["CDF"][0]["cdfVariables"]["variable"] -> list of variable dicts
      Each variable dict:
        {
          "name": "Epoch",
          "cdfVarData": {
            "record": [{"recNum": 0, "value": ["2010-04-05T08:02:30.000Z"]}, ...]
          }
        }
        {
          "name": "E2",          # or "B_GSM_c" or "RADIUS"
          "cdfVarData": {
            "record": [{"recNum": 0, "value": ["355.78"]}, ...]
          }
        }
      For vector variables (B_GSM_c) value is a space-separated string:
        "record": [{"recNum": 0, "value": ["30.18 2.48 69.69"]}, ...]
      We compute the L2 norm (|B|) for vector variables.
    """
    rows = []
    source      = ds["source"]
    measurement = ds["measurement"]
    unit        = ds["unit"]
    resolution  = ds["resolution"]
    is_vector   = ds["vector"]
    var_name    = ds["variable"]

    try:
        cdf_list  = payload.get("CDF", [])
        if not cdf_list:
            print(f"  [WARN] No CDF block in {ds['dataset_id']} payload")
            return rows

        variables = cdf_list[0].get("cdfVariables", {}).get("variable", [])

        epoch_var = _find_variable(variables, "Epoch")
        data_var  = _find_variable(variables, var_name)

        if epoch_var is None or data_var is None:
            print(f"  [WARN] Missing Epoch or {var_name} in {ds['dataset_id']}")
            return rows

        epoch_records = epoch_var["cdfVarData"]["record"]
        data_records  = data_var["cdfVarData"]["record"]

        # Build a recNum->timestamp dict from Epoch
        ts_by_rec = {}
        for rec in epoch_records:
            rec_num = rec["recNum"]
            raw_ts  = rec["value"][0]
            ts_by_rec[rec_num] = _normalise_timestamp(raw_ts)

        for rec in data_records:
            rec_num = rec["recNum"]
            raw_val = rec["value"][0]

            if is_vector:
                # Space-separated component string e.g. "30.18 2.48 69.69"
                try:
                    components = [float(c) for c in str(raw_val).split()]
                    if any(_is_fill(c) for c in components):
                        continue
                    scalar = math.sqrt(sum(c ** 2 for c in components))
                except (ValueError, TypeError):
                    continue
            else:
                if _is_fill(raw_val):
                    continue
                try:
                    scalar = float(raw_val)
                except (ValueError, TypeError):
                    continue

            ts = ts_by_rec.get(rec_num)
            if ts is None:
                continue

            rows.append({
                "timestamp":   ts,
                "source":      source,
                "measurement": measurement,
                "value":       scalar,
                "unit":        unit,
                "resolution":  resolution,
            })

    except Exception as exc:
        print(f"  [ERROR] Failed to parse {ds['dataset_id']}: {exc}")

    return rows


def build_evidence_csv() -> None:
    print("\n=== PARSE & NORMALISE PHASE ===")
    all_rows = []

    for ds in DATASETS:
        raw_path = os.path.join(RAW_DIR, f"{ds['dataset_id']}.json")
        if not os.path.exists(raw_path):
            print(f"  [SKIP]  {ds['dataset_id']} — raw file missing")
            continue

        with open(raw_path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)

        rows = _extract_records_from_payload(payload, ds)
        print(f"  [PARSED] {ds['dataset_id']}: {len(rows)} records")
        all_rows.extend(rows)

    # Insert anchor event
    all_rows.append(ANCHOR_EVENT)
    print(f"  [INSERT] Anchor event at {ANCHOR_EVENT['timestamp']}")

    df = pd.DataFrame(all_rows, columns=[
        "timestamp", "source", "measurement", "value", "unit", "resolution"
    ])
    df = df.sort_values("timestamp").reset_index(drop=True)

    os.makedirs(NORM_DIR, exist_ok=True)
    df.to_csv(EVIDENCE_CSV, index=False)
    print(f"\n  [WRITTEN] {EVIDENCE_CSV}  ({len(df)} rows)")

    # Sanity preview
    print("\n--- First 8 rows ---")
    print(df.head(8).to_string(index=False))
    print("\n--- Last 3 rows ---")
    print(df.tail(3).to_string(index=False))
    print(f"\nTotal rows   : {len(df)}")
    print(f"Sources      : {sorted(df['source'].unique())}")
    print(f"Measurements : {sorted(df['measurement'].unique())}")
    print(f"Time range   : {df['timestamp'].min()} → {df['timestamp'].max()}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    print("SpaceForensics — Galaxy 15 Evidence Fetch")
    print(f"Window : {WINDOW_START} → {WINDOW_END}")
    fetch_all()
    build_evidence_csv()
    print("\n=== DONE ===")


if __name__ == "__main__":
    main()
