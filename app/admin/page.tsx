'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@supabase/auth-helpers-nextjs'
import { Users, CreditCard, TrendingUp, Phone } from 'lucide-react'
import AppHeader from '@/app/components/AppHeader'

export const dynamic = 'force-dynamic'

type UserRow = {
  id: string
  email: string
  created_at: string
  subscription_status: string
  is_admin: boolean
  subscription?: {
    status: string
    stripe_customer_id: string
    created_at: string
  } | null
  skip_traces?: number
}

type StatsRow = {
  totalUsers: number
  activeSubscribers: number
  trialUsers: number
  totalSkipTraces: number
}

export default function AdminDashboard() {
  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
  )
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())
  const [refreshing, setRefreshing] = useState(false)
  const [stats, setStats] = useState<StatsRow>({
    totalUsers: 0,
    activeSubscribers: 0,
    trialUsers: 0,
    totalSkipTraces: 0,
  })
  const currentMonth = useMemo(
    () => new Date().toLocaleString('default', { month: 'short', year: 'numeric' }),
    []
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/admin/users', { cache: 'no-store' })
      if (!res.ok) {
        window.location.href = '/'
        return
      }

      const data = (await res.json()) as {
        users?: UserRow[]
        stats?: StatsRow
      }
      setUsers(data.users ?? [])
      setStats(
        data.stats ?? {
          totalUsers: 0,
          activeSubscribers: 0,
          trialUsers: 0,
          totalSkipTraces: 0,
        }
      )
      setLastUpdated(new Date())
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.user?.user_metadata?.is_admin) {
        window.location.href = '/'
        return
      }
      await refresh()
    }

    void load()
  }, [refresh, supabase])

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh()
    }, 60000)
    return () => clearInterval(interval)
  }, [refresh])

  const statusColor = (status: string) => {
    if (status === 'active') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    if (status === 'trialing') return 'bg-blue-50 text-blue-700 border-blue-200'
    if (status === 'canceling') return 'bg-amber-50 text-amber-700 border-amber-200'
    return 'bg-gray-50 text-gray-500 border-gray-200'
  }

  return (
    <div className="mm-app min-h-screen bg-gray-50">
      <AppHeader
        active="admin"
        context={
          <div className="mm-context">
            <span className="mm-context-label">Admin</span>
            <span>Users and usage</span>
          </div>
        }
      />

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total users', val: stats.totalUsers, icon: <Users size={18} className="text-gray-400" /> },
            {
              label: 'Active subscribers',
              val: stats.activeSubscribers,
              icon: <CreditCard size={18} className="text-emerald-500" />,
            },
            { label: 'Trial users', val: stats.trialUsers, icon: <TrendingUp size={18} className="text-blue-500" /> },
            {
              label: 'Skip traces this month',
              val: stats.totalSkipTraces,
              icon: <Phone size={18} className="text-amber-500" />,
            },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{s.label}</div>
                {s.icon}
              </div>
              <div className="font-serif text-3xl font-bold text-gray-900">{loading ? '-' : s.val}</div>
            </div>
          ))}
        </div>

        <div className="bg-gray-900 rounded-xl p-5 mb-8 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">
              Monthly Recurring Revenue
            </div>
            <div className="font-serif text-4xl font-bold text-white">
              ${loading ? '-' : (stats.activeSubscribers * 300).toLocaleString()}
            </div>
            <div className="text-sm text-gray-400 mt-1">{stats.activeSubscribers} active x $300/mo</div>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">ARR</div>
            <div className="font-serif text-2xl font-bold text-amber-400">
              ${loading ? '-' : (stats.activeSubscribers * 300 * 12).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-serif text-lg font-bold text-gray-900">All Users</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Link
                href="/admin/review"
                className="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-md border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
              >
                Review flagged deeds
              </Link>
              <span style={{ fontSize: 11, color: '#6B7280' }}>
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
              <button
                onClick={() => {
                  void refresh()
                }}
                disabled={refreshing}
                style={{
                  fontSize: 12,
                  padding: '6px 14px',
                  borderRadius: 7,
                  background: refreshing ? '#F3F4F6' : '#111827',
                  color: refreshing ? '#9CA3AF' : '#fff',
                  border: 'none',
                  cursor: refreshing ? 'default' : 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  fontWeight: 500,
                }}
              >
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
              <span className="text-xs text-gray-400">{users.length} total</span>
            </div>
          </div>
          {loading ? (
            <div className="p-8 text-center text-sm text-gray-400">Loading...</div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Email', 'Signed up', 'Subscription', `Skip traces (${currentMonth})`, 'Admin'].map((h) => (
                      <th
                        key={h}
                        className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 text-sm font-medium text-gray-900">{user.email}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {new Date(user.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusColor(user.subscription_status)}`}
                        >
                          {user.subscription_status || 'none'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">{user.skip_traces ?? 0}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{user.is_admin ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
