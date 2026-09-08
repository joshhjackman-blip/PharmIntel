'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, Minus, Users } from 'lucide-react'

import AppLogo from '@/app/components/AppLogo'
import './pricing.css'

type TierKey = 'solo' | 'team' | 'enterprise'

type Tier = {
  key: TierKey
  name: string
  price: string
  period: string
  description: string
  seats: string
  features: string[]
  inheritsFrom?: string
  cta: string
  priceId: string | null | undefined
  highlighted: boolean
}

const tiers: Tier[] = [
  {
    key: 'solo',
    name: 'Solo',
    price: '$299',
    period: '/mo',
    description: 'For individual landmen and acquisition professionals.',
    seats: '1 seat',
    features: [
      '207 survey abstracts in Gonzales County',
      '73,000+ scored mineral owners',
      'Propensity scoring across 12 signals',
      'Built-in CRM and pipeline',
      '200 skip traces per month',
      'CSV export',
      'Comp calculator',
    ],
    cta: 'Start free trial',
    priceId: process.env.NEXT_PUBLIC_STRIPE_PRICE_ID,
    highlighted: false,
  },
  {
    key: 'team',
    name: 'Team',
    price: '$499',
    period: '/mo',
    description: 'For acquisition teams and small funds that work one pipeline together.',
    seats: 'Up to 3 seats',
    inheritsFrom: 'Everything in Solo',
    features: [
      'Up to 3 user logins',
      'Shared CRM pipeline',
      'Shared skip trace pool of 600 per month',
      'Priority access to new counties',
    ],
    cta: 'Start free trial',
    priceId: process.env.NEXT_PUBLIC_STRIPE_TEAM_PRICE_ID,
    highlighted: true,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For larger operations and multi-county coverage.',
    seats: '5+ seats',
    inheritsFrom: 'Everything in Team',
    features: [
      'Unlimited seats',
      'Multi-county access',
      'Dedicated onboarding',
      'Custom data requests',
      'Priority support',
    ],
    cta: 'Contact sales',
    priceId: null,
    highlighted: false,
  },
]

type CompareCell = boolean | string

type CompareRow = {
  label: string
  values: [CompareCell, CompareCell, CompareCell]
}

type CompareGroup = {
  group: string
  rows: CompareRow[]
}

const COMPARE: CompareGroup[] = [
  {
    group: 'Data',
    rows: [
      { label: 'Survey abstracts', values: ['207 (Gonzales County)', '207 (Gonzales County)', 'Multi-county'] },
      { label: 'Scored mineral owners', values: ['73,000+', '73,000+', '73,000+'] },
      { label: 'Propensity scoring', values: ['12 signals', '12 signals', '12 signals'] },
      { label: 'New county access', values: [false, 'Priority', 'Included'] },
      { label: 'Custom data requests', values: [false, false, true] },
    ],
  },
  {
    group: 'Workflow',
    rows: [
      { label: 'CRM and pipeline', values: ['Built in', 'Shared', 'Shared'] },
      { label: 'Skip traces per month', values: ['200', '600 shared pool', 'Custom'] },
      { label: 'CSV export', values: [true, true, true] },
      { label: 'Comp calculator', values: [true, true, true] },
    ],
  },
  {
    group: 'Team',
    rows: [
      { label: 'Seats', values: ['1', 'Up to 3', 'Unlimited'] },
      { label: 'Dedicated onboarding', values: [false, false, true] },
      { label: 'Priority support', values: [false, false, true] },
    ],
  },
]

const CONTACT_EMAIL = 'josh@brentwoodenterprisesllc.com'

function CompareValue({ value }: { value: CompareCell }): ReactNode {
  if (value === true) {
    return (
      <span className="pr-yes" aria-label="Included">
        <Check size={13} strokeWidth={2.75} />
      </span>
    )
  }
  if (value === false) {
    return (
      <span className="pr-no" aria-label="Not included">
        <Minus size={13} strokeWidth={2.5} />
      </span>
    )
  }
  return <span>{value}</span>
}

export default function Pricing() {
  const [loadingTier, setLoadingTier] = useState<TierKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleCheckout = async (tier: Tier) => {
    setError(null)
    if (!tier.priceId) {
      setError('Checkout is not configured for this plan yet. Contact us and we will set you up directly.')
      return
    }
    setLoadingTier(tier.key)
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId: tier.priceId }),
      })
      const data = (await res.json()) as { url?: string; error?: string }
      if (data.url) {
        window.location.href = data.url
        return
      }
      if (res.status === 401) {
        window.location.href = '/auth'
        return
      }
      setLoadingTier(null)
      setError(data.error ?? 'Unable to start checkout. Please try again.')
    } catch {
      setLoadingTier(null)
      setError('Unable to start checkout. Please try again.')
    }
  }

  return (
    <div className="mm-night">
      <div className="mm-night-grid" aria-hidden="true" />
      <div
        className="mm-night-glow"
        aria-hidden="true"
        style={{ top: -120, left: '50%', transform: 'translateX(-50%)', width: 720, height: 360, background: 'rgba(239,159,39,0.16)' }}
      />

      <nav className="mm-night-nav" aria-label="Site">
        <Link href="/landing" style={{ display: 'flex', alignItems: 'center' }} aria-label="Mineral Map">
          <AppLogo width={150} variant="light" />
        </Link>
        <div className="mm-night-nav-links">
          <Link href="/landing" className="mm-night-link">Overview</Link>
          <Link href="/pricing" className="mm-night-link" data-active="true">Pricing</Link>
          <Link href="/auth" className="mm-night-btn mm-night-btn-ghost mm-night-btn-sm" style={{ marginLeft: 8 }}>
            Sign in
          </Link>
        </div>
      </nav>

      <header className="pr-hero">
        <div className="mm-enter">
          <span className="mm-night-kicker">Pricing</span>
          <h1 className="mm-night-display">
            Simple pricing.
            <br />
            <em>No contracts.</em>
          </h1>
          <p className="mm-night-lede" style={{ maxWidth: 520 }}>
            Start with Solo, move to Team when you need a shared pipeline, or talk to us about
            Enterprise coverage. Solo and Team start with a free trial, and there are no contracts.
          </p>
        </div>
        <div className="pr-hero-aside mm-enter" style={{ animationDelay: '120ms' }}>
          <div className="pr-hero-stat">
            <strong>73,000+</strong>
            <span>Scored mineral owners</span>
          </div>
          <div className="pr-hero-stat">
            <strong>207</strong>
            <span>Survey abstracts mapped</span>
          </div>
          <div className="pr-hero-stat">
            <strong>12</strong>
            <span>Propensity signals per owner</span>
          </div>
        </div>
      </header>

      {error && (
        <div className="pr-error">
          <div className="mm-night-alert" data-tone="error" role="alert" style={{ marginBottom: 16 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        </div>
      )}

      <section className="pr-plans" aria-label="Plans">
        {tiers.map((tier) => {
          const isEnterprise = tier.key === 'enterprise'
          const isLoading = loadingTier === tier.key
          return (
            <article key={tier.key} className="mm-night-card pr-plan" data-featured={tier.highlighted}>
              {tier.highlighted && <div className="pr-plan-ribbon">Most popular</div>}
              <div className="pr-plan-head">
                <span className="pr-plan-name">{tier.name}</span>
                <span className="pr-plan-seats">
                  <Users size={12} strokeWidth={2.25} />
                  {tier.seats}
                </span>
              </div>
              <div className="pr-plan-price">
                <strong>{tier.price}</strong>
                {tier.period && <span>{tier.period}</span>}
              </div>
              <p className="pr-plan-desc">{tier.description}</p>

              <div className="pr-plan-cta">
                {isEnterprise ? (
                  <a
                    href={`mailto:${CONTACT_EMAIL}?subject=Mineral%20Map%20Enterprise`}
                    className="mm-night-btn mm-night-btn-outline-amber mm-night-btn-block"
                  >
                    {tier.cta}
                    <ArrowRight size={15} strokeWidth={2.25} />
                  </a>
                ) : (
                  <button
                    type="button"
                    className={`mm-night-btn mm-night-btn-block ${tier.highlighted ? 'mm-night-btn-brand' : 'mm-night-btn-white'}`}
                    disabled={isLoading}
                    onClick={() => {
                      void handleCheckout(tier)
                    }}
                  >
                    {isLoading ? (
                      <>
                        <span className="mm-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'currentColor' }} />
                        Redirecting to checkout
                      </>
                    ) : (
                      <>
                        {tier.cta}
                        <ArrowRight size={15} strokeWidth={2.25} />
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="pr-plan-divider" />
              <ul className="pr-plan-features">
                {tier.inheritsFrom && (
                  <li data-inherit="true">
                    <Check size={14} strokeWidth={2.5} />
                    {tier.inheritsFrom}
                  </li>
                )}
                {tier.features.map((feature) => (
                  <li key={`${tier.key}-${feature}`}>
                    <Check size={14} strokeWidth={2.5} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          )
        })}
      </section>

      <section className="pr-section" aria-labelledby="compare-heading">
        <div className="pr-section-head">
          <div>
            <span className="mm-night-kicker">Compare</span>
            <h2 id="compare-heading" className="mm-night-display">What each plan includes</h2>
          </div>
          <p>The same scored owner data on every plan. Team and Enterprise add shared workflow, more skip traces, and broader coverage.</p>
        </div>

        <div className="pr-compare mm-enter" style={{ animationDelay: '80ms' }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                {tiers.map((tier) => (
                  <th key={tier.key} scope="col" data-featured={tier.highlighted}>
                    {tier.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((group) => (
                <FragmentGroup key={group.group} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pr-contact" aria-label="Contact">
        <div className="pr-contact-card mm-enter" style={{ animationDelay: '120ms' }}>
          <div>
            <h3>Questions about coverage or seats?</h3>
            <p>
              Tell us which counties you work and how many people need access. We will recommend a plan
              or put together a custom quote.
            </p>
          </div>
          <a href={`mailto:${CONTACT_EMAIL}`} className="mm-night-btn mm-night-btn-white mm-night-btn-lg">
            Email us
            <ArrowRight size={15} strokeWidth={2.25} />
          </a>
        </div>
      </section>

      <footer className="mm-night-foot">
        <span>Mineral Map. Eagle Ford Basin.</span>
        <div style={{ display: 'flex', gap: 20 }}>
          <Link href="/landing">Overview</Link>
          <Link href="/auth">Sign in</Link>
          <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
        </div>
      </footer>
    </div>
  )
}

function FragmentGroup({ group }: { group: CompareGroup }) {
  return (
    <>
      <tr className="pr-compare-group">
        <td colSpan={4}>{group.group}</td>
      </tr>
      {group.rows.map((row) => (
        <tr key={row.label}>
          <td>{row.label}</td>
          {row.values.map((value, index) => (
            <td key={`${row.label}-${index}`}>
              <CompareValue value={value} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
