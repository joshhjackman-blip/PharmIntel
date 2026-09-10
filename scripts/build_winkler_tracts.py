#!/usr/bin/env python3
"""Build a tract layer for Winkler County from its StratMap land parcels.

Winkler is unlike the other Permian section-grid counties (Midland/Reagan/
Upton), whose parcel LEGAL_DESC + owner roll both carry a clean
"BLK <n> SEC <n> A-<n>" survey grid. Winkler's CAD data mixes several shapes
inside a single free-text field and *never* fills the roll's explicit
abstract/block/section columns, so the shared scripts/build_county_tracts.py
resolved only ~20% of parcels (leaving ~40% of owners with no containing
tract). Formats seen in the parcel LEGAL_DESC / roll `survey` text:

    "1729    A-56    PSL SEC 15"      -> abstract 56, section 15   (named abstract)
    "1839    26      PSL SEC 1"       -> block 26, section 1       (bare block number)
    "B-5 39 PSL NE4SW4"               -> block B-5, section 39     (B-block, positional sec)
    "26 39 PSL W2NE4"                 -> block 26, section 39      (positional block + sec)
    "F 48 G&MMB&A E2&S2NW4"           -> block F, section 48       (letter block)
    "253 45-2N T&P RY CO SEC 5"       -> block 45 T2N, section 5   (T&P block-township)
    "608 N WILDCAT DR ... WINK ORIGINAL" -> town lot (no minerals) -> dropped

Strategy: dissolve parcels into tracts keyed by the explicit abstract when
present, otherwise the (block, section) grid cell. Owners are attached
downstream in enrich_county_parcels.py primarily by a lat/lon spatial join
(the roll carries coordinates for ~70% of rows), so the important thing here
is broad *geometric* coverage of the county's mineral acreage. Town/city lots
(Wink & Kermit subdivisions) carry no survey grid and are intentionally left
out — they hold no mineral interest.

Output mirrors the Martin-style Abstracts.shp schema the rest of the pipeline
already understands (ABSTRACT_L / ABSTRACT_N / LEVEL1_SUR / LEVEL2_BLO /
LEVEL3_SUR / Surv_Sect / SHAPE_AREA).

Usage:
  python3 scripts/build_winkler_tracts.py \
      --src data/_src_winkler/shp/stratmap25-landparcels_48495_winkler_202503.shp
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent

# Explicit abstract, e.g. "A-56", "A 1739". Bare "AB 935" form (Reagan) does
# not occur in Winkler, so require the leading "A".
_ABS = re.compile(r"\bA[-\s]?(\d{1,4})\b")
# Section: "SEC 15", "SECTION 15", "SECT 15". Trailing non-digit is allowed
# ("SEC 39E/2" -> 39) via a negative digit lookahead instead of \b.
_SEC = re.compile(r"\bSEC(?:TION|T)?\.?\s*(\d{1,3})(?![0-9])")
# University-Lands sec-first grid: "SEC 12 20" / "SEC 1 21" — the block is the
# bare number (or B-/letter block) right after the section, with no PSL anchor.
_SEC_FIRST = re.compile(r"^SEC(?:TION|T)?\.?\s+\d{1,3}\s+(\d{1,3}|B-?\d+|[A-Z]-?\d*)\b")
# T&P-style block-township, e.g. "45-2N" / "46T1N".
_BLK_TWN = re.compile(r"\b(\d{1,3})[-\s]?(T?\d+[NS])\b")
# Explicit "BLK <x>" / "BLOCK <x>" token.
_BLK_KW = re.compile(r"\b(?:BLK|BLOCK)\s*([A-Z]?-?\d{1,3}|[A-Z])\b")
# "B-5" / "B 12" PSL block.
_B_DASH = re.compile(r"\bB[-\s]?(\d{1,2})\b")

# Surveyor / system anchors — the token(s) that separate the survey grid
# from the metes-and-bounds portion of the description.
_SURVEYORS = ("PSL", "G&MMB&A", "G&MMBA", "T&PRR", "T&P", "SF", "WF", "H&TC",
              "G&MMB", "OATES")

# Town / city subdivision hints — parcels we deliberately skip.
_TOWN = re.compile(
    r"ORIGINAL|ADDITION|\bADDN\b|WINDSOR|BROWN ALTMAN|PERRY|HEIGHTS|\bHTS\b|"
    r"SUBD|\bLOTS?\b|\bBLK\b\s*\d+\s*\bLOT|WILDCAT|MONAHANS"
)


def norm(s) -> str:
    return " ".join(str(s or "").upper().split())


def _first_surveyor(u: str) -> tuple[str | None, int]:
    """Return (surveyor, index) of the earliest surveyor anchor in ``u``."""
    best: tuple[str | None, int] = (None, len(u) + 1)
    for name in _SURVEYORS:
        idx = u.find(name)
        if idx != -1 and idx < best[1]:
            best = (name, idx)
    return best


def parse(legal: str):
    """Return (tkey, abstract_num, block, twn, sec, surveyor) or None.

    ``tkey`` is the dissolve key: ``A:<abstract>`` when an explicit abstract is
    present, else ``G:<block>|<twn>|<sec>`` for the survey grid cell.
    """
    u = norm(legal)
    if not u:
        return None

    abs_m = _ABS.search(u)
    sec_m = _SEC.search(u)
    surveyor, surv_idx = _first_surveyor(u)

    abstract = abs_m.group(1) if abs_m else ""
    sec = sec_m.group(1) if sec_m else ""

    block = ""
    twn = ""
    bt = _BLK_TWN.search(u)
    bk = _BLK_KW.search(u)
    bd = _B_DASH.search(u)
    if bt:
        block, twn = bt.group(1), bt.group(2).upper()
    elif bk:
        block = bk.group(1).upper()
    elif bd:
        block = "B" + bd.group(1)

    # Positional fallback for the dominant "<blk> <sec> <SURVEYOR>" /
    # "<propid> <blk> <sec> <SURVEYOR>" shapes, where the grid numbers sit
    # immediately before the surveyor anchor and there is no BLK/B- token.
    if surveyor is not None and (not block or not sec):
        pre = u[:surv_idx].strip()
        nums = re.findall(r"\b(\d{1,4})\b", pre)
        # Drop a leading CAD property-id: a >=4-digit number that is clearly
        # not a 1-3 digit block/section. Winkler blocks/sections are <= 3
        # digits; property ids are 3-5 digits and appear first.
        small = [n for n in nums if len(n) <= 3]
        if not block and not sec:
            if len(small) >= 2:
                block, sec = small[0], small[1]
            elif len(small) == 1:
                block = small[0]
        elif block and not sec and small:
            # e.g. "B-5 39 PSL": block already B5, section is the trailing num.
            trailing = [n for n in small if n != block.lstrip("B")]
            if trailing:
                sec = trailing[-1]
        elif sec and not block and small:
            # Prefer a number that differs from the section, but a lone number
            # equal to the section is still the block (Section N of Block N),
            # e.g. "1372 26 PSL SEC 26".
            cand = [n for n in small if n != sec]
            block = cand[0] if cand else small[0]

    # University-Lands sec-first grid ("SEC 12 20"): block is the token right
    # after the section when nothing else supplied one.
    if sec and not block:
        m = _SEC_FIRST.match(u)
        if m:
            tok = m.group(1).upper()
            block = ("B" + tok[1:].lstrip("-") if tok.startswith("B") and tok[1:].lstrip("-").isdigit() else tok)

    if abstract:
        return (f"A:{abstract}", abstract, block, twn, sec, surveyor or "")
    if block and sec:
        return (f"G:{block}|{twn}|{sec}", "", block, twn, sec, surveyor or "")
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--src",
        default="data/_src_winkler/shp/stratmap25-landparcels_48495_winkler_202503.shp",
        help="StratMap land-parcel .shp path for Winkler (FIPS 48495).",
    )
    ap.add_argument("--county", default="winkler")
    args = ap.parse_args()

    print(f"Reading parcels: {args.src}", flush=True)
    g = gpd.read_file(args.src)
    g = g.set_crs("EPSG:4326") if g.crs is None else g.to_crs("EPSG:4326")

    info = g["LEGAL_DESC"].map(parse)
    placed = int(info.notna().sum())
    print(f"  parcels resolved to a tract: {placed}/{len(g)} "
          f"({100 * placed / len(g):.1f}%)", flush=True)

    g = g[info.notna()].copy()
    info = info[info.notna()]
    g["tkey"] = info.map(lambda k: k[0])
    g["pabs"] = info.map(lambda k: k[1])
    g["block"] = info.map(lambda k: k[2])
    g["twn"] = info.map(lambda k: k[3])
    g["sec"] = info.map(lambda k: k[4])
    g["surv"] = info.map(lambda k: k[5])

    print("Dissolving into tracts (explicit abstract, else block/section grid)...",
          flush=True)
    tracts = g.dissolve(by="tkey", as_index=False, aggfunc="first")[
        ["tkey", "pabs", "block", "twn", "sec", "surv", "geometry"]
    ]
    print(f"  tracts: {len(tracts)}", flush=True)

    def label_row(r):
        absn = str(r["pabs"] or "").strip()
        blk = str(r["block"] or "").strip()
        twn = str(r["twn"] or "").strip()
        sec = str(r["sec"] or "").strip()
        surv = str(r["surv"] or "").strip()
        if absn:
            abstract_l = f"A-{absn}"
            abstract_n = absn
        else:
            # Unique, human-readable grid key. LEVEL2_BLO/LEVEL3_SUR carry the
            # block/section so build_map_geojson renders "PSL BLK 26 SEC 39".
            twn_sfx = f"-{twn}" if twn else ""
            abstract_l = f"B{blk}{twn_sfx}-S{sec}"
            abstract_n = ""
        block_lvl = f"{blk} {twn}".strip()
        return abstract_l, abstract_n, surv, block_lvl, sec

    labels = [label_row(r) for _, r in tracts.iterrows()]
    tracts["ABSTRACT_L"] = [x[0] for x in labels]
    tracts["ABSTRACT_N"] = [x[1] for x in labels]
    tracts["LEVEL1_SUR"] = [x[2] for x in labels]
    tracts["LEVEL2_BLO"] = [x[3] for x in labels]
    tracts["LEVEL3_SUR"] = [x[4] for x in labels]
    tracts["Surv_Sect"] = tracts["sec"]

    # Merge any tracts that resolved to the same label into a single polygon
    # (keeps ABSTRACT_L unique for the map keying + tract_development_status).
    before = len(tracts)
    tracts = tracts.dissolve(by="ABSTRACT_L", as_index=False, aggfunc="first")
    if len(tracts) != before:
        print(f"  merged duplicate-label tracts: {before} -> {len(tracts)}", flush=True)

    tracts["SHAPE_AREA"] = tracts.to_crs("EPSG:5070").geometry.area / 4046.8564224

    out_dir = ROOT / "data" / args.county
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "Abstracts.shp"
    keep = tracts[["ABSTRACT_L", "ABSTRACT_N", "LEVEL1_SUR", "LEVEL2_BLO",
                   "LEVEL3_SUR", "Surv_Sect", "SHAPE_AREA", "geometry"]].copy()
    keep.to_file(out)
    with_abs = int((tracts["ABSTRACT_N"].astype(str).str.len() > 0).sum())
    print(f"Wrote {out} ({len(keep)} tracts; {with_abs} with a named abstract)",
          flush=True)


if __name__ == "__main__":
    main()
