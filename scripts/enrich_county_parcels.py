#!/usr/bin/env python3
"""Enrich a county's parcel polygons with motivated-owner aggregates.

This script:
1) Fetches ALL motivated owners from Supabase via pagination.
2) Prints join-key diagnostics for owner and parcel fields.
3) Maps owners directly to parcel abstracts (owner.abstract -> parcel CODE).
4) Enriches each polygon with aggregate owner metadata.
5) Writes data/<county>_parcels_enriched.geojson and copies to public/.

Usage:
    python3 scripts/enrich_howard_parcels.py
    python3 scripts/enrich_howard_parcels.py --county gonzales \
        --input-parcels /workspace/data/gonzales/Abstracts.shp

For backward compatibility the bare script defaults to Howard. New counties
should pass --county and --input-parcels explicitly (or set the env vars
COUNTY_ID, COUNTY_INPUT_PARCELS).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
from supabase import Client, create_client

PAGE_SIZE = 1000

DEFAULT_COUNTY_ID = "howard"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--county",
        default=os.getenv("COUNTY_ID", DEFAULT_COUNTY_ID),
        help="County id (matches lib/counties.ts entry, e.g. 'howard', 'gonzales').",
    )
    parser.add_argument(
        "--input-parcels",
        default=os.getenv("COUNTY_INPUT_PARCELS"),
        help="Path to the input shapefile. Defaults to /workspace/data/<county>/Abstracts.shp.",
    )
    parser.add_argument(
        "--output-dir",
        default=os.getenv("COUNTY_OUTPUT_DIR", "data"),
        help="Directory for the enriched GeoJSON output.",
    )
    parser.add_argument(
        "--public-dir",
        default=os.getenv("COUNTY_PUBLIC_DIR", "public"),
        help="Directory to copy the enriched GeoJSON into for the web app.",
    )
    parser.add_argument(
        "--owners-csv",
        default=os.getenv("COUNTY_INPUT_OWNERS"),
        help=(
            "Optional path to the owners CSV/XLSX. When provided, owners are "
            "parsed offline from this file (via load_county_mineral_records."
            "build_payload) instead of read from Supabase. Lets a county be "
            "enriched before its <county>_mineral_ownership table exists."
        ),
    )
    parser.add_argument(
        "--county-display",
        default=None,
        help="Display value for the 'county' column (offline mode). Defaults to capitalized county id.",
    )
    parser.add_argument(
        "--spatial-only",
        action="store_true",
        help=(
            "Skip abstract text-matching (AbstractMatcher + owner.abstract -> "
            "parcel code) and attach every owner to its tract purely by a "
            "lat/lon point-in-polygon join keyed on ABSTRACT_L. Use for "
            "counties whose tracts are a block/section grid with no numeric "
            "abstract (e.g. Winkler PSL), where the abstract path mis-buckets "
            "owners into the few named-abstract tracts."
        ),
    )
    parser.add_argument(
        "--survey-tract-parser",
        default=None,
        help=(
            "Optional module in scripts/ exposing parse(legal_desc) that "
            "returns (tkey, abstract, block, twn, sec, surveyor) — e.g. "
            "'build_winkler_tracts'. When set, owners still unattached after "
            "the spatial pass are matched by parsing their own `survey` text "
            "into the same ABSTRACT_L tract key (recovers rows with no or bad "
            "coordinates)."
        ),
    )
    parser.add_argument(
        "--attach-via-wells",
        dest="attach_via_wells",
        action="store_true",
        default=True,
        help=(
            "After spatial + survey-text, attach any still-unmapped owner to "
            "the tract of a well on its lease: owner `api` list / rrc_lease_id "
            "-> <county>_wells -> the well's tract (point-in-polygon). This is "
            "the lease/well reference-point convention the roll itself uses. "
            "Best-effort: skipped if the wells table or Supabase creds are "
            "unavailable. On by default; disable with --no-attach-via-wells."
        ),
    )
    parser.add_argument(
        "--no-attach-via-wells",
        dest="attach_via_wells",
        action="store_false",
    )
    parser.add_argument(
        "--wells-table",
        default=None,
        help="Wells table for --attach-via-wells (default: <county>_wells).",
    )
    return parser.parse_args()


def _norm_api(value: Any) -> str:
    """RRC API-8 key: strip non-digits, keep the leading 8 (county+well)."""
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[:8]


def _load_survey_parser(module_name: str):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import importlib

    return importlib.import_module(module_name)


def owner_survey_tract_key(owner: dict[str, Any], parser_mod: Any) -> str | None:
    """Parse an owner's `survey` text into an ABSTRACT_L tract key using the
    county's tract parser, so a coordinate-less owner can still be placed."""
    survey = owner.get("survey")
    if not survey:
        rr = owner.get("raw_record")
        if isinstance(rr, dict):
            survey = rr.get("survey")
    if not survey:
        return None
    parsed = parser_mod.parse(str(survey))
    if not parsed:
        return None
    _tkey, absnum, block, twn, sec, _surv = parsed
    if absnum:
        return f"A-{absnum}"
    if block and sec:
        twn_sfx = f"-{twn}" if twn else ""
        return f"B{block}{twn_sfx}-S{sec}"
    return None


def build_well_tract_maps(
    client: Any, wells_table: str, parcels_gdf: Any
) -> tuple[dict[str, str], dict[str, str]]:
    """Map each well to its tract (ABSTRACT_L, point-in-polygon on its surface
    location) and index by API-8 and rrc_lease_id. Returns ({api8: label},
    {lease: label}) with labels normalized like the spatial pass."""
    from shapely.geometry import Point
    from shapely.strtree import STRtree

    geoms = list(parcels_gdf.geometry.values)
    labels = [norm_text(parcels_gdf.at[idx, "ABSTRACT_L"]) for idx in parcels_gdf.index]
    tree = STRtree(geoms)

    def tract_of(lon: float, lat: float) -> str | None:
        pt = Point(lon, lat)
        for i in tree.query(pt):
            if geoms[i].covers(pt) and labels[i]:
                return labels[i]
        return None

    api2tract: dict[str, str] = {}
    lease2tract: dict[str, str] = {}
    offset = 0
    page = 1000
    while True:
        result = (
            client.table(wells_table)
            .select("api_number, rrc_lease_id, latitude, longitude")
            .range(offset, offset + page - 1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            break
        for well in rows:
            lat = well.get("latitude")
            lon = well.get("longitude")
            if lat is None or lon is None:
                continue
            try:
                label = tract_of(float(lon), float(lat))
            except (TypeError, ValueError):
                label = None
            if not label:
                continue
            api8 = _norm_api(well.get("api_number"))
            if api8:
                api2tract.setdefault(api8, label)
            lease = str(well.get("rrc_lease_id") or "").strip()
            if lease:
                lease2tract.setdefault(lease, label)
        if len(rows) < page:
            break
        offset += page
    return api2tract, lease2tract


def load_owners_from_csv(csv_path: str, county_display: str) -> list[dict[str, Any]]:
    """Build the owner list from a raw CSV without touching Supabase.

    Reuses the exact parsing in scripts/load_county_mineral_records.py so the
    offline enrichment matches what the DB load would produce (abstract,
    ownership_pct as a raw 0-1 decimal, raw_record with lat/long, etc.).
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import load_county_mineral_records as lcr

    rows = lcr.read_input(Path(csv_path))
    if not rows:
        return []
    column_lookup = {lcr.normalize_header(c): c for c in rows[0].keys()}
    owners: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        payload = lcr.build_payload(
            row, county_display=county_display, column_lookup=column_lookup
        )
        payload["id"] = index
        state = (payload.get("mailing_state") or "").upper()
        payload["out_of_state"] = bool(state) and state not in {"TX", "TEXAS"}
        owners.append(payload)
    print(f"Parsed {len(owners):,} owners offline from {csv_path}")
    return owners


ARGS = parse_args()
COUNTY_ID = ARGS.county.strip().lower()
OWNERSHIP_TABLE = f"{COUNTY_ID}_mineral_ownership"
INPUT_PARCELS = Path(
    ARGS.input_parcels or f"/workspace/data/{COUNTY_ID}/Abstracts.shp"
)
OUTPUT_PARCELS = Path(ARGS.output_dir) / f"{COUNTY_ID}_parcels_enriched.geojson"
PUBLIC_PARCELS = Path(ARGS.public_dir) / f"{COUNTY_ID}_parcels_enriched.geojson"


def require_env(name: str, aliases: tuple[str, ...] = ()) -> str:
    value = os.getenv(name)
    if value:
        return value
    for alias in aliases:
        alias_value = os.getenv(alias)
        if alias_value:
            return alias_value
    alias_text = f" (or one of: {', '.join(aliases)})" if aliases else ""
    raise ValueError(f"Missing required environment variable: {name}{alias_text}")


def resolve_input_parcels_path() -> Path:
    if INPUT_PARCELS.exists():
        return INPUT_PARCELS
    raise FileNotFoundError(f"Missing input shapefile: {INPUT_PARCELS}")


def norm_text(value: Any) -> str:
    return " ".join(str(value or "").strip().upper().split())


def to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def to_abstract_code(value: Any) -> str:
    # Keep matching rule as requested: str(value).strip()
    return str(value if value is not None else "").strip()


def paginate_motivated_owners(client: Client) -> list[dict[str, Any]]:
    all_owners: list[dict[str, Any]] = []
    last_id: str | None = None
    server_side_motivated_filter = False
    page_num = 0
    page_size = PAGE_SIZE

    while True:
        # Use keyset pagination to avoid deep OFFSET scan timeouts.
        # County schemas vary; pull full rows to avoid hard-failing on
        # optional/missing columns while keeping downstream logic unchanged.
        query = client.table(OWNERSHIP_TABLE).select("*")
        query = query.order("id", desc=False).limit(page_size)
        if last_id:
            query = query.gt("id", last_id)
        try:
            result = query.execute()
            page_rows = result.data or []
        except Exception as exc:
            if server_side_motivated_filter and "statement timeout" in str(exc).lower():
                print(
                    "Server-side motivated filter timed out; "
                    "falling back to client-side motivated filtering."
                )
                all_owners = []
                last_id = None
                page_num = 0
                server_side_motivated_filter = False
                page_size = PAGE_SIZE
                continue
            if "statement timeout" in str(exc).lower():
                if page_size > 200:
                    page_size = max(200, page_size // 2)
                    print(
                        f"Page query timed out; retrying with smaller page_size={page_size}."
                    )
                else:
                    print("Page query timed out; retrying with current page size.")
                continue
            raise

        if not page_rows:
            break

        page_num += 1
        batch = page_rows

        all_owners.extend(batch)
        last_id = str(page_rows[-1]["id"])
        print(
            f"Fetched page {page_num}: {len(batch)} motivated owners in page, "
            f"total so far: {len(all_owners)}"
        )
        if len(page_rows) < page_size:
            break

    print(f"Total motivated owners fetched: {len(all_owners)}")

    # Fetch raw_record separately in manageable chunks and merge by id when available.
    owners_by_id: dict[str, dict[str, Any]] = {
        str(owner["id"]): owner for owner in all_owners
    }
    owner_ids = list(owners_by_id.keys())
    chunk_size = 500
    for start in range(0, len(owner_ids), chunk_size):
        chunk_ids = owner_ids[start : start + chunk_size]
        try:
            result = (
                client.table(OWNERSHIP_TABLE)
                .select("id, raw_record")
                .in_("id", chunk_ids)
                .execute()
            )
        except Exception:
            # If raw_record does not exist in Howard, continue without it.
            break
        for row in result.data or []:
            owner = owners_by_id.get(str(row.get("id")))
            if owner is not None:
                owner["raw_record"] = row.get("raw_record")

    return all_owners


def main() -> None:
    # 1) Fetch all owners — offline from a CSV when --owners-csv is given
    #    (used to enrich a county before its Supabase table exists), else
    #    paginate the live <county>_mineral_ownership table.
    if ARGS.owners_csv:
        county_display = ARGS.county_display or COUNTY_ID.capitalize()
        all_owners = load_owners_from_csv(ARGS.owners_csv, county_display)
    else:
        supabase_url = require_env("SUPABASE_URL", ("NEXT_PUBLIC_SUPABASE_URL",))
        supabase_key = require_env(
            "SUPABASE_KEY",
            ("SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
        )
        client = create_client(supabase_url, supabase_key)
        all_owners = paginate_motivated_owners(client)

    # 2) Load parcels and normalize Howard-specific abstract fields
    input_parcels_path = resolve_input_parcels_path()
    print(f"Using input parcels from: {input_parcels_path}")
    parcels_gdf = gpd.read_file(input_parcels_path)
    if parcels_gdf.crs is None:
        parcels_gdf = parcels_gdf.set_crs("EPSG:4326")
    else:
        parcels_gdf = parcels_gdf.to_crs("EPSG:4326")

    # Howard's Abstracts.shp ships with a single ``CODE`` column that we
    # turn into ``ABSTRACT_N`` ("19") and ``ABSTRACT_L`` ("A-19"). Martin's
    # Abstracts.shp already provides ``ABSTRACT_N`` ("3171013", FIPS-prefixed)
    # and ``ABSTRACT_L`` ("A-1013"); fall back to deriving the bare abstract
    # number from ABSTRACT_L when CODE is missing so both shapes produce the
    # same downstream join key.
    if "CODE" in parcels_gdf.columns:
        parcels_gdf["ABSTRACT_N"] = parcels_gdf["CODE"].apply(to_abstract_code)
        parcels_gdf["ABSTRACT_L"] = parcels_gdf["ABSTRACT_N"].apply(
            lambda code: f"A-{code}" if code else ""
        )
    elif "ABSTRACT_L" in parcels_gdf.columns:
        # Only real "A-<abstract>" labels carry a numeric ABSTRACT_N. Grid
        # tracts (Winkler PSL) use a "B<block>-S<section>" ABSTRACT_L with no
        # abstract number — deriving ABSTRACT_N by blindly stripping "A-" would
        # leave the whole grid key in ABSTRACT_N, which then gets re-prefixed
        # to "A-B..-S.." and mismatches the ABSTRACT_L used for the owner
        # lookup (every prior county's ABSTRACT_L starts with "A-", so their
        # behavior is unchanged).
        def _derive_abstract_n(label: Any) -> str:
            text = str(label or "").strip()
            if text.upper().startswith("A-"):
                return re.sub(r"^A-", "", text, flags=re.IGNORECASE).strip()
            return ""

        parcels_gdf["ABSTRACT_N"] = parcels_gdf["ABSTRACT_L"].apply(_derive_abstract_n)
        parcels_gdf["ABSTRACT_L"] = parcels_gdf["ABSTRACT_L"].apply(
            lambda label: str(label or "").strip()
        )
    else:
        raise ValueError(
            "Parcels shapefile must contain either a CODE column (Howard-style) "
            "or an ABSTRACT_L column (Martin/Gonzales-style)."
        )

    print("First 5 owners join-field preview:")
    for index, owner in enumerate(all_owners[:5], start=1):
        print(
            index,
            {
                "abstract": owner.get("abstract"),
                "county_lease_name": owner.get("county_lease_name"),
                "field_name": owner.get("field_name"),
            },
        )

    print("First 5 parcel join-field preview:")
    for index, row in parcels_gdf.head(5).iterrows():
        _ = index
        print(
            {
                "CODE": row.get("CODE"),
                "DESC_": row.get("DESC_"),
                "Block": row.get("Block"),
                "Surv_Name": row.get("Surv_Name"),
                "ABSTRACT_L": row.get("ABSTRACT_L"),
                "ABSTRACT_N": row.get("ABSTRACT_N"),
            }
        )

    # 3) User-requested grouping preview by abstract / county_lease_name / field_name
    owners_by_abstract = defaultdict(list)
    for owner in all_owners:
        key = (
            to_abstract_code(owner.get("abstract"))
            or owner.get("county_lease_name", "")
            or owner.get("field_name", "")
            or ""
        )
        owners_by_abstract[key].append(owner)
    print(f"Unique abstract/group keys with owners: {len(owners_by_abstract)}")
    print("Sample keys:", list(owners_by_abstract.keys())[:10])

    # PRIMARY MATCH: owner.abstract -> parcel abstract number. ``ABSTRACT_N``
    # is set above for both Howard (from CODE) and Martin (derived from
    # ABSTRACT_L) shapefiles, so use it as the canonical join key.
    code_to_abstract_label: dict[str, str] = {}
    for idx in parcels_gdf.index:
        label_l = norm_text(parcels_gdf.at[idx, "ABSTRACT_L"])
        code = to_abstract_code(parcels_gdf.at[idx, "CODE"]) if "CODE" in parcels_gdf.columns else ""
        code = code or to_abstract_code(parcels_gdf.at[idx, "ABSTRACT_N"])
        # Numeric abstract ("441" -> bucket "A-441"). Grid tracts (Winkler PSL)
        # carry no numeric abstract; geopandas round-trips their empty
        # ABSTRACT_N as the literal "nan"/"none", so guard against it.
        if code and code.strip().lower() not in {"nan", "none"}:
            code_to_abstract_label.setdefault(code, f"A-{code}")
        # Self-map the full ABSTRACT_L so an owner whose recovered `abstract`
        # is already the tract key (recover_owner_tracts writes "A-441" for
        # abstract tracts and "B10--S5" for grid tracts) text-matches directly.
        if label_l and label_l.lower() not in {"nan", "none"}:
            code_to_abstract_label.setdefault(label_l, label_l)

    # Re-resolve weak/missing abstracts from survey / raw_record / lat-lon
    # before the primary join (Howard Block/Surv_Sect + Martin LEVEL* + lease map).
    if ARGS.spatial_only:
        print("Spatial-only mode: skipping AbstractMatcher + abstract text join.")
    try:
        if ARGS.spatial_only:
            raise RuntimeError("spatial-only")
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from abstract_match import AbstractMatcher

        matcher = AbstractMatcher(input_parcels_path)
        resolved = 0
        for owner in all_owners:
            row = dict(owner)
            rr = owner.get("raw_record")
            if isinstance(rr, dict):
                for key in ("survey", "abstract", "block", "section", "lat", "long", "rrc_id"):
                    if not row.get(key) and rr.get(key) is not None:
                        row[key] = rr.get(key)
                if not row.get("rrc_lease_id") and rr.get("rrc_id") is not None:
                    row["rrc_id"] = rr.get("rrc_id")
            bare, method = matcher.resolve(row)
            if bare and method != "unplaced":
                if to_abstract_code(owner.get("abstract")) != bare:
                    owner["abstract"] = bare
                    resolved += 1
                elif not owner.get("abstract"):
                    owner["abstract"] = bare
                    resolved += 1
        print(f"Re-resolved abstracts via AbstractMatcher: {resolved}")
    except Exception as exc:
        print(f"AbstractMatcher unavailable ({exc}); using stored abstracts only.")

    owner_id_to_abstract: dict[str, str] = {}
    if not ARGS.spatial_only:
        for owner in all_owners:
            owner_id = str(owner.get("id", ""))
            owner_code = to_abstract_code(owner.get("abstract"))
            if owner_id and owner_code in code_to_abstract_label:
                owner_id_to_abstract[owner_id] = code_to_abstract_label[owner_code]

    fallback_name_hits = 0
    print(
        f"After direct abstract matching: {len(owner_id_to_abstract)} owners mapped to abstracts"
    )

    # Spatial fallback: ~10% of Martin owners either carry `abstract='SEC'`
    # (a broken ingest sentinel from the source vendor), a null abstract,
    # or an abstract that doesn't exist in the county's Abstracts.shp
    # ("orphan" abstracts — the shapefile predates a re-plat). About half
    # of those rows do carry a real lat/lon inside `raw_record`, so we
    # can point-in-polygon them into the containing tract as a second
    # pass. Same code path helps Howard / Gonzales too whenever an owner
    # lands in the same bucket.
    def _owner_coords(row: dict[str, Any]) -> tuple[float, float] | None:
        rr = row.get("raw_record")
        if not isinstance(rr, dict):
            return None
        try:
            lat = float(rr.get("lat"))
            lon = float(rr.get("long"))
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(lat) and math.isfinite(lon)):
            return None
        if abs(lat) < 1 or abs(lon) < 1:
            return None
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            return None
        return lon, lat

    unmapped_with_coords: list[tuple[str, float, float]] = []
    for owner in all_owners:
        owner_id = str(owner.get("id", ""))
        if not owner_id or owner_id in owner_id_to_abstract:
            continue
        coords = _owner_coords(owner)
        if coords is None:
            continue
        unmapped_with_coords.append((owner_id, coords[0], coords[1]))

    spatial_hits = 0
    if unmapped_with_coords:
        try:
            from shapely.geometry import Point
            from shapely.strtree import STRtree

            geoms = list(parcels_gdf.geometry.values)
            # Two label arrays. `code_labels` is the "A-<code>" bucket for real
            # abstract tracts (empty for grid tracts); `grid_labels` is the raw
            # ABSTRACT_L (e.g. Winkler "B26-S39"). Prefer an abstract tract when
            # the point falls in one — counties like Ward/Midland have
            # overlapping abstract + grid tracts, and the abstract tract is the
            # meaningful bucket. Only fall back to a grid tract's ABSTRACT_L
            # when NO abstract tract contains the point (Winkler PSL, or gaps).
            code_labels = [
                code_to_abstract_label.get(
                    to_abstract_code(parcels_gdf.at[idx, "ABSTRACT_N"]), ""
                )
                for idx in parcels_gdf.index
            ]
            grid_labels = [
                norm_text(parcels_gdf.at[idx, "ABSTRACT_L"])
                for idx in parcels_gdf.index
            ]
            tree = STRtree(geoms)
            for owner_id, lon, lat in unmapped_with_coords:
                point = Point(lon, lat)
                assigned = None
                grid_fallback = None
                for i in tree.query(point):
                    if not geoms[i].contains(point):
                        continue
                    if code_labels[i]:
                        assigned = code_labels[i]
                        break
                    if grid_fallback is None and grid_labels[i]:
                        grid_fallback = grid_labels[i]
                label = assigned or grid_fallback
                if label:
                    owner_id_to_abstract[owner_id] = label
                    spatial_hits += 1
        except ImportError:
            print(
                "  shapely not available; skipping spatial-fallback pass "
                "(pip install shapely to enable)."
            )
    print(
        f"After spatial fallback: {len(owner_id_to_abstract)} owners mapped "
        f"(+{spatial_hits} via lat/lon; {len(unmapped_with_coords) - spatial_hits} "
        f"coord-carrying rows still outside every parcel)."
    )

    tract_label_set = {
        norm_text(parcels_gdf.at[idx, "ABSTRACT_L"]) for idx in parcels_gdf.index
    }
    tract_label_set.discard("")

    # Fallback B: survey-text. Owners with no usable coordinates still carry
    # the block/section in their `survey` string; parse it into the same
    # ABSTRACT_L key and attach when it matches a real tract.
    if ARGS.survey_tract_parser:
        try:
            parser_mod = _load_survey_parser(ARGS.survey_tract_parser)
        except Exception as exc:  # noqa: BLE001
            parser_mod = None
            print(f"  survey-text parser '{ARGS.survey_tract_parser}' unavailable: {exc}")
        if parser_mod is not None:
            text_hits = 0
            for owner in all_owners:
                oid = str(owner.get("id", ""))
                if not oid or oid in owner_id_to_abstract:
                    continue
                key = owner_survey_tract_key(owner, parser_mod)
                if key and norm_text(key) in tract_label_set:
                    owner_id_to_abstract[oid] = norm_text(key)
                    text_hits += 1
            print(f"After survey-text fallback: {len(owner_id_to_abstract)} owners "
                  f"mapped (+{text_hits} via parsed survey block/section).")

    # Fallback C: lease/well. Attach a still-unmapped owner to the tract of a
    # well on its lease — owner `api` list / rrc_lease_id -> <county>_wells ->
    # the well's tract. Same lease/well reference-point convention the roll
    # uses for its own coordinates.
    if ARGS.attach_via_wells:
        wells_table = ARGS.wells_table or f"{COUNTY_ID}_wells"
        well_client = None
        try:
            supa_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
            supa_key = (
                os.getenv("SUPABASE_KEY")
                or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
                or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
            )
            if supa_url and supa_key:
                well_client = create_client(supa_url, supa_key)
        except Exception as exc:  # noqa: BLE001
            print(f"  attach-via-wells: no Supabase client ({exc}); skipping.")
        if well_client is not None:
            try:
                api2tract, lease2tract = build_well_tract_maps(
                    well_client, wells_table, parcels_gdf
                )
                print(f"  well->tract maps: {len(api2tract)} api, {len(lease2tract)} lease")
                well_hits = 0
                for owner in all_owners:
                    oid = str(owner.get("id", ""))
                    if not oid or oid in owner_id_to_abstract:
                        continue
                    label = None
                    rr = owner.get("raw_record") if isinstance(owner.get("raw_record"), dict) else {}
                    api_field = owner.get("api") or (rr.get("api") if rr else None)
                    if api_field:
                        for token in str(api_field).split(","):
                            api8 = _norm_api(token)
                            if api8 and api8 in api2tract:
                                label = api2tract[api8]
                                break
                    if label is None:
                        lease = str(
                            owner.get("rrc_lease_id")
                            or (rr.get("rrc_id") if rr else "")
                            or ""
                        ).strip()
                        if lease and lease in lease2tract:
                            label = lease2tract[lease]
                    if label:
                        owner_id_to_abstract[oid] = label
                        well_hits += 1
                print(f"After lease/well fallback: {len(owner_id_to_abstract)} owners "
                      f"mapped (+{well_hits} via api/lease -> well tract).")
            except Exception as exc:  # noqa: BLE001
                print(f"  attach-via-wells failed ({exc}); skipping.")

    # Final dictionary: abstract identifier -> list[owners]
    owners_by_abstract_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for owner in all_owners:
        abstract_id = owner_id_to_abstract.get(str(owner["id"]))
        if abstract_id:
            owners_by_abstract_id[norm_text(abstract_id)].append(owner)

    # 4) Enrich polygons
    matched_polygons = 0
    represented_owner_ids: set[str] = set()
    polygon_rankings: list[dict[str, Any]] = []

    for idx in parcels_gdf.index:
        abstract_l = norm_text(parcels_gdf.at[idx, "ABSTRACT_L"])
        owners = owners_by_abstract_id.get(abstract_l, [])
        if owners:
            matched_polygons += 1
            represented_owner_ids.update(str(owner.get("id")) for owner in owners)
            highest = max(owners, key=lambda item: to_int(item.get("propensity_score")))
            operator_counter = Counter(
                (owner.get("operator_name") or "").strip()
                for owner in owners
                if (owner.get("operator_name") or "").strip()
            )
            top_operator = (
                operator_counter.most_common(1)[0][0] if operator_counter else ""
            )

            parcels_gdf.at[idx, "max_propensity_score"] = to_int(
                highest.get("propensity_score")
            )
            # Field name: most common non-null field across owners in tract.
            field_names = [
                owner.get("field_name")
                for owner in owners
                if (owner.get("field_name") or "")
            ]
            top_field = (
                Counter(str(name).strip() for name in field_names).most_common(1)[0][0]
                if field_names
                else "Unknown"
            )
            parcels_gdf.at[idx, "field_name"] = top_field

            # First date: earliest lease start date among tract owners.
            first_dates = [
                str(owner.get("first_date", ""))[:10]
                for owner in owners
                if owner.get("first_date")
            ]
            earliest_date = min(first_dates) if first_dates else ""
            parcels_gdf.at[idx, "first_date"] = earliest_date

            parcels_gdf.at[idx, "owner_count"] = len(owners)
            parcels_gdf.at[idx, "top_owner"] = highest.get("owner_name") or ""
            parcels_gdf.at[idx, "top_owner_state"] = highest.get("mailing_state") or ""
            parcels_gdf.at[idx, "top_operator"] = top_operator

            # Tract-level production aggregates for charting.
            oil_6 = [float(owner.get("first_6_month_oil", 0) or 0) for owner in owners]
            oil_12 = [float(owner.get("first_12_month_oil", 0) or 0) for owner in owners]
            oil_24 = [float(owner.get("first_24_month_oil", 0) or 0) for owner in owners]
            oil_60 = [float(owner.get("first_60_month_oil", 0) or 0) for owner in owners]
            oil_cum = [
                float(owner.get("prod_cumulative_sum_oil", 0) or 0) for owner in owners
            ]

            parcels_gdf.at[idx, "first_6_month_oil"] = sum(oil_6)
            parcels_gdf.at[idx, "first_12_month_oil"] = sum(oil_12)
            parcels_gdf.at[idx, "first_24_month_oil"] = sum(oil_24)
            parcels_gdf.at[idx, "first_60_month_oil"] = sum(oil_60)
            parcels_gdf.at[idx, "prod_cumulative_sum_oil"] = sum(oil_cum)

            avg_early = sum(oil_6) / max(len(oil_6), 1)
            avg_late = sum(oil_60) / max(len(oil_60), 1)
            decline_pct = (
                round((avg_early - avg_late) / max(avg_early, 1) * 100, 1)
                if avg_early > 0
                else 0
            )
            parcels_gdf.at[idx, "decline_pct"] = decline_pct
            parcels_gdf.at[idx, "production_trend"] = (
                "declining"
                if decline_pct > 30
                else "stable"
                if decline_pct > -10
                else "growing"
            )

            # Lease status logic:
            # - Active production: HBP (held by production), no fixed expiration.
            # - No production: estimate from first date + 5-year primary term.
            has_production = any(
                (owner.get("prod_cumulative_sum_oil") or 0) > 0 for owner in owners
            )
            production_trend = str(
                parcels_gdf.at[idx, "production_trend"] or "unknown"
            )

            if has_production:
                if production_trend == "declining":
                    est_expiration = "HBP - declining"
                else:
                    est_expiration = "HBP - active"
            elif earliest_date:
                try:
                    d = datetime.strptime(earliest_date, "%Y-%m-%d")
                    exp_year = d.year + 5
                    exp_date = date(exp_year, d.month, 1)
                    today = date.today()
                    if exp_date < today:
                        est_expiration = f"Expired {d.strftime('%b %Y')} - open acreage"
                    else:
                        months_left = (
                            (exp_date.year - today.year) * 12
                            + (exp_date.month - today.month)
                        )
                        est_expiration = (
                            f"Exp {exp_date.strftime('%b %Y')} ({months_left}mo)"
                        )
                except Exception:
                    est_expiration = "Unknown"
            else:
                est_expiration = "Unknown"

            parcels_gdf.at[idx, "est_lease_expiration"] = est_expiration
            owners_for_panel: list[dict[str, Any]] = []
            for owner in sorted(
                owners, key=lambda item: to_int(item.get("propensity_score")), reverse=True
            ):
                raw_record = owner.get("raw_record")
                interest_value = None
                if isinstance(raw_record, dict):
                    interest_value = raw_record.get("Interest")
                try:
                    # Store the raw 0-1 decimal interest, matching the DB
                    # (<county>_mineral_ownership.ownership_pct) and the
                    # frontend's ownershipPctIsDecimal convention, which
                    # multiplies by 100 for display. Multiplying here too
                    # double-scaled every embedded interest 100x (a 0.25%
                    # override royalty rendered as "25%").
                    ownership_pct = (
                        round(float(interest_value), 6)
                        if interest_value is not None
                        else None
                    )
                except (TypeError, ValueError):
                    ownership_pct = None

                def as_bool(value: Any) -> bool:
                    if isinstance(value, bool):
                        return value
                    if isinstance(value, (int, float)):
                        return value != 0
                    if isinstance(value, str):
                        return value.strip().lower() in {"1", "true", "yes", "y"}
                    return False

                owners_for_panel.append(
                    {
                        "owner_name": owner.get("owner_name", "") or "",
                        "propensity_score": to_int(owner.get("propensity_score", 0)),
                        "mailing_city": owner.get("mailing_city", "") or "",
                        "mailing_state": owner.get("mailing_state", "") or "",
                        "mailing_zip": owner.get("mailing_zip", "") or "",
                        "address_1": owner.get("address_1", "")
                        or owner.get("address", "")
                        or owner.get("mailing_address", "")
                        or "",
                        "out_of_state": as_bool(owner.get("out_of_state", False)),
                        "motivated": as_bool(owner.get("motivated", False)),
                        "operator_name": owner.get("operator_name", "") or "",
                        "rrc_lease_id": str(owner.get("rrc_lease_id", "") or ""),
                        "acreage": owner.get("acreage", 0),
                        "ownership_pct": (
                            ownership_pct
                            if ownership_pct is not None
                            else owner.get("ownership_pct", 0)
                        ),
                    }
                )

            parcels_gdf.at[idx, "owners_json"] = json.dumps(owners_for_panel)

            polygon_rankings.append(
                {
                    "abstract": parcels_gdf.at[idx, "ABSTRACT_L"],
                    "owner_count": len(owners),
                    "max_propensity_score": int(parcels_gdf.at[idx, "max_propensity_score"]),
                    "top_owner": parcels_gdf.at[idx, "top_owner"],
                }
            )
        else:
            parcels_gdf.at[idx, "max_propensity_score"] = 0
            parcels_gdf.at[idx, "field_name"] = "Unknown"
            parcels_gdf.at[idx, "first_date"] = ""
            parcels_gdf.at[idx, "est_lease_expiration"] = "Unknown"
            parcels_gdf.at[idx, "owner_count"] = 0
            parcels_gdf.at[idx, "top_owner"] = ""
            parcels_gdf.at[idx, "top_owner_state"] = ""
            parcels_gdf.at[idx, "top_operator"] = ""
            parcels_gdf.at[idx, "owners_json"] = "[]"
            parcels_gdf.at[idx, "first_6_month_oil"] = 0
            parcels_gdf.at[idx, "first_12_month_oil"] = 0
            parcels_gdf.at[idx, "first_24_month_oil"] = 0
            parcels_gdf.at[idx, "first_60_month_oil"] = 0
            parcels_gdf.at[idx, "prod_cumulative_sum_oil"] = 0
            parcels_gdf.at[idx, "decline_pct"] = 0
            parcels_gdf.at[idx, "production_trend"] = "stable"

    # 5) Save and copy
    OUTPUT_PARCELS.parent.mkdir(parents=True, exist_ok=True)
    parcels_gdf.to_file(OUTPUT_PARCELS, driver="GeoJSON")

    PUBLIC_PARCELS.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_PARCELS.write_text(OUTPUT_PARCELS.read_text(encoding="utf-8"), encoding="utf-8")

    # 6) Summary metrics
    print(f"Total polygons enriched: {len(parcels_gdf)}")
    print(f"How many matched at least one owner: {matched_polygons}")
    print(f"Total owners represented: {len(represented_owner_ids)}")
    print(
        f"Owners not represented (no abstract mapping found): "
        f"{len(all_owners) - len(represented_owner_ids)}"
    )
    print(f"Fallback owner mappings via county_lease_name: {fallback_name_hits}")

    polygon_rankings.sort(key=lambda item: item["owner_count"], reverse=True)
    print("Top 5 polygons by owner count:")
    for item in polygon_rankings[:5]:
        print(item)


if __name__ == "__main__":
    main()
