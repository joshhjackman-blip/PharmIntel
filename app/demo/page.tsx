'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const SQM_PER_ACRE = 4046.86

const FAKE_NAMES = [
  'HAR██████ J.T.', 'BRO██████ M.K.', 'WIL████ R.L.',
  'MCG████ S.A.', 'THO██████ D.W.', 'AND█████ P.K.',
  'DAV████ TRUST', 'JOH██████ FAMILY TRUST', 'WES████ MINERALS LLC',
  'SMI████ ENERGY LLC',
]
const FAKE_CITIES = [
  { city: 'Denver', state: 'CO' }, { city: 'Phoenix', state: 'AZ' },
  { city: 'Dallas', state: 'TX' }, { city: 'Houston', state: 'TX' },
  { city: 'Chicago', state: 'IL' }, { city: 'Nashville', state: 'TN' },
  { city: 'Austin', state: 'TX' }, { city: 'San Antonio', state: 'TX' },
]
const FAKE_OPERATORS = [
  'EOG Resources', 'Baytex Energy USA, Inc.',
  'Marathon Oil', 'Auterra Operating, LLC', 'Lacy 03 LLC',
]
const FAKE_PHONES = ['(720)', '(602)', '(214)', '(713)', '(312)', '(615)']
const FAKE_EMAIL_PREFIXES = ['jhar', 'mbro', 'rwil', 'smcg', 'dand', 'ptho']

type OwnerSort = 'score' | 'interest' | 'nra'
type SkipTraceState = 'idle' | 'loading' | 'result'

type FakeWell = {
  lease_name: string
  operator_name: string
  oil_gas_code: 'O' | 'G'
  well_type: 'HORIZONTAL' | 'VERTICAL'
}

type FakeOwner = {
  key: string
  name: string
  city: string
  state: string
  score: number
  ownershipPct: number
  decimal: number
  nra: number
  typeLabel: 'IND' | 'TRUST' | 'CO'
  outOfState: boolean
  signals: string[]
  phone: string
  email: string
}

type ProductionPoint = {
  month: string
  oil: number
}

type SelectedTract = {
  abstractLabel: string
  surveyName: string
  score: number
  fakeAcreage: number
  operatorName: string
  fieldName: string
  owners: FakeOwner[]
  wells: FakeWell[]
  productionData: ProductionPoint[]
}

const hashString = (value: string): number => {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

const createRng = (seed: number) => {
  let t = seed + 0x6d2b79f5
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const classifyOwnerType = (name: string): 'IND' | 'TRUST' | 'CO' => {
  const upper = name.toUpperCase()
  if (upper.includes('TRUST')) return 'TRUST'
  if (upper.includes('LLC') || upper.includes('MINERALS') || upper.includes('ENERGY')) return 'CO'
  return 'IND'
}

const getAcreageFromProps = (props: Record<string, unknown>): number => {
  const shapeArea = Number(props.SHAPE_AREA ?? props.shape_area ?? 0)
  if (Number.isFinite(shapeArea) && shapeArea > 0) {
    return Number((shapeArea / SQM_PER_ACRE).toFixed(1))
  }
  return 160
}

const scoreTextColor = (score: number): string =>
  score >= 8 ? '#F44336' : score >= 6 ? '#FF9800' : score >= 4 ? '#FFC107' : '#4CAF50'

const typeBadgeStyle = (typeLabel: FakeOwner['typeLabel']) => {
  if (typeLabel === 'TRUST') return { color: '#7AB835', bg: 'rgba(122,184,53,0.15)', border: '0.5px solid rgba(122,184,53,0.3)' }
  if (typeLabel === 'CO') return { color: '#378ADD', bg: 'rgba(55,138,221,0.15)', border: '0.5px solid rgba(55,138,221,0.3)' }
  return { color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)', border: '0.5px solid rgba(156,163,175,0.3)' }
}

const scoreBadgeStyle = (score: number) => {
  if (score >= 8) return { bg: '#B91C1C', text: '#FCA5A5' }
  if (score >= 5) return { bg: '#92400E', text: '#FCD34D' }
  if (score >= 2) return { bg: '#2A3E1A', text: '#7EE787' }
  return { bg: '#374151', text: '#9CA3AF' }
}

const makeSignals = (owner: { outOfState: boolean; typeLabel: FakeOwner['typeLabel']; nra: number; score: number }): string[] => {
  const signals: string[] = []
  if (owner.outOfState) signals.push('Out of state mailing address (+3 pts)')
  if (owner.typeLabel === 'IND') signals.push('Individual owner bonus (+2 pts)')
  if (owner.typeLabel === 'TRUST') signals.push('Trust ownership complexity (+2 pts)')
  if (owner.typeLabel === 'CO') signals.push('Entity ownership structure (+1 pt)')
  if (owner.nra < 1) signals.push('Small acreage position (+3 pts)')
  signals.push('Active production (+1 pt)')
  if (owner.score >= 8) signals.push('High response propensity (+2 pts)')
  return signals.slice(0, 4)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const makeProductionData = (abstractLabel: string): ProductionPoint[] => {
  const seed = hashString(`${abstractLabel}-prod`)
  const rand = createRng(seed)
  const start = 800 + Math.floor(rand() * 1200)
  return MONTHS.map((month, index) => {
    const decline = Math.pow(0.92, index)
    const noise = 0.94 + rand() * 0.12
    const oil = Math.max(120, Math.round(start * decline * noise))
    return { month, oil }
  })
}

const makeFakeWells = (abstractLabel: string, operatorName: string): FakeWell[] => {
  const seed = hashString(`${abstractLabel}-wells`)
  const rand = createRng(seed)
  const count = 2 + Math.floor(rand() * 2)
  const names = ['RED CREST 3H', 'HUMPHREY UNIT A', 'SOUTH BRANCH 1H', 'RIDGEVIEW 4V', 'MESA RIDGE 2H']
  const wells: FakeWell[] = []
  for (let i = 0; i < count; i += 1) {
    wells.push({
      lease_name: names[(seed + i * 3) % names.length],
      operator_name: i % 2 === 0 ? operatorName : FAKE_OPERATORS[(seed + i) % FAKE_OPERATORS.length],
      oil_gas_code: (seed + i) % 3 === 0 ? 'G' : 'O',
      well_type: (seed + i) % 4 === 0 ? 'VERTICAL' : 'HORIZONTAL',
    })
  }
  return wells
}

const makeFakeOwners = (abstractLabel: string, tractScore: number, fakeAcreage: number): FakeOwner[] => {
  const seed = hashString(`${abstractLabel}-owners`)
  const rand = createRng(seed)
  const ownerCount = 3 + Math.floor(rand() * 3)
  const usedNameIdx = new Set<number>()
  const owners: FakeOwner[] = []

  for (let i = 0; i < ownerCount; i += 1) {
    let nameIdx = (seed + i * 7) % FAKE_NAMES.length
    while (usedNameIdx.has(nameIdx)) {
      nameIdx = (nameIdx + 1) % FAKE_NAMES.length
    }
    usedNameIdx.add(nameIdx)

    const cityIdx = (seed + i * 5) % FAKE_CITIES.length
    const name = FAKE_NAMES[nameIdx]
    const location = FAKE_CITIES[cityIdx]
    const typeLabel = classifyOwnerType(name)

    const baseScore = Math.max(1, Math.min(10, Math.round(tractScore - i + (rand() * 2 - 1))))
    const score = i === 0 ? Math.max(baseScore, tractScore) : baseScore
    const decimal = Number((0.0008 + rand() * 0.12).toFixed(6))
    const ownershipPct = Number((decimal * 100).toFixed(4))
    const nra = Number((fakeAcreage * decimal).toFixed(3))
    const outOfState = location.state !== 'TX'

    const contactSeed = hashString(`${abstractLabel}-${name}-${i}`)
    const areaCode = FAKE_PHONES[contactSeed % FAKE_PHONES.length]
    const suffix = String((contactSeed % 9000) + 1000).padStart(4, '0')
    const emailPrefix = FAKE_EMAIL_PREFIXES[contactSeed % FAKE_EMAIL_PREFIXES.length]

    const key = `${abstractLabel}-${name}-${i}`
    owners.push({
      key,
      name,
      city: location.city,
      state: location.state,
      score,
      ownershipPct,
      decimal,
      nra,
      typeLabel,
      outOfState,
      signals: makeSignals({ outOfState, typeLabel, nra, score }),
      phone: `${areaCode} 555-${suffix}`,
      email: `${emailPrefix}●●●●@gmail.com`,
    })
  }

  return owners.sort((a, b) => b.score - a.score)
}

export default function DemoPage() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const layersReady = useRef(false)
  const loadingTimersRef = useRef<Record<string, number>>({})

  const [selectedTract, setSelectedTract] = useState<SelectedTract | null>(null)
  const [ownerSort, setOwnerSort] = useState<OwnerSort>('score')
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null)
  const [wellsExpanded, setWellsExpanded] = useState(false)
  const [skipTraceStates, setSkipTraceStates] = useState<Record<string, SkipTraceState>>({})
  const [addedToPipeline, setAddedToPipeline] = useState<Set<string>>(new Set())

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    const m = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-97.45, 29.45],
      zoom: 10,
    })
    map.current = m

    const tryAddLayers = async () => {
      if (layersReady.current) return
      if (!m.isStyleLoaded()) {
        setTimeout(() => {
          void tryAddLayers()
        }, 200)
        return
      }

      try {
        const parcelsData = await fetch('/gonzales_parcels_enriched.geojson', { cache: 'no-store' }).then((res) => res.json())
        if (!map.current) return

        const scoreExpr = [
          'to-number',
          ['coalesce', ['get', 'max_propensity_score'], 0],
        ] as const

        if (map.current.getLayer('demo-outline')) map.current.removeLayer('demo-outline')
        if (map.current.getLayer('demo-fill')) map.current.removeLayer('demo-fill')
        if (map.current.getSource('demo-parcels')) map.current.removeSource('demo-parcels')

        map.current.addSource('demo-parcels', { type: 'geojson', data: parcelsData, generateId: true })
        map.current.addLayer({
          id: 'demo-fill',
          type: 'fill',
          source: 'demo-parcels',
          paint: {
            'fill-color': [
              'step', scoreExpr,
              '#9E9E9E',
              2, '#81C784',
              5, '#FF9800',
              8, '#F44336',
              10, '#B71C1C',
            ],
            'fill-opacity': [
              'step', scoreExpr,
              0.3,
              2, 0.45,
              5, 0.7,
              8, 0.88,
              10, 1.0,
            ],
          },
        })

        map.current.addLayer({
          id: 'demo-outline',
          type: 'line',
          source: 'demo-parcels',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': ['step', scoreExpr, '#2d6a2d', 5, '#FFC107', 8, '#F44336'],
            'line-width': ['step', scoreExpr, 1.1, 6, 1.6, 8, 2.2],
            'line-opacity': 0.92,
          },
        })

        map.current.on('click', 'demo-fill', (e) => {
          const props = (e.features?.[0]?.properties ?? {}) as Record<string, unknown>
          const abstractLabel = String(props.ABSTRACT_L ?? props.abstract_label ?? 'Unknown')
          const surveyName = String(props.LEVEL1_SUR ?? props.level1_sur ?? 'Unknown')
          const tractScore = Number(props.max_propensity_score ?? 0)
          const fakeAcreage = getAcreageFromProps(props)
          const operatorName = FAKE_OPERATORS[hashString(abstractLabel) % FAKE_OPERATORS.length]
          const fieldName = String(props.field_name ?? `${abstractLabel} UNIT`)
          const owners = makeFakeOwners(abstractLabel, tractScore, fakeAcreage)
          const wells = makeFakeWells(abstractLabel, operatorName)
          const productionData = makeProductionData(abstractLabel)

          setSelectedTract({
            abstractLabel,
            surveyName,
            score: tractScore,
            fakeAcreage,
            operatorName,
            fieldName,
            owners,
            wells,
            productionData,
          })

          if (e.features?.[0]?.geometry) {
            const geometry = e.features[0].geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
            const bounds = new mapboxgl.LngLatBounds()
            const addCoords = (coords: number[][]) => {
              coords.forEach((c) => bounds.extend([c[0], c[1]] as [number, number]))
            }
            if (geometry.type === 'Polygon') {
              addCoords(geometry.coordinates[0] as number[][])
            } else if (geometry.type === 'MultiPolygon') {
              geometry.coordinates.forEach((poly) => addCoords(poly[0] as number[][]))
            }
            if (!bounds.isEmpty()) {
              map.current?.fitBounds(bounds, {
                padding: 120,
                duration: 800,
                maxZoom: 14
              })
            }
          }
        })

        map.current.on('mouseenter', 'demo-fill', () => {
          m.getCanvas().style.cursor = 'pointer'
        })
        map.current.on('mouseleave', 'demo-fill', () => {
          m.getCanvas().style.cursor = ''
        })

        layersReady.current = true
      } catch (err) {
        console.error('Demo map failed to load GeoJSON:', err)
      }
    }

    m.on('load', tryAddLayers)
    return () => {
      Object.values(loadingTimersRef.current).forEach((id) => window.clearTimeout(id))
      m.remove()
      map.current = null
      layersReady.current = false
    }
  }, [])

  useEffect(() => {
    setOwnerSort('score')
    setExpandedOwner(null)
    setWellsExpanded(false)
    setSkipTraceStates({})
    setAddedToPipeline(new Set())
    Object.values(loadingTimersRef.current).forEach((id) => window.clearTimeout(id))
    loadingTimersRef.current = {}
  }, [selectedTract?.abstractLabel])

  useEffect(() => {
    for (const [ownerKey, state] of Object.entries(skipTraceStates)) {
      if (state === 'loading' && !loadingTimersRef.current[ownerKey]) {
        loadingTimersRef.current[ownerKey] = window.setTimeout(() => {
          setSkipTraceStates((prev) => {
            if (prev[ownerKey] !== 'loading') return prev
            return { ...prev, [ownerKey]: 'result' }
          })
          delete loadingTimersRef.current[ownerKey]
        }, 2000)
      }
      if (state !== 'loading' && loadingTimersRef.current[ownerKey]) {
        window.clearTimeout(loadingTimersRef.current[ownerKey])
        delete loadingTimersRef.current[ownerKey]
      }
    }
  }, [skipTraceStates])

  const sortedOwners = useMemo(() => {
    if (!selectedTract) return []
    const owners = [...selectedTract.owners]
    if (ownerSort === 'interest') {
      owners.sort((a, b) => b.ownershipPct - a.ownershipPct)
    } else if (ownerSort === 'nra') {
      owners.sort((a, b) => b.nra - a.nra)
    } else {
      owners.sort((a, b) => b.score - a.score)
    }
    return owners
  }, [ownerSort, selectedTract])

  const productionPeak = useMemo(
    () => selectedTract?.productionData.reduce((max, p) => Math.max(max, p.oil), 0) ?? 0,
    [selectedTract]
  )

  return (
    <div style={{ background: '#FFFFFF', height: '100vh', color: '#111827', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          height: 38,
          minHeight: 38,
          background: '#FFFFFF',
          borderBottom: '1px solid #E5E7EB',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#EF9F27', display: 'inline-block' }} />
          <span style={{ fontSize: 11, letterSpacing: '0.09em', fontWeight: 700, color: '#111827' }}>MINERAL MAP</span>
          <span style={{ width: 1, height: 12, background: '#E5E7EB', display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: '#6B7280' }}>Gonzales County, TX</span>
        </div>
        <span style={{ fontSize: 11, color: '#9CA3AF' }}>Demo Mode</span>
      </div>

      <div
        style={{
          height: 28,
          minHeight: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(239,159,39,0.1)',
          borderBottom: '1px solid rgba(239,159,39,0.25)',
          color: 'rgba(239,159,39,0.9)',
          fontSize: 11,
          fontWeight: 600,
          textAlign: 'center',
          padding: '0 10px',
        }}
      >
        Interactive demo. Owner names are anonymized and some features are intentionally omitted. Sign up at getmineralmap.com to access real data.
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          style={{
            width: 260,
            minWidth: 260,
            background: '#F8F8F8',
            borderRight: '1px solid #E5E7EB',
            overflowY: 'auto',
            padding: 14,
          }}
        >
          {selectedTract ? (
            <div>
              <button
                onClick={() => setSelectedTract(null)}
                style={{
                  border: 'none',
                  background: 'none',
                  color: '#6B7280',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: '12px 16px',
                  marginBottom: 4,
                  fontFamily: 'Inter, sans-serif',
                }}
              >
                Back
              </button>

              <div style={{ fontSize: 18, fontFamily: 'Georgia, serif', color: '#111827', fontWeight: 700 }}>
                {selectedTract.abstractLabel}
              </div>
              <div style={{ color: '#6B7280', marginTop: 4 }}>{selectedTract.surveyName} Survey</div>
              <div style={{ borderTop: '1px solid #E5E7EB', marginTop: 10, marginBottom: 10 }} />

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 12, background: 'rgba(244,67,54,0.15)', color: '#F44336', border: '0.5px solid rgba(244,67,54,0.35)' }}>
                  {selectedTract.score}/10 HOT
                </span>
                <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 12, background: 'rgba(239,159,39,0.15)', color: '#EF9F27', border: '0.5px solid rgba(239,159,39,0.35)' }}>
                  {selectedTract.owners.length} owners
                </span>
                <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 12, background: '#F3F4F6', color: '#6B7280', border: '1px solid #E5E7EB' }}>
                  {selectedTract.operatorName}
                </span>
              </div>

              <div style={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, padding: 12, marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ color: '#EF9F27', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>PRODUCTION HISTORY</div>
                <div style={{ width: '100%', height: 140, minHeight: 140 }}>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={selectedTract.productionData}>
                      <XAxis dataKey="month" stroke="#6B7280" tick={{ fill: '#6B7280', fontSize: 10 }} />
                      <YAxis stroke="#6B7280" tick={{ fill: '#6B7280', fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ background: '#FFFFFF', border: '1px solid #E5E7EB', color: '#111827' }}
                        labelStyle={{ color: '#6B7280' }}
                      />
                      <Line type="monotone" dataKey="oil" stroke="#EF9F27" strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: '#6B7280' }}>
                  <span>Peak production: {productionPeak.toLocaleString()}</span>
                  <span>Current trend: Declining</span>
                </div>
              </div>

              <div style={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, padding: 12, marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ color: '#EF9F27', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>OPERATOR & LEASE INFO</div>
                <div style={{ fontSize: 12, color: '#111827', marginBottom: 6 }}>Operator: {selectedTract.operatorName}</div>
                <div style={{ fontSize: 12, color: '#111827', marginBottom: 6 }}>Field: {selectedTract.fieldName}</div>
                <div style={{ fontSize: 12, color: '#111827', marginBottom: 6 }}>Well status: PRODUCING</div>
                <div style={{ fontSize: 12, color: '#111827' }}>Est. lease expiration: 2031</div>
              </div>

              <div style={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
                <div style={{ borderTop: '1px solid #F3F4F6' }}>
                  <button
                    onClick={() => setWellsExpanded((prev) => !prev)}
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
                      color: '#6B7280',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}>
                      Wells in this tract ({selectedTract.wells.length})
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: '#9CA3AF',
                      transform: wellsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}>
                      ▼
                    </div>
                  </button>

                  {wellsExpanded && (
                    <div style={{ paddingBottom: 8 }}>
                      {selectedTract.wells.map((well, i) => (
                        <div
                          key={`${well.lease_name}-${i}`}
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
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {well.lease_name}
                            </div>
                            <div style={{ fontSize: 11, color: '#6B7280' }}>
                              {well.operator_name}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
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

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 16px',
                  borderBottom: '1px solid #F3F4F6',
                  background: '#F9FAFB',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#6B7280',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  All owners in tract ({sortedOwners.length})
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[
                    { key: 'score', label: 'Score' },
                    { key: 'interest', label: '% Ownership' },
                    { key: 'nra', label: 'NRA' },
                  ].map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setOwnerSort(s.key as OwnerSort)}
                      style={{
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif',
                        fontWeight: ownerSort === s.key ? 600 : 400,
                        background: ownerSort === s.key ? '#EF9F27' : 'transparent',
                        border: ownerSort === s.key ? '1px solid #EF9F27' : '1px solid #E5E7EB',
                        color: ownerSort === s.key ? '#fff' : '#6B7280',
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                {sortedOwners.map((owner, i) => {
                  const isExpanded = expandedOwner === i
                  const scoreBadge = scoreBadgeStyle(owner.score)
                  const typeBadge = typeBadgeStyle(owner.typeLabel)
                  const skipTraceState = skipTraceStates[owner.key] ?? 'idle'
                  const inPipeline = addedToPipeline.has(owner.key)

                  return (
                    <div key={owner.key} style={{ borderBottom: '1px solid #F3F4F6' }}>
                      <div
                        onClick={() => setExpandedOwner(isExpanded ? null : i)}
                        style={{
                          padding: '10px 16px',
                          cursor: 'pointer',
                          background: isExpanded ? '#FFFBEB' : 'transparent',
                          borderLeft: isExpanded ? '3px solid #EF9F27' : '3px solid transparent',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          if (!isExpanded) e.currentTarget.style.background = '#F9FAFB'
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded) e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, marginRight: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
                              {i + 1}. {owner.name}
                            </div>
                            <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
                              {owner.city}, {owner.state}
                            </div>
                            <div
                              style={{ fontSize: 10, color: '#374151', fontFamily: 'monospace', fontWeight: 600, marginTop: 2 }}
                            >
                              {owner.nra.toFixed(3)} NRA
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10 }}>
                              <span style={{ color: '#9CA3AF' }}>DO Interest:</span>
                              <span style={{ color: '#374151', fontFamily: 'monospace', fontWeight: 600 }}>
                                {owner.decimal.toFixed(6)}
                              </span>
                              <span style={{ color: '#9CA3AF' }}>
                                ({owner.ownershipPct.toFixed(4)}%)
                              </span>
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: scoreBadge.text,
                                background: scoreBadge.bg,
                                borderRadius: 4,
                                padding: '2px 7px',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {owner.score}/10
                            </span>
                            <span
                              style={{
                                fontSize: 9,
                                padding: '1px 5px',
                                borderRadius: 6,
                                background: typeBadge.bg,
                                color: typeBadge.color,
                                border: typeBadge.border,
                              }}
                            >
                              {owner.typeLabel}
                            </span>
                            {owner.outOfState && (
                              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: 'rgba(239,159,39,0.12)', color: '#B45309', border: '0.5px solid rgba(239,159,39,0.3)' }}>
                                OOS
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: 9, color: '#9CA3AF', marginTop: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
                          <span style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
                          {isExpanded ? 'Hide score breakdown' : 'Why this score?'}
                        </div>
                      </div>

                      {isExpanded && (
                        <div style={{ padding: '8px 16px 12px 28px', background: '#FFFBEB', borderTop: '1px solid #FDE68A' }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: '#92400E', letterSpacing: '0.08em', marginBottom: 6, textTransform: 'uppercase' }}>
                            Score Signals
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {owner.signals.map((signal, si) => (
                              <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#EF9F27', flexShrink: 0 }} />
                                <span style={{ fontSize: 11, color: '#374151' }}>{signal}</span>
                              </div>
                            ))}
                          </div>

                          <div style={{ marginTop: 10 }}>
                            {skipTraceState === 'idle' && (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setAddedToPipeline((prev) => {
                                      const next = new Set(prev)
                                      next.add(owner.key)
                                      return next
                                    })
                                  }}
                                  style={{
                                    fontSize: 10,
                                    padding: '4px 10px',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    background: inPipeline ? 'rgba(122,184,53,0.15)' : 'rgba(239,159,39,0.12)',
                                    border: inPipeline ? '0.5px solid #7AB835' : '0.5px solid #EF9F27',
                                    color: inPipeline ? '#7AB835' : '#B45309',
                                  }}
                                >
                                  {inPipeline ? 'In pipeline' : '+ Add to pipeline'}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSkipTraceStates((prev) => ({ ...prev, [owner.key]: 'loading' }))
                                  }}
                                  style={{
                                    fontSize: 10,
                                    padding: '4px 10px',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    background: 'transparent',
                                    border: '0.5px solid #E5E7EB',
                                    color: '#6B7280',
                                  }}
                                >
                                  Skip trace
                                </button>
                              </div>
                            )}

                            {skipTraceState === 'loading' && (
                              <div style={{ marginTop: 8, color: '#9CA3AF', fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>
                                Searching records...
                              </div>
                            )}

                            {skipTraceState === 'result' && (
                              <div
                                style={{
                                  background: '#FFF9F0',
                                  border: '1px solid rgba(239,159,39,0.3)',
                                  borderRadius: 6,
                                  padding: 10,
                                  marginTop: 8,
                                }}
                              >
                                <div style={{ color: '#7AB835', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 5 }}>
                                  CONTACT FOUND
                                </div>
                                <div style={{ color: '#111827', fontSize: 12, fontWeight: 700 }}>{owner.phone}</div>
                                <div style={{ color: '#2563EB', fontSize: 11, marginTop: 2 }}>{owner.email}</div>
                                <div style={{ marginTop: 6, fontSize: 10, color: '#9CA3AF' }}>
                                  <Link href="/pricing" style={{ color: '#9CA3AF', textDecoration: 'none' }}>
                                    Sign up to skip trace real owners
                                  </Link>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div style={{ display: 'flex', marginTop: 14 }}>
                <button style={{ width: '100%', padding: '9px', borderRadius: 6, border: '0.5px solid rgba(239,159,39,0.4)', background: 'rgba(239,159,39,0.15)', color: '#EF9F27', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                  Add all to pipeline
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 16 }}>
                County Overview
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { value: '73,430', label: 'Mineral owners scored' },
                  { value: '557', label: 'Survey abstracts' },
                  { value: '9.2', label: 'Avg hot tract score' },
                  { value: '4,217', label: 'Wells tracked' },
                ].map((card) => (
                  <div
                    key={card.label}
                    style={{
                      background: '#FFFFFF',
                      border: '1px solid #E5E7EB',
                      borderRadius: 8,
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>{card.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1.1 }}>{card.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' }}>
                Click any tract on the map to see ranked owners
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
          <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </div>
  )
}
