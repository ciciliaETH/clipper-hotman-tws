import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { hasRequiredHashtag } from '@/lib/hashtag-filter';

export const dynamic = 'force-dynamic';

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// GET: Get posts count per day based on post_date
export async function GET(req: Request) {
  try {
    const supabase = supabaseAdmin();
    const { searchParams } = new URL(req.url);
    const startDate = searchParams.get('start') || '';
    const endDate = searchParams.get('end') || new Date().toISOString().slice(0, 10);
    const campaignId = searchParams.get('campaign_id') || '';
    const platform = (searchParams.get('platform') || 'all').toLowerCase();
    const debugMode = searchParams.get('debug') === '1';
    let debug: any = debugMode ? { tiktok: {}, instagram: {} } : undefined;

    // Get all employees (karyawan) or campaign-specific employees
    let employeeIds: string[] = [];
    let requiredHashtags: string[] | null = null;

    if (campaignId) {
      // Get employees from campaign
      const { data: employees } = await supabase
        .from('employee_groups')
        .select('employee_id')
        .eq('campaign_id', campaignId);
      employeeIds = (employees || []).map((e: any) => e.employee_id);
      
      // Get campaign hashtags
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('required_hashtags')
        .eq('id', campaignId)
        .single();
      requiredHashtags = (campaign as any)?.required_hashtags || null;
    } else {
      // All employees
      const { data: emps } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'karyawan');
      employeeIds = (emps || []).map((r: any) => String(r.id));
    }

    if (employeeIds.length === 0) {
      return NextResponse.json({ series: [], total: 0 });
    }

    // Get usernames for employees
    const { data: users } = await supabase
      .from('users')
      .select('id, tiktok_username, instagram_username')
      .in('id', employeeIds);

    // Get TikTok usernames (from users + user_tiktok_usernames + employee_participants)
    const tiktokUsernames = new Set<string>();
    for (const u of users || []) {
      if (u.tiktok_username) {
        tiktokUsernames.add(u.tiktok_username.toLowerCase().replace(/^@+/, ''));
      }
    }
    // From mapping table
    if (employeeIds.length) {
      const { data: ttMap } = await supabase
        .from('user_tiktok_usernames')
        .select('tiktok_username, user_id')
        .in('user_id', employeeIds);
      for (const r of ttMap || []) {
        const h = String((r as any).tiktok_username||'').trim().toLowerCase().replace(/^@+/, '');
        if (h) tiktokUsernames.add(h);
      }
    }
    
    const { data: ttParticipants } = await supabase
      .from('employee_participants')
      .select('tiktok_username')
      .in('employee_id', employeeIds);
    for (const p of ttParticipants || []) {
      if ((p as any).tiktok_username) {
        tiktokUsernames.add((p as any).tiktok_username.toLowerCase().replace(/^@+/, ''));
      }
    }

    // Get Instagram usernames (from users + user_instagram_usernames + employee_instagram_participants)
    const instagramUsernames = new Set<string>();
    for (const u of users || []) {
      if (u.instagram_username) {
        instagramUsernames.add(u.instagram_username.toLowerCase().replace(/^@+/, ''));
      }
    }
    if (employeeIds.length) {
      const { data: igMap } = await supabase
        .from('user_instagram_usernames')
        .select('instagram_username, user_id')
        .in('user_id', employeeIds);
      for (const r of igMap || []) {
        const h = String((r as any).instagram_username||'').trim().toLowerCase().replace(/^@+/, '');
        if (h) instagramUsernames.add(h);
      }
    }
    
    const { data: igParticipants } = await supabase
      .from('employee_instagram_participants')
      .select('instagram_username')
      .in('employee_id', employeeIds);
    for (const p of igParticipants || []) {
      if (p.instagram_username) {
        instagramUsernames.add(p.instagram_username.toLowerCase().replace(/^@+/, ''));
      }
    }

    // Count posts per date
    const postsByDate = new Map<string, { tiktok: number; instagram: number; total: number }>();

    // Initialize dates in range
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      postsByDate.set(dateStr, { tiktok: 0, instagram: 0, total: 0 });
    }

    // Query TikTok posts (prefer taken_at; include legacy post_date when taken_at is null)
    if (platform === 'all' || platform === 'tiktok') {
      // Single query using OR to avoid missing rows due to filter composition
      const startTs = `${startDate}T00:00:00Z`;
      const endNext = new Date(startTs);
      // end bound exclusive: next day 00:00Z when start==end, or end+1day 00:00Z
      const endBase = new Date(`${endDate}T00:00:00Z`);
      const endNextTsDate = new Date(endBase.getTime() + 24*60*60*1000);
      const endTs = endNextTsDate.toISOString();
      // Use two queries (stable across PostgREST versions)
      const { data: ttTaken } = await supabase
        .from('tiktok_posts_daily')
        .select('video_id, username, taken_at, post_date, title')
        .gte('taken_at', startTs)
        .lt('taken_at', endTs);
      const { data: ttLegacy } = await supabase
        .from('tiktok_posts_daily')
        .select('video_id, username, taken_at, post_date, title')
        .is('taken_at', null)
        .gte('post_date', startDate)
        .lt('post_date', new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 24*60*60*1000).toISOString().slice(0,10));
      let ttPosts = ([] as any[]).concat(ttTaken||[], ttLegacy||[]);
      if (debugMode) debug.tiktok = { taken: (ttTaken||[]).length, legacy: (ttLegacy||[]).length };
      // Safety fallback: if still empty, fallback to post_date window
      if (!ttPosts || ttPosts.length === 0) {
        const { data: ttByPostDate } = await supabase
          .from('tiktok_posts_daily')
          .select('video_id, username, taken_at, post_date, title')
          .gte('post_date', startDate)
          .lt('post_date', new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 24*60*60*1000).toISOString().slice(0,10));
        ttPosts = ttByPostDate || [];
        if (debugMode) debug.tiktok.fallback_post_date = (ttByPostDate||[]).length;
      }

      // Group by date (taken_at day), count unique video_ids
      const videosByDate = new Map<string, Set<string>>();
      for (const row of ttPosts || []) {
        // Apply hashtag filter
        if (requiredHashtags && requiredHashtags.length > 0) {
          if (!hasRequiredHashtag((row as any).title, requiredHashtags)) continue;
        }
        const raw = (row as any).taken_at as string | null;
        const dStr = raw ? String(raw).slice(0,10) : String((row as any).post_date);
        if (!videosByDate.has(dStr)) videosByDate.set(dStr, new Set());
        videosByDate.get(dStr)!.add(String((row as any).video_id));
      }

      // Extra daily fallback: if only satu hari dan masih kosong, pakai equality pada post_date (legacy)
      const daySpan = Math.max(1, Math.floor((end.getTime() - start.getTime())/ (24*60*60*1000)) + 1);
      if (videosByDate.size === 0 && daySpan === 1) {
        const { data: ttEq } = await supabase
          .from('tiktok_posts_daily')
          .select('video_id, taken_at, post_date, title')
          .eq('post_date', startDate);
        for (const row of ttEq||[]) {
          const raw = (row as any).taken_at as string | null;
          const dStr = raw ? String(raw).slice(0,10) : String((row as any).post_date);
          if (!videosByDate.has(dStr)) videosByDate.set(dStr, new Set());
          videosByDate.get(dStr)!.add(String((row as any).video_id));
        }
        if (debugMode) debug.tiktok.eq_post_date = (ttEq||[]).length;
      }

      // Add to postsByDate
      for (const [date, videos] of videosByDate.entries()) {
        const entry = postsByDate.get(date) || { tiktok: 0, instagram: 0, total: 0 };
        entry.tiktok = videos.size;
        entry.total += videos.size;
        postsByDate.set(date, entry);
      }

      // Last-resort fallback: if nothing filled, use DB-side count per day
      if ([...postsByDate.values()].every(v => (v.tiktok||0) === 0)) {
        const days: string[] = Array.from(postsByDate.keys());
        for (const day of days) {
          const startISO = `${day}T00:00:00Z`;
          const endISO = new Date(new Date(startISO).getTime() + 24*60*60*1000).toISOString();
          const { count: c1 } = await supabase
            .from('tiktok_posts_daily')
            .select('video_id', { head: true, count: 'exact' })
            .gte('taken_at', startISO)
            .lt('taken_at', endISO);
          const { count: c2 } = await supabase
            .from('tiktok_posts_daily')
            .select('video_id', { head: true, count: 'exact' })
            .is('taken_at', null)
            .eq('post_date', day);
          const cnt = (c1 || 0) + (c2 || 0);
          if (debugMode) {
            debug.tiktok = { ...(debug.tiktok||{}), [`count_${day}`]: cnt };
          }
          const entry = postsByDate.get(day) || { tiktok: 0, instagram: 0, total: 0 };
          entry.tiktok = cnt;
          entry.total += cnt;
          postsByDate.set(day, entry);
        }
      }
    }

    // Query Instagram posts (prefer taken_at; include legacy rows with taken_at IS NULL using post_date)
    if (platform === 'all' || platform === 'instagram') {
      const startTsIG = `${startDate}T00:00:00Z`;
      const endTsIG = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 24*60*60*1000).toISOString();
      // 1) Rows with taken_at in range
      const { data: igTaken } = await supabase
        .from('instagram_posts_daily')
        .select('id, username, taken_at, post_date, caption')
        .in('username', Array.from(instagramUsernames))
        .gte('taken_at', startTsIG)
        .lt('taken_at', endTsIG);
      // 2) Legacy rows where taken_at is null but post_date in range
      const { data: igLegacy } = await supabase
        .from('instagram_posts_daily')
        .select('id, username, taken_at, post_date, caption')
        .in('username', Array.from(instagramUsernames))
        .is('taken_at', null)
        .gte('post_date', startDate)
        .lt('post_date', new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 24*60*60*1000).toISOString().slice(0,10));
      const igPosts = ([] as any[]).concat(igTaken||[], igLegacy||[]);
      if (debugMode) debug.instagram = { taken: (igTaken||[]).length, legacy: (igLegacy||[]).length };

      // Group by taken_at day, count unique ids
      const postIdsByDate = new Map<string, Set<string>>();
      for (const row of igPosts || []) {
        // Apply hashtag filter
        if (requiredHashtags && requiredHashtags.length > 0) {
          if (!hasRequiredHashtag((row as any).caption, requiredHashtags)) continue;
        }

        // Prefer taken_at date; fallback to post_date if null
        const rawTaken = (row as any).taken_at as string | null;
        const date = rawTaken ? new Date(rawTaken).toISOString().slice(0,10) : String((row as any).post_date);
        if (!date) continue;
        if (!postIdsByDate.has(date)) {
          postIdsByDate.set(date, new Set());
        }
        postIdsByDate.get(date)!.add(String((row as any).id));
      }

      // Add to postsByDate
      for (const [date, posts] of postIdsByDate.entries()) {
        const entry = postsByDate.get(date) || { tiktok: 0, instagram: 0, total: 0 };
        entry.instagram = posts.size;
        entry.total += posts.size;
        postsByDate.set(date, entry);
      }
    }

    // Convert to array sorted by date
    const series = Array.from(postsByDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, counts]) => ({
        date,
        posts: counts.total,
        posts_tiktok: counts.tiktok,
        posts_instagram: counts.instagram
      }));

    const total = series.reduce((sum, s) => sum + s.posts, 0);

    return NextResponse.json({
      series,
      total,
      start: startDate,
      end: endDate,
      platform,
      ...(debugMode ? { debug } : {})
    });
  } catch (e: any) {
    console.error('[posts-series] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
