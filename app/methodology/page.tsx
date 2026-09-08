'use client'

import { useState } from 'react'
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import AppHeader from '@/app/components/AppHeader'

type SignalCard = {
  name: string
  points: number
  what: string
  why: string
  angle: string
}

const SIGNALS: SignalCard[] = [
  {
    name: 'Out of State Address',
    points: 3,
    what: 'Mailing address is outside Texas.',
    why: 'Remote owners typically have less land attachment and higher admin friction for small mineral checks.',
    angle: 'Lead with remote close simplicity and certainty of funds.',
  },
  {
    name: 'Estate / Probate',
    points: 4,
    what: 'Owner record includes Estate / probate indicators.',
    why: 'Probate complexity and distributed heirs often increase motivation for a clean liquidation event.',
    angle: 'Position as a clean resolution path for executors and heirs.',
  },
  {
    name: 'Life Estate',
    points: 4,
    what: 'Owner record indicates life-estate structure.',
    why: 'Lifecycle-driven planning tends to favor immediate liquidity and reduced complexity.',
    angle: 'Emphasize certainty, timing, and reduced family admin burden.',
  },
  {
    name: 'Irrevocable Trust',
    points: 3,
    what: 'Trust ownership with irrevocable language.',
    why: 'Trustees often prefer lower-friction assets and clean fiduciary accounting.',
    angle: 'Frame as prudent trust administration and simplification.',
  },
  {
    name: 'Small Acreage Interest',
    points: 2,
    what: 'Low net acreage and fragmented ownership.',
    why: 'Small positions can be operationally noisy relative to monthly cash flow.',
    angle: 'Anchor on lump-sum conversion of low monthly value.',
  },
  {
    name: 'Steep Production Decline',
    points: 3,
    what: 'Decline curve indicates shrinking cash flow trajectory.',
    why: 'Owners are more willing to monetize before further decline.',
    angle: 'Present timing/decay tradeoff with clear valuation logic.',
  },
]

const SCORE_DATA = [
  { score: '10', count: 657, hot: true },
  { score: '9', count: 1190, hot: true },
  { score: '8', count: 2103, hot: true },
  { score: '7', count: 7232, warm: true },
  { score: '6', count: 2542, warm: true },
  { score: '5', count: 9273 },
  { score: '4', count: 26362 },
  { score: '3', count: 6936 },
  { score: '2', count: 6638 },
  { score: '1', count: 6465 },
  { score: '0', count: 4191 },
]

const FAQS = [
  {
    q: 'Is this score a guarantee of conversion?',
    a: 'No. It is a prioritization signal, not a certainty metric. It should be paired with title validation and outreach quality.',
  },
  {
    q: 'Can owners on the same tract have different scores?',
    a: 'Yes. Tract context is shared, but ownership structures and address/legal signals vary at the owner level.',
  },
  {
    q: 'How frequently is this refreshed?',
    a: 'Whenever source datasets and enrichment jobs are refreshed for Gonzales County.',
  },
  {
    q: 'Why do some producing tracts still score high?',
    a: 'Legal complexity, remote ownership, and fractional interests can outweigh current production strength.',
  },
  {
    q: 'What is a Net Mineral Acre (NMA)?',
    a: "A Net Mineral Acre represents your actual ownership stake in the minerals under a tract. It is calculated by multiplying the gross tract acreage by your decimal interest. For example, if a tract covers 640 gross acres and you own a 0.125 decimal interest, you own 80 Net Mineral Acres. A landowner with 12,800 gross acres but a 0.000001 decimal interest owns only 0.0128 NMA - a tiny fraction worth very little. Mineral Map displays NMA rather than gross acres because it more accurately reflects the economic size of an owner's interest and their motivation to sell.",
  },
]

export default function MethodologyPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0)

  return (
    <div className="mm-app h-screen flex flex-col bg-gray-50">
      <AppHeader
        active="methodology"
        context={
          <div className="mm-context">
            <span className="mm-context-label">Docs</span>
            <span>Methodology</span>
          </div>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 bg-white border-r border-gray-200 overflow-y-auto p-4">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Contents</div>
          <nav className="space-y-1">
            {['Propensity Score', 'Score Distribution', 'Signal Reference', 'Map Layers', 'Data Accuracy'].map((section) => (
              <a
                key={section}
                href={`#${section.toLowerCase().replace(/ /g, '-')}`}
                className="block px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors"
              >
                {section}
              </a>
            ))}
            <a href="#faq" className="block px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors">
              FAQ & Glossary
            </a>
          </nav>
        </aside>

        <main className="flex-1 overflow-y-auto bg-gray-50 p-8">
          <section className="mb-8">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Mineral Map Intelligence</div>
            <h1 className="font-serif text-4xl font-bold text-gray-900 mb-3">How We Score Mineral Rights Owners</h1>
            <p className="text-sm text-gray-600 leading-relaxed max-w-4xl">
              Mineral Map assigns each owner a 0–10 propensity score to prioritize acquisition outreach.
              Scores combine legal structure, geography, production profile, and ownership characteristics.
              This page documents signal logic and how to interpret map behavior in workflow.
            </p>
          </section>

          <section id="propensity-score" className="mb-8">
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Propensity Score</div>
              <p className="text-sm text-gray-600 leading-relaxed mb-4">
                Owners with score 5+ are marked motivated. High confidence “hot” leads are 8–10.
              </p>
              <div className="h-2 rounded-full bg-gradient-to-r from-green-500 via-yellow-400 to-red-500 relative">
                <div className="absolute left-1/2 top-[-4px] h-4 w-0.5 bg-gray-900" />
              </div>
              <div className="mt-2 flex justify-between text-xs text-gray-400">
                <span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
              </div>
            </div>
          </section>

          <section id="score-distribution" className="mb-8">
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Score Distribution</div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={SCORE_DATA}>
                    <XAxis dataKey="score" tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} width={44} />
                    <Bar dataKey="count" fill="#F59E0B" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                {[
                  { val: '3,950', lbl: 'Hot leads (score 8-10)', color: 'text-red-700', bg: 'bg-red-50' },
                  { val: '19,047', lbl: 'Motivated (score 5-7)', color: 'text-amber-700', bg: 'bg-amber-50' },
                  { val: '46,401', lbl: 'Prospect (score 2-4)', color: 'text-green-700', bg: 'bg-green-50' },
                ].map((card) => (
                  <div key={card.lbl} className={`${card.bg} border border-gray-200 rounded-lg p-3`}>
                    <div className={`text-xs mb-1 ${card.color}`}>{card.lbl}</div>
                    <div className={`font-serif text-xl font-bold ${card.color}`}>{card.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="signal-reference" className="mb-8">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Signal Reference</div>
            {SIGNALS.map((signal) => (
              <div key={signal.name} className="bg-white border border-gray-200 border-l-4 border-l-amber-400 rounded-xl p-6 mb-4 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-serif text-lg font-bold text-gray-900">{signal.name}</h3>
                  <span className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-0.5 text-xs font-semibold">
                    +{signal.points} {signal.points === 1 ? 'point' : 'points'}
                  </span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {[
                    { label: 'WHAT IT MEANS', text: signal.what },
                    { label: 'WHY IT PREDICTS MOTIVATION', text: signal.why },
                    { label: 'OUTREACH ANGLE', text: signal.angle },
                  ].map((col) => (
                    <div key={col.label}>
                      <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{col.label}</div>
                      <p className="text-sm text-gray-600 leading-relaxed">{col.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section id="map-layers" className="mb-8">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Map Layers</div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {[
                {
                  title: 'Parcel Layer',
                  text: 'Color intensity reflects owner score concentration and helps rank outreach zones quickly.',
                },
                {
                  title: 'Well Status Layers',
                  text: 'Active, shut-in, and unknown wells reveal production context and urgency.',
                },
                {
                  title: 'Permits',
                  text: 'Permit activity can change owner economics and increase response likelihood.',
                },
              ].map((item) => (
                <div key={item.title} className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
                  <h3 className="font-serif text-lg font-bold text-gray-900 mb-2">{item.title}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{item.text}</p>
                </div>
              ))}
            </div>
          </section>

          <div id="data-accuracy" className="mb-8">
            <h2 className="font-serif text-2xl font-bold text-gray-900 mb-2">Data Accuracy</h2>
            <p className="text-sm text-gray-500 mb-6">Not all data fields carry the same confidence level. Here is what to trust and what to treat as an estimate.</p>

            <div className="space-y-3">
              {[
                {
                  label: 'Owner names & mailing addresses',
                  confidence: 'High',
                  color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
                  desc: 'Sourced directly from the county appraisal district mineral roll - the same official record operators use for division orders. Updated annually.'
                },
                {
                  label: 'Decimal interest (division order)',
                  confidence: 'High',
                  color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
                  desc: 'From the appraisal district interest field. Matches what operators have on file for royalty payments. Expressed as a 6-decimal fraction.'
                },
                {
                  label: 'Well locations & operator names',
                  confidence: 'High',
                  color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
                  desc: 'Texas RRC GPS coordinates and operator assignments. Updated monthly. Very reliable for active wells.'
                },
                {
                  label: 'Production history',
                  confidence: 'High',
                  color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
                  desc: 'RRC-reported production data. Accurate but reported with a 2-3 month lag. Cumulative figures are reliable; recent months may be incomplete.'
                },
                {
                  label: 'Propensity scores',
                  confidence: 'Estimate',
                  color: 'text-amber-700 bg-amber-50 border-amber-200',
                  desc: 'Based on signals correlated with seller motivation - not a guarantee of willingness to sell. A score of 9 means multiple strong signals are present. Use scores to prioritize outreach, not to predict outcomes.'
                },
                {
                  label: 'Est. lease expiration',
                  confidence: 'Approximate',
                  color: 'text-orange-700 bg-orange-50 border-orange-200',
                  desc: 'Estimated as first production date + 5 years. Most active Eagle Ford leases are HBP (Held by Production) and do not expire while producing. Use as a flag, not a definitive date.'
                },
              ].map((item) => (
                <div key={item.label} className="flex items-start gap-4 bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="font-serif text-sm font-bold text-gray-900">{item.label}</span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${item.color}`}>
                        {item.confidence}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <section id="faq">
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">FAQ & Glossary</div>
              {FAQS.map((faq, i) => (
                <div key={faq.q} className="border-b border-gray-200 py-4 last:border-b-0">
                  <button
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    className="w-full flex items-center justify-between text-left"
                  >
                    <span className="font-serif text-base font-bold text-gray-900">{faq.q}</span>
                    <span className="text-amber-500 text-xl font-light ml-4 shrink-0">{openFaq === i ? '−' : '+'}</span>
                  </button>
                  {openFaq === i && (
                    <p className="mt-3 text-sm text-gray-600 leading-relaxed pr-8">{faq.a}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
