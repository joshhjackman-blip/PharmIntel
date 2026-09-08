import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { email?: string }
  const normalizedEmail = body.email?.toLowerCase().trim()
  if (!normalizedEmail) {
    return NextResponse.json({ error: 'Email required' }, { status: 400 })
  }

  const cookieStore = cookies()
  const supabaseAuth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll() {
          // No cookie writes needed for this endpoint.
        },
      },
    }
  )
  const {
    data: { session },
  } = await supabaseAuth.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: sub } = await adminClient
    .from('subscriptions')
    .select('status, seat_count, stripe_subscription_id')
    .eq('user_id', session.user.id)
    .single()

  if (!sub || sub.status !== 'active') {
    return NextResponse.json({ error: 'Active subscription required' }, { status: 403 })
  }

  const { data: existingMembers } = await adminClient
    .from('team_members')
    .select('id, status')
    .eq('owner_id', session.user.id)
    .neq('status', 'revoked')

  const seatLimit = Number(sub.seat_count ?? 1)
  if (seatLimit < 3) {
    return NextResponse.json(
      {
        error: 'Team plan required to invite members. Upgrade to Team at $499/mo.',
      },
      { status: 403 }
    )
  }

  if ((existingMembers?.length ?? 0) >= seatLimit - 1) {
    return NextResponse.json(
      {
        error: `Seat limit reached. Your plan includes ${seatLimit} seats.`,
      },
      { status: 403 }
    )
  }

  const { error: inviteError } = await adminClient.from('team_members').upsert(
    {
      owner_id: session.user.id,
      invite_email: normalizedEmail,
      status: 'pending',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'owner_id,invite_email' }
  )

  if (inviteError) {
    return NextResponse.json({ error: inviteError.message }, { status: 500 })
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/auth?invite=${session.user.id}&email=${encodeURIComponent(normalizedEmail)}`
  const resendApiKey = process.env.RESEND_API_KEY
  if (resendApiKey) {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: 'Mineral Map <noreply@getmineralmap.com>',
        to: normalizedEmail,
        subject: "You've been invited to Mineral Map",
        html: `
        <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; color: #111827; margin-bottom: 16px;">You've been invited to Mineral Map</h1>
          <p style="font-size: 15px; color: #4B5563; line-height: 1.7; margin-bottom: 24px;">
            A teammate has invited you to join their Mineral Map account,
            the Eagle Ford mineral rights prospecting platform.
          </p>
          <a href="${inviteUrl}" style="display: inline-block; background: #EF9F27; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-family: Inter, sans-serif; font-weight: 600; font-size: 14px;">
            Accept Invitation
          </a>
          <p style="font-size: 12px; color: #9CA3AF; margin-top: 32px;">
            If you weren't expecting this invite, you can ignore this email.
          </p>
        </div>
      `,
      }),
    })

    if (!emailRes.ok) {
      console.error('Resend error:', await emailRes.text())
      // Keep success because invite persistence succeeded.
    }
  } else {
    console.warn('RESEND_API_KEY missing; invite email not sent')
  }

  return NextResponse.json({ success: true, email: normalizedEmail })
}
