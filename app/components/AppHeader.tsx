'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  BarChart2,
  BookOpen,
  Briefcase,
  LogOut,
  Map as MapIcon,
  Menu,
  Settings,
  ShieldCheck,
  UserRound,
} from 'lucide-react'

import { supabase } from '@/lib/supabase'
import AppLogo from '@/app/components/AppLogo'

export type AppSection = 'map' | 'crm' | 'comps' | 'methodology' | 'account' | 'admin'

type NavItem = {
  key: AppSection
  href: string
  label: string
  icon: ReactNode
}

const PRIMARY_NAV: NavItem[] = [
  { key: 'map', href: '/', label: 'Map', icon: <MapIcon size={14} strokeWidth={2} /> },
  { key: 'crm', href: '/crm', label: 'CRM', icon: <Briefcase size={14} strokeWidth={2} /> },
  { key: 'comps', href: '/comps', label: 'Comps', icon: <BarChart2 size={14} strokeWidth={2} /> },
  { key: 'methodology', href: '/methodology', label: 'Methodology', icon: <BookOpen size={14} strokeWidth={2} /> },
]

type AppHeaderProps = {
  active: AppSection
  /** Page-specific controls rendered right of the logo (e.g. county switcher). */
  context?: ReactNode
  /** Centered slot, usually search. */
  center?: ReactNode
  /** Extra actions placed before Account / Sign out. */
  actions?: ReactNode
  /** Supplementary lines shown in the compact menu (e.g. county summary). */
  menuMeta?: ReactNode
  /** Hide the primary nav links (compact header for narrow layouts). */
  compact?: boolean
}

export default function AppHeader({
  active,
  context,
  center,
  actions,
  menuMeta,
  compact = false,
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return
        const meta = data.session?.user?.user_metadata as Record<string, unknown> | undefined
        setIsAdmin(Boolean(meta?.is_admin))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await supabase.auth.signOut()
    } finally {
      window.location.href = '/auth'
    }
  }

  return (
    <header className="mm-topbar" data-compact={compact ? 'true' : 'false'}>
      <div className="mm-topbar-left">
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="mm-btn mm-btn-secondary mm-btn-icon mm-topbar-menu-btn"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Menu size={15} strokeWidth={2} />
          </button>
          {menuOpen && (
            <div className="mm-menu" role="menu">
              {PRIMARY_NAV.map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  className="mm-menu-item"
                  data-active={item.key === active}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  {item.icon}
                  {item.label}
                </Link>
              ))}
              <div className="mm-menu-sep" />
              <Link
                href="/account"
                className="mm-menu-item"
                data-active={active === 'account'}
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <Settings size={14} strokeWidth={2} />
                Account
              </Link>
              {isAdmin && (
                <Link
                  href="/admin"
                  className="mm-menu-item"
                  data-active={active === 'admin'}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  <ShieldCheck size={14} strokeWidth={2} />
                  Admin
                </Link>
              )}
              <button type="button" className="mm-menu-item" role="menuitem" onClick={handleSignOut}>
                <LogOut size={14} strokeWidth={2} />
                Sign out
              </button>
              {menuMeta && (
                <>
                  <div className="mm-menu-sep" />
                  <div className="mm-menu-meta">{menuMeta}</div>
                </>
              )}
            </div>
          )}
        </div>

        <Link href="/" aria-label="Mineral Map home" style={{ display: 'flex', alignItems: 'center' }}>
          <AppLogo width={138} />
        </Link>

        {context && (
          <>
            <div className="mm-topbar-divider mm-topbar-hide-narrow" />
            <div className="mm-topbar-context">{context}</div>
          </>
        )}
      </div>

      {center && <div className="mm-topbar-center">{center}</div>}

      <div className="mm-topbar-right">
        {!compact && (
          <nav className="mm-nav mm-topbar-nav" aria-label="Primary">
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="mm-nav-link"
                data-active={item.key === active}
              >
                {item.label}
              </Link>
            ))}
            {isAdmin && (
              <Link href="/admin" className="mm-nav-link" data-active={active === 'admin'}>
                Admin
              </Link>
            )}
          </nav>
        )}
        {actions}
        <div className="mm-topbar-divider mm-topbar-hide-narrow" />
        <Link
          href="/account"
          className="mm-btn mm-btn-ghost mm-topbar-account"
          data-active={active === 'account'}
          aria-label="Account"
        >
          <UserRound size={14} strokeWidth={2} />
          <span className="mm-topbar-hide-narrow">Account</span>
        </Link>
        <button
          type="button"
          className="mm-btn mm-btn-secondary mm-topbar-signout"
          onClick={handleSignOut}
          disabled={signingOut}
        >
          {signingOut ? <span className="mm-spinner" /> : <LogOut size={14} strokeWidth={2} />}
          <span className="mm-topbar-hide-narrow">Sign out</span>
        </button>
      </div>
    </header>
  )
}
