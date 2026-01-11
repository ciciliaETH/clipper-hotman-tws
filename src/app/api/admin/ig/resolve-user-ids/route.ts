import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds to stay safe

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function ensureAdmin() {
  const supabase = await createServerSSR();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('users').select('role').eq('id', user.id).single();
  return data?.role === 'admin' || data?.role === 'super_admin';
}

function getRandomKey() {
  const keys = (process.env.RAPID_API_KEYS || process.env.RAPIDAPI_KEYS || process.env.RAPID_KEY_BACKFILL || process.env.RAPIDAPI_KEY || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!keys.length) throw new Error('No RapidAPI key');
  return keys[Math.floor(Math.random()*keys.length)];
}

async function rapidJson(url: string, host: string, timeoutMs = 15000) {
  const key = getRandomKey();
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host, 'accept': 'application/json' }, signal: controller.signal });
    const txt = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${txt.slice(0,200)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  } finally { clearTimeout(id); }
}

// POST request for instagram-media-api.p.rapidapi.com
async function rapidPostJson(url: string, host: string, body: object, timeoutMs = 15000) {
  const key = getRandomKey();
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { 
      method: 'POST',
      headers: { 
        'x-rapidapi-key': key, 
        'x-rapidapi-host': host, 
        'Content-Type': 'application/json',
        'accept': 'application/json' 
      }, 
      body: JSON.stringify(body),
      signal: controller.signal 
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${txt.slice(0,200)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  } finally { clearTimeout(id); }
}

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const supa = adminClient();
    const body = await req.json().catch(()=>({}));
    const maxAccountsPerRequest = body?.limit ? Math.min(body.limit, 5) : 5; // Process max 5 accounts to prevent timeout
    const doFetch = body?.fetch === true;
    const force = body?.force === true;
    const debug = body?.debug === true;

    // Collect IG usernames from multiple sources
    const set = new Set<string>();
    const norm = (u:any)=> String(u||'').trim().replace(/^@+/, '').toLowerCase();
    const sourceCounts: Record<string, number> = {};
    
    try { 
      const { data } = await supa.from('campaign_instagram_participants').select('instagram_username'); 
      for (const r of data||[]) if (r.instagram_username) set.add(norm(r.instagram_username)); 
      sourceCounts.campaign_instagram_participants = (data||[]).length; 
    } catch {}
    
    try { 
      const { data } = await supa.from('employee_instagram_participants').select('instagram_username'); 
      for (const r of data||[]) if (r.instagram_username) set.add(norm(r.instagram_username)); 
      sourceCounts.employee_instagram_participants = (data||[]).length; 
    } catch {}
    
    try { 
      const { data } = await supa.from('user_instagram_usernames').select('instagram_username'); 
      for (const r of data||[]) if (r.instagram_username) set.add(norm(r.instagram_username)); 
      sourceCounts.user_instagram_usernames = (data||[]).length; 
    } catch {}
    
    try { 
      const { data } = await supa.from('users').select('instagram_username').not('instagram_username','is',null); 
      for (const r of data||[]) if ((r as any).instagram_username) set.add(norm((r as any).instagram_username)); 
      sourceCounts.users = (data||[]).length; 
    } catch {}

    let all = Array.from(set).filter(Boolean);
    
    // Filter out already resolved unless force=true
    if (!force) {
      const { data: cached } = await supa.from('instagram_user_ids').select('instagram_username');
      const cachedSet = new Set((cached || []).map(r => norm(r.instagram_username)));
      all = all.filter(u => !cachedSet.has(u));
    }
    
    // Apply batch limit
    const totalPending = all.length;
    const toProcess = all.slice(0, maxAccountsPerRequest);
    const remaining = totalPending - toProcess.length;
    
    if (!toProcess.length) return NextResponse.json({ 
      resolved: 0, 
      fetched: 0, 
      users: 0, 
      remaining: 0,
      message: 'All usernames already resolved!',
      results: [] 
    });

    const host = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram120.p.rapidapi.com';
    const scraper = process.env.RAPIDAPI_IG_SCRAPER_HOST || 'instagram-scraper-api11.p.rapidapi.com';
    const mediaApi = 'instagram-media-api.p.rapidapi.com'; // Primary API for user ID resolution

    const results: any[] = [];
    const resolved: Array<{username:string; user_id:string}> = [];
    const failures: Array<{username:string; reason:string}> = [];

    const resolveUserId = async (username: string): Promise<string|undefined> => {
      const u = norm(username);
      
      // Check cache first
      if (!force) {
        const { data: c } = await supa.from('instagram_user_ids').select('instagram_user_id').eq('instagram_username', u).maybeSingle();
        if (c?.instagram_user_id) return String(c.instagram_user_id);
      }
      
      // Enhanced multi-provider resolution with retry logic
      const providers = [
        // Provider 1: instagram-media-api.p.rapidapi.com (PRIMARY - as specified by user)
        {
          name: 'media_api',
          fn: async () => {
            try {
              const j = await rapidPostJson(
                `https://${mediaApi}/user/id`,
                mediaApi,
                { username: u, proxy: '' },
                12000
              );
              if (debug) console.log(`[Resolve IG] ${u} media_api response:`, JSON.stringify(j).slice(0, 500));
              // Response format: { id: "123456789", username: "dailysuli" }
              return j?.id || j?.user_id || j?.pk;
            } catch (err: any) {
              if (debug) console.log(`[Resolve IG] ${u} media_api error:`, err?.message);
              throw err;
            }
          }
        },
        // Provider 2: Scraper link endpoint (fallback)
        {
          name: 'scraper_link',
          fn: async () => {
            try {
              const j = await rapidJson(`https://${scraper}/get_instagram_user_id?link=${encodeURIComponent('https://www.instagram.com/'+u)}`, scraper, 10000);
              if (debug) console.log(`[Resolve IG] ${u} scraper_link response:`, JSON.stringify(j).slice(0, 500));
              return j?.user_id || j?.id || j?.data?.user_id || j?.data?.id;
            } catch (err: any) {
              if (debug) console.log(`[Resolve IG] ${u} scraper_link error:`, err?.message);
              throw err;
            }
          }
        },
      ];
      
      // Try each provider (no retry to save time)
      for (const provider of providers) {
        try {
          const id = await provider.fn();
          if (id) {
            if (debug) console.log(`[Resolve IG] ${u} → ${id} via ${provider.name}`);
            return String(id);
          }
        } catch (e) {
          if (debug) console.log(`[Resolve IG] ${u} failed on ${provider.name}:`, e);
        }
      }
      
      return undefined;
    };

    // Derive base URL for internal calls
    const { protocol, host: reqHost } = new URL(req.url);
    const base = `${protocol}//${reqHost}`;

    // Process each username with delay to avoid rate limits
    for (let i = 0; i < toProcess.length; i++) {
      const u = toProcess[i];
      try {
        const id = await resolveUserId(u);
        if (id) {
          await supa.from('instagram_user_ids').upsert({ 
            instagram_username: u, 
            instagram_user_id: id, 
            created_at: new Date().toISOString() 
          }, { onConflict: 'instagram_username' });
          resolved.push({ username: u, user_id: id });
          results.push({ username: u, ok: true, user_id: id });
        } else {
          // Fallback: call internal fetch-ig to leverage extended resolvers
          try {
            const res = await fetch(`${base}/api/fetch-ig/${encodeURIComponent(u)}?create=0&debug=1`, { cache: 'no-store' });
            await res.json().catch(()=>({}));
            
            // Recheck cache after fetch-ig
            const { data: c2 } = await supa.from('instagram_user_ids').select('instagram_user_id').eq('instagram_username', u).maybeSingle();
            if (c2?.instagram_user_id) {
              const uid = String(c2.instagram_user_id);
              resolved.push({ username: u, user_id: uid });
              results.push({ username: u, ok: true, user_id: uid, via: 'fetch-ig-fallback' });
              continue;
            }
          } catch {}
          
          failures.push({ username: u, reason: 'not-found' });
          results.push({ username: u, ok: false, error: 'not-found' });
        }
      } catch (e:any) {
        failures.push({ username: u, reason: String(e?.message||e) });
        results.push({ username: u, ok: false, error: String(e?.message||e) });
      }
      
      // Add delay between requests to avoid rate limits
      if (i < toProcess.length - 1) {
        await new Promise(r => setTimeout(r, 500)); // 500ms delay
      }
    }

    // Optionally fetch posts for resolved accounts
    let fetched = 0;
    if (doFetch && resolved.length) {
      const limitFetch = Math.max(1, Math.min(5, Number(process.env.CAMPAIGN_REFRESH_IG_CONCURRENCY || '5')));
      for (let i=0;i<resolved.length;i+=limitFetch) {
        const batch = resolved.slice(i, i+limitFetch);
        await Promise.all(batch.map(async (r)=>{
          try { 
            const res = await fetch(`${base}/api/fetch-ig/${encodeURIComponent(r.username)}`); 
            if (res.ok) fetched += 1; 
          } catch {}
        }));
      }
    }

    return NextResponse.json({ 
      users: toProcess.length, 
      resolved: resolved.length, 
      fetched, 
      failures: failures.length,
      remaining,
      success_rate: toProcess.length > 0 ? Math.round((resolved.length / toProcess.length) * 100) : 0,
      message: remaining > 0
        ? `Processed ${toProcess.length} accounts. ${remaining} more to go. ${failures.length > 0 ? `(${failures.length} failures)` : ''}`
        : failures.length > 0 
          ? `Resolved ${resolved.length} of ${toProcess.length} users. ${failures.length} failures (check RapidAPI rate limits).`
          : `Successfully resolved all ${resolved.length} users!`,
      sources: debug ? sourceCounts : undefined, 
      results, // Always return results for debugging
      failures_detail: failures // Return failure details
    });
  } catch (e:any) {
    console.error('[Resolve IG User IDs] Error:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
