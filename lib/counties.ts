export type County = {
  id: string
  name: string
  state: string
  displayName: string
  mapCenter: [number, number]
  mapZoom: number
  fips: string
  fipsCode: string
  ownershipTable: string
  wellsTable: string
  geoJsonPath: string
  // Slim variant of geoJsonPath used by the Mapbox renderer. Drops the
  // ~95–98% of bytes that come from the embedded `owners_json` payload —
  // those owners are still loaded from the full file in `app/page.tsx` for
  // the side panel, but Mapbox doesn't need them and was choking on the
  // 24/53 MB FeatureCollections during low/medium-zoom tile generation.
  mapGeoJsonPath: string
  breakdown: { operator: string; pct: number }[]
  ownershipPctIsDecimal: boolean  // true = Howard style
  abstractField: string           // field name in GeoJSON for abstract label
  nriCode: string                 // sptb_code value that means NRI (skip NRA calc)
  // Lowercased substrings used by the CRM to derive a deal's county from
  // its operator_name when no `county` column is set on the row. New
  // counties just push their operator names here; CRM picks them up
  // automatically.
  operatorPatterns: string[]
  // How the wells API joins wells to a tract/owner. Howard owners reference
  // the abstract directly; Gonzales owners carry an `rrc_lease_id` that
  // matches `gonzales_wells.rrc_lease_id`. Add a new strategy here when a
  // future county uses a different join key.
  wellsJoinStrategy: 'abstract' | 'rrc_lease_id'
}

export type CountyKey = keyof typeof COUNTIES

// Gonzales was archived 2026-07-17. All its Supabase tables
// (gonzales_mineral_ownership, gonzales_wells, gonzales_permits,
// tract_development_status rows), public geojson files, and load
// scripts remain in place; only the UI + cron references were
// removed to reduce compute and focus the product on West Texas.
// To reactivate, re-add the Gonzales block from git history at
// commit 9afe6ef^ and re-enable it in the cron workflows.

export const COUNTIES: Record<string, County> = {
  howard: {
    id: 'howard',
    name: 'Howard',
    state: 'TX',
    displayName: 'Howard County, TX',
    mapCenter: [-101.45, 32.30],
    mapZoom: 10,
    fips: '48227',
    fipsCode: '227',
    ownershipTable: 'howard_mineral_ownership',
    wellsTable: 'howard_wells',
    geoJsonPath: '/howard_parcels_enriched.geojson',
    mapGeoJsonPath: '/howard_parcels_map.geojson?v=pdp-2026-07-16b',
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    operatorPatterns: [
      'apache', 'diamondback', 'sm energy', 'ovintiv',
      'highpeak', 'scout energy', 'vital energy', 'birch operations',
      'surge operating',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'Apache Corporation', pct: 31 },
      { operator: 'Diamondback E&P', pct: 28 },
      { operator: 'SM Energy', pct: 18 },
      { operator: 'Other', pct: 23 },
    ],
  },
  martin: {
    id: 'martin',
    name: 'Martin',
    state: 'TX',
    displayName: 'Martin County, TX',
    // Stanton (county seat) sits near 32.13°N, 101.79°W; the county centroid
    // is a touch north and west of that.
    mapCenter: [-101.95, 32.30],
    mapZoom: 10,
    fips: '48317',
    fipsCode: '317',
    ownershipTable: 'martin_mineral_ownership',
    wellsTable: 'martin_wells',
    geoJsonPath: '/martin_parcels_enriched.geojson',
    mapGeoJsonPath: '/martin_parcels_map.geojson?v=pdp-2026-07-16b',
    // Mirrors Howard: CAD ownership rolls express interest as a 0–1 decimal
    // that gets multiplied by 100 for display.
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    // Top operators by row count from the 2025 ownership roll. Diamondback
    // and Pioneer/ExxonMobil dominate; Birch and Ovintiv each hold a few %;
    // the long tail (Endeavor, Apache, COG, Permian Resources, Concho/Conoco)
    // shows up on enough leases to be worth fuzzy-matching for CRM
    // auto-county detection.
    operatorPatterns: [
      'diamondback', 'pioneer', 'exxon', 'xto',
      'birch', 'ovintiv', 'cog operating', 'endeavor',
      'permian resources', 'apache', 'concho', 'conoco',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'Diamondback E&P', pct: 35 },
      { operator: 'Pioneer / ExxonMobil', pct: 29 },
      { operator: 'Ovintiv + Birch', pct: 15 },
      { operator: 'Other', pct: 21 },
    ],
  },
  midland: {
    id: 'midland',
    name: 'Midland',
    state: 'TX',
    displayName: 'Midland County, TX',
    // Midland County centroid (city of Midland sits in the SE).
    mapCenter: [-102.03, 31.95],
    mapZoom: 10,
    fips: '48329',
    fipsCode: '329',
    ownershipTable: 'midland_mineral_ownership',
    wellsTable: 'midland_wells',
    geoJsonPath: '/midland_parcels_enriched.geojson',
    mapGeoJsonPath: '/midland_parcels_map.geojson?v=2026roll-2',
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    operatorPatterns: [
      'diamondback', 'pioneer', 'exxon', 'xto', 'apache', 'cog operating',
      'endeavor', 'permian resources', 'oxy', 'occidental', 'fasken',
      'henry', 'sm energy', 'birch', 'ovintiv',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'Diamondback E&P', pct: 32 },
      { operator: 'Pioneer / ExxonMobil', pct: 27 },
      { operator: 'Fasken / Henry', pct: 14 },
      { operator: 'Other', pct: 27 },
    ],
  },
  loving: {
    id: 'loving',
    name: 'Loving',
    state: 'TX',
    displayName: 'Loving County, TX',
    mapCenter: [-103.58, 31.85],
    mapZoom: 10,
    fips: '48301',
    fipsCode: '301',
    ownershipTable: 'loving_mineral_ownership',
    wellsTable: 'loving_wells',
    geoJsonPath: '/loving_parcels_enriched.geojson',
    mapGeoJsonPath: '/loving_parcels_map.geojson?v=2026roll-2',
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    operatorPatterns: [
      'exxon', 'xto', 'ovintiv', 'eog', 'chevron', 'occidental', 'oxy',
      'permian resources', 'apache', 'diamondback', 'coterra',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'ExxonMobil / XTO', pct: 30 },
      { operator: 'Ovintiv', pct: 20 },
      { operator: 'EOG Resources', pct: 15 },
      { operator: 'Other', pct: 35 },
    ],
  },
  reagan: {
    id: 'reagan',
    name: 'Reagan',
    state: 'TX',
    displayName: 'Reagan County, TX',
    mapCenter: [-101.52, 31.37],
    mapZoom: 10,
    fips: '48383',
    fipsCode: '383',
    ownershipTable: 'reagan_mineral_ownership',
    wellsTable: 'reagan_wells',
    geoJsonPath: '/reagan_parcels_enriched.geojson',
    mapGeoJsonPath: '/reagan_parcels_map.geojson?v=2026roll-2',
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    operatorPatterns: [
      'pioneer', 'exxon', 'xto', 'apache', 'sm energy', 'diamondback',
      'permian resources', 'endeavor', 'parsley', 'university lands',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'Pioneer / ExxonMobil', pct: 34 },
      { operator: 'Apache', pct: 18 },
      { operator: 'SM Energy', pct: 12 },
      { operator: 'Other', pct: 36 },
    ],
  },
  upton: {
    id: 'upton',
    name: 'Upton',
    state: 'TX',
    displayName: 'Upton County, TX',
    mapCenter: [-102.05, 31.37],
    mapZoom: 10,
    fips: '48461',
    fipsCode: '461',
    ownershipTable: 'upton_mineral_ownership',
    wellsTable: 'upton_wells',
    geoJsonPath: '/upton_parcels_enriched.geojson',
    mapGeoJsonPath: '/upton_parcels_map.geojson?v=2026roll-2',
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    operatorPatterns: [
      'pioneer', 'exxon', 'xto', 'apache', 'diamondback', 'endeavor',
      'permian resources', 'sm energy', 'parsley', 'oxy', 'occidental',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'Pioneer / ExxonMobil', pct: 33 },
      { operator: 'Diamondback E&P', pct: 20 },
      { operator: 'Apache', pct: 13 },
      { operator: 'Other', pct: 34 },
    ],
  },
  ward: {
    id: 'ward',
    name: 'Ward',
    state: 'TX',
    displayName: 'Ward County, TX',
    mapCenter: [-103.10, 31.51],
    mapZoom: 10,
    fips: '48475',
    fipsCode: '475',
    ownershipTable: 'ward_mineral_ownership',
    wellsTable: 'ward_wells',
    geoJsonPath: '/ward_parcels_enriched.geojson',
    mapGeoJsonPath: '/ward_parcels_map.geojson?v=2026roll-2',
    ownershipPctIsDecimal: true,
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    operatorPatterns: [
      'exxon', 'xto', 'apache', 'oxy', 'occidental', 'permian resources',
      'chevron', 'diamondback', 'coterra', 'mewbourne',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'ExxonMobil / XTO', pct: 28 },
      { operator: 'Apache', pct: 17 },
      { operator: 'Oxy', pct: 14 },
      { operator: 'Other', pct: 41 },
    ],
  },
  winkler: {
    id: 'winkler',
    name: 'Winkler',
    state: 'TX',
    displayName: 'Winkler County, TX',
    // Winkler County centroid; Kermit (county seat) sits near 31.86°N,
    // 103.09°W and the county spans roughly -103.33° to -102.80° lon and
    // 31.65° to 32.09° lat (from the 2026 tract layer bounds).
    mapCenter: [-103.05, 31.86],
    mapZoom: 10,
    fips: '48495',
    fipsCode: '495',
    ownershipTable: 'winkler_mineral_ownership',
    wellsTable: 'winkler_wells',
    geoJsonPath: '/winkler_parcels_enriched.geojson',
    mapGeoJsonPath: '/winkler_parcels_map.geojson?v=2026roll-1',
    // Mirrors the other Permian counties: CAD interest is a 0–1 decimal
    // multiplied by 100 for display.
    ownershipPctIsDecimal: true,
    // Winkler tracts are a Public School Land (PSL) block/section grid, so the
    // renderer keys labels off LEVEL2_BLO/LEVEL3_SUR ("PSL BLK 26 SEC 39")
    // rather than a numeric abstract. ABSTRACT_L is still the per-tract join
    // key.
    abstractField: 'ABSTRACT_L',
    nriCode: '',
    // Top operators by owner-row count from the 2026 ownership roll.
    operatorPatterns: [
      'wpx', 'basin oil', 'permian resources', 'formentera', 'oxy',
      'occidental', 'matador', 'apache', 'cog operating', 'stout energy',
      'hilcorp', 'continental', 'mewbourne', 'blackbeard', 'ldf energy',
    ],
    wellsJoinStrategy: 'abstract',
    breakdown: [
      { operator: 'WPX / Devon Energy', pct: 22 },
      { operator: 'Basin Oil & Gas', pct: 18 },
      { operator: 'Permian Resources / Oxy', pct: 12 },
      { operator: 'Other', pct: 48 },
    ],
  },
}
