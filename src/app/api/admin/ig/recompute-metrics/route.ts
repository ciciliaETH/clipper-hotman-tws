import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supa = adminClient();
    const body = await req.json().catch(()=>({}));
    const days = Math.max(1, Math.min(180, Number(body?.days || 60))); // default 60 days
    const since = new Date(); since.setUTCDate(since.getUTCDate() - (days - 1));
    const startISO = since.toISOString().slice(0,10);

    // Build mapping user_id -> handles set
    const map = new Map<string, Set<string>>();
    const norm = (u:string)=> String(u||'').trim().replace(/^@+/, '').toLowerCase();

    try {
      const { data } = await supa.from('users').select('id, instagram_username').not('instagram_username','is',null);
      for (const r of data||[]) {
        const uid = String((r as any).id); const h = norm((r as any).instagram_username);
        if (!uid || !h) continue; if (!map.has(uid)) map.set(uid, new Set()); map.get(uid)!.add(h);
      }
    } catch {}
    try {
      const { data } = await supa.from('user_instagram_usernames').select('user_id, instagram_username');
      for (const r of data||[]) {
        const uid = String((r as any).user_id); const h = norm((r as any).instagram_username);
        if (!uid || !h) continue; if (!map.has(uid)) map.set(uid, new Set()); map.get(uid)!.add(h);
      }
    } catch {}

    const userIds = Array.from(map.keys());
    if (!userIds.length) return NextResponse.json({ updated: 0, message: 'No IG mappings' });

    let updated = 0;
    const nowIso = new Date().toISOString();
    for (const uid of userIds) {
      const handles = Array.from(map.get(uid) || []);
      if (!handles.length) continue;
      const { data: rows } = await supa
        .from('instagram_posts_daily')
        .select('play_count, like_count, comment_count, username, post_date')
        .in('username', handles)
        .gte('post_date', startISO);
      const agg = (rows||[]).reduce((a:any,r:any)=>({
        views: a.views + (Number((r as any).play_count)||0),
        likes: a.likes + (Number((r as any).like_count)||0),
        comments: a.comments + (Number((r as any).comment_count)||0),
      }), { views:0, likes:0, comments:0 });
      await supa.from('social_metrics').upsert({
        user_id: uid,
        platform: 'instagram',
        followers: 0,
        likes: agg.likes,
        views: agg.views,
        comments: agg.comments,
        shares: 0,
        saves: 0,
        last_updated: nowIso
      }, { onConflict: 'user_id,platform' });
      await supa.from('social_metrics_history').insert({
        user_id: uid,
        platform: 'instagram',
        followers: 0,
        likes: agg.likes,
        views: agg.views,
        comments: agg.comments,
        shares: 0,
        saves: 0,
        captured_at: nowIso
      }).catch(()=>{});
      updated++;
    }

    return NextResponse.json({ updated, days });
  } catch (e:any) {
    return NextResponse.json({ error: e.message || 'Failed' }, { status: 500 });
  }
}
