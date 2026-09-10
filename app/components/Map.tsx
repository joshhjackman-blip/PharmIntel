'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { supabase } from '@/lib/supabase'
import { COUNTIES } from '@/lib/counties'
import type { County, CountyKey } from '@/lib/counties'
import TractSearch from './TractSearch'
import OperatorMultiSelect from './OperatorMultiSelect'
import type { OperatorOption } from '@/lib/operator-filter'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const MAP_STYLE_LIGHT = 'mapbox://styles/mapbox/streets-v12'
const MAP_STYLE_DARK = 'mapbox://styles/mapbox/dark-v11'

// Smooth, enterprise-grade camera easing. `easeInOutCubic` ramps the
// animation gently in and out so county/tract navigation glides to a stop
// instead of the abrupt, swooping zoom-out-then-in feel of Mapbox's default
// `flyTo` curve. Every programmatic camera move (county switch, tract fit,
// overview reset) uses `easeTo` with this curve for a consistent, premium
// feel — `easeTo` interpolates center+zoom directly, with no fly-away swoop.
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// Camera-move durations, tuned for crisp-but-smooth motion (ms).
const CAMERA_TRACT_MS = 600
const CAMERA_OVERVIEW_MS = 750

// Shared options so every camera move animates identically (and still runs
// for users with reduced-motion, since the move carries spatial context).
const easedMove = (
  duration: number,
): { duration: number; easing: (t: number) => number; essential: true } => ({
  duration,
  easing: easeInOutCubic,
  essential: true,
})

// Well-overlay coloring. Status mode = producing/shut-in/injection/permitted/
// drilled-horizontal/vertical; operator mode = a fixed palette keyed on the
// per-county operator rank (`op_idx`) stamped by build_wells_geojson.py.
// Well status palette — chosen to stay distinct from each other.
const WELL_KIND_COLORS: Record<string, string> = {
  producing: '#16A34A', // green
  duc: '#A855F7',       // purple
  shut_in: '#F59E0B',   // amber
  injection: '#0D9488', // teal
  permitted: '#2563EB', // blue
  // A drilled lateral with no completion IS a DUC — the legacy "horizontal"
  // (drilled, status unknown) bucket now reads as DUC (data is being
  // reclassified upstream; this keeps older geojson correct too).
  horizontal: '#A855F7', // purple — DUC
  vertical: '#9CA3AF',  // light gray
}
const WELL_KIND_LABEL: Record<string, string> = {
  producing: 'Producing (PDP)',
  duc: 'DUC',
  shut_in: 'Shut-in',
  injection: 'Injection / disposal',
  permitted: 'Permitted',
  horizontal: 'DUC',
  vertical: 'Vertical well',
}
const WELL_STATUS_COLOR = [
  'match', ['get', 'kind'],
  'producing', WELL_KIND_COLORS.producing,
  'duc', WELL_KIND_COLORS.duc,
  'shut_in', WELL_KIND_COLORS.shut_in,
  'injection', WELL_KIND_COLORS.injection,
  'permitted', WELL_KIND_COLORS.permitted,
  // Legacy 'horizontal' features still in older geojson render as DUC.
  'horizontal', WELL_KIND_COLORS.duc,
  'vertical', WELL_KIND_COLORS.vertical,
  WELL_KIND_COLORS.vertical,
] as unknown as mapboxgl.Expression
const WELL_OPERATOR_PALETTE = [
  '#2563EB', '#DC2626', '#16A34A', '#D97706', '#7C3AED', '#0891B2',
  '#DB2777', '#65A30D', '#EA580C', '#0EA5E9', '#9333EA', '#059669',
]
function wellColorExpr(byOperator: boolean): mapboxgl.Expression {
  if (!byOperator) return WELL_STATUS_COLOR
  const m: unknown[] = ['match', ['get', 'op_idx']]
  WELL_OPERATOR_PALETTE.forEach((c, i) => { m.push(i, c) })
  m.push('#9CA3AF') // long-tail / unknown operator
  return m as unknown as mapboxgl.Expression
}

// County navigation uses a flyTo *swoop* — an arc that lifts, travels, and
// settles — so switching counties always reads as a purposeful jump, even
// between adjacent counties.
//
// Smoothness notes (why no custom `easing` and a moderate `curve`):
//   * flyTo internally couples its zoom-out curve to a flight-tuned easing.
//     Overriding `easing` desynced the zoom from the pan and made the motion
//     stutter, so we let flyTo use its native easing.
//   * A high `curve` (1.7) zoomed so far out that a wide band of new tiles had
//     to render mid-flight, which dropped frames. 1.35 keeps a clear arc while
//     staying close enough that the GPU isn't slammed.
const CAMERA_SWOOP_MS = 1000
const swoopMove = (): {
  duration: number
  curve: number
  essential: true
} => ({
  duration: CAMERA_SWOOP_MS,
  curve: 1.35,
  essential: true,
})

// Flatten a GeoJSON polygon/multipolygon geometry into a flat array of [lng, lat]
// coordinate pairs so we can compute a rough bbox-based centroid without adding
// @turf as a dependency.
// Bare-abstract normalizer used by every parcel-lookup site in this
// file: strips a leading "A-" so a shapefile-labeled 'A-160' matches
// a compute-script-keyed '160' in tract_development_status.
const bareAbstract = (raw: unknown): string =>
  String(raw ?? '').replace(/^A-\s*/i, '').trim()

// Unified lifecycle statuses used to color the tract fills. Every tract
// on the map falls into exactly ONE of these buckets — the old split
// between "Activity" (production_status) and "Development" (dev_status)
// caused the same concept to render in two different colors (PDP was
// yellow on one view and green on the other), which was confusing, so
// they've been merged. All coloring, toggles, and legend rows work off
// map_status now.
type UnifiedStatus =
  | 'PDP'
  | 'PUD_DUC'
  | 'TRUE_PUD'
  | 'PUD_PERMITTED'
  | 'PUD_INFILL'
  | 'LEASING_ACTIVE'
  | 'FRONTIER'

// Map a production_status string (older schema, always populated on the
// baked geojson) into the unified dev-status space. Used as a fallback
// when tract_development_status hasn't been computed for a county yet
// (e.g. Martin only has production_status right now, not dev status).
function productionStatusToUnified(production: string): UnifiedStatus {
  const p = production.toLowerCase()
  if (p === 'pdp') return 'PDP'
  if (p === 'pud' || p === 'new_permit' || p === 'pending_permit') return 'PUD_PERMITTED'
  return 'FRONTIER'
}

// Prefer a computed tract_development_status row when we have one.
// Only fall back to the geojson `production_status` when no compute
// row exists for this abstract (county not yet computed, or key
// mismatch). Previously FRONTIER rows were treated as "no signal"
// and overwritten by production_status — that made Martin's 17
// Frontier tracts paint as PDP yellow whenever the shapefile still
// carried a producing label, so Frontier looked "missing" on the map.
//
// TRUE_PUD collapses into FRONTIER (2026-07-22): one undeveloped
// bucket on the map. Legacy TRUE_PUD rows still in the DB paint as
// Frontier until the next compute pass rewrites them.
function deriveMapStatus(
  props: GeoJSON.GeoJsonProperties,
  entry: { development_status?: string } | undefined,
): UnifiedStatus {
  const devStatus = entry?.development_status
  if (devStatus) {
    if (devStatus === 'TRUE_PUD') return 'FRONTIER'
    return devStatus as UnifiedStatus
  }
  return productionStatusToUnified(String(props?.production_status ?? 'none'))
}

function injectDevStatusIntoFeatures(
  collection: GeoJSON.FeatureCollection,
  lookup: Record<string, {
    development_status?: string
    pud_score?: number
    signal_detail?: {
      permits?: Array<{
        approved_date?: string | null
        // filed_date exposed by compute_development_status.py as of
        // 2026-07-21 so we can distinguish submitted permits (blue
        // has_recent_permit === approved) from filed-but-not-yet-
        // approved ones (teal has_recent_permit_submitted).
        filed_date?: string | null
      }>
      ducs?: unknown[]
      adjacent_permit_count?: number
      infill_gaps?: number
    }
  }>,
): void {
  const hasLookup = lookup && Object.keys(lookup).length > 0

  // Recent-permit cutoff for the halo overlays: 90 days back.
  //   has_recent_permit           -> tract has a permit APPROVED
  //                                  in the last 90 days (blue halo)
  //   has_recent_permit_submitted -> tract has a permit FILED in the
  //                                  last 90 days but NOT yet
  //                                  approved (teal halo)
  //
  // Approved wins if both apply: the blue halo takes precedence
  // and the teal one is suppressed. Otherwise a tract with a
  // permit that got filed AND approved recently would show a
  // double halo (blue on top of teal) which looks noisy.
  const cutoff = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return d.toISOString().slice(0, 10)
  })()

  for (const feature of collection.features) {
    const props = feature.properties ?? {}
    const key = bareAbstract(props.ABSTRACT_L ?? props.ABSTRACT_N)
    const entry = hasLookup && key ? lookup[key] : undefined
    const mapStatus = deriveMapStatus(props, entry)
    const permits = entry?.signal_detail?.permits ?? []
    const hasRecentPermit = permits.some((p) => {
      const d = String(p?.approved_date ?? '').slice(0, 10)
      return d && d >= cutoff
    })
    // A permit counts as "submitted only" for the teal halo when
    // it has a filed_date within the window AND doesn't ALSO have
    // a recent approved_date. The second condition avoids
    // double-tagging a permit that landed in the last 90 days as
    // both submitted and approved.
    const hasRecentPermitSubmitted = !hasRecentPermit && permits.some((p) => {
      const filed = String(p?.filed_date ?? '').slice(0, 10)
      const approved = String(p?.approved_date ?? '').slice(0, 10)
      if (!filed || filed < cutoff) return false
      if (approved && approved >= cutoff) return false
      return true
    })
    feature.properties = {
      ...props,
      // Persist the remapped status so click handlers / drawers see
      // FRONTIER for legacy TRUE_PUD rows, matching map_status.
      development_status: mapStatus,
      pud_score: entry?.pud_score ?? 0,
      map_status: mapStatus,
      has_recent_permit: hasRecentPermit,
      has_recent_permit_submitted: hasRecentPermitSubmitted,
    }
  }
}

const flattenPolygonCoords = (geometry: GeoJSON.Geometry | null | undefined): number[][] => {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return (geometry.coordinates[0] ?? []) as number[][]
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as unknown as number[][][][]).flatMap(
      (poly) => (poly[0] ?? []) as number[][]
    )
  }
  return []
}

const featureBboxCenter = (
  feature: GeoJSON.Feature | undefined | null
): [number, number] | null => {
  if (!feature) return null
  const coords = flattenPolygonCoords(feature.geometry)
  if (coords.length === 0) return null
  const lngs: number[] = []
  const lats: number[] = []
  for (const c of coords) {
    const lng = Number(c[0])
    const lat = Number(c[1])
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      lngs.push(lng)
      lats.push(lat)
    }
  }
  if (lngs.length === 0) return null
  return [
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ]
}

const buildBlockLabelFeatureCollection = (
  featureCollection: GeoJSON.FeatureCollection
): GeoJSON.FeatureCollection => {
  // `Map` the identifier is the default-exported component in this file, so
  // we use a plain object keyed by block name instead of the built-in Map.
  const blockCentroids: Record<string, { lngSum: number; latSum: number; count: number }> = {}
  for (const feature of featureCollection.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>
    // Howard's Abstracts.shp exposes ``Block`` ("31 T2N"), Martin's exposes
    // ``LEVEL2_BLO`` ("35 T1N", "A", "HA"); accept either so the centroid
    // labels show up for all counties without per-county special casing.
    const blockRaw = props.Block ?? props.block ?? props.LEVEL2_BLO ?? props.level2_blo
    const blockValue = typeof blockRaw === 'string'
      ? blockRaw.trim()
      : blockRaw != null
        ? String(blockRaw).trim()
        : ''
    if (!blockValue) continue

    const center = featureBboxCenter(feature)
    if (!center) continue

    const entry = blockCentroids[blockValue] ?? { lngSum: 0, latSum: 0, count: 0 }
    entry.lngSum += center[0]
    entry.latSum += center[1]
    entry.count += 1
    blockCentroids[blockValue] = entry
  }

  const features: GeoJSON.Feature[] = []
  for (const block of Object.keys(blockCentroids)) {
    const { lngSum, latSum, count } = blockCentroids[block]
    if (count === 0) continue
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lngSum / count, latSum / count],
      },
      properties: { block },
    })
  }

  return { type: 'FeatureCollection', features }
}

export type OwnerRecord = {
  id?: number
  owner_name: string
  mailing_city?: string
  mailing_state?: string
  operator_name?: string
  propensity_score?: number
  motivated?: boolean
  out_of_state?: boolean
  acreage?: number | null
  prod_cumulative_sum_oil?: number | null
  rrc_lease_id?: string | null
  latitude?: number | null
  longitude?: number | null
  well_status?: string
  [key: string]: unknown
}

type TractLayerHandlers = {
  layerId: string
  mouseEnterHandler: () => void
  mouseLeaveHandler: () => void
}

type PermitLayerHandlers = {
  clickHandler?: (event: mapboxgl.MapLayerMouseEvent) => void
  mouseEnterHandler?: () => void
  mouseLeaveHandler?: () => void
}

type CountyOverviewHandlers = {
  moveHandler?: (event: mapboxgl.MapLayerMouseEvent) => void
  leaveHandler?: () => void
  clickHandler?: (event: mapboxgl.MapLayerMouseEvent) => void
  hoveredFips: string | null
}

export type DevelopmentStatusKey =
  | 'PDP'
  | 'PUD_DUC'
  | 'TRUE_PUD'
  | 'PUD_PERMITTED'
  | 'PUD_INFILL'
  | 'LEASING_ACTIVE'
  | 'FRONTIER'

export type DevStatusMapEntry = {
  development_status: DevelopmentStatusKey
  pud_score: number
}

export default function Map({
  onOwnerClick,
  focusTarget,
  selectedCounty,
  mapFlyToRef,
  mapLevel,
  onCountySelect,
  onCountySwitch,
  devStatusByAbstract,
  operatorMatchAbstracts = null,
  operatorOptions = [],
  selectedOperatorKeys = [],
  onOperatorKeysChange,
  operatorMatchTractCount = null,
  activityRefreshTick = 0,
}: {
  onOwnerClick: (owner: Record<string, unknown>) => void
  focusTarget?: Record<string, unknown> | null
  selectedCounty: CountyKey
  mapFlyToRef?: React.MutableRefObject<((center: [number, number], zoom: number) => void) | null>
  mapLevel: 'county' | 'tract'
  onCountySelect?: (countyKey: CountyKey) => void
  onCountySwitch: (countyId: string) => void
  devStatusByAbstract?: Record<string, DevStatusMapEntry>
  /** When set, dim tracts not in this abstract list and ring matches in amber. */
  operatorMatchAbstracts?: string[] | null
  operatorOptions?: OperatorOption[]
  selectedOperatorKeys?: string[]
  onOperatorKeysChange?: (keys: string[]) => void
  operatorMatchTractCount?: number | null
  /**
   * Bumped by the parent on the same cadence as the Permits nav badge
   * (5 min + focus + new ingest date). Clears the session permits
   * cache and reloads rig dots so overnight scrapes show without a
   * hard refresh.
   */
  activityRefreshTick?: number
}) {
  // In-map layer toggles. Every tract on the map is classified into one
  // of the 6 UnifiedStatus buckets (see deriveMapStatus at the top of
  // this file). Each toggle controls whether that bucket is visible on
  // the fill — turning one off drops its fill-opacity + outline-width
  // to 0, effectively hiding those tracts. The Rigs toggle is separate:
  // it drives a red-dot overlay showing wells currently drilling,
  // which is a live signal that's meaningful regardless of the tract's
  // primary classification.
  const { resolvedTheme } = useTheme()
  const isDarkTheme = resolvedTheme === 'dark'
  const isDarkRef = useRef(isDarkTheme)
  const basemapStyleRef = useRef(
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? MAP_STYLE_DARK
      : MAP_STYLE_LIGHT,
  )

  useEffect(() => {
    isDarkRef.current = isDarkTheme
  }, [isDarkTheme])

  const [statusVisible, setStatusVisible] = useState<Record<UnifiedStatus, boolean>>({
    PDP: true,
    PUD_DUC: true,
    // TRUE_PUD collapsed into FRONTIER (2026-07-22). Kept on the
    // Record for type completeness; not shown in the legend.
    TRUE_PUD: true,
    // PUD_PERMITTED and LEASING_ACTIVE are still valid dev-status
    // classifications the compute pipeline may emit, but they've been
    // dropped from the visible legend:
    //   - PUD_PERMITTED never fires in mature Permian data because
    //     the classifier promotes producing tracts with fresh permits
    //     to PUD_INFILL. Permits are now surfaced as blue/teal GLOW
    //     overlays — see `showPermitGlow` / `showSubmittedGlow`.
    //   - LEASING_ACTIVE has zero tracts and doesn't add signal for
    //     the current buyer workflow.
    // Both statuses paint as True PUD emerald when they somehow appear.
    PUD_PERMITTED: true,
    PUD_INFILL: true,
    LEASING_ACTIVE: true,
    FRONTIER: true,
  })
  const setStatus = useCallback((key: UnifiedStatus, v: boolean) => {
    setStatusVisible((prev) => ({ ...prev, [key]: v }))
  }, [])
  // Blue glow overlay showing tracts with a permit approved in the
  // last 90 days. Renders on top of the tract's primary color
  // rather than replacing it, so a PDP tract with a fresh permit
  // stays yellow underneath but pulses blue on its edge.
  const [showPermitGlow, setShowPermitGlow] = useState(true)
  // Independent toggle for the teal submitted-permit halo (2026-07-21).
  // Kept separate from showPermitGlow so a broker who only wants to see
  // APPROVED permits (blue) can hide the teal noise, and vice versa.
  const [showSubmittedGlow, setShowSubmittedGlow] = useState(true)
  const [showRigs, setShowRigs] = useState(true)
  // Well geometry overlay: horizontal laterals (lines) + vertical/permit
  // wells (small dots), colored by status. Served from the static
  // /<county>_wells.geojson built by scripts/build_wells_geojson.py.
  const [showWells, setShowWells] = useState(true)
  const showWellsRef = useRef(showWells)
  useEffect(() => { showWellsRef.current = showWells }, [showWells])
  // Color the well overlay by operator (per-county palette) instead of status.
  // Tract fills default to a soft backdrop so the well/lateral overlay reads
  // clearly on top; flip to bold for a pure development-status overview.
  const [boldTracts, setBoldTracts] = useState(false)
  // "Wells only" hides the tract fill entirely (grid outline + wells remain,
  // and tracts stay clickable since the fill layer is only made transparent).
  const [wellsOnly, setWellsOnly] = useState(false)
  const [wellsByOperator, setWellsByOperator] = useState(false)
  const wellsByOperatorRef = useRef(wellsByOperator)
  useEffect(() => {
    wellsByOperatorRef.current = wellsByOperator
    const mapInstance = map.current
    if (!mapInstance?.isStyleLoaded()) return
    const expr = wellColorExpr(wellsByOperator)
    if (mapInstance.getLayer('wells-laterals-layer')) {
      mapInstance.setPaintProperty('wells-laterals-layer', 'line-color', expr)
    }
    if (mapInstance.getLayer('wells-points-layer')) {
      mapInstance.setPaintProperty('wells-points-layer', 'circle-color', expr)
    }
    if (mapInstance.getLayer('wells-arrows-layer')) {
      mapInstance.setPaintProperty('wells-arrows-layer', 'text-color', expr)
    }
  }, [wellsByOperator])
  const wellsCacheRef = useRef<Partial<Record<CountyKey, GeoJSON.FeatureCollection>>>({})
  const wellsHandlersRef = useRef<{
    clickHandler?: (e: mapboxgl.MapLayerMouseEvent) => void
    mouseEnterHandler?: () => void
    mouseLeaveHandler?: () => void
  }>({})
  // Refs so applyTractCountyStyles (which force-sets parcel layer
  // visibility on status toggles) can honor the current halo toggles
  // instead of always flipping blue/teal back to visible.
  const showPermitGlowRef = useRef(showPermitGlow)
  const showSubmittedGlowRef = useRef(showSubmittedGlow)
  useEffect(() => {
    showPermitGlowRef.current = showPermitGlow
  }, [showPermitGlow])
  useEffect(() => {
    showSubmittedGlowRef.current = showSubmittedGlow
  }, [showSubmittedGlow])
  // Bumped whenever county parcel FeatureCollections finish loading so
  // the focusTarget zoom effect can retry after async geojson fetch.
  const [parcelsVersion, setParcelsVersion] = useState(0)
  // Latest devStatusByAbstract in a ref so the setupTractLevel closure
  // (memoized on countyEntries only) still sees fresh data.
  const devStatusByAbstractRef = useRef(devStatusByAbstract ?? {})
  useEffect(() => {
    devStatusByAbstractRef.current = devStatusByAbstract ?? {}
  }, [devStatusByAbstract])
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const onOwnerClickRef = useRef(onOwnerClick)
  const onCountySwitchRef = useRef(onCountySwitch)
  const onCountySelectRef = useRef(onCountySelect)
  const selectedCountyRef = useRef<CountyKey>(selectedCounty)
  const lastClickTimeRef = useRef(0)
  const renderForCurrentLevelRef = useRef<() => Promise<void>>(async () => {})
  const renderTokenRef = useRef(0)
  const currentParcelsByCountyRef = useRef<Partial<Record<CountyKey, GeoJSON.FeatureCollection>>>({})
  const countyMarkersRef = useRef<mapboxgl.Marker[]>([])
  const tractHandlersRef = useRef<TractLayerHandlers[]>([])
  const tractClickHandlerRef = useRef<((event: mapboxgl.MapMouseEvent) => void) | null>(null)
  const permitHandlersRef = useRef<PermitLayerHandlers>({})
  const countyOverviewHandlersRef = useRef<CountyOverviewHandlers>({ hoveredFips: null })
  const activeCountyByFipsRef = useRef<Record<string, CountyKey>>({})
  // The exact click handler currently bound to the inactive-county blocks in
  // tract mode. Kept in a ref so we can off() the *same* function reference on
  // the next style pass — otherwise a fresh closure would be added each time
  // and old handlers would pile up, firing the county switch multiple times.
  const inactiveClickHandlerRef = useRef<((event: mapboxgl.MapLayerMouseEvent) => void) | null>(null)
  // The county that was last visually styled as "active" by
  // applyTractCountyStyles. Used to short-circuit the all-counties pass on
  // every click so we only repaint the two counties whose styling actually
  // flipped (old active → muted, new active → bright).
  const lastStyledSelectedCountyRef = useRef<CountyKey | null>(null)
  // Cache permit GeoJSON by county id so flipping between counties doesn't
  // re-issue a Supabase round-trip every time. Cleared on
  // activityRefreshTick so overnight scrapes / spud updates land
  // without a hard reload (same cadence as the Permits nav badge).
  const permitsCacheRef = useRef<Partial<Record<CountyKey, GeoJSON.FeatureCollection>>>({})
  // Cache the Texas-counties FIPS GeoJSON (fetched from plotly's public
  // dataset) once per session. Reused by both the county-overview
  // renderer and the tract-mode inactive-county overlay.
  const txCountiesCacheRef = useRef<GeoJSON.Feature[] | null>(null)

  // Permian-focused initial view. The 12 active counties span roughly
  // -103.5° to -101.0° lon and 30.7° to 32.5° lat; centering at
  // (-102.3, 31.7) puts Martin/Howard near the top and Loving/Reeves
  // near the bottom-left with the whole basin visible at zoom 7.
  // Renamed from TEXAS_OVERVIEW_* to reflect the archive of Gonzales
  // (2026-07-17). Old constant name kept as an alias so external
  // callers that referenced it don't need to change.
  const PERMIAN_OVERVIEW_CENTER: [number, number] = [-102.3, 31.7]
  const PERMIAN_OVERVIEW_ZOOM = 7.0
  const TEXAS_OVERVIEW_CENTER = PERMIAN_OVERVIEW_CENTER
  const TEXAS_OVERVIEW_ZOOM = PERMIAN_OVERVIEW_ZOOM

  // Permian counties whose data hasn't shipped yet. Painted as grey
  // "COMING SOON" squares in the county overview so the finished
  // basin footprint is visible from day one. FIPS codes match the
  // ones in scripts/scrape_rrc_permits_realtime.py; mapCenter
  // coordinates are the county centroids (used for the "COMING
  // SOON" label anchor).
  const UPCOMING_COUNTIES: Array<{ name: string; fips: string; mapCenter: [number, number] }> = [
    { name: 'GLASSCOCK', fips: '48173', mapCenter: [-101.52, 31.87] },
    { name: 'CRANE',     fips: '48103', mapCenter: [-102.55, 31.40] },
    { name: 'PECOS',     fips: '48371', mapCenter: [-102.72, 30.87] },
    { name: 'REEVES',    fips: '48389', mapCenter: [-103.68, 31.30] },
  ]

  const countyEntries = useMemo(
    () => Object.entries(COUNTIES) as Array<[CountyKey, County]>,
    []
  )

  useEffect(() => {
    onOwnerClickRef.current = onOwnerClick
  }, [onOwnerClick])

  useEffect(() => {
    onCountySwitchRef.current = onCountySwitch
  }, [onCountySwitch])

  useEffect(() => {
    onCountySelectRef.current = onCountySelect
  }, [onCountySelect])

  useEffect(() => {
    selectedCountyRef.current = selectedCounty
  }, [selectedCounty])

  const removeLayerIfExists = (mapInstance: mapboxgl.Map, layerId: string) => {
    if (mapInstance.getLayer(layerId)) mapInstance.removeLayer(layerId)
  }

  const removeSourceIfExists = (mapInstance: mapboxgl.Map, sourceId: string) => {
    if (mapInstance.getSource(sourceId)) mapInstance.removeSource(sourceId)
  }

  const clearCountyMarkers = useCallback(() => {
    countyMarkersRef.current.forEach((marker) => marker.remove())
    countyMarkersRef.current = []
  }, [])

  const fitGeometry = (
    mapInstance: mapboxgl.Map,
    geometry: GeoJSON.Geometry,
    options?: { padding?: number; duration?: number; maxZoom?: number; focusPoint?: [number, number] }
  ) => {
    const bounds = new mapboxgl.LngLatBounds()
    const addCoords = (coords: number[][]) => {
      coords.forEach((coord) => bounds.extend([coord[0], coord[1]] as [number, number]))
    }

    if (geometry.type === 'Polygon') {
      addCoords(geometry.coordinates[0] as number[][])
    } else if (geometry.type === 'MultiPolygon') {
      // Many tracts are dissolved into one MultiPolygon whose parts can sit
      // miles apart (same abstract/block-section label on non-contiguous
      // parcels). Fitting bounds over ALL parts zooms the camera way out to
      // the scattered extent. Instead focus a single coherent part: the one
      // under the click point when provided, otherwise the largest part.
      const polys = geometry.coordinates as number[][][][]
      const outerOf = (poly: number[][][]) => (poly[0] ?? []) as number[][]
      const ringContains = (ring: number[][], pt: [number, number]) => {
        let inside = false
        const [x, y] = pt
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0], yi = ring[i][1]
          const xj = ring[j][0], yj = ring[j][1]
          if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
        }
        return inside
      }
      const ringArea = (ring: number[][]) => {
        let a = 0
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
        }
        return Math.abs(a / 2)
      }
      let chosen: number[][] | null = null
      if (options?.focusPoint) {
        const hit = polys.find((p) => ringContains(outerOf(p), options.focusPoint as [number, number]))
        if (hit) chosen = outerOf(hit)
      }
      if (!chosen && polys.length > 0) {
        chosen = outerOf(
          polys.reduce((best, p) => (ringArea(outerOf(p)) > ringArea(outerOf(best)) ? p : best), polys[0]),
        )
      }
      if (chosen) addCoords(chosen)
    }

    if (!bounds.isEmpty()) {
      mapInstance.fitBounds(bounds, {
        padding: options?.padding ?? 120,
        maxZoom: options?.maxZoom ?? 14,
        ...easedMove(options?.duration ?? CAMERA_TRACT_MS),
      })
    }
  }

  const clearCountyOverviewLayers = useCallback((mapInstance: mapboxgl.Map) => {
    const handlers = countyOverviewHandlersRef.current
    if (handlers.moveHandler) mapInstance.off('mousemove', 'tx-counties-active-fill', handlers.moveHandler)
    if (handlers.leaveHandler) mapInstance.off('mouseleave', 'tx-counties-active-fill', handlers.leaveHandler)
    if (handlers.clickHandler) mapInstance.off('click', 'tx-counties-active-fill', handlers.clickHandler)
    countyOverviewHandlersRef.current = { hoveredFips: null }
    activeCountyByFipsRef.current = {}

    removeLayerIfExists(mapInstance, 'tx-counties-upcoming-sub-labels')
    removeLayerIfExists(mapInstance, 'tx-counties-active-labels')
    removeLayerIfExists(mapInstance, 'tx-counties-upcoming-outline')
    removeLayerIfExists(mapInstance, 'tx-counties-upcoming-fill')
    removeLayerIfExists(mapInstance, 'tx-counties-active-outline')
    removeLayerIfExists(mapInstance, 'tx-counties-active-fill')
    removeLayerIfExists(mapInstance, 'tx-counties-outline')
    removeLayerIfExists(mapInstance, 'tx-counties-fill')
    removeSourceIfExists(mapInstance, 'tx-counties-labels')
    removeSourceIfExists(mapInstance, 'tx-counties')
  }, [])

  const clearTractLayers = useCallback((mapInstance: mapboxgl.Map) => {
    tractHandlersRef.current.forEach((handlers) => {
      mapInstance.off('mouseenter', handlers.layerId, handlers.mouseEnterHandler)
      mapInstance.off('mouseleave', handlers.layerId, handlers.mouseLeaveHandler)
    })
    tractHandlersRef.current = []
    if (tractClickHandlerRef.current) {
      map.current?.off('click', tractClickHandlerRef.current)
      tractClickHandlerRef.current = null
    }

    // Detach the click/hover listeners attached to any of the three
    // per-category permit sub-layers. permitHandlersRef only preserves the
    // last-attached bundle; the others get wiped when the map removes the
    // source below, which detaches all listeners on those layer ids.
    for (const layerId of ['permits-approved-layer', 'permits-pending-layer', 'permits-rigs-layer']) {
      if (permitHandlersRef.current.clickHandler) {
        mapInstance.off('click', layerId, permitHandlersRef.current.clickHandler)
      }
      if (permitHandlersRef.current.mouseEnterHandler) {
        mapInstance.off('mouseenter', layerId, permitHandlersRef.current.mouseEnterHandler)
      }
      if (permitHandlersRef.current.mouseLeaveHandler) {
        mapInstance.off('mouseleave', layerId, permitHandlersRef.current.mouseLeaveHandler)
      }
    }
    permitHandlersRef.current = {}
    // Layers are about to be removed — invalidate the cached "last styled"
    // marker so the next applyTractCountyStyles re-applies the full pass.
    lastStyledSelectedCountyRef.current = null

    removeLayerIfExists(mapInstance, 'permits-approved-layer')
    removeLayerIfExists(mapInstance, 'permits-pending-layer')
    removeLayerIfExists(mapInstance, 'permits-rigs-layer')
    removeSourceIfExists(mapInstance, 'permits')

    // Well-geometry overlay (laterals + vertical/permit dots).
    for (const layerId of ['wells-laterals-layer', 'wells-points-layer']) {
      const h = wellsHandlersRef.current
      if (h.clickHandler) mapInstance.off('click', layerId, h.clickHandler)
      if (h.mouseEnterHandler) mapInstance.off('mouseenter', layerId, h.mouseEnterHandler)
      if (h.mouseLeaveHandler) mapInstance.off('mouseleave', layerId, h.mouseLeaveHandler)
    }
    wellsHandlersRef.current = {}
    removeLayerIfExists(mapInstance, 'wells-arrows-layer')
    removeLayerIfExists(mapInstance, 'wells-laterals-layer')
    removeLayerIfExists(mapInstance, 'wells-points-layer')
    removeSourceIfExists(mapInstance, 'wells')

    // Removing the layer detaches every listener attached to that
    // layer id, so we don't need to explicitly `off()` the
    // tract-inactive-fill click / hover handlers registered in
    // setupTractLevel — they die with the layer.
    removeLayerIfExists(mapInstance, 'tract-overlay-sub-labels')
    removeLayerIfExists(mapInstance, 'tract-overlay-labels')
    removeLayerIfExists(mapInstance, 'tract-upcoming-outline')
    removeLayerIfExists(mapInstance, 'tract-upcoming-fill')
    removeLayerIfExists(mapInstance, 'tract-inactive-outline')
    removeLayerIfExists(mapInstance, 'tract-inactive-fill')
    removeSourceIfExists(mapInstance, 'tract-mode-overlay-labels')
    removeSourceIfExists(mapInstance, 'tract-mode-overlay')

    countyEntries.forEach(([, countyConfig]) => {
      removeLayerIfExists(mapInstance, `block-labels-${countyConfig.id}`)
      removeSourceIfExists(mapInstance, `block-labels-source-${countyConfig.id}`)
      // Ticket 1.3 multi-color overlay dots (one per secondary signal).
      removeLayerIfExists(mapInstance, `parcels-permit-dot-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-duc-dot-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-infill-dot-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-pending-dot-${countyConfig.id}`)
      // Old singular dot layer id from before the multi-color refactor.
      // Left in the cleanup list so a mid-deploy source swap can tear
      // it down without a `getLayer` guard.
      removeLayerIfExists(mapInstance, `parcels-permit-dots-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-permit-glow-outer-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-permit-glow-core-${countyConfig.id}`)
      // Submitted-permit teal halo (2026-07-21).
      removeLayerIfExists(mapInstance, `parcels-permit-submitted-outer-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-permit-submitted-core-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-sections-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-labels-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-outline-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-fill-${countyConfig.id}`)
      removeSourceIfExists(mapInstance, `parcels-${countyConfig.id}`)
    })
    currentParcelsByCountyRef.current = {}
  }, [countyEntries])

  // Parcels are colored by well-activity classification. `production_status`
  // is written per tract by scripts/add_production_status.py:
  //   pdp             — tract has ≥1 drilled + completed well (bottom-hole)
  //   pud             — tract has wells but none with a bottom-hole record
  //   new_permit      — no wells; approved permit in <county>_permits
  //   pending_permit  — no wells; pending permit
  //   none            — no wells and no permits
  //
  // Permit-only tracts do NOT get a colored fill anymore — instead a small
  // blue dot is placed at the parcel centroid by a separate symbol layer
  // (`parcels-permit-dots-{countyId}`) below. Users read PDP/PUD via fill
  // color and permits via the dot on top.
  // Unified lifecycle palette. Every tract paints via a match on
  // `map_status` (injected in deriveMapStatus). No more Activity vs
  // Development split — one status per tract, one color per status,
  // one legend row per status.
  const STATUS_FILL: Record<UnifiedStatus, string> = {
    PDP:            '#EAB308', // yellow — producing today
    PUD_DUC:        '#A855F7', // purple — drilled, awaiting completion
    // Undeveloped bucket (FRONTIER + legacy TRUE_PUD) paints emerald
    // and labels as "True PUD" on the legend (2026-07-22).
    TRUE_PUD:       '#10B981',
    // PUD_PERMITTED + LEASING_ACTIVE paint as the same emerald True PUD
    // fill — permits are the blue/teal glow overlays; leasing is unused.
    PUD_PERMITTED:  '#10B981',
    PUD_INFILL:     '#F97316', // orange — spacing-gap infill candidate
    LEASING_ACTIVE: '#10B981',
    FRONTIER:       '#10B981',
  }
  const STATUS_OUTLINE: Record<UnifiedStatus, string> = {
    PDP:            '#A16207',
    PUD_DUC:        '#6B21A8',
    TRUE_PUD:       '#047857',
    PUD_PERMITTED:  '#047857',
    PUD_INFILL:     '#C2410C',
    LEASING_ACTIVE: '#047857',
    FRONTIER:       '#047857',
  }
  const STATUS_LABEL: Record<UnifiedStatus, string> = {
    PDP:            'PDP',
    PUD_DUC:        'DUC',
    TRUE_PUD:       'True PUD',
    PUD_PERMITTED:  'PUD (Permitted)',
    PUD_INFILL:     'Infill',
    LEASING_ACTIVE: 'Leasing active',
    FRONTIER:       'True PUD',
  }
  // Baseline opacities per status (before per-status toggle is applied).
  const STATUS_OPACITY: Record<UnifiedStatus, number> = {
    PDP:            0.72,
    PUD_DUC:        0.82,
    TRUE_PUD:       0.78,
    PUD_PERMITTED:  0.78, // treated as True PUD
    PUD_INFILL:     0.75,
    LEASING_ACTIVE: 0.78, // treated as True PUD
    FRONTIER:       0.78,
  }
  const STATUS_OUTLINE_WIDTH: Record<UnifiedStatus, number> = {
    PDP:            1.6,
    PUD_DUC:        2.0,
    TRUE_PUD:       1.8,
    PUD_PERMITTED:  1.8,
    PUD_INFILL:     1.5,
    LEASING_ACTIVE: 1.8,
    FRONTIER:       1.8,
  }

  const selectedFillColorExpr = useMemo<mapboxgl.Expression>(
    () => [
      'match',
      ['coalesce', ['get', 'map_status'], 'FRONTIER'],
      'PDP',            STATUS_FILL.PDP,
      'PUD_DUC',        STATUS_FILL.PUD_DUC,
      'TRUE_PUD',       STATUS_FILL.TRUE_PUD,
      'PUD_PERMITTED',  STATUS_FILL.PUD_PERMITTED,
      'PUD_INFILL',     STATUS_FILL.PUD_INFILL,
      'LEASING_ACTIVE', STATUS_FILL.LEASING_ACTIVE,
      STATUS_FILL.FRONTIER,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Toggling a status off drops its fill-opacity to 0. That's cheaper
  // than a `filter` update (no source refresh needed) and keeps the
  // outline/label layers in sync via the same trick below.
  // When an operator filter is active, non-matching tracts dim so CAD
  // operator hits read clearly (amber ring layer is added separately).
  const selectedFillOpacityExpr = useMemo<mapboxgl.Expression>(
    () => {
      const byStatus: mapboxgl.Expression = [
        'match',
        ['coalesce', ['get', 'map_status'], 'FRONTIER'],
        'PDP',            statusVisible.PDP            ? STATUS_OPACITY.PDP            : 0,
        'PUD_DUC',        statusVisible.PUD_DUC        ? STATUS_OPACITY.PUD_DUC        : 0,
        'TRUE_PUD',       statusVisible.TRUE_PUD       ? STATUS_OPACITY.TRUE_PUD       : 0,
        'PUD_PERMITTED',  statusVisible.PUD_PERMITTED  ? STATUS_OPACITY.PUD_PERMITTED  : 0,
        'PUD_INFILL',     statusVisible.PUD_INFILL     ? STATUS_OPACITY.PUD_INFILL     : 0,
        'LEASING_ACTIVE', statusVisible.LEASING_ACTIVE ? STATUS_OPACITY.LEASING_ACTIVE : 0,
        statusVisible.FRONTIER ? STATUS_OPACITY.FRONTIER : 0,
      ]
      // PRODUCTION-INTENSITY CHANNEL: instead of a flat backdrop, scale the
      // fill by how developed the tract is (producing-well count). Heavily
      // drilled tracts read as a deeper "heat"; frontier tracts stay light
      // (but keep a floor so their status hue is still visible). This layers a
      // production-heat channel onto the status-hue channel without adding any
      // new marks. Bold mode = full strength; wells-only = transparent.
      const intensity: mapboxgl.Expression = [
        'interpolate', ['linear'], ['coalesce', ['to-number', ['get', 'pdp_well_count']], 0],
        0, 0.18, 2, 0.3, 6, 0.4, 15, 0.5, 30, 0.6,
      ]
      const scale: number | mapboxgl.Expression = wellsOnly ? 0 : boldTracts ? 1 : intensity
      const withScale = (expr: mapboxgl.Expression): mapboxgl.Expression =>
        scale === 1 ? expr : (['*', expr, scale] as mapboxgl.Expression)
      if (operatorMatchAbstracts == null) return withScale(byStatus)
      if (operatorMatchAbstracts.length === 0) {
        return withScale(['*', byStatus, 0.12] as mapboxgl.Expression)
      }
      // Cap literal size — Mapbox handles large `in` lists, but keep
      // the expression bounded for pathological counties.
      const literals = operatorMatchAbstracts.slice(0, 8000)
      return withScale([
        'case',
        ['in', ['get', 'ABSTRACT_L'], ['literal', literals]],
        byStatus,
        ['*', byStatus, 0.12],
      ] as mapboxgl.Expression)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusVisible, operatorMatchAbstracts, boldTracts, wellsOnly]
  )

  // OPERATOR CHANNEL: color the tract outline by its top operator (major
  // Permian operators get a distinct hue; everything else keeps the neutral
  // grid line). This encodes operator footprint on the border so the fill
  // stays free for status + production heat — all three read at once.
  const selectedOutlineColorExpr = useMemo<mapboxgl.Expression>(() => {
    const up: mapboxgl.Expression = ['upcase', ['coalesce', ['get', 'top_operator'], '']]
    const has = (s: string): mapboxgl.Expression => ['in', s, up] as mapboxgl.Expression
    return [
      'case',
      has('DIAMONDBACK'), '#2563EB',
      ['any', has('PIONEER'), has('EXXON'), has('XTO')], '#DC2626',
      has('PERMIAN RESOURCES'), '#7C3AED',
      has('OVINTIV'), '#0D9488',
      has('APACHE'), '#EA580C',
      has('SM ENERGY'), '#CA8A04',
      has('ENDEAVOR'), '#DB2777',
      ['any', has('COG'), has('CONCHO'), has('CONOCO')], '#4338CA',
      ['any', has('OCCIDENTAL'), has('OXY')], '#059669',
      has('BIRCH'), '#92400E',
      'rgba(0,0,0,0.38)',
    ] as mapboxgl.Expression
  }, [])

  // Outline width — thin neutral grid, a touch heavier where a known operator
  // colors the border so the operator hue actually reads. Zoom-scaled.
  const selectedOutlineWidthExpr = useMemo<mapboxgl.Expression>(
    () => {
      const hasOperator: mapboxgl.Expression = ['any',
        ['in', 'DIAMONDBACK', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'PIONEER', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'EXXON', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'XTO', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'PERMIAN RESOURCES', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'OVINTIV', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'APACHE', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'SM ENERGY', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'ENDEAVOR', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'COG', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'CONCHO', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'CONOCO', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'OCCIDENTAL', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'OXY', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
        ['in', 'BIRCH', ['upcase', ['coalesce', ['get', 'top_operator'], '']]],
      ]
      return [
        'interpolate', ['linear'], ['zoom'],
        8, ['case', hasOperator, 0.8, 0.35],
        12, ['case', hasOperator, 1.6, 0.7],
        15, ['case', hasOperator, 2.6, 1.1],
      ] as mapboxgl.Expression
    },
    []
  )

  const applyTractCountyStyles = useCallback(() => {
    const mapInstance = map.current
    if (!mapInstance) return

    const newSelected = selectedCountyRef.current
    const previouslySelected = lastStyledSelectedCountyRef.current

    // All per-county parcel-related layer ids. Inactive counties get
    // every one of these hidden so no parcel data (fills, outlines,
    // abstract labels, section labels, block labels, permit halos)
    // bleeds through into the tract view of a different county.
    // The tract-inactive-fill / tract-overlay-labels layers added
    // in setupTractLevel take over as the visible representation.
    const parcelLayerSuffixes = [
      'parcels-fill', 'parcels-outline', 'parcels-labels', 'parcels-sections',
      'parcels-permit-glow-outer', 'parcels-permit-glow-core',
      // Submitted-permit teal halo (2026-07-21). Hidden along with
      // the rest of the parcel machinery when a county is muted
      // by applyTractCountyStyles.
      'parcels-permit-submitted-outer', 'parcels-permit-submitted-core',
      'block-labels',
    ]

    const stylePair = (
      countyKey: CountyKey,
      mode: 'active' | 'muted'
    ): boolean => {
      const countyConfig = COUNTIES[countyKey]
      const fillId = `parcels-fill-${countyConfig.id}`
      const outlineId = `parcels-outline-${countyConfig.id}`
      if (!mapInstance.getLayer(fillId) || !mapInstance.getLayer(outlineId)) {
        return false
      }
      if (mode === 'active') {
        mapInstance.setPaintProperty(fillId, 'fill-color', selectedFillColorExpr)
        mapInstance.setPaintProperty(fillId, 'fill-opacity', selectedFillOpacityExpr)
        mapInstance.setPaintProperty(outlineId, 'line-color', selectedOutlineColorExpr)
        mapInstance.setPaintProperty(outlineId, 'line-width', selectedOutlineWidthExpr)
        mapInstance.setPaintProperty(outlineId, 'line-opacity', 0.92)
        for (const suffix of parcelLayerSuffixes) {
          const layerId = `${suffix}-${countyConfig.id}`
          if (!mapInstance.getLayer(layerId)) continue
          // Status toggles null lastStyledSelectedCountyRef and re-run
          // this first-pass path. Previously every suffix was forced
          // 'visible', which re-enabled blue/teal halos after the user
          // had turned them off. Honor the overlay toggles here.
          let visibility: 'visible' | 'none' = 'visible'
          if (
            suffix === 'parcels-permit-glow-outer' ||
            suffix === 'parcels-permit-glow-core'
          ) {
            visibility = showPermitGlowRef.current ? 'visible' : 'none'
          } else if (
            suffix === 'parcels-permit-submitted-outer' ||
            suffix === 'parcels-permit-submitted-core'
          ) {
            visibility = showSubmittedGlowRef.current ? 'visible' : 'none'
          }
          mapInstance.setLayoutProperty(layerId, 'visibility', visibility)
        }
      } else {
        for (const suffix of parcelLayerSuffixes) {
          const layerId = `${suffix}-${countyConfig.id}`
          if (mapInstance.getLayer(layerId)) {
            mapInstance.setLayoutProperty(layerId, 'visibility', 'none')
          }
        }
      }
      return true
    }

    if (previouslySelected === null) {
      // First pass after layers were just (re)created — set every county to
      // its correct mode in one go.
      countyEntries.forEach(([countyKey]) => {
        stylePair(countyKey, countyKey === newSelected ? 'active' : 'muted')
      })
    } else if (previouslySelected !== newSelected) {
      // Incremental update: only the two counties whose styling actually
      // changed need new paint properties. Skipping the others avoids
      // redundant style events on every click.
      stylePair(previouslySelected, 'muted')
      stylePair(newSelected, 'active')
    } else {
      // Same county — nothing to repaint.
      return
    }

    // Move the active county's symbol layers to the top of the stack. This
    // is intentionally only done when the active county actually changed
    // (the early return above prevents it on no-op calls); back-to-back
    // moveLayer calls force a worker collision-detection pass on every
    // symbol layer below them.
    const selectedConfig = COUNTIES[newSelected]
    const cid = selectedConfig.id
    // Full z-order, bottom -> top. moveLayer() with no beforeId pushes to the
    // very top, so calling in this order yields exactly this stack:
    //   tract fill -> permit halos -> laterals -> well dots ->
    //   tract OUTLINE (subtle-black grid, above the wells) -> labels -> rigs.
    // Putting the grid above the wells means it's always readable.
    const zOrderBottomToTop = [
      `parcels-fill-${cid}`,
      `parcels-permit-glow-outer-${cid}`,
      `parcels-permit-glow-core-${cid}`,
      `parcels-permit-submitted-outer-${cid}`,
      `parcels-permit-submitted-core-${cid}`,
      'wells-laterals-layer',
      'wells-points-layer',
      'wells-arrows-layer',
      `parcels-outline-${cid}`,
      `parcels-labels-${cid}`,
      `parcels-sections-${cid}`,
      `block-labels-${cid}`,
      'permits-rigs-layer',
    ]
    for (const id of zOrderBottomToTop) {
      if (mapInstance.getLayer(id)) mapInstance.moveLayer(id)
    }

    // Refresh the tract-mode inactive-county overlay so the newly
    // selected county drops out of the orange-block set and the
    // previously selected county picks it up. The overlay source
    // itself is rebuilt when the filter changes.
    const currentFips = selectedConfig.fips
    if (mapInstance.getSource('tract-mode-overlay')) {
      const texasFeatures = txCountiesCacheRef.current
      if (texasFeatures) {
        const upcomingFipsSet = new Set(UPCOMING_COUNTIES.map((c) => c.fips))
        const allActiveFipsSet = new Set(countyEntries.map(([, cfg]) => cfg.fips))
        const overlayFeatures = texasFeatures
          .filter((feat) => {
            const fips = String(((feat.properties ?? {}) as Record<string, unknown>).__fips ?? feat.id ?? '')
            return upcomingFipsSet.has(fips) || (allActiveFipsSet.has(fips) && fips !== currentFips)
          })
          .map((feat) => {
            const fips = String(((feat.properties ?? {}) as Record<string, unknown>).__fips ?? feat.id ?? '')
            return {
              ...feat,
              properties: {
                ...(feat.properties ?? {}),
                __fips: fips,
                __role: upcomingFipsSet.has(fips) ? 'upcoming' : 'inactive',
              },
            } as GeoJSON.Feature
          })
        const src = mapInstance.getSource('tract-mode-overlay') as mapboxgl.GeoJSONSource
        src.setData({ type: 'FeatureCollection', features: overlayFeatures })
      }
    }
    if (mapInstance.getLayer('tract-overlay-labels')) {
      mapInstance.setFilter('tract-overlay-labels', ['!=', ['get', 'fips'], currentFips])
    }
    // Push overlay layers below the rig dots but above the base
    // parcel layers, so labels and orange blocks stay visible.
    for (const overlayLayerId of [
      'tract-inactive-fill', 'tract-inactive-outline',
      'tract-upcoming-fill', 'tract-upcoming-outline',
      'tract-overlay-labels', 'tract-overlay-sub-labels',
    ]) {
      if (mapInstance.getLayer(overlayLayerId)) mapInstance.moveLayer(overlayLayerId)
    }
    if (mapInstance.getLayer('permits-rigs-layer')) {
      mapInstance.moveLayer('permits-rigs-layer')
    }

    lastStyledSelectedCountyRef.current = newSelected
  }, [countyEntries, selectedFillColorExpr, selectedFillOpacityExpr, selectedOutlineColorExpr, selectedOutlineWidthExpr])

  const loadSelectedCountyPermits = useCallback(async (opts?: { force?: boolean }) => {
    const mapInstance = map.current
    if (!mapInstance) return

    const countyKey = selectedCountyRef.current
    const countyConfig = COUNTIES[countyKey]
    const permitsTable = `${countyConfig.id}_permits`

    // Use cached GeoJSON if we already loaded permits for this county
    // once — unless the parent asked for a live refresh.
    if (opts?.force) {
      delete permitsCacheRef.current[countyKey]
    }
    let permitsGeoJSON = permitsCacheRef.current[countyKey] ?? null

    if (!permitsGeoJSON) {
      let permitRows: Array<Record<string, unknown>> = []
      // Try the full column set first (Ticket 1.3 schema with
      // spud_date/completion_date). Fall back to the pre-1.3 minimal
      // column set if the migration hasn't landed for this county.
      //
      // IMPORTANT: Supabase's JS client silently caps a single SELECT
      // at 1000 rows (PGRST_MAX_ROWS default). Howard has 1,188 rows
      // with valid lat/lon; a plain `.select()` returned only the
      // first 1000 — sorted implicitly by primary key ascending,
      // which put the OLDEST permits first and dropped the 188
      // newest, which is where 8 of the 10 active rigs live. The
      // map ended up drawing 2 red dots on Howard vs Baker Hughes'
      // published ~10. We now page in 1000-row chunks via .range()
      // and stop when a partial page arrives.
      const paginatedSelect = async (cols: string): Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }> => {
        const out: Array<Record<string, unknown>> = []
        let offset = 0
        while (true) {
          const res = await supabase
            .from(permitsTable)
            .select(cols)
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .range(offset, offset + 999)
          if (res.error) return { data: null, error: res.error }
          const chunk = (res.data ?? []) as unknown as Array<Record<string, unknown>>
          out.push(...chunk)
          if (chunk.length < 1000) break
          offset += 1000
          // Safety net: no county should ever have more than 20k
          // permit rows, but guard anyway so a bad table doesn't
          // spin forever.
          if (offset >= 20_000) break
        }
        return { data: out, error: null }
      }

      const permitsResult = await paginatedSelect(
        'permit_number,api_number,operator_name,lease_name,latitude,longitude,permit_type,status,filed_date,approved_date,spud_date,completion_date'
      )

      if (permitsResult.error) {
        const msg = (permitsResult.error as { message?: string })?.message ?? ''
        if (/column .* does not exist/i.test(msg)) {
          const fallback = await paginatedSelect(
            'permit_number,api_number,operator_name,lease_name,latitude,longitude,permit_type,status,filed_date,approved_date'
          )
          if (fallback.error) {
            const emsg = (fallback.error as { message?: string })?.message ?? ''
            console.warn(`[permits] ${permitsTable} unavailable:`, emsg)
          } else {
            permitRows = fallback.data ?? []
          }
        } else {
          // Table may not exist for this county (some Permian counties before
          // their migration lands). Fail soft: empty layers so nothing
          // misleading renders.
          console.warn(`[permits] ${permitsTable} unavailable:`, msg)
        }
      } else {
        permitRows = permitsResult.data ?? []
      }

      const permits = permitRows.filter((row) => {
        const lon = Number(row.longitude)
        const lat = Number(row.latitude)
        // Guard against junk values (e.g. RRC fixed-width parser artifacts where
        // lat/lon come through as multi-billion integers).
        return (
          Number.isFinite(lon) &&
          Number.isFinite(lat) &&
          lon >= -180 && lon <= 180 &&
          lat >= -90 && lat <= 90
        )
      })

      // Categorize each row into one of three activity layers.
      //
      // Prior versions of this function pattern-matched "DRILL" on
      // permit_type/status, which flagged every historical drilling
      // permit ever issued as a rig — Howard produced 560 "rig" dots
      // vs Baker Hughes' actual ~10-15 rig weekly count. Fixed by
      // switching to the industry-standard definition:
      //
      //   rig        = spud_date within the last RIG_LOOKBACK_DAYS AND
      //                no completion_date on file AND not a
      //                disposal/injection well
      //   pre_permit = pending / filed / held applications
      //   permit     = approved permit or unknown, everything else
      //
      // SWD/disposal/injection wells are excluded because Baker
      // Hughes reports oil & gas rigs only. A 365-day lookback is
      // wider than the ~30-day drilling cycle, but our data source
      // (RRC EWA snapshots) has 3-6 month lag on completions, so
      // narrower windows undercount. Once the real-time scraper
      // catches up we can tighten to 90 days.
      const RIG_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000
      const now = Date.now()

      const parseIsoDate = (s: unknown): number | null => {
        if (s === null || s === undefined) return null
        const str = String(s).trim()
        if (!str) return null
        const t = Date.parse(str.slice(0, 10))
        return Number.isFinite(t) ? t : null
      }

      const isDisposalWell = (row: Record<string, unknown>): boolean => {
        const lease = String(row.lease_name ?? '').toUpperCase()
        const type = String(row.permit_type ?? '').toUpperCase()
        return (
          /(^|\s)SWD(\s|$)/.test(lease) ||
          lease.includes('DISPOSAL') ||
          lease.includes('INJECTION') ||
          lease.includes('WATER GATHERING') ||
          type.includes('DISPOSAL') ||
          type.includes('INJECTION')
        )
      }

      const categorize = (row: Record<string, unknown>): 'permit' | 'pre_permit' | 'rig' => {
        const spud = parseIsoDate(row.spud_date)
        const completion = parseIsoDate(row.completion_date)
        if (
          spud !== null &&
          completion === null &&
          (now - spud) <= RIG_LOOKBACK_MS &&
          !isDisposalWell(row)
        ) {
          return 'rig'
        }
        const status = String(row.status ?? '').toUpperCase()
        if (status.includes('PEND') || status.includes('FILED') || status.includes('HELD')) {
          return 'pre_permit'
        }
        return 'permit'
      }

      permitsGeoJSON = {
        type: 'FeatureCollection',
        features: permits.map((permit) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [Number(permit.longitude), Number(permit.latitude)],
          },
          properties: {
            operator: String(permit.operator_name ?? ''),
            lease: String(permit.lease_name ?? ''),
            // Prefer spud_date for the rig popup (that's what "active"
            // means); fall back to filed/approved for the plain
            // permit popups.
            date: String(permit.spud_date ?? permit.filed_date ?? permit.approved_date ?? ''),
            type: String(permit.permit_type ?? ''),
            status: String(permit.status ?? ''),
            category: categorize(permit),
          },
        })),
      }
      permitsCacheRef.current[countyKey] = permitsGeoJSON

      // Bail out if the user switched away from this county while the
      // network round-trip was in flight.
      if (countyKey !== selectedCountyRef.current || !map.current) return
    }

    // Three sub-layers, each filtered on `category`. Adds up to a single
    // toggleable set of activity dots without duplicating the source.
    const PERMIT_LAYERS: Array<{
      id: string
      category: 'permit' | 'pre_permit' | 'rig'
      color: string
      strokeColor: string
      radius: number
      visible: boolean
      popupTitle: string
      popupColor: string
    }> = [
      // Only "currently drilling" survives as a per-point overlay.
      // Approved / pending permits are subsumed by the tract-level
      // PUD (Permitted) fill in the unified palette, so drawing an
      // individual blue dot for every permit on top of an already-
      // blue tract was double-encoding the same signal.
      {
        id: 'permits-rigs-layer',
        category: 'rig',
        color: '#DC2626',
        strokeColor: '#ffffff',
        radius: 7,
        visible: showRigs,
        popupTitle: 'Rig — Currently Drilling',
        popupColor: '#991b1b',
      },
    ]

    if (!mapInstance.getSource('permits')) {
      mapInstance.addSource('permits', { type: 'geojson', data: permitsGeoJSON })
      for (const layer of PERMIT_LAYERS) {
        mapInstance.addLayer({
          id: layer.id,
          type: 'circle',
          source: 'permits',
          filter: ['==', ['get', 'category'], layer.category],
          layout: { visibility: layer.visible ? 'visible' : 'none' },
          paint: {
            'circle-radius': layer.radius,
            'circle-color': layer.color,
            'circle-opacity': 0.85,
            'circle-stroke-width': 2.5,
            'circle-stroke-color': layer.strokeColor,
            'circle-stroke-opacity': 1,
          },
        })
      }

      // One popup + cursor handler per sub-layer. The popup color +
      // heading text swap depending on which layer was clicked so users
      // see "Rig", "Pre-Permit", or "Approved Permit" correctly.
      const handlerBundles: Array<{ layerId: string; handlers: PermitLayerHandlers }> = []
      for (const layer of PERMIT_LAYERS) {
        const clickHandler = (event: mapboxgl.MapLayerMouseEvent) => {
          const feature = event.features?.[0]
          const props = feature?.properties
          if (!props || !map.current) return
          new mapboxgl.Popup({ closeButton: false, offset: 10 })
            .setLngLat((feature.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(`<div style="font-family:Inter,sans-serif;font-size:12px;padding:6px">
              <div style="font-weight:600;color:${layer.popupColor}">${layer.popupTitle}</div>
              <div style="font-weight:500;margin-top:2px">${props.lease ?? ''}</div>
              <div style="color:#6b7280">${props.operator ?? ''}</div>
              <div style="color:#6b7280;font-size:11px">${props.date ? `Filed: ${props.date}` : ''}</div>
            </div>`)
            .addTo(map.current)
        }
        const mouseEnterHandler = () => {
          map.current?.getCanvas().style.setProperty('cursor', 'pointer')
        }
        const mouseLeaveHandler = () => {
          if (map.current) map.current.getCanvas().style.cursor = ''
        }
        mapInstance.on('click', layer.id, clickHandler)
        mapInstance.on('mouseenter', layer.id, mouseEnterHandler)
        mapInstance.on('mouseleave', layer.id, mouseLeaveHandler)
        handlerBundles.push({
          layerId: layer.id,
          handlers: { clickHandler, mouseEnterHandler, mouseLeaveHandler },
        })
      }
      // Preserve first bundle's handlers on the ref for backwards-compat
      // cleanup. All handlers get wiped when clearTractLayers removes
      // the source anyway; we only need this ref for the click/hover
      // detach path in clearTractLayers (see the loop that follows).
      permitHandlersRef.current = handlerBundles[0]?.handlers ?? {}
    } else {
      const source = mapInstance.getSource('permits') as mapboxgl.GeoJSONSource
      source.setData(permitsGeoJSON)
    }

    for (const layer of PERMIT_LAYERS) {
      if (mapInstance.getLayer(layer.id)) {
        mapInstance.setLayoutProperty(layer.id, 'visibility', layer.visible ? 'visible' : 'none')
        // Push to the top of the render stack so rig dots draw over
        // the tract fills / outlines / permit glow / labels. Without
        // this the rigs painted under whichever parcel layers were
        // added after them, which made red rig markers invisible on
        // colored tracts.
        mapInstance.moveLayer(layer.id)
      }
    }
  }, [showRigs])

  // Well-geometry overlay: horizontal laterals (lines) + vertical/permit wells
  // (small dots), colored by status. Served from the static
  // /<county>_wells.geojson (scripts/build_wells_geojson.py). Rig dots stay on
  // top of this overlay.
  const loadSelectedCountyWells = useCallback(async (opts?: { force?: boolean }) => {
    const mapInstance = map.current
    if (!mapInstance) return
    const countyKey = selectedCountyRef.current
    const cfg = COUNTIES[countyKey]
    if (!cfg) return
    if (opts?.force) delete wellsCacheRef.current[countyKey]
    let wellsGeoJSON = wellsCacheRef.current[countyKey] ?? null
    if (!wellsGeoJSON) {
      // Prefer the nightly-refreshed copy in Supabase Storage; fall back to the
      // committed /public baseline so the overlay still works if Storage misses.
      const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')
      const urls = [
        supaUrl ? `${supaUrl}/storage/v1/object/public/map-data/${cfg.id}_wells.geojson` : '',
        `/${cfg.id}_wells.geojson?v=1`,
      ].filter(Boolean)
      for (const url of urls) {
        try {
          const res = await fetch(url)
          if (!res.ok) continue
          wellsGeoJSON = (await res.json()) as GeoJSON.FeatureCollection
          break
        } catch {
          // try next source
        }
      }
      if (!wellsGeoJSON) return
      wellsCacheRef.current[countyKey] = wellsGeoJSON
      if (countyKey !== selectedCountyRef.current || !map.current) return
    }

    const colorExpr = wellColorExpr(wellsByOperatorRef.current)
    const vis: 'visible' | 'none' = showWellsRef.current ? 'visible' : 'none'

    if (!mapInstance.getSource('wells')) {
      mapInstance.addSource('wells', { type: 'geojson', data: wellsGeoJSON })
      mapInstance.addLayer({
        id: 'wells-laterals-layer',
        type: 'line',
        source: 'wells',
        filter: ['==', ['get', 'geom'], 'line'],
        layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': colorExpr,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 1.4, 15, 2.4],
          // Fade laterals in as you zoom so the county view stays clean and
          // detail reveals progressively.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.35, 11, 0.7, 13, 0.92],
        },
      })
      mapInstance.addLayer({
        id: 'wells-points-layer',
        type: 'circle',
        source: 'wells',
        filter: ['==', ['get', 'geom'], 'point'],
        layout: { visibility: vis },
        paint: {
          // Deliberately small dots (the old vertical markers were oversized).
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 12, 2.4, 15, 3.8],
          'circle-color': colorExpr,
          // Vertical/permit dots fade in with zoom too.
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.25, 12, 0.7, 14, 0.85],
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#ffffff',
        },
      })
      // Heel→toe direction arrows along each lateral. Only appear once zoomed
      // in (z>=12) so they never clutter the county overview.
      mapInstance.addLayer({
        id: 'wells-arrows-layer',
        type: 'symbol',
        source: 'wells',
        filter: ['==', ['get', 'geom'], 'line'],
        layout: {
          visibility: vis,
          'symbol-placement': 'line',
          'symbol-spacing': 90,
          'text-field': '▶',
          'text-keep-upright': false,
          'text-rotation-alignment': 'map',
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 8, 15, 12],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': colorExpr,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 12.5, 0.9],
        },
      })

      const kindLabel = WELL_KIND_LABEL
      const clickHandler = (event: mapboxgl.MapLayerMouseEvent) => {
        const feature = event.features?.[0]
        const props = feature?.properties
        if (!props || !map.current) return
        const geom = feature!.geometry as GeoJSON.Geometry
        let lngLat: [number, number]
        if (geom.type === 'Point') {
          lngLat = geom.coordinates as [number, number]
        } else if (geom.type === 'LineString') {
          const cs = geom.coordinates as number[][]
          lngLat = cs[Math.floor(cs.length / 2)] as [number, number]
        } else {
          lngLat = [event.lngLat.lng, event.lngLat.lat]
        }
        const kind = String(props.kind ?? '')
        const title = kindLabel[kind] ?? 'Well'
        new mapboxgl.Popup({ closeButton: false, offset: 8 })
          .setLngLat(lngLat)
          .setHTML(`<div style="font-family:Inter,sans-serif;font-size:12px;padding:6px">
            <div style="font-weight:600;color:#0f172a">${title}${props.well_type === 'HORIZONTAL' ? ' (lateral)' : ''}</div>
            <div style="color:#6b7280;margin-top:2px">${props.operator ?? ''}</div>
            <div style="color:#6b7280;font-size:11px">API ${props.api ?? ''}${props.status ? ` · ${props.status}` : ''}</div>
          </div>`)
          .addTo(map.current)
      }
      const mouseEnterHandler = () => { map.current?.getCanvas().style.setProperty('cursor', 'pointer') }
      const mouseLeaveHandler = () => { if (map.current) map.current.getCanvas().style.cursor = '' }
      wellsHandlersRef.current = { clickHandler, mouseEnterHandler, mouseLeaveHandler }
      for (const id of ['wells-laterals-layer', 'wells-points-layer']) {
        mapInstance.on('click', id, clickHandler)
        mapInstance.on('mouseenter', id, mouseEnterHandler)
        mapInstance.on('mouseleave', id, mouseLeaveHandler)
      }
    } else {
      ;(mapInstance.getSource('wells') as mapboxgl.GeoJSONSource).setData(wellsGeoJSON)
      for (const id of ['wells-laterals-layer', 'wells-points-layer', 'wells-arrows-layer']) {
        if (mapInstance.getLayer(id)) mapInstance.setLayoutProperty(id, 'visibility', vis)
      }
    }

    // Rig dots always render above the wells overlay.
    if (mapInstance.getLayer('permits-rigs-layer')) mapInstance.moveLayer('permits-rigs-layer')
  }, [])

  // Fetch + memoize the Texas county polygons (from plotly's public
  // FIPS dataset). Returns Texas-only features tagged with a __fips
  // string property. Cached in a ref so we don't re-fetch when
  // toggling between county overview and tract mode.
  const loadTexasCountiesGeoJSON = useCallback(async (): Promise<GeoJSON.Feature[] | null> => {
    if (txCountiesCacheRef.current) return txCountiesCacheRef.current
    const response = await fetch('https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json')
    if (!response.ok) return null
    const geojson = await response.json() as GeoJSON.FeatureCollection
    const texasFeatures = (geojson.features ?? [])
      .map((feature) => {
        const properties = (feature.properties ?? {}) as Record<string, unknown>
        const fips = String(feature.id ?? properties.GEOID ?? properties.FIPS ?? '').trim()
        if (!fips.startsWith('48')) return null
        return {
          ...feature,
          id: fips,
          properties: { ...properties, __fips: fips },
        } as GeoJSON.Feature
      })
      .filter(Boolean) as GeoJSON.Feature[]
    txCountiesCacheRef.current = texasFeatures
    return texasFeatures
  }, [])

  const setupCountyOverview = useCallback(async () => {
    const mapInstance = map.current
    if (!mapInstance) return

    const renderToken = ++renderTokenRef.current
    clearTractLayers(mapInstance)
    clearCountyOverviewLayers(mapInstance)
    clearCountyMarkers()

    const texasFeatures = await loadTexasCountiesGeoJSON()
    if (!texasFeatures || renderToken !== renderTokenRef.current || !map.current) return

    const activeFipsSet = new Set<string>()
    const activeCountyByFips: Record<string, CountyKey> = {}
    countyEntries.forEach(([countyKey, countyConfig]) => {
      activeFipsSet.add(countyConfig.fips)
      activeCountyByFips[countyConfig.fips] = countyKey
    })
    activeCountyByFipsRef.current = activeCountyByFips

    if (!map.current) return
    map.current.addSource('tx-counties', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: texasFeatures },
    })

    const dark = isDarkRef.current
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-fill',
      type: 'fill',
      source: 'tx-counties',
      paint: {
        'fill-color': dark ? '#334155' : '#E5E7EB',
        'fill-opacity': dark ? 0.45 : 0.35,
      },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-outline',
      type: 'line',
      source: 'tx-counties',
      paint: {
        'line-color': dark ? '#475569' : '#D1D5DB',
        'line-width': 0.5,
      },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-active-fill',
      type: 'fill',
      source: 'tx-counties',
      filter: ['in', ['get', '__fips'], ['literal', Array.from(activeFipsSet)]],
      paint: {
        'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#D97706', '#EF9F27'],
        'fill-opacity': 0.75,
      },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-active-outline',
      type: 'line',
      source: 'tx-counties',
      filter: ['in', ['get', '__fips'], ['literal', Array.from(activeFipsSet)]],
      paint: { 'line-color': '#D97706', 'line-width': 1.5 },
    })

    // "Coming soon" grey squares for the 10 Permian counties whose
    // data hasn't shipped yet — Midland, Glasscock, Upton, Reagan,
    // Crane, Pecos, Ward, Winkler, Loving, Reeves. Painted as
    // subtle grey fills with a "COMING SOON" label so the map
    // visually communicates the roadmap without the polygons
    // being clickable. Their FIPS codes come from UPCOMING_COUNTIES.
    const upcomingFipsSet = new Set(UPCOMING_COUNTIES.map((c) => c.fips))
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-upcoming-fill',
      type: 'fill',
      source: 'tx-counties',
      filter: ['in', ['get', '__fips'], ['literal', Array.from(upcomingFipsSet)]],
      paint: {
        'fill-color': '#94A3B8',
        'fill-opacity': 0.28,
      },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-upcoming-outline',
      type: 'line',
      source: 'tx-counties',
      filter: ['in', ['get', '__fips'], ['literal', Array.from(upcomingFipsSet)]],
      paint: {
        'line-color': '#64748B',
        'line-width': 1,
        'line-dasharray': [3, 3],
      },
    })

    const moveHandler = (event: mapboxgl.MapLayerMouseEvent) => {
      if (!map.current) return
      map.current.getCanvas().style.cursor = 'pointer'
      const feature = event.features?.[0]
      const fips = String(feature?.id ?? ((feature?.properties ?? {}) as Record<string, unknown>).__fips ?? '').trim()
      if (!fips) return
      const previous = countyOverviewHandlersRef.current.hoveredFips
      if (previous && previous !== fips) {
        map.current.setFeatureState({ source: 'tx-counties', id: previous }, { hover: false })
      }
      countyOverviewHandlersRef.current.hoveredFips = fips
      map.current.setFeatureState({ source: 'tx-counties', id: fips }, { hover: true })
    }
    const leaveHandler = () => {
      if (!map.current) return
      map.current.getCanvas().style.cursor = ''
      const previous = countyOverviewHandlersRef.current.hoveredFips
      if (previous) map.current.setFeatureState({ source: 'tx-counties', id: previous }, { hover: false })
      countyOverviewHandlersRef.current.hoveredFips = null
    }
    const clickHandler = (event: mapboxgl.MapLayerMouseEvent) => {
      const feature = event.features?.[0]
      const fips = String(feature?.id ?? ((feature?.properties ?? {}) as Record<string, unknown>).__fips ?? '').trim()
      const countyKey = activeCountyByFipsRef.current[fips]
      if (!countyKey) return
      if (onCountySelectRef.current) {
        onCountySelectRef.current(countyKey)
      } else {
        onCountySwitchRef.current(countyKey)
      }
    }

    countyOverviewHandlersRef.current = { moveHandler, leaveHandler, clickHandler, hoveredFips: null }
    map.current.on('mousemove', 'tx-counties-active-fill', moveHandler)
    map.current.on('mouseleave', 'tx-counties-active-fill', leaveHandler)
    map.current.on('click', 'tx-counties-active-fill', clickHandler)

    // County names as an in-map symbol layer painted directly on the
    // county polygons — replaces the old white pill-shaped HTML
    // Marker with owner count. Uses each county's mapCenter (already
    // configured per-county in lib/counties.ts) so labels sit inside
    // the polygon body regardless of how oddly-shaped the county
    // outline is. A generous halo keeps the text readable on top of
    // the amber active-county fill.
    if (map.current) {
      // Active-county label features (rendered dark on the amber
      // fill) share the same source as the upcoming-county labels;
      // an `active` boolean on each feature drives the text
      // formatter so the layer paints both types in one pass.
      const labelFeatures: GeoJSON.Feature[] = [
        ...countyEntries.map(([, cfg]) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: cfg.mapCenter },
          properties: {
            name: cfg.name.toUpperCase(),
            active: true,
            sub: '',
          },
        })),
        ...UPCOMING_COUNTIES.map((cfg) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: cfg.mapCenter },
          properties: {
            name: cfg.name,
            active: false,
            sub: 'COMING SOON',
          },
        })),
      ]
      map.current.addSource('tx-counties-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: labelFeatures },
      })
      // Two symbol layers stacked: primary county name (active
      // counties in dark, upcoming counties in a muted slate), and
      // an offset "COMING SOON" subtitle that only renders on
      // upcoming counties.
      map.current.addLayer({
        id: 'tx-counties-active-labels',
        type: 'symbol',
        source: 'tx-counties-labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            5, 10,
            7, 14,
            9, 18,
          ],
          'text-letter-spacing': 0.06,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          // Active counties (Martin/Howard) sit on amber fill: dark text
          // in light mode, white text in night mode so titles don't go black.
          'text-color': [
            'case',
            ['==', ['coalesce', ['get', 'active'], false], true],
            dark ? '#FFFFFF' : '#0F172A',
            dark ? '#CBD5E1' : '#64748B',
          ],
          'text-halo-color': dark ? '#92400E' : '#FFFFFF',
          'text-halo-width': 2,
          'text-halo-blur': 0.5,
        },
      })
      map.current.addLayer({
        id: 'tx-counties-upcoming-sub-labels',
        type: 'symbol',
        source: 'tx-counties-labels',
        filter: ['==', ['coalesce', ['get', 'active'], false], false],
        layout: {
          'text-field': ['get', 'sub'],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            5, 7,
            7, 9,
            9, 11,
          ],
          'text-letter-spacing': 0.15,
          'text-offset': [0, 1.4],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': dark ? '#94A3B8' : '#64748B',
          'text-halo-color': dark ? '#0F172A' : '#FFFFFF',
          'text-halo-width': 1.5,
        },
      })
    }

    map.current.easeTo({ center: TEXAS_OVERVIEW_CENTER, zoom: TEXAS_OVERVIEW_ZOOM, ...easedMove(CAMERA_OVERVIEW_MS) })
  }, [clearCountyMarkers, clearCountyOverviewLayers, clearTractLayers, countyEntries, loadTexasCountiesGeoJSON])

  const setupTractLevel = useCallback(async () => {
    const mapInstance = map.current
    if (!mapInstance) return

    const renderToken = ++renderTokenRef.current
    clearCountyOverviewLayers(mapInstance)
    clearCountyMarkers()
    clearTractLayers(mapInstance)

    // Always pull the slim map-only GeoJSON (props the renderer needs, no
    // owners_json payload). The full enriched file is still fetched by the
    // side panel in app/page.tsx for owner data. Counties load in parallel
    // so adding more never serializes the cold-load latency.
    const fetchTasks = countyEntries.map(async ([countyKey, countyConfig]) => {
      const response = await fetch(countyConfig.mapGeoJsonPath ?? countyConfig.geoJsonPath)
      if (!response.ok) {
        throw new Error(`Parcels source failed for ${countyConfig.id} (${response.status})`)
      }
      const geojson = await response.json() as GeoJSON.FeatureCollection
      return [countyKey, geojson] as const
    })
    const parcelsByCounty: Array<readonly [CountyKey, GeoJSON.FeatureCollection]> = await Promise.all(fetchTasks)
    if (renderToken !== renderTokenRef.current || !map.current) return

    currentParcelsByCountyRef.current = {}
    parcelsByCounty.forEach(([countyKey, geojson]) => {
      injectDevStatusIntoFeatures(geojson, devStatusByAbstractRef.current)
      currentParcelsByCountyRef.current[countyKey] = geojson
    })
    // Signal that parcel features are ready for focusTarget fitBounds.
    setParcelsVersion((v) => v + 1)
    parcelsByCounty.forEach(([countyKey, geojson]) => {
      const countyConfig = COUNTIES[countyKey]
      const sourceId = `parcels-${countyConfig.id}`
      const fillId = `parcels-fill-${countyConfig.id}`
      const outlineId = `parcels-outline-${countyConfig.id}`
      const labelsId = `parcels-labels-${countyConfig.id}`

      if (!map.current) return
      map.current.addSource(sourceId, {
        type: 'geojson',
        data: geojson,
        generateId: true,
        // Default tolerance is 0.375 px which aggressively simplifies small
        // polygons at low zoom — Howard's RRC abstract sections are tightly
        // clustered ~2 km wide and were collapsing out of low-zoom tiles, so
        // the fill layer had nothing to paint until you zoomed past 10. The
        // lower tolerance keeps every polygon present from the first tile
        // load while still trimming redundant vertices. The buffer bump
        // reduces edge clipping artifacts when panning at the tract level.
        tolerance: 0.05,
        buffer: 256,
      })
      if (!map.current) return
      // Bake the classification-driven paint expressions directly
      // into the layer definition. Previously we added the layer
      // with a static #9E9E9E gray and then swapped it to the
      // expression via setPaintProperty inside applyTractCountyStyles.
      // That worked, but on the very first tract-mode entry the
      // source is still loading tiles when setPaintProperty runs,
      // and Mapbox occasionally rendered the initial gray on the
      // first frame — the user reported this as "Martin coloring
      // doesn't populate when you click on it first". Adding the
      // expression at layer-creation time avoids that race.
      // applyTractCountyStyles still runs afterwards, but its job
      // shrinks to visibility toggles + layer ordering, not paint
      // property swaps.
      map.current.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': selectedFillColorExpr,
          'fill-opacity': selectedFillOpacityExpr,
        },
      })
      if (!map.current) return
      map.current.addLayer({
        id: outlineId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': selectedOutlineColorExpr,
          'line-width': selectedOutlineWidthExpr,
          'line-opacity': 0.92,
        },
      })

      if (!map.current) return
      // New-permit glow. Any tract whose signal_detail carries a
      // permit approved in the last 90 days lights up with a
      // saturated blue outline that renders ABOVE the tract fill
      // and the neutral gray outline. This surfaces fresh drilling
      // activity without collapsing the primary map_status color —
      // a PDP tract with a fresh infill permit stays yellow underneath,
      // but the blue halo tells the broker "someone just filed a
      // new W-1 here".
      // We use two stacked line layers to fake a glow: an outer,
      // wider, semi-transparent blue underneath a narrow bright core.
      const glowGlowId = `parcels-permit-glow-outer-${countyConfig.id}`
      const glowCoreId = `parcels-permit-glow-core-${countyConfig.id}`
      map.current.addLayer({
        id: glowGlowId,
        type: 'line',
        source: sourceId,
        filter: ['==', ['coalesce', ['get', 'has_recent_permit'], false], true],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          // Wide bright-blue halo. Reads through yellow (PDP) and
          // orange (PUD Infill) fills because both those hues are
          // warm and low-contrast against #3B82F6.
          'line-color': '#3B82F6',
          'line-width': 12,
          'line-opacity': 0.55,
          'line-blur': 3,
        },
      })
      map.current.addLayer({
        id: glowCoreId,
        type: 'line',
        source: sourceId,
        filter: ['==', ['coalesce', ['get', 'has_recent_permit'], false], true],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          // Bright electric-blue core, thicker than before so the
          // permit signal reads at low zoom too.
          'line-color': '#60A5FA',
          'line-width': 3.5,
          'line-opacity': 1,
        },
      })

      // Submitted-permit teal halo (added 2026-07-21). Same
      // two-layer glow trick as the blue halo above, but keyed on
      // has_recent_permit_submitted (filed_date within 90 days
      // AND no recent approved_date). Teal is deliberately far
      // from every other palette color we ship:
      //   PDP yellow, PUD_DUC purple, PUD_INFILL orange, frontier
      //   gray, approved-permit blue, active-rig red. Teal
      //   (#14B8A6 outer, #5EEAD4 core) is the only cool-desat
      //   color that doesn't collide.
      const submittedOuterId = `parcels-permit-submitted-outer-${countyConfig.id}`
      const submittedCoreId = `parcels-permit-submitted-core-${countyConfig.id}`
      map.current.addLayer({
        id: submittedOuterId,
        type: 'line',
        source: sourceId,
        filter: ['==', ['coalesce', ['get', 'has_recent_permit_submitted'], false], true],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#14B8A6',
          'line-width': 12,
          'line-opacity': 0.55,
          'line-blur': 3,
        },
      })
      map.current.addLayer({
        id: submittedCoreId,
        type: 'line',
        source: sourceId,
        filter: ['==', ['coalesce', ['get', 'has_recent_permit_submitted'], false], true],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#5EEAD4',
          'line-width': 3.5,
          'line-opacity': 1,
        },
      })

      if (!map.current) return
      // Parcel labels. Two zoom bands so the user always sees enough
      // context to place themselves without cluttering low-zoom views:
      //   z9–z11: just the abstract label (e.g. "A-543"). Small, dense.
      //   z11+  : full legal description
      //           ("T2N BLK 31 SEC 20 A-543" for T&P counties,
      //            "COOK, W H A-160" for Gonzales-style abstracts),
      //           precomputed per-tract by scripts/build_map_geojson.py
      //           into the `legal_desc` prop.
      // `text-field` switches on zoom via a step expression rather than
      // adding a second layer — Mapbox handles the swap without needing
      // us to manage two symbol layers' visibility.
      map.current.addLayer({
        id: labelsId,
        type: 'symbol',
        source: sourceId,
        minzoom: 9,
        layout: {
          'text-field': [
            'step',
            ['zoom'],
            [
              'coalesce',
              ['get', 'ABSTRACT_L'],
              ['concat', 'A-', ['to-string', ['get', 'ABSTRACT_N']]],
              '',
            ],
            11,
            [
              'coalesce',
              ['get', 'legal_desc'],
              ['get', 'ABSTRACT_L'],
              '',
            ],
          ],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 9,
            12, 11,
            14, 13,
          ],
          'text-anchor': 'center',
          'text-justify': 'center',
          'text-max-width': 10,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.4,
          'text-halo-blur': 0.6,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9, 0,
            10, 1,
          ],
        },
      })

      if (!map.current) return
      // Per-tract section number. Only shown at z10+ so we don't clutter
      // the overview zooms. Field-name convention varies by county:
      //   Howard   → Surv_Sect ("20", "25", "26", …)
      //   Martin   → LEVEL3_SUR ("131", "36", …)
      //   Gonzales → no section number in the source shapefile
      // `coalesce` picks the first non-null so the same paint spec works
      // for every county.
      const sectionsId = `parcels-sections-${countyConfig.id}`
      map.current.addLayer({
        id: sectionsId,
        type: 'symbol',
        source: sourceId,
        minzoom: 10,
        layout: {
          'text-field': [
            'coalesce',
            ['get', 'Surv_Sect'],
            ['get', 'LEVEL3_SUR'],
            '',
          ],
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#1a1a1a',
          'text-halo-width': 1.5,
        },
      })

      if (!map.current) return
      // Secondary centroid dots (permit / DUC / infill / pending) were
      // removed with the unified-legend redesign. Each of those signals
      // now paints as the tract's primary color via the map_status
      // derivation in deriveMapStatus (PUD_PERMITTED, PUD_DUC, and
      // PUD_INFILL respectively). If a broker wants the exact spud
      // location for a permit they click the tract and read the
      // permits list in the OwnerDrawer.

      if (!map.current) return
      // Block labels: one point per distinct Block value, placed at the
      // averaged centroid of all tracts in that block. Visible earlier than
      // section numbers since blocks are larger aggregations.
      const blockSourceId = `block-labels-source-${countyConfig.id}`
      const blockLayerId = `block-labels-${countyConfig.id}`
      const blockFeatureCollection = buildBlockLabelFeatureCollection(geojson)
      if (blockFeatureCollection.features.length > 0) {
        map.current.addSource(blockSourceId, { type: 'geojson', data: blockFeatureCollection })
        if (!map.current) return
        map.current.addLayer({
          id: blockLayerId,
          type: 'symbol',
          source: blockSourceId,
          minzoom: 8,
          layout: {
            'text-field': ['concat', 'Block ', ['get', 'block']],
            'text-size': 13,
            'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
            'text-anchor': 'center',
            'text-allow-overlap': false,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 2,
          },
        })
      }

      const mouseEnterHandler = () => {
        map.current?.getCanvas().style.setProperty('cursor', 'pointer')
      }
      const mouseLeaveHandler = () => {
        if (map.current) map.current.getCanvas().style.cursor = ''
      }

      tractHandlersRef.current.push({
        layerId: fillId,
        mouseEnterHandler,
        mouseLeaveHandler,
      })

      if (!map.current) return
      map.current.on('mouseenter', fillId, mouseEnterHandler)
      map.current.on('mouseleave', fillId, mouseLeaveHandler)
    })

    if (tractClickHandlerRef.current) {
      map.current?.off('click', tractClickHandlerRef.current)
      tractClickHandlerRef.current = null
    }

    const handler = (event: mapboxgl.MapMouseEvent) => {
      if (!map.current) return

      const layerIds = countyEntries
        .map(([, countyConfig]) => `parcels-fill-${countyConfig.id}`)
        .filter((id) => !!map.current?.getLayer(id))
      if (layerIds.length === 0) return

      const features = map.current.queryRenderedFeatures(event.point, { layers: layerIds })
      if (!features?.length) return

      const selectedLayerId = `parcels-fill-${COUNTIES[selectedCountyRef.current].id}`
      const topFeature = features.find((feature) => feature.layer?.id === selectedLayerId) ?? features[0]
      const topLayerId = topFeature.layer?.id
      if (!topLayerId) return
      const topCountyId = topLayerId.replace('parcels-fill-', '')
      const countyKey = countyEntries.find(([, countyConfig]) => countyConfig.id === topCountyId)?.[0]
      if (!countyKey) return

      // Did the click land on a well line/dot? If so we keep the tract
      // selection (owner panel) but must NOT move the camera — re-fitting the
      // whole tract zooms the user out, which is jarring when they clicked a
      // well while zoomed in. The well's own popup handles the interaction.
      const wellLayerIds = ['wells-laterals-layer', 'wells-points-layer']
        .filter((id) => !!map.current?.getLayer(id))
      const clickedWell = wellLayerIds.length > 0 &&
        map.current.queryRenderedFeatures(event.point, { layers: wellLayerIds }).length > 0

      const props = topFeature.properties as Record<string, unknown> | undefined
      // County switches must never be debounced — swapping counties is a
      // deliberate navigation and always fires the swoop to the new county.
      if (countyKey !== selectedCountyRef.current) {
        onCountySwitchRef.current(countyKey)
        return
      }

      // Debounce only same-county tract selection so a jittery double-click
      // doesn't fire two fitGeometry animations back to back.
      const now = Date.now()
      if (now - lastClickTimeRef.current < 300) return
      lastClickTimeRef.current = now

      if (props) {
        onOwnerClickRef.current(props as Record<string, unknown>)
      }

      const clickedAbstract = props?.ABSTRACT_L ?? props?.CODE ?? props?.abstract_label
      const countyGeoJSON = currentParcelsByCountyRef.current[countyKey]
      const matchedFeature = countyGeoJSON?.features?.find((feature) => {
        const featureProps = feature.properties as Record<string, unknown>
        return featureProps?.ABSTRACT_L === clickedAbstract ||
          featureProps?.CODE === clickedAbstract ||
          String(featureProps?.CODE) === String(clickedAbstract)
      })
      const geometry = matchedFeature?.geometry ?? (topFeature.geometry as GeoJSON.Geometry | undefined)
      const clickPoint: [number, number] = [event.lngLat.lng, event.lngLat.lat]
      if (geometry && !clickedWell) {
        setTimeout(() => {
          if (map.current) {
            try {
              // Focus the polygon part the user actually clicked, so
              // dissolved multi-part tracts don't zoom to a scattered extent.
              fitGeometry(map.current, geometry, { focusPoint: clickPoint })
            } catch (e) {
              console.error('fitGeometry error:', e)
            }
          }
        }, 200)
      }
    }

    tractClickHandlerRef.current = handler
    if (!map.current) return
    map.current.on('click', handler)

    // Inactive-county overlay: when zoomed into one county's tract
    // view, paint the OTHER 11 active counties as clean orange
    // blocks with just the county name — same visual as the county
    // overview. Without this, Howard's tract data (labels, permit
    // halos, muted parcel outlines) bleeds through when the user is
    // looking at Martin next door and the map is clearly cluttered.
    // Upcoming counties render as grey COMING SOON squares in this
    // mode too so the Permian footprint is always intact.
    const texasFeatures = await loadTexasCountiesGeoJSON()
    if (renderToken !== renderTokenRef.current || !map.current) return
    if (texasFeatures) {
      const upcomingFipsSet = new Set(UPCOMING_COUNTIES.map((c) => c.fips))
      const allActiveFipsSet = new Set(countyEntries.map(([, cfg]) => cfg.fips))
      const currentFips = COUNTIES[selectedCountyRef.current].fips
      // All active counties EXCEPT the one currently open — those
      // get the orange overlay to hide their parcel data.
      const inactiveActiveFips = Array.from(allActiveFipsSet).filter((f) => f !== currentFips)

      const overlayFeatures = texasFeatures
        .filter((feat) => {
          const fips = String(((feat.properties ?? {}) as Record<string, unknown>).__fips ?? feat.id ?? '')
          return upcomingFipsSet.has(fips) || (allActiveFipsSet.has(fips) && fips !== currentFips)
        })
        .map((feat) => {
          const fips = String(((feat.properties ?? {}) as Record<string, unknown>).__fips ?? feat.id ?? '')
          return {
            ...feat,
            properties: {
              ...(feat.properties ?? {}),
              __fips: fips,
              __role: upcomingFipsSet.has(fips) ? 'upcoming' : 'inactive',
            },
          } as GeoJSON.Feature
        })

      // Same tx-counties-labels source as county-overview, so
      // county names sit on the polygon centers. Both active and
      // upcoming labels are added.
      const labelFeatures: GeoJSON.Feature[] = [
        ...countyEntries.map(([, cfg]) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: cfg.mapCenter },
          properties: {
            name: cfg.name.toUpperCase(),
            fips: cfg.fips,
            role: 'active',
            sub: '',
          },
        })),
        ...UPCOMING_COUNTIES.map((cfg) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: cfg.mapCenter },
          properties: {
            name: cfg.name,
            fips: cfg.fips,
            role: 'upcoming',
            sub: 'COMING SOON',
          },
        })),
      ]

      if (!map.current.getSource('tract-mode-overlay')) {
        map.current.addSource('tract-mode-overlay', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: overlayFeatures },
        })
      } else {
        const src = map.current.getSource('tract-mode-overlay') as mapboxgl.GeoJSONSource
        src.setData({ type: 'FeatureCollection', features: overlayFeatures })
      }
      if (!map.current.getSource('tract-mode-overlay-labels')) {
        map.current.addSource('tract-mode-overlay-labels', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: labelFeatures },
        })
      } else {
        const src = map.current.getSource('tract-mode-overlay-labels') as mapboxgl.GeoJSONSource
        src.setData({ type: 'FeatureCollection', features: labelFeatures })
      }

      // Orange block for inactive active counties.
      if (!map.current.getLayer('tract-inactive-fill')) {
        map.current.addLayer({
          id: 'tract-inactive-fill',
          type: 'fill',
          source: 'tract-mode-overlay',
          filter: ['==', ['get', '__role'], 'inactive'],
          paint: { 'fill-color': '#EF9F27', 'fill-opacity': 0.75 },
        })
      }
      if (!map.current.getLayer('tract-inactive-outline')) {
        map.current.addLayer({
          id: 'tract-inactive-outline',
          type: 'line',
          source: 'tract-mode-overlay',
          filter: ['==', ['get', '__role'], 'inactive'],
          paint: { 'line-color': '#D97706', 'line-width': 1.5 },
        })
      }
      // Grey COMING SOON block for the 10 upcoming counties.
      if (!map.current.getLayer('tract-upcoming-fill')) {
        map.current.addLayer({
          id: 'tract-upcoming-fill',
          type: 'fill',
          source: 'tract-mode-overlay',
          filter: ['==', ['get', '__role'], 'upcoming'],
          paint: { 'fill-color': '#94A3B8', 'fill-opacity': 0.28 },
        })
      }
      if (!map.current.getLayer('tract-upcoming-outline')) {
        map.current.addLayer({
          id: 'tract-upcoming-outline',
          type: 'line',
          source: 'tract-mode-overlay',
          filter: ['==', ['get', '__role'], 'upcoming'],
          paint: {
            'line-color': '#64748B',
            'line-width': 1,
            'line-dasharray': [3, 3],
          },
        })
      }
      // County name label — dark for inactive active counties,
      // muted slate for upcoming. Filtered to hide the label for
      // whichever county is currently open (its own parcel-labels
      // and detail take over the visual).
      if (!map.current.getLayer('tract-overlay-labels')) {
        map.current.addLayer({
          id: 'tract-overlay-labels',
          type: 'symbol',
          source: 'tract-mode-overlay-labels',
          filter: ['!=', ['get', 'fips'], currentFips],
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
            'text-size': [
              'interpolate', ['linear'], ['zoom'],
              6, 10,
              8, 14,
              10, 18,
            ],
            'text-letter-spacing': 0.06,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': [
              'case',
              ['==', ['get', 'role'], 'active'],
              isDarkRef.current ? '#FFFFFF' : '#0F172A',
              isDarkRef.current ? '#CBD5E1' : '#64748B',
            ],
            'text-halo-color': isDarkRef.current ? '#92400E' : '#FFFFFF',
            'text-halo-width': 2,
            'text-halo-blur': 0.5,
          },
        })
      } else {
        map.current.setFilter('tract-overlay-labels', ['!=', ['get', 'fips'], currentFips])
      }
      // Click-to-switch: tapping an inactive county's orange block
      // switches the map into that county's tract view. Wires up
      // activeCountyByFipsRef so the click handler can look up the
      // countyKey from the clicked feature's FIPS, then defers to
      // the same onCountySwitch callback the county overview uses.
      // Cursor style is set on hover so the block reads as clickable.
      const activeCountyByFips: Record<string, CountyKey> = {}
      countyEntries.forEach(([countyKey, cfg]) => {
        activeCountyByFips[cfg.fips] = countyKey
      })
      activeCountyByFipsRef.current = activeCountyByFips
      const inactiveClickHandler = (event: mapboxgl.MapLayerMouseEvent) => {
        const feature = event.features?.[0]
        const fips = String(
          ((feature?.properties ?? {}) as Record<string, unknown>).__fips ??
          feature?.id ?? '',
        ).trim()
        const countyKey = activeCountyByFipsRef.current[fips]
        if (!countyKey || !map.current) return
        onCountySwitchRef.current(countyKey)
      }
      const inactiveHoverEnter = () => {
        if (map.current) map.current.getCanvas().style.cursor = 'pointer'
      }
      const inactiveHoverLeave = () => {
        if (map.current) map.current.getCanvas().style.cursor = ''
      }
      // Detach the PREVIOUS click handler by its exact reference (a fresh
      // closure is created on every style pass, so off() must target the one
      // we actually bound last time — otherwise handlers pile up and a single
      // click switches counties multiple times / races the camera).
      if (inactiveClickHandlerRef.current) {
        map.current.off('click', 'tract-inactive-fill', inactiveClickHandlerRef.current)
      }
      map.current.on('click', 'tract-inactive-fill', inactiveClickHandler)
      inactiveClickHandlerRef.current = inactiveClickHandler
      map.current.on('mouseenter', 'tract-inactive-fill', inactiveHoverEnter)
      map.current.on('mouseleave', 'tract-inactive-fill', inactiveHoverLeave)

      if (!map.current.getLayer('tract-overlay-sub-labels')) {
        map.current.addLayer({
          id: 'tract-overlay-sub-labels',
          type: 'symbol',
          source: 'tract-mode-overlay-labels',
          filter: ['==', ['get', 'role'], 'upcoming'],
          layout: {
            'text-field': ['get', 'sub'],
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
            'text-size': [
              'interpolate', ['linear'], ['zoom'],
              6, 7,
              8, 9,
              10, 11,
            ],
            'text-letter-spacing': 0.15,
            'text-offset': [0, 1.4],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': isDarkRef.current ? '#94A3B8' : '#64748B',
            'text-halo-color': isDarkRef.current ? '#0F172A' : '#FFFFFF',
            'text-halo-width': 1.5,
          },
        })
      }
    }

    await loadSelectedCountyPermits()
    if (renderToken !== renderTokenRef.current || !map.current) return
    void loadSelectedCountyWells()
    applyTractCountyStyles()
  }, [applyTractCountyStyles, clearCountyMarkers, clearCountyOverviewLayers, clearTractLayers, countyEntries, loadSelectedCountyPermits, loadSelectedCountyWells, loadTexasCountiesGeoJSON])

  const renderForCurrentLevel = useCallback(async () => {
    if (!map.current) return
    if (mapLevel === 'county') {
      await setupCountyOverview()
      return
    }
    await setupTractLevel()
  }, [mapLevel, setupCountyOverview, setupTractLevel])

  useEffect(() => {
    renderForCurrentLevelRef.current = renderForCurrentLevel
  }, [renderForCurrentLevel])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    const initialStyle = document.documentElement.classList.contains('dark')
      ? MAP_STYLE_DARK
      : MAP_STYLE_LIGHT
    basemapStyleRef.current = initialStyle
    isDarkRef.current = initialStyle === MAP_STYLE_DARK

    const mapInstance = new mapboxgl.Map({
      container: mapContainer.current,
      style: initialStyle,
      center: TEXAS_OVERVIEW_CENTER,
      zoom: TEXAS_OVERVIEW_ZOOM,
    })
    map.current = mapInstance

    const onLoad = () => {
      setMapReady(true)
      void renderForCurrentLevelRef.current()
    }
    mapInstance.on('load', onLoad)

    return () => {
      clearCountyMarkers()
      if (map.current) {
        if (tractClickHandlerRef.current) {
          map.current.off('click', tractClickHandlerRef.current)
          tractClickHandlerRef.current = null
        }
        clearCountyOverviewLayers(map.current)
        clearTractLayers(map.current)
      }
      map.current?.remove()
      map.current = null
      setMapReady(false)
      renderTokenRef.current += 1
    }
  }, [])

  // Swap Mapbox basemap when the user toggles night mode. setStyle wipes
  // custom layers — rebuild via renderForCurrentLevel after style.load.
  useEffect(() => {
    const mapInstance = map.current
    if (!mapInstance) return
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') return

    const nextStyle = resolvedTheme === 'dark' ? MAP_STYLE_DARK : MAP_STYLE_LIGHT
    if (basemapStyleRef.current === nextStyle) return
    basemapStyleRef.current = nextStyle
    isDarkRef.current = resolvedTheme === 'dark'

    clearCountyMarkers()
    setMapReady(false)

    mapInstance.once('style.load', () => {
      setMapReady(true)
      void renderForCurrentLevelRef.current()
    })
    mapInstance.setStyle(nextStyle)
  }, [resolvedTheme, clearCountyMarkers])

  useEffect(() => {
    if (!map.current) return
    if (!map.current.isStyleLoaded()) {
      map.current.once('load', () => {
        void renderForCurrentLevelRef.current()
      })
      return
    }
    void renderForCurrentLevelRef.current()
  }, [mapLevel])

  useEffect(() => {
    if (!mapFlyToRef) return
    mapFlyToRef.current = (center, zoom) => {
      const mapInstance = map.current
      if (!mapInstance) return
      // Safety net: never fly outside the Texas/Permian window. Guards against
      // a bad/empty/zero deep-link coordinate (e.g. lat=0&lon=0) sending the
      // camera to Null Island / the ocean off West Africa.
      const [lon, lat] = center
      if (
        !Number.isFinite(lon) || !Number.isFinite(lat) ||
        lon < -108 || lon > -92 || lat < 24 || lat > 38
      ) {
        return
      }
      // Cancel any in-flight tract fitBounds / prior fly so the county
      // camera isn't immediately overwritten.
      try {
        mapInstance.stop()
      } catch {
        // stop() can throw if the map is mid-remove; ignore.
      }
      const run = () => {
        if (!map.current) return
        // flyTo swoop for every county switch: an eased arc that always reads
        // as a deliberate jump to the new county, even for adjacent ones.
        map.current.flyTo({ center, zoom, ...swoopMove() })
      }
      if (!mapInstance.isStyleLoaded()) {
        mapInstance.once('load', run)
        return
      }
      run()
    }
    return () => {
      mapFlyToRef.current = null
    }
  }, [mapFlyToRef])

  useEffect(() => {
    if (!map.current?.isStyleLoaded()) return
    if (mapLevel !== 'tract') return
    // Re-color active/muted counties immediately (cheap paint-property swaps).
    applyTractCountyStyles()
    // Defer the rig/permit reload (network + new point geometry) until just
    // after the county swoop settles. Loading it mid-flight made fresh rig
    // dots pop in while the camera was still moving, which read as a stutter.
    // The cleanup cancels a pending load if the user switches again first.
    const permitTimer = setTimeout(() => {
      void loadSelectedCountyPermits()
      void loadSelectedCountyWells()
    }, CAMERA_SWOOP_MS + 80)
    return () => clearTimeout(permitTimer)
  }, [applyTractCountyStyles, loadSelectedCountyPermits, loadSelectedCountyWells, mapLevel, selectedCounty])

  // Live refresh — same cadence as PermitsNavLink / useActivityRefreshTick.
  // Drop the whole session cache so a county revisit after an ingest
  // also picks up fresh coords / spud rows, then reload the active
  // county's rig layer via setData.
  useEffect(() => {
    if (!activityRefreshTick) return
    if (!map.current?.isStyleLoaded()) return
    if (mapLevel !== 'tract') return
    permitsCacheRef.current = {}
    void loadSelectedCountyPermits({ force: true })
  }, [activityRefreshTick, loadSelectedCountyPermits, mapLevel])

  // Amber ring around tracts whose CAD ownership matches the operator filter.
  useEffect(() => {
    const mapInstance = map.current
    if (!mapInstance?.isStyleLoaded() || mapLevel !== 'tract') return

    const countyId = COUNTIES[selectedCounty]?.id
    if (!countyId) return
    const sourceId = `parcels-${countyId}`
    const layerId = `parcels-operator-match-${countyId}`

    if (mapInstance.getLayer(layerId)) {
      mapInstance.removeLayer(layerId)
    }

    if (
      operatorMatchAbstracts == null ||
      operatorMatchAbstracts.length === 0 ||
      !mapInstance.getSource(sourceId)
    ) {
      return
    }

    const literals = operatorMatchAbstracts.slice(0, 8000)
    mapInstance.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      filter: ['in', ['get', 'ABSTRACT_L'], ['literal', literals]],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#EF9F27',
        'line-width': 3.5,
        'line-opacity': 0.95,
      },
    })
  }, [operatorMatchAbstracts, selectedCounty, mapLevel, mapReady])

  // When any per-status toggle flips, applyTractCountyStyles's own
  // "same county, nothing to repaint" optimization would swallow the
  // update. Force a repaint by invalidating the last-styled ref before
  // the effect above re-fires (applyTractCountyStyles is memoized on
  // the fill/opacity expressions, which depend on statusVisible).
  useEffect(() => {
    lastStyledSelectedCountyRef.current = null
  }, [statusVisible, operatorMatchAbstracts])

  // Re-inject development_status + secondary flags onto every loaded
  // feature when the per-county dev-status lookup changes (initial
  // fetch + county switch). Without this, features loaded before the
  // Supabase query returns would stay tagged FRONTIER forever.
  useEffect(() => {
    const mapInstance = map.current
    if (!mapInstance) return
    const lookup = devStatusByAbstract ?? {}
    if (Object.keys(lookup).length === 0) return
    let updated = 0
    for (const [countyKey, collection] of Object.entries(currentParcelsByCountyRef.current)) {
      if (!collection) continue
      injectDevStatusIntoFeatures(collection, lookup)
      const sourceId = `parcels-${COUNTIES[countyKey as CountyKey].id}`
      const source = mapInstance.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined
      if (source) {
        source.setData(collection)
        updated += 1
      }
    }
    if (updated > 0) {
      // The source's paint expressions will re-evaluate against
      // the new map_status automatically, but visibility toggles
      // and layer-ordering (rig on top, orange overlay above
      // muted parcels, etc.) still need one pass to line up. Force
      // a full first-pass repaint by nulling the ref before the
      // sync applyTractCountyStyles call below.
      lastStyledSelectedCountyRef.current = null
      applyTractCountyStyles()
    }
  }, [devStatusByAbstract, applyTractCountyStyles])

  // Bold/subtle tract-fill toggle changes fill-opacity for the *same* county,
  // which applyTractCountyStyles' same-county short-circuit would skip — so
  // force a full re-style when it flips.
  useEffect(() => {
    if (!map.current?.isStyleLoaded() || mapLevel !== 'tract') return
    lastStyledSelectedCountyRef.current = null
    applyTractCountyStyles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boldTracts, wellsOnly])

  useEffect(() => {
    if (!map.current?.isStyleLoaded()) return
    if (!map.current) return
    const mapInstance = map.current
    const tractLevel = mapLevel === 'tract'
    // Rigs overlay + permit glow layers are the two toggle-driven
    // overlays. Both stay hidden when mapLevel is 'county' (no
    // parcel-level layers to sit on top of).
    if (mapInstance.getLayer('permits-rigs-layer')) {
      mapInstance.setLayoutProperty(
        'permits-rigs-layer',
        'visibility',
        tractLevel && showRigs ? 'visible' : 'none',
      )
    }
    // Well-geometry overlay (laterals + vertical/permit dots + direction arrows).
    for (const layerId of ['wells-laterals-layer', 'wells-points-layer', 'wells-arrows-layer']) {
      if (mapInstance.getLayer(layerId)) {
        mapInstance.setLayoutProperty(
          layerId,
          'visibility',
          tractLevel && showWells ? 'visible' : 'none',
        )
      }
    }
    for (const [, countyConfig] of countyEntries) {
      // Approved-permit blue halo (existing).
      for (const suffix of ['permit-glow-outer', 'permit-glow-core']) {
        const layerId = `parcels-${suffix}-${countyConfig.id}`
        if (mapInstance.getLayer(layerId)) {
          mapInstance.setLayoutProperty(
            layerId,
            'visibility',
            tractLevel && showPermitGlow ? 'visible' : 'none',
          )
        }
      }
      // Submitted-permit teal halo (2026-07-21). Independent toggle.
      for (const suffix of ['permit-submitted-outer', 'permit-submitted-core']) {
        const layerId = `parcels-${suffix}-${countyConfig.id}`
        if (mapInstance.getLayer(layerId)) {
          mapInstance.setLayoutProperty(
            layerId,
            'visibility',
            tractLevel && showSubmittedGlow ? 'visible' : 'none',
          )
        }
      }
    }
  }, [mapLevel, showRigs, showWells, showPermitGlow, showSubmittedGlow, countyEntries, statusVisible])

  useEffect(() => {
    if (mapLevel !== 'tract') return
    if (!focusTarget || !map.current?.isStyleLoaded()) return

    const features = currentParcelsByCountyRef.current[selectedCountyRef.current]?.features ?? []
    if (features.length === 0) return

    const normalizeAbstract = (raw: unknown) =>
      String(raw ?? '')
        .replace(/^A-\s*/i, '')
        .trim()
        .toUpperCase()

    const selectedAbstract = normalizeAbstract(
      focusTarget.abstract_label ?? focusTarget.ABSTRACT_L ?? focusTarget.CODE,
    )
    if (!selectedAbstract) return

    const selectedSurvey = String(
      focusTarget.level1_sur ?? focusTarget.LEVEL1_SUR ?? '',
    )
      .trim()
      .toUpperCase()

    // Prefer abstract + survey when both sides have survey; otherwise
    // match on bare abstract alone. Howard/Martin map geojson often has
    // LEVEL1_SUR = null, and the old `!selectedSurvey` early-return meant
    // deep-links from /pad-activity never fitBounds.
    const matched =
      features.find((feature) => {
        const props = (feature.properties ?? {}) as Record<string, unknown>
        const featureAbstract = normalizeAbstract(
          props.abstract_label ?? props.ABSTRACT_L ?? props.CODE,
        )
        if (featureAbstract !== selectedAbstract) return false
        if (!selectedSurvey) return true
        const featureSurvey = String(props.level1_sur ?? props.LEVEL1_SUR ?? '')
          .trim()
          .toUpperCase()
        return !featureSurvey || featureSurvey === selectedSurvey
      }) ??
      features.find((feature) => {
        const props = (feature.properties ?? {}) as Record<string, unknown>
        return (
          normalizeAbstract(props.abstract_label ?? props.ABSTRACT_L ?? props.CODE) ===
          selectedAbstract
        )
      })

    if (matched?.geometry) {
      fitGeometry(map.current, matched.geometry, {
        padding: 80,
        maxZoom: 15,
        duration: 900,
      })
      return
    }

    // Deep-links sometimes select the sidebar tract (enriched geojson)
    // while the slim map layer can't match the abstract label. Fall
    // back to any lat/lon carried on the focus target so the camera
    // still moves onto the pad.
    const lat = Number(
      (focusTarget as { latitude?: unknown }).latitude ??
        (focusTarget as { lat?: unknown }).lat,
    )
    const lon = Number(
      (focusTarget as { longitude?: unknown }).longitude ??
        (focusTarget as { lon?: unknown }).lon ??
        (focusTarget as { lng?: unknown }).lng,
    )
    if (
      Number.isFinite(lat) && Number.isFinite(lon) &&
      lon >= -108 && lon <= -92 && lat >= 24 && lat <= 38
    ) {
      map.current.easeTo({ center: [lon, lat], zoom: 14, ...easedMove(CAMERA_TRACT_MS) })
    }
  }, [focusTarget, mapLevel, selectedCounty, parcelsVersion])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      {mapReady && (
        <TractSearch
          map={map.current}
          geojsonUrl={COUNTIES[selectedCounty].mapGeoJsonPath ?? COUNTIES[selectedCounty].geoJsonPath}
        />
      )}
      {mapReady && mapLevel === 'tract' && (
        <LayerTogglePanel
          statusVisible={statusVisible}
          onStatus={setStatus}
          statusPalette={STATUS_FILL}
          statusLabels={STATUS_LABEL}
          rigsVisible={showRigs}
          onRigs={setShowRigs}
          wellsVisible={showWells}
          onWells={setShowWells}
          wellsByOperator={wellsByOperator}
          onWellsByOperator={setWellsByOperator}
          boldTracts={boldTracts}
          onBoldTracts={setBoldTracts}
          wellsOnly={wellsOnly}
          onWellsOnly={setWellsOnly}
          permitGlowVisible={showPermitGlow}
          onPermitGlow={setShowPermitGlow}
          submittedGlowVisible={showSubmittedGlow}
          onSubmittedGlow={setShowSubmittedGlow}
          operatorOptions={operatorOptions}
          selectedOperatorKeys={selectedOperatorKeys}
          onOperatorKeysChange={onOperatorKeysChange}
          operatorMatchTractCount={operatorMatchTractCount}
        />
      )}
    </div>
  )
}

// In-map layer control. Fixed to the top-right of the map viewport.
// Single unified LEGEND — one row per UnifiedStatus, one color per
// status, one toggle per row. Checking a row shows those tracts;
// unchecking hides them by dropping fill-opacity to 0. Below the
// legend a single OVERLAYS section carries the Active rigs dot
// toggle, which is the one signal that doesn't collapse cleanly
// into the primary tract classification.
function LayerTogglePanel({
  statusVisible, onStatus,
  statusPalette, statusLabels,
  rigsVisible, onRigs,
  wellsVisible, onWells,
  wellsByOperator, onWellsByOperator,
  boldTracts, onBoldTracts,
  wellsOnly, onWellsOnly,
  permitGlowVisible, onPermitGlow,
  submittedGlowVisible, onSubmittedGlow,
  operatorOptions,
  selectedOperatorKeys,
  onOperatorKeysChange,
  operatorMatchTractCount,
}: {
  statusVisible: Record<UnifiedStatus, boolean>
  onStatus: (key: UnifiedStatus, v: boolean) => void
  statusPalette: Record<UnifiedStatus, string>
  statusLabels: Record<UnifiedStatus, string>
  rigsVisible: boolean
  onRigs: (v: boolean) => void
  wellsVisible: boolean
  onWells: (v: boolean) => void
  wellsByOperator: boolean
  onWellsByOperator: (v: boolean) => void
  boldTracts: boolean
  onBoldTracts: (v: boolean) => void
  wellsOnly: boolean
  onWellsOnly: (v: boolean) => void
  permitGlowVisible: boolean
  onPermitGlow: (v: boolean) => void
  submittedGlowVisible: boolean
  onSubmittedGlow: (v: boolean) => void
  operatorOptions: OperatorOption[]
  selectedOperatorKeys: string[]
  onOperatorKeysChange?: (keys: string[]) => void
  operatorMatchTractCount?: number | null
}) {
  // Legend: PDP / DUC / Infill / True PUD. FRONTIER is the DB key for
  // the undeveloped bucket but the swatch labels as "True PUD"
  // (emerald). PUD_PERMITTED / LEASING_ACTIVE stay off the legend —
  // permits via blue/teal glow, leasing unused.
  const statusKeys: UnifiedStatus[] = [
    'PDP', 'PUD_DUC', 'PUD_INFILL', 'FRONTIER',
  ]
  const legendRows = statusKeys.map((key) => ({
    label: statusLabels[key],
    swatch: 'fill' as const,
    color: statusPalette[key],
    checked: statusVisible[key],
    onChange: (v: boolean) => onStatus(key, v),
  }))

  return (
    <div
      data-tour="layer-legend"
      style={{
        position: 'absolute',
        right: 12,
        top: 12,
        background: 'var(--mm-chrome-panel)',
        border: '1px solid var(--mm-chrome-border)',
        borderRadius: 8,
        padding: '10px 12px',
        boxShadow: '0 4px 16px rgba(15,23,42,0.28)',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 12,
        color: 'var(--mm-chrome-fg)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 210,
        maxWidth: 250,
        overflow: 'visible',
      }}
    >
      <CollapsibleSection title="Legend">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {legendRows.map((row) => (
            <ToggleRow key={row.label} row={row} />
          ))}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Overlays" topBorder>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <ToggleRow
            row={{
              label: 'Permits (approved)',
              swatch: 'ring',
              color: '#3B82F6',
              checked: permitGlowVisible,
              onChange: onPermitGlow,
            }}
          />
          <ToggleRow
            row={{
              label: 'Permits (submitted)',
              swatch: 'ring',
              color: '#14B8A6',
              checked: submittedGlowVisible,
              onChange: onSubmittedGlow,
            }}
          />
          <ToggleRow
            row={{
              label: 'Active rigs',
              swatch: 'dot',
              color: '#DC2626',
              checked: rigsVisible,
              onChange: onRigs,
            }}
          />
          <ToggleRow
            row={{
              label: 'Bold tract fills',
              swatch: 'fill',
              color: '#94A3B8',
              checked: boldTracts,
              onChange: onBoldTracts,
            }}
          />
          <ToggleRow
            row={{
              label: 'Wells only (hide tract fill)',
              swatch: 'line',
              color: '#0f172a',
              checked: wellsOnly,
              onChange: onWellsOnly,
            }}
          />
          <ToggleRow
            row={{
              label: 'Wells & laterals',
              swatch: 'line',
              color: '#EA580C',
              checked: wellsVisible,
              onChange: onWells,
            }}
          />
          {wellsVisible && (
            <div style={{ marginLeft: 22 }}>
              <ToggleRow
                row={{
                  label: 'Color by operator',
                  swatch: 'dot',
                  color: '#7C3AED',
                  checked: wellsByOperator,
                  onChange: onWellsByOperator,
                }}
              />
            </div>
          )}
        </div>
        <div
          style={{
            marginTop: 6,
            marginLeft: 22,
            fontSize: 10.5,
            color: 'var(--mm-chrome-muted)',
            lineHeight: 1.35,
          }}
        >
          Tract fill: color = development status, depth = producing-well
          density (heat). Tract border: color = top operator (see key).
          Lines = laterals with heel→toe arrows; blue halo = permit approved
          (90d); teal halo = permit filed; red dot = active rig.
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Operator (tract border)" topBorder>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[
            ['Diamondback', '#2563EB'],
            ['Pioneer / ExxonMobil / XTO', '#DC2626'],
            ['Permian Resources', '#7C3AED'],
            ['Ovintiv', '#0D9488'],
            ['Apache', '#EA580C'],
            ['SM Energy', '#CA8A04'],
            ['Endeavor', '#DB2777'],
            ['COG / Concho / ConocoPhillips', '#4338CA'],
            ['Occidental / Oxy', '#059669'],
            ['Birch', '#92400E'],
            ['Other / none', 'rgba(0,0,0,0.38)'],
          ].map(([label, color]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 16, height: 3, borderRadius: 2, background: color, flexShrink: 0 }} />
              <span style={{ color: 'var(--mm-chrome-fg)' }}>{label}</span>
            </div>
          ))}
        </div>
      </CollapsibleSection>

      {wellsVisible && (
        <CollapsibleSection title="Well status" topBorder>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {['producing', 'duc', 'shut_in', 'injection', 'permitted', 'vertical'].map(
              (k) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span
                    style={{
                      width: 16,
                      height: 3,
                      borderRadius: 2,
                      background: WELL_KIND_COLORS[k],
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: 'var(--mm-chrome-fg)' }}>{WELL_KIND_LABEL[k]}</span>
                </div>
              ),
            )}
          </div>
        </CollapsibleSection>
      )}

      {onOperatorKeysChange && (
        <CollapsibleSection title="Operator" topBorder>
          <OperatorMultiSelect
            options={operatorOptions}
            selectedKeys={selectedOperatorKeys}
            onChange={onOperatorKeysChange}
            matchCount={operatorMatchTractCount}
          />
        </CollapsibleSection>
      )}
    </div>
  )
}

// Collapsible panel section — default open, click the header to toggle.
function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  topBorder = false,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  topBorder?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={topBorder ? { borderTop: '1px solid var(--mm-chrome-border)', paddingTop: 8 } : undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          ...sectionHeadingStyle,
          marginBottom: open ? 6 : 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span
          style={{
            fontSize: 9,
            lineHeight: 1,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s ease',
          }}
        >
          ▶
        </span>
      </button>
      {open && children}
    </div>
  )
}

const sectionHeadingStyle: React.CSSProperties = {
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: 'var(--mm-chrome-muted)',
  fontSize: 10,
  marginBottom: 6,
}

function ToggleRow({
  row,
}: {
  row: {
    label: string
    swatch: 'fill' | 'dot' | 'ring' | 'line'
    color: string
    checked: boolean
    onChange: (v: boolean) => void
  }
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        userSelect: 'none',
        fontSize: 12.5,
      }}
    >
      <input
        type="checkbox"
        checked={row.checked}
        onChange={(e) => row.onChange(e.target.checked)}
        style={{ margin: 0, accentColor: row.color, cursor: 'pointer', width: 14, height: 14 }}
      />
      <span
        style={{
          width: 14,
          height: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {row.swatch === 'fill' ? (
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              background: row.color,
              border: '1px solid rgba(15,23,42,0.25)',
              opacity: row.checked ? 1 : 0.35,
            }}
          />
        ) : row.swatch === 'ring' ? (
          // Blue-glow permit swatch — hollow rectangle with a thick
          // colored border that mimics the tract-outline halo on the
          // map.
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 3,
              background: 'transparent',
              border: `2.5px solid ${row.color}`,
              boxShadow: `0 0 6px ${row.color}80`,
              opacity: row.checked ? 1 : 0.35,
            }}
          />
        ) : row.swatch === 'line' ? (
          <span
            style={{
              width: 14,
              height: 3,
              borderRadius: 2,
              background: row.color,
              opacity: row.checked ? 1 : 0.35,
            }}
          />
        ) : (
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: row.color,
              border: '1.5px solid #ffffff',
              boxShadow: '0 0 0 1px rgba(15,23,42,0.35)',
              opacity: row.checked ? 1 : 0.35,
            }}
          />
        )}
      </span>
      <span style={{ color: row.checked ? 'var(--mm-chrome-fg)' : 'var(--mm-chrome-muted)' }}>
        {row.label}
      </span>
    </label>
  )
}

// (ProductionStatusLegend removed — its role has been merged into
// LayerTogglePanel above so the swatches double as toggle controls.)
