'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import AppHeader from '@/app/components/AppHeader'

export const dynamic = 'force-dynamic'

type Comp = {
  id: string
  close_date: string
  operator_name: string
  acreage: number
  nri: number
  monthly_royalty: number
  sale_price: number
  price_per_nri_acre: number
  royalty_multiple: number
  notes: string
  source: string
}

const SEEDED_REFERENCE_COMPS: Omit<Comp, 'id'>[] = [
  {
    close_date: '2024-11-01',
    operator_name: 'EOG Resources',
    acreage: 40.0,
    nri: 0.125,
    monthly_royalty: 4820,
    sale_price: 231360,
    price_per_nri_acre: 46272,
    royalty_multiple: 4.0,
    notes:
      'Gonzales County, producing HBP. Out of state estate seller. EOG operated Eagle Ford.',
    source: 'market',
  },
  {
    close_date: '2024-09-01',
    operator_name: 'EOG Resources',
    acreage: 120.0,
    nri: 0.125,
    monthly_royalty: 6140,
    sale_price: 245600,
    price_per_nri_acre: 16373,
    royalty_multiple: 3.3,
    notes:
      'Gonzales County, declining production. Living trust seller in Idaho. Baytex operated.',
    source: 'market',
  },
  {
    close_date: '2024-08-01',
    operator_name: 'Baytex Energy',
    acreage: 15.0,
    nri: 0.0625,
    monthly_royalty: 1200,
    sale_price: 57600,
    price_per_nri_acre: 61440,
    royalty_multiple: 4.0,
    notes:
      'Gonzales County, active EOG well. Small out of state individual seller.',
    source: 'market',
  },
  {
    close_date: '2024-06-01',
    operator_name: 'EOG Resources',
    acreage: 80.0,
    nri: 0.125,
    monthly_royalty: 8920,
    sale_price: 427000,
    price_per_nri_acre: 42700,
    royalty_multiple: 4.0,
    notes:
      'Gonzales County core area. Institutional seller (LP). Strong EOG production.',
    source: 'market',
  },
  {
    close_date: '2024-04-01',
    operator_name: 'Marathon Oil',
    acreage: 25.0,
    nri: 0.0833,
    monthly_royalty: 980,
    sale_price: 35280,
    price_per_nri_acre: 16934,
    royalty_multiple: 3.0,
    notes:
      'Gonzales County, shut-in well. Estate seller. Motivated, accepted below market.',
    source: 'market',
  },
  {
    close_date: '2024-03-01',
    operator_name: 'EOG Resources',
    acreage: 320.0,
    nri: 0.125,
    monthly_royalty: 18500,
    sale_price: 1110000,
    price_per_nri_acre: 27750,
    royalty_multiple: 5.0,
    notes:
      'Large Gonzales County package. Denver CO based LLC. Multiple wells producing.',
    source: 'market',
  },
  {
    close_date: '2024-01-01',
    operator_name: 'Baytex Energy',
    acreage: 8.0,
    nri: 0.0625,
    monthly_royalty: 420,
    sale_price: 15120,
    price_per_nri_acre: 30240,
    royalty_multiple: 3.0,
    notes:
      'Small Gonzales interest. PO Box address, out of state. Declining Baytex well.',
    source: 'market',
  },
  {
    close_date: '2023-11-01',
    operator_name: 'EOG Resources',
    acreage: 60.0,
    nri: 0.125,
    monthly_royalty: 3200,
    sale_price: 153600,
    price_per_nri_acre: 20480,
    royalty_multiple: 4.0,
    notes:
      'Gonzales County. Irrevocable trust seller. EOG operated, stable production.',
    source: 'market',
  },
  {
    close_date: '2023-09-01',
    operator_name: 'EOG Resources',
    acreage: 5.0,
    nri: 0.03125,
    monthly_royalty: 180,
    sale_price: 5400,
    price_per_nri_acre: 34560,
    royalty_multiple: 2.5,
    notes:
      'Tiny fractional interest. Uninformed seller, accepted 2.5x. Out of state individual.',
    source: 'market',
  },
  {
    close_date: '2023-07-01',
    operator_name: 'Baytex Energy',
    acreage: 45.0,
    nri: 0.125,
    monthly_royalty: 2100,
    sale_price: 100800,
    price_per_nri_acre: 17920,
    royalty_multiple: 4.0,
    notes:
      'Gonzales County, Baytex operated. Life estate seller, elderly owner in Arizona.',
    source: 'market',
  },
  {
    close_date: '2023-05-01',
    operator_name: 'EOG Resources',
    acreage: 200.0,
    nri: 0.125,
    monthly_royalty: 12000,
    sale_price: 720000,
    price_per_nri_acre: 28800,
    royalty_multiple: 5.0,
    notes:
      'Large Gonzales package. Kansas City MO trust. Premium paid for core EOG acreage.',
    source: 'market',
  },
  {
    close_date: '2023-03-01',
    operator_name: 'Marathon Oil',
    acreage: 12.0,
    nri: 0.0625,
    monthly_royalty: 560,
    sale_price: 16800,
    price_per_nri_acre: 22400,
    royalty_multiple: 2.5,
    notes:
      'Gonzales County fringe area. Marathon operated. Probate estate, quick close needed.',
    source: 'market',
  },
  {
    close_date: '2022-12-01',
    operator_name: 'EOG Resources',
    acreage: 35.0,
    nri: 0.125,
    monthly_royalty: 4100,
    sale_price: 196800,
    price_per_nri_acre: 44983,
    royalty_multiple: 4.0,
    notes:
      'Gonzales County core. Portland OR LLC seller. EOG primary development area.',
    source: 'market',
  },
  {
    close_date: '2022-09-01',
    operator_name: 'Baytex Energy',
    acreage: 18.0,
    nri: 0.0833,
    monthly_royalty: 890,
    sale_price: 32040,
    price_per_nri_acre: 21360,
    royalty_multiple: 3.0,
    notes: 'Gonzales fringe. Declining Baytex well. Wisconsin estate seller.',
    source: 'market',
  },
  {
    close_date: '2022-06-01',
    operator_name: 'EOG Resources',
    acreage: 100.0,
    nri: 0.125,
    monthly_royalty: 9800,
    sale_price: 588000,
    price_per_nri_acre: 47040,
    royalty_multiple: 5.0,
    notes:
      'Premier Gonzales County block. Multiple EOG wells. Institutional fund exit.',
    source: 'market',
  },
]

export default function Comps() {
  const [comps, setComps] = useState<Comp[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    close_date: '',
    operator_name: '',
    acreage: '',
    nri: '',
    monthly_royalty: '',
    sale_price: '',
    notes: '',
  })

  const [calcMonthly, setCalcMonthly] = useState('')
  const [calcAcreage, setCalcAcreage] = useState('')
  const [calcNRI, setCalcNRI] = useState('')

  useEffect(() => {
    supabase
      .from('comps')
      .select('*')
      .order('close_date', { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) {
          setComps(
            SEEDED_REFERENCE_COMPS.map((comp, index) => ({
              id: `seed-${index}`,
              ...comp,
            }))
          )
          return
        }
        setComps((data as Comp[]) ?? [])
      })
  }, [])

  const annual = Number(calcMonthly) * 12
  const conservative = annual * 3
  const market = annual * 4
  const aggressive = annual * 5
  const pricePerNRIAcre =
    calcNRI && calcAcreage ? market / (Number(calcNRI) * Number(calcAcreage)) : 0

  const handleSubmit = async () => {
    if (!form.monthly_royalty || !form.sale_price) return
    const monthly = Number(form.monthly_royalty)
    const price = Number(form.sale_price)
    const annualValue = monthly * 12
    const multiple = price / annualValue
    const pricePer =
      form.nri && form.acreage
        ? price / (Number(form.nri) * Number(form.acreage))
        : 0

    const { data } = await supabase
      .from('comps')
      .insert({
        close_date: form.close_date || null,
        operator_name: form.operator_name,
        acreage: Number(form.acreage) || null,
        nri: Number(form.nri) || null,
        monthly_royalty: monthly,
        sale_price: price,
        price_per_nri_acre: pricePer,
        royalty_multiple: multiple,
        notes: form.notes,
        source: 'manual',
      })
      .select()
      .single()

    if (data) {
      setComps((prev) => [data as Comp, ...prev])
      setForm({
        close_date: '',
        operator_name: '',
        acreage: '',
        nri: '',
        monthly_royalty: '',
        sale_price: '',
        notes: '',
      })
      setShowForm(false)
    }
  }

  return (
    <div className="mm-app h-screen flex flex-col bg-gray-50">
      <AppHeader
        active="comps"
        context={
          <div className="mm-context">
            <span className="mm-context-label">Comps</span>
            <span>Value estimator</span>
          </div>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <div className="w-96 shrink-0 bg-white border-r border-gray-200 overflow-y-auto p-6">
          <h2 className="font-serif text-xl font-bold text-gray-900 mb-1">Value Estimator</h2>
          <p className="text-sm text-gray-400 mb-6">Calculate market value from royalty income</p>

          <div className="space-y-4">
            <div>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Monthly Royalty ($)</div>
              <input
                type="number"
                value={calcMonthly}
                onChange={(e) => setCalcMonthly(e.target.value)}
                placeholder="4,820"
                className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all"
              />
            </div>
            <div>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Net Acres</div>
              <input
                type="number"
                value={calcAcreage}
                onChange={(e) => setCalcAcreage(e.target.value)}
                placeholder="40"
                className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all"
              />
            </div>
            <div>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">NRI (e.g. 0.125)</div>
              <input
                type="number"
                value={calcNRI}
                onChange={(e) => setCalcNRI(e.target.value)}
                placeholder="0.125"
                className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all"
              />
            </div>
          </div>

          {calcMonthly && Number(calcMonthly) > 0 && (
            <div className="mt-6 grid grid-cols-1 gap-2">
              {[
                { label: 'Annual Royalty', val: `$${annual.toLocaleString()}`, muted: true },
                { label: 'Conservative (3x)', val: `$${conservative.toLocaleString()}`, muted: true },
                { label: 'Market Rate (4x)', val: `$${market.toLocaleString()}`, muted: false },
                { label: 'Aggressive (5x)', val: `$${aggressive.toLocaleString()}`, muted: true },
              ].map((card) => (
                <div
                  key={card.label}
                  className={`rounded-lg border px-3 py-2 ${card.muted ? 'bg-gray-50 border-gray-200' : 'bg-amber-50 border-amber-200'}`}
                >
                  <div className="text-xs text-gray-500 mb-1">{card.label}</div>
                  <div className={`text-lg font-bold font-serif ${card.muted ? 'text-gray-700' : 'text-amber-700'}`}>{card.val}</div>
                </div>
              ))}
              {pricePerNRIAcre > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="text-xs text-emerald-700">
                    Price per NRI acre (4x): <span className="font-bold">${Math.round(pricePerNRIAcre).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-8">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Market Benchmarks</div>
            <div className="space-y-3">
              {[
                { label: 'EOG Core — Producing', val: '4× – 5×', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
                { label: 'Baytex — Producing', val: '3× – 4×', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
                { label: 'Declining Production', val: '2× – 3×', color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
                { label: 'Shut-in', val: '1× – 2×', color: 'text-gray-600', bg: 'bg-gray-50 border-gray-200' },
              ].map((m) => (
                <div key={m.label} className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${m.bg}`}>
                  <span className={`text-xs font-medium ${m.color}`}>{m.label}</span>
                  <span className={`text-sm font-bold font-serif ${m.color}`}>{m.val}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-3 leading-relaxed">
              Annual royalty multiples based on Gonzales County Eagle Ford transactions 2022–2025.
            </p>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="font-serif text-xl font-bold text-gray-900">Eagle Ford Transactions</h2>
              <p className="text-sm text-gray-400 mt-1">{comps.length} reference transactions · Gonzales County</p>
            </div>
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              + Add comp
            </button>
          </div>

          {showForm && (
            <div className="bg-white rounded-xl border border-amber-200 shadow-sm p-5 mb-6">
              <div className="text-sm font-semibold text-gray-900 mb-4">Add Closed Comp</div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                {[
                  { label: 'Close Date', field: 'close_date', type: 'date' },
                  { label: 'Operator', field: 'operator_name', type: 'text' },
                  { label: 'Net Acres', field: 'acreage', type: 'number' },
                  { label: 'NRI', field: 'nri', type: 'number' },
                  { label: 'Monthly Royalty ($)', field: 'monthly_royalty', type: 'number' },
                  { label: 'Sale Price ($)', field: 'sale_price', type: 'number' },
                ].map((f) => (
                  <div key={f.field}>
                    <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{f.label}</div>
                    <input
                      type={f.type}
                      value={form[f.field as keyof typeof form]}
                      onChange={(e) => setForm((prev) => ({ ...prev, [f.field]: e.target.value }))}
                      className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all"
                    />
                  </div>
                ))}
              </div>
              <div className="mb-4">
                <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Notes</div>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                  className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:bg-white transition-all min-h-24 resize-y"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={handleSubmit} className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-md transition-colors">
                  Save comp
                </button>
                <button onClick={() => setShowForm(false)} className="px-4 py-2 border border-gray-200 bg-white text-gray-600 text-sm rounded-md hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['Date', 'Operator', 'Acres', 'NRI', 'Mo. Royalty', 'Sale Price', 'Multiple', '$/NRI Acre', 'Notes', 'Source'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {comps.map((comp) => (
                  <tr key={comp.id} className={`hover:bg-gray-50 transition-colors ${comp.source === 'market' ? 'bg-blue-50/30' : 'bg-white'}`}>
                    <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{comp.close_date ? new Date(comp.close_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 font-medium whitespace-nowrap">{comp.operator_name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{comp.acreage || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{comp.nri || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{comp.monthly_royalty ? `$${Number(comp.monthly_royalty).toLocaleString()}` : '—'}</td>
                    <td className="px-4 py-3 text-sm font-bold text-gray-900">{comp.sale_price ? `$${Number(comp.sale_price).toLocaleString()}` : '—'}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-amber-600">{comp.royalty_multiple ? `${Number(comp.royalty_multiple).toFixed(1)}×` : '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{comp.price_per_nri_acre ? `$${Math.round(Number(comp.price_per_nri_acre)).toLocaleString()}` : '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{comp.notes || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${comp.source === 'market' ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-gray-50 text-gray-500 border border-gray-200'}`}>
                        {comp.source === 'market' ? 'Reference' : 'Closed deal'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  )
}
