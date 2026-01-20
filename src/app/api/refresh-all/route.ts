import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // up to 5 minutes

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function ensureAdmin() {
  const supa = await createSSR();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return false;
  const { data } = await supa.from('users').select('role').eq('id', user.id).single();
  return data?.role === 'admin' || data?.role === 'super_admin';
}

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const origin = new URL(req.url).origin;
    const supa = adminClient();

    // Source of truth for which accounts to refresh: analytics_tracked_accounts
    let tracked: any[] | null = null;
    try {
      const { data, error } = await supa
        .from('analytics_tracked_accounts')
        .select('platform, username')
        .order('created_at', { ascending: true });
      if (!error) tracked = data || [];
    } catch {}

    let accounts = (tracked||[])
      .map((r:any)=> ({ platform: String(r.platform), username: String(r.username).trim().replace(/^@+/, '').toLowerCase() }))
      .filter(a=> a.username && (a.platform==='tiktok' || a.platform==='instagram'));

    // Fallback: derive from users table if no tracked accounts configured
    if (!accounts.length) {
      const { data: users } = await supa
        .from('users')
        .select('tiktok_username, instagram_username')
        .in('role', ['karyawan','leader','admin','super_admin']);
      const tt = new Set<string>();
      const ig = new Set<string>();
      for (const u of users||[]) {
        const t = String((u as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase();
        const i = String((u as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
        if (t) tt.add(t);
        if (i) ig.add(i);
      }
      accounts = [
        ...Array.from(tt).map(username=>({ platform: 'tiktok', username })),
        ...Array.from(ig).map(username=>({ platform: 'instagram', username })),
      ];
    }

    if (!accounts.length) return NextResponse.json({ updated: 0, results: [], message: 'No accounts to refresh' });

    const concurrency = Math.max(1, Number(process.env.REFRESH_ALL_CONCURRENCY || '4'));
    const results: any[] = [];

    async function refreshOne(a: { platform: string, username: string }) {
      try {
        if (a.platform === 'tiktok') {
          const url = `${origin}/api/fetch-metrics/${encodeURIComponent(a.username)}?all=1`;
          const res = await fetch(url, { method: 'GET' });
          const j = await res.json().catch(()=>({}));
          return { platform: a.platform, username: a.username, ok: res.ok, status: res.status, body: j };
        } else {
          const url = `${origin}/api/fetch-ig/${encodeURIComponent(a.username)}`;
          const res = await fetch(url, { method: 'GET' });
          const j = await res.json().catch(()=>({}));
          return { platform: a.platform, username: a.username, ok: res.ok, status: res.status, body: j };
        }
      } catch (e:any) {
        return { platform: a.platform, username: a.username, ok: false, error: String(e?.message || e) };
      }
    }

    for (let i = 0; i < accounts.length; i += concurrency) {
      const chunk = accounts.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map(refreshOne));
      for (const s of settled) results.push(s.status === 'fulfilled' ? s.value : { ok: false, error: String((s as any).reason) });
    }

    // Setelah semua refresh selesai, panggil function refresh_top_videos agar tabel top_videos terupdate
    try {
      await supa.rpc('refresh_top_videos');
    } catch (e) {
      console.error('[refresh-all] Failed to refresh_top_videos:', e);
    }
    return NextResponse.json({ updated: results.length, results });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
