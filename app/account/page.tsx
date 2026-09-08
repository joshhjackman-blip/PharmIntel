'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@supabase/auth-helpers-nextjs'
import { User, CreditCard, LogOut } from 'lucide-react'
import AppHeader from '@/app/components/AppHeader'

export const dynamic = 'force-dynamic'

type SubscriptionRow = {
  status?: string | null
  seat_count?: number | null
  team_owner_id?: string | null
}

type TeamMemberRow = {
  id: string
  invite_email: string
  status: 'pending' | 'accepted' | 'revoked' | string
}

export default function Account() {
  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
  )
  const [user, setUser] = useState<{ id?: string; email?: string; created_at?: string } | null>(null)
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null)
  const [skipTraceCount, setSkipTraceCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelLoading, setCancelLoading] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ current: '', new: '', confirm: '' })
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null)
  const [seatCount, setSeatCount] = useState<number>(1)
  const [teamMembers, setTeamMembers] = useState<TeamMemberRow[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteMessage, setInviteMessage] = useState('')

  const fetchTeamMembers = useCallback(
    async (ownerId: string) => {
      const { data } = await supabase
        .from('team_members')
        .select('id, invite_email, status')
        .eq('owner_id', ownerId)
        .neq('status', 'revoked')
        .order('created_at', { ascending: false })
      setTeamMembers((data as TeamMemberRow[] | null) ?? [])
    },
    [supabase]
  )

  useEffect(() => {
    const load = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        setSkipTraceCount(0)
        setTeamMembers([])
        setLoading(false)
        return
      }
      setUser(session.user)

      const { data: sub } = await supabase
        .from('subscriptions')
        .select('seat_count, status')
        .eq('user_id', session.user.id)
        .single()
      setSubscription((sub as SubscriptionRow | null) ?? null)
      setSeatCount(Number((sub as SubscriptionRow | null)?.seat_count ?? 1))

      const currentMonth = new Date().toISOString().slice(0, 7)
      const { data: usage } = await supabase
        .from('skip_trace_usage')
        .select('count')
        .eq('user_id', session.user.id)
        .eq('month', currentMonth)
        .maybeSingle()
      setSkipTraceCount((usage as { count?: number } | null)?.count ?? 0)
      await fetchTeamMembers(session.user.id)

      setLoading(false)
    }
    void load()
  }, [fetchTeamMembers, supabase])

  const handleCancelSubscription = async () => {
    if (!confirm('Cancel your subscription? You will lose access at the end of your billing period.')) return
    setCancelLoading(true)
    const res = await fetch('/api/cancel', { method: 'POST' })
    const data = (await res.json()) as { success?: boolean; error?: string }
    if (data.success) {
      setSubscription((prev) => ({ ...(prev ?? {}), status: 'canceling' }))
    } else if (data.error) {
      alert(data.error)
    }
    setCancelLoading(false)
  }

  const handlePasswordChange = async () => {
    if (passwordForm.new !== passwordForm.confirm) {
      setPasswordMsg('Passwords do not match')
      return
    }
    if (passwordForm.new.length < 8) {
      setPasswordMsg('Password must be at least 8 characters')
      return
    }
    const { error } = await supabase.auth.updateUser({ password: passwordForm.new })
    if (error) {
      setPasswordMsg(error.message)
    } else {
      setPasswordMsg('Password updated successfully')
      setPasswordForm({ current: '', new: '', confirm: '' })
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/landing'
  }

  const handleInvite = async () => {
    if (!inviteEmail || !user?.id) return
    setInviting(true)
    setInviteMessage('')
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (data.success) {
        setInviteMessage(`Invite sent to ${inviteEmail}`)
        setInviteEmail('')
        await fetchTeamMembers(user.id)
      } else {
        setInviteMessage(data.error ?? 'Failed to send invite')
      }
    } catch {
      setInviteMessage('Failed to send invite')
    } finally {
      setInviting(false)
    }
  }

  const handleRevoke = async (email: string) => {
    if (!user?.id) return
    await supabase
      .from('team_members')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('owner_id', user.id)
      .eq('invite_email', email)
    await fetchTeamMembers(user.id)
  }

  const statusColor =
    subscription?.status === 'active'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : subscription?.status === 'canceling'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-red-50 text-red-600 border-red-200'

  return (
    <div className="mm-app min-h-screen bg-gray-50">
      <AppHeader
        active="account"
        context={
          <div className="mm-context">
            <span className="mm-context-label">Settings</span>
            <span>Account</span>
          </div>
        }
      />

      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-5 shadow-sm">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center">
              <User size={20} className="text-amber-600" />
            </div>
            <div>
              <div className="font-serif text-lg font-bold text-gray-900">{user?.email}</div>
              <div className="text-sm text-gray-400">
                Member since{' '}
                {user?.created_at
                  ? new Date(user.created_at).toLocaleDateString('en-US', {
                    month: 'long',
                    year: 'numeric',
                  })
                  : '-'}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-5 shadow-sm">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100">
            Subscription
          </div>
          {loading ? (
            <div className="text-sm text-gray-400">Loading...</div>
          ) : subscription ? (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="font-serif text-base font-bold text-gray-900 mb-1">Mineral Map, $300/mo</div>
                  <div className="text-sm text-gray-400">Eagle Ford Basin, Gonzales County</div>
                </div>
                <span className={`text-xs font-semibold px-3 py-1 rounded-full border ${statusColor}`}>
                  {subscription.status === 'active'
                    ? 'Active'
                    : subscription.status === 'canceling'
                      ? 'Canceling'
                      : subscription.status}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">Plan</div>
                  <div className="text-sm font-medium text-gray-900">Prospector</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">Status</div>
                  <div className="text-sm font-medium text-gray-900 capitalize">{subscription.status}</div>
                </div>
              </div>
              {subscription.status === 'active' && (
                <button
                  onClick={handleCancelSubscription}
                  disabled={cancelLoading}
                  className="text-sm text-red-500 hover:text-red-700 hover:underline transition-colors"
                >
                  {cancelLoading ? 'Canceling...' : 'Cancel subscription'}
                </button>
              )}
              {subscription.status === 'canceling' && (
                <div className="text-sm text-amber-600">
                  Your subscription will remain active until the end of your billing period.
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="text-sm text-gray-500 mb-4">No active subscription.</div>
              <Link href="/pricing" className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 transition-colors">
                <CreditCard size={14} />
                Subscribe for $300/mo
              </Link>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="text-xs text-gray-400 mb-2">Skip traces this month</div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-400 rounded-full transition-all"
                  style={{ width: `${Math.min(((skipTraceCount ?? 0) / 200) * 100, 100)}%` }}
                />
              </div>
              <span className="text-xs font-medium text-gray-700 shrink-0">
                {skipTraceCount ?? 0} / 200
              </span>
            </div>
            <div className="text-xs text-gray-400 mt-1">Resets on the 1st of each month</div>
          </div>
        </div>

        {seatCount < 3 ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-serif text-base font-bold text-gray-900 mb-1">
                  Upgrade to Team
                </div>
                <div className="text-sm text-gray-500">
                  Get 3 seats, shared CRM, and 600 skip traces/mo for $499/mo.
                </div>
              </div>
              <button
                onClick={async () => {
                  const res = await fetch('/api/checkout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      priceId: process.env.NEXT_PUBLIC_STRIPE_TEAM_PRICE_ID,
                    }),
                  })
                  const data = (await res.json()) as { url?: string; error?: string }
                  if (data.url) {
                    window.location.href = data.url
                  } else if (data.error) {
                    alert(data.error)
                  }
                }}
                className="ml-6 shrink-0 px-5 py-2.5 bg-amber-500 text-white text-sm font-semibold rounded-lg hover:bg-amber-600 transition-colors"
              >
                Upgrade for $499/mo
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm mt-6">
            <h2 className="font-serif text-lg font-bold text-gray-900 mb-1">Team Members</h2>
            <p className="text-sm text-gray-400 mb-4">
              Invite up to {seatCount - 1} additional team members.
            </p>

            <div className="flex gap-2 mb-4">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
              />
              <button
                onClick={() => {
                  void handleInvite()
                }}
                disabled={inviting || !inviteEmail}
                className="px-4 py-2 text-sm font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50"
              >
                {inviting ? 'Sending...' : 'Send invite'}
              </button>
            </div>

            {inviteMessage && <p className="text-sm text-gray-500 mb-4">{inviteMessage}</p>}

            {teamMembers.length > 0 ? (
              <div className="space-y-2">
                {teamMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                  >
                    <div>
                      <div className="text-sm font-medium text-gray-900">{member.invite_email}</div>
                      <div className="text-xs text-gray-400 capitalize">{member.status}</div>
                    </div>
                    <button
                      onClick={() => {
                        void handleRevoke(member.invite_email)
                      }}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No team members yet.</p>
            )}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-5 shadow-sm">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100">
            Change Password
          </div>
          <div className="space-y-3 mb-4">
            {[
              { label: 'New password', field: 'new', type: 'password' },
              { label: 'Confirm new password', field: 'confirm', type: 'password' },
            ].map((f) => (
              <div key={f.field}>
                <label className="block text-xs font-medium text-gray-500 mb-1">{f.label}</label>
                <input
                  type={f.type}
                  value={passwordForm[f.field as keyof typeof passwordForm]}
                  onChange={(e) => setPasswordForm((prev) => ({ ...prev, [f.field]: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 transition-all"
                />
              </div>
            ))}
          </div>
          {passwordMsg && (
            <div className={`text-xs mb-3 ${passwordMsg.includes('successfully') ? 'text-emerald-600' : 'text-red-500'}`}>
              {passwordMsg}
            </div>
          )}
          <button
            onClick={handlePasswordChange}
            className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700 transition-colors"
          >
            Update password
          </button>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100">
            Session
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
