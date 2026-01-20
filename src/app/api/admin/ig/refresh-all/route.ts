import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60s Vercel Hobby limit - process 1 account per request

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

interface FetchResult {
  username: string;
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
  duration_ms?: number;
}

async function fetchInstagramData(username: string, baseUrl: string, timeout = 27000): Promise<FetchResult> {
  const start = Date.now();
  try {
    // Hint the downstream route to fit within our timeout using budget and pagination caps
    // Aggregator-only mode: do NOT use RapidAPI. The fetch route will try link-based user_id resolution once.
    const url = `${baseUrl}/api/fetch-ig/${encodeURIComponent(username)}?create=1&allow_username=0&aggregator_only=1&max_pages=6&page_size=40&time_budget_ms=${Math.max(5000, Math.min(59000, Math.floor(timeout * 0.95)))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    
    try {
      const res = await fetch(url, { 
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }
      });
      clearTimeout(timer);
      
      let data: any = null;
      const contentType = res.headers.get('content-type');
      
      // Only parse as JSON if content-type is JSON
      if (contentType && contentType.includes('application/json')) {
        try {
          data = await res.json();
        } catch (parseErr) {
          // JSON parse failed
          const text = await res.text().catch(() => 'Unable to read response');
          return { 
            username, 
            ok: false, 
            status: res.status, 
            error: `Invalid JSON response: ${text.substring(0, 100)}`,
            duration_ms: Date.now() - start 
          };
        }
      } else {
        // Not JSON - read as text
        const text = await res.text().catch(() => 'Unable to read response');
        return { 
          username, 
          ok: false, 
          status: res.status, 
          error: `Non-JSON response (${contentType}): ${text.substring(0, 100)}`,
          duration_ms: Date.now() - start 
        };
      }
      
      const duration = Date.now() - start;
      
      if (!res.ok) {
        return { username, ok: false, status: res.status, error: data?.error || 'Failed', duration_ms: duration };
      }
      
      return { username, ok: true, status: 200, data, duration_ms: duration };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  } catch (error: any) {
    const duration = Date.now() - start;
    if (error.name === 'AbortError') {
      return { username, ok: false, status: 408, error: 'Timeout', duration_ms: duration };
    }
    return { username, ok: false, status: 500, error: error.message || 'Unknown error', duration_ms: duration };
  }
}

async function refreshHandler(req: Request) {
  const supa = adminClient();
  const isPost = req.method === 'POST';
  const body = isPost ? await req.json().catch(() => ({})) : {};
  
  const batchSize = Math.max(1, Math.min(100, Number(body?.batch_size || 1)));
  // GUARANTEED ZERO RATE LIMITS: 5 seconds delay (5x slower than limit)
  // Pro plan: 1 req/sec, with 5s delay = safe with faster processing
  const delayMs = Math.max(0, Math.min(30000, Number(body?.delay_ms || 2000))); // Default 2 seconds (FASTER)
  const limit = Math.max(1, Math.min(10000, Number(body?.limit || 1000)));
  const onlyWithUserId = body?.only_with_user_id === true; // default FALSE - fetch all usernames
  const accountsPerBatch = 1; // Process 1 account per batch (FIT within 60s Vercel limit!)
  const autoContinue = body?.auto_continue === true; // default FALSE - manual batch to prevent timeout
  const offset = Math.max(0, Number(body?.offset || 0)); // Track which batch we're on
  // Reduce false positives where downstream finishes at ~20s
  const fetchTimeout = 30000; // 30s timeout
  
  // Get base URL for fetch-ig endpoint
  const protocol = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('host') || 'localhost:3000';
  const baseUrl = `${protocol}://${host}`;
  
  // Persistent retry-queue helpers (DB-backed)
  async function getDueRetry(limitNum: number): Promise<string[]> {
    const { data } = await supa
      .from('refresh_retry_queue')
      .select('username')
      .eq('platform', 'instagram')
      .lte('next_retry_at', new Date().toISOString())
      .order('next_retry_at', { ascending: true })
      .limit(limitNum);
    return (data || []).map((r: any) => r.username);
  }
  async function removeRetry(username: string) {
    await supa.from('refresh_retry_queue').delete().eq('platform', 'instagram').eq('username', username);
  }
  async function enqueueRetry(username: string, errMsg: string) {
    const { data: exist } = await supa
      .from('refresh_retry_queue')
      .select('retry_count')
      .eq('platform', 'instagram')
      .eq('username', username)
      .maybeSingle();
    const count = Number(exist?.retry_count || 0);
    const minutes = Math.min(360, Math.max(2, 2 * Math.pow(2, Math.min(count, 5))));
    const nextAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await supa.from('refresh_retry_queue').upsert({
      platform: 'instagram',
      username,
      last_error: (errMsg || 'Unknown').slice(0, 500),
      retry_count: count + 1,
      last_error_at: new Date().toISOString(),
      next_retry_at: nextAt
    }, { onConflict: 'platform,username' });
  }

  // Collect IG usernames from multiple non-campaign sources (and campaign if exists)
  const set = new Set<string>();
  const norm = (u:string)=> String(u||'').trim().replace(/^@+/, '').toLowerCase();
  try {
    const { data } = await supa.from('user_instagram_usernames').select('instagram_username').limit(limit);
    for (const r of data||[]) if ((r as any).instagram_username) set.add(norm((r as any).instagram_username));
  } catch {}
  try {
    const { data } = await supa.from('users').select('instagram_username').not('instagram_username','is',null).limit(limit);
    for (const r of data||[]) if ((r as any).instagram_username) set.add(norm((r as any).instagram_username));
  } catch {}
  try {
    const { data } = await supa.from('employee_instagram_participants').select('instagram_username').limit(limit);
    for (const r of data||[]) if ((r as any).instagram_username) set.add(norm((r as any).instagram_username));
  } catch {}
  // Optional: existing campaign list (if present)
  try {
    const { data } = await supa.from('campaign_instagram_participants').select('instagram_username').limit(limit);
    for (const r of data||[]) if ((r as any).instagram_username) set.add(norm((r as any).instagram_username));
  } catch {}

  const allUsernames = Array.from(set).slice(0, limit);
  if (!allUsernames.length) {
    return NextResponse.json({ 
      total_usernames: 0, processed: 0, success: 0, failed: 0, message: 'No IG usernames' 
    });
  }

  // Filter by those that have instagram_user_id if requested
  let usernamesToFetch = allUsernames;
  if (onlyWithUserId) {
    const { data: userIds } = await supa
      .from('instagram_user_ids')
      .select('instagram_username')
      .in('instagram_username', allUsernames)
      .not('instagram_user_id', 'is', null);
    
    const withIds = new Set((userIds || []).map((r: any) => r.instagram_username));
    usernamesToFetch = allUsernames.filter(u => withIds.has(u));
  }

  if (usernamesToFetch.length === 0) {
    return NextResponse.json({
      total_usernames: allUsernames.length,
      usernames_with_ids: 0,
      processed: 0,
      success: 0,
      failed: 0,
      message: 'No usernames with resolved instagram_user_id found'
    });
  }

  // Sequential fetch with delay between each request to avoid rate limits
  const allResults: FetchResult[] = [];
  const batchProgress: Array<{
    batch: number;
    accounts: string[];
    success: number;
    failed: number;
    duration_ms: number;
  }> = [];
  
  let totalSuccess = 0;
  let totalFailed = 0;
  // Allow multiple inline retries while keeping within time budget
  const maxRetries = 10;
  const failedAccountsQueue: string[] = []; // Track failed accounts to retry in next batch
  
  // CRITICAL: ALWAYS process ONLY 1 batch per request to avoid timeout
  // Client will auto-trigger next batch via setTimeout in admin page
  const totalBatches = Math.ceil(usernamesToFetch.length / accountsPerBatch);
  const startBatch = Math.floor(offset / accountsPerBatch);
  const endBatch = startBatch + 1; // ALWAYS 1 batch only (client handles continuation)
  
  for (let batchNum = startBatch; batchNum < endBatch; batchNum++) {
    const batchStart = batchNum * accountsPerBatch;
    const batchEnd = Math.min(batchStart + accountsPerBatch, usernamesToFetch.length);
    let batchUsernames = usernamesToFetch.slice(batchStart, batchEnd);
    let processingRetry = false;
    
    // Prefer persistent retry queue first
    const dueRetry = await getDueRetry(accountsPerBatch);
    if (dueRetry.length > 0) {
      batchUsernames = dueRetry.slice(0, accountsPerBatch);
      processingRetry = true;
      console.log(`[Instagram Refresh] 🔁 Processing RETRY QUEUE first: ${batchUsernames.join(', ')}`);
    }
    
    // CRITICAL: Prepend failed accounts from previous batch to RETRY them first
    if (failedAccountsQueue.length > 0) {
      const retryAccounts = [...failedAccountsQueue];
      failedAccountsQueue.length = 0; // Clear queue
      batchUsernames = [...retryAccounts, ...batchUsernames];
      console.log(`[Instagram Refresh] 🔄 RETRY: Adding ${retryAccounts.length} failed accounts to batch ${batchNum + 1}: ${retryAccounts.join(', ')}`);
    }
    
    const batchStartTime = Date.now();
    const batchResults: FetchResult[] = [];
    let batchSuccess = 0;
    let batchFailed = 0;
    
    console.log(`[Instagram Refresh] Batch ${batchNum + 1}/${totalBatches}: Processing ${batchUsernames.length} accounts (${batchUsernames.join(', ')})`);
    
    for (let i = 0; i < batchUsernames.length; i++) {
      const username = batchUsernames[i];
      
      // Retry logic for reliability - ZERO DATA LOSS
      let result: FetchResult | null = null;
      let attempt = 0;
      const usernameStart = Date.now();
      
      while (attempt <= maxRetries) {
        result = await fetchInstagramData(username, baseUrl, fetchTimeout);
        
        // Success - break retry loop
        if (result.ok) {
          break;
        }
        // Stop retry if not found
        if (result.status === 404) {
          console.log(`[Instagram Refresh] ${username} not found (404). Skipping further retries.`);
          break;
        }
        // Time budget safeguard (keep ~8s buffer)
        const elapsed = Date.now() - usernameStart;
        if (elapsed > 52000) {
          console.log(`[Instagram Refresh] Time budget exceeded for ${username} after ${attempt} attempts.`);
          break;
        }
        
        // If rate limited, wait shorter to fit in 60s timeout
        if (result.status === 429 && attempt < maxRetries) {
          console.log(`[Instagram Refresh] Rate limited on ${username}, waiting 5s before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          attempt++;
          continue;
        }
        
        // If server error or timeout, retry with short delay
        if ((result.status >= 500 || result.status === 408) && attempt < maxRetries) {
          console.log(`[Instagram Refresh] Error ${result.status} on ${username}, retrying ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          attempt++;
          continue;
        }
        
        // Other errors - break and record as failed
        break;
      }
      
      batchResults.push(result!);
      allResults.push(result!);
      
      // VALIDATION: Ensure response has actual data
      if (result && result.ok) {
        if (processingRetry) {
          await removeRetry(username);
        }
        const inserted = result.data?.inserted || 0;
        const views = result.data?.instagram?.views || 0;
        if (inserted === 0 && views === 0) {
          console.warn(`[Instagram Refresh] WARNING: ${username} returned ZERO data (empty account or API issue)`);
          // PATCH: Force insert 0-row to social_metrics_history for visibility
          try {
            const normU = String(username).trim().replace(/^@+/, '').toLowerCase();
            let ownerUserId: string | null = null;
            try {
              const { data: u1 } = await supa.from('users').select('id').eq('instagram_username', normU).maybeSingle(); if (u1?.id) ownerUserId = String(u1.id);
              if (!ownerUserId) { const { data: u2 } = await supa.from('user_instagram_usernames').select('user_id').eq('instagram_username', normU).maybeSingle(); if (u2?.user_id) ownerUserId = String(u2.user_id); }
            } catch {}
            if (ownerUserId) {
              const nowIso = new Date().toISOString();
              await supa.from('social_metrics_history').insert({
                user_id: ownerUserId,
                platform: 'instagram',
                followers: 0,
                likes: 0,
                views: 0,
                comments: 0,
                shares: 0,
                saves: 0,
                captured_at: nowIso
              });
            }
          } catch (e) {
            console.warn('[Instagram Refresh] Failed to force-insert 0-row to social_metrics_history for', username, e);
          }
        }
        // NEW: Aggregate into social_metrics/history like TikTok
        try {
          const normU = String(username).trim().replace(/^@+/, '').toLowerCase();
          let ownerUserId: string | null = null;
          try {
            const { data: u1 } = await supa.from('users').select('id').eq('instagram_username', normU).maybeSingle(); if (u1?.id) ownerUserId = String(u1.id);
            if (!ownerUserId) { const { data: u2 } = await supa.from('user_instagram_usernames').select('user_id').eq('instagram_username', normU).maybeSingle(); if (u2?.user_id) ownerUserId = String(u2.user_id); }
          } catch {}
          if (ownerUserId) {
            const handles = new Set<string>();
            try { const { data: pr } = await supa.from('users').select('instagram_username').eq('id', ownerUserId).maybeSingle(); if (pr?.instagram_username) handles.add(String(pr.instagram_username).replace(/^@+/, '').toLowerCase()); } catch {}
            try { const { data: extras } = await supa.from('user_instagram_usernames').select('instagram_username').eq('user_id', ownerUserId); for (const r of extras||[]) handles.add(String((r as any).instagram_username).replace(/^@+/, '').toLowerCase()); } catch {}
            if (handles.size) {
              const list = Array.from(handles);
              // LIFETIME TOTALS for social_metrics: compute with DB aggregation to avoid arithmetic drift
              // Query all rows for this user (for fallback logic)
              const { data: rows } = await supa
                .from('instagram_posts_daily')
                .select('id')
                .in('username', list);
              const { data: totals } = await supa
                .from('instagram_posts_daily')
                .select('views:sum(play_count),likes:sum(like_count),comments:sum(comment_count),posts_total:count(id)')
                .in('username', list)
                .single();
              let agg = { views:0, likes:0, comments:0 } as any;
              if (totals && ((totals as any).posts_total > 0 || Number((totals as any).views||0) > 0)) {
                agg = {
                  views: Number((totals as any)?.views||0) || 0,
                  likes: Number((totals as any)?.likes||0) || 0,
                  comments: Number((totals as any)?.comments||0) || 0,
                };
              }
              // If posts_daily produced zero rows (aggregator-only with missing timestamps), fallback to response totals
              if ((rows?.length || 0) === 0) {
                const respTotals = {
                  views: Number(result.data?.total_views || result.data?.instagram?.views || 0) || 0,
                  likes: Number(result.data?.total_likes || result.data?.instagram?.likes || 0) || 0,
                  comments: Number(result.data?.total_comments || result.data?.instagram?.comments || 0) || 0,
                };
                if (respTotals.views + respTotals.likes + respTotals.comments > 0) {
                  agg = respTotals;
                }
              }
              const nowIso = new Date().toISOString();
              await supa.from('social_metrics').upsert({ user_id: ownerUserId, platform: 'instagram', followers: 0, likes: agg.likes, views: agg.views, comments: agg.comments, shares: 0, saves: 0, last_updated: nowIso }, { onConflict: 'user_id,platform' });
              try {
                await supa.from('social_metrics_history').insert({ user_id: ownerUserId, platform: 'instagram', followers: 0, likes: agg.likes, views: agg.views, comments: agg.comments, shares: 0, saves: 0, captured_at: nowIso });
              } catch {}
            }
          }
        } catch (e) {
          console.warn('[Instagram Refresh] Failed to update social_metrics for', username, e);
        }
        batchSuccess++;
        totalSuccess++;
      }
      if (!result || !result.ok) {
        // FAILED: enqueue to persistent retry queue and mark this batch failed
        failedAccountsQueue.push(username);
        const errMsg = result?.error || `HTTP ${result?.status || '500'}`;
        await enqueueRetry(username, errMsg);
        console.warn(`[Instagram Refresh] ⚠️ ${username} FAILED, queued for RETRY`);
        batchFailed++;
        totalFailed++;
      }
      
      // Delay after EACH request to avoid rate limits (except last one in batch)
      if (i < batchUsernames.length - 1 && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    const batchDuration = Date.now() - batchStartTime;
    batchProgress.push({
      batch: batchNum + 1,
      accounts: batchUsernames,
      success: batchSuccess,
      failed: batchFailed,
      duration_ms: batchDuration
    });
    
    console.log(`[Instagram Refresh] Batch ${batchNum + 1}/${totalBatches} completed: ${batchSuccess} success, ${batchFailed} failed, ${Math.round(batchDuration/1000)}s`);
    
    // Small delay between batches (2 seconds) - only if auto-continue
    if (autoContinue && batchNum < endBatch - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Aggregate statistics
  const successResults = allResults.filter(r => r.ok);
  const failedResults = allResults.filter(r => !r.ok);
  
  const totalPosts = successResults.reduce((sum, r) => sum + (r.data?.inserted || 0), 0);
  const totalViews = successResults.reduce((sum, r) => sum + (r.data?.total_views || r.data?.instagram?.views || 0), 0);
  const totalLikes = successResults.reduce((sum, r) => sum + (r.data?.total_likes || r.data?.instagram?.likes || 0), 0);
  const avgDuration = allResults.length > 0 
    ? Math.round(allResults.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / allResults.length)
    : 0;

  // Auto-refresh employee total metrics after successful refresh
  if (totalSuccess > 0) {
    try {
      await supa.rpc('refresh_employee_total_metrics');
      console.log('[Instagram Refresh] Employee metrics refreshed');
    } catch (e) {
      console.error('[Instagram Refresh] Failed to refresh employee metrics:', e);
    }
  }

  // Advance offset regardless of success so failed accounts don't block the queue.
  // Failures are persisted in retry_queue with backoff and will be processed later.
  const processedCount = offset + allResults.length;
  const remainingCount = Math.max(0, usernamesToFetch.length - processedCount);
  const nextOffset = remainingCount > 0 ? processedCount : 0;
  
  // CRITICAL ERROR LOGGING: Alert if any accounts failed after all retries
  if (totalFailed > 0) {
    const failedUsernames = failedResults.map(r => r.username).join(', ');
    console.error(`[Instagram Refresh] ⚠️ CRITICAL: ${totalFailed} accounts FAILED after ${maxRetries} retries: ${failedUsernames}`);
    console.error('[Instagram Refresh] Failed details:', failedResults.map(r => ({ username: r.username, status: r.status, error: r.error })));
  } else {
    console.log(`[Instagram Refresh] ✅ SUCCESS: All ${totalSuccess} accounts refreshed successfully`);
  }

  return NextResponse.json({
    total_usernames: allUsernames.length,
    usernames_with_ids: usernamesToFetch.length,
    total_batches: totalBatches,
    current_batch: startBatch + 1,
    batches_processed: batchProgress.length,
    processed: allResults.length,
    total_processed: processedCount,
    success: totalSuccess,
    failed: totalFailed,
    remaining: remainingCount,
    offset: offset,
    next_offset: nextOffset,
    total_posts_inserted: totalPosts,
    total_views: totalViews,
    total_likes: totalLikes,
    avg_duration_ms: avgDuration,
    auto_continue: autoContinue,
    message: remainingCount > 0
      ? `Batch ${startBatch + 1}/${totalBatches}: Processed ${allResults.length} accounts (${processedCount}/${usernamesToFetch.length} total). Click refresh to continue with next ${Math.min(accountsPerBatch, remainingCount)} accounts.`
      : `All ${usernamesToFetch.length} accounts processed successfully!`,
    batch_progress: batchProgress,
    batch_size: batchSize,
    accounts_per_batch: accountsPerBatch,
    delay_ms: delayMs,
    results: body?.include_details ? allResults : undefined,
    retry_queue: failedAccountsQueue.length,
    retry_queue_usernames: failedAccountsQueue,
    retry_queue_pending: (await getDueRetry(1000)).length,
    failed_usernames: failedResults.length > 0 ? failedResults.map(r => ({ 
      username: r.username, 
      error: r.error,
      status: r.status 
    })) : undefined,
    success_details: body?.include_details ? successResults.map(r => ({
      username: r.username,
      posts: r.data?.inserted || 0,
      views: r.data?.total_views || r.data?.instagram?.views || 0,
      likes: r.data?.total_likes || r.data?.instagram?.likes || 0,
      source: r.data?.source
    })) : undefined
  });
}

export async function GET(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[ig refresh-all GET] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Failed to refresh Instagram data',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[ig refresh-all POST] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Failed to refresh Instagram data',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}

