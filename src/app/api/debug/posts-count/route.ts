import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function GET(req: Request) {
  try {
    const supa = admin();
    const url = new URL(req.url);
    const date = (url.searchParams.get('date') || new Date().toISOString().slice(0,10));

    // 1) ambil semua karyawan + mapping usernames
    const { data: emps } = await supa
      .from('users')
      .select('id, tiktok_username, instagram_username')
      .eq('role', 'karyawan');
    const empIds = (emps||[]).map((u:any)=> String(u.id));

    const ttSet = new Set<string>();
    for (const u of emps||[]) {
      const h = String((u as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase();
      if (h) ttSet.add(h);
    }
    if (empIds.length) {
      const { data: map } = await supa
        .from('user_tiktok_usernames')
        .select('tiktok_username, user_id')
        .in('user_id', empIds);
      for (const r of map||[]) {
        const h = String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase();
        if (h) ttSet.add(h);
      }
    }

    const igSet = new Set<string>();
    for (const u of emps||[]) {
      const h = String((u as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
      if (h) igSet.add(h);
    }
    if (empIds.length) {
      const { data: map } = await supa
        .from('user_instagram_usernames')
        .select('instagram_username, user_id')
        .in('user_id', empIds);
      for (const r of map||[]) {
        const h = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
        if (h) igSet.add(h);
      }
    }

    // 2) hitung posts dan totals untuk tanggal tsb
    const startTs = `${date}T00:00:00Z`;
    const endTs = `${date}T23:59:59Z`;

    // TikTok by post_date
    const { data: ttRows } = await supa
      .from('tiktok_posts_daily')
      .select('video_id, username, post_date, play_count, digg_count, comment_count, share_count, save_count')
      .in('username', Array.from(ttSet))
      .eq('post_date', date);
    const tiktokPosts = new Set<string>();
    let ttViews=0, ttLikes=0, ttComments=0, ttShares=0, ttSaves=0;
    for (const r of ttRows||[]) {
      const vid = String((r as any).video_id);
      tiktokPosts.add(vid);
      ttViews += Number((r as any).play_count)||0;
      ttLikes += Number((r as any).digg_count)||0;
      ttComments += Number((r as any).comment_count)||0;
      ttShares += Number((r as any).share_count)||0;
      ttSaves += Number((r as any).save_count)||0;
    }

    // Instagram by taken_at (fallback post_date)
    const { data: igTaken } = await supa
      .from('instagram_posts_daily')
      .select('id, username, taken_at, post_date, play_count, like_count, comment_count')
      .in('username', Array.from(igSet))
      .gte('taken_at', startTs)
      .lte('taken_at', endTs);
    const { data: igLegacy } = await supa
      .from('instagram_posts_daily')
      .select('id, username, taken_at, post_date, play_count, like_count, comment_count')
      .in('username', Array.from(igSet))
      .is('taken_at', null)
      .eq('post_date', date);
    const igRows = ([] as any[]).concat(igTaken||[], igLegacy||[]);

    const instaPosts = new Set<string>();
    let igViews=0, igLikes=0, igComments=0;
    for (const r of igRows||[]) {
      instaPosts.add(String((r as any).id));
      igViews += Number((r as any).play_count)||0;
      igLikes += Number((r as any).like_count)||0;
      igComments += Number((r as any).comment_count)||0;
    }

    return NextResponse.json({
      date,
      handles: {
        tiktok: Array.from(ttSet).slice(0,20),
        instagram: Array.from(igSet).slice(0,20),
      },
      tiktok: {
        posts: tiktokPosts.size,
        totals: { views: ttViews, likes: ttLikes, comments: ttComments, shares: ttShares, saves: ttSaves },
      },
      instagram: {
        posts: instaPosts.size,
        totals: { views: igViews, likes: igLikes, comments: igComments },
      },
    });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
