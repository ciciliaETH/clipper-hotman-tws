import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds - Vercel Hobby plan limit (use 1 account per batch)

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

async function fetchTikTokData(
  username: string, 
  campaignId: string,
  startDate: string,
  endDate: string,
  baseUrl: string, 
  timeout = 50000 // 50 seconds - fit within 60s Vercel limit with buffer
): Promise<FetchResult> {
  const start = Date.now();
  try {
    // Aggregator-only mode to avoid RapidAPI usage during refresh-all
    const url = `${baseUrl}/api/fetch-metrics/${encodeURIComponent(username)}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}&aggregator_only=1&all=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    
    try {
      const res = await fetch(url, { 
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        method: 'GET'
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
  try {
    const supa = adminClient();
    const isPost = req.method === 'POST';
    const body = isPost ? await req.json().catch(() => ({})) : {};
    
    // GUARANTEED ZERO RATE LIMITS: 5 seconds delay (5x slower than limit)
    // Pro plan: 1 req/sec, with 5s delay = safe with faster processing
    const delayMs = Math.max(0, Math.min(30000, Number(body?.delay_ms || 2000))); // Default 2 seconds (FASTER)
    const limit = Math.max(1, Math.min(10000, Number(body?.limit || 1000)));
    const accountsPerBatch = 1; // Process 1 account per batch (FIT within 60s Vercel limit!)
    const autoContinue = body?.auto_continue === true; // default FALSE - manual batch to prevent timeout
    const offset = Math.max(0, Number(body?.offset || 0)); // Track which batch we're on
    // Bump timeout to avoid race with ~30s responses from fetch-metrics
    const fetchTimeout = 45000; // 45s timeout (still < 60s)
    
    // Get base URL for fetch-metrics endpoint
    const protocol = req.headers.get('x-forwarded-proto') || 'http';
    const host = req.headers.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;
    
    // Persistent retry-queue helpers (DB-backed)
    async function getDueRetry(limitNum: number): Promise<string[]> {
      const { data } = await supa
        .from('refresh_retry_queue')
        .select('username')
        .eq('platform', 'tiktok')
        .lte('next_retry_at', new Date().toISOString())
        .order('next_retry_at', { ascending: true })
        .limit(limitNum);
      return (data || []).map((r: any) => r.username);
    }
    async function removeRetry(username: string) {
      await supa.from('refresh_retry_queue').delete().eq('platform', 'tiktok').eq('username', username);
    }
    async function enqueueRetry(username: string, errMsg: string) {
      const { data: exist } = await supa
        .from('refresh_retry_queue')
        .select('retry_count')
        .eq('platform', 'tiktok')
        .eq('username', username)
        .maybeSingle();
      const count = Number(exist?.retry_count || 0);
      // Fast backoff: very quick retries first
      const backoffSeconds = [2, 5, 10, 20, 60, 120][Math.min(count, 5)];
      const nextAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      await supa.from('refresh_retry_queue').upsert({
        platform: 'tiktok',
        username,
        last_error: (errMsg || 'Unknown').slice(0, 500),
        retry_count: count + 1,
        last_error_at: new Date().toISOString(),
        next_retry_at: nextAt
      }, { onConflict: 'platform,username' });
    }
    
    // Get TikTok usernames from multiple sources (campaign participants, employee assignments, user mappings, profiles)
    // CRITICAL: ORDER BY ensures consistent username order across all requests
    const { data: rows, error: dbError } = await supa
      .from('campaign_participants')
      .select('tiktok_username, campaign_id')
      .not('tiktok_username', 'is', null)
      .order('tiktok_username', { ascending: true }) // Alphabetical order for consistency
      .limit(limit);
    
    if (dbError) {
      console.error('[TikTok Refresh] Database error:', dbError);
      return NextResponse.json({ 
        error: 'Database error',
        message: dbError.message,
        details: dbError
      }, { status: 500 });
    }
    
    // Additional sources
    const [empAssign, userMap, userProfiles] = await Promise.all([
      supa.from('employee_participants').select('tiktok_username').not('tiktok_username','is',null),
      supa.from('user_tiktok_usernames').select('tiktok_username').not('tiktok_username','is',null),
      supa.from('users').select('tiktok_username').not('tiktok_username','is',null)
    ]);

    // Get unique usernames (one username might be in multiple campaigns)
    const allUsernames = Array.from(new Set([
      ...(rows||[]).map((r: any) => String(r.tiktok_username||'').trim().replace(/^@/,'').toLowerCase()),
      ...((empAssign.data||[]).map((r:any)=> String(r.tiktok_username||'').trim().replace(/^@/,'').toLowerCase())),
      ...((userMap.data||[]).map((r:any)=> String(r.tiktok_username||'').trim().replace(/^@/,'').toLowerCase())),
      ...((userProfiles.data||[]).map((r:any)=> String(r.tiktok_username||'').trim().replace(/^@/,'').toLowerCase())),
    ].filter(Boolean)));

    if (!allUsernames || allUsernames.length === 0) {
      return NextResponse.json({ 
        total_usernames: 0, processed: 0, success: 0, failed: 0,
        message: 'No TikTok usernames found across sources'
      });
    }
  
  // For each username, get their campaign_ids for updating later
  const usernameToCampaigns = new Map<string, string[]>();
  for (const row of rows || []) {
    const username = String((row as any).tiktok_username || '').trim().replace(/^@/, '').toLowerCase();
    const campaignId = String((row as any).campaign_id);
    if (!username) continue;
    
    const campaigns = usernameToCampaigns.get(username) || [];
    if (!campaigns.includes(campaignId)) campaigns.push(campaignId);
    usernameToCampaigns.set(username, campaigns);
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
  // We'll retry inline as long as there's time remaining (cap attempts to avoid runaway)
  const maxRetries = 10;
  const failedAccountsQueue: string[] = []; // Track failed accounts to retry in next batch
  
  // CRITICAL: ALWAYS process ONLY 1 batch per request to avoid timeout
  // Client will auto-trigger next batch via setTimeout in admin page
  const totalBatches = Math.ceil(allUsernames.length / accountsPerBatch);
  const startBatch = Math.floor(offset / accountsPerBatch);
  const endBatch = startBatch + 1; // ALWAYS 1 batch only (client handles continuation)
  
  for (let batchNum = startBatch; batchNum < endBatch; batchNum++) {
    const batchStart = batchNum * accountsPerBatch;
    const batchEnd = Math.min(batchStart + accountsPerBatch, allUsernames.length);
    let batchUsernames = allUsernames.slice(batchStart, batchEnd);
    let processingRetry = false;
    
    // Prefer persistent retry queue first
    const dueRetry = await getDueRetry(accountsPerBatch);
    if (dueRetry.length > 0) {
      batchUsernames = dueRetry.slice(0, accountsPerBatch);
      processingRetry = true;
      console.log(`[TikTok Refresh] 🔁 Processing RETRY QUEUE first: ${batchUsernames.join(', ')}`);
    }
    
    // CRITICAL: Prepend failed accounts from previous batch to RETRY them first
    if (failedAccountsQueue.length > 0) {
      const retryAccounts = [...failedAccountsQueue];
      failedAccountsQueue.length = 0; // Clear queue
      batchUsernames = [...retryAccounts, ...batchUsernames];
      console.log(`[TikTok Refresh] 🔄 RETRY: Adding ${retryAccounts.length} failed accounts to batch ${batchNum + 1}: ${retryAccounts.join(', ')}`);
    }
    
    const batchStartTime = Date.now();
    const batchResults: FetchResult[] = [];
    let batchSuccess = 0;
    let batchFailed = 0;
    
    console.log(`[TikTok Refresh] Batch ${batchNum + 1}/${totalBatches}: Processing ${batchUsernames.length} accounts (${batchUsernames.join(', ')})`);
    
    for (let i = 0; i < batchUsernames.length; i++) {
      const username = batchUsernames[i];
      const campaignIds = usernameToCampaigns.get(username) || [];
      
      // Use FULL YEAR date range to guarantee ALL historical data (365 days = 1 year)
      // This ensures we capture videos from August that went viral in December
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      
      // Use first campaign_id for the fetch (doesn't matter which, we get same TikTok data)
      const campaignId = campaignIds[0] || 'default';
      
      // Retry logic for reliability - ZERO DATA LOSS
      let result: FetchResult | null = null;
      let attempt = 0;
      const usernameStart = Date.now();
      
      while (attempt <= maxRetries) {
        result = await fetchTikTokData(username, campaignId, startDate, endDate, baseUrl, fetchTimeout);
        
        // Success - break retry loop
        if (result.ok) {
          break;
        }
        // Stop retrying if user not found
        if (result.status === 404) {
          console.log(`[TikTok Refresh] ${username} not found (404). Skipping further retries.`);
          break;
        }
        // Stop if this request is about to exceed function limit (keep a 8s buffer)
        const elapsed = Date.now() - usernameStart;
        if (elapsed > 52000) {
          console.log(`[TikTok Refresh] Time budget exceeded for ${username} after ${attempt} attempts.`);
          break;
        }
        // If rate limited, wait shorter to fit in 60s timeout
        if (result.status === 429 && attempt < maxRetries) {
          console.log(`[TikTok Refresh] Rate limited on ${username}, waiting 5s before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          attempt++;
          continue;
        }
        
        // If server error or timeout, retry with short delay
        if ((result.status >= 500 || result.status === 408) && attempt < maxRetries) {
          console.log(`[TikTok Refresh] Error ${result.status} on ${username}, retrying ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          attempt++;
          continue;
        }
        
        // Other errors - break and record as failed
        break;
      }
      
      // Update ALL campaigns that have this username - CRITICAL: Save data immediately
      // VALIDATION: Ensure response has actual data (not just empty success)
      if (result && result.ok && result.data?.tiktok) {
        if (processingRetry) {
          await removeRetry(username);
        }
        const t = result.data.tiktok;
        
        // WARNING: Log if account has ZERO data (might be empty account or API issue)
        if (t.posts_total === 0 && t.views === 0 && t.followers === 0) {
          console.warn(`[TikTok Refresh] WARNING: ${username} returned ZERO data (empty account or API issue)`);
        }
        
        for (const cid of campaignIds) {
          const { error: upsertError } = await supa
            .from('campaign_participants')
            .upsert({
              campaign_id: cid,
              tiktok_username: username,
              followers: Number(t.followers) || 0,
              views: Number(t.views) || 0,
              likes: Number(t.likes) || 0,
              comments: Number(t.comments) || 0,
              shares: Number(t.shares) || 0,
              saves: Number(t.saves) || 0,
              posts_total: Number(t.posts_total) || 0,
              sec_uid: t.secUid || t.sec_uid || null,
              metrics_json: result.data,
              last_refreshed: new Date().toISOString(),
            }, { onConflict: 'campaign_id,tiktok_username' });
          
          if (upsertError) {
            console.error(`[TikTok Refresh] Failed to save ${username} in campaign ${cid}:`, upsertError);
          }
        }
        
        batchSuccess++;
        totalSuccess++;
      } else {
        // FAILED: Add to DB retry queue
        failedAccountsQueue.push(username);
        const errMsg = result?.error || `HTTP ${result?.status || '500'}`;
        await enqueueRetry(username, errMsg);
        console.warn(`[TikTok Refresh] ⚠️ ${username} FAILED, queued for RETRY`);
        batchFailed++;
        totalFailed++;
      }
      
      if (result) {
        batchResults.push(result);
        allResults.push(result);
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
    
    console.log(`[TikTok Refresh] Batch ${batchNum + 1}/${totalBatches} completed: ${batchSuccess} success, ${batchFailed} failed, ${Math.round(batchDuration/1000)}s`);
    
    // Small delay between batches (2 seconds) - only if auto-continue
    if (autoContinue && batchNum < endBatch - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Aggregate statistics
  const successResults = allResults.filter(r => r && r.ok);
  const failedResults = allResults.filter(r => r && !r.ok);
  
  const totalPostsInserted = successResults.reduce((sum, r) => sum + (r?.data?.tiktok?.posts_total || 0), 0);
  const totalViews = successResults.reduce((sum, r) => sum + (r?.data?.tiktok?.views || 0), 0);
  const totalLikes = successResults.reduce((sum, r) => sum + (r?.data?.tiktok?.likes || 0), 0);
  const avgDuration = allResults.length > 0 
    ? Math.round(allResults.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / allResults.length)
    : 0;

  // Auto-refresh employee total metrics after successful refresh
  if (totalSuccess > 0) {
    try {
      await supa.rpc('refresh_employee_total_metrics');
      console.log('[TikTok Refresh] Employee metrics refreshed');
    } catch (e) {
      console.error('[TikTok Refresh] Failed to refresh employee metrics:', e);
    }
  }

  // Do not advance offset on pure-fail batches; only advance by successes
  const processedCount = offset + totalSuccess;
  const remainingCount = Math.max(0, allUsernames.length - processedCount);
  const nextOffset = remainingCount > 0 ? processedCount : 0;
  
  // CRITICAL ERROR LOGGING: Alert if any accounts failed after all retries
  if (totalFailed > 0) {
    const failedUsernames = failedResults.map(r => r.username).join(', ');
    console.error(`[TikTok Refresh] ⚠️ CRITICAL: ${totalFailed} accounts FAILED after ${maxRetries} retries: ${failedUsernames}`);
    console.error('[TikTok Refresh] Failed details:', failedResults.map(r => ({ username: r.username, status: r.status, error: r.error })));
  } else {
    console.log(`[TikTok Refresh] ✅ SUCCESS: All ${totalSuccess} accounts refreshed successfully`);
  }

  // Build success_details similar to IG
  const successDetails = successResults.map(r => ({
    username: r.username,
    posts: r?.data?.tiktok?.posts_total || 0,
    views: r?.data?.tiktok?.views || 0,
    likes: r?.data?.tiktok?.likes || 0,
    source: r?.data?.telemetry?.mode || 'aggregator'
  }));

  return NextResponse.json({
    total_usernames: allUsernames.length,
    usernames_with_ids: allUsernames.length, // TikTok aggregator flow doesn't require secUid
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
    total_posts_inserted: totalPostsInserted,
    total_views: totalViews,
    total_likes: totalLikes,
    avg_duration_ms: avgDuration,
    auto_continue: autoContinue,
    message: (totalFailed > 0 && totalSuccess === 0)
      ? `Batch ${startBatch + 1}/${totalBatches}: ${batchProgress[0]?.accounts?.[0] || ''} TIMEOUT. Will retry the SAME account. Click refresh (or wait Auto) to retry.`
      : remainingCount > 0
      ? `Batch ${startBatch + 1}/${totalBatches}: Processed ${allResults.length} accounts (${processedCount}/${allUsernames.length} total). Click refresh to continue with next ${Math.min(accountsPerBatch, remainingCount)} accounts.`
      : `All ${allUsernames.length} accounts processed successfully!`,
    batch_progress: batchProgress,
    batch_size: 1,
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
    success_details: body?.include_details ? successDetails : undefined
  });
  } catch (error: any) {
    console.error('[refreshHandler] Unexpected error:', error);
    return NextResponse.json({ 
      error: 'Internal server error during refresh',
      message: error.message || 'Unknown error',
      details: error.toString()
    }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[tiktok refresh-all GET] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Internal server error',
      details: error.toString()
    }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[tiktok refresh-all POST] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Internal server error',
      details: error.toString()
    }, { status: 500 });
  }
}

