'use client'

// Recent permits page — surfaces every drilling permit filed or
// approved across our active counties in the last N days, and behind
// each permit exposes the owners on the tract it landed on so brokers
// can go call them. Data flow:
//
//   1. Query every <county>_permits table in parallel, filtered to
//      the selected date window on approved_date / filed_date.
//   2. For each permit that carries lat/lon, fetch that county's
//      parcels GeoJSON once, cache it, and run point-in-polygon to
//      resolve the abstract label. Permits without a lat/lon fall
//      back to a lease-name lookup.
//   3. On expand, GET /api/tract-owners?county=&abstract= (service-role
//      DB, then server-side enriched GeoJSON fallback). Never download
//      the 60 MB enriched FeatureCollection in the browser.
//   4. Render one card per permit with an expandable owners list;
//      each owner has Call / Email / Skip trace / Open in map actions.

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { CountyKey } from '@/lib/counties'
import { COUNTIES } from '@/lib/counties'
import AppLogo from '@/app/components/AppLogo'
import { writePermitsLastSeen } from '@/lib/permits-seen'
import { skipTraceOwnerKey } from '@/lib/workspace'

type PermitStatus = 'approved' | 'pending' | 'other'

type RawPermit = {
  id: number | string
  permit_number: string | null
  api_number: string | null
  operator_name: string | null
  lease_name: string | null
  county_code: string | null
  latitude: number | string | null
  longitude: number | string | null
  permit_type: string | null
  status: string | null
  filed_date: string | null
  approved_date: string | null
  // abstract_number is populated by scripts/compute_development_status.py
  // when it runs the spatial join. New permits from tonight's scrape
  // won't have it set until the next compute pass runs. Used as a
  // fallback in abstractForPermit() when lat/lon is missing (which is
  // the case for every permit the RRC EWA HTML scraper delivers —
  // that page has no coordinate column).
  abstract_number: string | null
}

type EnrichedPermit = RawPermit & {
  county_id: CountyKey
  county_display: string
  status_bucket: PermitStatus
  best_date: string | null
  abstract: string | null
  owner_load_state: 'idle' | 'loading' | 'loaded' | 'error'
  owner_count: number
}

type OwnerRow = {
  id?: number | string
  owner_name: string | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
  acreage?: number | null
  ownership_pct?: number | null
  phone?: string | null
  email?: string | null
}

// 3-day window added 2026-07-21 (user ask): brokers want to
// grab freshly-approved-in-the-last-72-hours permits before
// their competitors call the mineral owners. 3d is realistic
// now that the real-time ScrapingBee-backed scrape refreshes
// nightly; before that, the bulk EWA CSV lagged 4-12 weeks and
// a 3-day filter would have always returned zero rows.
type WindowChoice = 3 | 7 | 30 | 90 | 365

// Every county the permits page pulls from. Kept in sync with the
// daily RRC scraper's default county list. Counties whose _permits
// table doesn't exist yet return an empty array from Supabase and
// are silently skipped downstream.
const PERMIT_COUNTIES: CountyKey[] = [
  'howard', 'martin', 'midland', 'loving', 'reagan', 'upton', 'ward',
]

// Slim column list to keep the payload small when hitting the 13
// county tables in parallel.
const PERMIT_COLUMNS =
  'id, permit_number, api_number, operator_name, lease_name, county_code, latitude, longitude, permit_type, status, filed_date, approved_date, abstract_number'

const bareAbstract = (raw: unknown): string =>
  String(raw ?? '')
    .replace(/^A-\s*/i, '')
    .replace(/^\d{5}-/, '')
    .trim()
    .toUpperCase()

function statusToBucket(status: string | null | undefined): PermitStatus {
  const s = String(status ?? '').toUpperCase()
  if (s.includes('APPROV') || s.includes('ISSUED') || s.includes('PRODUCING')) return 'approved'
  if (s.includes('PEND') || s.includes('FILED') || s.includes('SUBMIT')) return 'pending'
  return 'other'
}

function daysAgo(dateStr: string | null): number | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const now = Date.now()
  return Math.floor((now - d.getTime()) / (1000 * 60 * 60 * 24))
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// Point-in-ring / point-in-geometry — copies of the isPointInRing +
// isPointInGeometry helpers in app/page.tsx. Not extracted to a shared
// module yet because they'll likely evolve differently: the permits
// page only needs polygon containment for permit -> abstract resolution
// and can accept the perf cost of pure-JS ray casting on the ~1k-3k
// tract features per county.
function isPointInRing(lon: number, lat: number, ring: readonly (readonly number[])[]): boolean {
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

function isPointInGeometry(
  lon: number,
  lat: number,
  geometry: GeoJSON.Geometry | null | undefined,
): boolean {
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

// Cache the slim per-county parcels GeoJSON used for point-in-polygon
// abstract resolution. Owners are NOT loaded from this file (it has no
// owners_json) — the expand panel hits /api/tract-owners instead so the
// browser never downloads the 53–63 MB enriched FeatureCollection.
const mapParcelsCache = new Map<CountyKey, GeoJSON.FeatureCollection>()

/** Slim parcels for point-in-polygon abstract resolution. */
async function loadParcels(countyId: CountyKey): Promise<GeoJSON.FeatureCollection | null> {
  const cached = mapParcelsCache.get(countyId)
  if (cached) return cached
  const cfg = COUNTIES[countyId]
  if (!cfg) return null
  try {
    const res = await fetch(cfg.mapGeoJsonPath || cfg.geoJsonPath)
    if (!res.ok) return null
    const gj = (await res.json()) as GeoJSON.FeatureCollection
    mapParcelsCache.set(countyId, gj)
    return gj
  } catch {
    return null
  }
}

// Cache api_number -> well surface coords per county, populated on
// first lookup demand. The wells GeoJSON is way smaller than the
// parcels GeoJSON so this is cheap; we still cache to avoid the
// per-permit-card fetch when the user is scrolling.
const wellCoordsCache = new Map<CountyKey, Map<string, { lat: number; lon: number }>>()

async function loadWellCoordsByApi(
  countyId: CountyKey,
): Promise<Map<string, { lat: number; lon: number }>> {
  const cached = wellCoordsCache.get(countyId)
  if (cached) return cached
  const out = new Map<string, { lat: number; lon: number }>()
  try {
    const { data } = await supabase
      .from(`${countyId}_wells`)
      .select('api_number, surface_latitude, surface_longitude, latitude, longitude')
      .not('api_number', 'is', null)
      .limit(50000)
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const api = String(row.api_number ?? '').trim()
      if (!api) continue
      const lat = Number(row.surface_latitude ?? row.latitude)
      const lon = Number(row.surface_longitude ?? row.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue
      // Store both the raw form and a normalized 10-digit form to
      // catch mismatches between how the permit vs the well
      // records the API. RRC writes it dozens of ways.
      out.set(api, { lat, lon })
      const digits = api.replace(/\D/g, '')
      if (digits && digits !== api) out.set(digits, { lat, lon })
    }
  } catch {
    // Table may not exist yet for upcoming counties; fall through.
  }
  wellCoordsCache.set(countyId, out)
  return out
}

// Four-tier permit -> abstract resolver:
//   1. permit.latitude/longitude valid    -> point-in-polygon (most accurate)
//   2. permit.abstract_number populated   -> use directly (compute_development_status
//                                            set it via spatial join on a prior run)
//   3. permit.api_number matches a well   -> use that well's surface coords,
//                                            run point-in-polygon
//   4. permit operator + lease-name prefix matches wells -> inherit their
//                                            most common abstract
// Tier 4 was added 2026-07-22 to cover BRAND-NEW permits from RRC EWA:
// their results page has no lat/lon and no abstract, and if the permit
// is for a not-yet-drilled well, tier 3 fails too because the well
// isn't in the wells table. But operators drill on the same acreage
// blocks year after year, so their existing wells' abstract is a
// strong predictor of where the new permit will end up.
async function abstractForPermit(permit: RawPermit, countyId: CountyKey): Promise<string | null> {
  // Tier 1: real lat/lon on the permit itself.
  const lat = Number(permit.latitude)
  const lon = Number(permit.longitude)
  const hasValidCoords =
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  if (hasValidCoords) {
    const abstract = await pointInPolygonAbstract(countyId, lon, lat)
    if (abstract) return abstract
    // If PIP fell through (permit lat/lon just outside every tract
    // polygon by a few meters, which happens near county borders),
    // continue to lower tiers rather than giving up.
  }

  // Tier 2: compute_development_status.py stamped the tract on a
  // prior nightly run. Trust it verbatim — it did its own PIP with
  // the same parcels shapefile and would have been more careful
  // about surveys / edge cases than we can afford client-side.
  const stamped = String(permit.abstract_number ?? '').trim()
  if (stamped) return stamped

  // Tier 3: look up this permit's well by API and use its surface
  // coords. Catches permits for wells that have already been drilled
  // and appear in <county>_wells.
  const api = String(permit.api_number ?? '').trim()
  if (api) {
    const wellCoords = await loadWellCoordsByApi(countyId)
    const hit = wellCoords.get(api) ?? wellCoords.get(api.replace(/\D/g, ''))
    if (hit) {
      const abstract = await pointInPolygonAbstract(countyId, hit.lon, hit.lat)
      if (abstract) return abstract
    }
  }

  // Tier 4: operator + lease-name prefix match against wells. For
  // a permit like "THE PEAKS 29-17 A UNIT" (HighPeak Energy), pull
  // every HighPeak well in Howard, keep those whose lease_name
  // shares a token prefix ("PEAKS"), tally their abstracts, and
  // return the most common. This is imperfect — different wells
  // on the same lease-family CAN sit on different abstracts — but
  // it's much better than "unresolved" for brand-new permits with
  // no matching drilled well.
  const inherited = await abstractByOperatorLease(
    countyId,
    permit.operator_name,
    permit.lease_name,
  )
  if (inherited) return inherited

  return null
}

// Cache well-abstract lookups per (county, operator) tuple. The
// permits page renders many cards, each of which independently
// resolves; caching prevents an N+1 storm of identical Supabase
// queries against the same operator.
const wellAbstractCache = new Map<string, Map<string, string> | null>()

// Return abstract for a permit by looking up existing wells of the
// same operator whose lease_name shares a token prefix with the
// permit's lease_name. Prefix is defined as: strip common noise
// words ("THE", "A", "UNIT", etc.), take the first remaining
// significant token, match case-insensitively. See the tier 4
// comment in abstractForPermit for the motivation.
async function abstractByOperatorLease(
  countyId: CountyKey,
  operatorName: string | null | undefined,
  leaseName: string | null | undefined,
): Promise<string | null> {
  const op = String(operatorName ?? '').trim()
  const lease = String(leaseName ?? '').trim()
  if (!op || !lease) return null

  const cacheKey = `${countyId}::${op.toLowerCase()}`
  let leaseToAbstract = wellAbstractCache.get(cacheKey)
  if (leaseToAbstract === undefined) {
    leaseToAbstract = null
    try {
      const { data } = await supabase
        .from(`${countyId}_wells`)
        .select('lease_name, abstract')
        .ilike('operator_name', op)
        .not('abstract', 'is', null)
        .not('lease_name', 'is', null)
        .limit(1000)
      if (data && data.length > 0) {
        leaseToAbstract = new Map<string, string>()
        for (const row of data as Array<Record<string, unknown>>) {
          const ln = String(row.lease_name ?? '').trim()
          const ab = String(row.abstract ?? '').trim()
          if (ln && ab) leaseToAbstract.set(ln.toUpperCase(), ab)
        }
      }
    } catch {
      leaseToAbstract = null
    }
    wellAbstractCache.set(cacheKey, leaseToAbstract)
  }
  if (!leaseToAbstract || leaseToAbstract.size === 0) return null

  // Strip common noise tokens so "THE PEAKS 29-17 A UNIT" and
  // "PEAKS 29-17" both key on "PEAKS 29-17". Order matters:
  // multi-word noise stripped first, then single words.
  const cleanLease = (raw: string): string =>
    raw
      .toUpperCase()
      .replace(/\bUNIT\b/g, ' ')
      .replace(/\b(THE|A|AN|LEASE)\b/g, ' ')
      .replace(/[^A-Z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  const permitClean = cleanLease(lease)
  if (!permitClean) return null
  const permitTokens = permitClean.split(' ').filter(Boolean)
  if (permitTokens.length === 0) return null
  const permitHead = permitTokens.slice(0, 2).join(' ')

  // Score each well-lease by how many leading tokens it shares
  // with the permit lease. Prefer full prefix match, then first-
  // two-tokens, then first-token. Tally abstracts by score.
  const abstractScore = new Map<string, number>()
  leaseToAbstract.forEach((wellAbstract, wellLease) => {
    const wellClean = cleanLease(wellLease)
    if (!wellClean) return
    let score = 0
    if (wellClean === permitClean) score = 100
    else if (wellClean.startsWith(permitHead)) score = 50
    else if (wellClean.split(' ')[0] === permitTokens[0]) score = 10
    if (score === 0) return
    abstractScore.set(
      wellAbstract,
      (abstractScore.get(wellAbstract) ?? 0) + score,
    )
  })
  if (abstractScore.size === 0) return null
  const scored: Array<[string, number]> = []
  abstractScore.forEach((score, ab) => scored.push([ab, score]))
  scored.sort((a, b) => b[1] - a[1])
  return scored[0]?.[0] ?? null
}

// Broken out of abstractForPermit so both the direct lat/lon path
// and the api-based fallback can share it.
async function pointInPolygonAbstract(
  countyId: CountyKey, lon: number, lat: number,
): Promise<string | null> {
  const gj = await loadParcels(countyId)
  if (!gj) return null
  for (const feature of gj.features) {
    if (isPointInGeometry(lon, lat, feature.geometry)) {
      const props = (feature.properties ?? {}) as Record<string, unknown>
      const abstract = String(
        props.ABSTRACT_L ?? props.abstract_label ?? props.ABSTRACT_N ?? '',
      ).trim()
      if (abstract) return abstract
    }
  }
  return null
}

// Owners for a (county, abstract) via /api/tract-owners. The API uses the
// service role against mineral_ownership and falls back to the enriched
// CAD GeoJSON server-side (cached in the serverless instance) so the
// browser never pulls a 60 MB FeatureCollection on expand.
async function loadOwnersForAbstract(
  countyId: CountyKey,
  abstract: string,
): Promise<OwnerRow[]> {
  const params = new URLSearchParams({
    county: countyId,
    abstract: bareAbstract(abstract) || String(abstract),
  })
  try {
    const res = await fetch(`/api/tract-owners?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const body = (await res.json()) as {
      success?: boolean
      data?: { owners?: OwnerRow[] }
      error?: string | null
    }
    if (!res.ok || !body.success) {
      console.warn(
        `[permits] /api/tract-owners ${countyId} ${abstract} failed:`,
        body.error ?? res.status,
      )
      return []
    }
    return (body.data?.owners ?? []) as OwnerRow[]
  } catch (err) {
    console.warn(`[permits] /api/tract-owners ${countyId} ${abstract} threw:`, err)
    return []
  }
}

// Bulk cached-only phone/email lookup so we can show contact info in
// the expanded permit card without triggering skip-trace on every
// owner. Reads the SHARED skip_trace_cache (any team's prior paid
// skip-trace is reusable — we don't re-bill the provider).
async function loadCachedContacts(
  ownerNames: string[],
): Promise<Record<string, { phone?: string | null; email?: string | null }>> {
  if (ownerNames.length === 0) return {}
  const uniq = Array.from(
    new Set(ownerNames.map((n) => skipTraceOwnerKey(n)).filter(Boolean)),
  )
  const { data } = await supabase
    .from('skip_trace_cache')
    .select('owner_name, phones, emails')
    .in('owner_name', uniq)
  const out: Record<string, { phone?: string | null; email?: string | null }> = {}
  for (const row of (data ?? []) as Array<{
    owner_name: string
    phones?: string[] | null
    emails?: string[] | null
  }>) {
    const key = String(row.owner_name ?? '').toUpperCase()
    out[key] = {
      phone: row.phones?.[0] ?? null,
      email: row.emails?.[0] ?? null,
    }
  }
  return out
}

export default function PermitsPage() {
  const [permits, setPermits] = useState<EnrichedPermit[]>([])
  const [loading, setLoading] = useState(true)
  // Default window: last 90 days. RRC's public bulk permit exports
  // (EWA snapshots) usually lag the current date by 4-12 weeks — a
  // 7-day window would show zero permits until we upgrade to a paid
  // real-time feed. Brokers still get plenty of leads at 90 days.
  const [windowDays, setWindowDays] = useState<WindowChoice>(90)
  const [statusFilter, setStatusFilter] = useState<'all' | PermitStatus>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [ownersByPermit, setOwnersByPermit] = useState<Record<string, OwnerRow[]>>({})
  const [ownerLoading, setOwnerLoading] = useState<Record<string, boolean>>({})

  // Clear the map-page Permits nav badge: stamp the newest ingest
  // date so the little square bubble stays hidden until fresher
  // rows land from the RRC scrape.
  useEffect(() => {
    let cancelled = false
    const markSeen = async () => {
      try {
        const res = await fetch('/api/permits/latest', { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const body = (await res.json()) as {
          success?: boolean
          data?: { latest_date?: string | null }
        }
        const latest = body.data?.latest_date
        if (body.success && latest) {
          writePermitsLastSeen(latest)
        } else {
          writePermitsLastSeen(new Date().toISOString().slice(0, 10))
        }
      } catch {
        writePermitsLastSeen(new Date().toISOString().slice(0, 10))
      }
    }
    void markSeen()
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch permits from every registered county in parallel and
  // resolve each permit's abstract via point-in-polygon on the
  // county's parcels GeoJSON. Runs whenever windowDays changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const since = isoDaysAgo(windowDays)

    const fetchAll = async () => {
      const perCounty = await Promise.all(
        PERMIT_COUNTIES.map(async (countyId) => {
          const cfg = COUNTIES[countyId]
          if (!cfg) return [] as EnrichedPermit[]
          // Filter on either date — Supabase doesn't support .or with
          // a range shorthand cleanly, so we grab everything from the
          // last N days by best_date (max of the two) client-side.
          const { data, error } = await supabase
            .from(`${countyId}_permits`)
            .select(PERMIT_COLUMNS)
            .or(`filed_date.gte.${since},approved_date.gte.${since}`)
            .limit(500)
          if (error) {
            // Table missing for a county whose migration isn't in yet.
            return [] as EnrichedPermit[]
          }
          return (data as RawPermit[]).map<EnrichedPermit>((row) => {
            const best = row.approved_date && row.filed_date
              ? (row.approved_date > row.filed_date ? row.approved_date : row.filed_date)
              : (row.approved_date ?? row.filed_date ?? null)
            return {
              ...row,
              county_id: countyId,
              county_display: cfg.displayName,
              status_bucket: statusToBucket(row.status),
              best_date: best,
              abstract: null,
              owner_load_state: 'idle',
              owner_count: 0,
            }
          })
        }),
      )

      if (cancelled) return
      const merged = perCounty.flat()

      // Resolve abstract for each permit via point-in-polygon. Runs
      // in parallel per county to keep total wall-clock time down.
      const withAbstracts = await Promise.all(
        merged.map(async (p) => ({
          ...p,
          abstract: await abstractForPermit(p, p.county_id),
        })),
      )

      if (cancelled) return
      withAbstracts.sort((a, b) => String(b.best_date ?? '').localeCompare(String(a.best_date ?? '')))
      setPermits(withAbstracts)
      setLoading(false)
    }

    void fetchAll()
    return () => {
      cancelled = true
    }
  }, [windowDays])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return permits
    return permits.filter((p) => p.status_bucket === statusFilter)
  }, [permits, statusFilter])

  const approvedCount = permits.filter((p) => p.status_bucket === 'approved').length
  const pendingCount = permits.filter((p) => p.status_bucket === 'pending').length

  const toggleExpand = useCallback((permitKey: string, permit: EnrichedPermit) => {
    setExpanded((prev) => {
      const wasOpen = !!prev[permitKey]
      const next = { ...prev, [permitKey]: !wasOpen }
      if (wasOpen) return next
      // First open — fetch owners on demand.
      if (!ownersByPermit[permitKey] && !ownerLoading[permitKey]) {
        void (async () => {
          if (!permit.abstract) {
            setOwnersByPermit((cur) => ({ ...cur, [permitKey]: [] }))
            return
          }
          setOwnerLoading((cur) => ({ ...cur, [permitKey]: true }))
          const owners = await loadOwnersForAbstract(permit.county_id, permit.abstract)
          const contacts = await loadCachedContacts(owners.map((o) => String(o.owner_name ?? '')))
          const merged = owners.map((o) => {
            const key = String(o.owner_name ?? '').toUpperCase()
            const c = contacts[key] ?? {}
            return { ...o, phone: c.phone, email: c.email }
          })
          setOwnersByPermit((cur) => ({ ...cur, [permitKey]: merged }))
          setOwnerLoading((cur) => ({ ...cur, [permitKey]: false }))
        })()
      }
      return next
    })
  }, [ownersByPermit, ownerLoading])

  return (
    <div style={{ minHeight: '100dvh', background: '#F8FAFC', display: 'flex', flexDirection: 'column' }}>
      {/* Header — mirrors the map page's chrome with the same subtle
          photo texture, so the whole app reads as one product. */}
      <div
        style={{
          height: 52,
          minHeight: 52,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(255,255,255,0.98) 100%), " +
            "url('/hero-permian.jpg') center/cover no-repeat",
          borderBottom: '1px solid #E5E7EB',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 20px',
        }}
      >
        <Link href="/" style={{ textDecoration: 'none' }}>
          <AppLogo width={150} />
        </Link>
        <span style={{ fontSize: 12, color: '#6B7280', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>·</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111827', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
          Recent Permits
        </span>
        <div style={{ flex: 1 }} />
        {/* Satellite Imagery archived — see lib/feature-flags.ts */}
        <Link
          href="/"
          style={{
            fontSize: 12,
            color: '#6B7280',
            textDecoration: 'none',
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #E5E7EB',
            fontFamily: 'Geist, Inter, system-ui, sans-serif',
          }}
        >
          ← Map
        </Link>
      </div>

      <div style={{ maxWidth: 1200, width: '100%', margin: '0 auto', padding: '24px 20px 40px', flex: 1 }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{
            fontFamily: 'Geist, Inter, system-ui, sans-serif',
            fontSize: 28,
            fontWeight: 700,
            color: '#111827',
            marginBottom: 6,
          }}>
            Permits — last {windowDays >= 365 ? 'year' : `${windowDays} days`}
          </h1>
          <p style={{
            fontFamily: 'Geist, Inter, system-ui, sans-serif',
            fontSize: 14,
            color: '#6B7280',
            marginBottom: 0,
          }}>
            {loading
              ? 'Loading permits across all counties…'
              : `${permits.length} permit${permits.length === 1 ? '' : 's'} · ${approvedCount} approved · ${pendingCount} pending`}
          </p>
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6B7280', fontFamily: 'Geist, Inter, system-ui, sans-serif', marginRight: 4 }}>
              Window:
            </span>
            {([
              { d: 3   as WindowChoice, label: '3 days' },
              { d: 7   as WindowChoice, label: '7 days' },
              { d: 30  as WindowChoice, label: '30 days' },
              { d: 90  as WindowChoice, label: '90 days' },
              { d: 365 as WindowChoice, label: '1 year' },
            ]).map(({ d, label }) => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                  background: windowDays === d ? '#0F172A' : '#FFFFFF',
                  border: windowDays === d ? '1px solid #0F172A' : '1px solid #E5E7EB',
                  color: windowDays === d ? '#FFFFFF' : '#6B7280',
                  fontWeight: windowDays === d ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6B7280', fontFamily: 'Geist, Inter, system-ui, sans-serif', marginRight: 4 }}>
              Status:
            </span>
            {([
              { key: 'all',      label: 'All',      color: '#0F172A' },
              { key: 'approved', label: 'Approved', color: '#2563EB' },
              { key: 'pending',  label: 'Pending',  color: '#EA580C' },
            ] as const).map((s) => (
              <button
                key={s.key}
                onClick={() => setStatusFilter(s.key)}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontFamily: 'Geist, Inter, system-ui, sans-serif',
                  background: statusFilter === s.key ? `${s.color}15` : '#FFFFFF',
                  border: statusFilter === s.key ? `1px solid ${s.color}` : '1px solid #E5E7EB',
                  color: statusFilter === s.key ? s.color : '#6B7280',
                  fontWeight: statusFilter === s.key ? 600 : 400,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Permit list */}
        {loading ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            fontSize: 14,
            color: '#6B7280',
            fontFamily: 'Geist, Inter, system-ui, sans-serif',
          }}>
            Fetching permits from all counties…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            fontSize: 14,
            color: '#6B7280',
            fontFamily: 'Geist, Inter, system-ui, sans-serif',
            background: '#FFFFFF',
            borderRadius: 8,
            border: '1px solid #E5E7EB',
          }}>
            No permits match the current filters.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filtered.map((permit, i) => {
              const permitKey = `${permit.county_id}-${permit.id ?? i}`
              const isOpen = !!expanded[permitKey]
              const owners = ownersByPermit[permitKey] ?? []
              const loadingOwners = !!ownerLoading[permitKey]
              const days = daysAgo(permit.best_date)
              const dayLabel = days === 0 ? 'Today'
                : days === 1 ? 'Yesterday'
                : days != null ? `${days} days ago`
                : 'Date unknown'
              return (
                <div
                  key={permitKey}
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid #E5E7EB',
                    borderRadius: 10,
                    overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
                  }}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto auto',
                      gap: 14,
                      alignItems: 'center',
                      padding: '14px 18px',
                      fontFamily: 'Geist, Inter, system-ui, sans-serif',
                    }}
                  >
                    {/* The card header is split into two clickable
                        surfaces so the "View on map" pin doesn't
                        collide with the expand-toggle. Left button
                        toggles the owners dropdown; right button is
                        a plain Link that navigates to the map. */}
                    <button
                      onClick={() => toggleExpand(permitKey, permit)}
                      style={{
                        display: 'contents',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                      }}
                    >
                      <StatusBadge status={permit.status_bucket} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: '#111827',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {permit.lease_name || permit.permit_number || 'Unnamed permit'}
                        </div>
                        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                          {permit.operator_name || 'Unknown operator'}
                          {' · '}
                          {permit.county_display}
                          {permit.abstract && (
                            <> · <span style={{ fontFamily: 'monospace' }}>{permit.abstract}</span></>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                        <span style={{ fontSize: 11, color: '#6B7280' }}>{dayLabel}</span>
                        <span style={{
                          display: 'inline-block',
                          transform: isOpen ? 'rotate(180deg)' : 'none',
                          transition: 'transform 0.15s',
                          color: '#94A3B8',
                          fontSize: 12,
                        }}>▼</span>
                      </div>
                    </button>
                    {/* View on map button. Deep-links to `/` (the
                        map) with ?county=X&abstract=Y so the map
                        can fly directly to the tract this permit
                        landed on. Falls back to just the county
                        deep-link (?county=X) when we couldn't
                        resolve an abstract (permit had no lat/lon,
                        or its coordinates didn't land inside any
                        known tract polygon). */}
                    <Link
                      href={(() => {
                        // Always carry the permit's coordinates when we have
                        // them so the map flies to *where the permit was
                        // filed* even when we couldn't resolve an abstract
                        // (permit on University/State land or a tract-coverage
                        // gap). The map resolves the tract from the abstract
                        // when present, otherwise via point-in-polygon on the
                        // lat/lon — and always zooms to the point.
                        const qs = new URLSearchParams({ county: permit.county_id })
                        if (permit.abstract) qs.set('abstract', permit.abstract)
                        const lat = Number(permit.latitude)
                        const lon = Number(permit.longitude)
                        // Only pass coordinates when they're a plausible Texas
                        // location. A permit with one coord missing/zero
                        // (Number(null) === 0) must NOT fly the map to Null
                        // Island / off the African coast — require BOTH lat &
                        // lon inside the Texas bounding box.
                        const inTexas =
                          Number.isFinite(lat) && Number.isFinite(lon) &&
                          lat >= 25 && lat <= 37 && lon >= -107 && lon <= -93
                        if (inTexas) {
                          qs.set('lat', String(lat))
                          qs.set('lon', String(lon))
                        }
                        return `/?${qs.toString()}`
                      })()}
                      title={permit.abstract
                        ? `Open ${permit.abstract} in ${permit.county_display} on the map`
                        : `Open ${permit.county_display} on the map`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '6px 12px',
                        borderRadius: 8,
                        background: '#2563EB',
                        color: '#FFFFFF',
                        textDecoration: 'none',
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                    >
                      📍 Map
                    </Link>
                  </div>

                  {isOpen && (
                    <div style={{
                      borderTop: '1px solid #F3F4F6',
                      background: '#FAFBFC',
                      padding: '14px 18px',
                    }}>
                      {!permit.abstract ? (
                        <div style={{ fontSize: 12, color: '#94A3B8', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                          Couldn&apos;t match this permit to a tract.
                          {' '}RRC&apos;s public search doesn&apos;t include
                          coordinates, and this operator has no prior wells on
                          a similarly-named lease. The nightly compute pass may
                          resolve it if the well gets drilled.
                        </div>
                      ) : loadingOwners ? (
                        <div style={{ fontSize: 12, color: '#6B7280', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                          Loading owners on {permit.abstract}…
                        </div>
                      ) : owners.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#94A3B8', fontFamily: 'Geist, Inter, system-ui, sans-serif' }}>
                          No mineral owners in our CAD file for abstract{' '}
                          {permit.abstract}. The tract may be operator-held
                          or not yet on the ownership roll.
                        </div>
                      ) : (
                        <>
                          <div style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#6B7280',
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            marginBottom: 8,
                            fontFamily: 'Geist, Inter, system-ui, sans-serif',
                          }}>
                            {owners.length} lead{owners.length === 1 ? '' : 's'} on this tract
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {owners.map((owner, oi) => (
                              <OwnerRowCard
                                key={`${owner.id ?? oi}-${owner.owner_name}`}
                                owner={owner}
                                countyId={permit.county_id}
                                abstract={permit.abstract!}
                              />
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: PermitStatus }) {
  const style = status === 'approved'
    ? { bg: '#DBEAFE', color: '#1D4ED8', label: 'APPROVED' }
    : status === 'pending'
      ? { bg: '#FED7AA', color: '#9A3412', label: 'PENDING' }
      : { bg: '#F3F4F6', color: '#6B7280', label: 'OTHER' }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 8px',
        borderRadius: 999,
        background: style.bg,
        color: style.color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        fontFamily: 'Geist, Inter, system-ui, sans-serif',
        whiteSpace: 'nowrap',
      }}
    >
      {style.label}
    </span>
  )
}

function OwnerRowCard({
  owner, countyId, abstract,
}: {
  owner: OwnerRow
  countyId: CountyKey
  abstract: string
}) {
  const nra = owner.acreage != null && owner.ownership_pct != null
    ? Number(owner.acreage) * Number(owner.ownership_pct) / 100
    : null
  const phone = owner.phone ?? null
  const email = owner.email ?? null
  const mapDeepLink = `/?county=${countyId}&owner=${encodeURIComponent(owner.owner_name ?? '')}&abstract=${encodeURIComponent(abstract)}`

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 10,
        alignItems: 'center',
        padding: '10px 12px',
        background: '#FFFFFF',
        border: '1px solid #E5E7EB',
        borderRadius: 8,
        fontFamily: 'Geist, Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
          {owner.owner_name}
        </div>
        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
          {(owner.mailing_city && owner.mailing_state)
            ? `${owner.mailing_city}, ${owner.mailing_state}${owner.mailing_zip ? ' ' + owner.mailing_zip : ''}`
            : 'Address on file'}
          {nra != null && nra > 0 && (
            <> · <span style={{ fontFamily: 'monospace', color: '#374151' }}>{nra.toFixed(nra < 1 ? 3 : 2)} NMA</span></>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {phone ? (
          <a
            href={`tel:${phone.replace(/[^0-9+]/g, '')}`}
            style={{
              fontSize: 11,
              padding: '5px 10px',
              borderRadius: 6,
              background: '#16A34A',
              color: '#FFFFFF',
              textDecoration: 'none',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
            title={phone}
          >
            📞 {phone}
          </a>
        ) : (
          <span style={{
            fontSize: 11,
            padding: '5px 10px',
            borderRadius: 6,
            background: '#F3F4F6',
            color: '#94A3B8',
            fontStyle: 'italic',
          }}>
            No phone
          </span>
        )}
        {email && (
          <a
            href={`mailto:${email}`}
            style={{
              fontSize: 11,
              padding: '5px 10px',
              borderRadius: 6,
              background: '#EFF6FF',
              color: '#1D4ED8',
              textDecoration: 'none',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
            title={email}
          >
            ✉️
          </a>
        )}
        <Link
          href={mapDeepLink}
          style={{
            fontSize: 11,
            padding: '5px 10px',
            borderRadius: 6,
            background: '#FFFFFF',
            color: '#374151',
            textDecoration: 'none',
            border: '1px solid #E5E7EB',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          Open ↗
        </Link>
      </div>
    </div>
  )
}
