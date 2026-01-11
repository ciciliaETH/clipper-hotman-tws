import { NextRequest, NextResponse } from 'next/server';

interface TikTokVideo {
  ai_dynamic_cover: string;
  anchors: any;
  anchors_extras: string;
  author: {
    avatar: string;
    id: string;
    nickname: string;
    unique_id: string;
  };
  aweme_id: string;
  collect_count: number;
  comment_count: number;
  commerce_info: {
    adv_promotable: boolean;
    auction_ad_invited: boolean;
    branded_content_type: number;
    organic_log_extra: string;
    with_comment_filter_words: boolean;
  };
  commercial_video_info: string;
  cover: string;
  create_time: number;
  digg_count: number;
  download_count: number;
  duration: number;
  is_ad: boolean;
  is_top: number;
  item_comment_settings: number;
  mentioned_users: string;
  music: string;
  music_info: {
    album: string;
    author: string;
    cover: string;
    duration: number;
    id: string;
    original: boolean;
    play: string;
    title: string;
  };
  origin_cover: string;
  play: string;
  play_count: number;
  region: string;
  share_count: number;
  size: number;
  title: string;
  video_id: string;
  wm_size: number;
  wmplay: string;
}

// Simple in-memory cache (per server instance) with TTL
const _cache = new Map<string, { expires: number; value: any }>();
function getCached(key: string) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}
function setCached(key: string, value: any, ttlMs = 60_000) {
  _cache.set(key, { value, expires: Date.now() + ttlMs });
}

async function delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function retryFetchJson(url: string, opts: RequestInit = {}, retries = 3, ttlMs = 60_000) {
  const key = `${url}|${opts.method || 'GET'}`;
  const cached = getCached(key);
  if (cached) return cached;

  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      if (!res.ok) {
        // Treat 5xx as retryable
        if (res.status >= 500 && i < retries - 1) {
          await delay(200 * Math.pow(2, i));
          continue;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText} - ${text.slice(0,200)}`);
      }
      const json = JSON.parse(text);
      setCached(key, json, ttlMs);
      return json;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) await delay(200 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    const searchParams = request.nextUrl.searchParams;
    const username = searchParams.get('username');
    const count = searchParams.get('count') || '10';

    if (!username) {
      return NextResponse.json({
        cache_info: {
          cost: 0,
          from_cache: false,
          hit: false
        },
        code: -1,
        data: null,
        msg: 'Username parameter is required',
        processed_time: (Date.now() - startTime) / 1000
      }, { status: 400 });
    }

    // Fetch from external TikTok API (with retry + cache)
    const apiUrl = `http://202.10.44.90/api/v1/user/posts?username=${username}&count=${count}`;
    let data;
    try {
      data = await retryFetchJson(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        cache: 'no-store'
      }, 3, 30_000);
    } catch (fetchErr: any) {
      console.error('Fetch external API error:', fetchErr);
      return NextResponse.json({
        cache_info: { cost: 0, from_cache: false, hit: false },
        code: -1,
        data: null,
        msg: `Failed to fetch from API: ${fetchErr?.message || fetchErr}`,
        processed_time: (Date.now() - startTime) / 1000
      }, { status: 502 });
    }

    // If videos exist, try to enrich incomplete entries using TikWM as a fallback
    const videos = data?.data?.videos || [];
    if (videos.length > 0) {
      const enriched = await Promise.all(videos.map(async (v: any) => {
        const hasCore = v.play && v.play_count && v.aweme_id;
        if (hasCore) return v;

        // Build video URL and call TikWM to enrich
        const vid = v.video_id;
        if (!vid) return v;
        const videoUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${encodeURIComponent(vid)}`;
        try {
          const tikwmJson = await retryFetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`, { headers: { 'Accept': 'application/json' } }, 2, 5 * 60_000).catch(() => null);
          if (!tikwmJson || tikwmJson.code !== 0) return v;

          const info = tikwmJson.data || {};
          return {
            ...v,
            play: v.play || info.play || v.play,
            play_count: v.play_count || info.play_count || info.views || v.play_count,
            digg_count: v.digg_count || info.like_count || v.digg_count,
            comment_count: v.comment_count || info.comment_count || v.comment_count,
            share_count: v.share_count || info.share_count || v.share_count,
            cover: v.cover || info.cover || v.cover,
          };
        } catch (e) {
          return v;
        }
      }));

      // Replace videos in the original payload
      data.data.videos = enriched;
    }

    return NextResponse.json(data);

  } catch (error) {
    const processedTime = (Date.now() - startTime) / 1000;
    console.error('Error fetching TikTok data:', error);
    
    return NextResponse.json({
      cache_info: {
        cost: 0,
        from_cache: false,
        hit: false
      },
      code: -1,
      data: null,
      msg: error instanceof Error ? error.message : 'Internal server error',
      processed_time: parseFloat(processedTime.toFixed(4))
    }, { status: 500 });
  }
}
