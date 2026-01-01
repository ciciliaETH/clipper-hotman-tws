import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 300; // 5 minutes - waits for Supabase function + accrual backfill

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: Request) {
  try {
    // Verify cron secret for security
    const { searchParams } = new URL(req.url)
    const cronSecret = searchParams.get('secret') || req.headers.get('x-cron-secret')
    const expectedSecret = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
    
    if (!cronSecret || cronSecret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const url = new URL(req.url)
    const baseUrl = `${url.protocol}//${url.host}`

    // Call internal Next.js endpoint instead of Supabase Edge Function
    // This is faster, more reliable, and uses less resources
    const refreshUrl = new URL(`${baseUrl}/api/admin/tiktok/refresh-all`)
    
    // Forward query params if needed
    const all = searchParams.get('all')
    const limit = searchParams.get('limit')
    const concurrency = searchParams.get('concurrency')
    if (all) refreshUrl.searchParams.set('all', all)
    if (limit) refreshUrl.searchParams.set('limit', limit)
    if (concurrency) refreshUrl.searchParams.set('concurrency', concurrency)

    const headers = {
      'Authorization': `Bearer ${process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
    
    const res = await fetch(refreshUrl.toString(), { headers, method: 'GET' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('[tiktok-refresh cron] Refresh failed:', json)
      throw new Error(json?.error || 'tiktok-refresh failed')
    }

    console.log('[tiktok-refresh cron] TikTok refresh completed:', {
      processed: json?.processed,
      success: json?.success,
      failed: json?.failed
    })

    // AUTO-TRIGGER ACCRUAL BACKFILL after TikTok refresh
    try {
      const cronSecret = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
      const accrualUrl = new URL(`${baseUrl}/api/backfill/accrual`)
      const accrualRes = await fetch(accrualUrl.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ days: 28 }) // Backfill 28 days for accrual mode
      })
      const accrualJson = await accrualRes.json().catch(() => ({}))
      console.log('[tiktok-refresh cron] Accrual backfill triggered:', accrualJson)
    } catch (e: any) {
      console.warn('[tiktok-refresh cron] Failed to trigger accrual backfill:', e?.message)
    }

    return NextResponse.json(json)
  } catch (e: any) {
    console.error('[tiktok-refresh cron] Error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
