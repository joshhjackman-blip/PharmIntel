#!/usr/bin/env python3
"""Build a per-county wells GeoJSON for the map: horizontal laterals (as-drilled
lines), permitted laterals (planned surface->bottom lines), and vertical wells
(small points) — colored by status.

Geometry source is the RRC county well shapefile (``well{FIPS}.zip`` in Supabase
Storage / data/), which ships three layers:
  * ``…s.shp`` surface points   — carry native NAD83 LONG83/LAT83 (used directly)
  * ``…b.shp`` bottom-hole pts   — native NAD83 LONG83/LAT83
  * ``…l.shp`` lateral lines     — geometry only, in NAD27 (EPSG:4267)

ACCURACY: the lateral geometry is NAD27; naively treating it as WGS84 mis-places
it ~40 m. We reproject 4267 -> 4326, which matches the NAD83 columns to ~3 m.
Point layers use LONG83/LAT83 directly (no reprojection needed).

Status/operator come from the ``<county>_wells`` table (the app's curated RRC
wellbore-query status). SYMNUM permit codes mark permitted (not-yet-drilled)
locations.

Output: public/<county>_wells.geojson  (FeatureCollection; props: kind, geom,
well_type, api, operator, status).

Usage:
  python3 scripts/build_wells_geojson.py --county loving --dry-run
  python3 scripts/build_wells_geojson.py            # all counties -> public/
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import geopandas as gpd
import httpx
from shapely.geometry import LineString, MultiLineString

ROOT = Path(__file__).resolve().parent.parent

COUNTY_FIPS = {
    "howard": "227", "martin": "317", "midland": "329", "loving": "301",
    "reagan": "383", "upton": "461", "ward": "475", "winkler": "495",
}

# RRC SYMNUM codes for a permitted / located-but-not-completed well.
PERMIT_SYMNUMS = {1, 11, 21, 87, 116}
# How many distinct operators get their own color in the per-operator palette.
OPERATOR_PALETTE_SIZE = 12
_OP_SUFFIX = __import__("re").compile(
    r"[\s,\.]+(LLC|L\.?L\.?C|LP|L\.?P|LLP|INC|CORP|CO|COMPANY|LTD|OPERATING|"
    r"RESOURCES|ENERGY|PRODUCTION|PETROLEUM|OIL\s*&?\s*GAS|USA|US|LIMITED)\b", __import__("re").I)


def _op_key(name: str | None) -> str:
    """Normalize an operator name for grouping (upper, drop common suffixes)."""
    import re
    s = re.sub(r"\s+", " ", str(name or "").strip().upper())
    s = _OP_SUFFIX.sub("", s).strip(" ,.")
    return s
# Minimum surface->bottom horizontal displacement (deg, ~200 m) to treat a
# permitted well as a (planned) horizontal rather than a vertical dot.
PERMIT_LATERAL_MIN_DEG = 0.002


def _find(extract: Path, fips: str, suffix: str) -> Path | None:
    return next((p for p in extract.rglob("*.shp")
                 if p.stem.lower().endswith(suffix)), None)


def _kind(status: str | None, is_permit: bool, is_line: bool) -> str:
    """Legacy status-only classifier (kept for callers); prefer _classify."""
    return _classify({"status": status}, {}, is_permit, is_line, "")


def _classify(winfo: dict, pinfo: dict, is_permit: bool, is_line: bool,
              lease: str = "") -> str:
    """Per-well designation from the RRC signals we have:
      injection  — well status / lease is disposal/injection
      shut_in    — well status SHUT IN
      producing  — has a completion (PDP) or status PRODUCING/ACTIVE
      duc        — a drilled lateral with no completion/production on file
                   (Drilled UnCompleted), whether or not a permit spud date
                   was matched — a drawn lateral IS evidence the well was
                   drilled, so an uncompleted one is a DUC
      permitted  — a permitted location (SYMNUM permit code), not yet spudded
      vertical   — a point well with no other signal
    """
    s = (winfo.get("status") or "").upper()
    lu = (lease or "").upper()
    if "INJECT" in s or "DISPOS" in s or "SWD" in s or " SWD" in lu or "DISPOSAL" in lu:
        return "injection"
    if "SHUT" in s:
        return "shut_in"
    completed = bool(winfo.get("completion")) or bool(pinfo.get("completion"))
    if completed or "PROD" in s or s in ("ACTIVE", "OIL", "GAS"):
        return "producing"
    if pinfo.get("spud"):
        return "duc"
    if is_permit:
        return "permitted"
    # A drawn lateral with no completion/production/shut/injection signal is,
    # by definition, drilled but not completed -> DUC. Only point wells fall
    # through to the neutral vertical bucket.
    return "duc" if is_line else "vertical"


def _paged(table: str, select: str, base: str, headers: dict) -> list[dict]:
    # PostgREST caps a single response at 1000 rows regardless of `limit`, so
    # keyset-paginate in 1000-row pages and stop only on a short page.
    PAGE = 1000
    out: list[dict] = []
    with httpx.Client(timeout=90) as c:
        last = 0
        while True:
            r = c.get(f"{base}/rest/v1/{table}",
                      params={"select": f"id,{select}", "order": "id.asc",
                              "id": f"gt.{last}", "limit": str(PAGE)},
                      headers=headers)
            rows = r.json()
            if not isinstance(rows, list) or not rows:
                break
            out.extend(rows)
            last = rows[-1]["id"]
            if len(rows) < PAGE:
                break
    return out


def wells_status_lookup(fips: str, county: str, base: str, headers: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in _paged(f"{county}_wells",
                      "api_number,well_status,operator_name,completion_date,oil_gas_code",
                      base, headers):
        api = str(row.get("api_number") or "").strip()
        if api and api not in out:
            out[api] = {
                "status": row.get("well_status"),
                "operator": row.get("operator_name"),
                "completion": row.get("completion_date"),
                "oil_gas": row.get("oil_gas_code"),
            }
    return out


def permits_lookup(county: str, base: str, headers: dict) -> dict[str, dict]:
    """{api: {spud, completion, operator}} from <county>_permits — gives DUC
    (spud, no completion) and extra PDP/operator coverage the wells table lacks."""
    out: dict[str, dict] = {}
    try:
        rows = _paged(f"{county}_permits",
                      "api_number,spud_date,completion_date,operator_name", base, headers)
    except Exception:
        return out
    for row in rows:
        api = str(row.get("api_number") or "").strip()
        if not api:
            continue
        cur = out.setdefault(api, {"spud": None, "completion": None, "operator": None})
        cur["spud"] = cur["spud"] or row.get("spud_date")
        cur["completion"] = cur["completion"] or row.get("completion_date")
        cur["operator"] = cur["operator"] or row.get("operator_name")
    return out


WELLS_BUCKET = "Raw-Data"


def ensure_well_zip(fips: str, base: str, headers: dict) -> Path:
    """Return the local well{FIPS}.zip, downloading from Storage if absent
    (so the nightly CI job doesn't need the zips committed to the repo)."""
    zp = ROOT / "data" / f"well{fips}.zip"
    if zp.exists():
        return zp
    if not base:
        raise SystemExit(f"missing {zp} and no Supabase creds to fetch it")
    print(f"  downloading {WELLS_BUCKET}/well{fips}.zip ...", flush=True)
    with httpx.Client(timeout=180) as c:
        r = c.get(f"{base}/storage/v1/object/{WELLS_BUCKET}/well{fips}.zip", headers=headers)
        r.raise_for_status()
    zp.parent.mkdir(parents=True, exist_ok=True)
    zp.write_bytes(r.content)
    return zp


def build_county(county: str, fips: str, base: str, headers: dict) -> dict:
    zp = ensure_well_zip(fips, base, headers)
    features: list[dict] = []
    status_by_api = wells_status_lookup(fips, county, base, headers)
    permits_by_api = permits_lookup(county, base, headers)

    with tempfile.TemporaryDirectory() as t:
        extract = Path(t)
        zipfile.ZipFile(zp).extractall(extract)

        # Surface points (native NAD83 columns).
        surf = gpd.read_file(_find(extract, fips, "s"))
        surface: dict[str, dict] = {}
        for _, r in surf.iterrows():
            api = str(r.get("API") or "").strip()
            if not api:
                continue
            try:
                lon, lat = float(r["LONG83"]), float(r["LAT83"])
            except (TypeError, ValueError, KeyError):
                continue
            try:
                symnum = int(r.get("SYMNUM"))
            except (TypeError, ValueError):
                symnum = None
            surface.setdefault(api, {"lon": lon, "lat": lat, "symnum": symnum})

        # Bottom-hole points (for permitted planned laterals).
        bottom: dict[str, tuple[float, float]] = {}
        bpath = _find(extract, fips, "b")
        if bpath:
            b = gpd.read_file(bpath)
            for _, r in b.iterrows():
                api = str(r.get("API") or "").strip()
                if not api:
                    continue
                try:
                    bottom.setdefault(api, (float(r["LONG83"]), float(r["LAT83"])))
                except (TypeError, ValueError, KeyError):
                    continue

        # Lateral lines — reproject NAD27 -> WGS84 for accurate placement.
        laterals: dict[str, list] = {}
        lpath = _find(extract, fips, "l")
        if lpath:
            lat_gdf = gpd.read_file(lpath).to_crs(4326)
            for _, r in lat_gdf.iterrows():
                api = str(r.get("API") or "").strip()
                geom = r.geometry
                if not api or geom is None or geom.is_empty:
                    continue
                if isinstance(geom, MultiLineString):
                    geom = max(geom.geoms, key=lambda g: g.length)
                if not isinstance(geom, LineString):
                    continue
                coords = [[round(x, 6), round(y, 6)] for x, y in geom.coords]
                if len(coords) >= 2:
                    laterals.setdefault(api, coords)

    def info_for(api: str) -> tuple[dict, dict, str | None]:
        w = status_by_api.get(api, {})
        p = permits_by_api.get(api, {})
        operator = w.get("operator") or p.get("operator")
        return w, p, operator

    drawn: set[str] = set()

    # 1) Drilled horizontal laterals (as-drilled lines).
    for api, coords in laterals.items():
        w, p, operator = info_for(api)
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "geom": "line", "well_type": "HORIZONTAL", "api": api,
                "kind": _classify(w, p, False, True),
                "status": w.get("status"), "operator": operator,
            },
        })
        drawn.add(api)

    # 2) Surface wells without a drilled lateral: permitted or vertical.
    for api, s in surface.items():
        if api in drawn:
            continue
        is_permit = s["symnum"] in PERMIT_SYMNUMS
        w, p, operator = info_for(api)
        bh = bottom.get(api)
        if is_permit and bh and (
            abs(bh[0] - s["lon"]) + abs(bh[1] - s["lat"]) >= PERMIT_LATERAL_MIN_DEG
        ):
            # Planned lateral: straight surface -> bottom-hole line.
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [
                    [round(s["lon"], 6), round(s["lat"], 6)],
                    [round(bh[0], 6), round(bh[1], 6)],
                ]},
                "properties": {
                    "geom": "line", "well_type": "HORIZONTAL", "api": api,
                    "kind": _classify(w, p, True, True),
                    "status": w.get("status"), "operator": operator,
                },
            })
        else:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [
                    round(s["lon"], 6), round(s["lat"], 6)]},
                "properties": {
                    "geom": "point",
                    "well_type": "VERTICAL" if not is_permit else "PERMIT",
                    "api": api,
                    "kind": _classify(w, p, is_permit, False),
                    "status": w.get("status"), "operator": operator,
                },
            })

    # Operator coloring: rank the county's operators by well count and stamp an
    # `op_idx` (0..N-1 for the top operators, -1 for the long tail) so the map
    # can switch to a per-operator palette. `op` carries a short display name.
    from collections import Counter
    counts = Counter(_op_key(f["properties"].get("operator")) for f in features
                     if _op_key(f["properties"].get("operator")))
    top = [k for k, _ in counts.most_common(OPERATOR_PALETTE_SIZE)]
    idx_of = {k: i for i, k in enumerate(top)}
    for f in features:
        opk = _op_key(f["properties"].get("operator"))
        f["properties"]["op"] = opk or ""
        f["properties"]["op_idx"] = idx_of.get(opk, -1)

    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--county", default=",".join(COUNTY_FIPS))
    ap.add_argument("--out", default="public")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--upload", action="store_true",
                    help="also upload each geojson to the public Supabase "
                         "Storage bucket so the map serves fresh data nightly")
    args = ap.parse_args()

    url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    base = ""
    headers: dict[str, str] = {}
    if url and key:
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        headers = {"apikey": key, "Authorization": f"Bearer {key}"}

    for county in [c.strip() for c in args.county.split(",") if c.strip() in COUNTY_FIPS]:
        fc = build_county(county, COUNTY_FIPS[county], base, headers)
        from collections import Counter
        kinds = Counter(f["properties"]["kind"] for f in fc["features"])
        geoms = Counter(f["properties"]["geom"] for f in fc["features"])
        print(f"{county}: {len(fc['features'])} wells | geom={dict(geoms)} | kind={dict(kinds)}")
        if args.dry_run:
            continue
        out = ROOT / args.out / f"{county}_wells.geojson"
        blob = json.dumps(fc, separators=(",", ":"))
        out.write_text(blob)
        print(f"  wrote {out} ({out.stat().st_size/1e6:.1f} MB)")
        if args.upload:
            if not base:
                raise SystemExit("--upload needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
            upload_to_storage(base, headers, f"{county}_wells.geojson", blob)


MAP_BUCKET = "map-data"


def upload_to_storage(base: str, headers: dict, name: str, blob: str) -> None:
    """Upsert a geojson into the public MAP_BUCKET (created on first run)."""
    with httpx.Client(timeout=120) as c:
        # Ensure a public bucket exists (idempotent).
        c.post(f"{base}/storage/v1/bucket", headers={**headers, "Content-Type": "application/json"},
               json={"id": MAP_BUCKET, "name": MAP_BUCKET, "public": True})
        r = c.post(
            f"{base}/storage/v1/object/{MAP_BUCKET}/{name}",
            headers={**headers, "Content-Type": "application/json",
                     "x-upsert": "true", "cache-control": "max-age=300"},
            content=blob.encode("utf-8"),
        )
        if r.status_code >= 300:
            raise SystemExit(f"storage upload failed ({r.status_code}): {r.text[:200]}")
        print(f"  uploaded {MAP_BUCKET}/{name}")


if __name__ == "__main__":
    main()
