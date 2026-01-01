import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function asyncPool<T, R>(items: T[], limit: number, worker: (t: T, idx: number) => Promise<R>): Promise<R[]> {
  const ret: R[] = []
  const executing: Promise<void>[] = []
  let i = 0
  const enqueue = () => {
    if (i >= items.length) return
    const idx = i++
    const p = worker(items[idx], idx)
      .then((r) => { ret[idx] = r as any })
      .catch((e) => { (ret as any)[idx] = { error: String(e?.message || e) } })
      .then(() => { const pos = executing.indexOf(p as any); if (pos >= 0) executing.splice(pos, 1) }) as any
    executing.push(p as any)
    if (executing.length < limit) enqueue()
  }
  for (let k = 0; k < Math.min(limit, items.length); k++) enqueue()
  await Promise.all(executing)
  while (i < items.length) { enqueue(); await Promise.race(executing) }
  await Promise.all(executing)
  return ret
}

export async function GET(req: NextRequest) {
  try {
    // Verify cron secret for security (support both header and query param)
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace(/^Bearer\s+/i, '')
    const secretParam = req.nextUrl.searchParams.get('secret')
    const cronSecret = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
    const isVercelCron = Boolean(req.headers.get('x-vercel-cron'))
    
    // Allow if: Vercel Cron header, valid token, or valid secret param
    if (!isVercelCron && token !== cronSecret && secretParam !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const search = req.nextUrl.searchParams
    const limit = parseInt(search.get('limit') || '200')
    const concurrency = parseInt(search.get('concurrency') || '6')

    const supa = adminClient()

    // Collect IG usernames from multiple sources
    const set = new Set<string>()
    // campaign_instagram_participants
    try {
      const { data } = await supa.from('campaign_instagram_participants').select('instagram_username').limit(limit)
      for (const r of data || []) if (r.instagram_username) set.add(String(r.instagram_username).replace(/^@/, '').toLowerCase())
    } catch {}
    // employee_instagram_participants (missing before)
    try {
      const { data } = await supa.from('employee_instagram_participants').select('instagram_username').limit(limit)
      for (const r of data || []) if (r.instagram_username) set.add(String(r.instagram_username).replace(/^@/, '').toLowerCase())
    } catch {}
    // user_instagram_usernames
    try {
      const { data } = await supa.from('user_instagram_usernames').select('instagram_username').limit(limit)
      for (const r of data || []) if (r.instagram_username) set.add(String(r.instagram_username).replace(/^@/, '').toLowerCase())
    } catch {}
    // users.instagram_username
    try {
      const { data } = await supa.from('users').select('instagram_username').not('instagram_username', 'is', null).limit(limit)
      for (const r of data || []) if ((r as any).instagram_username) set.add(String((r as any).instagram_username).replace(/^@/, '').toLowerCase())
    } catch {}

    const usernames = Array.from(set).slice(0, limit)
    if (!usernames.length) return NextResponse.json({ updated: 0, results: [], message: 'No IG usernames' })

    // Resolve and cache user_id for any usernames missing in instagram_user_ids
    const host = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram120.p.rapidapi.com'
    const scraper = process.env.RAPIDAPI_IG_SCRAPER_HOST || 'instagram-scraper-api11.p.rapidapi.com'
    const keys = (process.env.RAPID_API_KEYS || process.env.RAPIDAPI_KEYS || process.env.RAPID_KEY_BACKFILL || process.env.RAPIDAPI_KEY || '').split(',').map(s=>s.trim()).filter(Boolean)
    const rapidJson = async (url:string, rapidHost:string, timeoutMs=15000) => {
      const key = keys[Math.floor(Math.random()*(keys.length||1))]
      const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), timeoutMs)
      try {
        const res = await fetch(url, { headers: { 'x-rapidapi-key': key||'', 'x-rapidapi-host': rapidHost, 'accept':'application/json' }, signal: ctl.signal })
        const txt = await res.text(); if (!res.ok) throw new Error(`${res.status} ${txt.slice(0,120)}`)
        try { return JSON.parse(txt) } catch { return txt }
      } finally { clearTimeout(t) }
    }
    const norm = (u:string)=> String(u||'').trim().replace(/^@+/, '').toLowerCase()
    const needResolve:string[] = []
    try {
      const { data: cached } = await supa.from('instagram_user_ids').select('instagram_username')
      const cachedSet = new Set((cached||[]).map((r:any)=> String(r.instagram_username)))
      for (const u of usernames) if (!cachedSet.has(norm(u))) needResolve.push(norm(u))
    } catch { needResolve.push(...usernames.map(norm)) }
    if (needResolve.length) {
      const resolveOne = async (u:string) => {
        try {
          // link endpoint first
          try {
            const j = await rapidJson(`https://${scraper}/get_instagram_user_id?link=${encodeURIComponent('https://www.instagram.com/'+u)}`, scraper, 15000)
            const id = j?.user_id || j?.id || j?.data?.user_id || j?.data?.id
            if (id) { await supa.from('instagram_user_ids').upsert({ instagram_username: u, instagram_user_id: String(id), created_at: new Date().toISOString() }, { onConflict: 'instagram_username' }); return }
          } catch {}
          // host endpoints fallback
          const endpoints = [
            `https://${host}/api/instagram/user?username=${encodeURIComponent(u)}`,
            `https://${host}/api/instagram/userinfo?username=${encodeURIComponent(u)}`,
            `https://${host}/api/instagram/username?username=${encodeURIComponent(u)}`,
          ]
          for (const url of endpoints) {
            try {
              const ij = await rapidJson(url, host, 15000)
              const cand = ij?.result?.user || ij?.user || ij?.result || {}
              const pk = cand?.pk || cand?.id || cand?.pk_id || ij?.result?.pk || ij?.result?.id
              if (pk) { await supa.from('instagram_user_ids').upsert({ instagram_username: u, instagram_user_id: String(pk), created_at: new Date().toISOString() }, { onConflict: 'instagram_username' }); return }
            } catch {}
          }
        } catch {}
      }
      const pool = Math.max(1, Math.min(concurrency, 8))
      await asyncPool(needResolve, pool, resolveOne)
    }

    const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`
    const results = await asyncPool(usernames, concurrency, async (u) => {
      try {
        const uurl = new URL(`${base}/api/fetch-ig/${encodeURIComponent(u)}`)
        // Do not cleanup or create user on cron
        uurl.searchParams.set('create', '0')
        
        // AGGRESSIVE RETRY: Up to 3 attempts with exponential backoff
        let res: Response | null = null;
        let json: any = {};
        let lastError: string = '';
        
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            res = await fetch(uurl.toString(), { cache: 'no-store' })
            json = await res.json().catch(()=>({}))
            
            // Success criteria: 200 status AND (has inserts OR metrics inserted)
            if (res.ok && (json?.inserted > 0 || json?.metrics_inserted)) {
              return { 
                username: u, 
                ok: true, 
                status: res.status, 
                inserted: json.inserted || 0, 
                metrics_inserted: json.metrics_inserted || false,
                owner_user_id: json.owner_user_id || null,
                source: json.source,
                attempts: attempt + 1
              };
            }
            
            // If 200 but no data, retry
            if (res.ok && json?.inserted === 0) {
              lastError = `No data inserted (attempt ${attempt + 1})`;
              if (attempt < 2) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); // 2s, 4s
                continue;
              }
            }
            
            // If not ok, retry
            if (!res.ok) {
              lastError = `HTTP ${res.status} (attempt ${attempt + 1})`;
              if (attempt < 2) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                continue;
              }
            }
            
            break;
          } catch (e: any) {
            lastError = String(e?.message || e);
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
              continue;
            }
          }
        }
        
        return { 
          username: u, 
          ok: res?.ok || false, 
          status: res?.status || 0, 
          inserted: json?.inserted || 0, 
          metrics_inserted: json?.metrics_inserted || false,
          owner_user_id: json?.owner_user_id || null,
          source: json?.source,
          error: lastError,
          attempts: 3
        }
      } catch (e:any) {
        return { username: u, ok: false, error: String(e?.message || e), attempts: 0 }
      }
    })

    const inserted = results.reduce((a:any,r:any)=> a + (Number((r as any).inserted)||0), 0)
    
    // AUTO-TRIGGER ACCRUAL BACKFILL after Instagram refresh
    try {
      const accrualUrl = new URL(`${req.nextUrl.protocol}//${req.nextUrl.host}/api/backfill/accrual`)
      const accrualRes = await fetch(accrualUrl.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ days: 28 }) // Backfill 28 days for accrual mode
      })
      const accrualJson = await accrualRes.json().catch(() => ({}))
      console.log('[instagram-refresh] Accrual backfill triggered:', accrualJson)
    } catch (e: any) {
      console.warn('[instagram-refresh] Failed to trigger accrual backfill:', e?.message)
    }
    
    return NextResponse.json({ updated: results.length, inserted, results })
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
