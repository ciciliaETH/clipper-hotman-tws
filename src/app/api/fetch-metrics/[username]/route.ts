import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdmin } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { rapidApiRequest } from '@/lib/rapidapi';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds - Vercel Hobby plan limit

// ========================================
// AGGREGATOR API - PRIORITY #1 (UNLIMITED)
// ========================================
const AGGREGATOR_BASE = process.env.AGGREGATOR_API_BASE || 'http://202.10.44.90/api/v1';
const AGGREGATOR_ENABLED = process.env.AGGREGATOR_ENABLED !== '0'; // Default: enabled
const AGGREGATOR_UNLIMITED = process.env.AGGREGATOR_UNLIMITED !== '0'; // Default: unlimited
const AGGREGATOR_MAX_PAGES = Number(process.env.AGGREGATOR_MAX_PAGES || '10'); // Limit to 10 pages for 60s timeout
const AGGREGATOR_PER_PAGE = Number(process.env.AGGREGATOR_PER_PAGE || '100'); // 100 per page (faster)
const AGGREGATOR_RATE_MS = Number(process.env.AGGREGATOR_RATE_MS || '200'); // 200ms delay (faster)

// ========================================
// RAPIDAPI - FALLBACK #2
// ========================================
const TIKTOK_RAPID_HOST = process.env.RAPIDAPI_TIKTOK_HOST || 'tiktok-scraper7.p.rapidapi.com';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const RAPID_CURSOR_ON = process.env.RAPIDAPI_USE_CURSOR === '1';
const RAPID_PROVIDER = (process.env.RAPIDAPI_PROVIDER || 'fast').toLowerCase(); // 'fast' | 'api15'
const RAPID_FALLBACK_ON_429 = process.env.RAPIDAPI_FALLBACK_ON_429 !== '0';
const RAPID_CURSOR_MAX_ITER = Number(process.env.RAPIDAPI_MAX_ITER || '999'); // Unlimited
const RAPID_CURSOR_RATE_MS = Number(process.env.RAPIDAPI_RATE_LIMIT_MS || '350');
const RAPID_CURSOR_LIMIT = process.env.RAPIDAPI_LIMIT ? Number(process.env.RAPIDAPI_LIMIT) : undefined;

// --- Helper function to safely parse numbers ---
const safeParseInt = (value: any) => {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 0 : parsed;
};

// --- Helpers to derive a stable video_id and aweme_id ---
function getQueryParam(url: string, key: string): string | undefined {
  try {
    const u = new URL(url);
    const v = u.searchParams.get(key);
    return v || undefined;
  } catch {
    return undefined;
  }
}

function deriveVideoIds(post: any): { video_id?: string; aweme_id?: string } {
  // Extract both video_id (for URL) and aweme_id (internal TikTok ID)
  const result: { video_id?: string; aweme_id?: string } = {};
  
  // video_id is what appears in URLs (numeric, e.g., "7579465085903539472")
  // PRIORITIZE video_id first since it's the correct one for URLs
  const videoId = post?.video_id
    || post?.videoId
    || post?.item_id
    || post?.itemId
    || post?.video?.id
    || post?.video?.video_id
    || post?.itemInfos?.id;
  
  if (videoId) result.video_id = String(videoId);
  
  // aweme_id is the internal TikTok identifier (alphanumeric, e.g., "v14044g50000d4nqmanog65soi3j95dg")
  const awemeId = post?.aweme_id 
    || post?.awemeId 
    || post?.id;
  if (awemeId) result.aweme_id = String(awemeId);

  // Try from known url lists to extract video_id from query params (fallback)
  if (!result.video_id) {
    const candidates: any[] = [];
    const pushList = (val: any) => {
      if (!val) return;
      if (Array.isArray(val)) candidates.push(...val);
      else candidates.push(val);
    };

    pushList(post?.urlList);
    pushList(post?.video?.urlList);
    pushList(post?.playAddr?.urlList);
    pushList(post?.video?.playAddr);

    for (const u of candidates) {
      if (typeof u !== 'string') continue;
      const itemId = getQueryParam(u, 'item_id');
      if (itemId) {
        result.video_id = itemId;
        break;
      }
      const vid = getQueryParam(u, 'video_id');
      if (vid) {
        result.video_id = vid;
        break;
      }
    }
  }

  // Last resort fallback: if no video_id found, use aweme_id as video_id
  if (!result.video_id && result.aweme_id) {
    result.video_id = result.aweme_id;
  }

  return result;
}

// Legacy function for backward compatibility
function deriveVideoId(post: any): string | undefined {
  const ids = deriveVideoIds(post);
  return ids.video_id || ids.aweme_id;
}

// ========================================
// AGGREGATOR API FETCH (UNLIMITED)
// ========================================
async function fetchFromAggregator(
  username: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<{ videos: any[]; success: boolean; source: 'aggregator'; totalFetched: number }> {
  const normalized = username.replace(/^@/, '').toLowerCase();
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const seen = new Set<string>();
  const allVideos: any[] = [];
  
  console.log(`[Aggregator] Starting unlimited fetch for @${normalized}`);
  console.log(`[Aggregator] Date range: ${startDate || 'ALL'} to ${endDate || 'NOW'}`);
  
  // Strategy: Fetch in 90-day windows for deep historical data
  const now = new Date();
  const endBound = endDate ? new Date(endDate + 'T23:59:59Z') : now;
  const startBound = startDate ? new Date(startDate + 'T00:00:00Z') : new Date('2016-01-01'); // TikTok launch
  
  let windowEnd = new Date(endBound);
  let totalPages = 0;
  let emptyWindows = 0;
  
  // Fetch in reverse chronological order (newest to oldest)
  while (windowEnd > startBound && emptyWindows < 3) {
    // 90-day window for efficient pagination
    const windowStart = new Date(Math.max(
      startBound.getTime(),
      windowEnd.getTime() - (90 * 24 * 60 * 60 * 1000)
    ));
    
    const windowStartStr = windowStart.toISOString().slice(0, 10);
    const windowEndStr = windowEnd.toISOString().slice(0, 10);
    
    console.log(`[Aggregator] Window: ${windowStartStr} to ${windowEndStr}`);
    
    let cursor: string | undefined = undefined;
    let windowVideos = 0;
    let sameCursor = 0;
    let noNewData = 0;
    
    for (let page = 0; page < AGGREGATOR_MAX_PAGES; page++) {
      totalPages++;
      
      try {
        const url = new URL(`${AGGREGATOR_BASE}/user/posts`);
        url.searchParams.set('username', normalized);
        url.searchParams.set('count', String(AGGREGATOR_PER_PAGE));
        url.searchParams.set('start', windowStartStr);
        url.searchParams.set('end', windowEndStr);
        if (cursor) url.searchParams.set('cursor', cursor);
        
        const response = await fetch(url.toString(), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(30000)
        });
        
        if (!response.ok) {
          console.error(`[Aggregator] HTTP ${response.status} on page ${page + 1}`);
          break;
        }
        
        const json = await response.json();
        const videos = json?.data?.videos || [];
        
        if (!Array.isArray(videos) || videos.length === 0) {
          noNewData++;
          if (noNewData >= 2) break; // No more data in this window
        }
        
        let addedThisPage = 0;
        for (const video of videos) {
          const videoId = video.aweme_id || video.video_id || video.id;
          const key = String(videoId || '');
          if (!key || seen.has(key)) continue;
          
          seen.add(key);
          allVideos.push(video);
          addedThisPage++;
          windowVideos++;
        }
        
        console.log(`[Aggregator] Page ${page + 1}: +${addedThisPage} videos (window total: ${windowVideos})`);
        
        if (addedThisPage > 0) noNewData = 0;
        
        // Check for next cursor
        const nextCursor = json?.data?.cursor || json?.data?.next_cursor;
        const hasMore = json?.data?.hasMore || json?.data?.has_more;
        
        if (!hasMore || !nextCursor) break;
        
        if (cursor === nextCursor) {
          sameCursor++;
          if (sameCursor >= 2) break;
        } else {
          sameCursor = 0;
        }
        
        cursor = String(nextCursor);
        await sleep(AGGREGATOR_RATE_MS);
        
      } catch (error: any) {
        console.error(`[Aggregator] Error on page ${page + 1}:`, error.message);
        break;
      }
    }
    
    if (windowVideos === 0) {
      emptyWindows++;
    } else {
      emptyWindows = 0;
    }
    
    // Move to previous window
    windowEnd = new Date(windowStart.getTime() - 1);
    await sleep(AGGREGATOR_RATE_MS);
  }
  
  console.log(`[Aggregator] Completed: ${allVideos.length} unique videos from ${totalPages} pages`);
  
  return {
    videos: allVideos,
    success: allVideos.length > 0,
    source: 'aggregator',
    totalFetched: allVideos.length
  };
}

// Helper to read stats across different shapes
function readStat(post: any, key: 'play'|'digg'|'comment'|'share'|'save') {
  const tryKeys: string[] = []
  if (key === 'play') tryKeys.push('playCount','play_count','play')
  if (key === 'digg') tryKeys.push('diggCount','likeCount','likes','digg_count')
  if (key === 'comment') tryKeys.push('commentCount','comments','comment_count')
  if (key === 'share') tryKeys.push('shareCount','shares','share_count')
  if (key === 'save') tryKeys.push('saveCount','collectCount','favoriteCount','save_count')
  const sources = [post?.statsV2, post?.stats, post?.statistics, post] as any[]
  for (const src of sources) {
    if (!src) continue
    for (const k of tryKeys) {
      const v = src[k]
      if (v !== undefined && v !== null) return safeParseInt(v)
    }
  }
  return 0
}

// --- Real-time data fetching function (TikTok only) ---
// TikTok Data Fetcher (RapidAPI)
async function getTikTokData(username: string, cachedSecUid?: string, window?: { start?: Date | null, end?: Date | null }) {
  // ...existing code...
  const apiHost = process.env.RAPIDAPI_TIKTOK_HOST;

  if (!apiHost) {
    console.warn('TikTok RapidAPI key or host is missing. Returning mock data.');
    return { followers: 0, views: 0, likes: 0, comments: 0 };
  }

  let secUid = cachedSecUid;
  let followers = 0;
  if (!secUid) {
    // Step 1: Get secUid from username lewat user info
    const infoUrl = `https://${apiHost}/api/user/info?uniqueId=${encodeURIComponent(username)}`;
    let infoData;
    try {
      infoData = await rapidApiRequest<any>({ url: infoUrl, method: 'GET', rapidApiHost: apiHost, timeoutMs: 15000, maxPerKeyRetries: 1 });
    } catch (err) {
      return { error: 'Gagal fetch ke TikTok API', followers: 0, views: 0, likes: 0, comments: 0, raw: String(err) };
    }

    // Handle error dari API
    if (!infoData || infoData.status_code === 404 || infoData.status === false || infoData.message) {
      return { error: infoData?.message || 'User TikTok tidak ditemukan', followers: 0, views: 0, likes: 0, comments: 0, raw: infoData };
    }

    // Ambil secUid
    const userInfo = infoData?.userInfo;
    const stats = userInfo?.stats || userInfo?.statsV2 || userInfo?.user?.stats || userInfo?.user?.statsV2;
    secUid = userInfo?.user?.secUid || userInfo?.user?.sec_uid || userInfo?.user?.uniqueId || userInfo?.user?.id;
    if (!stats || !secUid) {
      console.error('TikTok secUid or stats not found. userInfo:', userInfo);
      return { error: 'User TikTok tidak ditemukan (struktur API berubah)', followers: 0, views: 0, likes: 0, comments: 0, raw: infoData };
    }
    followers = safeParseInt(stats.followerCount);

    // Simpan secUid ke database (tiktok_posts_daily - mass update baris lama)
    try {
      const supabase = await createClient();
      await supabase
        .from('tiktok_posts_daily')
        .update({ sec_uid: secUid })
        .eq('username', username)
        .is('sec_uid', null);
      // Simpan juga ke users.tiktok_sec_uid (cache per user)
      await supabase
        .from('users')
        .update({ tiktok_sec_uid: secUid })
        .ilike('tiktok_username', username);
    } catch (e) {
      console.warn('[TikTok] Gagal update sec_uid mass-update/cache:', e);
    }
  }

  // Fetch post hari ini
  const today = new Date();
  today.setHours(0,0,0,0);
  const postsUrl = `https://${apiHost}/api/user/posts?secUid=${secUid}`;
  let postsData;
  try {
    postsData = await rapidApiRequest<any>({ url: postsUrl, method: 'GET', rapidApiHost: apiHost, timeoutMs: 15000, maxPerKeyRetries: 1 });
  } catch (err) {
    return { error: 'Gagal fetch post TikTok', followers, views: 0, likes: 0, comments: 0, raw: String(err) };
  }
  // Ambil array post (handle TikTok API structure)
  let posts = postsData?.aweme_list
    || postsData?.data?.aweme_list
    || postsData?.data?.itemList
    || postsData?.data?.items
    || postsData?.items
    || [];
  if (!Array.isArray(posts)) {
    console.error('TikTok posts is not array. postsData:', postsData);
    posts = [];
  }

  // Tentukan window waktu untuk upsert: gunakan start campaign jika diberikan, else 90 hari terakhir
  const minDate = window?.start ? new Date(window.start) : new Date();
  if (!window?.start) minDate.setDate(minDate.getDate() - 90);
  const maxDate = window?.end ? new Date(window.end) : null;

  const parsePostTime = (ts: any): Date | null => {
    if (ts == null) return null;
    if (typeof ts === 'number') {
      // if appears to be milliseconds already
      const ms = ts > 1e12 ? ts : ts * 1000;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof ts === 'string') {
      // try numeric string first
      const n = Number(ts);
      if (!Number.isNaN(n) && n > 0) {
        const ms = n > 1e12 ? n : n * 1000;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
      }
      const d = new Date(ts);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  };

  // Filter posts sesuai tanggal (robust timestamp parsing)
  const filteredPosts = posts.filter((post: any) => {
    const ts = post.createTime ?? post.create_time ?? post.create_time_utc ?? post.create_time_local ?? post.createDate ?? post.create_date;
    const postDate = parsePostTime(ts);
    if (!postDate) return false;
    if (postDate < minDate) return false;
    if (maxDate && postDate > maxDate) return false;
    return true;
  });

  const supabase = await createClient();
  if (filteredPosts.length > 0) {
    for (const post of filteredPosts) {
      const ts = post.createTime ?? post.create_time ?? post.create_time_utc ?? post.create_time_local ?? post.createDate ?? post.create_date;
      const postDate = parsePostTime(ts) || new Date();
      const ids = deriveVideoIds(post);
      if (!ids.video_id) {
        console.warn('[TikTok] Skip upsert: video_id not found for post.', post?.id || post?.aweme_id || 'unknown');
        continue;
      }
      const title = String(post?.title || post?.desc || post?.description || '');
      const upsertData = {
        video_id: ids.video_id,
        username,
        sec_uid: secUid,
        post_date: postDate.toISOString().slice(0, 10),
        taken_at: postDate.toISOString(), // Store actual TikTok create_time
        title: title || null,
        comment_count: readStat(post,'comment'),
        play_count: readStat(post,'play'),
        share_count: readStat(post,'share'),
        digg_count: readStat(post,'digg'),
        save_count: readStat(post,'save'),
      };
  const { error: upsertError } = await supabase.from('tiktok_posts_daily').upsert(upsertData, { onConflict: 'video_id' });
      if (upsertError) {
        console.error('[TikTok] Gagal upsert ke tiktok_posts_daily:', upsertError.message, upsertData);
      } else {
        console.log('[TikTok] Berhasil upsert ke tiktok_posts_daily:', upsertData);
      }
    }
  } else {
    console.warn(`[TikTok] Tidak ada post TikTok dalam window untuk ${username}. Data posts:`, posts.map((p: any) => ({
      id: p.id || p.aweme_id,
      createTime: p.createTime,
      create_time: p.create_time,
      create_time_utc: p.create_time_utc,
      create_time_local: p.create_time_local
    })).slice(0,3));
  }

  // Hitung total metrik dari semua post yang lolos filter
  let totalLikes = 0, totalViews = 0, totalComments = 0, totalShares = 0, totalSaves = 0;
  for (const post of filteredPosts) {
    totalLikes += readStat(post,'digg');
    totalViews += readStat(post,'play');
    totalComments += readStat(post,'comment');
    totalShares += readStat(post,'share');
    totalSaves += readStat(post,'save');
  }

  // Return total metrik dan followers (selalu defined)
  return {
    followers,
    views: totalViews,
    likes: totalLikes,
    comments: totalComments,
    shares: totalShares,
    saves: totalSaves,
    posts_total: filteredPosts.length,
    secUid,
  };
}

// --- Main API Route Handler ---

export async function GET(request: Request, context: any) {
  const supabase = await createClient();
  const admin = createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const params = await context.params as { username: string };
  const primaryUsername = params.username;
  if (!primaryUsername) return NextResponse.json({ error: 'No username provided in params.' }, { status: 400 });

  const normalized = primaryUsername.replace(/^@/, '').toLowerCase().replace(/\s+/g, '').trim();
  const urlObj = new URL(request.url);
  const startParam = urlObj.searchParams.get('start');
  const endParam = urlObj.searchParams.get('end');
  const pagesParam = urlObj.searchParams.get('pages');
  const cursorParam = urlObj.searchParams.get('cursor');
  const rapidParam = urlObj.searchParams.get('rapid'); // '1' to force RapidAPI cursor mode
  const providerParam = (urlObj.searchParams.get('provider') || '').toLowerCase(); // 'fast' | 'api15'
  const pageMode = urlObj.searchParams.get('page') === '1' || cursorParam !== null;
  const startBound = startParam ? new Date(startParam + 'T00:00:00.000Z') : null;
  const endBound = endParam ? new Date(endParam + 'T23:59:59.999Z') : null;
  const allParam = urlObj.searchParams.get('all');
  const countParam = urlObj.searchParams.get('count');

  // Ensure user exists
  let { data: userData } = await admin
    .from('users')
    .select('id, tiktok_username, tiktok_sec_uid')
    .eq('tiktok_username', normalized)
    .maybeSingle();
  // Check employee_participants mapping (employee_id = user_id) - use .limit(1) to handle duplicates
  if (!userData) {
    const { data: empData } = await admin
      .from('employee_participants')
      .select('employee_id')
      .eq('tiktok_username', normalized)
      .limit(1);
    if (empData && empData.length > 0 && empData[0].employee_id) {
      // Fetch user details from employee_id
      const { data: empUser } = await admin
        .from('users')
        .select('id, tiktok_username, tiktok_sec_uid')
        .eq('id', empData[0].employee_id)
        .maybeSingle();
      if (empUser) userData = empUser as any;
    }
    
    // Auto-create user if not found after employee check
    if (!userData) {
      const newId = randomUUID();
      try {
        // CRITICAL: Only set tiktok_username, do NOT overwrite username field
        // username field should remain NULL for auto-created accounts
        const { data: inserted } = await admin
          .from('users')
          .insert({ id: newId, tiktok_username: normalized, role: 'umum', email: `${normalized}@example.com` })
          .select('id, tiktok_username, tiktok_sec_uid')
          .single();
        userData = inserted as any;
      } catch (e) {
        // network/db issue – fall back to a local placeholder so the rest of the pipeline can proceed
        console.warn('[fetch-metrics] users insert failed, using placeholder userData:', e);
        userData = { id: newId, tiktok_username: normalized, tiktok_sec_uid: null } as any;
      }
      if (!userData) {
        // as a last resort, create placeholder
        userData = { id: newId, tiktok_username: normalized, tiktok_sec_uid: null } as any;
      }
    }
  }
  const { id: userId, tiktok_username, tiktok_sec_uid } = userData as { id: string; tiktok_username: string; tiktok_sec_uid: string | null };

  // ========================================
  // MAIN FETCH LOGIC: Aggregator → RapidAPI
  // ========================================
  let videos: any[] = [];
  let fetchSource = 'none';
  let fetchTelemetry: any = {};
  
  // PRIORITY 1: Try Aggregator API (UNLIMITED) unless ?rapid=1
  if (AGGREGATOR_ENABLED && rapidParam !== '1') {
    console.log(`[TikTok Fetch] Trying Aggregator API first for @${normalized}`);
    try {
      const aggregatorResult = await fetchFromAggregator(normalized, startParam, endParam);
      
      if (aggregatorResult.success && aggregatorResult.videos.length > 0) {
        videos = aggregatorResult.videos;
        fetchSource = 'aggregator';
        fetchTelemetry = {
          source: 'aggregator',
          totalVideos: aggregatorResult.totalFetched,
          success: true
        };
        console.log(`[TikTok Fetch] ✓ Aggregator success: ${videos.length} videos`);
      } else {
        console.log(`[TikTok Fetch] ✗ Aggregator returned no data, falling back to RapidAPI`);
      }
    } catch (error: any) {
      console.error(`[TikTok Fetch] Aggregator error:`, error.message);
      console.log(`[TikTok Fetch] Falling back to RapidAPI`);
    }
  }
  
  // PRIORITY 2: Fallback to RapidAPI if Aggregator failed or forced
  if (videos.length === 0 || rapidParam === '1') {
    if (rapidParam === '1') {
      console.log(`[TikTok Fetch] RapidAPI forced via ?rapid=1`);
    }
    console.log(`[TikTok Fetch] Using RapidAPI for @${normalized}`);
    
    // Helper: fetch all videos via RapidAPI (UNLIMITED MODE)
    const fetchAllVideosRapid = async (): Promise<any[]> => {
      const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
      const perPage = clamp(Number(countParam ?? '100'), 20, 1000);
      // UNLIMITED MODE: Default to no page limit
      let maxPages = 0; // 0 = unlimited
      if (allParam === '0') maxPages = Number(process.env.USER_REFRESH_MAX_PAGES || '6'); // Reverse: all=0 untuk limit
      if (pagesParam !== null) {
        const p = Number(pagesParam);
        if (!Number.isNaN(p)) maxPages = p;
      }
    const seen = new Set<string>();
    const out: any[] = [];
    let cursor: string | undefined = undefined;
    let fallbackCursor: string | undefined = undefined;
    let sameCursorCount = 0;
    let noNewItemsCount = 0;
    let page = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (true) {
      if (maxPages > 0 && page >= maxPages) break;
      page += 1;
      const url = `https://${TIKTOK_RAPID_HOST}/user/posts?unique_id=@${encodeURIComponent(normalized)}&count=${perPage}${cursor ? `&cursor=${cursor}` : ''}`;
      let j: any = null;
      try {
        j = await rapidApiRequest({ url, method: 'GET', rapidApiHost: TIKTOK_RAPID_HOST, timeoutMs: 30000 });
      } catch (err) {
        console.error('[fetchAllVideos] RapidAPI error:', err);
        await sleep(1000);
        break;
      }
      if (!j || !j.data) break;
      const vlist: any[] = Array.isArray(j?.data?.videos) ? j.data.videos : (Array.isArray(j?.data?.aweme_list) ? j.data.aweme_list : []);
      const prevSize = out.length;
      let stop = false;
      for (const v of vlist) {
        const vid = v.aweme_id || v.video_id || v.id;
        const key = String(vid || '');
        if (!key || seen.has(key)) continue;
        const ts = v.create_time ?? v.createTime ?? v.create_time_utc ?? v.create_date;
        const ms = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Number(ts) > 0 ? (Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000) : Date.parse(ts);
        const d = new Date(ms);
        if (isNaN(d.getTime())) continue;
        if (startBound && d < startBound) { stop = true; break; }
        seen.add(key);
        out.push(v);
      }
      if (stop) break;
      // progress guard
      if (out.length === prevSize) noNewItemsCount += 1; else noNewItemsCount = 0;
      if (noNewItemsCount >= 3) break;
      const apiCursor = j?.data?.cursor ? String(j.data.cursor) : undefined;
      // fallback cursor from min timestamp on page
      const minMs = vlist
        .map((v:any)=>v.create_time ?? v.createTime ?? v.create_time_utc ?? v.create_date)
        .map((ts:any)=> typeof ts==='number' ? (ts>1e12?ts:ts*1000) : (Number(ts)>0 ? (Number(ts)>1e12?Number(ts):Number(ts)*1000) : Date.parse(ts)))
        .filter((n:any)=> Number.isFinite(n))
        .reduce((m:number, n:number)=> Math.min(m, n), Number.POSITIVE_INFINITY);
      const nextFallback = Number.isFinite(minMs) ? String(Math.max(0, Math.floor(minMs) - 1)) : undefined;
      // choose next cursor
      const nextCursor = apiCursor || nextFallback;
      if (!nextCursor) break;
      if (cursor && nextCursor === cursor && fallbackCursor && nextFallback === fallbackCursor) {
        sameCursorCount += 1;
        if (sameCursorCount >= 3) break;
      } else {
        sameCursorCount = 0;
      }
      cursor = nextCursor;
      fallbackCursor = nextFallback;
      // Rate limit
      await sleep(1000);
    }
    return out;
  };
    
    // Execute RapidAPI fetch
    try {
      videos = await fetchAllVideosRapid();
      fetchSource = 'rapidapi';
      fetchTelemetry = {
        source: 'rapidapi',
        totalVideos: videos.length,
        success: true
      };
      console.log(`[TikTok Fetch] ✓ RapidAPI success: ${videos.length} videos`);
    } catch (error: any) {
      console.error(`[TikTok Fetch] RapidAPI error:`, error.message);
      fetchTelemetry = {
        source: 'rapidapi',
        error: error.message,
        success: false
      };
    }
  }
  
  console.log(`[TikTok Fetch] Final result: ${videos.length} videos from ${fetchSource}`);

  // RapidAPI Fast Reliable Data Scraper cursor fetch (primary when RAPIDAPI_USE_CURSOR=1)
  const rapidFastCursorFetchAll = async (): Promise<{ list: any[]; telemetry: any } | any[]> => {
    const host = 'tiktok-api-fast-reliable-data-scraper.p.rapidapi.com';
    const sleep = (ms:number)=> new Promise(res=>setTimeout(res, ms));
    const seen = new Set<string>();
    const out: any[] = [];
    const pageSummaries: Array<{page:number;count:number;min_cursor:string;max_cursor:string;has_more:boolean;status:number}> = [];
    let cursor = '' as string; // IMPORTANT: first request must NOT send max_cursor
    let hasMore = true;
    let page = 0;
    let emptyStreak = 0;
    let sameCursorStreak = 0;
    let saw429 = false;

    const base = `https://${host}/user/${encodeURIComponent(normalized)}/feed`;

    while (hasMore && page < RAPID_CURSOR_MAX_ITER) {
      page += 1;

      // Build params: only send max_cursor if not empty string
      const url = new URL(base);
      if (cursor !== '') url.searchParams.set('max_cursor', cursor);
      if (typeof RAPID_CURSOR_LIMIT === 'number') url.searchParams.set('limit', String(RAPID_CURSOR_LIMIT));

      let data: any = null;
      try {
        const j = await rapidApiRequest<any>({ url: url.toString(), method: 'GET', rapidApiHost: host, timeoutMs: 20000, maxPerKeyRetries: 1 });
        data = j?.data || j;
      } catch {
        pageSummaries.push({ page, count: 0, min_cursor: '', max_cursor: cursor, has_more: false, status: 500 });
        break;
      }
      if (!data) {
        emptyStreak += 1; if (emptyStreak >= 3) break; await sleep(RAPID_CURSOR_RATE_MS); continue;
      }
      const items: any[] = Array.isArray(data.aweme_list || data.videos || data.items) ? (data.aweme_list || data.videos || data.items) : [];
      const min_cursor = String(data.min_cursor ?? '');
      const next_cursor = String(data.max_cursor ?? '');
      hasMore = Boolean(data.has_more);

      let added = 0;
      for (const it of items) {
        const id = String(it?.aweme_id || it?.aweme?.aweme_id || it?.id || it?.video_id || it?.awemeId || '');
        if (!id || seen.has(id)) continue;
        seen.add(id); out.push(it); added++;
      }
      pageSummaries.push({ page, count: added, min_cursor, max_cursor: next_cursor, has_more: hasMore, status: 200 });
      if (added === 0) { emptyStreak += 1; } else { emptyStreak = 0; }
      if (next_cursor === cursor) {
        sameCursorStreak += 1; if (sameCursorStreak >= 2) break;
      } else { sameCursorStreak = 0; }
      if (!next_cursor) break;
      cursor = next_cursor;
      await sleep(RAPID_CURSOR_RATE_MS);
    }

    // Sort oldest->newest if timestamps exist
    out.sort((a,b)=>{
      const ta = Number(a?.create_time || a?.createTime || 0);
      const tb = Number(b?.create_time || b?.createTime || 0);
      return ta - tb;
    });
    const telemetry = {
      mode: 'rapid_cursor',
      username: normalized,
      pages: pageSummaries,
      stats: {
        totalPages: pageSummaries.length,
        uniqueVideos: out.length,
      },
      rateLimited: saw429,
    };
    return { list: out, telemetry };
  };

  // RapidAPI tiktok-scraper7: getUserVideos with cursor paging
  const rapidApi15CursorFetchAll = async (): Promise<{ list: any[]; telemetry: any } | any[]> => {
    const host = process.env.RAPIDAPI_TIKTOK_HOST || 'tiktok-scraper7.p.rapidapi.com';
    const sleep = (ms:number)=> new Promise(res=>setTimeout(res, ms));
    const seen = new Set<string>();
    const out: any[] = [];
    const pageSummaries: Array<{page:number;count:number;cursor:string;has_more:boolean;status:number}> = [];
    let cursor: string | number | null = 0; // API15 menerima 0 untuk halaman pertama
    let hasMore = true;
    let page = 0;
    let emptyStreak = 0;
    let sameCursorStreak = 0;
    const count = typeof RAPID_CURSOR_LIMIT === 'number' ? Math.min(Math.max(RAPID_CURSOR_LIMIT,1), 35) : 35;
    let saw429 = false;

    while (hasMore && page < RAPID_CURSOR_MAX_ITER) {
      page += 1;
      const url = new URL(`https://${host}/user/posts`);
      // unique_id dengan '@' untuk tiktok-scraper7
      url.searchParams.set('unique_id', normalized);
      url.searchParams.set('count', String(count));
      if (cursor !== null && cursor !== undefined) url.searchParams.set('cursor', String(cursor));

      let j: any = null;
      let statusCode = 200;
      try {
        // Use default maxPerKeyRetries=5 from rapidapi.ts for maximum reliability
        j = await rapidApiRequest<any>({ url: url.toString(), method: 'GET', rapidApiHost: host, timeoutMs: 30000 });
        
        // Scraper7 response can have different formats:
        // 1. { msg: "success", data: { videos: [...] } }
        // 2. { code: 0, data: { videos: [...] } }
        // 3. { data: { videos: [...] } } (direct)
        
        const isSuccess = j?.msg === 'success' || j?.code === 0 || (j?.data && Array.isArray(j?.data?.videos));
        
        if (!isSuccess) {
          const errorMsg = j?.msg || j?.message || 'Unknown error';
          console.error(`[scraper7] API error for ${normalized}: ${errorMsg}`, j);
          statusCode = 500;
          pageSummaries.push({ page, count: 0, cursor: String(cursor ?? ''), has_more: false, status: statusCode });
          break;
        }
      } catch (err) {
        console.error(`[scraper7] Request failed for ${normalized}:`, err);
        pageSummaries.push({ page, count: 0, cursor: String(cursor ?? ''), has_more: false, status: 500 });
        break;
      }
      // Response format: { msg: "success", data: { videos: [...], hasMore: 0/1, cursor: "xxx" } }
      const data = j?.data || j;
      const list: any[] = Array.isArray(data?.videos) ? data.videos : [];
      
      // DEBUG: Log first page response for troubleshooting
      if (page === 1 && list.length > 0) {
        console.log(`[scraper7] ${normalized}: Successfully fetched ${list.length} videos on page 1`);
      }
      
      let added = 0;
      for (const it of list) {
        const id = String(it?.video_id || it?.aweme_id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id); 
        // Transform scraper7 format to internal format
        const transformed = {
          aweme_id: id,
          video_id: id,
          create_time: it?.create_time || 0,
          title: it?.title || '',
          play_count: it?.play_count || 0,
          digg_count: it?.digg_count || 0,
          comment_count: it?.comment_count || 0,
          share_count: it?.share_count || 0,
          collect_count: it?.collect_count || 0,
          cover: it?.cover || '',
        };
        out.push(transformed); 
        added++;
      }
      hasMore = Boolean(data?.hasMore === 1 || data?.has_more);
      const nextCursor = String(data?.cursor || '');
      pageSummaries.push({ page, count: added, cursor: String(nextCursor || cursor || ''), has_more: hasMore, status: statusCode });
      
      // Stop if no more data
      if (added === 0) { 
        emptyStreak += 1; 
        if (emptyStreak >= 2) {
          console.log(`[scraper7] ${username}: 2 consecutive empty pages, stopping`);
          break;
        }
      } else { 
        emptyStreak = 0; 
      }
      
      // Stop if hasMore is false
      if (!hasMore) {
        console.log(`[scraper7] ${username}: hasMore=false, stopping`);
        break;
      }
      
      // Update cursor for next iteration
      if (nextCursor && nextCursor !== '0' && nextCursor !== String(cursor)) {
        cursor = nextCursor;
        sameCursorStreak = 0;
      } else {
        sameCursorStreak += 1;
        if (sameCursorStreak >= 2) {
          console.log(`[scraper7] ${username}: Cursor not advancing, stopping`);
          break;
        }
      }
      
      await sleep(RAPID_CURSOR_RATE_MS);
    }
    // sort oldest->newest
    out.sort((a,b)=>{
      const ta = Number(a?.create_time || a?.createTime || 0);
      const tb = Number(b?.create_time || b?.createTime || 0);
      return ta - tb;
    });
    const telemetry = { mode: 'rapid_scraper7', username: normalized, pages: pageSummaries, stats: { totalPages: pageSummaries.length, uniqueVideos: out.length }, rateLimited: saw429 };
    return { list: out, telemetry };
  };

  // RapidAPI fallback: fetch using continuation tokens to traverse full history
  const rapidFetchAll = async (): Promise<any[]> => {
    try {
      const apiHost = process.env.RAPIDAPI_TIKTOK_HOST;
      if (!apiHost) return [];
      // details → first page → continuation loop
      const detUrl = `https://${apiHost}/user/details?username=${encodeURIComponent(normalized)}`;
      try { await rapidApiRequest<any>({ url: detUrl, method: 'GET', rapidApiHost: apiHost, timeoutMs: 15000 }); } catch {}
      // ignore details result if fails; not strictly required for continuation
      const firstUrl = `https://${apiHost}/user/videos?username=${encodeURIComponent(normalized)}`;
      let first: any = null;
      try { first = await rapidApiRequest<any>({ url: firstUrl, method: 'GET', rapidApiHost: apiHost, timeoutMs: 20000 }); } catch { first = null; }
      const out: any[] = [];
      const pushItems = (j:any) => {
        const items = j?.data?.videos || j?.videos || j?.data?.items || [];
        if (Array.isArray(items)) out.push(...items);
        return String(j?.data?.continuation_token || j?.continuation_token || j?.data?.cursor || j?.cursor || '') || undefined;
      };
      let token = first ? pushItems(first) : undefined;
      let stall = 0;
      while (token) {
        const contUrl = `https://${apiHost}/user/videos/continuation?username=${encodeURIComponent(normalized)}&secondary_id=&continuation_token=${encodeURIComponent(token)}`;
        let j: any = null;
        try { j = await rapidApiRequest<any>({ url: contUrl, method: 'GET', rapidApiHost: apiHost, timeoutMs: 20000 }); } catch { break; }
        const before = out.length;
        token = pushItems(j);
        if (out.length === before) {
          stall += 1; if (stall >= 3) break;
        } else {
          stall = 0;
        }
        await new Promise(res=>setTimeout(res, 250));
      }
      return out;
    } catch { return []; }
  };

  // Single-page fetch to support external iteration when `page=1` or `cursor` is given
  const fetchOnePage = async (cursor?: string): Promise<{ videos: any[]; hasMore: boolean; cursor?: string }> => {
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
    const perPage = clamp(Number(countParam ?? '100'), 20, 1000);
    const url = `https://${TIKTOK_RAPID_HOST}/user/posts?unique_id=@${encodeURIComponent(normalized)}&count=${perPage}${cursor ? `&cursor=${cursor}` : ''}`;
    let json: any = null;
    try {
      json = await rapidApiRequest({ url, method: 'GET', rapidApiHost: TIKTOK_RAPID_HOST, timeoutMs: 30000 });
    } catch (err) {
      console.error('[fetchOnePage] RapidAPI error:', err);
      return { videos: [], hasMore: false };
    }
    const list: any[] = Array.isArray(json?.data?.videos) ? json.data.videos : (Array.isArray(json?.data?.aweme_list) ? json.data.aweme_list : []);
    const apiCursor = json?.data?.cursor ? String(json.data.cursor) : undefined;
    const minMs = list
      .map((v:any)=>v.create_time ?? v.createTime ?? v.create_time_utc ?? v.create_date)
      .map((ts:any)=> typeof ts==='number' ? (ts>1e12?ts:ts*1000) : (Number(ts)>0 ? (Number(ts)>1e12?Number(ts):Number(ts)*1000) : Date.parse(ts)))
      .filter((n:any)=> Number.isFinite(n))
      .reduce((m:number, n:number)=> Math.min(m, n), Number.POSITIVE_INFINITY);
    const fallbackNext = Number.isFinite(minMs) ? String(Math.max(0, Math.floor(minMs)-1)) : undefined;
    const nextCursor = apiCursor && apiCursor !== cursor ? apiCursor : fallbackNext;
    return { videos: list, hasMore: !!json?.data?.hasMore, cursor: nextCursor };
  };

  try {
    // Page mode: process a single page and return next cursor to iterate client-side
    if (pageMode) {
      const { videos, hasMore, cursor: nextCursor } = await fetchOnePage(cursorParam || undefined);
      // Optional enrichment skipped in page mode for speed/reliability
      let totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts_total: 0 };
      const toUpsert: any[] = [];
      const minDate = startBound ? new Date(startBound) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const maxDate = endBound ? new Date(endBound) : null;
      for (const v of videos) {
        const ts = v.create_time ?? v.createTime ?? v.create_time_utc ?? v.create_date;
        const ms = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Number(ts) > 0 ? (Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000) : Date.parse(ts);
        const d = new Date(ms);
        if (isNaN(d.getTime())) continue;
        if (d < minDate) continue;
        if (maxDate && d > maxDate) continue;
        const vId = v.video_id || v.id || deriveVideoId(v);
        const vViews = readStat(v,'play');
        const vLikes = readStat(v,'digg');
        const vComments = readStat(v,'comment');
        const vShares = readStat(v,'share');
        const vSaves = readStat(v,'save');
        totals.views += vViews; totals.likes += vLikes; totals.comments += vComments; totals.shares += vShares; totals.saves += vSaves; totals.posts_total += 1;
        if (vId) toUpsert.push({ video_id: String(vId), username: normalized, sec_uid: tiktok_sec_uid || null, post_date: d.toISOString().slice(0, 10), taken_at: d.toISOString(), play_count: vViews, digg_count: vLikes, comment_count: vComments, share_count: vShares, save_count: vSaves });
      }
      if (toUpsert.length) {
        const chunkSize = 500;
        for (let i = 0; i < toUpsert.length; i += chunkSize) {
          const chunk = toUpsert.slice(i, i + chunkSize);
          await admin.from('tiktok_posts_daily').upsert(chunk, { onConflict: 'video_id' });
        }
      }
      // followers best-effort
      let followers = 0;
      try {
        const infoUrl = `https://${TIKTOK_RAPID_HOST}/user/info?unique_id=@${encodeURIComponent(normalized)}`;
        const info = await rapidApiRequest({ url: infoUrl, method: 'GET', rapidApiHost: TIKTOK_RAPID_HOST, timeoutMs: 15000 });
        followers = Number(info?.data?.stats?.followerCount || info?.userInfo?.stats?.followerCount || 0) || 0;
      } catch (err) {
        console.error('[pageMode] Failed to fetch followers:', err);
      }
      // Persist summary
      await admin.from('social_metrics').upsert({ user_id: userId, platform: 'tiktok', followers, likes: totals.likes, views: totals.views, comments: totals.comments, shares: totals.shares, saves: totals.saves, last_updated: new Date().toISOString() }, { onConflict: 'user_id,platform' });
      try { await admin.from('social_metrics_history').insert({ user_id: userId, platform: 'tiktok', followers, likes: totals.likes, views: totals.views, comments: totals.comments, shares: totals.shares, saves: totals.saves, captured_at: new Date().toISOString() }); } catch {}
      return NextResponse.json({ tiktok: { ...totals, followers }, page: { hasMore, nextCursor }, source: 'external' });
    } // End of pageMode block
    
    // ========================================
    // UNLIMITED SYNC WITH AGGREGATOR PRIORITY
    // ========================================
    let videos: any[] = [];
    let telemetry: any = undefined;
    const FORCE_RAPID = rapidParam === '1';
    
    // AGGREGATOR UNLIMITED FETCH - 90-DAY ROLLING WINDOWS
    const fetchFromAggregator = async (): Promise<any[]> => {
      if (!AGGREGATOR_ENABLED || FORCE_RAPID) return [];
      
      console.log(`[TikTok Fetch] Trying Aggregator API first for @${normalized}`);
      console.log(`[Aggregator] Starting unlimited fetch for @${normalized}`);
      
      const allVideos: any[] = [];
      const seenIds = new Set<string>();
      let totalPages = 0;
      
      // Calculate date range (optimize for Vercel 60s limit)
      const endDate = endBound ? new Date(endBound) : new Date();
      const startDate = startBound ? new Date(startBound) : new Date(endDate.getTime() - 90 * 86400000); // 90 days only (fit in 60s)
      
      console.log(`[Aggregator] Date range: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}`);
      
      // Single 90-day window (no multiple windows - too slow for 60s limit)
      const windows: { start: Date; end: Date }[] = [{ start: startDate, end: endDate }];
      
      // Process each window
      for (const window of windows) {
        const startTime = Math.floor(window.start.getTime() / 1000);
        const endTime = Math.floor(window.end.getTime() / 1000);
        
        console.log(`[Aggregator] Window: ${window.start.toISOString().slice(0,10)} to ${window.end.toISOString().slice(0,10)}`);
        
        let windowVideos = 0;
        let page = 1;
        let hasMore = true;
        
        while (hasMore && page <= AGGREGATOR_MAX_PAGES) {
          try {
            const url = `${AGGREGATOR_BASE}/user/posts?username=${encodeURIComponent(normalized)}&start_time=${startTime}&end_time=${endTime}&count=${AGGREGATOR_PER_PAGE}&page=${page}`;
            
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            
            if (!res.ok) {
              console.warn(`[Aggregator] Page ${page} failed: ${res.status}`);
              break;
            }
            
            const data = await res.json();
            const pageVideos = data?.data?.videos || data?.videos || [];
            
            let newVideos = 0;
            for (const video of pageVideos) {
              const videoId = video?.video_id || video?.aweme_id || video?.id;
              if (!videoId) continue;
              
              const id = String(videoId);
              if (seenIds.has(id)) continue;
              
              seenIds.add(id);
              allVideos.push(video);
              newVideos++;
              windowVideos++;
            }
            
            totalPages++;
            console.log(`[Aggregator] Page ${page}: +${newVideos} videos (window total: ${windowVideos})`);
            
            // Stop if no new videos (reached end)
            if (newVideos === 0) {
              hasMore = false;
            } else {
              page++;
              await new Promise(resolve => setTimeout(resolve, AGGREGATOR_RATE_MS));
            }
          } catch (err: any) {
            console.error(`[Aggregator] Page ${page} error:`, err.message);
            break;
          }
        }
        
        // If window returned videos, continue to older windows
        // If no videos in recent window, likely account has no older content
        if (windowVideos === 0 && windows.indexOf(window) === 0) {
          console.log(`[Aggregator] No videos in most recent window, skipping older windows`);
          break;
        }
      }
      
      console.log(`[Aggregator] Completed: ${allVideos.length} unique videos from ${totalPages} pages`);
      return allVideos;
    };
    
    // TRY AGGREGATOR FIRST (PRIORITY #1)
    if (AGGREGATOR_ENABLED && !FORCE_RAPID) {
      try {
        const aggVideos = await fetchFromAggregator();
        if (aggVideos.length > 0) {
          videos = aggVideos;
          telemetry = { mode: 'aggregator', username: normalized, source: AGGREGATOR_BASE, videos_count: aggVideos.length };
          console.log(`[TikTok Fetch] ✓ Aggregator success: ${aggVideos.length} videos`);
        } else {
          console.log(`[TikTok Fetch] ✗ Aggregator returned 0 videos, falling back to RapidAPI...`);
        }
      } catch (err: any) {
        console.error(`[TikTok Fetch] ✗ Aggregator failed:`, err.message);
        console.log(`[TikTok Fetch] Falling back to RapidAPI...`);
      }
    }
    
    // FALLBACK TO RAPIDAPI IF NEEDED
    const useRapidCursor = FORCE_RAPID || videos.length === 0;
    const providerOverride = providerParam === 'api15' || providerParam === 'fast' ? providerParam : undefined;
    
    if (useRapidCursor) {
      console.log(`[TikTok Fetch] Using RapidAPI fallback for @${normalized}...`);
      const provider = providerOverride || RAPID_PROVIDER;
      if (provider === 'api15') {
        const rf = await rapidApi15CursorFetchAll();
        if (Array.isArray(rf)) videos = rf; else { videos = rf.list || []; telemetry = rf.telemetry; }
        
        // CRITICAL FALLBACK: If scraper7 returns ZERO videos, ALWAYS try rapid_cursor as backup
        // This ensures we NEVER have missing data for ANY account
        const needsFallback = videos.length === 0 || telemetry?.rateLimited;
        
        if (RAPID_FALLBACK_ON_429 && needsFallback) {
          console.log(`[TikTok Fetch] Scraper7 returned ${videos.length} videos for ${normalized}, trying rapid_cursor fallback...`);
          const rf2 = await rapidFastCursorFetchAll();
          let vids2: any[] = Array.isArray(rf2) ? rf2 : (rf2.list || []);
          if (!Array.isArray(rf2)) telemetry = telemetry || {}; telemetry = { ...(telemetry||{}), alt: rf2.telemetry };
          if (vids2.length) {
            const seen = new Set(videos.map((v:any)=> String(v.aweme_id||v.video_id||v.id||'')));
            for (const v of vids2) { const k = String(v.aweme_id||v.video_id||v.id||''); if (!k||seen.has(k)) continue; seen.add(k); videos.push(v); }
          }
        }
      } else {
        const rf = await rapidFastCursorFetchAll();
        if (Array.isArray(rf)) videos = rf; else { videos = rf.list || []; telemetry = rf.telemetry; }
        if (RAPID_FALLBACK_ON_429 && ((telemetry?.rateLimited) || videos.length === 0)) {
          const rf2 = await rapidApi15CursorFetchAll();
          let vids2: any[] = Array.isArray(rf2) ? rf2 : (rf2.list || []);
          if (!Array.isArray(rf2)) telemetry = telemetry || {}; telemetry = { ...(telemetry||{}), alt: rf2.telemetry };
          if (vids2.length) {
            const seen = new Set(videos.map((v:any)=> String(v.aweme_id||v.video_id||v.id||'')));
            for (const v of vids2) { const k = String(v.aweme_id||v.video_id||v.id||''); if (!k||seen.has(k)) continue; seen.add(k); videos.push(v); }
          }
        }
      }
    }
    
    // FINAL RESULT LOG
    console.log(`[TikTok Fetch] Final result: ${videos.length} videos from ${telemetry?.mode || 'rapidapi'}`);
    
    // VIDEO ENRICHMENT - Backfill missing stats from tikwm.com
    videos = await Promise.all(videos.map(async (v: any) => {
      const coreCount = readStat(v,'play') || readStat(v,'digg') || readStat(v,'comment');
      const vid = v.aweme_id || v.video_id || deriveVideoId(v);
      const hasCore = coreCount > 0 && !!vid;
      if (hasCore) return v;
      if (!vid) return v;
      const videoUrl = `https://www.tiktok.com/@${encodeURIComponent(normalized)}/video/${encodeURIComponent(vid)}`;
      try {
        const twm = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`, { headers: { Accept: 'application/json' } });
        if (!twm.ok) return v;
        const j = await twm.json().catch(() => null);
        if (!j || j.code !== 0) return v;
        const info = j.data || {};
        return { ...v, play: v.play || info.play || v.play, play_count: v.play_count || info.play_count || info.views || v.play_count, digg_count: v.digg_count || info.like_count || v.digg_count, comment_count: v.comment_count || info.comment_count || v.comment_count, share_count: v.share_count || info.share_count || v.share_count, cover: v.cover || info.cover || v.cover };
      } catch { return v; }
    }));

    let totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts_total: 0 };
    const toUpsert: any[] = [];
    const minDate = startBound ? new Date(startBound) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const maxDate = endBound ? new Date(endBound) : null;
    
    console.log(`[TikTok Parse] ${normalized}: Processing ${videos.length} videos, minDate=${minDate.toISOString()}, maxDate=${maxDate?.toISOString() || 'none'}`);
    
    for (const v of videos) {
      // Parse timestamp - support both aggregator (createTime) and RapidAPI (create_time) formats
      const ts = v.create_time ?? v.createTime ?? v.create_time_utc ?? v.create_date ?? v.timestamp;
      const ms = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Number(ts) > 0 ? (Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000) : Date.parse(ts);
      const d = new Date(ms);
      
      if (isNaN(d.getTime())) {
        console.log(`[TikTok Parse] SKIP: Invalid date for video`, v.video_id || v.aweme_id);
        continue;
      }
      if (d < minDate) {
        console.log(`[TikTok Parse] SKIP: Video too old (${d.toISOString()})`, v.video_id || v.aweme_id);
        continue;
      }
      if (maxDate && d > maxDate) {
        console.log(`[TikTok Parse] SKIP: Video too new (${d.toISOString()})`, v.video_id || v.aweme_id);
        continue;
      }
      
      // Parse video ID - support multiple formats
      const vId = v.video_id || v.id || deriveVideoId(v);
      
      if (!vId) {
        console.log(`[TikTok Parse] SKIP: No video ID found`, v);
        continue;
      }
      
      // Parse stats - CRITICAL: Support both RapidAPI and Aggregator formats
      // RapidAPI: v.stats.playCount or v.statsV2.playCount
      // Aggregator: v.playCount or v.play_count directly on object
      const vViews = readStat(v,'play') || Number(v.playCount || v.play_count || v.views || 0) || 0;
      const vLikes = readStat(v,'digg') || Number(v.likeCount || v.like_count || v.diggCount || v.digg_count || v.likes || 0) || 0;
      const vComments = readStat(v,'comment') || Number(v.commentCount || v.comment_count || v.comments || 0) || 0;
      const vShares = readStat(v,'share') || Number(v.shareCount || v.share_count || v.shares || 0) || 0;
      const vSaves = readStat(v,'save') || Number(v.saveCount || v.save_count || v.collectCount || v.collect_count || v.favoriteCount || v.favorite_count || v.saves || 0) || 0;
      
      console.log(`[TikTok Parse] ✅ Video ${vId}: views=${vViews}, likes=${vLikes}, comments=${vComments}, date=${d.toISOString().slice(0,10)}`);
      
      totals.views += vViews; totals.likes += vLikes; totals.comments += vComments; totals.shares += vShares; totals.saves += vSaves; totals.posts_total += 1;
      if (vId) toUpsert.push({ video_id: String(vId), username: normalized, sec_uid: tiktok_sec_uid || null, post_date: d.toISOString().slice(0, 10), taken_at: d.toISOString(), play_count: vViews, digg_count: vLikes, comment_count: vComments, share_count: vShares, save_count: vSaves });
    }
    
    console.log(`[TikTok Parse] ${normalized}: Parsed ${toUpsert.length}/${videos.length} videos. Total stats: views=${totals.views}, likes=${totals.likes}`);
    
    if (toUpsert.length) {
      const chunkSize = 500;
      for (let i = 0; i < toUpsert.length; i += chunkSize) {
        const chunk = toUpsert.slice(i, i + chunkSize);
        await admin.from('tiktok_posts_daily').upsert(chunk, { onConflict: 'video_id' });
      }
    }

    // Fetch user followers count from RapidAPI
    let followers = 0;
    try {
      const infoUrl = `https://${TIKTOK_RAPID_HOST}/user/info?unique_id=@${encodeURIComponent(normalized)}`;
      const infoData = await rapidApiRequest({ url: infoUrl, method: 'GET', rapidApiHost: TIKTOK_RAPID_HOST, timeoutMs: 15000 });
      followers = Number(infoData?.data?.stats?.followerCount || infoData?.userInfo?.stats?.followerCount || 0) || 0;
    } catch (err) {
      console.error('[fetch-metrics] Failed to fetch follower count from RapidAPI:', err);
    }

    let tiktokData: any = { ...totals, followers };
    if (startBound && endBound) {
      const { data: aggRows } = await admin.from('tiktok_posts_daily').select('play_count, digg_count, comment_count, share_count, save_count, post_date').eq('username', normalized).gte('post_date', startParam!).lte('post_date', endParam!);
      if ((aggRows?.length || 0) > 0) {
        const acc = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 } as any;
        for (const r of aggRows || []) { acc.views += safeParseInt(r.play_count); acc.likes += safeParseInt(r.digg_count); acc.comments += safeParseInt(r.comment_count); acc.shares += safeParseInt(r.share_count); acc.saves += safeParseInt(r.save_count); }
        tiktokData = { ...totals, ...acc, posts_total: (aggRows || []).length, followers };
      }
    }

    // Save summary metrics (social_metrics) and history
    await admin.from('social_metrics').upsert({ user_id: userId, platform: 'tiktok', followers, likes: tiktokData.likes, views: tiktokData.views, comments: tiktokData.comments, shares: tiktokData.shares, saves: tiktokData.saves, last_updated: new Date().toISOString() }, { onConflict: 'user_id,platform' });
    try { await admin.from('social_metrics_history').insert({ user_id: userId, platform: 'tiktok', followers, likes: tiktokData.likes, views: tiktokData.views, comments: tiktokData.comments, shares: tiktokData.shares, saves: tiktokData.saves, captured_at: new Date().toISOString() }); } catch {}

    return NextResponse.json({ tiktok: tiktokData, source: 'external', telemetry });
  } catch (error) {
    console.error('fetch-metrics error', error);
    return NextResponse.json({ error: 'An internal server error occurred.' }, { status: 500 });
  }
}
