
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60;

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || '10')));
    const platform = (url.searchParams.get('platform') || 'all').toLowerCase();
    const supabase = supabaseAdmin();

    // Compose SQL for union all top videos
    let sql = `
      SELECT * FROM (
        SELECT
          'tiktok' AS platform,
          video_id,
          username,
          post_date,
          play_count AS views,
          digg_count AS likes,
          comment_count AS comments,
          share_count AS shares,
          save_count AS saves,
          (digg_count + comment_count + share_count + save_count) AS total_engagement,
          taken_at,
          CONCAT('https://www.tiktok.com/@', username, '/video/', video_id) AS link
        FROM tiktok_posts_daily
        WHERE play_count IS NOT NULL
        UNION ALL
        SELECT
          'instagram' AS platform,
          id AS video_id,
          username,
          post_date,
          play_count AS views,
          like_count AS likes,
          comment_count AS comments,
          0 AS shares,
          0 AS saves,
          (like_count + comment_count) AS total_engagement,
          taken_at,
          CONCAT('https://www.instagram.com/reel/', code) AS link
        FROM instagram_posts_daily
        WHERE play_count IS NOT NULL
      ) AS all_videos
    `;
    if (platform !== 'all') {
      sql += ` WHERE platform = '${platform}'`;
    }
    sql += ` ORDER BY views DESC LIMIT ${limit}`;

    // NOTE: You must have a Postgres function 'exec_sql' to run raw SQL via RPC, or replace with a supported Supabase query
    const { data, error } = await supabase.rpc('exec_sql', { sql });
    if (error) throw error;

    const filtered = (data || []).filter(row => row && typeof row.views !== 'undefined');
    // Map metrics fields into a nested metrics object for each video
    const mapped = filtered.map(({ views, likes, comments, shares, saves, total_engagement, ...rest }) => ({
      ...rest,
      metrics: {
        views,
        likes,
        comments,
        shares,
        saves,
        total_engagement
      }
    }));
    return NextResponse.json({
      videos: mapped,
      platform,
      showing: mapped.length
    });
  } catch (e: any) {
    console.error('[top-videos] error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
