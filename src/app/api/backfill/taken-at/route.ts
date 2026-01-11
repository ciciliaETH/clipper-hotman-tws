import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';
import { rapidApiRequest } from '@/lib/rapidapi';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function isAuthorized(req: Request) {
  const supa = await createSSR();
  const { data: { user } } = await supa.auth.getUser();
  if (user) {
    const { data } = await supa.from('users').select('role').eq('id', user.id).single();
    if ((data as any)?.role === 'admin' || (data as any)?.role === 'super_admin') return true;
  }
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token && token === (process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY)) return true;
  return false;
}

const IG_HOST = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram120.p.rapidapi.com';
const IG_MEDIA_API = 'instagram-media-api.p.rapidapi.com'; // Primary API for media details
const TT_HOST = process.env.RAPIDAPI_TIKTOK_HOST || 'tiktok-scraper7.p.rapidapi.com';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function parseMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    if (!(await isAuthorized(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const limitParam = Number(url.searchParams.get('limit') || body.limit || 100);
    const platformParam = url.searchParams.get('platform') || body.platform || 'all'; // 'instagram', 'tiktok', 'all'
    const usernameFilter = url.searchParams.get('username') || body.username || null;

    const supa = admin();
    let totalUpdated = 0;
    let totalFailed = 0;
    const allResults: any[] = [];

    // ============ INSTAGRAM ============
    if (platformParam === 'all' || platformParam === 'instagram') {
      let query = supa
        .from('instagram_posts_daily')
        .select('id, code, username, post_date')
        .is('taken_at', null)
        .order('play_count', { ascending: false })
        .limit(limitParam);

      if (usernameFilter) {
        query = query.eq('username', usernameFilter.toLowerCase().replace(/^@/, ''));
      }

      const { data: igPosts, error } = await query;
      if (error) throw error;

      for (const post of igPosts || []) {
        const code = post.code;
        if (!code) {
          totalFailed++;
          continue;
        }

        try {
          let takenAt: string | null = null;

          // PRIMARY: Use instagram-media-api.p.rapidapi.com/media/shortcode_reels endpoint (POST)
          try {
            const j = await rapidApiRequest<any>({
              url: `https://${IG_MEDIA_API}/media/shortcode_reels`,
              method: 'POST',
              rapidApiHost: IG_MEDIA_API,
              body: { shortcode: code, proxy: '' },
              timeoutMs: 12000
            });
            // Response: data.xdt_api__v1__media__shortcode__web_info.items[0].taken_at
            const items = j?.data?.xdt_api__v1__media__shortcode__web_info?.items || j?.items || [];
            const item = items[0] || j;
            const ts = parseMs(item?.taken_at) || parseMs(item?.taken_at_timestamp);
            if (ts) {
              takenAt = new Date(ts).toISOString();
            }
          } catch {}

          // FALLBACK: Try older endpoints
          if (!takenAt) {
            const endpoints = [
              `https://${IG_HOST}/api/instagram/media_info?code=${encodeURIComponent(code)}`,
              `https://${IG_HOST}/api/instagram/post_info?code=${encodeURIComponent(code)}`,
            ];

            for (const endpoint of endpoints) {
              try {
                const j = await rapidApiRequest<any>({
                  url: endpoint,
                  method: 'GET',
                  rapidApiHost: IG_HOST,
                  timeoutMs: 15000
                });
                const m = j?.result?.items?.[0] || j?.result?.media || j?.result || j?.item || j;
                const ts = parseMs(m?.taken_at) || parseMs(m?.taken_at_ms) || parseMs(m?.caption?.created_at);
                if (ts) {
                  takenAt = new Date(ts).toISOString();
                  break;
                }
              } catch {}
            }
          }

          if (takenAt) {
            const { error: upErr } = await supa
              .from('instagram_posts_daily')
              .update({ 
                taken_at: takenAt,
                post_date: takenAt.slice(0, 10)
              })
              .eq('id', post.id);

            if (!upErr) {
              totalUpdated++;
              allResults.push({ platform: 'instagram', id: post.id, code, taken_at: takenAt, status: 'updated' });
            } else {
              totalFailed++;
            }
          } else {
            totalFailed++;
          }

          await sleep(500);
        } catch (err: any) {
          totalFailed++;
        }
      }
    }

    // ============ TIKTOK ============
    if (platformParam === 'all' || platformParam === 'tiktok') {
      let query = supa
        .from('tiktok_posts_daily')
        .select('video_id, username, post_date')
        .is('taken_at', null)
        .order('play_count', { ascending: false })
        .limit(limitParam);

      if (usernameFilter) {
        query = query.eq('username', usernameFilter.toLowerCase().replace(/^@/, ''));
      }

      const { data: ttPosts, error } = await query;
      if (error) throw error;

      for (const post of ttPosts || []) {
        const videoId = post.video_id;
        if (!videoId) {
          totalFailed++;
          continue;
        }

        try {
          // Try to get video info from TikTok API
          const endpoint = `https://${TT_HOST}/video/info?video_id=${encodeURIComponent(videoId)}`;
          
          let takenAt: string | null = null;
          try {
            const j = await rapidApiRequest<any>({
              url: endpoint,
              method: 'GET',
              rapidApiHost: TT_HOST,
              timeoutMs: 15000
            });
            const v = j?.data || j?.aweme_detail || j?.itemInfo?.itemStruct || j;
            const ts = parseMs(v?.create_time) || parseMs(v?.createTime) || parseMs(v?.create_time_utc);
            if (ts) {
              takenAt = new Date(ts).toISOString();
            }
          } catch {}

          if (takenAt) {
            const { error: upErr } = await supa
              .from('tiktok_posts_daily')
              .update({ 
                taken_at: takenAt,
                post_date: takenAt.slice(0, 10)
              })
              .eq('video_id', videoId);

            if (!upErr) {
              totalUpdated++;
              allResults.push({ platform: 'tiktok', video_id: videoId, taken_at: takenAt, status: 'updated' });
            } else {
              totalFailed++;
            }
          } else {
            totalFailed++;
          }

          await sleep(500);
        } catch (err: any) {
          totalFailed++;
        }
      }
    }

    return NextResponse.json({
      updated: totalUpdated,
      failed: totalFailed,
      platform: platformParam,
      results: allResults.slice(0, 20)
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
