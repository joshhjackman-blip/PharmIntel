'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@supabase/auth-helpers-nextjs'
import { ArrowLeft } from 'lucide-react'

import AppHeader from '@/app/components/AppHeader'

export const dynamic = 'force-dynamic'

type ReviewRecord = {
  id: string
  county: string
  section: string
  township: string
  range: string
  grantor: string
  grantee: string
  interest: number | null
  legal_desc: string
  recorded_date: string
  instrument_type: string
  confidence: number
  raw_text: string
  needs_review: boolean
}

type ApiGetResponse = {
  record: ReviewRecord | null
  remaining: number
}

type ApiActionResponse = {
  success?: boolean
  error?: string
}

const EMPTY_RECORD: ReviewRecord = {
  id: '',
  county: 'roger_mills',
  section: '',
  township: '',
  range: '',
  grantor: '',
  grantee: '',
  interest: null,
  legal_desc: '',
  recorded_date: '',
  instrument_type: '',
  confidence: 0,
  raw_text: '',
  needs_review: true,
}

export default function AdminReviewPage() {
  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
  )

  const [record, setRecord] = useState<ReviewRecord | null>(null)
  const [draft, setDraft] = useState<ReviewRecord>(EMPTY_RECORD)
  const [remaining, setRemaining] = useState(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    const res = await fetch('/api/admin/review', { cache: 'no-store' })
    if (!res.ok) {
      window.location.href = '/'
      return
    }
    const data = (await res.json()) as ApiGetResponse
    setRecord(data.record)
    setRemaining(data.remaining ?? 0)
    setDraft(data.record ?? EMPTY_RECORD)
    setLoading(false)
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

  const updateField = <K extends keyof ReviewRecord>(field: K, value: ReviewRecord[K]) => {
    setDraft((prev) => ({ ...prev, [field]: value }))
  }

  const submitAction = async (action: 'accept' | 'edit_accept' | 'reject') => {
    if (!record?.id) return
    setSubmitting(true)
    setMessage(null)

    const payload: Record<string, unknown> = {
      action,
      id: record.id,
    }
    if (action === 'edit_accept') {
      payload.updates = {
        grantor: draft.grantor,
        grantee: draft.grantee,
        interest: draft.interest,
        recorded_date: draft.recorded_date,
      }
    }

    const res = await fetch('/api/admin/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = (await res.json()) as ApiActionResponse
    if (!res.ok || !data.success) {
      setMessage(data.error ?? 'Failed to update record')
      setSubmitting(false)
      return
    }

    setMessage(
      action === 'reject'
        ? 'Record rejected.'
        : action === 'edit_accept'
          ? 'Edits applied and record accepted.'
          : 'Record accepted.'
    )
    await refresh()
    setSubmitting(false)
  }

  return (
    <div className="mm-app min-h-screen bg-gray-50">
      <AppHeader
        active="admin"
        context={
          <div className="mm-context">
            <span className="mm-context-label">Admin</span>
            <span>Deed review</span>
          </div>
        }
        actions={
          <Link href="/admin" className="mm-btn mm-btn-ghost">
            <ArrowLeft size={14} strokeWidth={2} />
            Back to admin
          </Link>
        }
      />

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-serif text-2xl font-bold text-gray-900">Flagged Deed Review</h1>
          <div className="text-sm text-gray-500">{remaining} remaining</div>
        </div>

        {loading ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400">
            Loading flagged record...
          </div>
        ) : !record ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-500">
            No flagged records pending review.
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 text-xs text-gray-500 bg-gray-50">
              {record.county.replace('_', ' ')}, Section {record.section}, Township {record.township}, Range{' '}
              {record.range}, Confidence {(record.confidence * 100).toFixed(0)}%
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
              <div className="border-r border-gray-100 p-5">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
                  Raw deed text
                </div>
                <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-6 max-h-[560px] overflow-auto bg-gray-50 rounded-lg border border-gray-200 p-4">
                  {record.raw_text || 'No raw text captured.'}
                </pre>
              </div>

              <div className="p-5">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
                  Extracted data
                </div>
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-xs text-gray-500">Grantor</span>
                    <input
                      value={draft.grantor ?? ''}
                      onChange={(e) => updateField('grantor', e.target.value)}
                      className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs text-gray-500">Grantee</span>
                    <input
                      value={draft.grantee ?? ''}
                      onChange={(e) => updateField('grantee', e.target.value)}
                      className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs text-gray-500">Interest</span>
                    <input
                      value={draft.interest ?? ''}
                      onChange={(e) => {
                        const value = e.target.value.trim()
                        updateField('interest', value === '' ? null : Number(value))
                      }}
                      className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs text-gray-500">Date</span>
                    <input
                      value={draft.recorded_date ?? ''}
                      onChange={(e) => updateField('recorded_date', e.target.value)}
                      className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-amber-400"
                    />
                  </label>
                </div>

                {message && <div className="mt-4 text-sm text-gray-500">{message}</div>}

                <div className="mt-6 flex items-center gap-2">
                  <button
                    onClick={() => {
                      void submitAction('accept')
                    }}
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-60"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => {
                      void submitAction('edit_accept')
                    }}
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60"
                  >
                    Edit and accept
                  </button>
                  <button
                    onClick={() => {
                      void submitAction('reject')
                    }}
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-60"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
