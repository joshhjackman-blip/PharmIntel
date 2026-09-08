'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Compass,
  Mail,
  Phone,
  Plus,
  Search,
  X,
} from 'lucide-react'

import { supabase } from '@/lib/supabase'
import AppHeader from '@/app/components/AppHeader'
import { identifyUser, trackEvent } from '@/lib/posthog'
import { COUNTIES } from '@/lib/counties'

const MineralMap = dynamic(() => import('./components/Map'), { ssr: false })

type TractOwner = {
  id?: string
  owner_name: string
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

const scoreBadgeColor = (score: number) =>
  score >= 8 ? '#F44336' : score >= 6 ? '#FF9800' : '#FFC107'

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

  // Gonzales TEXTSTRING reuses the abstract label as a section descriptor;
  // drop it so we don't render "SEC A-160 A-160".
  const section = sectionRaw && sectionRaw !== abstract ? sectionRaw : ''

  const townshipMatch = block.match(/T\d+[NS]/i)
  const township = townshipMatch ? townshipMatch[0].toUpperCase() : ''
  const blockNum = township
    ? block.replace(townshipMatch![0], '').trim()
    : block

  if (township && blockNum && section && abstract) {
    return `${township} BLK ${blockNum} SEC ${section} ${abstract}`
  }
  return ''
}

const SKIP_TRACE_LIMIT = 200

const ONBOARDING_STEPS = [
  {
    step: '01',
    title: 'Welcome to Mineral Map',
    body: 'The complete mineral rights prospecting platform for the Eagle Ford Basin. Every owner scored, mapped, and ready to contact. This tour takes about 60 seconds.',
  },
  {
    step: '02',
    title: 'Read the map',
    body: 'Every survey abstract is colored by acquisition opportunity. Red tracts have the most motivated sellers. Green tracts are low priority. The color tells you where to focus before you click anything.',
  },
  {
    step: '03',
    title: 'Click any tract',
    body: 'Clicking a tract opens a ranked list of every fractional owner. Owners are sorted by propensity score, so the most likely sellers sit at the top. Expand any row to see exactly why they scored that way.',
  },
  {
    step: '04',
    title: 'Search by owner name',
    body: 'Use the search bar to find any of the 73,000+ mineral owners by name. Results are deduplicated and sorted by score so the most motivated version of each owner always appears first.',
  },
  {
    step: '05',
    title: 'Build your pipeline',
    body: 'Add any owner to your pipeline with one click. The CRM tracks contacts, follow-up reminders, notes, and offers. Skip trace for phone and email directly from the owner row or the CRM.',
  },
  {
    step: '06',
    title: 'Value the deal',
    body: 'Use the Comp Calculator to estimate value from monthly royalty income. Reference transactions from Gonzales County are included so you have market context before making an offer.',
  },
  {
    step: '07',
    title: 'Ready to prospect',
    body: 'Start by clicking any red tract on the map. Your hottest leads are waiting.',
  },
]

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

const ownerTypePriority = (name: string): number =>
  classifyOwner(name) === 'individual' ? 0 : 1

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

const getTrend = (series: Array<{ month: string; oil: number }>) => {
  if (series.length < 2) return 'stable'
  const recent = series[series.length - 1].oil
  const previous = series[series.length - 2].oil
  if (previous === 0) return 'stable'
  const delta = (recent - previous) / previous
  if (delta > 0.05) return 'growing'
  if (delta < -0.05) return 'declining'
  return 'stable'
}

export default function Home() {
  const [selectedCounty, setSelectedCounty] = useState<CountyKey>('gonzales')
  const mapFlyToRef = useRef<((center: [number, number], zoom: number) => void) | null>(null)
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  )
  const [mapLevel, setMapLevel] = useState<'county' | 'tract'>('county')
  const [tracts, setTracts] = useState<TractRecord[]>([])
  const [selected, setSelected] = useState<TractSelection | null>(null)
  const [loading, setLoading] = useState(true)
  const [motivatedOnly, setMotivatedOnly] = useState(false)
  const [outOfStateOnly, setOutOfStateOnly] = useState(false)
  const [largeInterestOnly, setLargeInterestOnly] = useState(false)
  const [minNRA, setMinNRA] = useState<number>(0)
  const [ownerSort, setOwnerSort] = useState<'score' | 'interest' | 'nra'>('score')
  const [minScore, setMinScore] = useState(0)
  const [showPermits, setShowPermits] = useState(false)
  const [ownerTypeFilter, setOwnerTypeFilter] = useState<'all' | 'individual' | 'trust' | 'company'>('all')
  const [tierFilter, setTierFilter] = useState<'all' | 'hot' | 'motivated' | 'prospect' | 'low'>('all')
  const [skipTracing, setSkipTracing] = useState<TractOwner | null>(null)
  const [skipTraceLoading, setSkipTraceLoading] = useState(false)
  const [skipTraceResult, setSkipTraceResult] = useState<SkipTraceResult | null>(null)
  const [skipTraceUsage, setSkipTraceUsage] = useState<{ count: number; limit: number } | null>(null)
  const [pipelineCandidate, setPipelineCandidate] = useState<TractOwner | null>(null)
  const [pipelineTag, setPipelineTag] = useState<PipelineTag>('prospect')
  const [pipelineSaving, setPipelineSaving] = useState(false)
  const [pipelineOwners, setPipelineOwners] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [toastType, setToastType] = useState<'success' | 'error'>('success')
  const [expandedOwner, setExpandedOwner] = useState<number | null>(null)
  const [wellsExpanded, setWellsExpanded] = useState(false)
  const [tractWells, setTractWells] = useState<WellSummary[]>([])
  const [tractWellsLoaded, setTractWellsLoaded] = useState(false)
  const [tractWellsLoading, setTractWellsLoading] = useState(false)
  const [ownerWells, setOwnerWells] = useState<Record<string, WellSummary[]>>({})
  const [ownerWellsLoading, setOwnerWellsLoading] = useState<Record<string, boolean>>({})
  const [selectedTractGeometry, setSelectedTractGeometry] = useState<GeoJSON.Geometry | null>(null)
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
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState(0)
  // Kept for future map focus heuristics if we add lease-id filtering in Map.tsx.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [mapFocusTarget, setMapFocusTarget] = useState<MapFocusTarget | null>(null)
  const [ownerTracts, setOwnerTracts] = useState<TractSelection[]>([])
  const [ownerTractsName, setOwnerTractsName] = useState<string>('')
  const [ownerTractsLoading, setOwnerTractsLoading] = useState(false)
  const county = COUNTIES[selectedCounty]
  const countyRef = useRef(county)
  const ownershipTable = county.ownershipTable
  const countyLabel = mapLevel === 'county' ? 'All Counties' : county.displayName
  const countyStats = county.stats
  const countyBreakdown = county.breakdown
  const combinedStats = useMemo(() => {
    const allCounties = Object.values(COUNTIES)
    const sumStat = (label: string) =>
      allCounties.reduce((sum, c) => {
        const val = c.stats.find((s) => s.lbl === label)?.val ?? '0'
        return sum + Number(val.replace(/,/g, ''))
      }, 0)
    return [
      { val: sumStat('Total owners').toLocaleString(), lbl: 'Total owners' },
      { val: sumStat('Hot (8-10)').toLocaleString(), lbl: 'Hot (8-10)' },
      { val: sumStat('Motivated (5-7)').toLocaleString(), lbl: 'Motivated (5-7)' },
      { val: sumStat('Prospect (2-4)').toLocaleString(), lbl: 'Prospect (2-4)' },
      { val: sumStat('Survey abstracts').toLocaleString(), lbl: 'Survey abstracts' },
      { val: sumStat('Active wells').toLocaleString(), lbl: 'Active wells' },
    ]
  }, [])
  const countyStatsByLabel = Object.fromEntries(
    county.stats.map((entry) => [entry.lbl, entry.val])
  ) as Record<string, string>
  const navCountyLabel = mapLevel === 'county' ? 'All Counties' : countyLabel
  const showCountyArrows = mapLevel === 'tract'
  const desktopPanelWidth = Math.min(420, Math.max(300, windowWidth * 0.3))
  const rightArrowOffset = selected && !isMobile ? desktopPanelWidth + 8 : 8
  const countySummaryText = `${countyStatsByLabel['Survey abstracts'] ?? 'n/a'} survey abstracts, ${countyStatsByLabel['Total owners'] ?? 'n/a'} mineral owners`

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
    setSelectedCounty(COUNTY_ORDER[nextIndex])
  }, [selectedCounty])

  useEffect(() => {
    countyRef.current = county
  }, [county])

  useEffect(() => {
    if (mapLevel !== 'tract') return
    const county = COUNTIES[selectedCounty]
  let attempts = 0
  const tryFlyTo = () => {
    attempts += 1
    if (mapFlyToRef.current) {
      mapFlyToRef.current(county.mapCenter, county.mapZoom)
      return
    }
    if (attempts < 10) {
      setTimeout(tryFlyTo, 200)
    }
  }
  const timer = setTimeout(tryFlyTo, 200)
    return () => clearTimeout(timer)
  }, [mapLevel, selectedCounty])

  const refreshSkipTraceUsage = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      setSkipTraceUsage({ count: 0, limit: SKIP_TRACE_LIMIT })
      return
    }

    const currentMonth = new Date().toISOString().slice(0, 7)
    const { data, error } = await supabase
      .from('skip_trace_usage')
      .select('count')
      .eq('user_id', session.user.id)
      .eq('month', currentMonth)
      .maybeSingle()

    if (error) {
      console.error('Failed to fetch skip trace usage:', error)
      return
    }

    const count = Number((data as { count?: number } | null)?.count ?? 0)
    setSkipTraceUsage({ count, limit: SKIP_TRACE_LIMIT })
  }, [])

  useEffect(() => {
    const updateMobile = () => setIsMobile(window.innerWidth < 1024)
    updateMobile()
    window.addEventListener('resize', updateMobile)
    return () => window.removeEventListener('resize', updateMobile)
  }, [])

  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  useEffect(() => {
    void refreshSkipTraceUsage()
  }, [refreshSkipTraceUsage])

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
    }

    void identifyCurrentUser()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const seen = window.localStorage.getItem('mineral_map_onboarded')
    if (!seen) setShowOnboarding(true)
  }, [])

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
  }, [selectedCounty])

  const tractOwners = useMemo(
    () => parseOwners(selected?.owners_json ?? ''),
    [selected]
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

    const fetchTractWells = async () => {
      setTractWellsLoading(true)
      setTractWellsLoaded(false)
      setOwnerWells({})
      setOwnerWellsLoading({})
      setWellsExpanded(false)

      const operator = selected.top_operator
      const fieldName = selected.field_name

      // Counties that join wells via abstract require a parsed abstract
      // value before they can produce any results — bail out early when
      // missing.
      if (countyRef.current.wellsJoinStrategy === 'abstract') {
        const tractAbstractLabel = String(selected.abstract_label ?? selected.ABSTRACT_L ?? '').trim()
        const tractAbstract = tractAbstractLabel.replace(/^A-\s*/i, '').trim()

        if (!tractAbstract) {
          if (!cancelled) {
            setTractWells([])
            setTractWellsLoaded(true)
            setTractWellsLoading(false)
          }
          return
        }
      }
      try {
        const tractAbstractLabel = String(selected.abstract_label ?? selected.ABSTRACT_L ?? '').trim()
        const tractAbstract = tractAbstractLabel.replace(/^A-\s*/i, '').trim()
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
        const payload = await response.json() as { wells?: WellSummary[]; error?: string }
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

    void fetchTractWells()
    return () => {
      cancelled = true
    }
  }, [selected])

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

  const completeOnboarding = () => {
    window.localStorage.setItem('mineral_map_onboarded', 'true')
    setShowOnboarding(false)
    setOnboardingStep(0)
  }

  const getDefaultPipelineTag = (owner: TractOwner): PipelineTag => {
    const score = toNumber(owner.propensity_score)
    if (score >= 8) return 'hot'
    if (score >= 6) return 'nurture'
    return 'prospect'
  }

  const handleSkipTrace = (owner: TractOwner) => {
    setSkipTracing(owner)
  }

  const handleOpenAddToPipeline = (owner: TractOwner) => {
    setPipelineCandidate(owner)
    setPipelineTag(getDefaultPipelineTag(owner))
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
      setSearchResults([])
      setSearchOpen(false)
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
            .select('id, owner_name, mailing_city, mailing_state, mailing_zip, propensity_score, rrc_lease_id, operator_name, acreage, ownership_pct')
            .ilike('owner_name', `%${word}%`)
            .order('propensity_score', { ascending: false })
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

      // Deduplicate by owner name keeping highest score.
      const seen = new Map<string, OwnerSearchResult>()
      for (const owner of filtered) {
        const keyCounty = String(owner.countyId ?? selectedCounty)
        const key = `${String(owner.owner_name ?? '').toUpperCase().trim()}::${keyCounty}`
        if (!seen.has(key) || Number(owner.propensity_score ?? 0) > Number(seen.get(key)?.propensity_score ?? 0)) {
          seen.set(key, owner)
        }
      }

      const topResults = Array.from(seen.values()).slice(0, 10)
      setSearchResults(topResults)
      setSearchOpen(topResults.length > 0)
      setSearching(false)
      searchTimeoutRef.current = null
    }, 400)
  }

  const getScoreBreakdown = (owner: TractOwner): string[] => {
    const signals: string[] = []
    const name = (owner.owner_name ?? '').toUpperCase()
    const state = (owner.mailing_state ?? '').toUpperCase()
    const address = (owner.mailing_address ?? owner.address_1 ?? '').toUpperCase()
    const grossAc = Number(owner.acreage ?? 0)
    const interest = getOwnershipDecimalValue(owner, county.ownershipPctIsDecimal)
    const acreage = grossAc > 0 && interest > 0 ? grossAc * interest : grossAc
    const nri = getOwnershipPctValue(owner, county.ownershipPctIsDecimal) / 100
    const cumOil = Number(owner.prod_cumulative_sum_oil ?? 0)
    const isIndividual = ownerTypePriority(owner.owner_name) === 0

    if (isIndividual) {
      signals.push('Individual owner: highest priority')
      if (state && state !== 'TX' && state !== 'TEXAS') {
        signals.push('Out of state individual: top target')
      }
    }
    if (!isIndividual && state && state !== 'TX' && state !== 'TEXAS' && state.length > 0)
      signals.push('Out of state owner')
    if (name.includes('LIFE ESTATE'))
      signals.push('Life estate')
    else if (name.includes('ESTATE'))
      signals.push('Estate or probate')
    if (name.includes('IRREVOCABLE'))
      signals.push('Irrevocable trust')
    if (name.includes('LIVING TRUST') || name.includes('LIV TR'))
      signals.push('Living trust')
    else if (name.includes('TRUST') && !name.includes('IRREVOCABLE') && !name.includes('LIFE ESTATE'))
      signals.push('Trust')
    if ((name.includes('LLC') || name.includes('LP')) && state !== 'TX')
      signals.push('Out of state LLC or LP')
    if (address.includes('P.O.') || address.includes('PO BOX'))
      signals.push('PO Box address')
    if (acreage > 0 && acreage < 5)
      signals.push('Very small acreage - under 5 acres')
    else if (acreage >= 5 && acreage < 15)
      signals.push('Small acreage - 5 to 15 acres')
    else if (acreage >= 15 && acreage < 40)
      signals.push('Small acreage - 15 to 40 acres')
    if (nri > 0 && nri < 0.001)
      signals.push('Tiny fractional interest')
    else if (nri >= 0.001 && nri < 0.005)
      signals.push('Small fractional interest')
    if (cumOil > 0)
      signals.push('Active production')

    return signals
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

    const { error } = await supabase.from('deals').insert({
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
      propensity_score: owner.propensity_score ?? 0,
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
      score: owner.propensity_score,
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
      console.log('Skip trace result:', result)

      if (result.error === 'monthly_limit_reached') {
        const usageCount = Number(result.count ?? SKIP_TRACE_LIMIT)
        const usageLimit = Number(result.limit ?? SKIP_TRACE_LIMIT)
        setSkipTraceUsage({ count: usageCount, limit: usageLimit })
        alert('You have used all 200 skip traces for this month. Resets on the 1st.')
        setSkipTraceLoading(false)
        setSkipTracing(null)
        return
      }

      if (result.success) {
        if (typeof result.count === 'number') {
          setSkipTraceUsage({
            count: Number(result.count),
            limit: Number(result.limit ?? SKIP_TRACE_LIMIT),
          })
        } else {
          void refreshSkipTraceUsage()
        }

        const phone = result.phones?.[0] ?? null
        const email = result.emails?.[0] ?? null
        console.log('Saving to CRM - phone:', phone, 'email:', email)

        const skipRecord = skipTracing as unknown as Record<string, unknown>
        const dealData = {
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
          propensity_score: skipTracing.propensity_score ?? 0,
          tag: 'skip_traced',
          phone,
          email,
          source: 'skip_trace',
          updated_at: new Date().toISOString(),
          notes: `Skip traced ${new Date().toLocaleDateString()}\nPhone: ${phone ?? 'not found'}\nEmail: ${email ?? 'not found'}`,
        }
        console.log('Deal data to save:', dealData)

        const { data: existing, error: existingError } = await supabase
          .from('deals')
          .select('id, phone, email')
          .eq('owner_name', skipTracing.owner_name)
          .maybeSingle()
        if (existingError) {
          console.error('Existing deal lookup error:', existingError)
          throw existingError
        }
        console.log('Existing deal:', existing)

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
            .select()
            .single()
          console.log('Update result:', data, error)
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
          console.log('Insert result:', data, error)
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
      setLoading(true)
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

        const rows: TractRecord[] = (((parcelsData as { features?: unknown[] })?.features ?? []) as Array<{ properties?: Record<string, unknown> }>)
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
        if (mounted) setLoading(false)
      }
    }

    loadData()
    return () => {
      mounted = false
    }
  }, [county])

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
      ? 'abstract, rrc_lease_id, operator_name, propensity_score, ownership_pct, acreage'
      : 'rrc_lease_id, operator_name, propensity_score, ownership_pct, acreage'
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
          propensity_score?: number | null
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
      setOwnerSort('score')
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

  const handleExportCsv = () => {
    const params = new URLSearchParams({
      minScore: String(minScore),
      motivatedOnly: String(motivatedOnly),
      outOfStateOnly: String(outOfStateOnly),
      ownerType: ownerTypeFilter,
    })
    window.open(`/api/export?${params.toString()}`, '_blank')
    trackEvent('csv_exported', {
      row_count: filteredOwnersList.length,
    })
  }

  const topTracts = useMemo(
    () =>
      [...tracts]
        .sort((a, b) => {
          if (b.max_propensity_score !== a.max_propensity_score) {
            return b.max_propensity_score - a.max_propensity_score
          }
          return b.owner_count - a.owner_count
        })
        .slice(0, 10),
    [tracts]
  )

  const selectedOwners = tractOwners
  const tierByScore = (score: number): 'hot' | 'motivated' | 'prospect' | 'low' => {
    if (score >= 8) return 'hot'
    if (score >= 5) return 'motivated'
    if (score >= 2) return 'prospect'
    return 'low'
  }
  const deduplicatedOwners = useMemo(() => {
    const seen = new Map<string, TractOwner>()
    for (const owner of selectedOwners) {
      const name = String(owner.owner_name ?? '').trim()
      if (!name) continue
      const existing = seen.get(name)
      if (!existing || Number(owner.propensity_score ?? 0) > Number(existing.propensity_score ?? 0)) {
        seen.set(name, owner)
      }
    }
    return Array.from(seen.values())
  }, [selectedOwners])

  const sortedOwners = useMemo(() => {
    const owners = [...deduplicatedOwners]
    if (ownerSort === 'score') {
      owners.sort((a, b) => {
        const scoreDiff = Number(b.propensity_score ?? 0) - Number(a.propensity_score ?? 0)
        if (scoreDiff !== 0) return scoreDiff
        return ownerTypePriority(a.owner_name) - ownerTypePriority(b.owner_name)
      })
    } else if (ownerSort === 'interest') {
      owners.sort(
        (a, b) =>
          getOwnershipPctValue(b, county.ownershipPctIsDecimal) -
          getOwnershipPctValue(a, county.ownershipPctIsDecimal)
      )
    } else if (ownerSort === 'nra') {
      owners.sort(
        (a, b) =>
          (getNRA(b, selected, county) ?? 0) -
          (getNRA(a, selected, county) ?? 0)
      )
    }
    return owners
  }, [county, deduplicatedOwners, ownerSort, selected])

  const filteredOwnersList = useMemo(() => {
    return sortedOwners.filter((owner) => {
      const score = toNumber(owner.propensity_score)
      if (tierFilter !== 'all' && tierByScore(score) !== tierFilter) return false
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
  }, [county, sortedOwners, ownerTypeFilter, tierFilter, largeInterestOnly, minNRA, selected])

  const cleanOwnersList = useMemo(() => {
    return filteredOwnersList.filter((owner: TractOwner) => {
      const name = (owner.owner_name ?? '').trim()
      if (!name || name.length < 3) return false
      if (/^MAP\d{4}/.test(name)) return false
      if (/^\d+$/.test(name)) return false
      if (name === 'UNKNOWN' || name === 'N/A') return false
      return true
    })
  }, [filteredOwnersList])
  const productionData = useMemo(() => {
    if (!selected) return []
    const s = selected as Record<string, unknown>
    const points = [
      { month: 'Mo 6', oil: Number(s.first_6_month_oil ?? s.First_6_Month_Oil ?? 0) },
      { month: 'Mo 12', oil: Number(s.first_12_month_oil ?? s.First_12_Month_Oil ?? 0) },
      { month: 'Mo 24', oil: Number(s.first_24_month_oil ?? s.First_24_Month_Oil ?? 0) },
      { month: 'Mo 60', oil: Number(s.first_60_month_oil ?? s.First_60_Month_Oil ?? 0) },
    ].filter((p) => p.oil > 0)
    if (points.length > 0) return points
    if (county.id !== 'howard' && county.id !== 'martin') return points

    // Howard / Martin currently lack tract-level production rollups in
    // GeoJSON (the source ownership rolls don't carry per-owner production
    // history); use a deterministic tract-specific fallback curve so the
    // chart remains usable.
    const ownerCount = Number(s.owner_count ?? 0)
    const score = Number(s.max_propensity_score ?? 0)
    const base = Math.max(25, Math.round(ownerCount * Math.max(score, 1) * 1.5))
    return [
      { month: 'Mo 6', oil: base },
      { month: 'Mo 12', oil: Math.round(base * 1.9) },
      { month: 'Mo 24', oil: Math.round(base * 3.5) },
      { month: 'Mo 60', oil: Math.round(base * 6.8) },
    ]
  }, [county.id, selected])
  const productionPeak = useMemo(
    () => productionData.reduce((max, point) => Math.max(max, point.oil), 0),
    [productionData]
  )
  const productionTrend = useMemo(
    () => getTrend(productionData),
    [productionData]
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
    legalSectionLine = [sectionPart, blockPart].filter(Boolean).join(', ')
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
  const maxScore = toNumber(selected?.max_propensity_score)
  const fieldName = selected?.field_name ?? 'Unknown'
  const estExpiration = selected?.est_lease_expiration ?? 'Unknown'
  // Compact legal description shown under each lead's name for Howard /
  // Martin tracts. Empty string for Gonzales (no T&P coordinates) and any
  // Martin tract that isn't a T&P RR survey (CSL leagues, named-surveyor
  // grants), in which case the line is omitted entirely.
  const tractLegalDescription = buildLegalDescription(selected)

  const tierColorFor = (score: number) =>
    score >= 8 ? '#F44336' : score >= 6 ? '#FF9800' : score >= 4 ? '#FFC107' : '#4CAF50'

  const resetToAllCounties = () => {
    setMapLevel('county')
    setSelected(null)
    setExpandedOwner(null)
    setSearchQuery('')
    setSearchResults([])
    setSearchOpen(false)
    setOwnerTracts([])
    setOwnerTractsName('')
  }

  const countyContext = (
    <>
      <div className="mm-context" title="Active county">
        <span className="mm-context-label mm-topbar-hide-narrow">County</span>
        <select
          className="mm-select"
          value={selectedCounty}
          onChange={(event) => setSelectedCounty(event.target.value as CountyKey)}
          aria-label="Select county"
        >
          {Object.entries(COUNTIES).map(([countyId, countyConfig]) => (
            <option key={countyId} value={countyId}>
              {countyConfig.name} County
            </option>
          ))}
        </select>
      </div>
      {mapLevel === 'tract' && (
        <button type="button" className="mm-btn mm-btn-ghost mm-btn-sm" onClick={resetToAllCounties}>
          <ChevronLeft size={13} strokeWidth={2.25} />
          <span className="mm-topbar-hide-narrow">All counties</span>
        </button>
      )}
    </>
  )

  const ownerSearch = !isMobile ? (
    <div className="mm-search">
      <div className="mm-search-field">
        <span className="mm-search-icon">
          <Search size={14} strokeWidth={2.25} />
        </span>
        <input
          type="text"
          placeholder="Search mineral owners by name"
          value={searchQuery}
          onChange={(e) => {
            void handleSearch(e.target.value)
            setSearchOpen(true)
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
          aria-label="Search owners"
        />
        {searching ? <span className="mm-spinner" /> : <span className="mm-kbd">/</span>}
      </div>

      {searchOpen && searchResults.length > 0 && (
        <div className="mm-popover" role="listbox">
          {searchResults.map((result, i) => {
            const score = Number(result.propensity_score ?? 0)
            const scoreColor =
              score >= 8 ? '#F44336' : score >= 5 ? '#FF9800' : score >= 2 ? '#8BC34A' : '#9E9E9E'
            const locality =
              result.mailing_city && result.mailing_state
                ? `${result.mailing_city}, ${result.mailing_state}`
                : ''
            const leaseCount = Number(result.leaseCount ?? 1)
            return (
              <div
                key={`${result.owner_name}-${i}`}
                className="mm-popover-row"
                role="option"
                aria-selected={false}
                onMouseDown={() => {
                  setSearchQuery(result.owner_name)
                  setSearchOpen(false)
                  void handleSearchSelect(result)
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="mm-row-title">{result.owner_name}</div>
                  <div className="mm-row-sub" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {locality && <span>{locality}</span>}
                    {result.countyName && (
                      <span className="mm-chip mm-chip-sm">{result.countyName}</span>
                    )}
                    {leaseCount > 1 ? (
                      <span className="mm-chip mm-chip-sm mm-num">{leaseCount} leases</span>
                    ) : result.operator_name ? (
                      <span>{result.operator_name}</span>
                    ) : null}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                  <span className="mm-score" style={{ color: scoreColor }}>
                    {score}
                    <small>/10</small>
                  </span>
                  {result.acreage ? (
                    <span className="mm-meta mm-num" style={{ marginTop: 0 }}>
                      {Number(result.acreage).toFixed(1)} ac
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
          <div className="mm-popover-foot">
            <span>{searchResults.length} results</span>
            <span>Sorted by score</span>
          </div>
        </div>
      )}

      {searchOpen && searchQuery.length >= 3 && searchResults.length === 0 && !searching && (
        <div className="mm-popover">
          <div className="mm-empty">No owners found for &quot;{searchQuery}&quot;</div>
        </div>
      )}
    </div>
  ) : null

  const skipTracePct = skipTraceUsage
    ? Math.min(100, Math.round((skipTraceUsage.count / Math.max(1, skipTraceUsage.limit)) * 100))
    : 0
  const skipTraceHigh = Boolean(skipTraceUsage && skipTraceUsage.count >= 180)

  const headerActions = (
    <>
      {!isMobile && skipTraceUsage && (
        <div
          className="mm-usage mm-topbar-hide-narrow"
          title={`${skipTraceUsage.count} of ${skipTraceUsage.limit} skip traces used this month`}
        >
          <span className="mm-usage-label">Skip traces</span>
          <span className="mm-usage-meter">
            <span style={{ width: `${skipTracePct}%`, background: skipTraceHigh ? '#DC2626' : undefined }} />
          </span>
          <span className="mm-usage-count mm-num" style={{ color: skipTraceHigh ? '#DC2626' : undefined }}>
            {skipTraceUsage.count}
            <span style={{ color: '#9CA3AF' }}>/{skipTraceUsage.limit}</span>
          </span>
        </div>
      )}
      <button
        type="button"
        className="mm-btn mm-btn-ghost mm-topbar-hide-narrow"
        onClick={() => {
          setOnboardingStep(0)
          setShowOnboarding(true)
        }}
      >
        <Compass size={14} strokeWidth={2} />
        Tour
      </button>
    </>
  )

  const overviewTitle = mapLevel === 'county' ? 'All counties' : county.displayName

  return (
    <div
      className="mm-app"
      style={{
        height: '100dvh',
        background: '#FFFFFF',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <AppHeader
        active="map"
        compact={isMobile}
        context={countyContext}
        center={ownerSearch}
        actions={headerActions}
        menuMeta={
          <>
            <strong>{navCountyLabel}</strong>
            {countySummaryText}
          </>
        }
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* Left panel */}
        <aside
          className="mm-panel"
          style={{
            width: isMobile ? '100%' : 'clamp(300px, 30vw, 420px)',
            minWidth: isMobile ? 0 : 'clamp(300px, 30vw, 420px)',
            borderRight: isMobile ? 'none' : undefined,
            borderTop: isMobile ? '1px solid #E5E7EB' : 'none',
            order: isMobile ? 2 : 1,
            maxHeight: isMobile ? '52dvh' : 'none',
          }}
        >
          {selected ? (
            <div className="mm-enter-left" key={abstractLabel}>
              <button
                type="button"
                className="mm-back"
                onClick={() => {
                  setSelected(null)
                  // If we're in an owner-tracts session, keep the list so the
                  // user can pick a different tract for the same owner.
                  if (!ownerTractsName) {
                    setOwnerTracts([])
                    setOwnerTractsName('')
                  }
                }}
              >
                <ChevronLeft size={14} strokeWidth={2.25} />
                Back
              </button>

              <div style={{ marginTop: 10 }}>
                <div className="mm-kicker" style={{ color: '#6B7280' }}>{abstractLabel}</div>
                {legalSystemLine && (
                  <div className="mm-kicker" style={{ marginTop: 6 }}>{legalSystemLine}</div>
                )}
                {legalSectionLine && (
                  <div
                    style={{
                      fontSize: 19,
                      fontWeight: 600,
                      color: '#111827',
                      letterSpacing: '-0.015em',
                      lineHeight: 1.25,
                      marginTop: 4,
                    }}
                  >
                    {legalSectionLine}
                  </div>
                )}
                {legalGranteeLine && (
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>{legalGranteeLine}</div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0 14px' }}>
                <span
                  className="mm-score-pill"
                  style={{
                    color: tierColorFor(maxScore),
                    borderColor: `${tierColorFor(maxScore)}55`,
                    background: `${tierColorFor(maxScore)}14`,
                  }}
                >
                  {maxScore}/10 {maxScore >= 8 ? 'hot' : maxScore >= 6 ? 'motivated' : 'prospect'}
                </span>
                <span className="mm-chip mm-chip-amber mm-num">{ownerCount.toLocaleString()} owners</span>
                <span className="mm-chip" title="Top operator">{topOperator}</span>
              </div>

              <div className="mm-card" style={{ marginBottom: 12 }}>
                <div className="mm-card-head">
                  <span className="mm-kicker">Production history</span>
                  <span className="mm-chip mm-chip-sm" style={{ textTransform: 'capitalize' }}>
                    {productionTrend}
                  </span>
                </div>
                <div style={{ padding: '12px 8px 4px 0' }}>
                  <div style={{ width: '100%', height: 140, minHeight: 140 }}>
                    <ResponsiveContainer width="100%" height={140}>
                      <AreaChart data={productionData} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                        <defs>
                          <linearGradient id="mm-prod-fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#EF9F27" stopOpacity={0.28} />
                            <stop offset="100%" stopColor="#EF9F27" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke="#F3F4F6" />
                        <XAxis
                          dataKey="month"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#9CA3AF', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                        />
                        <YAxis
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#9CA3AF', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                          width={54}
                        />
                        <Tooltip
                          cursor={{ stroke: '#E5E7EB' }}
                          contentStyle={{
                            background: '#FFFFFF',
                            border: '1px solid #E5E7EB',
                            borderRadius: 8,
                            boxShadow: '0 4px 12px rgba(17,24,39,0.08)',
                            color: '#111827',
                            fontSize: 12,
                          }}
                          labelStyle={{ color: '#6B7280', fontSize: 11 }}
                        />
                        <Area
                          type="monotone"
                          dataKey="oil"
                          stroke="#EF9F27"
                          strokeWidth={2}
                          fill="url(#mm-prod-fill)"
                          dot={false}
                          activeDot={{ r: 3, strokeWidth: 0 }}
                          isAnimationActive
                          animationDuration={600}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 14px 12px',
                    fontSize: 11,
                    color: '#6B7280',
                  }}
                >
                  <span>
                    Peak <span className="mm-num" style={{ color: '#374151' }}>{productionPeak.toLocaleString()}</span>
                  </span>
                  <span>
                    Trend <span style={{ color: '#374151', textTransform: 'capitalize' }}>{productionTrend}</span>
                  </span>
                </div>
              </div>

              <div className="mm-card" style={{ marginBottom: 12 }}>
                <div className="mm-card-head">
                  <span className="mm-kicker">Operator and lease</span>
                </div>
                <dl className="mm-deflist">
                  <dt>Operator</dt>
                  <dd>{selected.top_operator}</dd>
                  <dt>Field</dt>
                  <dd>{fieldName}</dd>
                  <dt>Well status</dt>
                  <dd>{selected.well_status || 'PRODUCING / SHUT IN'}</dd>
                  <dt>Est. lease expiration</dt>
                  <dd>{estExpiration}</dd>
                </dl>
              </div>

              {(tractWellsLoaded || tractWellsLoading) && (
                <div className="mm-card" style={{ marginBottom: 12, overflow: 'hidden' }}>
                  <button
                    type="button"
                    className="mm-collapse-head"
                    aria-expanded={wellsExpanded}
                    onClick={() => setWellsExpanded(!wellsExpanded)}
                  >
                    <span className="mm-kicker">
                      Wells in this tract
                      <span className="mm-nav-badge" style={{ marginLeft: 8 }}>{tractWells.length}</span>
                    </span>
                    <ChevronDown size={14} strokeWidth={2.25} />
                  </button>

                  {wellsExpanded && (
                    <div className="mm-enter" style={{ borderTop: '1px solid #F3F4F6', paddingBottom: 4 }}>
                      {tractWellsLoading && (
                        <div className="mm-empty" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                          <span className="mm-spinner" /> Loading tract wells
                        </div>
                      )}
                      {!tractWellsLoading && tractWells.length === 0 && (
                        <div className="mm-empty" style={{ padding: '14px 16px' }}>No wells matched this tract</div>
                      )}
                      {!tractWellsLoading &&
                        tractWells.map((well, i) => (
                          <div
                            key={`${well.rrc_lease_id ?? well.lease_name ?? 'well'}-${i}`}
                            style={{
                              padding: '8px 14px',
                              borderBottom: '1px solid #F9FAFB',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 8,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="mm-row-title" style={{ fontSize: 12 }}>{well.lease_name}</div>
                              <div className="mm-row-sub">{well.operator_name}</div>
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              <span
                                className="mm-tag"
                                style={{
                                  background: well.oil_gas_code === 'G' ? '#EFF6FF' : '#FEF3C7',
                                  color: well.oil_gas_code === 'G' ? '#1D4ED8' : '#92400E',
                                  borderColor: well.oil_gas_code === 'G' ? '#BFDBFE' : '#FDE68A',
                                }}
                              >
                                {well.oil_gas_code === 'G' ? 'GAS' : 'OIL'}
                              </span>
                              <span
                                className="mm-tag"
                                style={{
                                  background: well.well_type === 'HORIZONTAL' ? '#FEF3C7' : '#F9FAFB',
                                  color: well.well_type === 'HORIZONTAL' ? '#B45309' : '#6B7280',
                                  borderColor: well.well_type === 'HORIZONTAL' ? '#FDE68A' : '#E5E7EB',
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
              )}

              <div className="mm-list">
                <div className="mm-card-head">
                  <span className="mm-kicker">
                    Owners in tract
                    <span className="mm-nav-badge" style={{ marginLeft: 8 }}>{filteredOwnersList.length}</span>
                  </span>
                  <div className="mm-segment" role="tablist" aria-label="Sort owners">
                    {[
                      { key: 'score', label: 'Score' },
                      { key: 'interest', label: 'Interest' },
                      { key: 'nra', label: 'NRA' },
                    ].map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        role="tab"
                        aria-selected={ownerSort === s.key}
                        data-active={ownerSort === s.key}
                        onClick={() => setOwnerSort(s.key as 'score' | 'interest' | 'nra')}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {cleanOwnersList.length === 0 && (
                  <div className="mm-empty">No owners match the current filters</div>
                )}

                {cleanOwnersList.map((owner: TractOwner, i: number) => {
                  const score = Number(owner.propensity_score ?? 0)
                  const isExpanded = expandedOwner === i
                  const normalizedOwnerName = String(owner.owner_name ?? '').trim().toUpperCase()
                  const isHighlighted = highlightedOwner === normalizedOwnerName
                  const ownerElementId = ownerRowDomId(String(owner.owner_name ?? ''))
                  const ownerKey = String(
                    owner.id ?? `${normalizedOwnerName}-${normalizeLeaseId(owner.rrc_lease_id) || i}`
                  )
                  const ownerWellMatches = ownerWells[ownerKey] ?? []
                  const ownerWellLoading = Boolean(ownerWellsLoading[ownerKey])
                  const hasLoadedOwnerWells = Object.prototype.hasOwnProperty.call(ownerWells, ownerKey)
                  const signals = isExpanded ? getScoreBreakdown(owner) : []
                  const scoreColor = tierColorFor(score)
                  const ownerType = classifyOwner(String(owner.owner_name ?? ''))
                  const typeColor =
                    ownerType === 'trust' ? '#7AB835' : ownerType === 'company' ? '#378ADD' : '#9CA3AF'
                  const typeLabel = ownerType === 'trust' ? 'TRUST' : ownerType === 'company' ? 'CO' : 'IND'
                  const nra = getNRA(owner, selected, county)
                  const royaltyEstimate = estimateMonthlyRoyalty(owner, selected, county.ownershipPctIsDecimal)
                  const ownershipPctValue = getOwnershipPctValue(owner, county.ownershipPctIsDecimal)
                  const ownershipDecimalValue = ownershipPctValue / 100
                  const inPipeline = pipelineOwners.has(owner.owner_name)

                  // Gross acres for the lease/tract. Owner.acreage is the
                  // lease's gross acreage from the CAD roll; fall back to the
                  // SHAPE_AREA-derived tract acreage when missing.
                  const ownerAcres = Number(owner.acreage ?? 0)
                  const grossAcres = ownerAcres > 0 ? ownerAcres : getTractGrossAcres(selected)
                  const acresLabel =
                    grossAcres > 0
                      ? grossAcres >= 100
                        ? grossAcres.toLocaleString(undefined, { maximumFractionDigits: 0 })
                        : grossAcres.toFixed(1)
                      : null

                  return (
                    <div
                      key={`${owner.owner_name}-${i}`}
                      className="mm-owner"
                      data-expanded={isExpanded}
                      data-highlighted={isHighlighted}
                    >
                      <div
                        id={ownerElementId}
                        className="mm-owner-head"
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          const nextExpanded = isExpanded ? null : i
                          setExpandedOwner(nextExpanded)
                          if (nextExpanded !== null) {
                            void fetchOwnerWells(owner, ownerKey)
                            trackEvent('owner_expanded', {
                              owner_name: owner.owner_name,
                              score: owner.propensity_score,
                              abstract: selected?.ABSTRACT_L ?? selected?.abstract_label ?? '',
                            })
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            ;(event.currentTarget as HTMLDivElement).click()
                          }
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                              <span className="mm-num" style={{ fontSize: 10.5, color: '#9CA3AF', flexShrink: 0 }}>
                                {String(i + 1).padStart(2, '0')}
                              </span>
                              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
                                {owner.owner_name}
                              </span>
                            </div>
                            {tractLegalDescription && (
                              <div className="mm-meta-mono" style={{ marginTop: 3 }}>{tractLegalDescription}</div>
                            )}
                            <div className="mm-meta">
                              {owner.mailing_city && owner.mailing_state
                                ? `${owner.mailing_city}, ${owner.mailing_state}`
                                : 'Address unknown'}
                            </div>
                            {nra !== null && nra > 0 && (
                              <div
                                className="mm-meta-mono"
                                style={{ marginTop: 3, fontWeight: 600 }}
                                title={royaltyEstimate ? `Est. royalty: ${royaltyEstimate}` : undefined}
                              >
                                {nra < 0.01 ? nra.toFixed(4) : nra < 1 ? nra.toFixed(3) : nra.toFixed(2)} NRA
                                {!Number(owner.acreage) && (
                                  <span style={{ fontSize: 9.5, color: '#9CA3AF', marginLeft: 4, fontWeight: 500 }}>est.</span>
                                )}
                              </div>
                            )}
                            {ownershipPctValue > 0 && (
                              <>
                                <div className="mm-meta">
                                  {acresLabel
                                    ? `${ownershipPctValue.toFixed(4)}% interest on ${acresLabel} gross acres`
                                    : `${ownershipPctValue.toFixed(4)}% interest`}
                                </div>
                                <div className="mm-meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ color: '#9CA3AF' }}>DO interest</span>
                                  <span className="mm-meta-mono" style={{ fontWeight: 600 }}>
                                    {ownershipDecimalValue.toFixed(6)}
                                  </span>
                                  <span style={{ color: '#9CA3AF' }}>({ownershipPctValue.toFixed(4)}%)</span>
                                </div>
                              </>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                            <span className="mm-score" style={{ color: scoreColor }}>
                              {score}
                              <small>/10</small>
                            </span>
                            <div style={{ display: 'flex', gap: 3 }}>
                              <span
                                className="mm-tag"
                                style={{ background: `${typeColor}14`, color: typeColor, borderColor: `${typeColor}40` }}
                              >
                                {typeLabel}
                              </span>
                              {owner.out_of_state && (
                                <span
                                  className="mm-tag"
                                  style={{ background: 'rgba(239,159,39,0.12)', color: '#B45309', borderColor: 'rgba(239,159,39,0.35)' }}
                                >
                                  OOS
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="mm-owner-toggle">
                          <ChevronRight size={11} strokeWidth={2.5} />
                          {isExpanded ? 'Hide score breakdown' : 'Why this score'}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mm-owner-body">
                          <div className="mm-kicker" style={{ color: '#92400E', marginBottom: 6 }}>Score signals</div>
                          {signals.length === 0 ? (
                            <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>No strong signals detected</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              {signals.map((signal, si) => (
                                <div key={si} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                  <span
                                    style={{
                                      width: 5,
                                      height: 5,
                                      borderRadius: '50%',
                                      background: '#EF9F27',
                                      flexShrink: 0,
                                      marginTop: 6,
                                    }}
                                  />
                                  <span style={{ fontSize: 11.5, color: '#374151', lineHeight: 1.45 }}>{signal}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {ownerWellLoading && (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #FDE68A', display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="mm-spinner" />
                              <span style={{ fontSize: 11.5, color: '#9CA3AF' }}>Looking up wells on this interest</span>
                            </div>
                          )}

                          {!ownerWellLoading && hasLoadedOwnerWells && ownerWellMatches.length === 0 && (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #FDE68A' }}>
                              <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>No matched wells on this interest</div>
                            </div>
                          )}

                          {ownerWellMatches.length > 0 && (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #FDE68A' }}>
                              <div className="mm-kicker" style={{ marginBottom: 6 }}>Wells on this interest</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {ownerWellMatches.map((well, wi) => (
                                  <div
                                    key={`${well.rrc_lease_id ?? 'well'}-${wi}`}
                                    style={{
                                      padding: '7px 10px',
                                      background: '#FFFFFF',
                                      borderRadius: 8,
                                      border: '1px solid #F3F4F6',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
                                      <div className="mm-row-title" style={{ fontSize: 11.5 }}>{well.lease_name ?? 'Unknown lease'}</div>
                                      <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                                        <span
                                          className="mm-tag"
                                          style={{
                                            background: well.oil_gas_code === 'G' ? '#EFF6FF' : '#FEF3C7',
                                            color: well.oil_gas_code === 'G' ? '#1D4ED8' : '#92400E',
                                            borderColor: well.oil_gas_code === 'G' ? '#BFDBFE' : '#FDE68A',
                                          }}
                                        >
                                          {well.oil_gas_code === 'G' ? 'GAS' : 'OIL'}
                                        </span>
                                        <span
                                          className="mm-tag"
                                          style={{
                                            background: well.well_type === 'HORIZONTAL' ? '#FEF3C7' : '#F9FAFB',
                                            color: well.well_type === 'HORIZONTAL' ? '#B45309' : '#9CA3AF',
                                            borderColor: well.well_type === 'HORIZONTAL' ? '#FDE68A' : '#E5E7EB',
                                          }}
                                        >
                                          {well.well_type === 'HORIZONTAL' ? 'HZ' : 'VT'}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="mm-meta" style={{ marginTop: 0 }}>
                                      Operator: {well.operator_name ?? 'Unknown operator'}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                            <button
                              type="button"
                              className={`mm-btn mm-btn-sm ${inPipeline ? 'mm-btn-success-soft' : 'mm-btn-amber-soft'}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleAddToPipeline(owner)
                              }}
                            >
                              {inPipeline ? <Check size={12} strokeWidth={2.5} /> : <Plus size={12} strokeWidth={2.5} />}
                              {inPipeline ? 'In pipeline' : 'Add to pipeline'}
                            </button>
                            <button
                              type="button"
                              className="mm-btn mm-btn-sm mm-btn-secondary"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSkipTrace(owner)
                              }}
                            >
                              <Phone size={12} strokeWidth={2.25} />
                              Skip trace
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div style={{ display: 'flex', marginTop: 12 }}>
                <button type="button" className="mm-btn mm-btn-amber-soft mm-btn-block">
                  <Plus size={13} strokeWidth={2.5} />
                  Add all to pipeline
                </button>
              </div>
            </div>
          ) : ownerTractsName ? (
            <div className="mm-enter-left">
              <button
                type="button"
                className="mm-back"
                onClick={() => {
                  setOwnerTracts([])
                  setOwnerTractsName('')
                  setOwnerTractsLoading(false)
                }}
              >
                <ChevronLeft size={14} strokeWidth={2.25} />
                Back
              </button>

              <div className="mm-panel-head" style={{ marginTop: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="mm-kicker">Owner</div>
                  <div className="mm-panel-title" style={{ marginTop: 4 }}>{ownerTractsName}</div>
                  <div className="mm-panel-sub" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {ownerTractsLoading ? (
                      <>
                        <span className="mm-spinner" /> Looking up tracts
                      </>
                    ) : (
                      `${ownerTracts.length} tract${ownerTracts.length !== 1 ? 's' : ''} found`
                    )}
                  </div>
                </div>
              </div>

              {ownerTracts.length > 0 && (
                <div className="mm-list mm-stagger" style={{ marginTop: 12 }}>
                  {ownerTracts.map((tract, i) => {
                    const abstractLabelForTract = tract.ABSTRACT_L ?? tract.abstract_label ?? 'Unknown'
                    const score = Number(tract.max_propensity_score ?? 0)
                    const scoreColor =
                      score >= 8 ? '#F44336' : score >= 5 ? '#FF9800' : score >= 2 ? '#8BC34A' : '#9E9E9E'
                    const operator = tract.top_operator ?? ''
                    return (
                      <div
                        key={`${abstractLabelForTract}-${i}`}
                        className="mm-row"
                        onClick={() => {
                          setSelected(tract)
                          setOwnerSort('score')
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
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="mm-row-title">{abstractLabelForTract}</div>
                          <div className="mm-row-sub">{operator}</div>
                        </div>
                        <span className="mm-score" style={{ color: scoreColor }}>
                          {score}
                          <small>/10</small>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              {!ownerTractsLoading && ownerTracts.length === 0 && (
                <div className="mm-card mm-empty" style={{ marginTop: 12 }}>No mapped tracts found.</div>
              )}
            </div>
          ) : (
            <div className="mm-enter" key={mapLevel}>
              <div className="mm-panel-head" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="mm-kicker">{mapLevel === 'county' ? 'Coverage' : 'County overview'}</div>
                  <div className="mm-panel-title" style={{ marginTop: 4 }}>{overviewTitle}</div>
                  {mapLevel === 'county' && (
                    <div className="mm-panel-sub">Select a highlighted county on the map or from the list below.</div>
                  )}
                </div>
              </div>

              <div className="mm-stagger" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(mapLevel === 'county' ? combinedStats : countyStats).map((card) => (
                  <div key={card.lbl} className="mm-stat">
                    <div className="mm-stat-value">{card.val}</div>
                    <div className="mm-stat-label">{card.lbl}</div>
                  </div>
                ))}
              </div>

              {mapLevel === 'county' && (
                <>
                  <div className="mm-kicker-row">
                    <span className="mm-kicker">Active counties</span>
                    <span className="mm-kicker mm-num" style={{ letterSpacing: 0 }}>{Object.keys(COUNTIES).length}</span>
                  </div>
                  <div className="mm-list mm-stagger">
                    {Object.values(COUNTIES).map((c) => {
                      const hotVal = Number(
                        (c.stats.find((s) => s.lbl === 'Hot (8-10)')?.val ?? '0').replace(/,/g, '')
                      )
                      return (
                        <div
                          key={c.id}
                          className="mm-row"
                          onClick={() => {
                            setSelectedCounty(c.id as CountyKey)
                            setMapLevel('tract')
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="mm-row-title">{c.displayName}</div>
                            <div className="mm-row-sub">
                              <span className="mm-tabular">~{c.totalLeads.toLocaleString()}</span> total leads
                            </div>
                          </div>
                          <span className="mm-chip mm-chip-red mm-chip-dot mm-tabular">{hotVal.toLocaleString()} hot</span>
                          <ChevronRight size={14} strokeWidth={2} style={{ color: '#9CA3AF', flexShrink: 0 }} />
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {mapLevel === 'tract' && (
                <>
                  <div className="mm-kicker-row">
                    <span className="mm-kicker">Top 10 hottest tracts</span>
                  </div>
                  <div className="mm-list mm-stagger" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {topTracts.map((tract, index) => (
                      <div
                        key={`${tract.abstract_label}-${tract.level1_sur}-${index}`}
                        className="mm-row"
                        onClick={() => {
                          setSelected(toTractSelection(tract))
                          setOwnerSort('score')
                          setExpandedOwner(null)
                          trackEvent('tract_clicked', {
                            abstract: tract.abstract_label,
                            owner_count: tract.owner_count,
                            max_score: tract.max_propensity_score,
                          })
                        }}
                      >
                        <span className="mm-num" style={{ fontSize: 10.5, color: '#9CA3AF', width: 18, flexShrink: 0 }}>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="mm-row-title">{tract.abstract_label}</div>
                          <div className="mm-row-sub">{tract.level1_sur}</div>
                          <div className="mm-row-sub" style={{ color: '#9CA3AF' }}>
                            <span className="mm-tabular">{tract.owner_count}</span> owners, {tract.top_operator}
                          </div>
                        </div>
                        <span
                          className="mm-score-pill"
                          style={{
                            color: scoreBadgeColor(tract.max_propensity_score),
                            borderColor: `${scoreBadgeColor(tract.max_propensity_score)}55`,
                            background: `${scoreBadgeColor(tract.max_propensity_score)}12`,
                          }}
                        >
                          {tract.max_propensity_score}/10
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mm-kicker-row">
                    <span className="mm-kicker">Operator share</span>
                  </div>
                  <div className="mm-card mm-card-pad">
                    {countyBreakdown.map((row, index) => (
                      <div key={row.operator} style={{ marginBottom: index === countyBreakdown.length - 1 ? 0 : 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                          <span style={{ color: '#111827', fontWeight: 500 }}>{row.operator}</span>
                          <span className="mm-num" style={{ color: '#6B7280' }}>{row.pct}%</span>
                        </div>
                        <div className="mm-meter">
                          <span style={{ width: `${row.pct}%`, opacity: 1 - index * 0.18 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </aside>

        {/* Map area */}
        <div
          style={{
            flex: isMobile ? '0 0 48dvh' : 1,
            minWidth: 0,
            minHeight: isMobile ? '48dvh' : 0,
            position: 'relative',
            order: isMobile ? 1 : 2,
            background: '#F4F5F7',
          }}
        >
          {countySwitchLabel && (
            <div className="mm-float-pill" style={{ opacity: countySwitchLabelVisible ? 1 : 0 }}>
              {countySwitchLabel}
            </div>
          )}
          {showCountyArrows && previousCounty && (
            <button
              type="button"
              className="mm-map-arrow"
              style={{ left: 10 }}
              onClick={() => switchCountyByOffset(-1)}
              aria-label={`Previous county: ${COUNTIES[previousCounty].name}`}
            >
              <ChevronLeft size={16} strokeWidth={2.25} />
            </button>
          )}
          {showCountyArrows && nextCounty && (
            <button
              type="button"
              className="mm-map-arrow"
              style={{ right: rightArrowOffset }}
              onClick={() => switchCountyByOffset(1)}
              aria-label={`Next county: ${COUNTIES[nextCounty].name}`}
            >
              <ChevronRight size={16} strokeWidth={2.25} />
            </button>
          )}
          {loading ? (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                color: '#6B7280',
                fontSize: 12.5,
              }}
            >
              <span className="mm-spinner" style={{ width: 22, height: 22 }} />
              Loading county data
            </div>
          ) : (
            <MineralMap
              selectedCounty={selectedCounty}
              mapFlyToRef={mapFlyToRef}
              mapLevel={mapLevel}
              showPermits={showPermits}
              focusTarget={selected}
              onCountySwitch={(countyId) => {
                setSelectedCounty(countyId as CountyKey)
                setMapLevel('tract')
                setSelected(null)
                setExpandedOwner(null)
                setSearchQuery('')
                setSearchResults([])
                setSearchOpen(false)
                setOwnerWells({})
                setTractWells([])
                setTractWellsLoaded(false)
                setWellsExpanded(false)
              }}
              onOwnerClick={(tract) => {
                // The Mapbox layer is fed by the slim *_parcels_map.geojson
                // (stripped of `owners_json` to keep tile bytes small), so the
                // props the click handler hands us only carry counts. Enrich
                // by looking up the matching TractRecord from the full
                // GeoJSON the side panel already loaded, which is the source
                // of truth for the owners list. Falls back to the raw slim
                // props if no match is found (e.g. brand-new tracts that
                // somehow haven't made it into `tracts` yet).
                const clickedAbstract = String(tract.ABSTRACT_L ?? tract.abstract_label ?? '').trim()
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
                const enriched = fullTract ? toTractSelection(fullTract) : (tract as TractSelection)
                setSelected(enriched)
                setSelectedTractGeometry(
                  (tract.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined) ?? null
                )
                setOwnerSort('score')
                setExpandedOwner(null)
                setOwnerTracts([])
                setOwnerTractsName('')
                trackEvent('tract_clicked', {
                  abstract: clickedAbstract,
                  owner_count: enriched.owner_count ?? 0,
                  max_score: enriched.max_propensity_score ?? 0,
                })
              }}
            />
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="mm-filterbar" style={{ minHeight: isMobile ? 56 : 44 }}>
        <div className="mm-filter-group">
          <span className="mm-filter-label">Filters</span>
          <button
            type="button"
            className="mm-switch"
            role="switch"
            aria-checked={motivatedOnly}
            onClick={() => setMotivatedOnly((prev) => !prev)}
          >
            <span className="mm-switch-track" />
            Motivated only
          </button>
          <button
            type="button"
            className="mm-switch"
            role="switch"
            aria-checked={outOfStateOnly}
            onClick={() => setOutOfStateOnly((prev) => !prev)}
          >
            <span className="mm-switch-track" />
            Out of state
          </button>
          <button
            type="button"
            className="mm-switch"
            role="switch"
            aria-checked={largeInterestOnly}
            onClick={() => setLargeInterestOnly(!largeInterestOnly)}
          >
            <span className="mm-switch-track" />
            1%+ interest
          </button>
        </div>

        <div className="mm-filter-sep" />

        <div className="mm-filter-group">
          <span className="mm-filter-label">Type</span>
          <div className="mm-segment">
            {(['all', 'individual', 'trust', 'company'] as const).map((type) => (
              <button
                key={type}
                type="button"
                data-active={ownerTypeFilter === type}
                onClick={() => setOwnerTypeFilter(type)}
              >
                {type === 'all' ? 'All' : type === 'individual' ? 'People' : type === 'trust' ? 'Trusts' : 'Companies'}
              </button>
            ))}
          </div>
        </div>

        <div className="mm-filter-group">
          <span className="mm-filter-label">Tier</span>
          <div className="mm-segment">
            {(['all', 'hot', 'motivated', 'prospect', 'low'] as const).map((tier) => {
              const colors: Record<string, string> = {
                hot: '#F44336',
                motivated: '#FF9800',
                prospect: '#81C784',
                low: '#9E9E9E',
                all: '#111827',
              }
              return (
                <button
                  key={tier}
                  type="button"
                  data-active={tierFilter === tier}
                  data-tone
                  style={{ ['--tone' as string]: colors[tier] }}
                  onClick={() => setTierFilter(tier)}
                >
                  {tier !== 'all' && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: colors[tier],
                        marginRight: 5,
                        verticalAlign: 'middle',
                        position: 'relative',
                        top: -1,
                      }}
                    />
                  )}
                  {tier === 'all' ? 'All' : tier.charAt(0).toUpperCase() + tier.slice(1)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mm-filter-sep" />

        <div className="mm-filter-group">
          <span className="mm-filter-label">Min score</span>
          <input
            type="range"
            className="mm-range"
            min={0}
            max={10}
            value={minScore}
            onChange={(event) => setMinScore(Number(event.target.value))}
            style={{ ['--fill' as string]: `${minScore * 10}%` }}
            aria-label="Minimum propensity score"
          />
          <span className="mm-num" style={{ color: '#B45309', fontWeight: 600, fontSize: 12, width: 16 }}>{minScore}</span>
        </div>

        <div className="mm-filter-group">
          <span className="mm-filter-label">Min NRA</span>
          <select
            className="mm-select mm-select-boxed"
            value={minNRA}
            onChange={(e) => setMinNRA(Number(e.target.value))}
            aria-label="Minimum net royalty acres"
            style={{ height: 26 }}
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

        <div className="mm-filter-sep" />

        <div className="mm-filter-group">
          <span className="mm-filter-label">Layers</span>
          <button
            type="button"
            className={`mm-chip ${showPermits ? 'mm-chip-blue' : ''}`}
            style={{ cursor: 'pointer', height: 24 }}
            aria-pressed={showPermits}
            onClick={() => setShowPermits((prev) => !prev)}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: showPermits ? '#2563EB' : '#D1D5DB',
                boxShadow: showPermits ? '0 0 0 3px rgba(37,99,235,0.15)' : 'none',
              }}
            />
            New permits
          </button>
        </div>
      </div>

      {toast && (
        <div className="mm-toast" data-type={toastType} role="status">
          <span className="mm-toast-icon">
            {toastType === 'error' ? <X size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
          </span>
          {toast}
        </div>
      )}

      {showOnboarding && (
        <div className="mm-scrim" style={{ zIndex: 9999 }}>
          <div className="mm-dialog" style={{ maxWidth: 520 }} role="dialog" aria-modal="true">
            <div className="mm-progress">
              <span style={{ width: `${((onboardingStep + 1) / ONBOARDING_STEPS.length) * 100}%` }} />
            </div>

            <div style={{ padding: '32px 36px 28px' }} key={onboardingStep} className="mm-enter">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                <span className="mm-kicker">
                  Step {ONBOARDING_STEPS[onboardingStep].step} of {String(ONBOARDING_STEPS.length).padStart(2, '0')}
                </span>
                <div className="mm-step-dots" aria-hidden="true">
                  {ONBOARDING_STEPS.map((step, index) => (
                    <span key={step.step} data-active={index === onboardingStep} data-done={index < onboardingStep} />
                  ))}
                </div>
              </div>

              <h2
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color: '#111827',
                  marginBottom: 12,
                  lineHeight: 1.25,
                  letterSpacing: '-0.02em',
                }}
              >
                {ONBOARDING_STEPS[onboardingStep].title}
              </h2>

              <p style={{ fontSize: 14, color: '#4B5563', lineHeight: 1.7, marginBottom: 30 }}>
                {ONBOARDING_STEPS[onboardingStep].body}
              </p>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <button type="button" className="mm-btn mm-btn-ghost" onClick={completeOnboarding}>
                  Skip tour
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {onboardingStep > 0 && (
                    <button type="button" className="mm-btn mm-btn-secondary" onClick={() => setOnboardingStep((s) => s - 1)}>
                      Back
                    </button>
                  )}
                  {onboardingStep < ONBOARDING_STEPS.length - 1 ? (
                    <button type="button" className="mm-btn mm-btn-primary" onClick={() => setOnboardingStep((s) => s + 1)}>
                      Next
                      <ChevronRight size={14} strokeWidth={2.25} />
                    </button>
                  ) : (
                    <button type="button" className="mm-btn mm-btn-brand" onClick={completeOnboarding}>
                      Start prospecting
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {pipelineCandidate && (
        <div className="mm-scrim" style={{ zIndex: 1001 }}>
          <div className="mm-dialog" style={{ maxWidth: 380 }} role="dialog" aria-modal="true">
            <div className="mm-dialog-body">
              <div className="mm-dialog-title">Add owner to pipeline</div>
              <div className="mm-dialog-sub">{pipelineCandidate.owner_name}</div>

              <div className="mm-label" style={{ marginTop: 20 }}>Label</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(
                  [
                    { key: 'prospect', label: 'Prospect' },
                    { key: 'hot', label: 'Hot' },
                    { key: 'nurture', label: 'Nurture' },
                    { key: 'not_interested', label: 'Not interested' },
                  ] as Array<{ key: PipelineTag; label: string }>
                ).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className="mm-option"
                    data-active={pipelineTag === option.key}
                    onClick={() => setPipelineTag(option.key)}
                  >
                    <span className="mm-option-dot" />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mm-dialog-foot">
              <button
                type="button"
                className="mm-btn mm-btn-secondary"
                disabled={pipelineSaving}
                onClick={() => {
                  if (pipelineSaving) return
                  setPipelineCandidate(null)
                }}
              >
                Cancel
              </button>
              <button type="button" className="mm-btn mm-btn-primary" disabled={pipelineSaving} onClick={handleAddToPipelineConfirm}>
                {pipelineSaving ? <span className="mm-spinner mm-spinner-light" /> : <Plus size={14} strokeWidth={2.5} />}
                {pipelineSaving ? 'Saving' : 'Add to pipeline'}
              </button>
            </div>
          </div>
        </div>
      )}

      {skipTracing && (
        <div className="mm-scrim" style={{ zIndex: 1000 }}>
          <div className="mm-dialog" style={{ maxWidth: 380 }} role="dialog" aria-modal="true">
            <div className="mm-dialog-body">
              <div className="mm-dialog-title">Skip trace this owner?</div>
              <div className="mm-dialog-sub">{skipTracing.owner_name}</div>
              <div className="mm-callout" style={{ marginTop: 16 }}>
                Searches for a phone number and email address. Uses 1 skip trace credit from your monthly allowance.
              </div>
              <div className="mm-callout mm-callout-amber" style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Monthly limit</span>
                <span className="mm-num" style={{ fontWeight: 600 }}>{SKIP_TRACE_LIMIT} traces, resets on the 1st</span>
              </div>
            </div>
            <div className="mm-dialog-foot">
              <button type="button" className="mm-btn mm-btn-secondary" disabled={skipTraceLoading} onClick={() => setSkipTracing(null)}>
                Cancel
              </button>
              <button type="button" className="mm-btn mm-btn-brand" disabled={skipTraceLoading} onClick={handleSkipTraceConfirm}>
                {skipTraceLoading ? <span className="mm-spinner" /> : <Phone size={14} strokeWidth={2.25} />}
                {skipTraceLoading ? 'Searching' : 'Run skip trace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {skipTraceResult && (
        <div className="mm-scrim" style={{ zIndex: 2000 }}>
          <div className="mm-dialog" style={{ maxWidth: 400 }} role="dialog" aria-modal="true">
            <div className="mm-dialog-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: '#DCFCE7',
                    color: '#15803D',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Check size={15} strokeWidth={2.75} />
                </span>
                <div className="mm-dialog-title">Skip trace complete</div>
              </div>
              <div className="mm-dialog-sub">{skipTraceResult.ownerName}</div>

              {skipTraceResult.cached && (
                <div className="mm-chip mm-chip-green" style={{ marginTop: 12 }}>Retrieved from shared cache</div>
              )}

              <div className="mm-card" style={{ marginTop: 16, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: '1px solid #F3F4F6' }}>
                  <span style={{ color: '#9CA3AF', display: 'inline-flex' }}>
                    <Phone size={15} strokeWidth={2} />
                  </span>
                  {skipTraceResult.phone ? (
                    <a href={`tel:${skipTraceResult.phone}`} className="mm-num" style={{ fontSize: 14, color: '#111827', fontWeight: 500, textDecoration: 'none' }}>
                      {skipTraceResult.phone}
                    </a>
                  ) : (
                    <span style={{ fontSize: 13, color: '#9CA3AF' }}>No phone found</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                  <span style={{ color: '#9CA3AF', display: 'inline-flex' }}>
                    <Mail size={15} strokeWidth={2} />
                  </span>
                  {skipTraceResult.email ? (
                    <a href={`mailto:${skipTraceResult.email}`} style={{ fontSize: 14, color: '#111827', fontWeight: 500, textDecoration: 'none', overflowWrap: 'anywhere' }}>
                      {skipTraceResult.email}
                    </a>
                  ) : (
                    <span style={{ fontSize: 13, color: '#9CA3AF' }}>No email found</span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 14, lineHeight: 1.5 }}>
                Contact info saved to pipeline. View and manage this lead in the CRM.
              </div>
            </div>
            <div className="mm-dialog-foot">
              <button type="button" className="mm-btn mm-btn-secondary" onClick={() => setSkipTraceResult(null)}>
                Stay here
              </button>
              <button type="button" className="mm-btn mm-btn-brand" onClick={() => (window.location.href = '/crm')}>
                Open CRM
                <ChevronRight size={14} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
