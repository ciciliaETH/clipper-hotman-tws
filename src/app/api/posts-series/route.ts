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

    // Get TikTok usernames (from users + employee_participants)
    const tiktokUsernames = new Set<string>();
    for (const u of users || []) {
      if (u.tiktok_username) {
        tiktokUsernames.add(u.tiktok_username.toLowerCase().replace(/^@+/, ''));
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

    // Get Instagram usernames (from users + employee_instagram_participants)
    const instagramUsernames = new Set<string>();
    for (const u of users || []) {
      if (u.instagram_username) {
        instagramUsernames.add(u.instagram_username.toLowerCase().replace(/^@+/, ''));
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

    // Query TikTok posts
    if ((platform === 'all' || platform === 'tiktok') && tiktokUsernames.size > 0) {
      const { data: ttPosts } = await supabase
        .from('tiktok_posts_daily')
        .select('video_id, username, post_date, title')
        .in('username', Array.from(tiktokUsernames))
        .gte('post_date', startDate)
        .lte('post_date', endDate);

      // Group by date, count unique video_ids
      const videosByDate = new Map<string, Set<string>>();
      for (const row of ttPosts || []) {
        // Apply hashtag filter
        if (requiredHashtags && requiredHashtags.length > 0) {
          if (!hasRequiredHashtag(row.title, requiredHashtags)) continue;
        }
        
        const date = String(row.post_date);
        if (!videosByDate.has(date)) {
          videosByDate.set(date, new Set());
        }
        videosByDate.get(date)!.add(row.video_id);
      }

      // Add to postsByDate
      for (const [date, videos] of videosByDate.entries()) {
        const entry = postsByDate.get(date) || { tiktok: 0, instagram: 0, total: 0 };
        entry.tiktok = videos.size;
        entry.total += videos.size;
        postsByDate.set(date, entry);
      }
    }

    // Query Instagram posts
    if ((platform === 'all' || platform === 'instagram') && instagramUsernames.size > 0) {
      const { data: igPosts } = await supabase
        .from('instagram_posts_daily')
        .select('id, username, post_date, caption')
        .in('username', Array.from(instagramUsernames))
        .gte('post_date', startDate)
        .lte('post_date', endDate);

      // Group by date, count unique ids
      const postIdsByDate = new Map<string, Set<string>>();
      for (const row of igPosts || []) {
        // Apply hashtag filter
        if (requiredHashtags && requiredHashtags.length > 0) {
          if (!hasRequiredHashtag((row as any).caption, requiredHashtags)) continue;
        }
        
        const date = String((row as any).post_date);
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
      platform
    });
  } catch (e: any) {
    console.error('[posts-series] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
