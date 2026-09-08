'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { COUNTIES } from '@/lib/counties'
import type { County, CountyKey } from '@/lib/counties'
import AppHeader from '@/app/components/AppHeader'
import {
  Phone, Mail, Search,
  MapPin, Clock,
  DollarSign, User, Building2,
  CheckCircle2, Circle, XCircle, Flame,
  TrendingUp, Save, FileText, Package, ThumbsDown,
} from 'lucide-react'

type BuyerEntity = { name: string; address: string; city: string; state: string; zip: string }

const BUYER_ENTITY_STORAGE_KEY = 'mineral_map_buyer_entity'
const DEFAULT_BUYER_ENTITY: BuyerEntity = { name: '', address: '', city: '', state: 'TX', zip: '' }

type DocFieldProps = {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  minChars?: number
  style?: React.CSSProperties
}

const DocField = ({ value, onChange, placeholder, minChars = 10, style }: DocFieldProps) => {
  const chars = Math.max(
    (value?.length ?? 0) + 2,
    (placeholder?.length ?? 0) + 2,
    minChars
  )
  return (
    <input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      size={chars}
      style={{
        borderBottom: '1px solid #3B82F6',
        background: '#EFF6FF',
        padding: '0 4px',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        color: '#1D4ED8',
        outline: 'none',
        minWidth: 120,
        display: 'inline-block',
        ...style,
      }}
    />
  )
}

const DocTextarea = ({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  rows?: number
}) => (
  <textarea
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    rows={rows}
    style={{
      width: '100%',
      border: '1px solid #3B82F6',
      background: '#EFF6FF',
      padding: '8px 10px',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      color: '#1D4ED8',
      outline: 'none',
      display: 'block',
      marginTop: 8,
      marginBottom: 8,
      resize: 'vertical',
      borderRadius: 2,
    }}
  />
)

const PSA_CLAUSES: { heading: string; body: string }[] = [
  {
    heading: 'Revenues Post-Effective Date',
    body:
      '.  In the event Seller receives revenues from the Interests attributable to production after the Effective Date, Seller agrees to notify Buyer within ten (10) business days and that said revenues shall be owed to Buyer.  Any revenue, costs, expenses, and taxes will be prorated as of the Effective Date.',
  },
  {
    heading: 'Assignment/Conveyance',
    body:
      '.  Buyer shall prepare the assignment(s) on a form that is mutually agreeable to both Buyer and Seller.',
  },
  {
    heading: 'Special Warranty',
    body:
      '.  Seller will warrant title by, through, and under Seller.  Title will be conveyed to Buyer free and clear of any security interests, liens, mortgages, or other encumbrances.',
  },
  {
    heading: 'Restriction on Certain Actions',
    body:
      ".  Seller will not, without Buyer's prior written consent: (a) enter into or modify any oil and gas lease or other agreement with respect to any of the Interests; (b) sell, transfer, or abandon any portion of the Interests; or (c) release, modify or reduce its rights under, any oil, gas, and/or mineral lease forming a part of the Interests.",
  },
  {
    heading: 'Due Diligence',
    body:
      ".  Closing shall be subject to Buyer's review and approval of title and shall be at the sole discretion of the Buyer.  Seller shall in good faith cooperate with Buyer to provide any documentation readily available to address curative matters, and the closing shall further be contingent on the delivery of a properly executed assignment(s).",
  },
  {
    heading: 'Force Majeure',
    body:
      '.  In no event shall Buyer be held responsible or liable for any failure to or delay in Closing or in the performance of its obligations hereunder arising out of or caused by, directly or indirectly, forces beyond its control, including, without limitation, strikes, work stoppages, acts of war or terrorism, civil or military disturbances, natural catastrophes or acts of God, pandemic, or governmental action.',
  },
  {
    heading: 'Confidentiality',
    body:
      '.  This Agreement and its contents are intended to be confidential and are not to be discussed with or disclosed to any third party, except as may be required by contract or law.',
  },
  {
    heading: 'Choice of Law',
    body:
      '.  This Agreement shall be governed by the laws of the State of Texas without regard to conflict of law principles.',
  },
  {
    heading: 'Successors and Assigns',
    body:
      ".  This Agreement shall be binding upon and inure to the benefit of the parties hereto, and their respective successors and assigns. Buyer's rights and obligations under this Agreement may be freely assigned in Buyer's sole discretion at any time prior to Closing.",
  },
]

const numberToWords = (amount: number): string => {
  if (!amount || isNaN(amount)) return ''
  const ones = [
    '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN',
    'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN',
    'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
  ]
  const tens = [
    '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY',
    'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
  ]

  const convertHundreds = (n: number): string => {
    if (n === 0) return ''
    if (n < 20) return ones[n] + ' '
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '') + ' '
    return ones[Math.floor(n / 100)] + ' HUNDRED ' + convertHundreds(n % 100)
  }

  const dollars = Math.floor(amount)
  const cents = Math.round((amount - dollars) * 100)

  let result = ''
  if (dollars >= 1000000) {
    result += convertHundreds(Math.floor(dollars / 1000000)) + 'MILLION '
    const thousands = Math.floor((dollars % 1000000) / 1000)
    result += convertHundreds(thousands)
    if (thousands > 0) result += 'THOUSAND '
    result += convertHundreds(dollars % 1000)
  } else if (dollars >= 1000) {
    result += convertHundreds(Math.floor(dollars / 1000)) + 'THOUSAND '
    result += convertHundreds(dollars % 1000)
  } else {
    result += convertHundreds(dollars)
  }

  return result.trim() + ' AND ' + String(cents).padStart(2, '0') + '/100'
}


export const dynamic = 'force-dynamic'

type Deal = {
  id: string
  owner_name: string
  tract_abstract?: string | null
  tract_survey?: string | null
  rrc_lease_id?: string | null
  operator_name?: string | null
  county?: string | null
  surv_name?: string | null
  block?: string | null
  surv_sect?: string | null
  mailing_address?: string | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
  acreage?: number | null
  monthly_royalty?: number | null
  propensity_score?: number | null
  tag?: string | null
  offer_amount?: number | null
  follow_up_date?: string | null
  source?: string | null
  notes?: string | null
  phone?: string | null
  email?: string | null
  created_at?: string | null
  updated_at?: string | null
}

type ContactEntry = {
  id: string
  deal_id: string
  logged_at: string
  method: string
  outcome?: string | null
  notes?: string | null
}

type Task = { id: string; text: string; done: boolean; dealId: string }

type DealWell = {
  lease_name?: string | null
  operator_name?: string | null
  well_type?: string | null
}

const TAG_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  hot:            { label: 'Hot',           color: 'text-red-700',     bg: 'bg-red-50 border-red-200',       icon: <Flame size={11} /> },
  nurture:        { label: 'Nurture',       color: 'text-amber-700',   bg: 'bg-amber-50 border-amber-200',   icon: <TrendingUp size={11} /> },
  prospect:       { label: 'Prospect',      color: 'text-green-700',   bg: 'bg-green-50 border-green-200',   icon: <TrendingUp size={11} /> },
  not_interested: { label: 'Not Interested',color: 'text-slate-400',   bg: 'bg-slate-50 border-slate-100',   icon: <XCircle size={11} /> },
  bad_lead:       { label: 'Bad Lead',      color: 'text-rose-700',    bg: 'bg-rose-50 border-rose-200',     icon: <ThumbsDown size={11} /> },
  skip_traced:    { label: 'Skip Traced',   color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: <CheckCircle2 size={11} /> },
  offer_sent:     { label: 'Offer Sent',    color: 'text-blue-700',    bg: 'bg-blue-50 border-blue-200',     icon: <DollarSign size={11} /> },
  closed:         { label: 'Closed',        color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: <CheckCircle2 size={11} /> },
}

const TagBadge = ({ tag }: { tag: string }) => {
  const cfg = TAG_CONFIG[tag] ?? TAG_CONFIG.prospect
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.color}`}>
      {cfg.icon}{cfg.label}
    </span>
  )
}

const isOverdue = (date: string) => new Date(date) < new Date()

const formatDate = (date: string) => {
  const d = new Date(date)
  const today = new Date()
  const diff = Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff < 0) return `${Math.abs(diff)}d overdue`
  return `in ${diff}d`
}

type DealCounty = CountyKey | 'unknown'

const KNOWN_COUNTY_IDS = new Set<CountyKey>(Object.keys(COUNTIES) as CountyKey[])

const getDealCounty = (deal: Deal): DealCounty => {
  const stored = (deal.county ?? '').toLowerCase().trim() as CountyKey
  if (stored && KNOWN_COUNTY_IDS.has(stored)) return stored
  const op = (deal.operator_name ?? '').toLowerCase()
  if (!op) return 'unknown'
  // Walk every county's operatorPatterns list (sourced from lib/counties.ts)
  // — adding a county there is the only place this logic needs to know
  // about it.
  for (const [countyId, county] of Object.entries(COUNTIES) as Array<[CountyKey, County]>) {
    if (county.operatorPatterns.some((p) => op.includes(p))) {
      return countyId
    }
  }
  return 'unknown'
}

export default function CRM() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [selected, setSelected] = useState<Deal | null>(null)
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null)
  const [editingContact, setEditingContact] = useState(false)
  const [editPhone, setEditPhone] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [dealWells, setDealWells] = useState<DealWell[]>([])
  const [contactLog, setContactLog] = useState<ContactEntry[]>([])
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState('all')
  const [countyFilter, setCountyFilter] = useState<'all' | CountyKey>('all')
  const [search, setSearch] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [logModal, setLogModal] = useState<{ method: string } | null>(null)
  const [logNote, setLogNote] = useState('')
  const [buyerEntity, setBuyerEntity] = useState<BuyerEntity>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_BUYER_ENTITY }
    try {
      const saved = window.localStorage.getItem(BUYER_ENTITY_STORAGE_KEY)
      if (!saved) return { ...DEFAULT_BUYER_ENTITY }
      const parsed = JSON.parse(saved) as Partial<BuyerEntity>
      return { ...DEFAULT_BUYER_ENTITY, ...parsed }
    } catch {
      return { ...DEFAULT_BUYER_ENTITY }
    }
  })
  const [showPSAModal, setShowPSAModal] = useState(false)
  const [showDeedModal, setShowDeedModal] = useState(false)
  const [showFullPackageModal, setShowFullPackageModal] = useState(false)
  const [psaForm, setPsaForm] = useState<Record<string, string>>({})
  const [deedForm, setDeedForm] = useState<Record<string, string>>({})
  const [generatingDoc, setGeneratingDoc] = useState(false)

  useEffect(() => {
    supabase.from('deals').select('*').order('updated_at', { ascending: false }).then(({ data }) => {
      setDeals((data as Deal[]) ?? [])
    })
  }, [])

  const filtered = useMemo(() => deals.filter((d) => {
    if (activeTag !== 'all' && (d.tag ?? 'prospect') !== activeTag) return false
    if (countyFilter !== 'all' && getDealCounty(d) !== countyFilter) return false
    if (
      search &&
      !(d.owner_name ?? '').toLowerCase().includes(search.toLowerCase()) &&
      !(d.operator_name ?? '').toLowerCase().includes(search.toLowerCase())
    ) return false
    return true
  }), [deals, activeTag, countyFilter, search])

  const handleSelectDeal = async (deal: Deal) => {
    setSelected(deal)
    setEditingDeal({ ...deal, tag: deal.tag ?? 'prospect' })
    const { data } = await supabase
      .from('contact_log')
      .select('*')
      .eq('deal_id', deal.id)
      .order('logged_at', { ascending: false })
    setContactLog((data as ContactEntry[]) ?? [])
  }

  const handleSaveDeal = async (overrides?: Partial<Deal>) => {
    const toSave = { ...editingDeal, ...overrides }
    if (!toSave?.id) return

    const payload = {
      owner_name: toSave.owner_name ?? '',
      tract_abstract: toSave.tract_abstract ?? null,
      tract_survey: toSave.tract_survey ?? null,
      operator_name: toSave.operator_name ?? null,
      mailing_address: toSave.mailing_address ?? null,
      mailing_city: toSave.mailing_city ?? null,
      mailing_state: toSave.mailing_state ?? null,
      mailing_zip: toSave.mailing_zip ?? null,
      acreage: toSave.acreage === null || toSave.acreage === undefined ? null : Number(toSave.acreage),
      monthly_royalty: toSave.monthly_royalty === null || toSave.monthly_royalty === undefined ? null : Number(toSave.monthly_royalty),
      propensity_score: toSave.propensity_score === null || toSave.propensity_score === undefined ? null : Number(toSave.propensity_score),
      tag: toSave.tag ?? 'prospect',
      offer_amount: toSave.offer_amount === null || toSave.offer_amount === undefined ? null : Number(toSave.offer_amount),
      follow_up_date: toSave.follow_up_date || null,
      source: toSave.source ?? null,
      notes: toSave.notes ?? '',
      phone: toSave.phone ?? null,
      email: toSave.email ?? null,
      county: toSave.county ?? (() => {
        const derived = getDealCounty(toSave as Deal)
        return derived === 'unknown' ? null : derived
      })(),
      surv_name: toSave.surv_name ?? null,
      block: toSave.block ?? null,
      surv_sect: toSave.surv_sect ?? null,
      updated_at: new Date().toISOString(),
    }

    await supabase.from('deals').update(payload).eq('id', toSave.id)
    setDeals((prev) => prev.map((d) => d.id === toSave.id ? ({ ...d, ...payload } as Deal) : d))
    setSelected((prev) => prev?.id === toSave.id ? ({ ...prev, ...payload } as Deal) : prev)
    setEditingDeal((prev) => prev?.id === toSave.id ? ({ ...prev, ...payload } as Deal) : prev)
    setLastSaved('just now')
  }

  const handleTagChange = async (tag: string) => {
    if (!editingDeal) return
    setEditingDeal((prev) => prev ? { ...prev, tag } : null)
    await supabase.from('deals').update({ tag, updated_at: new Date().toISOString() }).eq('id', editingDeal.id)
    setDeals((prev) => prev.map((d) => d.id === editingDeal.id ? { ...d, tag } : d))
    setSelected((prev) => prev?.id === editingDeal.id ? { ...prev, tag } : prev)
  }

  const handleDeleteLead = useCallback(async () => {
    if (!editingDeal) return
    if (!confirm(`Delete ${editingDeal.owner_name} from pipeline?`)) return
    const { error } = await supabase
      .from('deals')
      .delete()
      .eq('id', editingDeal.id)
    if (error) {
      console.error('Failed to delete lead:', error)
      return
    }
    setDeals((prev) => prev.filter((d) => d.id !== editingDeal.id))
    setSelected(null)
    setEditingDeal(null)
    setContactLog([])
  }, [editingDeal])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && editingDeal && e.metaKey) {
        e.preventDefault()
        void handleDeleteLead()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingDeal, handleDeleteLead])

  useEffect(() => {
    if (!editingDeal) {
      setEditingContact(false)
      setEditPhone('')
      setEditEmail('')
      setDealWells([])
      return
    }

    setEditPhone(editingDeal.phone ?? '')
    setEditEmail(editingDeal.email ?? '')
    setEditingContact(false)
  }, [editingDeal])

  useEffect(() => {
    let cancelled = false

    const fetchDealWells = async () => {
      if (!editingDeal?.rrc_lease_id) {
        setDealWells([])
        return
      }

      const { data, error } = await supabase
        .from('gonzales_wells')
        .select('lease_name, operator_name, well_type')
        .eq('rrc_lease_id', String(editingDeal.rrc_lease_id))
        .limit(20)

      if (error) {
        console.error('Failed to load deal wells:', error)
        if (!cancelled) setDealWells([])
        return
      }

      if (!cancelled) {
        setDealWells((data as DealWell[]) ?? [])
      }
    }

    void fetchDealWells()
    return () => {
      cancelled = true
    }
  }, [editingDeal?.rrc_lease_id])

  const saveContactInfo = async () => {
    if (!editingDeal) return

    const phone = editPhone.trim() || null
    const email = editEmail.trim() || null

    const { error } = await supabase
      .from('deals')
      .update({
        phone,
        email,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingDeal.id)

    if (error) return

    setEditingDeal((prev) => (prev ? { ...prev, phone, email } : null))
    setSelected((prev) => (prev?.id === editingDeal.id ? { ...prev, phone, email } : prev))
    setDeals((prev) => prev.map((d) => (d.id === editingDeal.id ? { ...d, phone, email } : d)))
    setEditingContact(false)
  }

  const handleRunSkipTraceFromCRM = useCallback(async () => {
    if (!editingDeal) return

    const nameParts = (editingDeal.owner_name ?? '').trim().split(/\s+/)
    const lastName = nameParts.length > 1 ? nameParts[0] : ''
    const firstName = nameParts.length > 1 ? nameParts[1] : (nameParts[0] ?? '')

    const res = await fetch('/api/skiptrace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName,
        lastName,
        address: editingDeal.mailing_address ?? '',
        city: editingDeal.mailing_city ?? '',
        state: editingDeal.mailing_state ?? '',
        zip: editingDeal.mailing_zip ?? '',
        ownerName: editingDeal.owner_name,
      }),
    })

    const result = await res.json()
    const phone = result.phones?.[0] ?? null
    const email = result.emails?.[0] ?? null

    if (phone || email) {
      const derivedCounty = editingDeal.county ?? (() => {
        const d = getDealCounty(editingDeal)
        return d === 'unknown' ? null : d
      })()
      const updatePayload: Record<string, unknown> = {
        phone,
        email,
        tag: 'skip_traced',
        updated_at: new Date().toISOString(),
      }
      if (!editingDeal.county && derivedCounty) updatePayload.county = derivedCounty

      await supabase
        .from('deals')
        .update(updatePayload)
        .eq('id', editingDeal.id)

      setEditingDeal((prev) => (prev ? { ...prev, phone, email, tag: 'skip_traced', county: prev.county ?? derivedCounty ?? null } : null))
      setSelected((prev) => (prev?.id === editingDeal.id ? { ...prev, phone, email, tag: 'skip_traced', county: prev.county ?? derivedCounty ?? null } : prev))
      setDeals((prev) => prev.map((d) => (d.id === editingDeal.id ? { ...d, phone, email, tag: 'skip_traced', county: d.county ?? derivedCounty ?? null } : d)))
    } else {
      alert('No contact info found for this owner.')
    }
  }, [editingDeal])

  const openPSAModal = useCallback(() => {
    if (!editingDeal) return
    const today = new Date()
    const effectiveDate = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    const closingDate = new Date(today)
    closingDate.setDate(closingDate.getDate() + 44)

    const formatLong = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

    const countyNameResolved = (() => {
      const c = getDealCounty(editingDeal)
      return c === 'unknown' ? '' : (COUNTIES[c]?.name ?? '')
    })()
    const survName = (editingDeal.surv_name ?? '').trim()
    const blockVal = (editingDeal.block ?? '').trim()
    const survSectRaw = (editingDeal.surv_sect ?? '').trim()
    const tractAbstract = (editingDeal.tract_abstract ?? '').trim()
    const survSect = survSectRaw && survSectRaw !== tractAbstract ? survSectRaw : ''
    const builtLegalDesc = [
      survSect ? `Section ${survSect}` : '',
      blockVal ? `Block ${blockVal}` : '',
      survName,
      tractAbstract,
      countyNameResolved ? `${countyNameResolved} County, Texas` : '',
    ]
      .filter(Boolean)
      .join(', ')

    setPsaForm({
      agreementDate: formatLong(today),
      sellerName: editingDeal.owner_name ?? '',
      sellerAddress: editingDeal.mailing_address ?? '',
      sellerCity: editingDeal.mailing_city ?? '',
      sellerState: editingDeal.mailing_state ?? '',
      sellerZip: editingDeal.mailing_zip ?? '',
      buyerName: buyerEntity.name,
      buyerAddress: buyerEntity.address,
      buyerCity: buyerEntity.city,
      buyerState: buyerEntity.state,
      buyerZip: buyerEntity.zip,
      effectiveDate: formatLong(effectiveDate),
      closingDate: formatLong(closingDate),
      legalDescription: builtLegalDesc || tractAbstract,
      county: countyNameResolved,
      nra: editingDeal.acreage ? String(Number(editingDeal.acreage).toFixed(4)) : '',
      pricePerNRA: '',
      totalPrice: '',
      totalPriceWritten: '',
      operatorName: editingDeal.operator_name ?? '',
      rrcLeaseId: editingDeal.rrc_lease_id ?? '',
      buyerSignatory: 'Jordan Spearman',
    })
    setShowPSAModal(true)
  }, [editingDeal, buyerEntity])

  const openDeedModal = useCallback(() => {
    if (!editingDeal) return
    const today = new Date()
    const effectiveDate = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    const formatLong = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

    const countyNameResolved = (() => {
      const c = getDealCounty(editingDeal)
      return c === 'unknown' ? '' : (COUNTIES[c]?.name ?? '')
    })()
    const survName = (editingDeal.surv_name ?? '').trim()
    const blockVal = (editingDeal.block ?? '').trim()
    const survSectRaw = (editingDeal.surv_sect ?? '').trim()
    const tractAbstract = (editingDeal.tract_abstract ?? '').trim()
    const survSect = survSectRaw && survSectRaw !== tractAbstract ? survSectRaw : ''
    const builtLegalDesc = [
      survSect ? `Section ${survSect}` : '',
      blockVal ? `Block ${blockVal}` : '',
      survName,
      tractAbstract,
      countyNameResolved ? `${countyNameResolved} County, Texas` : '',
    ]
      .filter(Boolean)
      .join(', ')

    setDeedForm({
      grantorName: editingDeal.owner_name ?? '',
      grantorAddress: editingDeal.mailing_address ?? '',
      grantorCity: editingDeal.mailing_city ?? '',
      grantorState: editingDeal.mailing_state ?? '',
      grantorZip: editingDeal.mailing_zip ?? '',
      granteeName: buyerEntity.name,
      granteeAddress: buyerEntity.address,
      granteeCity: buyerEntity.city,
      granteeState: buyerEntity.state,
      granteeZip: buyerEntity.zip,
      effectiveDate: formatLong(effectiveDate),
      legalDescription: builtLegalDesc || tractAbstract,
      county: countyNameResolved,
    })
    setShowDeedModal(true)
  }, [editingDeal, buyerEntity])

  const openFullPackageModal = useCallback(() => {
    openPSAModal()
    setShowFullPackageModal(true)
  }, [openPSAModal])

  const updatePSAField = useCallback((field: string, value: string) => {
    setPsaForm((prev) => {
      const next = { ...prev, [field]: value }
      const nraNum = Number(next.nra)
      if (field === 'pricePerNRA') {
        const pricePerNra = Number(value.replace(/[,$]/g, ''))
        if (nraNum > 0 && pricePerNra > 0) {
          const total = nraNum * pricePerNra
          next.totalPrice = total.toFixed(2)
          next.totalPriceWritten = numberToWords(total)
        }
      }
      if (field === 'totalPrice') {
        const total = Number(value.replace(/[,$]/g, ''))
        if (nraNum > 0 && total > 0) {
          next.pricePerNRA = (total / nraNum).toFixed(2)
        }
        next.totalPriceWritten = total > 0 ? numberToWords(total) : ''
      }
      if (field === 'nra') {
        const nraNext = Number(value)
        const pricePerNra = Number((next.pricePerNRA ?? '').replace(/[,$]/g, ''))
        if (nraNext > 0 && pricePerNra > 0) {
          const total = nraNext * pricePerNra
          next.totalPrice = total.toFixed(2)
          next.totalPriceWritten = numberToWords(total)
        }
      }
      return next
    })
  }, [])

  const updateDeedField = useCallback((field: string, value: string) => {
    setDeedForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  const generatePSA = useCallback(async () => {
    setGeneratingDoc(true)
    try {
      const response = await fetch('/api/generate-psa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(psaForm),
      })
      if (!response.ok) throw new Error('Failed to generate PSA')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${psaForm.sellerName?.replace(/[^a-z0-9]/gi, '_') || 'PSA'}_PSA.docx`
      a.click()
      URL.revokeObjectURL(url)
      setShowPSAModal(false)
    } catch (err) {
      console.error('PSA generation error:', err)
      alert('Failed to generate PSA. Please try again.')
    } finally {
      setGeneratingDoc(false)
    }
  }, [psaForm])

  const generateDeed = useCallback(async () => {
    setGeneratingDoc(true)
    try {
      const response = await fetch('/api/generate-deed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deedForm),
      })
      if (!response.ok) throw new Error('Failed to generate Deed')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${deedForm.grantorName?.replace(/[^a-z0-9]/gi, '_') || 'Deed'}_Mineral_Deed.docx`
      a.click()
      URL.revokeObjectURL(url)
      setShowDeedModal(false)
    } catch (err) {
      console.error('Deed generation error:', err)
      alert('Failed to generate Deed. Please try again.')
    } finally {
      setGeneratingDoc(false)
    }
  }, [deedForm])

  const annual = editingDeal?.monthly_royalty ? Number(editingDeal.monthly_royalty) * 12 : 0

  return (
    <div className="mm-app h-screen flex flex-col bg-gray-50">
      <AppHeader
        active="crm"
        context={
          <div className="mm-context">
            <span className="mm-context-label">CRM</span>
            <span>Pipeline</span>
          </div>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[260px] shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 bg-white">
            <div className="grid grid-cols-3 gap-1">
              {[
                { label: 'Total', val: deals.length },
                { label: 'Hot', val: deals.filter((d) => (d.tag ?? 'prospect') === 'hot').length, color: 'text-red-600' },
                { label: 'Follow up', val: deals.filter((d) => d.follow_up_date && isOverdue(d.follow_up_date)).length, color: 'text-amber-600' },
              ].map((s) => (
                <div key={s.label} className="text-center py-1">
                  <div className={`text-base font-bold font-serif ${s.color ?? 'text-gray-900'}`}>{s.val}</div>
                  <div className="text-xs text-gray-400">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="p-3 border-b border-gray-100">
            <div className="relative mb-2">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search owners, operators..."
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-gray-200 rounded-md focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all"
              />
            </div>
            <div className="flex gap-1 flex-wrap">
              {['all', ...Object.keys(TAG_CONFIG)].map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag(tag)}
                  className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
                    activeTag === tag
                      ? 'bg-amber-50 border-amber-300 text-amber-700 font-medium'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {tag === 'all' ? 'All' : TAG_CONFIG[tag]?.label}
                  {tag !== 'all' && (
                    <span className="ml-1 text-gray-400">{deals.filter((d) => (d.tag ?? 'prospect') === tag).length}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="mt-2">
              <label className="sr-only" htmlFor="crm-county-filter">County</label>
              <div className="relative">
                <MapPin
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                />
                <select
                  id="crm-county-filter"
                  value={countyFilter}
                  onChange={(e) => setCountyFilter(e.target.value as typeof countyFilter)}
                  className="w-full appearance-none pl-8 pr-7 py-1.5 text-xs font-medium bg-white border border-gray-200 rounded-md text-gray-700 hover:border-gray-300 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 transition-colors"
                >
                  <option value="all">All Counties ({deals.length})</option>
                  {(Object.entries(COUNTIES) as Array<[CountyKey, County]>).map(([countyId, county]) => {
                    const count = deals.filter((d) => getDealCounty(d) === countyId).length
                    return (
                      <option key={countyId} value={countyId}>
                        {county.name} ({count})
                      </option>
                    )
                  })}
                </select>
                <svg
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                  width="10" height="10" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </div>
          </div>

          <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100 font-semibold">
            {filtered.length} leads
          </div>

          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-8 text-center">
                <div className="text-sm text-gray-400">No leads found</div>
              </div>
            ) : filtered.map((deal) => (
              <button
                key={deal.id}
                onClick={() => handleSelectDeal(deal)}
                className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                  selected?.id === deal.id ? 'bg-white border-l-2 border-l-amber-500 shadow-sm' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-900 leading-tight">{deal.owner_name}</span>
                  <TagBadge tag={deal.tag ?? 'prospect'} />
                </div>
                <div className="text-xs text-gray-400 mb-1">
                  {deal.tract_abstract ?? '--'} · {deal.operator_name ?? '--'}
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  {deal.mailing_city && <span>{deal.mailing_city}, {deal.mailing_state}</span>}
                  {deal.acreage ? <span>{deal.acreage} ac</span> : null}
                  {deal.monthly_royalty ? <span>${Number(deal.monthly_royalty).toLocaleString()}/mo</span> : null}
                </div>
                {deal.follow_up_date && (
                  <div className={`mt-1.5 inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${
                    isOverdue(deal.follow_up_date)
                      ? 'bg-red-50 text-red-600'
                      : 'bg-amber-50 text-amber-600'
                  }`}>
                    <Clock size={10} />
                    {formatDate(deal.follow_up_date)}
                  </div>
                )}
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 overflow-hidden flex">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {!selected || !editingDeal ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <User size={20} className="text-gray-400" />
                  </div>
                  <div className="text-sm font-medium text-gray-500">Select a lead</div>
                  <div className="text-xs text-gray-400 mt-1">Choose a lead from the list to view details</div>
                </div>
              </div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4 shadow-sm border-b-2 border-b-amber-400">
                  <div className="flex items-start justify-between mb-3">
                    <input
                      value={editingDeal.owner_name ?? ''}
                      onChange={(e) => setEditingDeal((p) => p ? { ...p, owner_name: e.target.value } : null)}
                      onBlur={() => handleSaveDeal()}
                      className="text-2xl font-bold tracking-tight text-gray-900 bg-transparent border-none outline-none w-full font-serif"
                    />
                    <div className="shrink-0 flex items-center gap-2 mt-1">
                      {lastSaved && (
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Save size={11} />Saved {lastSaved}
                        </span>
                      )}
                      <button
                        onClick={() => {
                          void handleDeleteLead()
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-md transition-colors"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>
                        Delete lead
                      </button>
                    </div>
                  </div>

                  {/* Pipeline stage bar */}
                  <div className="flex items-center gap-1 mb-4 p-1 bg-gray-50 rounded-lg border border-gray-100">
                    {[
                      { key: 'prospect', label: 'Prospect' },
                      { key: 'nurture', label: 'Nurture' },
                      { key: 'hot', label: 'Hot' },
                      { key: 'offer_sent', label: 'Offer Sent' },
                      { key: 'closed', label: 'Closed' },
                    ].map((stage) => {
                      const stageOrder = ['prospect', 'nurture', 'hot', 'offer_sent', 'closed']
                      const currentIdx = stageOrder.indexOf(editingDeal.tag ?? 'prospect')
                      const thisIdx = stageOrder.indexOf(stage.key)
                      const isActive = (editingDeal.tag ?? 'prospect') === stage.key
                      const isPast = thisIdx < currentIdx

                      return (
                        <button
                          key={stage.key}
                          onClick={() => handleTagChange(stage.key)}
                          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                            isActive
                              ? 'bg-white shadow-sm text-gray-900 border border-gray-200'
                              : isPast
                              ? 'text-gray-400 hover:text-gray-600'
                              : 'text-gray-400 hover:text-gray-600'
                          }`}
                        >
                          {stage.label}
                        </button>
                      )
                    })}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(TAG_CONFIG).map(([key, cfg]) => (
                      <button
                        key={key}
                        onClick={() => handleTagChange(key)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                          editingDeal.tag === key
                            ? `${cfg.bg} ${cfg.color} shadow-sm`
                            : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300'
                        }`}
                      >
                        {cfg.icon}{cfg.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4 shadow-sm">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100">Lead Info</div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                    {[
                      { label: 'Tract', field: 'tract_abstract', icon: <MapPin size={13} /> },
                      { label: 'Survey', field: 'tract_survey', icon: <MapPin size={13} /> },
                      { label: 'Operator', field: 'operator_name', icon: <Building2 size={13} /> },
                      { label: 'Address', field: 'mailing_address', icon: <MapPin size={13} /> },
                      { label: 'City', field: 'mailing_city', icon: null },
                      { label: 'State', field: 'mailing_state', icon: null },
                      { label: 'Zip', field: 'mailing_zip', icon: null },
                      { label: 'Acreage', field: 'acreage', icon: null },
                    ].map(({ label, field, icon }) => (
                      <div key={field}>
                        <div className="flex items-center gap-1 text-xs font-medium text-gray-400 mb-1">
                          {icon}{label}
                        </div>
                        <input
                          value={String(editingDeal[field as keyof Deal] ?? '')}
                          onChange={(e) => setEditingDeal((p) => p ? { ...p, [field]: e.target.value } : null)}
                          onBlur={() => handleSaveDeal()}
                          className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Contact
                      </div>
                      <button
                        onClick={() => {
                          if (editingContact) {
                            setEditPhone(editingDeal.phone ?? '')
                            setEditEmail(editingDeal.email ?? '')
                          }
                          setEditingContact(!editingContact)
                        }}
                        className="text-xs text-amber-500 hover:text-amber-600 font-medium"
                      >
                        {editingContact ? 'Cancel' : 'Edit'}
                      </button>
                    </div>

                    {editingContact ? (
                      <div className="space-y-2">
                        <input
                          type="tel"
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          placeholder="Phone number"
                          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
                        />
                        <input
                          type="email"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          placeholder="Email address"
                          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
                        />
                        <button
                          onClick={() => {
                            void saveContactInfo()
                          }}
                          className="w-full py-2 text-sm font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {editingDeal.phone ? (
                          <a
                            href={`tel:${editingDeal.phone}`}
                            className="flex items-center gap-2 text-sm text-gray-700 hover:text-amber-600"
                          >
                            <Phone size={13} />
                            {editingDeal.phone}
                          </a>
                        ) : (
                          <button
                            onClick={() => setEditingContact(true)}
                            className="text-sm text-gray-400 hover:text-amber-500"
                          >
                            + Add phone
                          </button>
                        )}
                        {editingDeal.email ? (
                          <a
                            href={`mailto:${editingDeal.email}`}
                            className="flex items-center gap-2 text-sm text-gray-700 hover:text-amber-600"
                          >
                            <Mail size={13} />
                            {editingDeal.email}
                          </a>
                        ) : (
                          <button
                            onClick={() => setEditingContact(true)}
                            className="text-sm text-gray-400 hover:text-amber-500"
                          >
                            + Add email
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {!editingDeal.phone && !editingDeal.email && (
                    <button
                      onClick={() => {
                        void handleRunSkipTraceFromCRM()
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 transition-colors mt-2"
                    >
                      <Phone size={12} />
                      Run skip trace
                    </button>
                  )}

                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Offer Documents
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => openPSAModal()}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
                      >
                        <FileText size={12} />
                        Generate PSA
                      </button>
                      <button
                        onClick={() => openDeedModal()}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md hover:bg-green-100 transition-colors"
                      >
                        <FileText size={12} />
                        Generate Mineral Deed
                      </button>
                      <button
                        onClick={() => openFullPackageModal()}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 transition-colors"
                      >
                        <Package size={12} />
                        Generate Full Package
                      </button>
                    </div>
                  </div>

                  {dealWells.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-100">
                      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                        Wells on this interest
                      </div>
                      {dealWells.map((well, i) => (
                        <div key={`${well.lease_name ?? 'well'}-${i}`} className="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            well.well_type === 'HORIZONTAL' ? 'bg-amber-400' : 'bg-gray-300'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">{well.lease_name ?? 'Unknown lease'}</div>
                            <div className="text-xs text-gray-400">{well.operator_name ?? 'Unknown operator'}</div>
                          </div>
                          <div className="text-xs text-gray-400 shrink-0">{well.well_type ?? 'VERTICAL'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4 shadow-sm">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100">Offer & Valuation</div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input
                        type="number"
                        placeholder="Your offer amount"
                        value={editingDeal.offer_amount ?? ''}
                        onChange={(e) => setEditingDeal((p) => p ? { ...p, offer_amount: e.target.value === '' ? null : Number(e.target.value) } : null)}
                        onBlur={() => handleSaveDeal()}
                        className="w-full pl-7 pr-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 transition-all"
                      />
                    </div>
                  </div>
                  {annual > 0 && (
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: 'Conservative', mult: 3, muted: true },
                        { label: 'Market Rate', mult: 4, muted: false },
                        { label: 'Aggressive', mult: 5, muted: true },
                      ].map((c) => (
                        <div key={c.mult} className={`rounded-lg p-3 text-center border ${c.muted ? 'bg-gray-50 border-gray-200' : 'bg-amber-50 border-amber-200'}`}>
                          <div className="text-xs text-gray-500 mb-1">{c.label} ({c.mult}x)</div>
                          <div className={`text-base font-bold font-serif ${c.muted ? 'text-gray-700' : 'text-amber-700'}`}>
                            ${(annual * c.mult).toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4 shadow-sm">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100">Follow-up Reminder</div>
                  <div className="flex items-center gap-3 mb-3">
                    <input
                      type="date"
                      value={editingDeal.follow_up_date ?? ''}
                      onChange={(e) => setEditingDeal((p) => p ? { ...p, follow_up_date: e.target.value } : null)}
                      onBlur={() => handleSaveDeal()}
                      className="text-sm border border-gray-200 rounded-md px-3 py-1.5 focus:outline-none focus:border-amber-400 transition-all [color-scheme:light]"
                    />
                    {editingDeal.follow_up_date && (
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                        isOverdue(editingDeal.follow_up_date)
                          ? 'bg-red-50 text-red-600'
                          : 'bg-amber-50 text-amber-600'
                      }`}>
                        {formatDate(editingDeal.follow_up_date)}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {[{ label: '+3d', days: 3 }, { label: '+1w', days: 7 }, { label: '+2w', days: 14 }, { label: '+1mo', days: 30 }].map((q) => (
                      <button
                        key={q.days}
                        onClick={() => {
                          const d = new Date()
                          d.setDate(d.getDate() + q.days)
                          const ds = d.toISOString().split('T')[0]
                          setEditingDeal((p) => p ? { ...p, follow_up_date: ds } : null)
                          handleSaveDeal({ follow_up_date: ds } as Partial<Deal>)
                        }}
                        className="px-3 py-1 text-xs border border-gray-200 rounded-md text-gray-500 hover:border-amber-300 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-xs font-bold text-gray-400 uppercase tracking-widest pb-3 border-b border-gray-100 w-full">Notes</div>
                    {lastSaved && <span className="text-xs text-gray-400">Saved {lastSaved}</span>}
                  </div>
                  <textarea
                    value={editingDeal.notes ?? ''}
                    onChange={(e) => setEditingDeal((p) => p ? { ...p, notes: e.target.value } : null)}
                    onBlur={() => handleSaveDeal()}
                    placeholder="Add notes about this lead..."
                    rows={5}
                    className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all resize-none leading-relaxed"
                  />
                </div>
              </>
            )}
          </div>

          <aside className="w-72 shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
            {selected ? (
              <>
                <div className="p-4 border-b border-gray-100">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Quick Actions</div>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {['Called — no answer', 'Called — spoke', 'Left voicemail', 'Sent letter', 'Sent email', 'Met in person'].map(method => (
                      <button
                        key={method}
                        onClick={() => {
                          setLogModal({ method })
                          setLogNote('')
                        }}
                        className="px-3 py-1.5 text-xs border border-gray-200 rounded-md text-gray-600 hover:border-amber-300 hover:text-amber-700 hover:bg-amber-50 transition-colors font-medium bg-white shadow-sm"
                      >
                        + {method}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-4 border-b border-gray-100">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Lead Score</div>
                  <div className="flex items-center gap-3">
                    <div className={`text-3xl font-bold font-serif ${
                      (selected.propensity_score ?? 0) >= 8 ? 'text-red-600' :
                      (selected.propensity_score ?? 0) >= 6 ? 'text-amber-600' : 'text-gray-500'
                    }`}>
                      {selected.propensity_score ?? 0}
                      <span className="text-lg text-gray-400 font-normal">/10</span>
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-700">
                        {(selected.propensity_score ?? 0) >= 8 ? 'Hot lead' :
                         (selected.propensity_score ?? 0) >= 6 ? 'Warm lead' : 'Low priority'}
                      </div>
                      <div className="text-xs text-gray-400">Source: {selected.source ?? 'map'}</div>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        (selected.propensity_score ?? 0) >= 8 ? 'bg-red-500' :
                        (selected.propensity_score ?? 0) >= 6 ? 'bg-amber-400' : 'bg-gray-300'
                      }`}
                      style={{ width: `${((selected.propensity_score ?? 0) / 10) * 100}%` }}
                    />
                  </div>
                </div>

                <div className="p-4 border-b border-gray-100">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-xs font-bold text-gray-400 uppercase tracking-widest">Tasks</div>
                    <button
                      onClick={() => {
                        const task = prompt('Add task:')
                        if (task) {
                          setTasks((prev) => [...prev, { id: Date.now().toString(), text: task, done: false, dealId: selected.id }])
                        }
                      }}
                      className="text-xs text-amber-600 hover:text-amber-700 font-medium"
                    >
                      + Add
                    </button>
                  </div>
                  {tasks.filter((t) => t.dealId === selected.id).length === 0 ? (
                    <div className="text-xs text-gray-400 italic">No tasks yet</div>
                  ) : (
                    <div className="space-y-2">
                      {tasks.filter((t) => t.dealId === selected.id).map((task) => (
                        <div key={task.id} className="flex items-start gap-2">
                          <button
                            onClick={() => setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, done: !t.done } : t))}
                            className="mt-0.5 shrink-0"
                          >
                            {task.done
                              ? <CheckCircle2 size={15} className="text-emerald-500" />
                              : <Circle size={15} className="text-gray-300 hover:text-amber-400" />
                            }
                          </button>
                          <span className={`text-sm leading-tight ${task.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                            {task.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="p-4">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Activity</div>
                  {contactLog.length === 0 ? (
                    <div className="text-xs text-gray-400 italic">No activity yet</div>
                  ) : (
                    <div className="space-y-3">
                      {contactLog.slice(0, 8).map((entry, i) => (
                        <div key={entry.id ?? `${entry.logged_at}-${i}`} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="w-2 h-2 rounded-full bg-amber-400 mt-1 shrink-0" />
                            {i < contactLog.slice(0, 8).length - 1 && <div className="w-px flex-1 bg-gray-100 mt-1" />}
                          </div>
                          <div className="pb-3">
                            <div className="text-sm text-gray-700 leading-tight">{entry.method}</div>
                            <div className="text-xs text-gray-400 mt-0.5">
                              {new Date(entry.logged_at).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="p-6 text-center text-sm text-gray-400 italic mt-8">
                Select a lead to see tasks and activity
              </div>
            )}
          </aside>
        </main>
      </div>

      {logModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 shadow-2xl">
            <h3 className="font-serif text-lg font-bold text-gray-900 mb-1">{logModal.method}</h3>
            <p className="text-sm text-gray-400 mb-4">Add notes about this contact attempt</p>
            <textarea
              value={logNote}
              onChange={(e) => setLogNote(e.target.value)}
              placeholder="e.g. Spoke with owner for 10 min, interested but wants to think about it. Call back next week."
              rows={4}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2.5 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 resize-none mb-4"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setLogModal(null)}
                className="px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!editingDeal) return
                  const entry = logNote.trim()
                    ? `${logModal.method} — ${logNote.trim()}`
                    : logModal.method
                  const loggedAt = new Date().toISOString()
                  await supabase.from('contact_log').insert({
                    deal_id: editingDeal.id,
                    method: entry,
                    logged_at: loggedAt,
                  })
                  setContactLog((prev) => [{
                    id: Date.now().toString(),
                    deal_id: editingDeal.id,
                    logged_at: loggedAt,
                    method: entry,
                  }, ...prev])
                  setLogModal(null)
                  setLogNote('')
                }}
                className="px-4 py-2 text-sm font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600"
              >
                Save log
              </button>
            </div>
          </div>
        </div>
      )}

      {showPSAModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
              <div>
                <div className="text-lg font-semibold text-gray-900">Purchase &amp; Sale Agreement</div>
                {showFullPackageModal && (
                  <div className="text-xs text-amber-700 mt-0.5">
                    Full package: PSA + Mineral Deed will be generated.
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setShowPSAModal(false)
                    setShowFullPackageModal(false)
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (showFullPackageModal) {
                      setDeedForm((prev) => ({
                        ...prev,
                        grantorName: psaForm.sellerName ?? prev.grantorName ?? '',
                        grantorAddress: psaForm.sellerAddress ?? prev.grantorAddress ?? '',
                        grantorCity: psaForm.sellerCity ?? prev.grantorCity ?? '',
                        grantorState: psaForm.sellerState ?? prev.grantorState ?? '',
                        grantorZip: psaForm.sellerZip ?? prev.grantorZip ?? '',
                        granteeName: psaForm.buyerName ?? prev.granteeName ?? '',
                        granteeAddress: psaForm.buyerAddress ?? prev.granteeAddress ?? '',
                        granteeCity: psaForm.buyerCity ?? prev.granteeCity ?? '',
                        granteeState: psaForm.buyerState ?? prev.granteeState ?? '',
                        granteeZip: psaForm.buyerZip ?? prev.granteeZip ?? '',
                        effectiveDate: psaForm.effectiveDate ?? prev.effectiveDate ?? '',
                        legalDescription: psaForm.legalDescription ?? prev.legalDescription ?? '',
                        county: psaForm.county ?? prev.county ?? '',
                      }))
                      void generatePSA().then(() => {
                        setShowDeedModal(true)
                      })
                    } else {
                      void generatePSA()
                    }
                  }}
                  disabled={generatingDoc}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-60"
                >
                  {generatingDoc && (
                    <span
                      className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"
                      aria-hidden
                    />
                  )}
                  {generatingDoc
                    ? 'Generating…'
                    : showFullPackageModal
                      ? 'Download PSA & Continue'
                      : 'Download PSA'}
                </button>
              </div>
            </div>

            <div
              className="overflow-y-auto"
              style={{
                maxHeight: '85vh',
                padding: '48px 64px',
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: 12,
                lineHeight: 1.8,
                color: '#111827',
              }}
            >
              <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 14, marginBottom: 24 }}>
                PURCHASE AND SALE AGREEMENT
              </div>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                This Purchase and Sale Agreement (the &ldquo;Agreement&rdquo;) is entered into this{' '}
                <DocField
                  value={psaForm.agreementDate ?? ''}
                  onChange={(v) => updatePSAField('agreementDate', v)}
                  placeholder="Agreement date"
                />{' '}
                but is effective as of{' '}
                <DocField
                  value={psaForm.effectiveDate ?? ''}
                  onChange={(v) => updatePSAField('effectiveDate', v)}
                  placeholder="Effective date"
                />
                , by and between{' '}
                <DocField
                  value={psaForm.sellerName ?? ''}
                  onChange={(v) => updatePSAField('sellerName', v)}
                  placeholder="Seller name"
                  minChars={20}
                  style={{ fontWeight: 700 }}
                />{' '}
                whose address is{' '}
                <DocField
                  value={psaForm.sellerAddress ?? ''}
                  onChange={(v) => updatePSAField('sellerAddress', v)}
                  placeholder="Seller address"
                  minChars={18}
                />
                ,{' '}
                <DocField
                  value={psaForm.sellerCity ?? ''}
                  onChange={(v) => updatePSAField('sellerCity', v)}
                  placeholder="City"
                />
                ,{' '}
                <DocField
                  value={psaForm.sellerState ?? ''}
                  onChange={(v) => updatePSAField('sellerState', v)}
                  placeholder="ST"
                  minChars={4}
                />{' '}
                <DocField
                  value={psaForm.sellerZip ?? ''}
                  onChange={(v) => updatePSAField('sellerZip', v)}
                  placeholder="Zip"
                  minChars={7}
                />{' '}
                (the &ldquo;Seller&rdquo;), and{' '}
                <DocField
                  value={psaForm.buyerName ?? ''}
                  onChange={(v) => updatePSAField('buyerName', v)}
                  placeholder="Buyer entity name"
                  minChars={20}
                  style={{ fontWeight: 700 }}
                />
                , whose address is{' '}
                <DocField
                  value={psaForm.buyerAddress ?? ''}
                  onChange={(v) => updatePSAField('buyerAddress', v)}
                  placeholder="Buyer address"
                  minChars={18}
                />
                ,{' '}
                <DocField
                  value={psaForm.buyerCity ?? ''}
                  onChange={(v) => updatePSAField('buyerCity', v)}
                  placeholder="City"
                />
                ,{' '}
                <DocField
                  value={psaForm.buyerState ?? ''}
                  onChange={(v) => updatePSAField('buyerState', v)}
                  placeholder="ST"
                  minChars={4}
                />{' '}
                <DocField
                  value={psaForm.buyerZip ?? ''}
                  onChange={(v) => updatePSAField('buyerZip', v)}
                  placeholder="Zip"
                  minChars={7}
                />{' '}
                (the &ldquo;Buyer&rdquo;).
              </p>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                WHEREAS, Seller owns and desires to sell or assign to Buyer certain oil, gas, mineral
                and/or royalty interests (the &ldquo;Interests&rdquo;) owned in{' '}
                <DocField
                  value={psaForm.county ?? ''}
                  onChange={(v) => updatePSAField('county', v)}
                  placeholder="County"
                />{' '}
                County, Texas, in the subject lands described on the attached Exhibit &ldquo;A.&rdquo;
              </p>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                WHEREAS, Buyer desires to purchase such Interests in the lands described in the attached
                Exhibit &ldquo;A.&rdquo;
              </p>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                NOW THEREFORE, Seller and Buyer have reached an agreement regarding such purchase and
                sale with the following terms and conditions:
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', rowGap: 6, marginBottom: 16 }}>
                <div>Purchase Price:</div>
                <div>
                  $
                  <DocField
                    value={psaForm.totalPrice ?? ''}
                    onChange={(v) => updatePSAField('totalPrice', v)}
                    placeholder="0.00"
                  />
                </div>
                <div>Number of Net Royalty Acres:</div>
                <div>
                  <DocField
                    value={psaForm.nra ?? ''}
                    onChange={(v) => updatePSAField('nra', v)}
                    placeholder="0.0000"
                  />
                </div>
                <div>Closing Date:</div>
                <div>
                  On or before{' '}
                  <DocField
                    value={psaForm.closingDate ?? ''}
                    onChange={(v) => updatePSAField('closingDate', v)}
                    placeholder="Closing date"
                  />
                  , or thirty (30) business days after the date which both Seller and Buyer have executed
                  the Agreement, whichever is later.
                </div>
                <div>Effective Date:</div>
                <div>
                  <DocField
                    value={psaForm.effectiveDate ?? ''}
                    onChange={(v) => updatePSAField('effectiveDate', v)}
                    placeholder="Effective date"
                  />
                </div>
              </div>

              {PSA_CLAUSES.slice(0, 3).map((c) => (
                <p key={c.heading} style={{ textAlign: 'justify', marginBottom: 14 }}>
                  <span style={{ textDecoration: 'underline' }}>{c.heading}</span>
                  {c.body}
                </p>
              ))}

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                <span style={{ textDecoration: 'underline' }}>Calculation of Purchase Price</span>. The
                total purchase price for the Interests shall be{' '}
                <DocField
                  value={psaForm.totalPriceWritten ?? ''}
                  onChange={(v) => updatePSAField('totalPriceWritten', v)}
                  placeholder="WRITTEN OUT AMOUNT"
                  minChars={40}
                  style={{ fontWeight: 700 }}
                />{' '}
                ($
                <DocField
                  value={psaForm.totalPrice ?? ''}
                  onChange={(v) => updatePSAField('totalPrice', v)}
                  placeholder="0.00"
                />
                ) (the &ldquo;Purchase Price&rdquo;), subject to adjustment as set forth herein, based upon
                the Parties&rsquo; belief that Seller owns{' '}
                <DocField
                  value={psaForm.nra ?? ''}
                  onChange={(v) => updatePSAField('nra', v)}
                  placeholder="0.0000"
                />{' '}
                Net Royalty Acres in the lands described on the attached Exhibit &ldquo;A.&rdquo; For
                purposes of calculating the Purchase Price, &ldquo;Net Royalty Acres&rdquo; shall mean one
                (1) net mineral acre of land subject to an oil and gas lease at a one-eighth (1/8)
                royalty, free and clear of any and all burdens outstanding in third parties. In the event
                Buyer establishes that Seller owns less Net Royalty Acres than set forth above, the
                Purchase Price will accordingly be proportionately reduced.
              </p>

              {PSA_CLAUSES.slice(3).map((c) => (
                <p key={c.heading} style={{ textAlign: 'justify', marginBottom: 14 }}>
                  <span style={{ textDecoration: 'underline' }}>{c.heading}</span>
                  {c.body}
                </p>
              ))}

              <div style={{ marginTop: 40 }}>
                <div style={{ fontWeight: 700 }}>SELLER:</div>
                <div style={{ fontWeight: 700, marginTop: 4 }}>
                  <DocField
                    value={psaForm.sellerName ?? ''}
                    onChange={(v) => updatePSAField('sellerName', v)}
                    placeholder="SELLER NAME"
                    minChars={24}
                    style={{ fontWeight: 700, textTransform: 'uppercase' }}
                  />
                </div>
                <div style={{ marginTop: 16 }}>___________________________</div>
                <div>Date: _______________________</div>
              </div>

              <div style={{ marginTop: 32 }}>
                <div style={{ fontWeight: 700 }}>BUYER:</div>
                <div style={{ fontWeight: 700, marginTop: 4 }}>
                  <DocField
                    value={psaForm.buyerName ?? ''}
                    onChange={(v) => updatePSAField('buyerName', v)}
                    placeholder="BUYER ENTITY"
                    minChars={24}
                    style={{ fontWeight: 700, textTransform: 'uppercase' }}
                  />
                </div>
                <div style={{ marginTop: 16 }}>___________________________</div>
                <div>
                  By:&nbsp;&nbsp;&nbsp;&nbsp;
                  <DocField
                    value={psaForm.buyerSignatory ?? ''}
                    onChange={(v) => updatePSAField('buyerSignatory', v)}
                    placeholder="Signatory name"
                    minChars={18}
                  />
                </div>
                <div>Title:&nbsp;&nbsp;&nbsp;&nbsp;Managing Member</div>
                <div>Date:&nbsp;&nbsp;______________________</div>
              </div>

              <div style={{ marginTop: 48 }}>
                <div style={{ textAlign: 'center', fontWeight: 700, marginBottom: 14 }}>
                  EXHIBIT &ldquo;A&rdquo;
                </div>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  Attached to and made part of that certain Purchase and Sale Agreement dated{' '}
                  <DocField
                    value={psaForm.agreementDate ?? ''}
                    onChange={(v) => updatePSAField('agreementDate', v)}
                    placeholder="Agreement date"
                  />
                  , by and between{' '}
                  <DocField
                    value={psaForm.sellerName ?? ''}
                    onChange={(v) => updatePSAField('sellerName', v)}
                    placeholder="Seller"
                    minChars={18}
                  />{' '}
                  (the &ldquo;Seller&rdquo;) and{' '}
                  <DocField
                    value={psaForm.buyerName ?? ''}
                    onChange={(v) => updatePSAField('buyerName', v)}
                    placeholder="Buyer"
                    minChars={18}
                  />{' '}
                  (the &ldquo;Buyer&rdquo;).
                </div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>LANDS:</div>
                <DocTextarea
                  value={psaForm.legalDescription ?? ''}
                  onChange={(v) => updatePSAField('legalDescription', v)}
                  placeholder="Legal description / Exhibit A lands"
                  rows={5}
                />
                <div style={{ textAlign: 'center', fontWeight: 700, marginTop: 14 }}>
                  [END OF EXHIBIT &ldquo;A&rdquo;]
                </div>
              </div>
            </div>

            <div className="sr-only">
              <input
                value={psaForm.operatorName ?? ''}
                onChange={(e) => updatePSAField('operatorName', e.target.value)}
                readOnly
              />
              <input
                value={psaForm.rrcLeaseId ?? ''}
                onChange={(e) => updatePSAField('rrcLeaseId', e.target.value)}
                readOnly
              />
            </div>

            <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50 rounded-b-xl">
              <button
                onClick={() => {
                  setBuyerEntity({
                    name: psaForm.buyerName ?? '',
                    address: psaForm.buyerAddress ?? '',
                    city: psaForm.buyerCity ?? '',
                    state: psaForm.buyerState ?? '',
                    zip: psaForm.buyerZip ?? '',
                  })
                  try {
                    window.localStorage.setItem(
                      BUYER_ENTITY_STORAGE_KEY,
                      JSON.stringify({
                        name: psaForm.buyerName ?? '',
                        address: psaForm.buyerAddress ?? '',
                        city: psaForm.buyerCity ?? '',
                        state: psaForm.buyerState ?? '',
                        zip: psaForm.buyerZip ?? '',
                      })
                    )
                  } catch {
                    // ignore
                  }
                }}
                className="text-xs font-medium text-amber-700 hover:text-amber-800"
              >
                Save buyer as default →
              </button>
              <div className="text-xs text-gray-400">Click any blue field to edit</div>
            </div>
          </div>
        </div>
      )}

      {showDeedModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
              <div className="text-lg font-semibold text-gray-900">Mineral Deed</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setShowDeedModal(false)
                    setShowFullPackageModal(false)
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    void generateDeed().then(() => {
                      setShowFullPackageModal(false)
                    })
                  }}
                  disabled={generatingDoc}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-60"
                >
                  {generatingDoc && (
                    <span
                      className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"
                      aria-hidden
                    />
                  )}
                  {generatingDoc ? 'Generating…' : 'Download Deed'}
                </button>
              </div>
            </div>

            <div
              className="overflow-y-auto"
              style={{
                maxHeight: '85vh',
                padding: '48px 64px',
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: 12,
                lineHeight: 1.8,
                color: '#111827',
              }}
            >
              <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 14, marginBottom: 24 }}>
                MINERAL DEED
              </div>

              <div style={{ marginBottom: 16 }}>
                <div>STATE OF TEXAS&nbsp;&nbsp;&nbsp;§</div>
                <div>&nbsp;&nbsp;&nbsp;§</div>
                <div>
                  COUNTY OF{' '}
                  <DocField
                    value={(deedForm.county ?? '').toUpperCase()}
                    onChange={(v) => updateDeedField('county', v)}
                    placeholder="COUNTY"
                    style={{ textTransform: 'uppercase' }}
                  />
                  &nbsp;&nbsp;&nbsp;§
                </div>
              </div>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                <DocField
                  value={deedForm.grantorName ?? ''}
                  onChange={(v) => updateDeedField('grantorName', v)}
                  placeholder="Grantor name"
                  minChars={22}
                  style={{ fontWeight: 700 }}
                />
                , whose address is{' '}
                <DocField
                  value={deedForm.grantorAddress ?? ''}
                  onChange={(v) => updateDeedField('grantorAddress', v)}
                  placeholder="Grantor address"
                  minChars={18}
                />
                ,{' '}
                <DocField
                  value={deedForm.grantorCity ?? ''}
                  onChange={(v) => updateDeedField('grantorCity', v)}
                  placeholder="City"
                />
                ,{' '}
                <DocField
                  value={deedForm.grantorState ?? ''}
                  onChange={(v) => updateDeedField('grantorState', v)}
                  placeholder="ST"
                  minChars={4}
                />{' '}
                <DocField
                  value={deedForm.grantorZip ?? ''}
                  onChange={(v) => updateDeedField('grantorZip', v)}
                  placeholder="Zip"
                  minChars={7}
                />{' '}
                (&ldquo;Grantor&rdquo;), for the sum of Ten Dollars ($10.00) and other good and valuable
                consideration, the receipt and sufficiency of which are hereby acknowledged, does hereby
                grant, bargain, sell, transfer, convey, assign and deliver all of Grantor&rsquo;s
                interest in and to the oil, gas, and minerals (the &ldquo;Mineral Interest&rdquo;) in and
                under and that may be produced from the lands as set forth and identified in
                &ldquo;Exhibit A,&rdquo; which is attached to and made a part of this Mineral Deed for
                all purposes (the &ldquo;Lands&rdquo;), to{' '}
                <DocField
                  value={deedForm.granteeName ?? ''}
                  onChange={(v) => updateDeedField('granteeName', v)}
                  placeholder="Grantee name"
                  minChars={22}
                  style={{ fontWeight: 700 }}
                />
                , whose address is{' '}
                <DocField
                  value={deedForm.granteeAddress ?? ''}
                  onChange={(v) => updateDeedField('granteeAddress', v)}
                  placeholder="Grantee address"
                  minChars={18}
                />
                ,{' '}
                <DocField
                  value={deedForm.granteeCity ?? ''}
                  onChange={(v) => updateDeedField('granteeCity', v)}
                  placeholder="City"
                />
                ,{' '}
                <DocField
                  value={deedForm.granteeState ?? ''}
                  onChange={(v) => updateDeedField('granteeState', v)}
                  placeholder="ST"
                  minChars={4}
                />{' '}
                <DocField
                  value={deedForm.granteeZip ?? ''}
                  onChange={(v) => updateDeedField('granteeZip', v)}
                  placeholder="Zip"
                  minChars={7}
                />{' '}
                (&ldquo;Grantee&rdquo;).
              </p>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                This Mineral Deed is effective for all purposes, including runs of oil and deliveries of
                gas and other hydrocarbons, as of{' '}
                <DocField
                  value={deedForm.effectiveDate ?? ''}
                  onChange={(v) => updateDeedField('effectiveDate', v)}
                  placeholder="Effective date"
                />{' '}
                (the &ldquo;Effective Date&rdquo;). Grantor also conveys to Grantee any and all revenues
                attributable to the Mineral Interest that are held in suspense, unremitted, or otherwise
                unpaid regardless of the Effective Date.
              </p>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                TO HAVE AND TO HOLD the above-described Lands and Mineral Interest, together with all and
                singular the rights and appurtenances thereto and anywise belonging, unto Grantee and
                Grantee&rsquo;s heirs, successors, and assigns forever; and Grantor, their heirs and
                successors warrant and agree to forever defend title to the Lands unto Grantee and
                Grantee&rsquo;s heirs, successors, and assigns against all claims of every person
                claiming or to claim the same or any part thereof.
              </p>

              <p style={{ textAlign: 'justify', marginBottom: 14 }}>
                <span style={{ fontWeight: 700 }}>IN WITNESS WHEREOF</span>, this Mineral Deed is
                executed on the date of acknowledgement, but shall be effective as of the Effective Date
                provided herein.
              </p>

              <div style={{ marginTop: 40 }}>
                <div style={{ fontWeight: 700 }}>GRANTOR:</div>
                <div style={{ fontWeight: 700, marginTop: 4 }}>
                  <DocField
                    value={deedForm.grantorName ?? ''}
                    onChange={(v) => updateDeedField('grantorName', v)}
                    placeholder="GRANTOR NAME"
                    minChars={24}
                    style={{ fontWeight: 700, textTransform: 'uppercase' }}
                  />
                </div>
                <div style={{ marginTop: 16 }}>___________________________</div>
                <div>Date: _______________________</div>
              </div>

              <div style={{ marginTop: 48 }}>
                <div style={{ textAlign: 'center', fontWeight: 700, marginBottom: 14 }}>EXHIBIT A</div>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  Attached and made a part of that Mineral Deed effective{' '}
                  <DocField
                    value={deedForm.effectiveDate ?? ''}
                    onChange={(v) => updateDeedField('effectiveDate', v)}
                    placeholder="Effective date"
                  />{' '}
                  between{' '}
                  <DocField
                    value={deedForm.grantorName ?? ''}
                    onChange={(v) => updateDeedField('grantorName', v)}
                    placeholder="Grantor"
                    minChars={18}
                  />{' '}
                  (&ldquo;Grantor&rdquo;), and{' '}
                  <DocField
                    value={deedForm.granteeName ?? ''}
                    onChange={(v) => updateDeedField('granteeName', v)}
                    placeholder="Grantee"
                    minChars={18}
                  />{' '}
                  (&ldquo;Grantee&rdquo;).
                </div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>LANDS:</div>
                <DocTextarea
                  value={deedForm.legalDescription ?? ''}
                  onChange={(v) => updateDeedField('legalDescription', v)}
                  placeholder="Legal description / Exhibit A lands"
                  rows={5}
                />
                <div style={{ textAlign: 'center', fontWeight: 700, marginTop: 14 }}>
                  END OF EXHIBIT A
                </div>
              </div>
            </div>

            <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50 rounded-b-xl">
              <button
                onClick={() => {
                  setBuyerEntity({
                    name: deedForm.granteeName ?? '',
                    address: deedForm.granteeAddress ?? '',
                    city: deedForm.granteeCity ?? '',
                    state: deedForm.granteeState ?? '',
                    zip: deedForm.granteeZip ?? '',
                  })
                  try {
                    window.localStorage.setItem(
                      BUYER_ENTITY_STORAGE_KEY,
                      JSON.stringify({
                        name: deedForm.granteeName ?? '',
                        address: deedForm.granteeAddress ?? '',
                        city: deedForm.granteeCity ?? '',
                        state: deedForm.granteeState ?? '',
                        zip: deedForm.granteeZip ?? '',
                      })
                    )
                  } catch {
                    // ignore
                  }
                }}
                className="text-xs font-medium text-amber-700 hover:text-amber-800"
              >
                Save grantee as default →
              </button>
              <div className="text-xs text-gray-400">Click any blue field to edit</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
