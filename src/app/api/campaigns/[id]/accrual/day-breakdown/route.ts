import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function canView(campaignId: string) {
  const supa = await createSSR();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return false;
  const { data } = await supa.from('users').select('role').eq('id', user.id).single();
  const role = (data as any)?.role;
  if (role === 'admin' || role === 'super_admin') return true;
  const admin = adminClient();
  const { data: eg } = await admin.from('employee_groups').select('employee_id').eq('campaign_id', campaignId).eq('employee_id', user.id).maybeSingle();
  return !!eg;
}

export async function GET(req: Request, ctx: any) {
  try {
    const { id } = await ctx.params as { id: string };
    const allowed = await canView(id); if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const admin = adminClient();
    const url = new URL(req.url);
    const day = String(url.searchParams.get('date') || '2026-01-02');
    const format = String(url.searchParams.get('format') || 'json').toLowerCase();
    const cutoff = String(process.env.ACCRUAL_CUTOFF_DATE || '2026-01-02');
    const effDay = day < cutoff ? cutoff : day;

    // Build campaign users (TikTok)
    const { data: ttParts } = await admin.from('campaign_participants').select('tiktok_username').eq('campaign_id', id);
    const handles = Array.from(new Set((ttParts||[]).map((r:any)=> String(r.tiktok_username).replace(/^@/,'').toLowerCase())));
    const userIds = new Set<string>();
    if (handles.length) {
      const { data: u1 } = await admin.from('users').select('id, tiktok_username').in('tiktok_username', handles);
      for (const r of u1||[]) userIds.add(String((r as any).id));
      const { data: map } = await admin.from('user_tiktok_usernames').select('user_id, tiktok_username').in('tiktok_username', handles);
      for (const r of map||[]) userIds.add(String((r as any).user_id));
    }

    const ids = Array.from(userIds);
    if (!ids.length) return NextResponse.json({ date: effDay, totals: {views:0,likes:0,comments:0,shares:0,saves:0}, top: [] });

    // Fetch snapshots D-1 and D
    const prev = new Date(effDay+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
    const prevISO = prev.toISOString().slice(0,10);
    const { data: rows } = await admin
      .from('social_metrics_history')
      .select('user_id, platform, views, likes, comments, shares, saves, captured_at')
      .in('user_id', ids)
      .eq('platform', 'tiktok')
      .gte('captured_at', prevISO + 'T00:00:00Z')
      .lte('captured_at', effDay + 'T23:59:59Z')
      .order('user_id', { ascending: true })
      .order('captured_at', { ascending: true });

    const byUser = new Map<string, any[]>();
    for (const r of rows||[]) {
      const uid = String((r as any).user_id);
      const arr = byUser.get(uid) || []; arr.push(r); byUser.set(uid, arr);
    }

    const top: Array<{user_id:string; views:number; likes:number; comments:number; shares:number; saves:number}> = [];
    let totals = { views:0, likes:0, comments:0, shares:0, saves:0 };

    for (const [uid, arr] of byUser.entries()) {
      // Use last-of-day minus last-of-previous-day to avoid jitter overcount
      const lastByDay = new Map<string, any>();
      for (const r of arr) {
        const d = String((r as any).captured_at).slice(0,10);
        lastByDay.set(d, r);
      }
      const baseline = lastByDay.get(prevISO) || null;
      const today = lastByDay.get(effDay) || null;
      let sum = { views:0, likes:0, comments:0, shares:0, saves:0 };
      if (baseline && today) {
        sum.views = Math.max(0, Number((today as any).views||0) - Number((baseline as any).views||0));
        sum.likes = Math.max(0, Number((today as any).likes||0) - Number((baseline as any).likes||0));
        sum.comments = Math.max(0, Number((today as any).comments||0) - Number((baseline as any).comments||0));
        sum.shares = Math.max(0, Number((today as any).shares||0) - Number((baseline as any).shares||0));
        sum.saves = Math.max(0, Number((today as any).saves||0) - Number((baseline as any).saves||0));
      }
      if (sum.views+sum.likes+sum.comments+sum.shares+sum.saves>0) {
        totals.views += sum.views; totals.likes += sum.likes; totals.comments += sum.comments; totals.shares += sum.shares; totals.saves += sum.saves;
        top.push({ user_id: uid, ...sum });
      }
    }

    top.sort((a,b)=> b.views - a.views);
    const payload = { date: effDay, totals, top: top.slice(0, 100) };
    if (format === 'csv') {
      const header = ['user_id','views','likes','comments','shares','saves'];
      const rows = [header.join(',')].concat(
        payload.top.map(r => [r.user_id, r.views, r.likes, r.comments, r.shares, r.saves].join(','))
      );
      const csv = rows.join('\n');
      return new Response(csv, { headers: { 'content-type': 'text/csv' } });
    }
    return NextResponse.json(payload);
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
