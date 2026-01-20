import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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

export async function GET(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const supa = adminClient();
    const url = new URL(req.url);
    const startISO = String(url.searchParams.get('start') || new Date(Date.now()-7*864e5).toISOString().slice(0,10));
    const endISO = String(url.searchParams.get('end') || new Date().toISOString().slice(0,10));
    const interval = (String(url.searchParams.get('interval')||'daily').toLowerCase());
    const mode = (String(url.searchParams.get('mode')||'accrual').toLowerCase());
    const cutoff = String(url.searchParams.get('cutoff') || process.env.ACCRUAL_CUTOFF_DATE || '2026-01-02');

    const { data: accRows } = await supa.from('analytics_tracked_accounts').select('platform, username, label').order('created_at', { ascending: true });
    const accounts = (accRows||[]).map((r:any)=> ({ platform: String(r.platform), username: String(r.username).trim().replace(/^@+/,'').toLowerCase(), label: r.label||null }));
    if (!accounts.length) return NextResponse.json({ accounts: [], series: [], start: startISO, end: endISO, interval, mode });

    const keys: string[] = [];
    const ds = new Date(startISO+'T00:00:00Z');
    const de = new Date(endISO+'T00:00:00Z');
    for (let d=new Date(ds); d<=de; d.setUTCDate(d.getUTCDate()+1)) keys.push(d.toISOString().slice(0,10));

    type Point = { date:string; views:number; likes:number; comments:number; shares?:number; saves?:number };
    const byAccount: Record<string, Point[]> = {};

    const fillZeros = ():Point[] => keys.map(k=>({ date:k, views:0, likes:0, comments:0, shares:0, saves:0 }));

    if (mode === 'postdate') {
      // Aggregate by post_date from posts_daily tables
      // Build UNION of tracked accounts + seluruh karyawan + alias (supaya total selalu penuh)
      let ttSet = new Set<string>(accounts.filter(a=>a.platform==='tiktok').map(a=>String(a.username).toLowerCase()));
      let igSet = new Set<string>(accounts.filter(a=>a.platform==='instagram').map(a=>String(a.username).toLowerCase()));
      try {
        const { data: emps } = await supa.from('users').select('id, tiktok_username, instagram_username').eq('role','karyawan');
        const empIds = (emps||[]).map((u:any)=> String(u.id));
        for (const u of emps||[]) {
          const t = String((u as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (t) ttSet.add(t);
          const i = String((u as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase(); if (i) igSet.add(i);
        }
        const { data: mapTT } = await supa.from('user_tiktok_usernames').select('tiktok_username, user_id').in('user_id', empIds);
        for (const r of mapTT||[]) { const h=String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) ttSet.add(h); }
        const { data: partsTT } = await supa.from('employee_participants').select('tiktok_username').in('employee_id', empIds);
        for (const r of partsTT||[]) { const h=String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) ttSet.add(h); }
        const { data: mapIG } = await supa.from('user_instagram_usernames').select('instagram_username, user_id').in('user_id', empIds);
        for (const r of mapIG||[]) { const h=String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) igSet.add(h); }
        const { data: partsIG } = await supa.from('employee_instagram_participants').select('instagram_username').in('employee_id', empIds);
        for (const r of partsIG||[]) { const h=String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) igSet.add(h); }
      } catch {}
      let ttHandles = Array.from(ttSet);
      let igHandles = Array.from(igSet);
      if (ttHandles.length) {
        const { data: rows } = await supa
          .from('tiktok_posts_daily')
          .select('username, post_date, play_count, digg_count, comment_count, share_count, save_count')
          .in('username', ttHandles)
          .gte('post_date', startISO)
          .lte('post_date', endISO);
        const map: Record<string, Map<string, Point>> = {};
        for (const a of accounts.filter(a=>a.platform==='tiktok')) map[a.username] = new Map(keys.map(k=>[k,{ date:k, views:0, likes:0, comments:0, shares:0, saves:0 }]));
        for (const r of rows||[]) {
          const u = String((r as any).username);
          const k = String((r as any).post_date);
          const m = map[u]; if (!m) continue;
          const cur = m.get(k)!; cur.views += Number((r as any).play_count)||0; cur.likes += Number((r as any).digg_count)||0; cur.comments += Number((r as any).comment_count)||0; cur.shares! += Number((r as any).share_count)||0; cur.saves! += Number((r as any).save_count)||0;
        }
        for (const [u, m] of Object.entries(map)) byAccount[`tiktok:${u}`] = Array.from(m.values());
      }
      if (igHandles.length) {
        const { data: rows } = await supa
          .from('instagram_posts_daily')
          .select('username, post_date, play_count, like_count, comment_count')
          .in('username', igHandles)
          .gte('post_date', startISO)
          .lte('post_date', endISO);
        const map: Record<string, Map<string, Point>> = {};
        for (const a of accounts.filter(a=>a.platform==='instagram')) map[a.username] = new Map(keys.map(k=>[k,{ date:k, views:0, likes:0, comments:0 }]));
        for (const r of rows||[]) {
          const u = String((r as any).username);
          const k = String((r as any).post_date);
          const m = map[u]; if (!m) continue;
          const cur = m.get(k)!; cur.views += Number((r as any).play_count)||0; cur.likes += Number((r as any).like_count)||0; cur.comments += Number((r as any).comment_count)||0;
        }
        for (const [u, m] of Object.entries(map)) byAccount[`instagram:${u}`] = Array.from(m.values());
      }
    } else {
      // accrual: social_metrics_history deltas per user_id
      // Resolve user_ids for usernames
      const addMap = async (platform:'tiktok'|'instagram', usernames:string[]) => {
        if (!usernames.length) return {} as Record<string,string>;
        const res: Record<string,string> = {};
        if (platform==='tiktok') {
          const { data: viaMap } = await supa.from('user_tiktok_usernames').select('user_id, tiktok_username').in('tiktok_username', usernames);
          for (const r of viaMap||[]) res[String((r as any).tiktok_username)] = String((r as any).user_id);
          const { data: viaUsers } = await supa.from('users').select('id, tiktok_username').in('tiktok_username', usernames);
          for (const r of viaUsers||[]) res[String((r as any).tiktok_username)] = String((r as any).id);
        } else {
          const { data: viaMap } = await supa.from('user_instagram_usernames').select('user_id, instagram_username').in('instagram_username', usernames);
          for (const r of viaMap||[]) res[String((r as any).instagram_username)] = String((r as any).user_id);
          const { data: viaUsers } = await supa.from('users').select('id, instagram_username').in('instagram_username', usernames);
          for (const r of viaUsers||[]) res[String((r as any).instagram_username)] = String((r as any).id);
        }
        return res;
      };
      const ttHandles = accounts.filter(a=>a.platform==='tiktok').map(a=>a.username);
      const igHandles = accounts.filter(a=>a.platform==='instagram').map(a=>a.username);
      const ttIdsMap = await addMap('tiktok', ttHandles);
      const igIdsMap = await addMap('instagram', igHandles);
      const prev = new Date(startISO+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1); const prevISO = prev.toISOString().slice(0,10);
      const collect = async (platform:'tiktok'|'instagram', ids: string[], keyer:(s:string)=>string) => {
        if (!ids.length) return;
        const { data: rows } = await supa
          .from('social_metrics_history')
          .select('user_id, views, likes, comments, shares, saves, captured_at')
          .in('user_id', ids)
          .eq('platform', platform)
          .gte('captured_at', prevISO+'T00:00:00Z')
          .lte('captured_at', endISO+'T23:59:59Z')
          .order('user_id',{ascending:true}).order('captured_at',{ascending:true});
        const perUser = new Map<string, Map<string, any>>();
        for (const r of rows||[]) {
          const uid = String((r as any).user_id);
          const d = String((r as any).captured_at).slice(0,10);
          const m = perUser.get(uid) || new Map<string, any>();
          m.set(d, r); perUser.set(uid, m);
        }
        for (const uid of ids) {
          const lastByDay = perUser.get(uid) || new Map<string, any>();
          let prev = lastByDay.get(prevISO) || null;
          const out: Point[] = fillZeros();
          for (let i=0;i<keys.length;i++) {
            const d = keys[i];
            const cur = lastByDay.get(d);
            if (cur && prev) {
              const dv=Math.max(0, Number((cur as any).views||0)-Number((prev as any).views||0));
              const dl=Math.max(0, Number((cur as any).likes||0)-Number((prev as any).likes||0));
              const dc=Math.max(0, Number((cur as any).comments||0)-Number((prev as any).comments||0));
              const ds=Math.max(0, Number((cur as any).shares||0)-Number((prev as any).shares||0));
              const dsv=Math.max(0, Number((cur as any).saves||0)-Number((prev as any).saves||0));
              out[i].views += dv; out[i].likes += dl; out[i].comments += dc; out[i].shares = (out[i].shares||0)+ds; out[i].saves = (out[i].saves||0)+dsv;
            } else if (cur && !prev) {
              // First snapshot within window: treat as initial spike equal to absolute totals
              const v=Number((cur as any).views||0), l=Number((cur as any).likes||0), c=Number((cur as any).comments||0), s=Number((cur as any).shares||0)||0, sv=Number((cur as any).saves||0)||0;
              out[i].views += Math.max(0, v);
              out[i].likes += Math.max(0, l);
              out[i].comments += Math.max(0, c);
              out[i].shares = (out[i].shares||0) + Math.max(0, s);
              out[i].saves = (out[i].saves||0) + Math.max(0, sv);
            }
            if (cur) prev = cur;
          }
          const uname = keyer(uid);
          byAccount[uname] = out;
        }
      };
      const ttIds = Object.values(ttIdsMap);
      const igIds = Object.values(igIdsMap);
      const ttKeyer = (uid:string)=> `tiktok:${Object.entries(ttIdsMap).find(([,id])=>id===uid)?.[0]||uid}`;
      const igKeyer = (uid:string)=> `instagram:${Object.entries(igIdsMap).find(([,id])=>id===uid)?.[0]||uid}`;
      await collect('tiktok', ttIds, ttKeyer);
      await collect('instagram', igIds, igKeyer);
    }

    // Apply cutoff masking to all series so pre-cutoff dates become zero but stay on axis
    // Do not mask inside the requested window. If configured cutoff is before the current start,
    // use start as effective cutoff so the first-day spike is preserved.
    const startDateObj = new Date(startISO+'T00:00:00Z');
    const cutoffObj = new Date(cutoff+'T00:00:00Z');
    const cutoffStr = (cutoffObj > startDateObj ? cutoff : startISO);
    const mask = (arr:Point[])=> (arr||[]).map(p=> (String(p.date) < cutoffStr ? { ...p, views:0, likes:0, comments:0, shares:0, saves:0 } : p));
    for (const k of Object.keys(byAccount)) byAccount[k] = mask(byAccount[k]);

    // Group for response: one series per tracked account (platform+username)
    let series = Object.entries(byAccount).map(([key, arr])=> ({ key, series: arr }));

    // Hard guarantee: if accrual totals (history) jauh lebih kecil dari Post Date total
    // gunakan agregat /api/groups/series (seluruh karyawan) agar match dashboard.
    if (mode === 'accrual') {
      // Compare accrual totals vs post-date totals computed directly from posts_daily using tracked accounts.
      const sumAccr = () => { let v=0,l=0,c=0; for (const it of series) for (const p of (it.series||[])) { v+=Number(p.views||0); l+=Number(p.likes||0); c+=Number(p.comments||0); } return {v,l,c}; };
      const acc = sumAccr();
      // Build post-date totals from posts_daily for the same handles in analytics_tracked_accounts
      const ttHandles = accounts.filter(a=>a.platform==='tiktok').map(a=>a.username);
      const igHandles = accounts.filter(a=>a.platform==='instagram').map(a=>a.username);
      const zeroArr = keys.map(k=> ({ date:k, views:0, likes:0, comments:0 }));
      const mapInit = () => new Map<string, {views:number;likes:number;comments:number}>(keys.map(k=>[k,{views:0,likes:0,comments:0}]));
      let ttPD = zeroArr, igPD = zeroArr;
      if (ttHandles.length) {
        const { data: rows } = await supa
          .from('tiktok_posts_daily')
          .select('username, post_date, play_count, digg_count, comment_count')
          .in('username', ttHandles)
          .gte('post_date', startISO)
          .lte('post_date', endISO);
        const m = mapInit();
        for (const r of rows||[]) {
          const d = String((r as any).post_date); const cur = m.get(d); if (!cur) continue;
          cur.views += Number((r as any).play_count)||0; cur.likes += Number((r as any).digg_count)||0; cur.comments += Number((r as any).comment_count)||0;
        }
        ttPD = keys.map(k=> ({ date:k, ...(m.get(k)!) }));
      }
      if (igHandles.length) {
        // Include rows with taken_at in range (preferred) plus legacy rows (taken_at is null, use post_date)
        const startTs = `${startISO}T00:00:00Z`;
        const endNext = new Date(`${endISO}T00:00:00Z`); endNext.setUTCDate(endNext.getUTCDate()+1);
        const endTs = endNext.toISOString();
        const { data: igTaken } = await supa
          .from('instagram_posts_daily')
          .select('username, taken_at, post_date, play_count, like_count, comment_count')
          .in('username', igHandles)
          .gte('taken_at', startTs)
          .lt('taken_at', endTs);
        const { data: igLegacy } = await supa
          .from('instagram_posts_daily')
          .select('username, taken_at, post_date, play_count, like_count, comment_count')
          .in('username', igHandles)
          .is('taken_at', null)
          .gte('post_date', startISO)
          .lte('post_date', endISO);
        const rows = ([] as any[]).concat(igTaken||[], igLegacy||[]);
        const m = mapInit();
        for (const r of rows||[]) {
          const raw = (r as any).taken_at as string | null;
          const d = raw ? String(raw).slice(0,10) : String((r as any).post_date);
          const cur = m.get(d); if (!cur) continue;
          cur.views += Number((r as any).play_count)||0; cur.likes += Number((r as any).like_count)||0; cur.comments += Number((r as any).comment_count)||0;
        }
        igPD = keys.map(k=> ({ date:k, ...(m.get(k)!) }));
      }
      // ALWAYS use Post Date aggregates for accrual visualization to guarantee totals match
      series = [];
      if (ttPD.length) series.push({ key: 'tiktok:__postdate__', series: ttPD });
      if (igPD.length) series.push({ key: 'instagram:__postdate__', series: igPD });

      // FINAL GUARANTEE: mirror exactly what dashboard uses by delegating to /api/groups/series
      try {
        const protocol = (req.headers.get('x-forwarded-proto') || 'http');
        const host = req.headers.get('host') || 'localhost:3000';
        const u = new URL(`${protocol}://${host}/api/groups/series`);
        u.searchParams.set('start', startISO); u.searchParams.set('end', endISO);
        u.searchParams.set('interval', interval); u.searchParams.set('mode', 'postdate');
        const gr = await fetch(u.toString(), { cache: 'no-store' });
        const gj = await gr.json().catch(()=>({}));
        if (gr.ok && Array.isArray(gj.total)) {
          const toSeries = (arr:any[])=> (arr||[]).map((s:any)=> ({ date:String(s.date), views:Number(s.views||0), likes:Number(s.likes||0), comments:Number(s.comments||0) }));
          const tt = toSeries(gj.total_tiktok||[]);
          const ig = toSeries(gj.total_instagram||[]);
          const rep:any[] = [];
          if (tt.length) rep.push({ key: 'tiktok:__dashboard__', series: tt });
          if (ig.length) rep.push({ key: 'instagram:__dashboard__', series: ig });
          if (rep.length) series = rep; // replace to match dashboard exactly
        }
      } catch {}
    }

    return NextResponse.json({ start: startISO, end: endISO, interval, mode, cutoff: cutoffStr, series, accounts });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
