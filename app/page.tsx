'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import dynamic from 'next/dynamic'

// recharts is no longer imported here: the tract sidebar's per-tract line
// chart (PRODUCTION HISTORY) was removed in favor of the NEW PERMITS
// dropdown. If a future revision brings a chart back it should re-import
// only what it uses.

import { supabase } from '@/lib/supabase'
import AppLogo from '@/app/components/AppLogo'
import { identifyUser, trackEvent } from '@/lib/posthog'
import { isPlatformOwner } from '@/lib/team'
import { getWorkspaceContext } from '@/lib/workspace'
import ThemeToggle from '@/app/components/ThemeToggle'
import {
  bareAbstract,
  permitBestDate,
  permitMatchesTractLegal,
  permitMatchesTractWells,
} from '@/lib/permit-match'
import { COUNTIES } from '@/lib/counties'
import {
  abstractsMatchingOperators,
  collectOperatorOptions,
  operatorMatchesAny,
  operatorRoot,
} from '@/lib/operator-filter'
import {
  applyOwnerOverride,
  deleteOwnerOverride,
  fetchOwnerOverrides,
  isHiddenOverride,
  mirrorOverrideToDeal,
  pickOwnerOverride,
  upsertOwnerOverride,
  type OwnerOverride,
} from '@/lib/owner-overrides'
import type { OwnerDetailsPatch } from '@/app/components/OwnerDrawer'

import OwnerDrawer from './components/OwnerDrawer'
import MarketPricesWidget from './components/MarketPricesWidget'
import BasinActivityWidget from './components/BasinActivityWidget'
import PermitsNavLink from './components/PermitsNavLink'
import ProductTour, { TOUR_EVENT, TOUR_ADVANCE_EVENT, type TourStep } from './components/ProductTour'
import { useActivityRefreshTick } from '@/lib/use-activity-refresh'
const MineralMap = dynamic(() => import('./components/Map'), { ssr: false })

// Single interactive product tour for newcomers. Steps anchor to
// [data-tour=...] elements; anchor-less steps render centered. Some steps
// are action-gated (awaitId) — the tour waits for the user to click a
// county / tract before advancing and explaining what just appeared.
const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to Mineral Map',
    body: 'The complete mineral-rights prospecting platform for the Permian Basin — every owner mapped and ready to contact. This quick tour walks through it, and you click along as you go.',
    placement: 'center',
  },
  {
    selector: '[data-tour="global-search"]',
    title: 'Search anything',
    body: "One box searches it all — type a county, a tract or abstract number, or an owner's name and jump straight there.",
    placement: 'bottom',
  },
  {
    selector: '[data-tour="map"]',
    title: 'Open a county',
    body: 'The map starts zoomed out over the Permian Basin. Click any county to dive in — go ahead and pick one now.',
    placement: 'center',
    awaitId: 'county',
    actionHint: 'Click a county on the map to continue',
    satisfied: (c) => c.mapLevel === 'tract',
  },
  {
    selector: '[data-tour="layer-legend"]',
    title: 'Legend & overlays',
    body: "Now that you're inside a county, this panel controls the map. The Legend colors each tract by development status — PDP (producing today), DUC, infill, and true PUD. Overlays layer on wells, drilling permits, and development blobs, and Well status explains the well-line colors.",
    placement: 'left',
  },
  {
    selector: '[data-tour="map"]',
    title: 'Open a tract',
    body: 'Each colored shape is a survey abstract. Click one to pull up every fractional mineral owner on it.',
    placement: 'center',
    awaitId: 'tract',
    actionHint: 'Click a tract on the map to continue',
    satisfied: (c) => !!c.tractSelected,
  },
  {
    selector: '[data-tour="owner-panel"]',
    title: 'Owners & outreach',
    body: "This is the full owner list for the tract. Sort or search it, open a row to see an owner's holdings across every county, skip-trace for phone and email, or add them straight to your CRM pipeline.",
    placement: 'right',
  },
  {
    selector: '[data-tour="nav-menu"]',
    title: 'Permits & pipeline',
    body: 'Open this menu anytime for recent drilling permits and your CRM pipeline — track contacts, reminders, notes, and offers.',
    placement: 'bottom',
  },
  {
    title: "You're ready to prospect",
    body: 'Start with any tract that has an active permit or PDP well — those are your best leads. You can replay this tour anytime from the ? button.',
    placement: 'center',
  },
]

// Permian counties whose data hasn't shipped yet. Rendered in
// the "All Counties" sidebar under a COMING SOON section so
// prospective users see the full basin roadmap. Names match the
// UPCOMING_COUNTIES list in app/components/Map.tsx.
const UPCOMING_PERMIAN_COUNTIES = [
  'Glasscock County, TX',
  'Crane County, TX',
  'Pecos County, TX',
  'Reeves County, TX',
]

type TractOwner = {
  id?: string
  owner_name: string
  display_name?: string | null
  propensity_score: number
  operator_name?: string
  mailing_city?: string
  mailing_state?: string
  mailing_zip?: string
  address_1?: string
  mailing_address?: string
  out_of_state?: boolean
  motivated?: boolean
  acreage?: number
  ownership_pct?: number
  decimal_interest?: number
  interest_type?: string
  prod_cumulative_sum_oil?: number
  phone?: string
  email?: string
  rrc_lease_id?: string | number | null
  sptb_code?: string | null
}

type TractSelection = {
  abstract_label?: string
  level1_sur?: string
  owner_count?: number
  top_operator?: string
  owners_json?: string
  max_propensity_score?: number
  ABSTRACT_L?: string
  LEVEL1_SUR?: string
  field_name?: string
  well_status?: string
  first_date?: string
  est_lease_expiration?: string
  prod_cumulative_sum_oil?: number
  first_6_month_oil?: number
  first_12_month_oil?: number
  first_24_month_oil?: number
  first_60_month_oil?: number
  horizontal_well_count?: number
  vertical_well_count?: number
  SHAPE_AREA?: number
  surv_name?: string
  block?: string
  surv_sect?: string
  desc_?: string
  level3_sur?: string
  Surv_Name?: string
  Block?: string
  Surv_Sect?: string
  TEXTSTRING?: string
  LEVEL3_SUR?: string
  NAME?: string
  DESC_?: string
  geometry?: GeoJSON.Geometry
}

type ProductionStatus = 'pdp' | 'pud' | 'new_permit' | 'pending_permit' | 'none'

type TractRecord = {
  abstract_label: string
  level1_sur: string
  owner_count: number
  top_operator: string
  max_propensity_score: number
  owners_json: string
  field_name?: string
  well_status?: string
  first_date?: string
  est_lease_expiration?: string
  prod_cumulative_sum_oil?: number
  first_6_month_oil?: number
  first_12_month_oil?: number
  first_24_month_oil?: number
  first_60_month_oil?: number
  horizontal_well_count?: number
  vertical_well_count?: number
  // Written by scripts/add_production_status.py into the slim map GeoJSON.
  // Drives the sidebar activity badges and the top-tracts sort order.
  production_status?: ProductionStatus
  well_count?: number
  pdp_well_count?: number
  pud_well_count?: number
  permit_count?: number
  SHAPE_AREA?: number
  surv_name?: string
  block?: string
  surv_sect?: string
  desc_?: string
  level3_sur?: string
}

type PipelineTag = 'prospect' | 'hot' | 'nurture' | 'not_interested'
type SkipTraceResult = {
  ownerName: string
  phone: string | null
  email: string | null
  dealId: string | null
  cached?: boolean
}

type OwnerSearchResult = {
  owner_name: string
  mailing_city?: string | null
  mailing_state?: string | null
  propensity_score?: number | null
  rrc_lease_id?: string | number | null
  operator_name?: string | null
  acreage?: number | null
  leaseCount?: number
  countyId?: CountyKey
  countyName?: string
}

type WellSummary = {
  lease_name?: string | null
  operator_name?: string | null
  well_type?: string | null
  latitude?: number | null
  longitude?: number | null
  rrc_lease_id?: string | null
  oil_gas_code?: string | null
  // Populated when the tract's wells are matched by geometry against the
  // rendered wells GeoJSON (grid + abstract counties alike).
  api_number?: string | null
  kind?: string | null
}

// Well-status kind → short badge label + color. Mirrors the map legend in
// app/components/Map.tsx so the "Wells in this tract" list reads the same as
// what's drawn on the map.
const WELL_KIND_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  producing: { label: 'PDP', color: '#166534', bg: '#DCFCE7', border: '#86EFAC' },
  duc: { label: 'DUC', color: '#6B21A8', bg: '#F3E8FF', border: '#D8B4FE' },
  shut_in: { label: 'SHUT-IN', color: '#92400E', bg: '#FEF3C7', border: '#FDE68A' },
  injection: { label: 'INJ', color: '#0F766E', bg: '#CCFBF1', border: '#5EEAD4' },
  permitted: { label: 'PERMIT', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  // Legacy "drilled, status unknown" laterals are DUCs.
  horizontal: { label: 'DUC', color: '#6B21A8', bg: '#F3E8FF', border: '#D8B4FE' },
  vertical: { label: 'WELL', color: '#4B5563', bg: '#F9FAFB', border: '#E5E7EB' },
}

// ── Geometry helpers for matching wells to a tract polygon (same result as
// the map overlay, which draws wells by their shapefile geometry). ──
type LngLat = [number, number]

function pointInRing(pt: LngLat, ring: number[][]): boolean {
  // Ray-casting; ring is an array of [lng, lat].
  let inside = false
  const [x, y] = pt
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pointInPolygonGeom(pt: LngLat, geom: GeoJSON.Geometry): boolean {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates as number[][][]
    if (rings.length === 0 || !pointInRing(pt, rings[0])) return false
    // Exclude holes.
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(pt, rings[h])) return false
    }
    return true
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates as number[][][][]
    return polys.some((rings) => {
      if (rings.length === 0 || !pointInRing(pt, rings[0])) return false
      for (let h = 1; h < rings.length; h++) {
        if (pointInRing(pt, rings[h])) return false
      }
      return true
    })
  }
  return false
}

function geomBbox(geom: GeoJSON.Geometry): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const visit = (coords: unknown) => {
    if (typeof (coords as number[])[0] === 'number' && typeof (coords as number[])[1] === 'number' && !Array.isArray((coords as number[])[0])) {
      const [x, y] = coords as number[]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      return
    }
    for (const c of coords as unknown[]) visit(c)
  }
  if ('coordinates' in geom) visit((geom as { coordinates: unknown }).coordinates)
  return [minX, minY, maxX, maxY]
}

// Outer-ring edges of a polygon/multipolygon, as [start, end] segments.
// Used to catch laterals that cross a tract edge without landing a vertex
// inside it (a vertex-only test undercounts those clip-through wells).
function polygonOuterEdges(geom: GeoJSON.Geometry): [LngLat, LngLat][] {
  const edges: [LngLat, LngLat][] = []
  const addRing = (ring: number[][]) => {
    for (let i = 0; i < ring.length - 1; i++) {
      edges.push([ring[i] as LngLat, ring[i + 1] as LngLat])
    }
  }
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates as number[][][]
    if (rings[0]) addRing(rings[0])
  } else if (geom.type === 'MultiPolygon') {
    for (const rings of geom.coordinates as number[][][][]) {
      if (rings[0]) addRing(rings[0])
    }
  }
  return edges
}

function segmentsIntersect(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const d = (a: LngLat, b: LngLat, c: LngLat) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const d1 = d(p3, p4, p1)
  const d2 = d(p3, p4, p2)
  const d3 = d(p1, p2, p3)
  const d4 = d(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

// Collect coordinates from a well feature's geometry.
function wellCoords(geom: GeoJSON.Geometry): LngLat[] {
  if (geom.type === 'Point') return [geom.coordinates as LngLat]
  if (geom.type === 'LineString') return geom.coordinates as LngLat[]
  if (geom.type === 'MultiLineString') return (geom.coordinates as number[][][]).flat() as LngLat[]
  if (geom.type === 'MultiPoint') return geom.coordinates as LngLat[]
  return []
}

// True when any part of a well (point or lateral) falls on the tract —
// either a vertex inside the polygon, or (for laterals) a segment that
// crosses a tract edge. Matches what the map draws.
function wellHitsTract(
  wellGeom: GeoJSON.Geometry,
  tractGeom: GeoJSON.Geometry,
  tractBbox: [number, number, number, number],
  tractEdges: [LngLat, LngLat][],
): boolean {
  const [minX, minY, maxX, maxY] = tractBbox
  const coords = wellCoords(wellGeom)
  // Fast path: any vertex inside the polygon.
  for (const [x, y] of coords) {
    if (x < minX || x > maxX || y < minY || y > maxY) continue
    if (pointInPolygonGeom([x, y], tractGeom)) return true
  }
  // Laterals may clip through a corner without an interior vertex — test
  // each well segment against the tract's edges.
  if (coords.length >= 2) {
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]
      const b = coords[i + 1]
      for (const [c, d] of tractEdges) {
        if (segmentsIntersect(a, b, c, d)) return true
      }
    }
  }
  return false
}

export type DevelopmentStatus =
  | 'PDP'
  | 'PUD_DUC'
  | 'PUD_PERMITTED'
  | 'PUD_INFILL'
  | 'LEASING_ACTIVE'
  | 'FRONTIER'

export type DevStatusSignal = {
  permits?: Array<{
    permit_number?: string | null
    api?: string | null
    operator?: string | null
    lease?: string | null
    status?: string | null
    approved_date?: string | null
    filed_date?: string | null
    spud_date?: string | null
    completion_date?: string | null
  }>
  ducs?: Array<{
    api?: string | null
    operator?: string | null
    lease?: string | null
    spud_date?: string | null
    status?: string | null
    source?: string | null
  }>
  adjacent_permits?: Array<{ operator?: string | null; count?: number }>
  adjacent_permit_count?: number
  adjacent_pdp_count?: number
  adjacent_pdp_operators?: Array<{ operator?: string | null; count?: number }>
  operator_committed?: boolean
  operator_program_hit?: boolean
  infill_gaps?: number
  leases?: Array<{
    lessee?: string | null
    lessor?: string | null
    memo_date?: string | null
    filed_date?: string | null
    source_url?: string | null
  }>
}

export type DevStatusRow = {
  development_status: DevelopmentStatus
  pud_score: number
  signal_detail: DevStatusSignal
  last_computed?: string
}

type PermitRow = {
  id: number
  permit_number?: string | null
  api_number?: string | null
  operator_name?: string | null
  lease_name?: string | null
  latitude?: number | null
  longitude?: number | null
  permit_type?: string | null
  status?: string | null
  filed_date?: string | null
  approved_date?: string | null
  // Stamped by compute_development_status.py when it assigns a permit
  // to a tract (PIP or declared). The /permits page trusts this as
  // tier-2 matching; the map sidebar must too — PIP alone misses
  // permits whose surface lat/lon sits just outside the polygon.
  abstract_number?: string | null
}

type HowardWellPoint = {
  latitude: number
  longitude: number
  well_type?: string | null
  oil_gas_code?: string | null
}

type MapFocusTarget = {
  leaseId: string | null
  ownerName: string
  nonce: number
}

type CountyKey = keyof typeof COUNTIES

const COUNTY_ORDER: CountyKey[] = Object.keys(COUNTIES) as CountyKey[]
const TEXAS_OVERVIEW_CENTER: [number, number] = [-99.5, 31.0]
const TEXAS_OVERVIEW_ZOOM = 5.5

// Global-search dropdown styles (shared by the county / tract / owner groups).
const SEARCH_GROUP_HEADING: CSSProperties = {
  padding: '8px 14px 4px',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: 'var(--mm-chrome-muted)',
  background: 'var(--mm-chrome-surface)',
  borderTop: '1px solid var(--mm-chrome-border)',
}
const SEARCH_KIND_BADGE: CSSProperties = {
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  color: 'var(--mm-chrome-muted)',
  background: 'var(--mm-chrome-muted-fill)',
  border: '1px solid var(--mm-chrome-border)',
  borderRadius: 4,
  padding: '2px 5px',
}

// Palette mirrors PRODUCTION_STATUS_FILL in app/components/Map.tsx so the
// sidebar tract badge visually matches the parcel color on the map.
const PRODUCTION_STATUS_LABEL: Record<string, string> = {
  pdp: 'PDP',
  pud: 'PUD',
  new_permit: 'New Permit',
  pending_permit: 'Pending Permit',
  none: 'No activity',
}
// Palette mirrors PRODUCTION_STATUS_FILL in app/components/Map.tsx:
//   PDP -> yellow, PUD -> green, permits -> neutral fill + blue dot.
// The sidebar badge uses the tint (`bg`) as the pill background and the
// darker `border` for the outline so the badge reads as the same visual
// object as the parcel on the map.
const PRODUCTION_STATUS_COLOR: Record<string, { fg: string; bg: string; border: string }> = {
  pdp:            { fg: '#854D0E', bg: '#FEF9C3', border: '#FACC15' }, // yellow
  pud:            { fg: '#14532D', bg: '#DCFCE7', border: '#16A34A' }, // green
  new_permit:     { fg: '#1D4ED8', bg: '#DBEAFE', border: '#2563EB' }, // blue-dot tint
  pending_permit: { fg: '#1E40AF', bg: '#EFF6FF', border: '#93C5FD' },
  none:           { fg: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB' },
}

function TractActivityBadge({
  tract,
}: {
  tract: {
    production_status?: string
    well_count?: number
    pdp_well_count?: number
    pud_well_count?: number
    permit_count?: number
  }
}) {
  const status = (tract.production_status ?? 'none') as keyof typeof PRODUCTION_STATUS_COLOR
  const swatch = PRODUCTION_STATUS_COLOR[status] ?? PRODUCTION_STATUS_COLOR.none
  const label = PRODUCTION_STATUS_LABEL[status] ?? 'No activity'
  const wells = Number(tract.well_count ?? 0)
  const permits = Number(tract.permit_count ?? 0)
  const detail = wells > 0
    ? `${wells} well${wells === 1 ? '' : 's'}`
    : permits > 0
      ? `${permits} permit${permits === 1 ? '' : 's'}`
      : null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 2,
      }}
    >
      <span
        style={{
          background: swatch.bg,
          border: `1px solid ${swatch.border}`,
          borderRadius: 999,
          padding: '2px 8px',
          color: swatch.fg,
          fontFamily: 'Geist, Inter, system-ui, sans-serif',
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {detail && (
        <span style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
          {detail}
        </span>
      )}
    </div>
  )
}

// Ray-casting point-in-polygon that works for both Polygon and MultiPolygon.
// The New Permits dropdown filters the county's permit list to just those
// whose lat/lon falls inside the currently-selected tract; we do this
// client-side to avoid an extra Supabase round-trip on every tract click.
const isPointInRing = (
  lon: number,
  lat: number,
  ring: readonly (readonly number[])[],
): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0])
    const yi = Number(ring[i][1])
    const xj = Number(ring[j][0])
    const yj = Number(ring[j][1])
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

/** Rough centroid for deep-link zoom when Map parcel match fails. */
const geometryCenter = (
  geometry: GeoJSON.Geometry | null | undefined,
): [number, number] | null => {
  if (!geometry) return null
  const rings: number[][][] =
    geometry.type === 'Polygon'
      ? (geometry.coordinates as unknown as number[][][])
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as unknown as number[][][][]).flat()
        : []
  const ring = rings[0]
  if (!ring || ring.length === 0) return null
  let sumLon = 0
  let sumLat = 0
  let n = 0
  for (const coord of ring) {
    const lon = Number(coord[0])
    const lat = Number(coord[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    sumLon += lon
    sumLat += lat
    n += 1
  }
  if (n === 0) return null
  return [sumLon / n, sumLat / n]
}

const isPointInGeometry = (
  lon: number,
  lat: number,
  geometry: GeoJSON.Geometry | null | undefined,
): boolean => {
  if (!geometry) return false
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as unknown as number[][][]
    if (rings.length === 0) return false
    if (!isPointInRing(lon, lat, rings[0])) return false
    for (let i = 1; i < rings.length; i += 1) {
      if (isPointInRing(lon, lat, rings[i])) return false
    }
    return true
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates as unknown as number[][][][]
    for (const poly of polys) {
      if (poly.length === 0) continue
      if (!isPointInRing(lon, lat, poly[0])) continue
      let insideHole = false
      for (let i = 1; i < poly.length; i += 1) {
        if (isPointInRing(lon, lat, poly[i])) { insideHole = true; break }
      }
      if (!insideHole) return true
    }
  }
  return false
}

const permitDateKey = (permit: PermitRow): string =>
  String(permit.filed_date ?? permit.approved_date ?? '')

const permitSortByFiledDesc = (a: PermitRow, b: PermitRow): number => {
  const aKey = permitDateKey(a)
  const bKey = permitDateKey(b)
  if (aKey === bKey) return (b.id ?? 0) - (a.id ?? 0)
  return bKey.localeCompare(aKey)
}

// Build the compact survey/legal description string used under each lead's
// name for Howard / Martin (T&P RR coordinate system).
//   "T1N BLK 35 SEC 36 A-1013"
// Pulls township from the embedded "T?N/T?S" token in the tract's `block`
// field (Howard stores e.g. "31 T2N", Martin stores e.g. "35 T1N"), the
// block number from the remainder, the section from `surv_sect` (Howard's
// Surv_Sect column) or `level3_sur` (Martin's LEVEL3_SUR column), and the
// abstract label from `abstract_label`. Returns "" when the tract isn't a
// T&P-style row (e.g. Martin CSL leagues, Gonzales) so the caller can hide
// the line entirely.
const buildLegalDescription = (tract: TractSelection | null | undefined): string => {
  if (!tract) return ''
  const block = String(tract.block ?? tract.Block ?? '').trim()
  const sectionRaw = String(
    tract.surv_sect ?? tract.Surv_Sect ?? tract.level3_sur ?? tract.LEVEL3_SUR ?? ''
  ).trim()
  const abstract = String(tract.abstract_label ?? tract.ABSTRACT_L ?? '').trim()
  const surveyName = String(
    tract.surv_name ?? tract.Surv_Name ?? tract.level1_sur ?? tract.LEVEL1_SUR ?? tract.desc_ ?? tract.DESC_ ?? ''
  ).trim()

  // Gonzales TEXTSTRING reuses the abstract label as a section descriptor;
  // drop it so we don't render "SEC A-160 A-160".
  const section = sectionRaw && sectionRaw !== abstract ? sectionRaw : ''

  const townshipMatch = block.match(/T\d+[NS]/i)
  const township = townshipMatch ? townshipMatch[0].toUpperCase() : ''
  const blockNum = township
    ? block.replace(townshipMatch![0], '').trim()
    : block

  // T&P counties (Howard, most of Martin) — full coordinate line.
  if (township && blockNum && section && abstract) {
    return `${township} BLK ${blockNum} SEC ${section} ${abstract}`
  }
  // Non-T&P shape (Gonzales, Martin CSL leagues, older Howard rows) —
  // fall back to survey name + abstract label so the drawer always has
  // something to render. Mirrors scripts/build_map_geojson.py's
  // build_legal_desc() so the map's baked-in `legal_desc` prop and the
  // client-side derivation stay in sync.
  if (surveyName && abstract) return `${surveyName} ${abstract}`
  return abstract || ''
}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const normalizeLeaseId = (value: unknown): string =>
  String(value ?? '').replace(/^0+/, '').trim()

const ownerRowDomId = (ownerName: string): string =>
  `owner-${ownerName.trim().replace(/\s+/g, '-')}`

const parseOwners = (ownersJson: unknown): TractOwner[] => {
  if (Array.isArray(ownersJson)) return ownersJson as TractOwner[]
  if (typeof ownersJson !== 'string') return []
  try {
    const parsed = JSON.parse(ownersJson) as unknown
    return Array.isArray(parsed) ? (parsed as TractOwner[]) : []
  } catch {
    return []
  }
}

const classifyOwner = (name: string): 'trust' | 'company' | 'individual' => {
  const n = (name ?? '').toUpperCase()
  if (
    n.includes('TRUST') || n.includes('ESTATE') ||
    n.includes('LIVING') || n.includes('TESTAMENTARY') ||
    n.includes('IRREVOCABLE') || n.includes('REVOCABLE')
  ) return 'trust'
  if (
    n.includes('LLC') || n.includes('LP') || n.includes('INC') ||
    n.includes('CORP') || n.includes('LTD') || n.includes('COMPANY') ||
    n.includes('CO.') || n.includes('PARTNERS') || n.includes('ENERGY') ||
    n.includes('MINERALS') || n.includes('RESOURCES') || n.includes('ROYALTY') ||
    n.includes('HOLDINGS') || n.includes('PROPERTIES') || n.includes('VENTURES')
  ) return 'company'
  return 'individual'
}

const SQM_PER_ACRE = 4046.86

const getTractGrossAcres = (tractProperties?: TractSelection | null): number => {
  const shapeArea = Number(tractProperties?.SHAPE_AREA ?? 0)
  if (shapeArea > 0) return shapeArea / SQM_PER_ACRE
  return 0
}

const getOwnershipPctValue = (
  owner: TractOwner,
  ownershipPctIsDecimal: boolean
): number => {
  const raw = Number(owner.ownership_pct ?? 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return ownershipPctIsDecimal ? raw * 100 : raw
}

const getOwnershipDecimalValue = (
  owner: TractOwner,
  ownershipPctIsDecimal: boolean
): number => {
  const pct = getOwnershipPctValue(owner, ownershipPctIsDecimal)
  return Number(owner.decimal_interest ?? 0) || (pct / 100)
}

const getNRA = (
  owner: TractOwner,
  tractProperties: TractSelection | null | undefined,
  countyConfig: { ownershipPctIsDecimal: boolean; nriCode: string }
): number | null => {
  if (owner.sptb_code === countyConfig.nriCode && countyConfig.nriCode !== '') return null
  const decimalInterest = getOwnershipDecimalValue(owner, countyConfig.ownershipPctIsDecimal)
  if (!decimalInterest || decimalInterest <= 0) return null

  let grossAcres = Number(owner.acreage ?? 0)
  if (!grossAcres && tractProperties) {
    grossAcres = getTractGrossAcres(tractProperties)
  }
  if (!grossAcres) return null

  return grossAcres * decimalInterest
}

const estimateMonthlyRoyalty = (
  owner: TractOwner,
  selectedTract: TractSelection | null,
  ownershipPctIsDecimal: boolean
): string | null => {
  const decimalInterest = getOwnershipDecimalValue(owner, ownershipPctIsDecimal)
  if (!decimalInterest || decimalInterest <= 0) return null

  let grossAcres = Number(owner.acreage ?? 0)
  if (!grossAcres && selectedTract) {
    grossAcres = getTractGrossAcres(selectedTract)
  }
  if (!grossAcres) return null

  const ownerCount = Number(selectedTract?.owner_count ?? 1)
  const estimatedWells = Math.max(1, Math.round(ownerCount / 150))
  const cumOil = Number(selectedTract?.prod_cumulative_sum_oil ?? 0)
  const perWellMonthly = Math.min(cumOil / estimatedWells / 60, 3000)
  const monthlyRoyalty = perWellMonthly * decimalInterest * 70 * 0.25

  if (monthlyRoyalty < 0.5) return null
  if (monthlyRoyalty < 1000) return `~$${Math.round(monthlyRoyalty)}/mo`
  return `~$${(monthlyRoyalty / 1000).toFixed(1)}k/mo`
}

export default function Home() {
  // Same cadence as the Permits nav badge — bumps every 5 min, on
  // window focus, and when /api/permits/latest reports a newer date.
  // Drives soft refetch of tract_development_status (halos), sidebar
  // New Permits, and the Map rig layer.
  const activityRefreshTick = useActivityRefreshTick()
  const [selectedCounty, setSelectedCounty] = useState<CountyKey>('martin')
  const mapFlyToRef = useRef<((center: [number, number], zoom: number) => void) | null>(null)
  // Once the map has mounted once, county switches must NOT flip
  // `loading` back to true — that unmounts <MineralMap>, nulls
  // mapFlyToRef, and kills Martin↔Howard flyTo while the geojson reloads.
  const mapHasMountedRef = useRef(false)
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  )
  const [mapLevel, setMapLevel] = useState<'county' | 'tract'>('county')
  const [tracts, setTracts] = useState<TractRecord[]>([])
  // Pending focus target: when the URL carries an `abstract` param,
  // stash it here. Once the county's tracts finish loading below,
  // a one-shot useEffect resolves this to a TractSelection and
  // fires setSelected() + clears the pending state.
  const [pendingUrlAbstract, setPendingUrlAbstract] = useState<string | null>(null)
  const [pendingUrlPoint, setPendingUrlPoint] = useState<{ lat: number; lon: number } | null>(null)
  const [pendingUrlOwner, setPendingUrlOwner] = useState<string | null>(null)
  // Deep-link zoom can resolve before Mapbox finishes init — queue a
  // flyTo and retry until mapFlyToRef is wired.
  const [pendingFlyTo, setPendingFlyTo] = useState<{
    center: [number, number]
    zoom: number
  } | null>(null)

  // Explicit county camera — do NOT auto-fly from a selectedCounty
  // effect. That raced deep-link fitBounds and also fired while the map
  // was unmounted during geojson reload. Call this from every UI path
  // that enters / switches a county.
  const flyToCountyView = useCallback((countyKey: CountyKey) => {
    const target = COUNTIES[countyKey]
    if (!target) return
    let attempts = 0
    const tryFlyTo = () => {
      attempts += 1
      if (mapFlyToRef.current) {
        mapFlyToRef.current(target.mapCenter, target.mapZoom)
        return
      }
      // Only the map-not-ready case retries; the fly fires immediately once
      // the ref is wired so the swoop starts the instant a county is clicked.
      if (attempts < 40) setTimeout(tryFlyTo, 120)
    }
    tryFlyTo()
  }, [])

  useEffect(() => {
    if (!pendingFlyTo) return
    let tries = 0
    const tick = () => {
      tries += 1
      if (mapFlyToRef.current) {
        mapFlyToRef.current(pendingFlyTo.center, pendingFlyTo.zoom)
        setPendingFlyTo(null)
        return
      }
      if (tries > 50) setPendingFlyTo(null)
    }
    tick()
    const id = window.setInterval(tick, 100)
    return () => window.clearInterval(id)
  }, [pendingFlyTo])

  // Deep-link support from /permits, /pad-activity, etc:
  //   `/?county=<key>&abstract=<label>`
  //   `/?county=<key>&lat=<n>&lon=<n>`  (point-in-polygon → exact tract)
  //   optional `&owner=<name>` to highlight / expand that owner
  // Read the URL AFTER mount (not in useState factories) because
  // Next.js runs this client component through SSR first.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const urlCounty = params.get('county') as CountyKey | null
    const urlAbstractRaw = params.get('abstract') || ''
    const urlLat = Number(params.get('lat'))
    const urlLon = Number(params.get('lon'))
    const urlOwner = (params.get('owner') || '').trim()
    // Only trust a lat/lon deep-link when it's a plausible Texas coordinate.
    // Guards against a bad/half-zero point (Number(null) === 0) flying the
    // camera to Null Island / off the African coast.
    const validPoint =
      Number.isFinite(urlLat) && Number.isFinite(urlLon) &&
      urlLat >= 25 && urlLat <= 37 && urlLon >= -107 && urlLon <= -93
    const hasTractDeepLink = Boolean(urlAbstractRaw) || validPoint
    if (urlCounty && urlCounty in COUNTIES) {
      setSelectedCounty(urlCounty)
      setMapLevel('tract')
      // County-only URL → fly to county. Tract deep-links leave the
      // camera to the abstract/lat-lon resolver below.
      if (!hasTractDeepLink) flyToCountyView(urlCounty)
    }
    // Keep both when present: abstract selects the sidebar tract; lat/lon
    // guarantees a zoom even if the slim map geojson label doesn't match.
    if (urlAbstractRaw) {
      setPendingUrlAbstract(urlAbstractRaw.replace(/^A-\s*/i, '').trim())
    }
    if (validPoint) {
      setPendingUrlPoint({ lat: urlLat, lon: urlLon })
    }
    if (urlOwner) setPendingUrlOwner(urlOwner)
    // flyToCountyView is stable (empty deps)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Bare-abstract ("543") -> "T2N BLK 31 SEC 20 A-543" lookup, computed
  // from the same TractRecord[] the sidebar already loaded so the Leases
  // tab of the OwnerDrawer can render full legal descriptions per lease
  // without another network round-trip.
  const tractLegalDescLookup = useMemo(() => {
    const out: Record<string, string> = {}
    for (const t of tracts) {
      const label = String(t.abstract_label ?? '').trim()
      if (!label) continue
      const bare = label.replace(/^A-\s*/i, '').trim()
      if (!bare) continue
      const legal = buildLegalDescription(t as unknown as TractSelection)
      out[bare] = legal || `A-${bare}`
    }
    return out
  }, [tracts])
  const [selected, setSelected] = useState<TractSelection | null>(null)
  const [loading, setLoading] = useState(true)
  const [outOfStateOnly, setOutOfStateOnly] = useState(false)
  const [largeInterestOnly, setLargeInterestOnly] = useState(false)
  const [minNRA, setMinNRA] = useState<number>(0)
  // Sort model was previously score-based ('score' | 'interest' | 'nra').
  // Proprietary scoring was removed from the UI; owners are ranked
  // alphabetically by default and can be flipped to Z-A or sorted by
  // NMA (Net Mineral Acres = gross_acres × mineral_interest, the
  // number the platform actually computes; industry-standard NRA
  // would require a per-lease royalty rate we don't yet have).
  type OwnerSortKey = 'az' | 'za' | 'largest' | 'smallest'
  const [ownerSort, setOwnerSort] = useState<OwnerSortKey>('az')
  const [ownerTypeFilter, setOwnerTypeFilter] = useState<'all' | 'individual' | 'trust' | 'company'>('all')
  // Well-activity chip filter that replaced the score-based tier chips in
  // the bottom toolbar. Currently only recolors its own chip; the toolbar
  // comment near ActivityChip explains why it's not yet wired into Map.tsx
  // as a layer filter.
  const [activityFilter, setActivityFilter] = useState<'all' | 'pdp' | 'pud' | 'new_permit' | 'pending_permit'>('all')
  // CAD tax-roll operator clusters (entity listed against the lease / NRI).
  // Empty = no filter. Keys come from collectOperatorOptions().key.
  const [selectedOperatorKeys, setSelectedOperatorKeys] = useState<string[]>([])
  const [skipTracing, setSkipTracing] = useState<TractOwner | null>(null)
  const [skipTraceLoading, setSkipTraceLoading] = useState(false)
  const [skipTraceResult, setSkipTraceResult] = useState<SkipTraceResult | null>(null)
  const [pipelineCandidate, setPipelineCandidate] = useState<TractOwner | null>(null)
  const [pipelineTag, setPipelineTag] = useState<PipelineTag>('prospect')
  const [pipelineSaving, setPipelineSaving] = useState(false)
  const [pipelineOwners, setPipelineOwners] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [toastType, setToastType] = useState<'success' | 'error'>('success')
  const [navMenuOpen, setNavMenuOpen] = useState(false)
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null)
  // Owner detail drawer at the bottom of the viewport. When set, an
  // OwnerDrawer component slides up over the map area, showing all the
  // owner's leases, wells, and CRM actions.
  const [drawerOwner, setDrawerOwner] = useState<TractOwner | null>(null)
  // The tract label active at the moment the drawer opened, so the
  // drawer stays anchored to that tract even if the sidebar changes.
  const [drawerTractLabel, setDrawerTractLabel] = useState<string | null>(null)
  // Soft corrections / hides for CAD owners (does not mutate tax-roll tables).
  const [ownerOverrides, setOwnerOverrides] = useState<OwnerOverride[]>([])
  const [showHiddenOwners, setShowHiddenOwners] = useState(false)
  const [wellsExpanded, setWellsExpanded] = useState(false)
  const [tractWells, setTractWells] = useState<WellSummary[]>([])
  const [tractWellsLoaded, setTractWellsLoaded] = useState(false)
  const [tractWellsLoading, setTractWellsLoading] = useState(false)
  // Every permit filed against the currently-selected county, loaded once
  // per county switch. The sidebar's "New Permits" dropdown filters this
  // to the selected tract (abstract_number match and/or point-in-polygon)
  // when a tract is active; if no tract is selected, the same list
  // renders at the county overview level.
  const [countyPermits, setCountyPermits] = useState<PermitRow[]>([])
  const [countyPermitsLoading, setCountyPermitsLoading] = useState(false)
  const [permitsExpanded, setPermitsExpanded] = useState(true)
  // Per-county tract development lifecycle status from Ticket 1.3. Keyed on
  // the bare abstract number ('543', not 'A-543') so it lines up with
  // tract_development_status.abstract_number written by
  // scripts/compute_development_status.py.
  const [devStatusByAbstract, setDevStatusByAbstract] = useState<Record<string, DevStatusRow>>({})
  // Ticket 1.3 dev status for the currently-selected tract, if any.
  // Consumed by the sidebar's ⚡ badge and the OwnerDrawer's status
  // section. Same bare-abstract key convention as devStatusByAbstract.
  const selectedTractDevStatus = useMemo(() => {
    const key = String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '')
      .replace(/^A-\s*/i, '').trim()
    return key ? devStatusByAbstract[key] ?? null : null
  }, [selected, devStatusByAbstract])
  const [ownerWells, setOwnerWells] = useState<Record<string, WellSummary[]>>({})
  const [ownerWellsLoading, setOwnerWellsLoading] = useState<Record<string, boolean>>({})
  const [selectedTractGeometry, setSelectedTractGeometry] = useState<GeoJSON.Geometry | null>(null)
  // Abstract-label (bare, e.g. "543") -> geometry lookup. Populated once
  // per county load from the parcels GeoJSON. Used as a fallback source
  // for the selected tract's geometry when setSelected() was called
  // from a code path that doesn't propagate geometry (sidebar top-tracts
  // list, owner-tracts list, search result).
  const [tractGeometryByAbstract, setTractGeometryByAbstract] = useState<Record<string, GeoJSON.Geometry>>({})
  const [isMobile, setIsMobile] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<OwnerSearchResult[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const countySwitchHideTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const countySwitchClearTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasInitializedCountySwitchRef = useRef(false)
  const [highlightedOwner, setHighlightedOwner] = useState<string | null>(null)
  const [countySwitchLabel, setCountySwitchLabel] = useState<string | null>(null)
  const [countySwitchLabelVisible, setCountySwitchLabelVisible] = useState(false)
  // Kept for future map focus heuristics if we add lease-id filtering in Map.tsx.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [mapFocusTarget, setMapFocusTarget] = useState<MapFocusTarget | null>(null)
  const [ownerTracts, setOwnerTracts] = useState<TractSelection[]>([])
  const [ownerTractsName, setOwnerTractsName] = useState<string>('')
  const [ownerTractsLoading, setOwnerTractsLoading] = useState(false)
  const county = COUNTIES[selectedCounty]
  const countyRef = useRef(county)
  // Per-county wells GeoJSON (the same file the map draws) cached so the
  // "Wells in this tract" list can be matched by geometry — see
  // loadCountyWellsGeo / the tract-wells effect below.
  const wellsGeoCacheRef = useRef<Record<string, GeoJSON.FeatureCollection | null>>({})
  const ownershipTable = county.ownershipTable
  const countyLabel = mapLevel === 'county' ? 'All Counties' : county.displayName
  const countyBreakdown = county.breakdown
  // Live per-county stat counts fetched from Supabase. Replaces the
  // static county.stats values baked in lib/counties.ts, which
  // drifted out of date whenever we added a county or ran a fresh
  // scrape. Each county contributes six counts (owners, pdp, pud,
  // permits24mo, abstracts, wells); the whole grid loads in one
  // fan-out that finishes in ~200ms.
  type CountyLiveStats = {
    totalOwners: number | null
    pdpTracts:   number | null
    pudTracts:   number | null
    newPermits:  number | null
    abstracts:   number | null
  }
  const [liveCountyStats, setLiveCountyStats] = useState<Partial<Record<CountyKey, CountyLiveStats>>>({})

  useEffect(() => {
    let cancelled = false
    const cutoff = (() => {
      const d = new Date()
      d.setMonth(d.getMonth() - 24)
      return d.toISOString().slice(0, 10)
    })()

    const perCounty = async (countyId: CountyKey): Promise<[CountyKey, CountyLiveStats]> => {
      const cfg = COUNTIES[countyId]
      const empty: CountyLiveStats = {
        totalOwners: null, pdpTracts: null, pudTracts: null,
        newPermits: null, abstracts: null,
      }
      if (!cfg) return [countyId, empty]
      const table = cfg.ownershipTable
      const permitsTable = `${cfg.id}_permits`
      // `count: 'exact', head: true` gives us the count without pulling
      // rows. Note: RLS-blocked reads return `count = 0` with NO error
      // — PostgREST reports the count PostgreSQL saw after row-level
      // filtering, and RLS filters silently. So if a table has RLS on
      // but no policy for anon, the sidebar just shows 0 forever.
      // See supabase/migrations/20260716260000_allow_anon_read_mineral_ownership.sql.
      // The "Active wells" stat card was removed from the sidebar on
      // 2026-07-20 (user asked for it out — the county wells count
      // didn't drive any decisions and hit the RLS trap on Martin).
      const [owners, permits, pdp, pud, abstracts] = await Promise.all([
        // 'estimated' (planner stats for big tables, exact for small) — a
        // COUNT(*) exact on 200k–440k-row ownership rolls exceeds the
        // statement timeout, which surfaced as "Total owners: —".
        supabase.from(table).select('id', { count: 'estimated', head: true }),
        supabase.from(permitsTable).select('id', { count: 'exact', head: true })
          .gte('approved_date', cutoff),
        supabase.from('tract_development_status').select('abstract_number', { count: 'exact', head: true })
          .eq('county_id', cfg.id).eq('development_status', 'PDP'),
        supabase.from('tract_development_status').select('abstract_number', { count: 'exact', head: true })
          .eq('county_id', cfg.id).in('development_status', ['PUD_DUC', 'PUD_PERMITTED', 'PUD_INFILL']),
        supabase.from('tract_development_status').select('abstract_number', { count: 'exact', head: true })
          .eq('county_id', cfg.id),
      ])
      // Diagnostic logging for the sidebar. Two failure modes:
      //   1. .error is set — the query blew up (typo, network, etc).
      //   2. .count === 0 for a table we KNOW is populated — almost
      //      always an RLS policy missing for anon. Surface both to
      //      the console so the source of a suspicious zero is one
      //      click into DevTools away.
      const logIfSus = (label: string, res: { error: unknown; count: number | null }, populated: boolean) => {
        const err = (res.error as { message?: string } | null | undefined)?.message
        if (err) {
          console.warn(`[liveStats] ${countyId}.${label} query error:`, err)
        } else if (populated && (res.count ?? 0) === 0) {
          console.warn(`[liveStats] ${countyId}.${label} returned 0 — check RLS policy on the anon role for this table.`)
        }
      }
      // Howard + Martin are known-populated; the other 10 Permian
      // counties may legitimately show 0 for permits/ownership until
      // their data ships.
      const isPopulated = countyId === 'howard' || countyId === 'martin' || countyId === 'gonzales'
      logIfSus('totalOwners', owners, isPopulated)
      logIfSus('permits', permits, isPopulated)
      logIfSus('pdp', pdp, isPopulated)
      logIfSus('pud', pud, isPopulated)
      logIfSus('abstracts', abstracts, isPopulated)
      return [countyId, {
        totalOwners: owners.error ? null : (owners.count ?? 0),
        pdpTracts:   pdp.error    ? null : (pdp.count ?? 0),
        pudTracts:   pud.error    ? null : (pud.count ?? 0),
        newPermits:  permits.error ? null : (permits.count ?? 0),
        abstracts:   abstracts.error ? null : (abstracts.count ?? 0),
      }]
    }

    const countyIds = Object.keys(COUNTIES) as CountyKey[]
    void Promise.all(countyIds.map(perCounty)).then((entries) => {
      if (cancelled) return
      setLiveCountyStats(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  }, [])

  // combinedStats (sum of live stats across all counties) used to
  // sit above the ACTIVE COUNTIES list in the sidebar. Removed
  // when the widget-driven "All Counties" redesign shipped; the
  // per-county numbers on each row cover the same ground and the
  // MarketPricesWidget occupies that visual real estate now.
  const countyStatsByLabel = useMemo(() => {
    const live = liveCountyStats[selectedCounty]
    if (!live) return {} as Record<string, string>
    const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString())
    return {
      'Total owners':      fmt(live.totalOwners),
      'PDP tracts':        fmt(live.pdpTracts),
      'PUD tracts':        fmt(live.pudTracts),
      'New permits':       fmt(live.newPermits),
      'Survey abstracts':  fmt(live.abstracts),
    } as Record<string, string>
  }, [liveCountyStats, selectedCounty])

  // Same values as countyStatsByLabel but shaped as an array for the
  // stat-card grid renderer (each card reads .val and .lbl). "Active
  // wells" was removed on 2026-07-20 — it wasn't influencing any
  // broker decisions and it hit the RLS silent-zero trap on Martin.
  const liveCountyStatEntries = useMemo(() => {
    const live = liveCountyStats[selectedCounty]
    const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
    return [
      { val: fmt(live?.totalOwners), lbl: 'Total owners' },
      { val: fmt(live?.pdpTracts),   lbl: 'PDP tracts' },
      { val: fmt(live?.pudTracts),   lbl: 'PUD tracts' },
      { val: fmt(live?.newPermits),  lbl: 'New permits' },
      { val: fmt(live?.abstracts),   lbl: 'Survey abstracts' },
    ]
  }, [liveCountyStats, selectedCounty])
  const navCountyLabel = mapLevel === 'county' ? 'All Counties' : countyLabel
  const showCountyArrows = mapLevel === 'tract'
  const desktopPanelWidth = Math.min(420, Math.max(300, windowWidth * 0.3))
  const rightArrowOffset = selected && !isMobile ? desktopPanelWidth + 8 : 8
  const hideSecondaryNavActions = !isMobile && windowWidth < 1100
  const backToAllLabel = !isMobile && windowWidth < 1100 ? '← All' : '← All Counties'
  const countySummaryText = `${countyStatsByLabel['Survey abstracts'] ?? '—'} survey abstracts · ${countyStatsByLabel['Total owners'] ?? '—'} mineral owners`

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToastType(type)
    setToast(message)
    setTimeout(() => setToast(null), 3500)
  }
  const countyOrderIndex = COUNTY_ORDER.indexOf(selectedCounty)
  const previousCounty = countyOrderIndex > 0 ? COUNTY_ORDER[countyOrderIndex - 1] : null
  const nextCounty = countyOrderIndex >= 0 && countyOrderIndex < COUNTY_ORDER.length - 1
    ? COUNTY_ORDER[countyOrderIndex + 1]
    : null

  const switchCountyByOffset = useCallback((offset: -1 | 1) => {
    const currentIndex = COUNTY_ORDER.indexOf(selectedCounty)
    if (currentIndex === -1) return
    const nextIndex = currentIndex + offset
    if (nextIndex < 0 || nextIndex >= COUNTY_ORDER.length) return
    const nextKey = COUNTY_ORDER[nextIndex]
    setSelected(null)
    setSelectedCounty(nextKey)
    flyToCountyView(nextKey)
  }, [selectedCounty, flyToCountyView])

  useEffect(() => {
    countyRef.current = county
  }, [county])

  // Soft owner corrections / hides for the active county.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await fetchOwnerOverrides(selectedCounty)
      if (cancelled) return
      if (error) {
        console.error('Failed to load owner overrides:', error)
        setOwnerOverrides([])
        return
      }
      setOwnerOverrides(data)
    })()
    return () => {
      cancelled = true
    }
  }, [selectedCounty])

  // Close the owner drawer whenever the active tract changes so a stale
  // drawer from another tract doesn't stay visible after the user
  // navigates elsewhere.
  useEffect(() => {
    setDrawerOwner(null)
    setDrawerTractLabel(null)
  }, [selected?.abstract_label, selected?.ABSTRACT_L])

  // NOTE: no mapLevel/selectedCounty → flyTo effect. County zoom is only
  // triggered by flyToCountyView() from UI clicks. An auto-effect raced
  // deep-link fitBounds and also fired while MineralMap was unmounted
  // during county geojson reload (mapFlyToRef null → silent no-op).

  useEffect(() => {
    // 900px is the width at which the drawer's side-panel layout
    // (clamp(480px, 50vw, 720px) + map) stops being usable, so below
    // that we fall back to the mobile bottom-sheet. This used to be
    // 1024 which meant standard laptop-with-docked-panel widths
    // silently got the mobile layout even though they had plenty of
    // horizontal space.
    const updateMobile = () => setIsMobile(window.innerWidth < 900)
    updateMobile()
    window.addEventListener('resize', updateMobile)
    return () => window.removeEventListener('resize', updateMobile)
  }, [])

  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const [showOwnerNav, setShowOwnerNav] = useState(false)

  // Hydrate in-pipeline badges from THIS workspace's deals only.
  useEffect(() => {
    let mounted = true
    void (async () => {
      const workspace = await getWorkspaceContext()
      if (!mounted || !workspace) return
      const { data } = await supabase
        .from('deals')
        .select('owner_name')
        .eq('team_owner_id', workspace.workspaceId)
      if (!mounted || !data) return
      setPipelineOwners(
        new Set(
          data
            .map((row) => String((row as { owner_name?: string }).owner_name ?? '').trim())
            .filter(Boolean),
        ),
      )
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let mounted = true

    const identifyCurrentUser = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!mounted || !session?.user?.id) return
      identifyUser(
        session.user.id,
        session.user.email ?? '',
        session.user.user_metadata?.is_admin ?? false
      )
      setShowOwnerNav(isPlatformOwner(session.user.email))
    }

    void identifyCurrentUser()
    return () => {
      mounted = false
    }
  }, [])

  // Notify the product tour when the user hits a milestone so its
  // action-gated steps advance: clicking a county (enter tract view) →
  // explain the legend/overlays; clicking a tract → explain the owner panel.
  const prevMapLevelRef = useRef(mapLevel)
  useEffect(() => {
    if (prevMapLevelRef.current !== 'tract' && mapLevel === 'tract') {
      window.dispatchEvent(new CustomEvent(TOUR_ADVANCE_EVENT, { detail: { id: 'county' } }))
    }
    prevMapLevelRef.current = mapLevel
  }, [mapLevel])

  useEffect(() => {
    if (selected && (selected.abstract_label || selected.ABSTRACT_L)) {
      window.dispatchEvent(new CustomEvent(TOUR_ADVANCE_EVENT, { detail: { id: 'tract' } }))
    }
  }, [selected])

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
      if (countySwitchHideTimeoutRef.current) {
        clearTimeout(countySwitchHideTimeoutRef.current)
      }
      if (countySwitchClearTimeoutRef.current) {
        clearTimeout(countySwitchClearTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!hasInitializedCountySwitchRef.current) {
      hasInitializedCountySwitchRef.current = true
      return
    }

    if (countySwitchHideTimeoutRef.current) {
      clearTimeout(countySwitchHideTimeoutRef.current)
    }
    if (countySwitchClearTimeoutRef.current) {
      clearTimeout(countySwitchClearTimeoutRef.current)
    }

    setCountySwitchLabel(county.displayName)
    setCountySwitchLabelVisible(true)

    countySwitchHideTimeoutRef.current = setTimeout(() => {
      setCountySwitchLabelVisible(false)
    }, 1700)

    countySwitchClearTimeoutRef.current = setTimeout(() => {
      setCountySwitchLabel(null)
    }, 2000)
  }, [county.displayName, selectedCounty])

  useEffect(() => {
    setSelected(null)
    setExpandedOwner(null)
    setSearchQuery('')
    setSearchResults([])
    setSearchOpen(false)
    setOwnerWells({})
    setOwnerWellsLoading({})
    setTractWells([])
    setTractWellsLoaded(false)
    setTractWellsLoading(false)
    setWellsExpanded(false)
    setOwnerTracts([])
    setOwnerTractsName('')
    setOwnerTractsLoading(false)
    setCountyPermits([])
    setDrawerOwner(null)
    setDrawerTractLabel(null)
    setDevStatusByAbstract({})
  }, [selectedCounty])

  // Only permits filed / approved in the last 90 days qualify as
  // "new" for the sidebar dropdown + map halos. Use max(filed,
  // approved) everywhere — realtime scrape rows often have a fresh
  // approved_date with an older/null filed_date.
  const RECENT_PERMIT_DAYS = 90
  const recentPermitCutoffIso = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - RECENT_PERMIT_DAYS)
    return d.toISOString().slice(0, 10)
  }, [])

  // Shared loaders so county-switch and the live activity tick can
  // reuse the same Supabase queries. Soft refreshes skip the sidebar
  // loading spinner to avoid a 5-minute flicker.
  const loadDevStatusForCounty = useCallback(async (countyId: string) => {
    // PostgREST caps a response at 1000 rows, so a single .limit(5000) only
    // returns the first 1000 — that left large counties (e.g. Midland, 1.8k
    // tracts) with most tracts uncolored/green. Page through all rows.
    const pageSize = 1000
    const rows: Array<Record<string, unknown>> = []
    for (let from = 0; ; from += pageSize) {
      const result = await supabase
        .from('tract_development_status')
        .select('abstract_number, development_status, pud_score, signal_detail, last_computed')
        .eq('county_id', countyId)
        .order('abstract_number', { ascending: true })
        .range(from, from + pageSize - 1)
      if (result.error) {
        const msg = result.error.message.toLowerCase()
        if (!msg.includes('not find') && !msg.includes('does not exist')) {
          console.warn('[dev_status] fetch error:', result.error.message)
        }
        break
      }
      const batch = (result.data ?? []) as Array<Record<string, unknown>>
      rows.push(...batch)
      if (batch.length < pageSize || from > 50000) break
    }
    const out: Record<string, DevStatusRow> = {}
    for (const row of rows as Array<{
      abstract_number?: string | null
      development_status?: string | null
      pud_score?: number | null
      signal_detail?: unknown
      last_computed?: string | null
    }>) {
      const bare = String(row.abstract_number ?? '').replace(/^A-\s*/i, '').trim()
      if (!bare) continue
      out[bare] = {
        development_status: (row.development_status as DevelopmentStatus) ?? 'FRONTIER',
        pud_score: Number(row.pud_score ?? 0),
        signal_detail: (row.signal_detail as DevStatusSignal) ?? {},
        last_computed: row.last_computed ?? undefined,
      }
    }
    return out
  }, [])

  const loadCountyPermitsForCounty = useCallback(async (countyId: string, cutoff: string) => {
    const table = `${countyId}_permits`
    const result = await supabase
      .from(table)
      .select(
        'id, permit_number, api_number, operator_name, lease_name, latitude, longitude, permit_type, status, filed_date, approved_date, abstract_number',
      )
      .or(`filed_date.gte.${cutoff},approved_date.gte.${cutoff}`)
      .limit(3000)
    if (result.error) {
      console.warn(`[permits] ${table} unavailable:`, result.error.message)
      return [] as PermitRow[]
    }
    // Keep every recent row — realtime scrape delivers NO lat/lon
    // and usually NO abstract_number until the nightly compute.
    // Tract matching happens in visiblePermits via wells/lease.
    return (result.data ?? []) as PermitRow[]
  }, [])

  // Fetch tract_development_status for the active county. Rows come from
  // scripts/compute_development_status.py (Ticket 1.3 Phase 1). Missing
  // rows fall back to FRONTIER / score 0 client-side; a missing table
  // fails soft with an empty lookup so old builds don't crash.
  useEffect(() => {
    let cancelled = false
    void loadDevStatusForCounty(county.id).then((out) => {
      if (!cancelled) setDevStatusByAbstract(out)
    })
    return () => {
      cancelled = true
    }
  }, [county.id, loadDevStatusForCounty])

  // Load recent permits for the active county: filed OR approved
  // within the last 90 days (matches map halo window).
  useEffect(() => {
    let cancelled = false
    setCountyPermitsLoading(true)
    void loadCountyPermitsForCounty(county.id, recentPermitCutoffIso).then((rows) => {
      if (cancelled) return
      setCountyPermits(rows)
      setCountyPermitsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [county.id, recentPermitCutoffIso, loadCountyPermitsForCounty])

  // Soft live refresh — same cadence as the Permits nav badge. Updates
  // permit halos (via tract_development_status) + sidebar New Permits
  // without a hard reload or loading flicker. Uses a ref for county so
  // a county switch doesn't double-fire with the mount effects above.
  const activityCountyIdRef = useRef(county.id)
  activityCountyIdRef.current = county.id
  useEffect(() => {
    if (!activityRefreshTick) return
    let cancelled = false
    const countyId = activityCountyIdRef.current
    const cutoff = recentPermitCutoffIso
    void (async () => {
      const [dev, permits] = await Promise.all([
        loadDevStatusForCounty(countyId),
        loadCountyPermitsForCounty(countyId, cutoff),
      ])
      if (cancelled) return
      // Ignore stale responses if the user switched counties mid-flight.
      if (countyId !== activityCountyIdRef.current) return
      setDevStatusByAbstract(dev)
      setCountyPermits(permits)
    })()
    return () => {
      cancelled = true
    }
  }, [
    activityRefreshTick,
    recentPermitCutoffIso,
    loadDevStatusForCounty,
    loadCountyPermitsForCounty,
  ])

  // Effective geometry for the currently-selected tract. Uses whichever
  // source resolves first:
  //   1. `selectedTractGeometry` state — set by the on-map click handler
  //      because it has the exact geometry mapbox rendered.
  //   2. `tractGeometryByAbstract[abstract]` lookup — populated at load
  //      time from the parcels GeoJSON. Covers every non-map click path
  //      (sidebar top-tracts, owner tracts list, search results).
  // Falling back to the lookup makes the New Permits filter update
  // every time the selected tract changes, regardless of where the
  // click came from.
  const activeTractGeometry = useMemo<GeoJSON.Geometry | null>(() => {
    if (!selected) return null
    const currentAbstract = bareAbstract(selected.abstract_label ?? selected.ABSTRACT_L)
    // Prefer the state-provided geometry when it matches the current
    // selection, otherwise fall through to the lookup so stale
    // geometry from a previous click never leaks into the permit
    // filter for a different tract.
    if (selectedTractGeometry && currentAbstract && tractGeometryByAbstract[currentAbstract] === selectedTractGeometry) {
      return selectedTractGeometry
    }
    if (currentAbstract && tractGeometryByAbstract[currentAbstract]) {
      return tractGeometryByAbstract[currentAbstract]
    }
    return selectedTractGeometry
  }, [selected, selectedTractGeometry, tractGeometryByAbstract])

  // Bare abstract for the selected tract — same keying as
  // tract_development_status / permit.abstract_number.
  const selectedAbstractBare = useMemo(() => {
    if (!selected) return ''
    return bareAbstract(selected.abstract_label ?? selected.ABSTRACT_L)
  }, [selected])

  // Permit numbers / APIs that compute_development_status already
  // attached to this tract via signal_detail. Used when the row-level
  // abstract_number column is null but the nightly classifier still
  // linked the permit to this abstract.
  const signalPermitKeys = useMemo(() => {
    const keys = new Set<string>()
    const signalPermits = selectedTractDevStatus?.signal_detail?.permits ?? []
    for (const p of signalPermits) {
      const num = String(p.permit_number ?? '').trim()
      const api = String(p.api ?? '').replace(/\D/g, '')
      if (num) keys.add(`num:${num}`)
      if (api) keys.add(`api:${api}`)
    }
    return keys
  }, [selectedTractDevStatus])

  const visiblePermits = useMemo(() => {
    const recent = countyPermits
      .filter((permit) => {
        const best = permitBestDate(permit)
        return Boolean(best && best >= recentPermitCutoffIso)
      })
      .sort((a, b) => {
        const aKey = permitBestDate(a) ?? ''
        const bKey = permitBestDate(b) ?? ''
        if (aKey === bKey) return (b.id ?? 0) - (a.id ?? 0)
        return bKey.localeCompare(aKey)
      })

    // County overview (no tract selected): show every recent permit.
    if (!selected) return recent

    // Tract selected — ONLY this tract's permits. Fresh EWA scrape rows
    // have no lat/lon and no abstract_number, so we also match via the
    // wells already loaded for this abstract (lease/operator), same
    // idea as /permits tier 4 but scoped to the clicked tract.
    const section = String(
      selected.surv_sect ?? selected.Surv_Sect ?? selected.level3_sur ?? '',
    ).trim()
    const block = String(selected.block ?? selected.Block ?? '').trim()

    return recent.filter((permit) => {
      const stamped = bareAbstract(permit.abstract_number)
      if (selectedAbstractBare && stamped && stamped === selectedAbstractBare) {
        return true
      }

      const num = String(permit.permit_number ?? '').trim()
      const api = String(permit.api_number ?? '').replace(/\D/g, '')
      if (num && signalPermitKeys.has(`num:${num}`)) return true
      if (api && signalPermitKeys.has(`api:${api}`)) return true

      if (permitMatchesTractWells(permit, tractWells)) return true

      // Only use section/block fallback after wells have loaded so we
      // don't flash unrelated county permits while wells are in flight.
      if (
        tractWellsLoaded &&
        permitMatchesTractLegal(permit, {
          section,
          block,
          operator: selected.top_operator,
        })
      ) {
        return true
      }

      const lon = Number(permit.longitude)
      const lat = Number(permit.latitude)
      if (
        activeTractGeometry &&
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        lon >= -180 &&
        lon <= 180 &&
        lat >= -90 &&
        lat <= 90
      ) {
        return isPointInGeometry(lon, lat, activeTractGeometry)
      }
      return false
    })
  }, [
    countyPermits,
    activeTractGeometry,
    recentPermitCutoffIso,
    selected,
    selectedAbstractBare,
    signalPermitKeys,
    tractWells,
    tractWellsLoaded,
  ])

  const embeddedOwners = useMemo(
    () => parseOwners(selected?.owners_json ?? ''),
    [selected]
  )
  // Filter box for the tract owner list (helps navigate large West-Texas
  // rolls where a single tract can carry thousands of mineral owners).
  const [ownerNameQuery, setOwnerNameQuery] = useState('')
  // Counties whose enriched GeoJSON omits owners_json (big rolls kept in
  // Supabase to stay under file limits) load the FULL owner list per tract
  // on demand from /api/tract-owners. Counties with embedded owners_json
  // (Howard/Martin) keep using it, so their behavior is unchanged.
  const [dbTractOwners, setDbTractOwners] = useState<TractOwner[]>([])
  const [dbOwnersLoading, setDbOwnersLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setDbTractOwners([])
    setOwnerNameQuery('')
    const abstract = String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '')
      .replace(/^A-\s*/i, '')
      .trim()
    // Always load the complete owner list from the DB (the source of truth,
    // uncapped) for the selected tract — embedded owners_json is only a
    // fast-loading preview and may be capped or missing recovered owners.
    if (!selected || !abstract) {
      setDbOwnersLoading(false)
      return
    }
    setDbOwnersLoading(true)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/tract-owners?county=${countyRef.current.id}&abstract=${encodeURIComponent(abstract)}`,
        )
        const json = await res.json()
        if (cancelled) return
        const rows = (json?.data?.owners ?? []) as Array<Record<string, unknown>>
        setDbTractOwners(
          rows.map((r, idx): TractOwner => ({
            id: (r.id as string | undefined) ?? String(idx),
            owner_name: String(r.owner_name ?? ''),
            propensity_score: Number(r.propensity_score ?? 0),
            operator_name: (r.operator_name as string) ?? '',
            mailing_city: (r.mailing_city as string) ?? '',
            mailing_state: (r.mailing_state as string) ?? '',
            mailing_zip: (r.mailing_zip as string) ?? '',
            address_1: (r.mailing_address as string) ?? '',
            out_of_state: Boolean(r.out_of_state),
            motivated: Boolean(r.motivated),
            acreage: r.acreage == null ? 0 : Number(r.acreage),
            ownership_pct: r.ownership_pct == null ? 0 : Number(r.ownership_pct),
            rrc_lease_id: (r.rrc_lease_id as string | number | null) ?? null,
            sptb_code: (r.sptb_code as string | null) ?? null,
          })),
        )
      } catch {
        /* leave empty; embedded fallback already tried */
      } finally {
        if (!cancelled) setDbOwnersLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, embeddedOwners])

  // Merge the embedded preview with the complete DB list (deduped by owner +
  // lease), so nothing is lost and recovered/uncapped owners are included.
  const tractOwners = useMemo<TractOwner[]>(() => {
    if (dbTractOwners.length === 0) return embeddedOwners
    if (embeddedOwners.length === 0) return dbTractOwners
    const keyOf = (o: TractOwner) =>
      `${String(o.owner_name ?? '').toUpperCase().trim()}|${normalizeLeaseId(o.rrc_lease_id)}`
    const seen = new Set<string>()
    const merged: TractOwner[] = []
    for (const o of embeddedOwners) {
      seen.add(keyOf(o))
      merged.push(o)
    }
    for (const o of dbTractOwners) {
      const k = keyOf(o)
      if (!seen.has(k)) {
        seen.add(k)
        merged.push(o)
      }
    }
    return merged
  }, [embeddedOwners, dbTractOwners])

  // Fetch + cache the county's wells GeoJSON (the exact file the map draws),
  // so tract-wells can be matched by geometry rather than a brittle abstract
  // string join. Storage first, then the /public fallback, mirroring Map.tsx.
  const loadCountyWellsGeo = useCallback(
    async (countyId: string): Promise<GeoJSON.FeatureCollection | null> => {
      const cached = wellsGeoCacheRef.current[countyId]
      if (cached !== undefined) return cached
      const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')
      const urls = [
        supaUrl ? `${supaUrl}/storage/v1/object/public/map-data/${countyId}_wells.geojson` : '',
        `/${countyId}_wells.geojson?v=1`,
      ].filter(Boolean)
      for (const url of urls) {
        try {
          const r = await fetch(url, { cache: 'force-cache' })
          if (!r.ok) continue
          const gj = (await r.json()) as GeoJSON.FeatureCollection
          if (gj && Array.isArray(gj.features)) {
            wellsGeoCacheRef.current[countyId] = gj
            return gj
          }
        } catch {
          /* try next url */
        }
      }
      wellsGeoCacheRef.current[countyId] = null
      return null
    },
    [],
  )

  useEffect(() => {
    let cancelled = false

    if (!selected) {
      setTractWells([])
      setTractWellsLoaded(false)
      setTractWellsLoading(false)
      setOwnerWells({})
      setOwnerWellsLoading({})
      setWellsExpanded(false)
      return
    }

    // Match wells to the tract by GEOMETRY against the same wells GeoJSON the
    // map renders. This is the only approach that agrees with what the user
    // sees — grid-county tracts (Block/Section labels) never matched the
    // wells table's `abstract` column, so the old string join returned 0
    // even when laterals clearly crossed the tract.
    const matchTractWellsByGeometry = async (): Promise<boolean> => {
      const tractGeom = activeTractGeometry
      if (!tractGeom) return false
      const geo = await loadCountyWellsGeo(countyRef.current.id)
      if (cancelled) return true
      if (!geo || !Array.isArray(geo.features)) return false

      const bbox = geomBbox(tractGeom)
      const edges = polygonOuterEdges(tractGeom)
      const seen = new Set<string>()
      const wells: WellSummary[] = []
      for (const f of geo.features) {
        const g = f.geometry as GeoJSON.Geometry | null
        if (!g) continue
        if (!wellHitsTract(g, tractGeom, bbox, edges)) continue
        const p = (f.properties ?? {}) as Record<string, unknown>
        const api = String(p.api ?? '').trim()
        const operator = String(p.operator ?? '').trim()
        const kind = String(p.kind ?? '').trim()
        const wellType = String(p.well_type ?? '').trim().toUpperCase()
        const dedupeKey = api || `${operator}|${kind}|${wellType}`
        if (dedupeKey && seen.has(dedupeKey)) continue
        if (dedupeKey) seen.add(dedupeKey)
        wells.push({
          lease_name: api ? `API ${api}` : (WELL_KIND_BADGE[kind]?.label ?? 'Well'),
          operator_name: operator || 'Unknown',
          well_type: wellType === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL',
          api_number: api || null,
          kind: kind || null,
          rrc_lease_id: null,
        })
      }
      const rank: Record<string, number> = {
        producing: 0, duc: 1, permitted: 2, shut_in: 3, injection: 4, horizontal: 5, vertical: 6,
      }
      wells.sort((a, b) => (rank[a.kind ?? ''] ?? 9) - (rank[b.kind ?? ''] ?? 9))
      if (!cancelled) {
        setTractWells(wells)
        setTractWellsLoaded(true)
        setTractWellsLoading(false)
      }
      return true
    }

    // Fallback for the rare case where tract geometry or the wells GeoJSON
    // isn't available: the original abstract/operator lookup via /api/wells.
    const fetchTractWellsViaApi = async () => {
      const operator = selected.top_operator
      const fieldName = selected.field_name
      const tractAbstractLabel = String(selected.abstract_label ?? selected.ABSTRACT_L ?? '').trim()
      const tractAbstract = tractAbstractLabel.replace(/^A-\s*/i, '').trim()
      if (countyRef.current.wellsJoinStrategy === 'abstract' && !tractAbstract) {
        if (!cancelled) {
          setTractWells([])
          setTractWellsLoaded(true)
          setTractWellsLoading(false)
        }
        return
      }
      try {
        const response = await fetch('/api/wells', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            countyId: countyRef.current.id,
            mode: 'tract',
            abstractLabel: tractAbstract,
            operator: operator ?? null,
            fieldName: fieldName ?? null,
          }),
        })
        const payload = (await response.json()) as { wells?: WellSummary[]; error?: string }
        if (!cancelled) {
          setTractWells(Array.isArray(payload.wells) ? payload.wells : [])
          setTractWellsLoaded(true)
          setTractWellsLoading(false)
        }
      } catch (error) {
        console.error('Failed to fetch tract wells:', error)
        if (!cancelled) {
          setTractWells([])
          setTractWellsLoaded(true)
          setTractWellsLoading(false)
        }
      }
    }

    const run = async () => {
      setTractWellsLoading(true)
      setTractWellsLoaded(false)
      setOwnerWells({})
      setOwnerWellsLoading({})
      setWellsExpanded(false)
      const matched = await matchTractWellsByGeometry()
      if (!matched && !cancelled) await fetchTractWellsViaApi()
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [selected, activeTractGeometry, loadCountyWellsGeo])

  const fetchOwnerWells = useCallback(async (owner: TractOwner, ownerKey: string) => {
    setOwnerWellsLoading((prev) => ({ ...prev, [ownerKey]: true }))

    try {
      const tractAbstractLabel = String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '').trim()
      const tractAbstract = tractAbstractLabel.replace(/^A-\s*/i, '').trim()
      const response = await fetch('/api/wells', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countyId: countyRef.current.id,
          mode: 'owner',
          ownerName: String(owner.owner_name ?? '').trim(),
          leaseId: String(owner.rrc_lease_id ?? '').trim(),
          abstract: tractAbstract,
          operator: owner.operator_name ?? selected?.top_operator ?? null,
          fieldName: selected?.field_name ?? null,
        }),
      })
      const payload = await response.json() as { wells?: WellSummary[]; error?: string }
      setOwnerWells((prev) => ({ ...prev, [ownerKey]: Array.isArray(payload.wells) ? payload.wells : [] }))
    } finally {
      setOwnerWellsLoading((prev) => ({ ...prev, [ownerKey]: false }))
    }
  }, [selected])

  const getDefaultPipelineTag = (): PipelineTag => {
    // Default pipeline tag is now 'prospect' for everything;
    // proprietary scoring was removed so we no longer auto-classify
    // 'hot' / 'nurture' at pipeline-add time. Users tag manually.
    return 'prospect'
  }

  const handleSkipTrace = (owner: TractOwner) => {
    setSkipTracing(owner)
  }

  const handleOpenAddToPipeline = (owner: TractOwner) => {
    setPipelineCandidate(owner)
    setPipelineTag(getDefaultPipelineTag())
  }

  const handleAddToPipeline = (owner: TractOwner) => {
    handleOpenAddToPipeline(owner)
  }

  const handleSearch = async (query: string) => {
    // Preserve the raw value in state so spaces between words aren't stripped while
    // the user is still typing. Trim only for the search logic below.
    setSearchQuery(query)
    const trimmed = query.trim()

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }

    if (trimmed.length < 3) {
      // Owners need 3+ chars, but counties/tracts match at 2+, so leave the
      // dropdown open — the derived county/tract matches may still populate it.
      setSearchResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    // Debounce — wait 400ms after user stops typing.
    searchTimeoutRef.current = setTimeout(async () => {
      const words = trimmed.toUpperCase().split(/\s+/).filter((word) => word.length > 1)
      if (words.length === 0) {
        setSearchResults([])
        setSearching(false)
        searchTimeoutRef.current = null
        return
      }

      const searchCounties = mapLevel === 'county'
        ? COUNTY_ORDER
        : [selectedCounty]

      // Run parallel searches for each word as primary.
      // This handles both "Kent Plaster" and "Plaster Kent".
      const searchPromises = searchCounties.flatMap((countyKey) =>
        words.map((word) =>
          supabase
            .from(COUNTIES[countyKey].ownershipTable)
            .select('id, owner_name, mailing_city, mailing_state, mailing_zip, rrc_lease_id, operator_name, acreage, ownership_pct')
            .ilike('owner_name', `%${word}%`)
            .order('owner_name', { ascending: true })
            .limit(100)
            .then((result) => ({ ...result, countyId: countyKey }))
        )
      )

      const queryResults = await Promise.all(searchPromises)
      const firstError = queryResults.find((result) => result.error)?.error
      if (firstError) {
        console.error('Owner search failed:', firstError.message)
        setSearching(false)
        searchTimeoutRef.current = null
        return
      }

      const allData = queryResults.flatMap((result) =>
        ((result.data ?? []) as OwnerSearchResult[]).map((owner) => ({
          ...owner,
          countyId: result.countyId,
          countyName: COUNTIES[result.countyId].name,
        }))
      )

      // Filter to rows that contain ALL words (in any order).
      const filtered = allData.filter((owner) =>
        words.every((word) => String(owner.owner_name ?? '').toUpperCase().includes(word))
      )

      // Deduplicate by owner name (per county). First occurrence wins;
      // Supabase already returned rows ordered by owner_name so this
      // gives us a stable A–Z result set.
      const seen = new Map<string, OwnerSearchResult>()
      for (const owner of filtered) {
        const keyCounty = String(owner.countyId ?? selectedCounty)
        const key = `${String(owner.owner_name ?? '').toUpperCase().trim()}::${keyCounty}`
        if (!seen.has(key)) {
          seen.set(key, owner)
        }
      }

      const topResults = Array.from(seen.values())
        .sort((a, b) =>
          String(a.owner_name ?? '').localeCompare(String(b.owner_name ?? '')),
        )
        .slice(0, 10)
      setSearchResults(topResults)
      setSearching(false)
      searchTimeoutRef.current = null
    }, 400)
  }

  const handleAddToPipelineConfirm = async () => {
    if (!pipelineCandidate) return
    setPipelineSaving(true)

    const owner = pipelineCandidate
    const tractAbstract = selected?.ABSTRACT_L ?? selected?.abstract_label ?? ''
    const tractSurvey = selected?.LEVEL1_SUR ?? selected?.level1_sur ?? ''
    const survName = (selected?.surv_name ?? selected?.Surv_Name ?? selected?.LEVEL1_SUR ?? '').trim() || null
    const blockVal = (selected?.block ?? selected?.Block ?? '').trim() || null
    const survSectRaw = (selected?.surv_sect ?? selected?.Surv_Sect ?? selected?.TEXTSTRING ?? '').trim()
    const survSect = survSectRaw && survSectRaw !== tractAbstract ? survSectRaw : null

    const workspace = await getWorkspaceContext()
    if (!workspace) {
      showToast('Sign in required to add to pipeline', 'error')
      setPipelineSaving(false)
      return
    }

    const { error } = await supabase.from('deals').insert({
      user_id: workspace.userId,
      team_owner_id: workspace.workspaceId,
      owner_name: owner.owner_name,
      tract_abstract: tractAbstract,
      tract_survey: tractSurvey,
      operator_name: owner.operator_name ?? '',
      rrc_lease_id: owner.rrc_lease_id ?? null,
      mailing_city: owner.mailing_city ?? '',
      mailing_state: owner.mailing_state ?? '',
      mailing_zip: owner.mailing_zip ?? '',
      mailing_address: owner.address_1 ?? owner.mailing_address ?? '',
      acreage: owner.acreage ?? null,
      source: 'map',
      tag: pipelineTag,
      county: selectedCounty,
      surv_name: survName,
      block: blockVal,
      surv_sect: survSect,
    })

    if (error) {
      console.error('Failed to add owner to pipeline:', error.message)
      showToast(`Failed to add ${owner.owner_name}: ${error.message}`, 'error')
      setPipelineSaving(false)
      return
    }

    setPipelineOwners((prev) => {
      const next = new Set(prev)
      next.add(owner.owner_name)
      return next
    })
    setPipelineSaving(false)
    setPipelineCandidate(null)
    showToast(`${owner.owner_name} added to pipeline (${pipelineTag.replace('_', ' ')})`)
    trackEvent('lead_added_to_pipeline', {
      owner_name: owner.owner_name,
    })
  }

  const handleSkipTraceConfirm = async () => {
    if (!skipTracing) return
    setSkipTraceLoading(true)

    try {
      const nameParts = (skipTracing?.owner_name ?? '').trim().split(/\s+/)
      const lastName = nameParts.length > 1 ? nameParts[0] : ''
      const firstName = nameParts.length > 1 ? nameParts[1] : (nameParts[0] ?? '')

      const response = await fetch('/api/skiptrace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          address: skipTracing.mailing_address ?? skipTracing.address_1 ?? '',
          city: skipTracing.mailing_city ?? '',
          state: skipTracing.mailing_state ?? '',
          zip: skipTracing.mailing_zip ?? '',
          ownerName: skipTracing.owner_name,
        }),
      })

      const result = await response.json()
      if (!response.ok) {
        throw new Error(result?.error || result?.message || 'Skip trace failed')
      }

      if (result.success) {
        const phone = result.phones?.[0] ?? null
        const email = result.emails?.[0] ?? null

        const workspace = await getWorkspaceContext()
        if (!workspace) {
          throw new Error('Sign in required')
        }

        const skipRecord = skipTracing as unknown as Record<string, unknown>
        const dealData = {
          user_id: workspace.userId,
          team_owner_id: workspace.workspaceId,
          owner_name: skipTracing.owner_name,
          tract_abstract: (skipRecord.tract_abstract as string | undefined) ?? selected?.ABSTRACT_L ?? '',
          tract_survey: (skipRecord.tract_survey as string | undefined) ?? selected?.LEVEL1_SUR ?? '',
          operator_name: skipTracing.operator_name ?? '',
          rrc_lease_id: skipTracing.rrc_lease_id ?? null,
          mailing_address: skipTracing.mailing_address ?? skipTracing.address_1 ?? '',
          mailing_city: skipTracing.mailing_city ?? '',
          mailing_state: skipTracing.mailing_state ?? '',
          mailing_zip: skipTracing.mailing_zip ?? '',
          acreage: skipTracing.acreage ?? null,
          tag: 'skip_traced',
          phone,
          email,
          source: 'skip_trace',
          county: selectedCounty,
          updated_at: new Date().toISOString(),
          notes: `Skip traced ${new Date().toLocaleDateString()}\nPhone: ${phone ?? 'not found'}\nEmail: ${email ?? 'not found'}`,
        }

        const { data: existing, error: existingError } = await supabase
          .from('deals')
          .select('id, phone, email')
          .eq('team_owner_id', workspace.workspaceId)
          .eq('owner_name', skipTracing.owner_name)
          .maybeSingle()
        if (existingError) {
          console.error('Existing deal lookup error:', existingError)
          throw existingError
        }

        let savedDeal: { id?: string } | null = null
        if (existing?.id) {
          const { data, error } = await supabase
            .from('deals')
            .update({
              tag: 'skip_traced',
              phone: phone ?? null,
              email: email ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
            .eq('team_owner_id', workspace.workspaceId)
            .select()
            .single()
          if (error) {
            console.error('Failed to update CRM deal:', error)
            throw error
          }
          savedDeal = (data ?? null) as { id?: string } | null
        } else {
          const { data, error } = await supabase
            .from('deals')
            .insert(dealData)
            .select()
            .single()
          if (error) {
            console.error('Failed to insert CRM deal:', error)
            throw error
          }
          savedDeal = (data ?? null) as { id?: string } | null
        }

        setPipelineOwners((prev) => {
          const next = new Set(prev)
          next.add(skipTracing.owner_name)
          return next
        })

        setSkipTraceResult({
          ownerName: skipTracing.owner_name,
          phone,
          email,
          dealId: savedDeal?.id ?? null,
          cached: Boolean(result.cached),
        })
        trackEvent('skip_trace_run', {
          owner_name: skipTracing.owner_name,
          cached: Boolean(result.cached),
        })
      } else {
        setToast(`Skip trace failed: ${result.error}`)
        setTimeout(() => setToast(null), 4000)
      }
    } catch (err) {
      console.error('Skip trace confirm error:', err)
      setToast('Skip trace failed - check console')
      setTimeout(() => setToast(null), 4000)
    } finally {
      setSkipTraceLoading(false)
      setSkipTracing(null)
    }
  }

  useEffect(() => {
    let mounted = true

    const loadData = async () => {
      // First visit only — keep MineralMap mounted across Martin↔Howard
      // switches so the camera flyTo still has a live map instance.
      if (!mapHasMountedRef.current) setLoading(true)
      try {
        const parcelSource = county.geoJsonPath
        const response = await fetch(parcelSource, { cache: 'no-store' })
        let parcelsData: unknown

        if (response.ok) {
          parcelsData = await response.json()
        } else {
          throw new Error(`${county.displayName} parcel source failed (${response.status})`)
        }

        if (!mounted) return

        // Build an abstract -> geometry lookup alongside the flat
        // TractRecord[] so downstream code (New Permits point-in-
        // polygon filter, sidebar map focus) can resolve a tract's
        // geometry no matter where the click originated — map,
        // sidebar top-tracts list, owner tracts list, or search.
        // Before this, setSelectedTractGeometry was only ever called
        // from the on-map click handler, so clicking a tract from
        // any sidebar list left the permit filter stuck on the last
        // map-clicked polygon.
        const featureList = (
          ((parcelsData as { features?: unknown[] })?.features ?? []) as Array<{
            properties?: Record<string, unknown>
            geometry?: GeoJSON.Geometry
          }>
        )
        const nextGeometryLookup: Record<string, GeoJSON.Geometry> = {}
        for (const feature of featureList) {
          const props = feature.properties ?? {}
          const label = String(
            props[county.abstractField] ?? props.ABSTRACT_L ?? '',
          ).trim()
          const bare = label.replace(/^A-\s*/i, '').replace(/^\d{5}-/, '').trim().toUpperCase()
          if (bare && feature.geometry && !nextGeometryLookup[bare]) {
            nextGeometryLookup[bare] = feature.geometry
          }
        }
        setTractGeometryByAbstract(nextGeometryLookup)

        const rows: TractRecord[] = featureList
          .map((feature) => {
            const props = feature.properties ?? {}
            const ownersJsonRaw = props.owners_json
            const abstractFieldValue = props[county.abstractField]
            return {
              abstract_label: String(abstractFieldValue ?? props.ABSTRACT_L ?? ''),
              level1_sur: String(props.LEVEL1_SUR ?? ''),
              owner_count: toNumber(props.owner_count),
              top_operator: String(props.top_operator ?? 'Unknown'),
              max_propensity_score: toNumber(props.max_propensity_score),
              owners_json:
                typeof ownersJsonRaw === 'string'
                  ? ownersJsonRaw
                  : JSON.stringify(ownersJsonRaw ?? []),
              field_name: String(props.field_name ?? ''),
              well_status: String(props.well_status ?? ''),
              first_date: String(props.first_date ?? ''),
              est_lease_expiration: String(props.est_lease_expiration ?? ''),
              prod_cumulative_sum_oil: toNumber(props.prod_cumulative_sum_oil),
              first_6_month_oil: toNumber(props.first_6_month_oil),
              first_12_month_oil: toNumber(props.first_12_month_oil),
              first_24_month_oil: toNumber(props.first_24_month_oil),
              first_60_month_oil: toNumber(props.first_60_month_oil),
              horizontal_well_count: toNumber(props.horizontal_well_count),
              vertical_well_count: toNumber(props.vertical_well_count),
              production_status: (
                ['pdp', 'pud', 'new_permit', 'pending_permit', 'none'].includes(String(props.production_status))
                  ? props.production_status
                  : 'none'
              ) as ProductionStatus,
              well_count: toNumber(props.well_count),
              pdp_well_count: toNumber(props.pdp_well_count),
              pud_well_count: toNumber(props.pud_well_count),
              permit_count: toNumber(props.permit_count),
              SHAPE_AREA: toNumber(props.SHAPE_AREA ?? props.shape_area ?? props.STArea__),
              surv_name: String(props.Surv_Name ?? props.LEVEL1_SUR ?? props.DESC_ ?? ''),
              block: String(props.Block ?? props.BLOCK ?? props.LEVEL2_BLO ?? ''),
              surv_sect: String(props.Surv_Sect ?? props.TEXTSTRING ?? ''),
              desc_: String(props.DESC_ ?? ''),
              level3_sur: String(props.LEVEL3_SUR ?? ''),
            }
          })
          .filter((tract) => tract.abstract_label !== '')

        setTracts(rows)
      } catch (err) {
        console.error('Failed to load parcel data:', err)
        if (mounted) {
          setTracts([])
          showToast('Failed to load map data', 'error')
        }
      } finally {
        if (mounted) {
          setLoading(false)
          mapHasMountedRef.current = true
        }
      }
    }

    loadData()
    return () => {
      mounted = false
    }
  }, [county])

  // One-shot deep-link resolver: once tracts finish loading for
  // the URL-requested county, find the tract whose abstract_label
  // matches ?abstract=X (case-insensitive, "A-" prefix optional)
  // OR contains ?lat/?lon via point-in-polygon, then setSelected.
  useEffect(() => {
    if (tracts.length === 0) return

    if (pendingUrlAbstract) {
      const wanted = pendingUrlAbstract.replace(/^A-\s*/i, '').trim().toUpperCase()
      const match = tracts.find((t) => {
        const label = String(t.abstract_label ?? '')
          .replace(/^A-\s*/i, '')
          .trim()
          .toUpperCase()
        return label === wanted
      })
      if (match) {
        // Prefer the geojson label form (often "A-316") so Map focus
        // matching against ABSTRACT_L succeeds.
        const geom =
          tractGeometryByAbstract[wanted] ||
          tractGeometryByAbstract[`A-${wanted}`] ||
          tractGeometryByAbstract[wanted.toLowerCase()]
        const centerFromGeom = geometryCenter(geom)
        const selection = {
          ...toTractSelection(match),
          abstract_label:
            String(match.abstract_label ?? '').trim() ||
            (wanted ? `A-${wanted}` : ''),
          // Stash pad coords so Map.tsx can flyTo if parcel label match fails.
          latitude: pendingUrlPoint?.lat ?? centerFromGeom?.[1],
          longitude: pendingUrlPoint?.lon ?? centerFromGeom?.[0],
        }
        setSelected(selection)
        if (geom) setSelectedTractGeometry(geom)

        // Zoom immediately. Relying only on Map focusTarget→parcel match
        // left Pad Ops deep-links selected in the sidebar but never
        // fitBounds when slim map geojson labels diverge.
        if (pendingUrlPoint) {
          setPendingFlyTo({
            center: [pendingUrlPoint.lon, pendingUrlPoint.lat],
            zoom: 14,
          })
          setPendingUrlPoint(null)
        } else if (centerFromGeom) {
          setPendingFlyTo({ center: centerFromGeom, zoom: 14 })
        }

        setPendingUrlAbstract(null)
        if (pendingUrlOwner) {
          setHighlightedOwner(pendingUrlOwner)
          setPendingUrlOwner(null)
        }
        return
      }
    }

    if (pendingUrlPoint) {
      const { lat, lon } = pendingUrlPoint
      let matchedBare: string | null = null
      let matchedGeom: GeoJSON.Geometry | null = null
      for (const [bare, geom] of Object.entries(tractGeometryByAbstract)) {
        if (isPointInGeometry(lon, lat, geom)) {
          matchedBare = bare.replace(/^A-\s*/i, '').trim()
          matchedGeom = geom
          break
        }
      }
      if (matchedBare) {
        const match = tracts.find((t) => {
          const label = String(t.abstract_label ?? '').replace(/^A-\s*/i, '').trim()
          return label === matchedBare || label.toUpperCase() === matchedBare.toUpperCase()
        })
        if (match) {
          setSelected(toTractSelection(match))
          if (matchedGeom) setSelectedTractGeometry(matchedGeom)
        }
      }
      // Always zoom to the pad point — even if PIP missed a tract label.
      setPendingFlyTo({ center: [lon, lat], zoom: 14 })
      setPendingUrlPoint(null)
      if (pendingUrlOwner) {
        setHighlightedOwner(pendingUrlOwner)
        setPendingUrlOwner(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracts, pendingUrlAbstract, pendingUrlPoint, tractGeometryByAbstract, pendingUrlOwner])

  const toTractSelection = (tract: TractRecord): TractSelection => ({
    abstract_label: tract.abstract_label,
    level1_sur: tract.level1_sur,
    owner_count: tract.owner_count,
    top_operator: tract.top_operator,
    owners_json: tract.owners_json,
    max_propensity_score: tract.max_propensity_score,
    field_name: tract.field_name,
    well_status: tract.well_status,
    first_date: tract.first_date,
    prod_cumulative_sum_oil: tract.prod_cumulative_sum_oil,
    first_6_month_oil: tract.first_6_month_oil,
    first_12_month_oil: tract.first_12_month_oil,
    first_24_month_oil: tract.first_24_month_oil,
    first_60_month_oil: tract.first_60_month_oil,
    horizontal_well_count: tract.horizontal_well_count,
    vertical_well_count: tract.vertical_well_count,
    SHAPE_AREA: tract.SHAPE_AREA,
    surv_name: tract.surv_name,
    block: tract.block,
    surv_sect: tract.surv_sect,
    desc_: tract.desc_,
    level3_sur: tract.level3_sur,
  })

  const handleSearchSelect = async (result: OwnerSearchResult) => {
    const ownerName = String(result.owner_name ?? '').trim()
    if (!ownerName) {
      setSearchQuery('')
      setSearchResults([])
      setSearchOpen(false)
      return
    }

    const resultCounty = result.countyId ?? selectedCounty
    if (mapLevel === 'county') {
      if (resultCounty !== selectedCounty) {
        setSelectedCounty(resultCounty)
      }
      setMapLevel('tract')
      setSelected(null)
      setExpandedOwner(null)
      setOwnerWells({})
      setTractWells([])
      setTractWellsLoaded(false)
      setWellsExpanded(false)
      flyToCountyView(resultCounty)
    }

    const normalizedOwner = ownerName.toUpperCase()

    // Close the search dropdown immediately; the tract list takes over.
    setSearchQuery('')
    setSearchResults([])
    setSearchOpen(false)

    setOwnerTracts([])
    setOwnerTractsName(ownerName)
    setOwnerTractsLoading(true)

    const resultCountyConfig = COUNTIES[resultCounty]
    const ownershipTable = resultCountyConfig.ownershipTable
    // Abstract-join counties expose an `abstract` column on the ownership
    // row; rrc_lease_id-join counties don't.
    const selectCols = resultCountyConfig.wellsJoinStrategy === 'abstract'
      ? 'abstract, rrc_lease_id, operator_name, ownership_pct, acreage'
      : 'rrc_lease_id, operator_name, ownership_pct, acreage'
    const { data: ownerRows, error: ownerRowsError } = await supabase
      .from(ownershipTable)
      .select(selectCols)
      .ilike('owner_name', ownerName)
      .limit(50)

    if (ownerRowsError) {
      console.error('Owner tracts lookup failed:', ownerRowsError.message)
    }

    const matchedTracts = (ownerRows ?? [])
      .map((row) => {
        const record = row as {
          abstract?: string | null
          rrc_lease_id?: string | number | null
          operator_name?: string | null
        }
        const abstractNumeric = String(record.abstract ?? '').trim()
        const leaseIdRaw = String(record.rrc_lease_id ?? '').trim()
        const leaseIdNorm = normalizeLeaseId(record.rrc_lease_id)

        const tract = tracts.find((t) => {
          const tractAbstractRaw = String(t.abstract_label ?? '').trim()
          const tractAbstractNumeric = tractAbstractRaw.replace(/^A-\s*/i, '').trim()
          if (abstractNumeric && tractAbstractNumeric === abstractNumeric) return true
          if (leaseIdRaw || leaseIdNorm) {
            const owners = parseOwners(t.owners_json) as Array<Record<string, unknown>>
            return owners.some((o) => {
              const oLeaseRaw = String(o.rrc_lease_id ?? '').trim()
              const oLeaseNorm = normalizeLeaseId(o.rrc_lease_id)
              if (!oLeaseRaw && !oLeaseNorm) return false
              if (leaseIdRaw && oLeaseRaw === leaseIdRaw) return true
              if (leaseIdNorm && oLeaseNorm === leaseIdNorm) return true
              return false
            })
          }
          return false
        })

        return tract ? { tract, row: record } : null
      })
      .filter((item): item is { tract: TractRecord; row: Record<string, unknown> } => item !== null)

    const seen = new Set<string>()
    const uniqueTracts: TractSelection[] = []
    for (const item of matchedTracts) {
      const key = String(item.tract.abstract_label ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      uniqueTracts.push(toTractSelection(item.tract))
    }

    // Fallback: if the abstract/lease join missed everything, try the old
    // owner-name scan of the loaded tracts so we still show something for
    // owners whose ownership row didn't have an abstract the tracts index
    // recognizes.
    if (uniqueTracts.length === 0) {
      for (const t of tracts) {
        const owners = parseOwners(t.owners_json) as Array<Record<string, unknown>>
        const hasOwner = owners.some(
          (o) => String(o.owner_name ?? '').trim().toUpperCase() === normalizedOwner
        )
        if (!hasOwner) continue
        const key = String(t.abstract_label ?? '')
        if (!key || seen.has(key)) continue
        seen.add(key)
        uniqueTracts.push(toTractSelection(t))
      }
    }

    setOwnerTracts(uniqueTracts)
    setOwnerTractsLoading(false)

    const focusOnTract = (tractSelection: TractSelection) => {
      setSelected(tractSelection)
      setOwnerSort('az')
      setExpandedOwner(null)
      setHighlightedOwner(normalizedOwner)

      setTimeout(() => {
        const el = document.getElementById(ownerRowDomId(ownerName))
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, 400)

      setTimeout(() => setHighlightedOwner(null), 3000)

      setMapFocusTarget({
        leaseId: normalizeLeaseId(result.rrc_lease_id) || null,
        ownerName,
        nonce: Date.now(),
      })
    }

    if (uniqueTracts.length === 0) {
      showToast(`No mapped tract found for ${ownerName}`, 'error')
      setOwnerTractsName('')
      return
    }

    if (uniqueTracts.length === 1) {
      focusOnTract(uniqueTracts[0])
      setOwnerTracts([])
      setOwnerTractsName('')
    }
  }

  // Global search — jump straight to a county from the top search bar.
  const handleCountySearchSelect = (countyId: CountyKey) => {
    setSearchQuery('')
    setSearchResults([])
    setSearchOpen(false)
    setSelected(null)
    setExpandedOwner(null)
    setOwnerTracts([])
    setOwnerTractsName('')
    setSelectedCounty(countyId)
    setMapLevel('tract')
    flyToCountyView(countyId)
    trackEvent('global_search_select', { kind: 'county', county: countyId })
  }

  // Global search — select a tract in the currently loaded county and let
  // the map's focusTarget effect fit the camera onto it.
  const handleTractSearchSelect = (tract: TractRecord) => {
    setSearchQuery('')
    setSearchResults([])
    setSearchOpen(false)
    setExpandedOwner(null)
    setOwnerTracts([])
    setOwnerTractsName('')
    setMapLevel('tract')
    setOwnerSort('az')
    setSelected(toTractSelection(tract))
    trackEvent('global_search_select', {
      kind: 'tract',
      county: selectedCounty,
      abstract: tract.abstract_label,
    })
  }

  // Rank order once the score-based sort was removed:
  //   1. PDP wells drilled (drilled + completed activity)
  //   2. PUD wells (permitted but not yet drilled)
  //   3. Total permits (approved + pending)
  //   4. Owner count as final tiebreaker so a tract with more mineral
  //      leads still floats up when well activity is identical.
  const PRODUCTION_STATUS_RANK: Record<ProductionStatus, number> = {
    pdp: 4, pud: 3, new_permit: 2, pending_permit: 1, none: 0,
  }
  const topTracts = useMemo(
    () =>
      [...tracts]
        .sort((a, b) => {
          const rankA = PRODUCTION_STATUS_RANK[(a.production_status ?? 'none') as ProductionStatus] ?? 0
          const rankB = PRODUCTION_STATUS_RANK[(b.production_status ?? 'none') as ProductionStatus] ?? 0
          if (rankB !== rankA) return rankB - rankA
          const pdpA = Number(a.pdp_well_count ?? 0)
          const pdpB = Number(b.pdp_well_count ?? 0)
          if (pdpB !== pdpA) return pdpB - pdpA
          const wellsA = Number(a.well_count ?? 0)
          const wellsB = Number(b.well_count ?? 0)
          if (wellsB !== wellsA) return wellsB - wellsA
          return b.owner_count - a.owner_count
        })
        .slice(0, 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracts]
  )

  const selectedOwners = tractOwners
  const deduplicatedOwners = useMemo(() => {
    const seen = new Map<string, TractOwner>()
    for (const owner of selectedOwners) {
      const name = String(owner.owner_name ?? '').trim()
      if (!name) continue
      const existing = seen.get(name)
      // Keep the row with the largest NRA when the same owner
      // appears on multiple leases; that preserves the "biggest
      // stake" version of the record, which is what brokers care
      // about now that scoring is gone.
      const currentNRA = getNRA(owner, selected, county) ?? 0
      const existingNRA = existing ? (getNRA(existing, selected, county) ?? 0) : -1
      if (!existing || currentNRA > existingNRA) {
        seen.set(name, owner)
      }
    }
    return Array.from(seen.values())
    // Selected + county are stable references at this depth; the
    // effect only meaningfully re-runs when selectedOwners changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOwners])

  const sortedOwners = useMemo(() => {
    const owners = [...deduplicatedOwners]
    const nameKey = (o: TractOwner) => String(o.owner_name ?? '').trim().toUpperCase()
    if (ownerSort === 'az') {
      owners.sort((a, b) => nameKey(a).localeCompare(nameKey(b)))
    } else if (ownerSort === 'za') {
      owners.sort((a, b) => nameKey(b).localeCompare(nameKey(a)))
    } else if (ownerSort === 'largest') {
      owners.sort(
        (a, b) =>
          (getNRA(b, selected, county) ?? 0) -
          (getNRA(a, selected, county) ?? 0),
      )
    } else if (ownerSort === 'smallest') {
      owners.sort(
        (a, b) =>
          (getNRA(a, selected, county) ?? 0) -
          (getNRA(b, selected, county) ?? 0),
      )
    }
    return owners
  }, [county, deduplicatedOwners, ownerSort, selected])

  const filteredOwnersList = useMemo(() => {
    return sortedOwners.filter((owner) => {
      if (ownerTypeFilter !== 'all' && classifyOwner(String(owner.owner_name ?? '')) !== ownerTypeFilter) {
        return false
      }
      if (largeInterestOnly) {
        const pct = getOwnershipPctValue(owner, county.ownershipPctIsDecimal)
        if (pct < 1) return false
      }
      if (minNRA > 0) {
        const nra = getNRA(owner, selected, county) ?? 0
        if (nra < minNRA) return false
      }
      return true
    })
  }, [county, sortedOwners, ownerTypeFilter, largeInterestOnly, minNRA, selected])

  const operatorOptions = useMemo(
    () => collectOperatorOptions(tracts, parseOwners),
    [tracts],
  )

  // Canonical label for a CAD operator spelling (sidebar Op: lines).
  const operatorLabelByRoot = useMemo(() => {
    const map = new Map<string, string>()
    for (const op of operatorOptions) map.set(op.key, op.label)
    return map
  }, [operatorOptions])

  const canonicalOperatorLabel = useCallback(
    (raw: string | null | undefined) => {
      const label = String(raw || '').trim()
      if (!label) return ''
      const root = operatorRoot(label)
      return (root && operatorLabelByRoot.get(root)) || label
    },
    [operatorLabelByRoot],
  )

  // Drop selections that disappear after a county switch / data reload.
  useEffect(() => {
    if (selectedOperatorKeys.length === 0) return
    const valid = new Set(operatorOptions.map((o) => o.key))
    const next = selectedOperatorKeys.filter((k) => valid.has(k))
    if (next.length !== selectedOperatorKeys.length) {
      setSelectedOperatorKeys(next)
    }
  }, [operatorOptions, selectedOperatorKeys])

  const selectedOperatorFilters = useMemo(() => {
    if (selectedOperatorKeys.length === 0) return [] as string[]
    const byKey = new Map(operatorOptions.map((o) => [o.key, o]))
    // Match against cluster key + canonical label so CAD aliases resolve
    // through operatorRoot / operatorMatches.
    return selectedOperatorKeys.flatMap((key) => {
      const op = byKey.get(key)
      return op ? [op.key, op.label] : [key]
    })
  }, [operatorOptions, selectedOperatorKeys])

  const operatorMatchAbstracts = useMemo(() => {
    if (selectedOperatorFilters.length === 0) return null
    return abstractsMatchingOperators(
      tracts,
      selectedOperatorFilters,
      parseOwners,
    )
  }, [tracts, selectedOperatorFilters])

  const operatorMatchTractCount = useMemo(() => {
    if (!operatorMatchAbstracts) return null
    return new Set(
      operatorMatchAbstracts.map((a) => a.replace(/^A-\s*/i, '').toUpperCase()),
    ).size
  }, [operatorMatchAbstracts])

  const tractAbstractForOverrides = useMemo(
    () =>
      String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '').trim(),
    [selected?.abstract_label, selected?.ABSTRACT_L],
  )

  const cleanOwnersList = useMemo(() => {
    const cleaned = filteredOwnersList
      .filter((owner: TractOwner) => {
        const name = (owner.owner_name ?? '').trim()
        if (!name || name.length < 3) return false
        if (/^MAP\d{4}/.test(name)) return false
        if (/^\d+$/.test(name)) return false
        if (name === 'UNKNOWN' || name === 'N/A') return false
        const override = pickOwnerOverride(
          ownerOverrides,
          name,
          tractAbstractForOverrides,
        )
        if (!showHiddenOwners && isHiddenOverride(override)) return false
        return true
      })
      .map((owner) => {
        const override = pickOwnerOverride(
          ownerOverrides,
          owner.owner_name,
          tractAbstractForOverrides,
        )
        return applyOwnerOverride(owner, override)
      })
    if (selectedOperatorFilters.length === 0) return cleaned
    // Surface CAD operator matches first; keep the rest for tract context.
    return [...cleaned].sort((a, b) => {
      const aHit = operatorMatchesAny(a.operator_name, selectedOperatorFilters) ? 0 : 1
      const bHit = operatorMatchesAny(b.operator_name, selectedOperatorFilters) ? 0 : 1
      return aHit - bHit
    })
  }, [
    filteredOwnersList,
    ownerOverrides,
    showHiddenOwners,
    tractAbstractForOverrides,
    selectedOperatorFilters,
  ])

  // In-tract search: filter the owner list by name / city / state / operator.
  const displayedOwners = useMemo(() => {
    const q = ownerNameQuery.trim().toUpperCase()
    if (!q) return cleanOwnersList
    return cleanOwnersList.filter((o) => {
      const hay = [
        o.owner_name,
        o.mailing_city,
        o.mailing_state,
        o.operator_name,
        o.address_1,
        o.mailing_address,
      ]
        .map((v) => String(v ?? '').toUpperCase())
        .join(' ')
      return hay.includes(q)
    })
  }, [cleanOwnersList, ownerNameQuery])

  // ── Global search: county + tract matches. Owners are fetched from the
  // DB inside handleSearch; counties and tracts are matched client-side.
  // Counties are always searchable; tracts are scoped to the county whose
  // parcel index is currently loaded (that's what `tracts` holds).
  const globalCountyMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) return [] as CountyKey[]
    return COUNTY_ORDER
      .filter((key) => `${COUNTIES[key].name} county`.includes(q) || COUNTIES[key].name.toLowerCase().includes(q))
      .slice(0, 5)
  }, [searchQuery])

  const globalTractMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) return [] as TractRecord[]
    const bare = q.replace(/^a-?\s*/i, '')
    const seen = new Set<string>()
    const out: TractRecord[] = []
    for (const t of tracts) {
      const label = String(t.abstract_label ?? '').toLowerCase()
      const labelBare = label.replace(/^a-?\s*/i, '')
      const survey = String(t.level1_sur ?? t.surv_name ?? '').toLowerCase()
      const block = String(t.block ?? '').toLowerCase()
      const matched =
        label.includes(q) ||
        (bare.length >= 1 && labelBare.startsWith(bare)) ||
        survey.includes(q) ||
        (!!block && block === q)
      if (!matched) continue
      const key = String(t.abstract_label ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(t)
      if (out.length >= 6) break
    }
    return out
  }, [searchQuery, tracts])

  const hasGlobalResults =
    globalCountyMatches.length > 0 ||
    globalTractMatches.length > 0 ||
    searchResults.length > 0

  const hiddenOwnerCount = useMemo(() => {
    return filteredOwnersList.filter((owner) => {
      const override = pickOwnerOverride(
        ownerOverrides,
        owner.owner_name,
        tractAbstractForOverrides,
      )
      return isHiddenOverride(override)
    }).length
  }, [filteredOwnersList, ownerOverrides, tractAbstractForOverrides])

  const drawerOwnerOverride = useMemo(() => {
    if (!drawerOwner) return null
    return pickOwnerOverride(
      ownerOverrides,
      drawerOwner.owner_name,
      drawerTractLabel || tractAbstractForOverrides,
    )
  }, [
    drawerOwner,
    ownerOverrides,
    drawerTractLabel,
    tractAbstractForOverrides,
  ])

  const drawerOwnerView = useMemo(() => {
    if (!drawerOwner) return null
    return applyOwnerOverride(drawerOwner, drawerOwnerOverride)
  }, [drawerOwner, drawerOwnerOverride])

  const handleSaveOwnerDetails = useCallback(
    async (owner: { owner_name: string }, patch: OwnerDetailsPatch) => {
      const abstract = drawerTractLabel || tractAbstractForOverrides
      const { data, error } = await upsertOwnerOverride({
        countyId: selectedCounty,
        ownerName: owner.owner_name,
        abstract,
        status: isHiddenOverride(
          pickOwnerOverride(ownerOverrides, owner.owner_name, abstract),
        )
          ? 'hidden'
          : 'updated',
        patch,
      })
      if (error || !data) {
        showToast(error || 'Failed to save owner details', 'error')
        return { success: false, error: error || 'Failed to save' }
      }
      setOwnerOverrides((prev) => {
        const keyName = owner.owner_name.trim().toUpperCase()
        const keyAbs = String(data.abstract || '').toUpperCase()
        const next = prev.filter(
          (row) =>
            !(
              row.owner_name.trim().toUpperCase() === keyName &&
              String(row.abstract || '').toUpperCase() === keyAbs
            ),
        )
        next.push(data)
        return next
      })
      setDrawerOwner((prev) =>
        prev && prev.owner_name === owner.owner_name
          ? applyOwnerOverride(prev, data)
          : prev,
      )
      void mirrorOverrideToDeal({
        countyId: selectedCounty,
        ownerName: owner.owner_name,
        patch,
      })
      showToast('Owner details updated')
      trackEvent('owner_details_updated', {
        owner_name: owner.owner_name,
        county: selectedCounty,
      })
      return { success: true }
    },
    [
      drawerTractLabel,
      ownerOverrides,
      selectedCounty,
      tractAbstractForOverrides,
    ],
  )

  const handleRemoveOwner = useCallback(
    async (
      owner: { owner_name: string },
      opts: { status: 'hidden' | 'incorrect'; note?: string },
    ) => {
      const abstract = drawerTractLabel || tractAbstractForOverrides
      const existing = pickOwnerOverride(
        ownerOverrides,
        owner.owner_name,
        abstract,
      )
      const { data, error } = await upsertOwnerOverride({
        countyId: selectedCounty,
        ownerName: owner.owner_name,
        abstract,
        status: opts.status,
        patch: {
          display_name: existing?.display_name ?? null,
          mailing_address: existing?.mailing_address ?? null,
          mailing_city: existing?.mailing_city ?? null,
          mailing_state: existing?.mailing_state ?? null,
          mailing_zip: existing?.mailing_zip ?? null,
          phone: existing?.phone ?? null,
          email: existing?.email ?? null,
          note: opts.note ?? existing?.note ?? null,
        },
      })
      if (error || !data) {
        showToast(error || 'Failed to remove owner', 'error')
        return { success: false, error: error || 'Failed to remove' }
      }
      setOwnerOverrides((prev) => {
        const keyName = owner.owner_name.trim().toUpperCase()
        const keyAbs = String(data.abstract || '').toUpperCase()
        const next = prev.filter(
          (row) =>
            !(
              row.owner_name.trim().toUpperCase() === keyName &&
              String(row.abstract || '').toUpperCase() === keyAbs
            ),
        )
        next.push(data)
        return next
      })
      void mirrorOverrideToDeal({
        countyId: selectedCounty,
        ownerName: owner.owner_name,
        patch: {},
        tag: 'bad_lead',
      })
      setDrawerOwner(null)
      setDrawerTractLabel(null)
      showToast('Owner removed from your list (CAD record kept)')
      trackEvent('owner_removed_from_list', {
        owner_name: owner.owner_name,
        county: selectedCounty,
        status: opts.status,
      })
      return { success: true }
    },
    [
      drawerTractLabel,
      ownerOverrides,
      selectedCounty,
      tractAbstractForOverrides,
    ],
  )

  const handleRestoreOwner = useCallback(
    async (owner: { owner_name: string }) => {
      const abstract = drawerTractLabel || tractAbstractForOverrides
      const existing = pickOwnerOverride(
        ownerOverrides,
        owner.owner_name,
        abstract,
      )
      // If there are contact corrections, keep them as status=updated;
      // otherwise delete the override row entirely.
      const hasContactPatch = Boolean(
        existing &&
          (existing.display_name ||
            existing.mailing_address ||
            existing.mailing_city ||
            existing.phone ||
            existing.email),
      )
      if (hasContactPatch && existing) {
        const { data, error } = await upsertOwnerOverride({
          countyId: selectedCounty,
          ownerName: owner.owner_name,
          abstract: existing.abstract,
          status: 'updated',
          patch: {
            display_name: existing.display_name,
            mailing_address: existing.mailing_address,
            mailing_city: existing.mailing_city,
            mailing_state: existing.mailing_state,
            mailing_zip: existing.mailing_zip,
            phone: existing.phone,
            email: existing.email,
            note: existing.note,
          },
        })
        if (error || !data) {
          showToast(error || 'Failed to restore owner', 'error')
          return { success: false, error: error || 'Failed to restore' }
        }
        setOwnerOverrides((prev) => {
          const keyName = owner.owner_name.trim().toUpperCase()
          const keyAbs = String(data.abstract || '').toUpperCase()
          const next = prev.filter(
            (row) =>
              !(
                row.owner_name.trim().toUpperCase() === keyName &&
                String(row.abstract || '').toUpperCase() === keyAbs
              ),
          )
          next.push(data)
          return next
        })
      } else {
        const { error } = await deleteOwnerOverride({
          countyId: selectedCounty,
          ownerName: owner.owner_name,
          abstract: existing?.abstract ?? abstract,
        })
        if (error) {
          showToast(error, 'error')
          return { success: false, error }
        }
        setOwnerOverrides((prev) =>
          prev.filter(
            (row) =>
              !(
                row.owner_name.trim().toUpperCase() ===
                  owner.owner_name.trim().toUpperCase() &&
                String(row.abstract || '').toUpperCase() ===
                  String((existing?.abstract ?? abstract) || '')
                    .replace(/^A-\s*/i, '')
                    .toUpperCase()
              ),
          ),
        )
      }
      showToast('Owner restored to list')
      trackEvent('owner_restored_to_list', {
        owner_name: owner.owner_name,
        county: selectedCounty,
      })
      return { success: true }
    },
    [
      drawerTractLabel,
      ownerOverrides,
      selectedCounty,
      tractAbstractForOverrides,
    ],
  )
  const abstractLabel = selected?.abstract_label ?? selected?.ABSTRACT_L ?? 'Unknown'
  const selectedDescRaw = (selected?.desc_ ?? selected?.DESC_ ?? '').trim()
  const selectedSurvName = (selected?.surv_name ?? selected?.Surv_Name ?? '').trim()
  const selectedLevel1Sur = (selected?.level1_sur ?? selected?.LEVEL1_SUR ?? '').trim()
  const selectedBlock = (selected?.block ?? selected?.Block ?? '').trim()
  const selectedSurvSectRaw = (selected?.surv_sect ?? selected?.Surv_Sect ?? selected?.TEXTSTRING ?? '').trim()
  // Gonzales TEXTSTRING is typically just the abstract label (e.g. "A-160"),
  // which isn't useful as a section descriptor — drop it in that case.
  const selectedSurvSect = selectedSurvSectRaw && selectedSurvSectRaw !== abstractLabel
    ? selectedSurvSectRaw
    : ''
  // Header layout has three slots: survey system, section+block, and the
  // surveyor/grantee name. Howard data fills all three (e.g. "T&P RR CO",
  // "Section 14 · Block 33 T1N", "SMITH, J H Survey"). Gonzales has no
  // block/section and only a grantee name (LEVEL1_SUR), so we show it as
  // "{LEVEL1_SUR} Survey" on the big bold line with "Abstract {N}" below.
  const hasStructuredLegal = Boolean(selectedDescRaw || selectedBlock || selectedSurvSect)
  const abstractNumber = abstractLabel.replace(/^A-\s*/i, '')

  let legalSystemLine = ''
  let legalSectionLine = ''
  let legalGranteeLine = ''
  if (hasStructuredLegal) {
    legalSystemLine = selectedDescRaw
    const sectionPart = selectedSurvSect ? `Section ${selectedSurvSect}` : ''
    const blockPart = selectedBlock ? `Block ${selectedBlock}` : ''
    legalSectionLine = [sectionPart, blockPart].filter(Boolean).join(' · ')
    const granteeName = selectedSurvName && selectedSurvName !== selectedDescRaw
      ? selectedSurvName
      : ''
    legalGranteeLine = granteeName ? `${granteeName} Survey` : ''
  } else {
    const granteeName = selectedSurvName || selectedLevel1Sur
    legalSectionLine = granteeName ? `${granteeName} Survey` : ''
    legalGranteeLine = abstractLabel ? `Abstract ${abstractNumber}` : ''
  }
  const ownerCount = toNumber(selected?.owner_count)
  const topOperator = selected?.top_operator ?? 'Unknown'
  const fieldName = selected?.field_name ?? 'Unknown'
  const estExpiration = selected?.est_lease_expiration ?? 'Unknown'
  // Compact legal description shown under each lead's name for Howard /
  // Martin tracts. Empty string for Gonzales (no T&P coordinates) and any
  // Martin tract that isn't a T&P RR survey (CSL leagues, named-surveyor
  // grants), in which case the line is omitted entirely.
  const tractLegalDescription = buildLegalDescription(selected)

  return (
    <div
      style={{
        height: '100dvh',
        background: 'var(--mm-chrome-bg)',
        color: 'var(--mm-chrome-fg)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <ProductTour
        steps={TOUR_STEPS}
        storageKey="mineral_map_tour_v2"
        context={{
          mapLevel,
          tractSelected: Boolean(selected && (selected.abstract_label || selected.ABSTRACT_L)),
        }}
      />
      {/* Top header */}
      <div
        style={{
          height: isMobile ? 56 : 52,
          // Subtle photo texture behind the top bar. The Permian hero
          // sits underneath a solid chrome overlay so light/dark both
          // keep a hint of place without hurting nav readability.
          background:
            "var(--mm-chrome-header-overlay), " +
            "url('/hero-permian.jpg') center/cover no-repeat",
          backgroundBlendMode: 'normal',
          borderBottom: '1px solid var(--mm-chrome-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: isMobile ? '0 10px' : '0 20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          gap: isMobile ? 8 : 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative' }} data-tour="nav-menu">
            <button
              onClick={() => setNavMenuOpen((prev) => !prev)}
              style={{
                width: 30,
                height: 30,
                borderRadius: 6,
                border: '1px solid var(--mm-chrome-border)',
                background: 'var(--mm-chrome-bg)',
                color: 'var(--mm-chrome-fg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                padding: 0,
              }}
              aria-label="Open navigation menu"
            >
              <span
                style={{
                  display: 'inline-flex',
                  flexDirection: 'column',
                  gap: 3,
                  width: 12,
                }}
              >
                <span style={{ display: 'block', height: 1.5, background: 'var(--mm-chrome-fg)' }} />
                <span style={{ display: 'block', height: 1.5, background: 'var(--mm-chrome-fg)' }} />
                <span style={{ display: 'block', height: 1.5, background: 'var(--mm-chrome-fg)' }} />
              </span>
            </button>
            {navMenuOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 36,
                  left: 0,
                  zIndex: 1200,
                  background: 'var(--mm-chrome-panel)',
                  border: '1px solid var(--mm-chrome-border)',
                  borderRadius: 8,
                  minWidth: 220,
                  overflow: 'hidden',
                  boxShadow: '0 8px 20px rgba(0,0,0,0.15)',
                }}
              >
                <a
                  href="/"
                  style={{
                    display: 'block',
                    padding: '10px 16px',
                    fontSize: 13,
                    color: 'var(--mm-chrome-fg)',
                    textDecoration: 'none',
                    fontFamily: 'Geist, Inter, system-ui, sans-serif',
                    borderBottom: '1px solid var(--mm-chrome-border)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#FEF3C7'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  ← Map
                </a>
                <PermitsNavLink
                  href="/permits"
                  style={{
                    display: 'block',
                    padding: '10px 16px',
                    fontSize: 13,
                    color: 'var(--mm-chrome-fg)',
                    textDecoration: 'none',
                    fontFamily: 'Geist, Inter, system-ui, sans-serif',
                    borderBottom: '1px solid var(--mm-chrome-border)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#EFF6FF'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  Recent permits
                </PermitsNavLink>
                {/* Satellite Imagery archived — see lib/feature-flags.ts */}
                <a
                  href="/crm"
                  style={{
                    display: 'block',
                    padding: '10px 16px',
                    fontSize: 13,
                    color: 'var(--mm-chrome-fg)',
                    textDecoration: 'none',
                    fontFamily: 'Geist, Inter, system-ui, sans-serif',
                    borderBottom: '1px solid var(--mm-chrome-border)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#FEF3C7'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  CRM & Pipeline
                </a>
                <div style={{ borderTop: '1px solid #E5E7EB', margin: '2px 0 0' }} />
                <div style={{ padding: '10px 16px 4px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                  {navCountyLabel}
                </div>
                <div style={{ padding: '0 16px 12px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                  {countySummaryText}
                </div>
              </div>
            )}
          </div>
          <AppLogo width={150} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            {!isMobile && (
              <span style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif', whiteSpace: 'nowrap' }}>
                {navCountyLabel}
              </span>
            )}
            {mapLevel === 'tract' && (
              <button
                onClick={() => {
                  setMapLevel('county')
                  setSelected(null)
                  setExpandedOwner(null)
                  setSearchQuery('')
                  setSearchResults([])
                  setSearchOpen(false)
                  setOwnerTracts([])
                  setOwnerTractsName('')
                }}
                style={{
                  height: 26,
                  border: '1px solid var(--mm-chrome-border)',
                  borderRadius: 6,
                  background: 'var(--mm-chrome-panel)',
                  color: 'var(--mm-chrome-muted)',
                  fontSize: 11,
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                  padding: '0 8px',
                  cursor: 'pointer',
                }}
              >
                {backToAllLabel}
              </button>
            )}
            <select
              data-tour="county-select"
              value={selectedCounty}
              onChange={(event) => {
                const next = event.target.value as CountyKey
                setSelected(null)
                setSelectedCounty(next)
                if (mapLevel === 'tract') flyToCountyView(next)
              }}
              style={{
                height: 26,
                border: '1px solid var(--mm-chrome-border)',
                borderRadius: 6,
                background: 'var(--mm-chrome-panel)',
                color: 'var(--mm-chrome-muted)',
                fontSize: 11,
                fontFamily: 'Geist, Inter, system-ui, sans-serif',
                padding: '0 8px',
                outline: 'none',
              }}
            >
              {Object.entries(COUNTIES).map(([countyId, countyConfig]) => (
                <option key={countyId} value={countyId}>
                  {countyConfig.name} County
                </option>
              ))}
            </select>
          </div>
        </div>
        {!isMobile && (
          <div data-tour="global-search" style={{ position: 'relative', flex: 1, maxWidth: 360, margin: '0 16px' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--mm-chrome-muted-fill)', border: '1px solid var(--mm-chrome-border)',
              borderRadius: 8, padding: '6px 12px',
              transition: 'all 0.15s'
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="Search counties, tracts, owners…"
                value={searchQuery}
                onChange={(e) => { void handleSearch(e.target.value); setSearchOpen(true) }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                style={{
                  border: 'none', background: 'transparent', outline: 'none',
                  fontSize: 13, color: 'var(--mm-chrome-fg)', width: '100%',
                  fontFamily: 'Geist, Inter, system-ui, sans-serif'
                }}
              />
              {searching && (
                <div style={{ width: 12, height: 12, border: '2px solid #E5E7EB', borderTopColor: '#EF9F27', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
              )}
            </div>

            {searchOpen && hasGlobalResults && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 1000, overflow: 'hidden',
                maxHeight: '70vh', overflowY: 'auto',
              }}>
                {globalCountyMatches.length > 0 && (
                  <>
                    <div style={SEARCH_GROUP_HEADING}>Counties</div>
                    {globalCountyMatches.map((key) => (
                      <div
                        key={`county-${key}`}
                        onMouseDown={() => handleCountySearchSelect(key)}
                        style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mm-chrome-muted-fill)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <span style={SEARCH_KIND_BADGE}>County</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--mm-chrome-fg)' }}>
                          {COUNTIES[key].name} County
                        </span>
                      </div>
                    ))}
                  </>
                )}

                {globalTractMatches.length > 0 && (
                  <>
                    <div style={SEARCH_GROUP_HEADING}>Tracts in {COUNTIES[selectedCounty].name} County</div>
                    {globalTractMatches.map((tract, i) => (
                      <div
                        key={`tract-${tract.abstract_label}-${i}`}
                        onMouseDown={() => handleTractSearchSelect(tract)}
                        style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mm-chrome-muted-fill)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={SEARCH_KIND_BADGE}>Tract</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mm-chrome-fg)' }}>{tract.abstract_label}</div>
                            <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {tract.level1_sur || tract.surv_name || '—'}
                            </div>
                          </div>
                        </div>
                        {tract.owner_count ? (
                          <span style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', flexShrink: 0 }}>
                            {tract.owner_count} owner{tract.owner_count === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </>
                )}

                {searchResults.length > 0 && (
                  <>
                    <div style={SEARCH_GROUP_HEADING}>Owners</div>
                    {searchResults.map((result, i) => (
                      <div
                        key={`${result.owner_name}-${i}`}
                        onMouseDown={() => {
                          setSearchQuery(result.owner_name)
                          setSearchOpen(false)
                          void handleSearchSelect(result)
                        }}
                        style={{
                          padding: '10px 14px', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mm-chrome-muted-fill)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mm-chrome-fg)' }}>{result.owner_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', marginTop: 2 }}>
                            {result.mailing_city && result.mailing_state ? `${result.mailing_city}, ${result.mailing_state}` : ''}
                            {result.countyName ? ` · ${result.countyName}` : ''}
                            {Number(result.leaseCount ?? 1) > 1 ? (
                              <span
                                style={{
                                  marginLeft: 6,
                                  background: 'var(--mm-chrome-muted-fill)',
                                  border: '1px solid var(--mm-chrome-border)',
                                  borderRadius: 4,
                                  padding: '1px 5px',
                                  fontSize: 10,
                                  color: 'var(--mm-chrome-muted)',
                                }}
                              >
                                {result.leaseCount} leases
                              </span>
                            ) : result.operator_name ? ` · ${result.operator_name}` : ''}
                          </div>
                        </div>
                        {result.acreage ? (
                          <span style={{ fontSize: 10, color: 'var(--mm-chrome-muted)' }}>
                            {Number(result.acreage).toFixed(1)} ac
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {searchOpen && searchQuery.trim().length >= 2 && !hasGlobalResults && !searching && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 10,
                padding: '16px 14px', fontSize: 13, color: 'var(--mm-chrome-muted)', textAlign: 'center',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 1000
              }}>
                No matches for &quot;{searchQuery}&quot;
              </div>
            )}
          </div>
        )}
        {/* "Skip traces: X / 200" display was removed with the monthly
            cap. Usage is still tracked server-side in skip_trace_usage
            for internal accounting, but end users have unlimited
            skip traces. */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            maxWidth: isMobile ? '55vw' : 'none',
            overflowX: isMobile ? 'auto' : 'visible',
            paddingBottom: isMobile ? 2 : 0,
            flexShrink: 1,
          }}
        >
          <PermitsNavLink
            href="/permits"
            style={{
              fontSize: 12,
              color: '#2563EB',
              textDecoration: 'none',
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #2563EB',
              fontWeight: 500,
              fontFamily: 'Geist, Inter, system-ui, sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            Permits
          </PermitsNavLink>
          {/* Satellite Imagery archived — see lib/feature-flags.ts */}
          <a
            href="/crm"
            style={{
              fontSize: 12,
              color: '#EF9F27',
              textDecoration: 'none',
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #EF9F27',
              fontWeight: 500,
              fontFamily: 'Geist, Inter, system-ui, sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            CRM →
          </a>
          {showOwnerNav && !hideSecondaryNavActions && (
            <a
              href="/owner"
              style={{
                fontSize: 12,
                color: '#B45309',
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #F59E0B',
                background: '#FFFBEB',
                fontWeight: 600,
                fontFamily: 'Geist, Inter, system-ui, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              Owner
            </a>
          )}
          {!hideSecondaryNavActions && (
            <a
              href="/account"
              style={{
                fontSize: 12,
                color: 'var(--mm-chrome-muted)',
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--mm-chrome-border)',
                fontFamily: 'Geist, Inter, system-ui, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              Account
            </a>
          )}
          <button
            onClick={() => window.dispatchEvent(new Event(TOUR_EVENT))}
            style={{
              fontSize: 12,
              color: 'var(--mm-chrome-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px 12px',
              fontFamily: 'Geist, Inter, system-ui, sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            Tour
          </button>
          <button
            onClick={async () => {
              await supabase.auth.signOut()
              window.location.href = '/auth'
            }}
            style={{
              fontSize: 12,
              color: 'var(--mm-chrome-muted)',
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--mm-chrome-border)',
              background: 'var(--mm-chrome-panel)',
              cursor: 'pointer',
              fontFamily: 'Geist, Inter, system-ui, sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Outer flex-column so the mobile drawer (bottom sheet) stays
          a real sibling. On desktop we render the OwnerDrawer as a
          left-hand column INSIDE the sidebar+map row instead of
          under it — that way the map keeps its full height on the
          right and the broker doesn't have to scroll the drawer to
          reach the wells / notes tabs. Mobile keeps the historical
          bottom-sheet layout because a 50/50 split doesn't work on
          a phone. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* Desktop-only side drawer. Sits before the tract sidebar
            in the row so it visually replaces it. `flex: none` +
            explicit width so the map on the right can just grow to
            fill the remainder without extra math. */}
        {drawerOwner && !isMobile && (
          <div
            style={{
              width: 'clamp(480px, 50vw, 720px)',
              minWidth: 'clamp(480px, 50vw, 720px)',
              flex: 'none',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRight: '1px solid #E5E7EB',
              background: 'var(--mm-chrome-panel)',
              order: 0,
            }}
          >
            <OwnerDrawer
              open={Boolean(drawerOwner)}
              owner={drawerOwnerView}
              tractLabel={drawerTractLabel}
              tractLegalDescription={buildLegalDescription(selected) || null}
              countyId={selectedCounty}
              inPipeline={drawerOwner ? pipelineOwners.has(drawerOwner.owner_name) : false}
              legalDescByAbstract={tractLegalDescLookup}
              tractDevStatus={devStatusByAbstract[
                String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '').replace(/^A-\s*/i, '').trim()
              ] ?? null}
              highlightOperators={selectedOperatorFilters}
              ownerIsHidden={isHiddenOverride(drawerOwnerOverride)}
              onSaveOwnerDetails={handleSaveOwnerDetails}
              onRemoveOwner={handleRemoveOwner}
              onRestoreOwner={handleRestoreOwner}
              onClose={() => {
                setDrawerOwner(null)
                setDrawerTractLabel(null)
                setExpandedOwner(null)
              }}
              onSkipTrace={(o) => handleSkipTrace(o as TractOwner)}
              onAddToPipeline={(o) => handleAddToPipeline(o as TractOwner)}
              onShowAllTracts={(o) => {
                setDrawerOwner(null)
                setDrawerTractLabel(null)
                setExpandedOwner(null)
                setOwnerTractsName(o.owner_name)
              }}
            />
          </div>
        )}
        {/* Left panel */}
        <div
          data-tour="owner-panel"
          style={{
            width: drawerOwner ? 0 : (isMobile ? '100%' : 'clamp(300px, 30vw, 420px)'),
            minWidth: drawerOwner ? 0 : (isMobile ? 0 : 'clamp(300px, 30vw, 420px)'),
            background: 'var(--mm-chrome-surface)',
            borderRight: drawerOwner ? 'none' : (isMobile ? 'none' : '1px solid var(--mm-chrome-border)'),
            borderTop: isMobile ? '1px solid var(--mm-chrome-border)' : 'none',
            overflowY: 'auto',
            padding: drawerOwner ? 0 : 14,
            order: isMobile ? 2 : 1,
            maxHeight: isMobile ? '52dvh' : 'none',
            display: drawerOwner ? 'none' : undefined,
            transition: 'width 0.2s ease',
          }}
        >
          {selected ? (
            <div>
              <button
                onClick={() => {
                  setSelected(null)
                  // If we're in an owner-tracts session, keep the list so the
                  // user can pick a different tract for the same owner.
                  if (!ownerTractsName) {
                    setOwnerTracts([])
                    setOwnerTractsName('')
                  }
                }}
                style={{
                  border: 'none',
                  background: 'none',
                  color: 'var(--mm-chrome-muted)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: '12px 16px',
                  marginBottom: 4,
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                }}
              >
                ← Back
              </button>

              <div
                style={{
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--mm-chrome-muted)',
                  letterSpacing: '0.05em',
                }}
              >
                {abstractLabel}
              </div>
              <div style={{ marginTop: 8 }}>
                {legalSystemLine && (
                  <div
                    style={{
                      fontFamily: 'Geist, Inter, system-ui, sans-serif',
                      fontSize: 11,
                      color: 'var(--mm-chrome-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      marginBottom: 2,
                    }}
                  >
                    {legalSystemLine}
                  </div>
                )}
                {legalSectionLine && (
                  <div
                    style={{
                      fontFamily: 'Geist, Inter, system-ui, sans-serif',
                      fontSize: 18,
                      fontWeight: 700,
                      color: 'var(--mm-chrome-fg)',
                      letterSpacing: '-0.01em',
                      marginBottom: 2,
                      lineHeight: 1.3,
                    }}
                  >
                    {legalSectionLine}
                  </div>
                )}
                {legalGranteeLine && (
                  <div
                    style={{
                      fontFamily: 'Geist, Inter, system-ui, sans-serif',
                      fontSize: 11,
                      color: 'var(--mm-chrome-muted)',
                    }}
                  >
                    {legalGranteeLine}
                  </div>
                )}
              </div>
              <div style={{ borderTop: '1px solid #E5E7EB', marginTop: 12, marginBottom: 10 }} />

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 12, background: 'rgba(239,159,39,0.15)', color: '#EF9F27', border: '0.5px solid rgba(239,159,39,0.35)' }}>
                  {ownerCount} owners
                </span>
                <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 12, background: 'var(--mm-chrome-muted-fill)', color: 'var(--mm-chrome-muted)', border: '1px solid var(--mm-chrome-border)' }}>
                  {topOperator}
                </span>
              </div>

              <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
                <button
                  onClick={() => setPermitsExpanded((prev) => !prev)}
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#2563EB', fontSize: 12, fontWeight: 600, letterSpacing: '0.02em' }}>
                      NEW PERMITS
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 999,
                        background: visiblePermits.length > 0 ? '#DBEAFE' : '#F3F4F6',
                        color: visiblePermits.length > 0 ? '#1D4ED8' : '#9CA3AF',
                        border: `1px solid ${visiblePermits.length > 0 ? '#93C5FD' : '#E5E7EB'}`,
                        fontFamily: 'Geist, Inter, system-ui, sans-serif',
                        fontWeight: 600,
                      }}
                    >
                      {countyPermitsLoading ? '…' : visiblePermits.length}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                      last 90 days
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--mm-chrome-muted)',
                      transform: permitsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}
                  >
                    ▼
                  </span>
                </button>
                {permitsExpanded && (
                  <div style={{ borderTop: '1px solid var(--mm-chrome-border)', padding: '4px 0 8px' }}>
                    {countyPermitsLoading ? (
                      <div style={{ padding: '10px 16px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontStyle: 'italic', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                        Loading permits…
                      </div>
                    ) : visiblePermits.length === 0 ? (
                      <div style={{ padding: '10px 16px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                        No permits filed on this tract in the last 90 days.
                      </div>
                    ) : (
                      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                        {visiblePermits.slice(0, 50).map((permit) => {
                          const status = String(permit.status ?? '').toUpperCase()
                          const isPending = status.includes('PEND') || status.includes('FILED')
                          const statusFg = isPending ? '#1E40AF' : '#1D4ED8'
                          const statusBg = isPending ? '#EFF6FF' : '#DBEAFE'
                          const statusLabel = isPending ? 'Pending' : (status || 'Approved')
                          const filed = String(permit.filed_date ?? permit.approved_date ?? '').slice(0, 10)
                          const lease = String(permit.lease_name ?? '').trim()
                          const operator = String(permit.operator_name ?? '').trim()
                          const permitNumber = String(permit.permit_number ?? '').trim()
                          const api = String(permit.api_number ?? '').trim()
                          return (
                            <div
                              key={`permit-${permit.id}`}
                              style={{
                                padding: '10px 16px',
                                borderTop: '1px solid #F9FAFB',
                                display: 'flex',
                                gap: 8,
                                alignItems: 'flex-start',
                                justifyContent: 'space-between',
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    color: 'var(--mm-chrome-fg)',
                                    fontFamily: 'Geist, Inter, system-ui, sans-serif',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {lease || (permitNumber ? `Permit ${permitNumber}` : api ? `API ${api}` : 'Unnamed permit')}
                                </div>
                                {operator && (
                                  <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif', marginTop: 2 }}>
                                    {operator}
                                  </div>
                                )}
                                <div style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif', marginTop: 3, display: 'flex', gap: 8 }}>
                                  {filed && <span>Filed {filed}</span>}
                                  {api && <span>API {api}</span>}
                                  {permitNumber && <span>#{permitNumber}</span>}
                                </div>
                              </div>
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '2px 8px',
                                  borderRadius: 999,
                                  background: statusBg,
                                  color: statusFg,
                                  border: `1px solid ${isPending ? '#93C5FD' : '#2563EB'}`,
                                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap',
                                  alignSelf: 'flex-start',
                                }}
                              >
                                {statusLabel}
                              </span>
                            </div>
                          )
                        })}
                        {visiblePermits.length > 50 && (
                          <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontFamily: 'Geist, Inter, system-ui, sans-serif', fontStyle: 'italic', textAlign: 'center' }}>
                            + {visiblePermits.length - 50} more (RRC daily scrape)
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Operator moved up here (under New Permits). */}
              <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 12, color: 'var(--mm-chrome-fg)' }}>
                  <span style={{ color: 'var(--mm-chrome-muted)' }}>Operator: </span>
                  <span style={{ fontWeight: 600 }}>{selected.top_operator || 'Unknown'}</span>
                </div>
              </div>

              {/* Development breakdown — replaces the old Operator & Lease Info
                  box. Shows the tract's status plus EVERY contributing RRC
                  signal (a tract can have DUC + infill + adjacent PDP at once). */}
              {(() => {
                const dev = selectedTractDevStatus
                const sd = dev?.signal_detail ?? {}
                const META: Record<string, { label: string; color: string; bg: string; border: string }> = {
                  PDP: { label: 'PDP — Producing', color: '#92400E', bg: 'rgba(234,179,8,0.14)', border: 'rgba(234,179,8,0.45)' },
                  PUD_DUC: { label: 'DUC — Drilled, uncompleted', color: '#6B21A8', bg: 'rgba(168,85,247,0.14)', border: 'rgba(168,85,247,0.45)' },
                  PUD_INFILL: { label: 'Infill candidate', color: '#9A3412', bg: 'rgba(249,115,22,0.14)', border: 'rgba(249,115,22,0.45)' },
                  PUD_PERMITTED: { label: 'PUD — Permitted', color: '#065F46', bg: 'rgba(16,185,129,0.14)', border: 'rgba(16,185,129,0.45)' },
                  LEASING_ACTIVE: { label: 'Leasing active', color: '#065F46', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.35)' },
                  FRONTIER: { label: 'Frontier — undeveloped', color: '#475569', bg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.3)' },
                }
                const statusKey = dev?.development_status ?? 'FRONTIER'
                const meta = META[statusKey] ?? META.FRONTIER
                const d10 = (v?: string | null) => (v ? String(v).slice(0, 10) : '')
                const permits = sd.permits ?? []
                const ducs = sd.ducs ?? []
                const infill = sd.infill_gaps ?? 0
                const adjPdp = sd.adjacent_pdp_count ?? 0
                const adjPdpOps = sd.adjacent_pdp_operators ?? []
                const adjPermits = sd.adjacent_permit_count ?? 0
                const adjPermitOps = sd.adjacent_permits ?? []
                const leases = sd.leases ?? []
                const opNames = (arr: Array<{ operator?: string | null; count?: number }>) =>
                  arr.map((o) => o.operator).filter(Boolean).slice(0, 4).join(', ')
                const sectionTitle = { fontSize: 11, fontWeight: 700, color: 'var(--mm-chrome-fg)', marginTop: 10 }
                const rowStyle = { fontSize: 11, color: 'var(--mm-chrome-muted)', marginTop: 3, lineHeight: 1.35 }
                const hasAny =
                  permits.length > 0 || ducs.length > 0 || infill > 0 ||
                  adjPdp > 0 || adjPermits > 0 || leases.length > 0
                return (
                  <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, padding: 12, marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ color: '#EF9F27', fontSize: 12, fontWeight: 600 }}>DEVELOPMENT</span>
                      <span style={{ fontSize: 10, color: 'var(--mm-chrome-muted)' }} title="Texas Railroad Commission signals, refreshed nightly">
                        RRC · score {dev?.pud_score ?? 0}/10
                      </span>
                    </div>
                    <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: meta.bg, color: meta.color, border: `0.5px solid ${meta.border}` }}>
                      {meta.label}
                    </span>

                    {/* DUCs */}
                    {ducs.length > 0 && (
                      <div>
                        <div style={sectionTitle}>Drilled / uncompleted (DUC) · {ducs.length}</div>
                        {ducs.slice(0, 6).map((w, i) => (
                          <div key={`duc-${i}`} style={rowStyle}>
                            {[w.operator, w.lease].filter(Boolean).join(' · ') || 'Well'}
                            {w.api ? ` · API ${w.api}` : ''}
                            {w.spud_date ? ` · spud ${d10(w.spud_date)}` : (w.status ? ` · ${w.status}` : '')}
                          </div>
                        ))}
                        {ducs.length > 6 && <div style={rowStyle}>+ {ducs.length - 6} more</div>}
                      </div>
                    )}

                    {/* Permits on this tract */}
                    {permits.length > 0 && (
                      <div>
                        <div style={sectionTitle}>Permits on tract · {permits.length}</div>
                        {permits.slice(0, 6).map((p, i) => (
                          <div key={`perm-${i}`} style={rowStyle}>
                            {[p.operator, p.lease].filter(Boolean).join(' · ') || (p.permit_number ? `Permit ${p.permit_number}` : 'Permit')}
                            {p.status ? ` · ${p.status}` : ''}
                            {p.api ? ` · API ${p.api}` : ''}
                            {(() => {
                              const dd = d10(p.completion_date) ? `completed ${d10(p.completion_date)}`
                                : d10(p.spud_date) ? `spud ${d10(p.spud_date)}`
                                : d10(p.approved_date) ? `approved ${d10(p.approved_date)}`
                                : d10(p.filed_date) ? `filed ${d10(p.filed_date)}` : ''
                              return dd ? ` · ${dd}` : ''
                            })()}
                          </div>
                        ))}
                        {permits.length > 6 && <div style={rowStyle}>+ {permits.length - 6} more</div>}
                      </div>
                    )}

                    {/* Infill */}
                    {infill > 0 && (
                      <div>
                        <div style={sectionTitle}>Infill candidate</div>
                        <div style={rowStyle}>{infill} spacing‑gap{infill === 1 ? '' : 's'} vs. neighboring wells (offset spacing math)</div>
                      </div>
                    )}

                    {/* Adjacent PDP (within ~1 mi) */}
                    {adjPdp > 0 && (
                      <div>
                        <div style={sectionTitle}>Producing offsets · {adjPdp} within ~1 mi</div>
                        {opNames(adjPdpOps) && <div style={rowStyle}>{opNames(adjPdpOps)}</div>}
                      </div>
                    )}

                    {/* Adjacent permits */}
                    {adjPermits > 0 && (
                      <div>
                        <div style={sectionTitle}>Nearby permitting · {adjPermits} adjacent tract{adjPermits === 1 ? '' : 's'}</div>
                        {opNames(adjPermitOps) && <div style={rowStyle}>{opNames(adjPermitOps)}</div>}
                      </div>
                    )}

                    {/* Fresh leasing */}
                    {leases.length > 0 && (
                      <div>
                        <div style={sectionTitle}>Recent lease memos · {leases.length}</div>
                        {leases.slice(0, 4).map((l, i) => (
                          <div key={`lease-${i}`} style={rowStyle}>
                            {[l.lessee, l.lessor].filter(Boolean).join(' → ') || 'Lease memo'}
                            {l.memo_date ? ` · ${d10(l.memo_date)}` : ''}
                          </div>
                        ))}
                      </div>
                    )}

                    {(sd.operator_committed || sd.operator_program_hit) && (
                      <div style={rowStyle}>✓ Operator commitment signal (active drilling program nearby)</div>
                    )}

                    {!hasAny && (
                      <div style={{ ...rowStyle, marginTop: 8 }}>
                        No drilling, permit, or leasing activity recorded on this tract.
                      </div>
                    )}

                    <div style={{ fontSize: 9, color: 'var(--mm-chrome-muted)', marginTop: 10, fontStyle: 'italic' }}>
                      Source: Texas RRC permits + wellbores, refreshed nightly.
                    </div>
                  </div>
                )
              })()}

              {(tractWellsLoaded || tractWellsLoading) && (
                <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
                  <div style={{ borderTop: '1px solid var(--mm-chrome-border)' }}>
                    <button
                      onClick={() => setWellsExpanded(!wellsExpanded)}
                      style={{
                        width: '100%',
                        padding: '10px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: 'var(--mm-chrome-muted)',
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                      }}>
                        Wells in this tract ({tractWells.length})
                      </div>
                      <div style={{
                        fontSize: 10,
                        color: 'var(--mm-chrome-muted)',
                        transform: wellsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                      }}>
                        ▼
                      </div>
                    </button>

                    {wellsExpanded && (
                      <div style={{ paddingBottom: 8 }}>
                        {tractWellsLoading && (
                          <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontStyle: 'italic' }}>
                            Loading tract wells...
                          </div>
                        )}
                        {!tractWellsLoading && tractWells.length === 0 && (
                          <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--mm-chrome-muted)', fontStyle: 'italic' }}>
                            No wells matched this tract
                          </div>
                        )}
                        {!tractWellsLoading && tractWells.map((well, i) => (
                          <div
                            key={`${well.rrc_lease_id ?? well.lease_name ?? 'well'}-${i}`}
                            style={{
                              padding: '6px 16px',
                              borderBottom: '1px solid #F9FAFB',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 8,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--mm-chrome-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {well.lease_name}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)' }}>
                                {well.operator_name}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              {well.kind && WELL_KIND_BADGE[well.kind] ? (
                                <span
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: WELL_KIND_BADGE[well.kind].bg,
                                    color: WELL_KIND_BADGE[well.kind].color,
                                    border: `1px solid ${WELL_KIND_BADGE[well.kind].border}`,
                                  }}
                                >
                                  {WELL_KIND_BADGE[well.kind].label}
                                </span>
                              ) : (
                                <span
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: well.oil_gas_code === 'G' ? '#EFF6FF' : '#FEF3C7',
                                    color: well.oil_gas_code === 'G' ? '#1D4ED8' : '#92400E',
                                    border: `1px solid ${well.oil_gas_code === 'G' ? '#BFDBFE' : '#FDE68A'}`,
                                  }}
                                >
                                  {well.oil_gas_code === 'G' ? 'GAS' : 'OIL'}
                                </span>
                              )}
                              <span
                                style={{
                                  fontSize: 9,
                                  fontWeight: 600,
                                  padding: '1px 5px',
                                  borderRadius: 3,
                                  background: well.well_type === 'HORIZONTAL' ? '#FEF3C7' : '#F9FAFB',
                                  color: well.well_type === 'HORIZONTAL' ? '#EF9F27' : '#6B7280',
                                  border: `1px solid ${well.well_type === 'HORIZONTAL' ? '#FDE68A' : '#E5E7EB'}`,
                                }}
                              >
                                {well.well_type === 'HORIZONTAL' ? 'H' : 'V'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--mm-chrome-border)',
                  background: 'var(--mm-chrome-surface)',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--mm-chrome-muted)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  All owners in tract ({dbOwnersLoading ? 'loading…' : displayedOwners.length})
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  {hiddenOwnerCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowHiddenOwners((v) => !v)}
                      title="Owners you removed stay in CAD; toggle to review them"
                      style={{
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'Geist, Inter, system-ui, sans-serif',
                        fontWeight: 600,
                        background: showHiddenOwners ? '#FFE4E6' : 'transparent',
                        border: '1px solid #FECDD3',
                        color: '#BE123C',
                      }}
                    >
                      {showHiddenOwners ? 'Hide removed' : `${hiddenOwnerCount} removed`}
                    </button>
                  )}
                  {([
                    { key: 'az',       label: 'A–Z',    title: 'Sort owners A to Z' },
                    { key: 'za',       label: 'Z–A',    title: 'Sort owners Z to A' },
                    { key: 'largest',  label: 'Largest', title: 'Largest to smallest by NMA' },
                    { key: 'smallest', label: 'Smallest', title: 'Smallest to largest by NMA' },
                  ] as const).map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setOwnerSort(s.key)}
                      title={s.title}
                      style={{
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'Geist, Inter, system-ui, sans-serif',
                        fontWeight: ownerSort === s.key ? 600 : 400,
                        background: ownerSort === s.key ? '#EF9F27' : 'transparent',
                        border: ownerSort === s.key ? '1px solid #EF9F27' : '1px solid #E5E7EB',
                        color: ownerSort === s.key ? '#fff' : '#6B7280',
                        transition: 'all 0.15s',
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="text"
                value={ownerNameQuery}
                onChange={(e) => setOwnerNameQuery(e.target.value)}
                placeholder="Search owners by name, city, state, operator…"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  margin: '0 0 8px',
                  padding: '7px 10px',
                  fontSize: 12,
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                  borderRadius: 8,
                  border: '1px solid var(--mm-chrome-border)',
                  background: 'var(--mm-chrome-panel)',
                  color: 'var(--mm-chrome-text)',
                  outline: 'none',
                }}
              />
              <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                {dbOwnersLoading && displayedOwners.length === 0 && (
                  <div style={{ padding: '12px', fontSize: 12, color: 'var(--mm-chrome-muted)' }}>
                    Loading owners…
                  </div>
                )}
                {displayedOwners.map((owner: TractOwner, i: number) => {
                  const isExpanded = expandedOwner === i
                  const normalizedOwnerName = String(owner.owner_name ?? '').trim().toUpperCase()
                  const isHighlighted = highlightedOwner === normalizedOwnerName
                  const operatorHit = Boolean(
                    selectedOperatorFilters.length > 0 &&
                      operatorMatchesAny(owner.operator_name, selectedOperatorFilters),
                  )
                  const ownerElementId = ownerRowDomId(String(owner.owner_name ?? ''))
                  const ownerKey = String(owner.id ?? `${normalizedOwnerName}-${normalizeLeaseId(owner.rrc_lease_id) || i}`)
                  // ownerWells / ownerWellsLoading are still populated when a
                  // user clicks a row so the follow-up drawer render doesn't
                  // have to wait — the sidebar just no longer displays them
                  // inline. Wells now live in OwnerDrawer.
                  void ownerWells[ownerKey]
                  void ownerWellsLoading[ownerKey]
                  const ownerType = classifyOwner(String(owner.owner_name ?? ''))
                  const typeColor = ownerType === 'trust' ? '#7AB835' : ownerType === 'company' ? '#378ADD' : '#9CA3AF'
                  const typeLabel = ownerType === 'trust' ? 'TRUST' : ownerType === 'company' ? 'CO' : 'IND'
                  const nra = getNRA(owner, selected, county)
                  const royaltyEstimate = estimateMonthlyRoyalty(
                    owner,
                    selected,
                    county.ownershipPctIsDecimal
                  )
                  const ownershipPctValue = getOwnershipPctValue(
                    owner,
                    county.ownershipPctIsDecimal
                  )
                  const ownershipDecimalValue = ownershipPctValue / 100
                  const rowOverride = pickOwnerOverride(
                    ownerOverrides,
                    owner.owner_name,
                    tractAbstractForOverrides,
                  )
                  const rowHidden = isHiddenOverride(rowOverride)
                  const rowDisplayName =
                    (owner.display_name || owner.owner_name || '').trim() || owner.owner_name

                  return (
                    <div
                      key={`${owner.owner_name}-${i}`}
                      style={{
                        borderBottom: '1px solid var(--mm-chrome-border)',
                        opacity: rowHidden
                          ? 0.55
                          : selectedOperatorFilters.length > 0 && !operatorHit
                            ? 0.45
                            : 1,
                      }}
                    >
                      <div
                        id={ownerElementId}
                        onClick={() => {
                          // Clicking an owner now opens the bottom
                          // drawer (OwnerDrawer) instead of the old
                          // inline score-signals expander. The
                          // legacy expandedOwner state is kept in
                          // sync so any downstream code that reads
                          // it keeps working; only the DOM branch
                          // that used to render the inline body has
                          // been removed.
                          setDrawerOwner(owner)
                          setDrawerTractLabel(
                            String(
                              selected?.ABSTRACT_L
                                ?? selected?.abstract_label
                                ?? '',
                            ).trim() || null,
                          )
                          setExpandedOwner(i)
                          void fetchOwnerWells(owner, ownerKey)
                          trackEvent('owner_drawer_opened', {
                            owner_name: owner.owner_name,
                            abstract: selected?.ABSTRACT_L ?? selected?.abstract_label ?? '',
                          })
                        }}
                        style={{
                          padding: '10px 16px',
                          cursor: 'pointer',
                          background: operatorHit
                            ? '#FEF3C7'
                            : isHighlighted
                              ? '#FEF3C7'
                              : isExpanded
                                ? '#FFFBEB'
                                : 'transparent',
                          borderLeft: operatorHit || isHighlighted
                            ? '3px solid #EF9F27'
                            : '3px solid transparent',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          if (!isExpanded && !isHighlighted && !operatorHit) {
                            e.currentTarget.style.background = '#F9FAFB'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded && !isHighlighted && !operatorHit) {
                            e.currentTarget.style.background = 'transparent'
                          }
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, marginRight: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mm-chrome-fg)', lineHeight: 1.3 }}>
                              {i + 1}. {rowDisplayName}
                              {operatorHit && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: '0.04em',
                                    textTransform: 'uppercase',
                                    color: '#B45309',
                                    background: '#FDE68A',
                                    border: '1px solid #F59E0B',
                                    borderRadius: 4,
                                    padding: '1px 5px',
                                    verticalAlign: 'middle',
                                  }}
                                  title={`CAD operator: ${owner.operator_name || ''}`}
                                >
                                  Operator match
                                </span>
                              )}
                              {rowHidden && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 9,
                                    fontWeight: 700,
                                    color: '#BE123C',
                                    background: '#FFE4E6',
                                    border: '1px solid #FECDD3',
                                    borderRadius: 4,
                                    padding: '1px 5px',
                                    verticalAlign: 'middle',
                                  }}
                                >
                                  Removed
                                </span>
                              )}
                            </div>
                            {tractLegalDescription && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: 'var(--mm-chrome-muted)',
                                  fontFamily: 'monospace',
                                  marginTop: 2,
                                  letterSpacing: '0.02em',
                                }}
                              >
                                {tractLegalDescription}
                              </div>
                            )}
                            {owner.operator_name?.trim() && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: operatorHit ? '#B45309' : '#9CA3AF',
                                  marginTop: 2,
                                  fontWeight: operatorHit ? 600 : 400,
                                }}
                                title={`CAD tax-roll operator: ${owner.operator_name.trim()}`}
                              >
                                Op: {canonicalOperatorLabel(owner.operator_name)}
                              </div>
                            )}
                            <div style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', marginTop: 2 }}>
                              {owner.mailing_city && owner.mailing_state
                                ? `${owner.mailing_city}, ${owner.mailing_state}`
                                : 'Address unknown'}
                            </div>
                            {nra !== null && nra > 0 && (
                              <div
                                style={{ fontSize: 10, color: 'var(--mm-chrome-fg)', fontFamily: 'monospace', fontWeight: 600 }}
                                title={royaltyEstimate ? `Est. royalty: ${royaltyEstimate}` : undefined}
                              >
                                {nra < 0.01
                                  ? `${nra.toFixed(4)} NMA`
                                  : nra < 1
                                    ? `${nra.toFixed(3)} NMA`
                                    : `${nra.toFixed(2)} NMA`}
                                {!Number(owner.acreage) && (
                                  <span style={{ fontSize: 9, color: 'var(--mm-chrome-muted)', marginLeft: 3 }}>est.</span>
                                )}
                              </div>
                            )}
                            {ownershipPctValue > 0 && (() => {
                              // Gross acres for the lease/tract. Owner.acreage
                              // is the lease's gross acreage from the CAD roll
                              // (e.g. "442" on a Martin lease); fall back to
                              // SHAPE_AREA-derived tract acreage when missing.
                              const ownerAcres = Number(owner.acreage ?? 0)
                              const grossAcres = ownerAcres > 0
                                ? ownerAcres
                                : getTractGrossAcres(selected)
                              const acresLabel = grossAcres > 0
                                ? grossAcres >= 100
                                  ? grossAcres.toLocaleString(undefined, { maximumFractionDigits: 0 })
                                  : grossAcres.toFixed(1)
                                : null
                              return (
                                <>
                                  <div style={{ fontSize: 10, color: 'var(--mm-chrome-muted)' }}>
                                    {acresLabel
                                      ? `${ownershipPctValue.toFixed(4)}% interest on ${acresLabel} gross acres`
                                      : `${ownershipPctValue.toFixed(4)}% interest`}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10 }}>
                                    <span style={{ color: 'var(--mm-chrome-muted)' }}>DO Interest:</span>
                                    <span style={{ color: 'var(--mm-chrome-fg)', fontFamily: 'monospace', fontWeight: 600 }}>
                                      {ownershipDecimalValue.toFixed(6)}
                                    </span>
                                    <span style={{ color: 'var(--mm-chrome-muted)' }}>
                                      ({ownershipPctValue.toFixed(4)}%)
                                    </span>
                                  </div>
                                </>
                              )
                            })()}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: `${typeColor}15`, color: typeColor, border: `0.5px solid ${typeColor}30` }}>
                              {typeLabel}
                            </span>
                            {owner.out_of_state && (
                              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: 'rgba(239,159,39,0.12)', color: '#B45309', border: '0.5px solid rgba(239,159,39,0.3)' }}>OOS</span>
                            )}
                            {selectedTractDevStatus && (
                              selectedTractDevStatus.development_status === 'PUD_DUC' ||
                              selectedTractDevStatus.development_status === 'PUD_PERMITTED'
                            ) && (
                              <span
                                style={{
                                  fontSize: 9,
                                  padding: '1px 5px',
                                  borderRadius: 6,
                                  background: selectedTractDevStatus.development_status === 'PUD_DUC'
                                    ? 'rgba(168,85,247,0.14)'
                                    : 'rgba(249,115,22,0.14)',
                                  color: selectedTractDevStatus.development_status === 'PUD_DUC'
                                    ? '#6B21A8'
                                    : '#9A3412',
                                  border: `0.5px solid ${
                                    selectedTractDevStatus.development_status === 'PUD_DUC'
                                      ? 'rgba(168,85,247,0.4)'
                                      : 'rgba(249,115,22,0.4)'
                                  }`,
                                  whiteSpace: 'nowrap',
                                }}
                                title={`Development ${selectedTractDevStatus.development_status === 'PUD_DUC' ? 'DUC' : 'permitted'} · pud_score ${selectedTractDevStatus.pud_score}/10`}
                              >
                                ⚡ Dev pending
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--mm-chrome-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span aria-hidden style={{ display: 'inline-block', transform: isExpanded ? 'translateY(-1px)' : 'none', transition: 'transform 0.15s', color: isExpanded ? '#EF9F27' : '#9CA3AF' }}>
                            ↗
                          </span>
                          {isExpanded ? 'Open in detail drawer' : 'Click to open details'}
                        </div>
                      </div>
                      {/* Inline score-signals + wells expansion was removed;
                          the full detail lives in OwnerDrawer at the bottom
                          of the viewport (rendered below the map). */}
                    </div>
                  )
                })}
                {!dbOwnersLoading && displayedOwners.length === 0 && (
                  <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--mm-chrome-muted)', lineHeight: 1.55 }}>
                    {(() => {
                      const q = ownerNameQuery.trim()
                      // Search returned nothing but the tract does have owners.
                      if (q && cleanOwnersList.length > 0) {
                        return `No owners on this tract match “${q}”.`
                      }
                      const label = String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '')
                      // West Texas Block/Section grid (e.g. "B10--S5") = University /
                      // State survey lands: mineral title is retained by the State of
                      // Texas / University Lands, so no private royalty owners appear
                      // in the county appraisal roll even where wells are producing.
                      const isUniversityBlock = /^B\d+--S/i.test(label)
                      const hasWells = tractWells.length > 0
                      if (isUniversityBlock) {
                        return hasWells
                          ? 'No private mineral owners are on file for this University / State survey tract. The wells here are held under a state lease — mineral title is retained by the State of Texas / University Lands, so no private royalty owners appear in the county roll.'
                          : 'No private mineral owners are on file for this University / State survey tract. Mineral title is typically retained by the State of Texas / University Lands.'
                      }
                      return hasWells
                        ? 'No mineral owners are on file for this tract in the county appraisal roll, though wells are present here — the acreage is often held under lease.'
                        : 'No mineral owners are on file for this tract in the county appraisal roll.'
                    })()}
                  </div>
                )}
              </div>

              {displayedOwners.length > 0 && (
                <div style={{ display: 'flex', marginTop: 14 }}>
                  <button style={{ width: '100%', padding: '9px', borderRadius: 6, border: '0.5px solid rgba(239,159,39,0.4)', background: 'rgba(239,159,39,0.15)', color: '#EF9F27', cursor: 'pointer', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                    Add all to pipeline
                  </button>
                </div>
              )}
            </div>
          ) : ownerTractsName ? (
            <div>
              <button
                onClick={() => {
                  setOwnerTracts([])
                  setOwnerTractsName('')
                  setOwnerTractsLoading(false)
                }}
                style={{
                  border: 'none',
                  background: 'none',
                  color: 'var(--mm-chrome-muted)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: '12px 16px',
                  marginBottom: 4,
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                }}
              >
                ← Back
              </button>

              <div style={{ padding: '0 16px 12px' }}>
                <div style={{ fontFamily: 'Geist, Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 700, color: 'var(--mm-chrome-fg)', marginBottom: 4 }}>
                  {ownerTractsName}
                </div>
                <div style={{ fontSize: 12, color: 'var(--mm-chrome-muted)', marginBottom: 12, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                  {ownerTractsLoading
                    ? 'Looking up tracts…'
                    : `${ownerTracts.length} tract${ownerTracts.length !== 1 ? 's' : ''} found`}
                </div>
              </div>

              {ownerTracts.length > 0 && (
                <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, overflow: 'hidden', margin: '0 14px' }}>
                  {ownerTracts.map((tract, i) => {
                    const abstractLabel = tract.ABSTRACT_L ?? tract.abstract_label ?? 'Unknown'
                    const operator = tract.top_operator ?? ''
                    return (
                      <div
                        key={`${abstractLabel}-${i}`}
                        onClick={() => {
                          setSelected(tract)
                          setOwnerSort('az')
                          setExpandedOwner(null)
                          setHighlightedOwner(ownerTractsName.toUpperCase())
                          setTimeout(() => {
                            const el = document.getElementById(ownerRowDomId(ownerTractsName))
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          }, 400)
                          setTimeout(() => setHighlightedOwner(null), 3000)
                          setMapFocusTarget({
                            leaseId: null,
                            ownerName: ownerTractsName,
                            nonce: Date.now(),
                          })
                        }}
                        style={{
                          padding: '10px 16px',
                          cursor: 'pointer',
                          borderBottom: i < ownerTracts.length - 1 ? '1px solid #F3F4F6' : 'none',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#F9FAFB' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ minWidth: 0, flex: 1, marginRight: 10 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mm-chrome-fg)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                              {abstractLabel}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', marginTop: 2, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                              {operator}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {!ownerTractsLoading && ownerTracts.length === 0 && (
                <div style={{ padding: '16px', color: 'var(--mm-chrome-muted)', fontSize: 12, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                  No mapped tracts found.
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontFamily: 'Geist, Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 700, color: 'var(--mm-chrome-fg)', marginBottom: mapLevel === 'county' ? 4 : 16 }}>
                {mapLevel === 'county' ? 'All Counties' : 'County Overview'}
              </div>
              {mapLevel === 'county' && (
                <div style={{ color: 'var(--mm-chrome-muted)', fontSize: 12, marginBottom: 16, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                  Click any highlighted county to explore
                </div>
              )}

              {mapLevel === 'tract' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {liveCountyStatEntries.map((card, idx, arr) => {
                    // If the total count is odd, stretch the last card
                    // across both columns so we don't leave a lone card
                    // hanging in the second row. With the "Active wells"
                    // card removed we're at 5 stat cards, so the 5th
                    // (Survey abstracts) spans the row.
                    const isLastOdd = idx === arr.length - 1 && arr.length % 2 === 1
                    return (
                      <div
                        key={card.lbl}
                        style={{
                          background: 'var(--mm-chrome-panel)',
                          borderRadius: 8,
                          border: '1px solid var(--mm-chrome-border)',
                          padding: '14px 16px',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                          gridColumn: isLastOdd ? 'span 2' : undefined,
                        }}
                      >
                        <div
                          style={{
                            color: 'var(--mm-chrome-fg)',
                            fontFamily: '"Times New Roman", Georgia, serif',
                            fontSize: 24,
                            fontWeight: 700,
                            letterSpacing: '0.02em',
                            fontVariantNumeric: 'tabular-nums lining-nums',
                            fontFeatureSettings: '"tnum" 1, "lnum" 1',
                          }}
                        >
                          {card.val}
                        </div>
                        <div style={{ color: 'var(--mm-chrome-muted)', fontSize: 11, marginTop: 2, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>{card.lbl}</div>
                      </div>
                    )
                  })}
                </div>
              )}

              {mapLevel === 'county' && (
                <>
                  {/* Real-time commodity prices — WTI Crude + Henry Hub
                     Natural Gas. Polled from /api/market/prices every
                     60s. Sits at the top of the sidebar so brokers
                     have live market context before they scan the
                     county list below. */}
                  <MarketPricesWidget />

                  {/* Basin-wide drilling activity — rigs drilling,
                     permits filed (30d), wells completed (30d).
                     Aggregated from every active county's permits
                     table by /api/basin/activity and expandable to
                     show per-county contributions. */}
                  <BasinActivityWidget />

                  <div style={{ marginTop: 4, marginBottom: 10, fontSize: 10, fontWeight: 600, color: 'var(--mm-chrome-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                    ACTIVE COUNTIES
                  </div>
                  <div>
                    {Object.values(COUNTIES).map((c) => {
                      const live = liveCountyStats[c.id as CountyKey]
                      const owners = live?.totalOwners
                      const permits24mo = live?.newPermits
                      return (
                        <div
                          key={c.id}
                          onClick={() => {
                            const key = c.id as CountyKey
                            setSelected(null)
                            setSelectedCounty(key)
                            setMapLevel('tract')
                            flyToCountyView(key)
                          }}
                          style={{
                            background: 'var(--mm-chrome-panel)',
                            border: '1px solid var(--mm-chrome-border)',
                            borderRadius: 8,
                            padding: 12,
                            marginBottom: 8,
                            cursor: 'pointer',
                            transition: 'border-color 0.15s',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 10,
                          }}
                          onMouseEnter={(event) => {
                            event.currentTarget.style.borderColor = '#EF9F27'
                          }}
                          onMouseLeave={(event) => {
                            event.currentTarget.style.borderColor = '#E5E7EB'
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--mm-chrome-fg)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                              {c.displayName}
                            </div>
                            {live ? (
                              <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', marginTop: 2, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                                {owners != null ? owners.toLocaleString() : '—'} owners
                                {permits24mo != null && permits24mo > 0 && (
                                  <>{' · '}<span style={{ color: '#1D4ED8', fontWeight: 500 }}>{permits24mo.toLocaleString()} new permits</span></>
                                )}
                              </div>
                            ) : (
                              <div style={{ fontSize: 11, color: '#D1D5DB', marginTop: 2, fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                                Loading…
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div style={{ marginTop: 18, marginBottom: 10, fontSize: 10, fontWeight: 600, color: 'var(--mm-chrome-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                    Coming Soon
                  </div>
                  <div>
                    {UPCOMING_PERMIAN_COUNTIES.map((name) => (
                      <div
                        key={name}
                        style={{
                          background: '#F8FAFC',
                          border: '1px dashed #CBD5E1',
                          borderRadius: 8,
                          padding: '10px 12px',
                          marginBottom: 6,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 10,
                          cursor: 'not-allowed',
                        }}
                        title="Data ships soon — check back in a few weeks"
                      >
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                          {name}
                        </div>
                        <div style={{
                          fontSize: 9,
                          fontWeight: 600,
                          color: '#94A3B8',
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          background: 'var(--mm-chrome-panel)',
                          border: '1px solid #E2E8F0',
                          borderRadius: 999,
                          padding: '3px 8px',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}>
                          Coming soon
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {mapLevel === 'tract' && (
              <>
              <div style={{ marginTop: 18, marginBottom: 10, fontSize: 10, fontWeight: 600, color: 'var(--mm-chrome-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                TOP 10 MOST ACTIVE TRACTS
              </div>
              <div
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  maxHeight: 340,
                  overflowY: 'auto',
                }}
              >
                {topTracts.map((tract, index) => (
                  <div
                    key={`${tract.abstract_label}-${tract.level1_sur}-${index}`}
                    onClick={() => {
                      setSelected(toTractSelection(tract))
                      setOwnerSort('az')
                      setExpandedOwner(null)
                      trackEvent('tract_clicked', {
                        abstract: tract.abstract_label,
                        owner_count: tract.owner_count,
                        production_status: tract.production_status ?? 'none',
                        well_count: tract.well_count ?? 0,
                      })
                    }}
                    style={{
                      background: 'var(--mm-chrome-panel)',
                      border: '1px solid var(--mm-chrome-border)',
                      borderRadius: 8,
                      padding: '10px 14px',
                      marginBottom: 6,
                      cursor: 'pointer',
                      transition: 'border-color 0.15s',
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.borderColor = '#EF9F27'
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.borderColor = '#E5E7EB'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, marginRight: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--mm-chrome-fg)' }}>
                          {tract.abstract_label}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', marginTop: 2 }}>
                          {tract.level1_sur}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--mm-chrome-muted)', marginTop: 4 }}>
                          {tract.owner_count} owners · {tract.top_operator}
                        </div>
                      </div>
                      <TractActivityBadge tract={tract} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 18, marginBottom: 10, fontSize: 10, fontWeight: 600, color: 'var(--mm-chrome-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                COUNTY BREAKDOWN
              </div>
              <div style={{ background: 'var(--mm-chrome-panel)', border: '1px solid var(--mm-chrome-border)', borderRadius: 8, padding: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                {countyBreakdown.map((row) => (
                  <div key={row.operator} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: 'var(--mm-chrome-fg)' }}>{row.operator}</span>
                      <span style={{ color: 'var(--mm-chrome-muted)' }}>{row.pct}%</span>
                    </div>
                    <div style={{ height: 7, borderRadius: 4, background: 'var(--mm-chrome-muted-fill)' }}>
                      <div style={{ width: `${row.pct}%`, height: 7, borderRadius: 4, background: '#EF9F27' }} />
                    </div>
                  </div>
                ))}
              </div>
              </>
              )}
            </div>
          )}
        </div>

        {/* Map area */}
        <div
          data-tour="map"
          style={{
            flex: isMobile ? '0 0 48dvh' : 1,
            minWidth: 0,
            minHeight: isMobile ? '48dvh' : 0,
            position: 'relative',
            order: isMobile ? 1 : 2,
          }}
        >
          {countySwitchLabel && (
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 10,
                padding: '5px 12px',
                borderRadius: 999,
                background: 'rgba(239,159,39,0.14)',
                border: '1px solid rgba(239,159,39,0.45)',
                color: '#B45309',
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'Geist, Inter, system-ui, sans-serif',
                opacity: countySwitchLabelVisible ? 1 : 0,
                transition: 'opacity 0.25s ease',
                pointerEvents: 'none',
              }}
            >
              {countySwitchLabel}
            </div>
          )}
          {showCountyArrows && previousCounty && (
            <button
              onClick={() => switchCountyByOffset(-1)}
              aria-label={`Previous county: ${COUNTIES[previousCounty].name}`}
              style={{
                position: 'absolute',
                top: '50%',
                left: 8,
                transform: 'translateY(-50%)',
                zIndex: 10,
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '1px solid var(--mm-chrome-border)',
                background: 'var(--mm-chrome-panel)',
                color: 'var(--mm-chrome-fg)',
                fontSize: 16,
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ‹
            </button>
          )}
          {showCountyArrows && nextCounty && (
            <button
              onClick={() => switchCountyByOffset(1)}
              aria-label={`Next county: ${COUNTIES[nextCounty].name}`}
              style={{
                position: 'absolute',
                top: '50%',
                right: rightArrowOffset,
                transform: 'translateY(-50%)',
                zIndex: 10,
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '1px solid var(--mm-chrome-border)',
                background: 'var(--mm-chrome-panel)',
                color: 'var(--mm-chrome-fg)',
                fontSize: 16,
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ›
            </button>
          )}
          {loading ? (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#EF9F27', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
              Loading...
            </div>
          ) : (
            <MineralMap
              selectedCounty={selectedCounty}
              mapFlyToRef={mapFlyToRef}
              mapLevel={mapLevel}
              focusTarget={selected}
              devStatusByAbstract={devStatusByAbstract}
              activityRefreshTick={activityRefreshTick}
              operatorMatchAbstracts={operatorMatchAbstracts}
              operatorOptions={operatorOptions}
              selectedOperatorKeys={selectedOperatorKeys}
              onOperatorKeysChange={setSelectedOperatorKeys}
              operatorMatchTractCount={operatorMatchTractCount}
              onCountySwitch={(countyId) => {
                const key = countyId as CountyKey
                setSelected(null)
                setSelectedCounty(key)
                setMapLevel('tract')
                flyToCountyView(key)
                setExpandedOwner(null)
                setSearchQuery('')
                setSearchResults([])
                setSearchOpen(false)
                setOwnerWells({})
                setTractWells([])
                setTractWellsLoaded(false)
                setWellsExpanded(false)
                setSelectedOperatorKeys([])
              }}
              onOwnerClick={(tract) => {
                // The Mapbox layer is fed by the slim *_parcels_map.geojson
                // (stripped of `owners_json` to keep tile bytes small), so the
                // props the click handler hands us only carry counts. Enrich
                // by looking up the matching TractRecord from the full
                // GeoJSON the side panel already loaded — that's the source
                // of truth for the owners list. Falls back to the raw slim
                // props if no match is found (e.g. brand-new tracts that
                // somehow haven't made it into `tracts` yet).
                const clickedAbstract = String(
                  tract.ABSTRACT_L ?? tract.abstract_label ?? ''
                ).trim()
                const fullTract = clickedAbstract
                  ? tracts.find((t) => {
                      const t1 = String(t.abstract_label ?? '').trim()
                      if (!t1) return false
                      if (t1 === clickedAbstract) return true
                      // Tolerate either side carrying the "A-" prefix.
                      const t1Bare = t1.replace(/^A-\s*/i, '')
                      const clickedBare = clickedAbstract.replace(/^A-\s*/i, '')
                      return t1Bare === clickedBare
                    })
                  : undefined
                const enriched = fullTract
                  ? toTractSelection(fullTract)
                  : (tract as TractSelection)
                setSelected(enriched)
                setSelectedTractGeometry(
                  (tract.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined) ?? null
                )
                setOwnerSort('az')
                setExpandedOwner(null)
                setOwnerTracts([])
                setOwnerTractsName('')
                trackEvent('tract_clicked', {
                  abstract: clickedAbstract,
                  owner_count: enriched.owner_count ?? 0,
                })
              }}
            />
          )}
        </div>
      </div>

      {/* Mobile-only bottom-sheet drawer. On phones a 50/50 side
          split is unusable so we keep the historical layout where
          the drawer takes the bottom half of the viewport. */}
      {drawerOwner && isMobile && (
        <div
          style={{
            height: '58vh',
            minHeight: 320,
            maxHeight: '75vh',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'var(--mm-chrome-panel)',
          }}
        >
          <OwnerDrawer
            open={Boolean(drawerOwner)}
            owner={drawerOwnerView}
            tractLabel={drawerTractLabel}
            tractLegalDescription={buildLegalDescription(selected) || null}
            countyId={selectedCounty}
            inPipeline={drawerOwner ? pipelineOwners.has(drawerOwner.owner_name) : false}
            legalDescByAbstract={tractLegalDescLookup}
            tractDevStatus={devStatusByAbstract[
              String(selected?.abstract_label ?? selected?.ABSTRACT_L ?? '').replace(/^A-\s*/i, '').trim()
            ] ?? null}
            highlightOperators={selectedOperatorFilters}
            ownerIsHidden={isHiddenOverride(drawerOwnerOverride)}
            onSaveOwnerDetails={handleSaveOwnerDetails}
            onRemoveOwner={handleRemoveOwner}
            onRestoreOwner={handleRestoreOwner}
            onClose={() => {
              setDrawerOwner(null)
              setDrawerTractLabel(null)
              setExpandedOwner(null)
            }}
            onSkipTrace={(o) => handleSkipTrace(o as TractOwner)}
            onAddToPipeline={(o) => handleAddToPipeline(o as TractOwner)}
            onShowAllTracts={(o) => {
              setDrawerOwner(null)
              setDrawerTractLabel(null)
              setExpandedOwner(null)
              setOwnerTractsName(o.owner_name)
            }}
          />
        </div>
      )}
      </div>{/* /outer flex-column that wraps sidebar+map row (+ mobile bottom drawer) */}

      {/* Bottom bar */}
      <div
        style={{
          height: isMobile ? 58 : 44,
          minHeight: isMobile ? 58 : 44,
          background: 'var(--mm-chrome-bg)',
          borderTop: '1px solid var(--mm-chrome-border)',
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 14 : 20,
          padding: isMobile ? '0 10px' : '0 16px',
          color: 'var(--mm-chrome-fg)',
          fontSize: 11,
          boxShadow: '0 -1px 3px rgba(0,0,0,0.04)',
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--mm-chrome-fg)', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>Out of state</span>
        <button
          onClick={() => setOutOfStateOnly((prev) => !prev)}
          style={{
            width: 32,
            height: 18,
            borderRadius: 9,
            border: 'none',
            background: outOfStateOnly ? '#EF9F27' : '#D1D5DB',
            position: 'relative',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: outOfStateOnly ? 14 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#fff',
            }}
          />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--mm-chrome-muted)' }}>1%+ interest</span>
          <div
            onClick={() => setLargeInterestOnly(!largeInterestOnly)}
            style={{
              width: 32, height: 18, borderRadius: 9,
              background: largeInterestOnly ? '#EF9F27' : '#E5E7EB',
              cursor: 'pointer', position: 'relative', transition: 'background 0.2s'
            }}
          >
            <div style={{
              position: 'absolute', top: 2,
              left: largeInterestOnly ? 16 : 2,
              width: 14, height: 14, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
            }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginRight: 16 }}>
          <span style={{ fontSize: 12, color: 'var(--mm-chrome-fg)', whiteSpace: 'nowrap', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>Type:</span>
          {(['all', 'individual', 'trust', 'company'] as const).map(type => (
            <button
              key={type}
              onClick={() => setOwnerTypeFilter(type)}
              style={{
                fontSize: 10,
                padding: '3px 10px',
                borderRadius: 10,
                cursor: 'pointer',
                fontFamily: 'Geist, Inter, system-ui, sans-serif',
                whiteSpace: 'nowrap',
                background: ownerTypeFilter === type ? 'rgba(239,159,39,0.2)' : 'transparent',
                border: ownerTypeFilter === type ? '1px solid rgba(239,159,39,0.6)' : '1px solid var(--mm-chrome-border)',
                color: ownerTypeFilter === type ? '#EF9F27' : '#6B7280',
              }}
            >
              {type === 'all' ? 'All' : type === 'individual' ? 'People' : type === 'trust' ? 'Trusts' : 'Companies'}
            </button>
          ))}
        </div>
        {/* Well activity chips. Coloring on the map is driven by parcel-
            level production_status (see Map.tsx); these chips just recolor
            the toolbar label. Proprietary scoring (`tierFilter`, `minScore`,
            `propensity_score`) has been removed from the UI in favor of an
            alphabetical / NRA-based owner sort — see `ownerSort` state. */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginRight: 16 }}>
          <span style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', marginRight: 4 }}>Activity:</span>
          {([
            { key: 'all',            label: 'All',    color: '#EF9F27' },
            { key: 'pdp',            label: 'PDP',    color: '#CA8A04' }, // yellow chip
            { key: 'pud',            label: 'PUD',    color: '#16A34A' }, // green chip
            { key: 'new_permit',     label: 'New',    color: '#2563EB' },
            { key: 'pending_permit', label: 'Pending', color: '#93C5FD' },
          ] as const).map((chip) => (
            <button
              key={chip.key}
              onClick={() => setActivityFilter(chip.key)}
              style={{
                fontSize: 10, padding: '3px 10px', borderRadius: 10, cursor: 'pointer',
                fontFamily: 'monospace',
                background: activityFilter === chip.key ? `${chip.color}20` : 'transparent',
                border: activityFilter === chip.key ? `0.5px solid ${chip.color}` : '0.5px solid var(--mm-chrome-border)',
                color: activityFilter === chip.key ? chip.color : '#6B7280',
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--mm-chrome-muted)' }}>Min NMA:</span>
          <select
            value={minNRA}
            onChange={(e) => setMinNRA(Number(e.target.value))}
            style={{
              fontSize: 11,
              border: '1px solid var(--mm-chrome-border)',
              borderRadius: 6,
              padding: '2px 6px',
              background: 'var(--mm-chrome-bg)',
              color: 'var(--mm-chrome-fg)',
            }}
          >
            <option value={0}>Any</option>
            <option value={0.1}>0.1+</option>
            <option value={0.5}>0.5+</option>
            <option value={1}>1+</option>
            <option value={5}>5+</option>
            <option value={10}>10+</option>
            <option value={25}>25+</option>
            <option value={50}>50+</option>
          </select>
        </div>

        {/* Theme toggle — right edge of the map footer. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
          <ThemeToggle size="sm" />
        </div>

        {/* Operator filter lives in the map Legend/Overlays panel (top-right).
            CSV export was also here; removed intentionally — leads
            must stay on-platform (see PLATFORM-SERVICES-AGREEMENT.md
            non-circumvention clause).
            Help desk is the corner chat widget (HelpChatWidget). */}
      </div>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--mm-chrome-panel)',
            border: toastType === 'error' ? '0.5px solid #F44336' : '0.5px solid #7AB835',
            color: toastType === 'error' ? '#F44336' : '#7AB835',
            fontSize: 12,
            padding: '10px 20px',
            borderRadius: 8,
            fontFamily: 'Geist, Inter, system-ui, sans-serif',
            zIndex: 9999,
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          {toastType === 'error' ? '✕' : '✓'} {toast}
        </div>
      )}

      {pipelineCandidate && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1001,
          }}
        >
          <div
            style={{
              background: 'var(--mm-chrome-panel)',
              border: '0.5px solid var(--mm-chrome-border)',
              borderRadius: 12,
              padding: 24,
              width: 360,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mm-chrome-fg)', marginBottom: 8 }}>
              Add owner to pipeline
            </div>
            <div style={{ fontSize: 12, color: 'var(--mm-chrome-muted)', marginBottom: 14 }}>
              {pipelineCandidate.owner_name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--mm-chrome-muted)', marginBottom: 8 }}>
              Label
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
              {([
                { key: 'prospect', label: 'Prospect' },
                { key: 'hot', label: 'Hot' },
                { key: 'nurture', label: 'Nurture' },
                { key: 'not_interested', label: 'Not Interested' },
              ] as Array<{ key: PipelineTag; label: string }>).map((option) => (
                <button
                  key={option.key}
                  onClick={() => setPipelineTag(option.key)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    border:
                      pipelineTag === option.key
                        ? '0.5px solid rgba(55,138,221,0.8)'
                        : '0.5px solid #E5E7EB',
                    background:
                      pipelineTag === option.key
                        ? 'rgba(55,138,221,0.2)'
                        : 'transparent',
                    color: pipelineTag === option.key ? '#8CC4FF' : '#6B7280',
                    fontSize: 11,
                    cursor: 'pointer',
                    fontFamily: 'Geist, Inter, system-ui, sans-serif',
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => {
                  if (pipelineSaving) return
                  setPipelineCandidate(null)
                }}
                style={{
                  flex: 1,
                  padding: '9px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: '0.5px solid var(--mm-chrome-border)',
                  color: 'var(--mm-chrome-muted)',
                  fontSize: 12,
                  cursor: pipelineSaving ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAddToPipelineConfirm}
                style={{
                  flex: 1,
                  padding: '9px',
                  borderRadius: 6,
                  background: 'rgba(55,138,221,0.2)',
                  border: '0.5px solid rgba(55,138,221,0.8)',
                  color: '#8CC4FF',
                  fontSize: 12,
                  cursor: pipelineSaving ? 'not-allowed' : 'pointer',
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                }}
              >
                {pipelineSaving ? 'Saving...' : 'Add to pipeline'}
              </button>
            </div>
          </div>
        </div>
      )}

      {skipTracing && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--mm-chrome-panel)',
              border: '0.5px solid var(--mm-chrome-border)',
              borderRadius: 12,
              padding: '24px',
              width: 320,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--mm-chrome-fg)', marginBottom: 8 }}>
              Skip trace this owner?
            </div>
            <div style={{ fontSize: 12, color: 'var(--mm-chrome-muted)', marginBottom: 6 }}>
              {skipTracing.owner_name}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--mm-chrome-muted)',
                marginBottom: 20,
                padding: '10px 12px',
                background: 'var(--mm-chrome-panel)',
                borderRadius: 6,
                lineHeight: 1.5,
              }}
            >
              This will search for phone number and email address.
              Skip traces are unlimited.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setSkipTracing(null)}
                disabled={skipTraceLoading}
                style={{
                  flex: 1,
                  padding: '9px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: '0.5px solid var(--mm-chrome-border)',
                  color: 'var(--mm-chrome-muted)',
                  fontSize: 12,
                  cursor: skipTraceLoading ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSkipTraceConfirm}
                disabled={skipTraceLoading}
                style={{
                  flex: 1, padding: '9px', borderRadius: 6,
                  background: skipTraceLoading ? 'rgba(239,159,39,0.08)' : 'rgba(239,159,39,0.15)',
                  border: '0.5px solid rgba(239,159,39,0.4)',
                  color: '#EF9F27', fontSize: 12, cursor: skipTraceLoading ? 'not-allowed' : 'pointer',
                  fontFamily: 'monospace'
                }}
              >
                {skipTraceLoading ? 'Searching...' : 'Skip trace →'}
              </button>
            </div>
          </div>
        </div>
      )}
      {skipTraceResult && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'var(--mm-chrome-panel)', borderRadius: 12, padding: '28px 32px',
            width: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.2)'
          }}>
            <div style={{ fontFamily: 'Geist, Inter, system-ui, sans-serif', fontSize: 18, fontWeight: 700, color: 'var(--mm-chrome-fg)', marginBottom: 6 }}>
              Skip Trace Complete
            </div>
            <div style={{ fontSize: 13, color: 'var(--mm-chrome-muted)', marginBottom: 20 }}>
              {skipTraceResult.ownerName}
            </div>

            {skipTraceResult.cached && (
              <div style={{ fontSize: 11, color: '#16a34a', marginBottom: 8 }}>
                ✓ Retrieved from shared cache
              </div>
            )}

            <div style={{ background: 'var(--mm-chrome-surface)', borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
              {skipTraceResult.phone ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>📞</span>
                  <a href={`tel:${skipTraceResult.phone}`} style={{ fontSize: 14, color: 'var(--mm-chrome-fg)', fontWeight: 500, textDecoration: 'none' }}>
                    {skipTraceResult.phone}
                  </a>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--mm-chrome-muted)', marginBottom: 8 }}>No phone found</div>
              )}
              {skipTraceResult.email ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>✉️</span>
                  <a href={`mailto:${skipTraceResult.email}`} style={{ fontSize: 14, color: 'var(--mm-chrome-fg)', fontWeight: 500, textDecoration: 'none' }}>
                    {skipTraceResult.email}
                  </a>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--mm-chrome-muted)' }}>No email found</div>
              )}
            </div>

            <div style={{ fontSize: 12, color: 'var(--mm-chrome-muted)', marginBottom: 20 }}>
              Contact info saved to pipeline. View and manage this lead in the CRM.
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setSkipTraceResult(null)}
                style={{
                  flex: 1, padding: '10px', borderRadius: 8,
                  background: 'transparent', border: '1px solid var(--mm-chrome-border)',
                  color: 'var(--mm-chrome-muted)', fontSize: 13, cursor: 'pointer'
                }}
              >
                Stay here
              </button>
              <button
                onClick={() => window.location.href = '/crm'}
                style={{
                  flex: 1, padding: '10px', borderRadius: 8,
                  background: '#EF9F27', border: 'none',
                  color: '#fff', fontSize: 13, cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                Go to CRM →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OwnerDrawer moved into the outer flex-column above so it takes
          real flex space and the map/sidebar shrink around it. */}
    </div>
  )
}
