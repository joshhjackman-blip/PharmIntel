'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'

import { supabase } from '@/lib/supabase'
import AppLogo from '@/app/components/AppLogo'
import './signin.css'

const TIER_COLORS = {
  hot: '#F44336',
  motivated: '#FF9800',
  prospect: '#FFC107',
  low: '#4CAF50',
} as const

type Tier = keyof typeof TIER_COLORS

type Tract = {
  points: string
  tier: Tier
  selected?: boolean
}

// Stylized survey grid: irregular abstracts colored by propensity tier, the
// same palette the live map uses.
const TRACTS: Tract[] = [
  { points: '20,20 150,16 158,110 26,118', tier: 'low' },
  { points: '150,16 300,22 296,104 158,110', tier: 'prospect' },
  { points: '300,22 430,18 438,96 296,104', tier: 'motivated' },
  { points: '430,18 580,26 574,108 438,96', tier: 'low' },
  { points: '26,118 158,110 166,214 32,222', tier: 'prospect' },
  { points: '158,110 296,104 302,206 166,214', tier: 'hot', selected: true },
  { points: '296,104 438,96 444,200 302,206', tier: 'motivated' },
  { points: '438,96 574,108 568,212 444,200', tier: 'prospect' },
  { points: '32,222 166,214 160,318 24,326', tier: 'low' },
  { points: '166,214 302,206 310,312 160,318', tier: 'motivated' },
  { points: '302,206 444,200 450,306 310,312', tier: 'hot' },
  { points: '444,200 568,212 578,316 450,306', tier: 'low' },
]

const WELLS: Array<[number, number]> = [
  [96, 70], [230, 62], [372, 58], [500, 66],
  [104, 168], [226, 160], [372, 154], [506, 156],
  [92, 270], [238, 262], [376, 256], [512, 262],
]

function SurveyMap() {
  return (
    <svg viewBox="0 0 600 340" role="img" aria-label="Survey abstracts colored by acquisition opportunity">
      <defs>
        <pattern id="si-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.6" />
        </pattern>
      </defs>
      <rect width="600" height="340" fill="url(#si-grid)" />
      {TRACTS.map((tract, index) => {
        const color = TIER_COLORS[tract.tier]
        return (
          <polygon
            key={tract.points}
            className="si-map-tract"
            points={tract.points}
            fill={color}
            fillOpacity={tract.selected ? 0.34 : 0.13}
            stroke={tract.selected ? '#EF9F27' : color}
            strokeOpacity={tract.selected ? 1 : 0.45}
            strokeWidth={tract.selected ? 2 : 0.8}
            style={{ animationDelay: `${180 + index * 45}ms` }}
          />
        )
      })}
      {/* Horizontal laterals */}
      <path d="M 182 128 L 288 196" stroke="rgba(240,236,228,0.55)" strokeWidth="1.2" strokeDasharray="4 3" fill="none" />
      <path d="M 318 224 L 436 292" stroke="rgba(240,236,228,0.35)" strokeWidth="1" strokeDasharray="4 3" fill="none" />
      {WELLS.map(([x, y], index) => (
        <g key={`${x}-${y}`} className="si-map-pin" style={{ animationDelay: `${700 + index * 30}ms` }}>
          <circle cx={x} cy={y} r="2.6" fill="#f0ece4" />
          <circle cx={x} cy={y} r="5.5" fill="none" stroke="rgba(240,236,228,0.35)" strokeWidth="0.8" />
        </g>
      ))}
      {/* Selected tract marker */}
      <g className="si-map-pin">
        <line x1="230" y1="132" x2="230" y2="160" stroke="#EF9F27" strokeWidth="1.2" />
        <circle cx="230" cy="160" r="3" fill="#EF9F27" />
        <circle cx="230" cy="160" r="8" fill="none" stroke="#EF9F27" strokeOpacity="0.4" strokeWidth="1" />
      </g>
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

type Mode = 'login' | 'signup'

function SignInForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<Mode>('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [inviteOwnerId, setInviteOwnerId] = useState<string | null>(null)
  const [isInvite, setIsInvite] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const inviteOwnerParam = params.get('invite')
    const inviteEmail = params.get('email')
    if (inviteOwnerParam && inviteEmail) {
      setEmail(decodeURIComponent(inviteEmail))
      setInviteOwnerId(inviteOwnerParam)
      setIsInvite(true)
      setMode('signup')
      setMessage('You were invited to join a team account. Sign in or create your account to accept.')
    }
  }, [])

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setMessage(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (!email || !password) {
      setError('Please enter your email and password.')
      return
    }

    setLoading(true)

    const authResponse =
      mode === 'signup'
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password })

    const { data, error: authError } = authResponse

    if (authError) {
      console.error('Auth error:', authError.message, authError.status)
      setError(authError.message)
      setLoading(false)
      return
    }

    if (inviteOwnerId && data.session) {
      const acceptRes = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: inviteOwnerId }),
      })
      if (!acceptRes.ok) {
        const acceptData = (await acceptRes.json().catch(() => ({}))) as { error?: string }
        setError(acceptData.error ?? 'Failed to accept invite')
        setLoading(false)
        return
      }
    }

    if (mode === 'signup' && !data.session) {
      setMessage('Check your email to confirm your account, then sign in to continue.')
      setLoading(false)
      return
    }

    window.location.href = '/'
  }

  const isLogin = mode === 'login'

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="mm-night-segment" data-index={isLogin ? '0' : '1'} role="tablist" aria-label="Authentication mode">
        <span className="mm-night-segment-thumb" aria-hidden="true" />
        <button type="button" role="tab" aria-selected={isLogin} data-active={isLogin} onClick={() => switchMode('login')}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={!isLogin} data-active={!isLogin} onClick={() => switchMode('signup')}>
          Create account
        </button>
      </div>

      <h2 className="si-form-title">{isLogin ? 'Welcome back' : 'Request access'}</h2>
      <p className="si-form-sub">
        {isLogin
          ? 'Sign in to your Mineral Map workspace.'
          : 'Create your account to get started with Mineral Map.'}
      </p>

      {isInvite && (
        <div className="mm-night-alert" data-tone="info" style={{ marginBottom: 16 }}>
          <InfoIcon />
          <span>Team invite detected for {email}. Complete sign-in or sign-up to accept.</span>
        </div>
      )}
      {error && (
        <div className="mm-night-alert" data-tone="error" role="alert" style={{ marginBottom: 16 }}>
          <AlertIcon />
          <span>{error}</span>
        </div>
      )}
      {message && !isInvite && (
        <div className="mm-night-alert" data-tone="info" style={{ marginBottom: 16 }}>
          <InfoIcon />
          <span>{message}</span>
        </div>
      )}

      <div className="si-field">
        <label className="mm-night-label" htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          className="mm-night-input"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus
        />
      </div>

      <div className="si-field">
        <label className="mm-night-label" htmlFor="password">
          <span>Password</span>
        </label>
        <div className="si-password">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            className="mm-night-input"
            placeholder={isLogin ? 'Your password' : 'At least 8 characters'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
          />
          <button
            type="button"
            className="si-eye"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={16} strokeWidth={2} /> : <Eye size={16} strokeWidth={2} />}
          </button>
        </div>
      </div>

      <button type="submit" className="mm-night-btn mm-night-btn-brand mm-night-btn-lg mm-night-btn-block si-submit" disabled={loading}>
        {loading ? (
          <>
            <span className="mm-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'currentColor' }} />
            {isLogin ? 'Signing in' : 'Creating account'}
          </>
        ) : (
          <>
            {isLogin ? 'Sign in' : 'Create account'}
            <ArrowRight size={16} strokeWidth={2.25} />
          </>
        )}
      </button>

      <div className="si-switch">
        {isLogin ? (
          <>
            New to Mineral Map?{' '}
            <button type="button" onClick={() => switchMode('signup')}>Request access</button>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <button type="button" onClick={() => switchMode('login')}>Sign in</button>
          </>
        )}
      </div>
    </form>
  )
}

export default function SignInPage() {
  const legend = useMemo(
    () => [
      { label: 'Hot', color: TIER_COLORS.hot },
      { label: 'Motivated', color: TIER_COLORS.motivated },
      { label: 'Prospect', color: TIER_COLORS.prospect },
      { label: 'Low', color: TIER_COLORS.low },
    ],
    []
  )

  return (
    <div className="mm-night">
      <div className="mm-night-grid" aria-hidden="true" />
      <div
        className="mm-night-glow"
        aria-hidden="true"
        style={{ bottom: '-10%', left: '10%', width: 520, height: 520, background: 'rgba(239,159,39,0.14)' }}
      />

      <div className="si-page">
        <aside className="si-brand">
          <div className="si-brand-top">
            <Link href="/landing" aria-label="Mineral Map" style={{ display: 'flex' }}>
              <AppLogo width={140} variant="light" />
            </Link>
            <span className="mm-night-kicker" style={{ fontSize: 10.5 }}>Mineral acquisition intelligence</span>
          </div>

          <div className="si-brand-body">
            <div className="mm-enter">
              <h1 className="mm-night-display">
                Find the right owners
                <br />
                <em>before anyone else.</em>
              </h1>
              <p className="mm-night-lede si-brand-sub">
                County ownership data, well context, and motivation scoring combined into one
                acquisition platform.
              </p>
            </div>

            <div className="si-map">
              <div className="si-map-head">
                <span>
                  <strong>Gonzales County, TX</strong>
                </span>
                <div className="si-map-legend" aria-hidden="true">
                  {legend.map((item) => (
                    <span key={item.label}>
                      <i style={{ background: item.color }} />
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
              <SurveyMap />
              <div className="si-map-callout">
                <div className="si-map-callout-row">
                  <div>
                    <div className="si-map-callout-name">Abstract A-160</div>
                    <div className="si-map-callout-sub">EOG Resources</div>
                  </div>
                  <span className="si-map-callout-score">9/10</span>
                </div>
                <div className="si-map-callout-tags">
                  <span style={{ color: '#F44336', borderColor: 'rgba(244,67,54,0.4)', background: 'rgba(244,67,54,0.12)' }}>HOT</span>
                  <span style={{ color: '#EF9F27', borderColor: 'rgba(239,159,39,0.4)', background: 'rgba(239,159,39,0.12)' }}>OOS</span>
                  <span style={{ color: '#b0a89a', borderColor: 'rgba(255,255,255,0.14)' }}>IND</span>
                </div>
              </div>
            </div>

            <div className="si-stats mm-stagger">
              <div className="si-stat">
                <strong>73,430</strong>
                <span>Mineral owners scored</span>
              </div>
              <div className="si-stat">
                <strong>3,950</strong>
                <span>Hot leads (8 to 10)</span>
              </div>
              <div className="si-stat">
                <strong>207</strong>
                <span>Survey abstracts mapped</span>
              </div>
            </div>
          </div>

          <div className="si-brand-foot">
            <Link href="/landing">Overview</Link>
            <Link href="/pricing">Pricing</Link>
            <a href="mailto:josh@brentwoodenterprisesllc.com">Contact</a>
          </div>
        </aside>

        <main className="si-form-panel">
          <div className="si-form-card">
            <div className="si-mobile-logo">
              <Link href="/landing" aria-label="Mineral Map" style={{ display: 'inline-flex' }}>
                <AppLogo width={124} variant="light" />
              </Link>
            </div>
            <SignInForm />
          </div>
          <div className="si-form-foot">
            <Link href="/landing">Overview</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
        </main>
      </div>
    </div>
  )
}
