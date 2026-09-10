#!/usr/bin/env python3
"""Generate slim GeoJSON files for the Mapbox renderer.

The full *_parcels_enriched.geojson files are 24–53 MB because they embed
``owners_json`` (a complete list of mineral owners per tract) inside every
feature. The CRM panel needs that data, but Mapbox does not — it only reads
geometry + a handful of small properties. Shipping the heavy file to the
worker thread for tile generation was causing visible coloring delay at
low/medium zoom.

This script reads the existing enriched files and emits a parallel
*_parcels_map.geojson that retains only the props the map actually uses.
The full files are still served to the rest of the app.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Property keys that the map cares about. Anything not in this set is
# stripped before the file is written.
KEEP_PROPS = {
    # Identifiers / labels
    'ABSTRACT_L', 'ABSTRACT_N', 'CODE',
    # Survey/legal description. Field-name convention varies by county:
    #   Howard   — Surv_Name / Block / Surv_Sect / DESC_
    #   Martin   — LEVEL1_SUR / LEVEL2_BLO / LEVEL3_SUR / LEVEL4_SUR
    #   Gonzales — LEVEL1_SUR / LEVEL2_BLO / TEXTSTRING (abstract label)
    # LEVEL3_SUR carries Martin's per-tract section number ("131", "36",
    # etc.) — the same role Surv_Sect plays for Howard. The section
    # labels layer in app/components/Map.tsx coalesces the two, so
    # keeping LEVEL3_SUR here is what makes Martin's section numbers
    # actually render on the map.
    'Block', 'Surv_Name', 'Surv_Sect', 'DESC_',
    'LEVEL1_SUR', 'LEVEL2_BLO', 'LEVEL3_SUR', 'LEVEL4_SUR', 'TEXTSTRING',
    # Precomputed per-tract legal description string, e.g.
    #   "T1N BLK 35 SEC 36 A-1013"  (Howard / Martin T&P)
    #   "COOK, W H A-160"           (Gonzales survey abstracts)
    # Rendered on the map at high zoom by parcels-labels-{countyId}.
    # Precomputed here (rather than in Mapbox expressions) because
    # extracting the township from a mixed "31 T2N" block string needs
    # regex, which is not expressible in the paint DSL.
    'legal_desc',
    # Geometry helpers
    'SHAPE_AREA', 'STArea__',
    # Paint inputs: parcel-level well activity classification. `production_status`
    # is a categorical (pdp / pud / new_permit / pending_permit / none) written
    # by scripts/add_production_status.py; the counts feed the sidebar's
    # PDP/PUD/permits stat cards. `max_propensity_score` is retained during the
    # transition so previously deployed clients don't hard-fail; new client code
    # ignores it.
    'production_status', 'pdp_well_count', 'pud_well_count', 'well_count',
    'permit_count', 'new_permit_count', 'pending_permit_count',
    'max_propensity_score',
    # Misc that the map labels/popups read
    'owner_count', 'top_operator', 'field_name',
    'first_date', 'production_trend', 'est_lease_expiration',
}


def _clean(value) -> str:
    """Strip a value and return '' for None / literal 'None' / 'nan'."""
    if value is None:
        return ''
    text = str(value).strip()
    if text.lower() in {'none', 'nan', ''}:
        return ''
    return text


def build_legal_desc(props: dict) -> str:
    """Assemble a compact legal description string per tract.

    Mirrors buildLegalDescription() in app/page.tsx so the map label and
    the sidebar carry the same identifier. Handles both:

    * **T&P-style counties** (Howard, Martin, most Permian counties)
      where Block is "31 T2N" (Howard) or "35 T1N" (Martin), and each
      section number is stored in Surv_Sect or LEVEL3_SUR. Emits e.g.
      "T2N BLK 31 SEC 20 A-543".

    * **Non-T&P counties** (Gonzales) where blocks aren't part of the
      identifier — emits "COOK, W H A-160" instead.
    """
    abstract_l = _clean(props.get('ABSTRACT_L'))
    # Only bare numeric abstracts get the "A-" prefix. Winkler grid tracts use
    # a "B<block>-S<section>" key that is not an abstract — leave it out of the
    # label (the block/section below carry the identifier instead).
    is_grid_key = bool(re.match(r'^B.*-S', abstract_l.upper())) if abstract_l else False
    if abstract_l and not abstract_l.upper().startswith('A-'):
        if re.fullmatch(r'\d+', abstract_l):
            abstract_l = f'A-{abstract_l}'
        elif is_grid_key:
            abstract_l = ''

    block_raw = _clean(props.get('Block') or props.get('BLOCK') or props.get('LEVEL2_BLO'))
    section = _clean(props.get('Surv_Sect') or props.get('LEVEL3_SUR'))
    survey = _clean(props.get('Surv_Name') or props.get('LEVEL1_SUR') or props.get('DESC_'))

    # T&P coordinate parsing: "31 T2N" -> block="31", township="T2N".
    township = ''
    block_number = block_raw
    match = re.search(r'(T\d+[NS])', block_raw.upper()) if block_raw else None
    if match:
        township = match.group(1)
        block_number = re.sub(r'\s*T\d+[NS]\s*', '', block_raw, flags=re.IGNORECASE).strip()

    if township:
        parts = [township]
        if block_number:
            parts.append(f'BLK {block_number}')
        if section:
            parts.append(f'SEC {section}')
        if abstract_l:
            parts.append(abstract_l)
        return ' '.join(parts)

    # Winkler PSL grid (no T&P township, no numeric abstract): render
    # "PSL BLK 26 SEC 39" from the block/section. Gated on the grid-key shape
    # so the existing abstract counties keep their survey+abstract label.
    if is_grid_key and block_number and section:
        parts = []
        if survey:
            parts.append(survey)
        parts.append(f'BLK {block_number}')
        parts.append(f'SEC {section}')
        return ' '.join(parts)

    # Fallback (Gonzales-style): survey name + abstract label.
    if survey and abstract_l:
        return f'{survey} {abstract_l}'
    return abstract_l or survey

INPUT_OUTPUT_PAIRS = [
    ('public/gonzales_parcels_enriched.geojson', 'public/gonzales_parcels_map.geojson'),
    ('public/howard_parcels_enriched.geojson',   'public/howard_parcels_map.geojson'),
    ('public/martin_parcels_enriched.geojson',   'public/martin_parcels_map.geojson'),
    ('public/midland_parcels_enriched.geojson',  'public/midland_parcels_map.geojson'),
    ('public/loving_parcels_enriched.geojson',   'public/loving_parcels_map.geojson'),
    ('public/reagan_parcels_enriched.geojson',   'public/reagan_parcels_map.geojson'),
    ('public/upton_parcels_enriched.geojson',    'public/upton_parcels_map.geojson'),
    ('public/ward_parcels_enriched.geojson',     'public/ward_parcels_map.geojson'),
    ('public/winkler_parcels_enriched.geojson',  'public/winkler_parcels_map.geojson'),
]


def slim_feature(feature: dict) -> dict:
    props = feature.get('properties') or {}
    slim_props = {k: props[k] for k in KEEP_PROPS if k in props}
    slim_props['legal_desc'] = build_legal_desc(props)
    return {
        'type': 'Feature',
        'geometry': feature.get('geometry'),
        'properties': slim_props,
    }


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    for in_rel, out_rel in INPUT_OUTPUT_PAIRS:
        in_path = repo_root / in_rel
        out_path = repo_root / out_rel
        if not in_path.exists():
            print(f'skip: {in_rel} not found')
            continue

        in_size = in_path.stat().st_size
        with in_path.open() as f:
            collection = json.load(f)

        slim = {
            'type': 'FeatureCollection',
            'features': [slim_feature(feat) for feat in collection.get('features', [])],
        }

        # No pretty-printing: smallest payload to ship to the browser.
        with out_path.open('w') as f:
            json.dump(slim, f, separators=(',', ':'))

        out_size = out_path.stat().st_size
        ratio = (out_size / in_size) * 100 if in_size else 0
        print(
            f'{in_rel} -> {out_rel}: {in_size / 1e6:.1f} MB -> '
            f'{out_size / 1e6:.2f} MB ({ratio:.1f}% of original)'
        )


if __name__ == '__main__':
    main()
