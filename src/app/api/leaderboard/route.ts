import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { hasRequiredHashtag } from '@/lib/hashtag-filter';
// No SSR auth needed for public leaderboard

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes - complex leaderboard calculations

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Public endpoint: no authentication required for leaderboard snapshot

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const topParam = url.searchParams.get('top');
    const top = topParam ? Math.max(1, Math.min(10000, Number(topParam))) : null; // null = no limit
    const mode = (url.searchParams.get('mode') || 'accrual').toLowerCase();
    const forceDb = mode === 'db' || process.env.LEADERBOARD_PREFER_DB === '1';
    const scope = (url.searchParams.get('scope') || '').toLowerCase(); // 'employees' to aggregate all employees
    const monthStr = url.searchParams.get('month'); // YYYY-MM
    const intervalParam = (url.searchParams.get('interval')||'').toLowerCase();
    const startParam = url.searchParams.get('start');
    const endParam = url.searchParams.get('end');
    const supabaseAdmin = adminClient();

    // Global accrual leaderboard SELARAS /groups (pakai campaign aktif + cutoff + snapshots)
    if (mode === 'accrual' && (scope === 'employees' || scope === 'all')) {
      const daysParam = Number(url.searchParams.get('days') || '7');
      const windowDays = daysParam > 0 ? daysParam : 7;
      const cutoffISO = String(url.searchParams.get('cutoff') || process.env.ACCRUAL_CUTOFF_DATE || process.env.NEXT_PUBLIC_ACCRUAL_CUTOFF_DATE || '2026-01-02');
      const customMode = url.searchParams.get('custom') === '1';
      
      let startISO: string;
      let endISO: string;
      
      if (customMode) {
        // Custom date mode: use cutoff as start, calculate end from days
        startISO = cutoffISO;
        const endD = new Date(cutoffISO + 'T00:00:00Z');
        endD.setUTCDate(endD.getUTCDate() + (windowDays - 1));
        endISO = endD.toISOString().slice(0, 10);
      } else {
        // Preset mode: rolling window from today
        endISO = new Date().toISOString().slice(0,10);
        startISO = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(windowDays-1)); return d.toISOString().slice(0,10) })();
      }

      // Ambil SEMUA anggota dari semua groups + union semua user role=karyawan
      const { data: egAll } = await supabaseAdmin
        .from('employee_groups')
        .select('employee_id');
      const idsEG = Array.from(new Set((egAll||[]).map((r:any)=> String((r as any).employee_id))));
      const { data: roleUsers } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('role','karyawan');
      const idsRole = (roleUsers||[]).map((u:any)=> String((u as any).id));
      const empIds: string[] = Array.from(new Set([ ...idsEG, ...idsRole ]));
      if (!empIds.length) return NextResponse.json({ top, start: startISO, end: endISO, data: [], scope: 'employees', days: windowDays });

      // Fetch profiles for labeling
      const { data: empUsers } = await supabaseAdmin
        .from('users')
        .select('id, full_name, username, tiktok_username, instagram_username')
        .in('id', empIds);

      // Helper: accrual per user dari snapshots (persis seperti /groups)
      const accrualForUser = async (uid: string, startISO: string, endISO: string, cutoffISO: string) => {
        const prev = new Date(startISO+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
        const prevISO = prev.toISOString().slice(0,10);
        const { data: rows } = await supabaseAdmin
          .from('social_metrics_history')
          .select('platform, views, likes, comments, shares, saves, captured_at')
          .eq('user_id', uid)
          .gte('captured_at', prevISO+'T00:00:00Z')
          .lte('captured_at', endISO+'T23:59:59Z')
          .order('captured_at', { ascending: true });
        const lastTT = new Map<string, any>();
        const lastIG = new Map<string, any>();
        for (const r of rows||[]) {
          const d = String((r as any).captured_at).slice(0,10);
          const plat = String((r as any).platform||'');
          if (plat === 'tiktok') lastTT.set(d, r); else if (plat === 'instagram') lastIG.set(d, r);
        }
        const days: string[] = []; for (let d=new Date(startISO+'T00:00:00Z'); d<=new Date(endISO+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) days.push(d.toISOString().slice(0,10));
        let totals = { views:0, likes:0, comments:0, shares:0, saves:0 } as any;
        let prevTT:any = lastTT.get(prevISO) || null;
        for (const key of days) {
          const cur = lastTT.get(key);
          if (cur && prevTT && key >= cutoffISO) {
            totals.views += Math.max(0, Number((cur as any).views||0) - Number((prevTT as any).views||0));
            totals.likes += Math.max(0, Number((cur as any).likes||0) - Number((prevTT as any).likes||0));
            totals.comments += Math.max(0, Number((cur as any).comments||0) - Number((prevTT as any).comments||0));
            totals.shares += Math.max(0, Number((cur as any).shares||0) - Number((prevTT as any).shares||0));
            totals.saves += Math.max(0, Number((cur as any).saves||0) - Number((prevTT as any).saves||0));
          }
          if (cur) prevTT = cur;
        }
        let prevIG:any = lastIG.get(prevISO) || null;
        for (const key of days) {
          const cur = lastIG.get(key);
          if (cur && prevIG && key >= cutoffISO) {
            totals.views += Math.max(0, Number((cur as any).views||0) - Number((prevIG as any).views||0));
            totals.likes += Math.max(0, Number((cur as any).likes||0) - Number((prevIG as any).likes||0));
            totals.comments += Math.max(0, Number((cur as any).comments||0) - Number((prevIG as any).comments||0));
            totals.shares += Math.max(0, Number((cur as any).shares||0) - Number((prevIG as any).shares||0));
            totals.saves += Math.max(0, Number((cur as any).saves||0) - Number((prevIG as any).saves||0));
          }
          if (cur) prevIG = cur;
        }
        return totals;
      };
      
      const nameMap = new Map<string,string>();
      for (const u of empUsers||[]) nameMap.set(String((u as any).id), String((u as any).full_name || (u as any).username || (u as any).tiktok_username || (u as any).instagram_username || (u as any).id));

      // Hitung totals persis per user (snapshot accrual) dan saring yang nol
      const rows: any[] = [];
      for (const uid of empIds) {
        const acc = await accrualForUser(uid, startISO, endISO, cutoffISO);
        const total = acc.views + acc.likes + acc.comments + acc.shares + acc.saves;
        if (total <= 0) continue;
        rows.push({
          username: nameMap.get(uid) || uid,
          views: acc.views, likes: acc.likes, comments: acc.comments, shares: acc.shares, saves: acc.saves, posts: 0,
          total,
        });
      }
      const sorted = rows.sort((a,b)=> b.total - a.total);
      const limited = top ? sorted.slice(0, top) : sorted;
      const data = limited.map((x,i)=> ({ rank: i+1, ...x }));

      // Sertakan hadiah kampanye (pakai kampanye terbaru jika ada) agar UI podium menampilkan angka
      let prizes: { first_prize: number; second_prize: number; third_prize: number } | null = null;
      try {
        const { data: latest } = await supabaseAdmin
          .from('campaigns')
          .select('id')
          .order('start_date', { ascending: false })
          .limit(1);
        const campId = latest?.[0]?.id as string | undefined;
        if (campId) {
          const { data: p } = await supabaseAdmin
            .from('campaign_prizes')
            .select('first_prize, second_prize, third_prize')
            .eq('campaign_id', campId)
            .maybeSingle();
          if (p) prizes = {
            first_prize: Number((p as any).first_prize)||0,
            second_prize: Number((p as any).second_prize)||0,
            third_prize: Number((p as any).third_prize)||0,
          };
        }
      } catch {}

      return NextResponse.json({ top, start: startISO, end: endISO, prizes, data, scope:'employees', days: windowDays });
    }

    // If monthly + scope=employees → bypass campaign logic and aggregate across all employees
    if (scope === 'employees') {
      const supa = supabaseAdmin;
      // Determine window (monthly by default; support weekly)
      let startISO: string; let endISO: string; let periodType: 'monthly'|'weekly' = 'monthly';
      if (intervalParam === 'weekly') {
        periodType = 'weekly';
        if (startParam && endParam) {
          startISO = String(startParam);
          endISO = String(endParam);
        } else {
          const now = new Date();
          const day = now.getUTCDay();
          const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((day+6)%7)));
          const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate()+6);
          startISO = monday.toISOString().slice(0,10);
          endISO = sunday.toISOString().slice(0,10);
        }
      } else {
        if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
          const [y,m] = monthStr.split('-').map(Number);
          const start = new Date(Date.UTC(y, m-1, 1));
          const end = new Date(Date.UTC(y, m, 0));
          startISO = start.toISOString().slice(0,10);
          endISO = end.toISOString().slice(0,10);
        } else {
          const now = new Date();
          const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
          const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 0));
          startISO = start.toISOString().slice(0,10);
          endISO = end.toISOString().slice(0,10);
        }
      }

      // Build employee → handles map (TikTok + Instagram)
      const { data: empUsers } = await supa
        .from('users')
        .select('id, full_name, username, tiktok_username, instagram_username')
        .eq('role','karyawan');
      const empIds = (empUsers||[]).map((u:any)=>u.id);

      const handlesTT = new Map<string, string[]>(); // user_id -> tt handles
      const handlesIG = new Map<string, string[]>(); // user_id -> ig handles
      for (const u of empUsers||[]) {
        const baseT = (u as any).tiktok_username ? [String((u as any).tiktok_username).replace(/^@/,'').toLowerCase()] : [];
        const baseI = (u as any).instagram_username ? [String((u as any).instagram_username).replace(/^@/,'').toLowerCase()] : [];
        handlesTT.set(String((u as any).id), baseT);
        handlesIG.set(String((u as any).id), baseI);
      }
      if (empIds.length) {
        const { data: exT } = await supa
          .from('user_tiktok_usernames')
          .select('user_id, tiktok_username')
          .in('user_id', empIds);
        for (const r of exT||[]) {
          const id = String((r as any).user_id);
          const u = String((r as any).tiktok_username||'').replace(/^@/,'').toLowerCase();
          if (!u) continue;
          const arr = handlesTT.get(id) || [];
          if (!arr.includes(u)) arr.push(u);
          handlesTT.set(id, arr);
        }
        const { data: exI } = await supa
          .from('user_instagram_usernames')
          .select('user_id, instagram_username')
          .in('user_id', empIds);
        for (const r of exI||[]) {
          const id = String((r as any).user_id);
          const u = String((r as any).instagram_username||'').replace(/^@/,'').toLowerCase();
          if (!u) continue;
          const arr = handlesIG.get(id) || [];
          if (!arr.includes(u)) arr.push(u);
          handlesIG.set(id, arr);
        }
      }

      // Union handles for querying
      const allTT = Array.from(new Set(Array.from(handlesTT.values()).flat())).filter(Boolean);
      const allIG = Array.from(new Set(Array.from(handlesIG.values()).flat())).filter(Boolean);

      // Query monthly aggregates per handle from DB
      const aggTT = new Map<string, { views:number; likes:number; comments:number; shares:number; saves:number; posts:number }>();
      if (allTT.length) {
        const { data: rowsTT } = await supa
          .from('tiktok_posts_daily')
          .select('username, play_count, digg_count, comment_count, share_count, save_count')
          .in('username', allTT)
          .gte('post_date', startISO)
          .lte('post_date', endISO);
        for (const r of rowsTT || []) {
          const u = String((r as any).username).toLowerCase();
          const cur = aggTT.get(u) || { views:0, likes:0, comments:0, shares:0, saves:0, posts:0 };
          cur.views += Number((r as any).play_count)||0;
          cur.likes += Number((r as any).digg_count)||0;
          cur.comments += Number((r as any).comment_count)||0;
          cur.shares += Number((r as any).share_count)||0;
          cur.saves += Number((r as any).save_count)||0;
          cur.posts += 1;
          aggTT.set(u, cur);
        }
      }
      const aggIG = new Map<string, { views:number; likes:number; comments:number; posts:number }>();
      if (allIG.length) {
        const { data: rowsIG } = await supa
          .from('instagram_posts_daily')
          .select('username, play_count, like_count, comment_count')
          .in('username', allIG)
          .gte('post_date', startISO)
          .lte('post_date', endISO);
        for (const r of rowsIG || []) {
          const u = String((r as any).username).toLowerCase();
          const cur = aggIG.get(u) || { views:0, likes:0, comments:0, posts:0 };
          cur.views += Number((r as any).play_count)||0;
          cur.likes += Number((r as any).like_count)||0;
          cur.comments += Number((r as any).comment_count)||0;
          cur.posts += 1;
          aggIG.set(u, cur);
        }
      }

      // Reduce per employee
      const result: Array<{ username:string; views:number; likes:number; comments:number; shares:number; saves:number; posts:number; total:number }>= [];
      for (const u of empUsers || []) {
        const id = String((u as any).id);
        const label = String((u as any).full_name || (u as any).username || (u as any).tiktok_username || (u as any).instagram_username || id);
        const ttHandles = handlesTT.get(id) || [];
        const igHandles = handlesIG.get(id) || [];
        let v=0,l=0,c=0,s=0,sv=0,p=0;
        for (const h of ttHandles) {
          const a = aggTT.get(h); if (!a) continue;
          v += a.views; l += a.likes; c += a.comments; s += a.shares; sv += a.saves; p += a.posts;
        }
        for (const h of igHandles) {
          const a = aggIG.get(h); if (!a) continue;
          v += a.views; l += a.likes; c += a.comments; p += a.posts;
        }
        const total = v + l + c + s + sv;
        if (total > 0) {
          result.push({ username: label, views: v, likes: l, comments: c, shares: s, saves: sv, posts: p, total });
        }
      }

      // Fetch prizes from any campaign overlapping month (latest by start_date)
      let prizes: { first_prize: number; second_prize: number; third_prize: number } | null = null;
      // Fetch campaign name for client display
      let campaignName: string | null = null;
      try {
        const { data: c } = await supabaseAdmin
          .from('campaigns')
          .select('name')
          .eq('id', campaignId)
          .maybeSingle();
        campaignName = (c as any)?.name || null;
      } catch {}
      try {
        const { data: camps } = await supa
          .from('campaigns')
          .select('id, start_date, end_date')
          .lte('start_date', endISO)
          .or('end_date.is.null,end_date.gte.' + startISO)
          .order('start_date', { ascending: false })
          .limit(1);
        let campId = camps?.[0]?.id as string | undefined;
        if (campId) {
          const { data: prizeRow } = await supa
            .from('campaign_prizes')
            .select('first_prize, second_prize, third_prize')
            .eq('campaign_id', campId)
            .maybeSingle();
          if (prizeRow) {
            prizes = {
              first_prize: Number((prizeRow as any).first_prize)||0,
              second_prize: Number((prizeRow as any).second_prize)||0,
              third_prize: Number((prizeRow as any).third_prize)||0,
            };
          }
        } else {
          // Fallback: use the most recent campaign (by start_date desc) even if it doesn't overlap the month
          const { data: latestCamp } = await supa
            .from('campaigns')
            .select('id')
            .order('start_date', { ascending: false })
            .limit(1);
          campId = latestCamp?.[0]?.id as string | undefined;
          if (campId) {
            const { data: prizeRow } = await supa
              .from('campaign_prizes')
              .select('first_prize, second_prize, third_prize')
              .eq('campaign_id', campId)
              .maybeSingle();
            if (prizeRow) {
              prizes = {
                first_prize: Number((prizeRow as any).first_prize)||0,
                second_prize: Number((prizeRow as any).second_prize)||0,
                third_prize: Number((prizeRow as any).third_prize)||0,
              };
            }
          }
        }
      } catch {}

      const sorted = result.sort((a,b)=> b.total-a.total);
      const limited = top ? sorted.slice(0, top) : sorted;
      const data = limited.map((x,i)=> ({ rank: i+1, ...x }));
      return NextResponse.json({ top, start: startISO, end: endISO, prizes, data, scope:'employees', period: periodType });
    }

    // Determine campaign_id: query ?campaign=..., else active campaign
    let campaignId: string | null = url.searchParams.get('campaign');
    let campaignStart: string | null = null;
    let campaignEnd: string | null = null;
    if (!campaignId) {
      const today = new Date().toISOString().slice(0,10);
      const { data: activeCampaigns } = await supabaseAdmin
        .from('campaigns')
        .select('id, start_date, end_date')
        .lte('start_date', today)
        .or('end_date.is.null,end_date.gte.' + today)
        .order('start_date', { ascending: false })
        .limit(1);
      if (activeCampaigns && activeCampaigns.length > 0) {
        campaignId = activeCampaigns[0].id as any;
        campaignStart = activeCampaigns[0].start_date as any;
        campaignEnd = (activeCampaigns[0].end_date as any) ?? null;
      }
    }

    if (!campaignId) return NextResponse.json({ error: 'No active campaign found' }, { status: 400 });

    // If campaign start/end still empty (because campaignId supplied by query), fetch window
    if (!campaignStart) {
      const { data: c } = await supabaseAdmin
        .from('campaigns')
        .select('start_date, end_date')
        .eq('id', campaignId)
        .single();
      if (c) { campaignStart = c.start_date as any; campaignEnd = (c.end_date as any) ?? null; }
    }

    // Live mode: aggregate directly from external endpoint for each participant
    if (mode === 'live') {
      // Get participants
      const { data: parts, error: pErr } = await supabaseAdmin
        .from('campaign_participants')
        .select('tiktok_username')
        .eq('campaign_id', campaignId);
      if (pErr) throw pErr;
      const usernames = (parts || []).map((p: any) => String(p.tiktok_username).replace(/^@/, '').toLowerCase());

      // Helper: safe number
      const toNum = (v: any) => Number(v || 0) || 0;
      // Fetch one page per user (count up to 1000) and filter by campaign window
      const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
      const perPage = clamp(Number(url.searchParams.get('count') || '1000'), 50, 1000);
      const concurrency = clamp(Number(url.searchParams.get('concurrency') || '4'), 1, 8);

      const runLimited = async <T,>(items: string[], fn: (u: string) => Promise<T>): Promise<T[]> => {
        const results: T[] = [];
        let i = 0;
        async function worker() {
          while (i < items.length) {
            const idx = i++;
            const u = items[idx];
            try { results[idx] = await fn(u); } catch { results[idx] = await Promise.resolve(undefined as any); }
          }
        }
        await Promise.all(new Array(concurrency).fill(0).map(()=>worker()));
        return results;
      };

      const startBound = campaignStart ? new Date(campaignStart + 'T00:00:00Z') : null;
      const endBound = campaignEnd ? new Date(campaignEnd + 'T23:59:59Z') : null;
      const parseTs = (ts: any): Date | null => {
        if (ts == null) return null;
        if (typeof ts === 'number') { const ms = ts > 1e12 ? ts : ts * 1000; const d = new Date(ms); return isNaN(d.getTime()) ? null : d; }
        if (typeof ts === 'string') { const n = Number(ts); if (!Number.isNaN(n) && n>0) { const ms=n>1e12?n:n*1000; const d=new Date(ms); return isNaN(d.getTime())?null:d; } const d=new Date(ts); return isNaN(d.getTime())?null:d; }
        return null;
      };

      const callUser = async (username: string) => {
        const u = new URL('http://202.10.44.90/api/v1/user/posts');
        u.searchParams.set('username', username);
        u.searchParams.set('count', String(perPage));
        if (campaignStart) u.searchParams.set('start', campaignStart);
        if (campaignEnd) u.searchParams.set('end', campaignEnd);
        let json: any = null;
        for (let attempt=0; attempt<2; attempt++) {
          try {
            const r = await fetch(u.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
            if (r.ok) { json = await r.json().catch(()=>null); break; }
          } catch {}
          await new Promise(res=>setTimeout(res, 200*(attempt+1)));
        }
        const list: any[] = Array.isArray(json?.data?.videos) ? json.data.videos : [];
        let v=0,l=0,c=0,s=0,sv=0,posts=0;
        for (const it of list) {
          const d = parseTs(it.create_time ?? it.createTime ?? it.create_time_utc ?? it.create_date);
          if (!d) continue;
          if (startBound && d < startBound) continue;
          if (endBound && d > endBound) continue;
          v += toNum(it.play_count || it.views);
          l += toNum(it.digg_count || it.like_count || it.likes);
          c += toNum(it.comment_count || it.comments);
          s += toNum(it.share_count || it.shares);
          sv += toNum(it.collect_count || it.save_count || it.favorites);
          posts += 1;
        }
        return { username, views: v, likes: l, comments: c, shares: s, saves: sv, posts, total: v+l+c+s+sv };
      };

      const live = await runLimited(usernames, callUser);
      const sortedLive = (live || [])
        .filter(Boolean)
        .sort((a,b) => (b.total||0) - (a.total||0));
      const limitedLive = top ? sortedLive.slice(0, top) : sortedLive;
      const data = limitedLive.map((x:any, i:number) => ({ rank: i+1, ...x }));

      let prizes: { first_prize: number; second_prize: number; third_prize: number } | null = null;
      const { data: prizeRow } = await supabaseAdmin
        .from('campaign_prizes')
        .select('first_prize, second_prize, third_prize')
        .eq('campaign_id', campaignId)
        .maybeSingle();
      if (prizeRow) prizes = { first_prize: Number(prizeRow.first_prize)||0, second_prize: Number(prizeRow.second_prize)||0, third_prize: Number(prizeRow.third_prize)||0 };

      return NextResponse.json({ top, campaignId, campaignName, start: campaignStart, end: campaignEnd, prizes, data, source: 'live' });
    }

    // Accrual mode (default): compute from social_metrics_history deltas within a recent window
    if (mode === 'accrual') {
      // Window: PRESET ONLY (7 atau 28 hari). Abaikan start/end custom.
      const daysParam = Number(url.searchParams.get('days') || '7');
      const windowDays = ([7,28] as number[]).includes(daysParam) ? daysParam : 7;
      const endISO = new Date().toISOString().slice(0,10);
      const startISO = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(windowDays-1)); return d.toISOString().slice(0,10) })();

      // Fetch campaign required_hashtags for filtering
      const { data: campaign } = await supabaseAdmin
        .from('campaigns')
        .select('id, name, required_hashtags')
        .eq('id', campaignId)
        .single();
      const requiredHashtags = campaign?.required_hashtags || null;

      // Ambil daftar karyawan resmi group ini
      const { data: egs } = await supabaseAdmin
        .from('employee_groups')
        .select('employee_id')
        .eq('campaign_id', campaignId);
      const empIds: string[] = (egs||[]).map((r:any)=> String(r.employee_id));
      if (!empIds.length) return NextResponse.json({ top, campaignId, campaignName: campaign?.name||null, start: startISO, end: endISO, prizes: null, data: [], required_hashtags: requiredHashtags, filtered_by_hashtag: requiredHashtags && requiredHashtags.length > 0 });

      // Build user -> handles mapping for hashtag filtering
      const { data: usersMeta } = await supabaseAdmin
        .from('users')
        .select('id, tiktok_username, instagram_username')
        .in('id', empIds);
      const userToTikTok = new Map<string, string>();
      const userToInstagram = new Map<string, string>();
      for (const u of usersMeta || []) {
        const uid = String((u as any).id);
        if ((u as any).tiktok_username) userToTikTok.set(uid, String((u as any).tiktok_username).replace(/^@/, '').toLowerCase());
        if ((u as any).instagram_username) userToInstagram.set(uid, String((u as any).instagram_username).replace(/^@/, '').toLowerCase());
      }
      // Also check additional usernames
      const { data: ttExtra } = await supabaseAdmin
        .from('user_tiktok_usernames')
        .select('user_id, tiktok_username')
        .in('user_id', empIds);
      for (const r of ttExtra || []) {
        const uid = String((r as any).user_id);
        if (!userToTikTok.has(uid)) userToTikTok.set(uid, String((r as any).tiktok_username).replace(/^@/, '').toLowerCase());
      }
      const { data: igExtra } = await supabaseAdmin
        .from('user_instagram_usernames')
        .select('user_id, instagram_username')
        .in('user_id', empIds);
      for (const r of igExtra || []) {
        const uid = String((r as any).user_id);
        if (!userToInstagram.has(uid)) userToInstagram.set(uid, String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
      }

      // Query history untuk semua karyawan + platform, sertakan baseline sehari sebelum start
      const prev = new Date(startISO+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
      const prevISO = prev.toISOString().slice(0,10);
      const { data: hist } = await supabaseAdmin
        .from('social_metrics_history')
        .select('user_id, platform, views, likes, comments, shares, saves, captured_at')
        .in('user_id', empIds)
        .gte('captured_at', prevISO+'T00:00:00Z')
        .lte('captured_at', endISO+'T23:59:59Z')
        .order('user_id', { ascending: true })
        .order('platform', { ascending: true })
        .order('captured_at', { ascending: true });

      // If hashtag filtering enabled, fetch posts with titles/captions to filter
      let validPostsByUser: Map<string, Set<string>> | null = null;
      if (requiredHashtags && requiredHashtags.length > 0) {
        validPostsByUser = new Map<string, Set<string>>();
        // Fetch TikTok posts with titles
        const ttHandles = Array.from(userToTikTok.values()).filter(Boolean);
        if (ttHandles.length > 0) {
          const { data: ttPosts } = await supabaseAdmin
            .from('tiktok_posts_daily')
            .select('username, video_id, title, post_date')
            .in('username', ttHandles)
            .gte('post_date', startISO)
            .lte('post_date', endISO);
          for (const post of ttPosts || []) {
            const title = String((post as any).title || '');
            if (hasRequiredHashtag(title, requiredHashtags)) {
              const username = String((post as any).username).toLowerCase();
              // Find user_id for this username
              for (const [uid, handle] of userToTikTok.entries()) {
                if (handle === username) {
                  const key = `${uid}::tiktok::${(post as any).post_date}`;
                  const set = validPostsByUser.get(uid) || new Set<string>();
                  set.add(key);
                  validPostsByUser.set(uid, set);
                }
              }
            }
          }
        }
        // Fetch Instagram posts with captions
        const igHandles = Array.from(userToInstagram.values()).filter(Boolean);
        if (igHandles.length > 0) {
          const { data: igPosts } = await supabaseAdmin
            .from('instagram_posts_daily')
            .select('username, id, caption, post_date')
            .in('username', igHandles)
            .gte('post_date', startISO)
            .lte('post_date', endISO);
          for (const post of igPosts || []) {
            const caption = String((post as any).caption || '');
            if (hasRequiredHashtag(caption, requiredHashtags)) {
              const username = String((post as any).username).toLowerCase();
              // Find user_id for this username
              for (const [uid, handle] of userToInstagram.entries()) {
                if (handle === username) {
                  const key = `${uid}::instagram::${(post as any).post_date}`;
                  const set = validPostsByUser.get(uid) || new Set<string>();
                  set.add(key);
                  validPostsByUser.set(uid, set);
                }
              }
            }
          }
        }
      }

      // Group by (user_id, platform) lalu hitung delta harian
      const byUserPlat = new Map<string, any[]>();
      for (const r of hist||[]) {
        const uid = String((r as any).user_id); const plat = String((r as any).platform||'');
        const key = `${uid}::${plat}`; const arr = byUserPlat.get(key) || []; arr.push(r); byUserPlat.set(key, arr);
      }
      const totalsByUser = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
      for (const [key, arr] of byUserPlat.entries()) {
        const [uid, plat] = key.split('::');
        // If hashtag filtering active and user has no valid posts, skip entirely
        if (validPostsByUser && !validPostsByUser.has(uid)) continue;
        
        let prevRow:any = null;
        for (const r of arr) {
          if (!prevRow) {
            // Treat first snapshot within window as delta from zero
            const d0 = String((r as any).captured_at).slice(0,10);
            if (d0 >= startISO && d0 <= endISO) {
              const dv0 = Math.max(0, Number((r as any).views||0));
              const dl0 = Math.max(0, Number((r as any).likes||0));
              const dc0 = Math.max(0, Number((r as any).comments||0));
              const ds0 = Math.max(0, Number((r as any).shares||0));
              const dsv0 = Math.max(0, Number((r as any).saves||0));
              const cur0 = totalsByUser.get(uid) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              cur0.views += dv0; cur0.likes += dl0; cur0.comments += dc0; cur0.shares += ds0; cur0.saves += dsv0; totalsByUser.set(uid, cur0);
            }
            prevRow = r; continue;
          }
          const date = String((r as any).captured_at).slice(0,10);
          if (date >= startISO && date <= endISO) {
            const dv = Math.max(0, Number((r as any).views||0) - Number((prevRow as any).views||0));
            const dl = Math.max(0, Number((r as any).likes||0) - Number((prevRow as any).likes||0));
            const dc = Math.max(0, Number((r as any).comments||0) - Number((prevRow as any).comments||0));
            const ds = Math.max(0, Number((r as any).shares||0) - Number((prevRow as any).shares||0));
            const dsv = Math.max(0, Number((r as any).saves||0) - Number((prevRow as any).saves||0));
            const cur = totalsByUser.get(uid) || { views:0, likes:0, comments:0, shares:0, saves:0 };
            cur.views += dv; cur.likes += dl; cur.comments += dc; cur.shares += ds; cur.saves += dsv; totalsByUser.set(uid, cur);
          }
          prevRow = r;
        }
      }

      // Label karyawan (reuse usersMeta if already fetched, or fetch with full_name)
      const { data: usersMetaFull } = await supabaseAdmin
        .from('users')
        .select('id, full_name, username, tiktok_username, instagram_username')
        .in('id', empIds);
      const nameMap = new Map<string,string>();
      for (const u of usersMetaFull||[]) nameMap.set(String((u as any).id), String((u as any).full_name || (u as any).username || (u as any).tiktok_username || (u as any).instagram_username || (u as any).id));

      const dataAcc = Array.from(totalsByUser.entries()).map(([uid, v])=> ({
        username: nameMap.get(uid) || uid,
        views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves,
        posts: 0,
        total: v.views + v.likes + v.comments + v.shares + v.saves,
      }));
      const sortedAcc = dataAcc.sort((a,b)=> b.total - a.total);
      const limitedAcc = top ? sortedAcc.slice(0, top) : sortedAcc;

      // Prizes kampanye
      let prizes: { first_prize: number; second_prize: number; third_prize: number } | null = null;
      const { data: prizeRow } = await supabaseAdmin
        .from('campaign_prizes')
        .select('first_prize, second_prize, third_prize')
        .eq('campaign_id', campaignId)
        .maybeSingle();
      if (prizeRow) prizes = { first_prize: Number((prizeRow as any).first_prize)||0, second_prize: Number((prizeRow as any).second_prize)||0, third_prize: Number((prizeRow as any).third_prize)||0 };

      return NextResponse.json({ 
        top, 
        campaignId, 
        campaignName: campaign?.name || null,
        start: startISO, 
        end: endISO, 
        prizes, 
        data: limitedAcc, 
        mode:'accrual', 
        days: windowDays,
        required_hashtags: requiredHashtags,
        filtered_by_hashtag: requiredHashtags && requiredHashtags.length > 0
      });
    }

    // Prefer snapshot from campaign_participants unless mode forces DB aggregation
    const { data: rows, error } = await supabaseAdmin
      .from('campaign_participants')
      .select('tiktok_username, views, likes, comments, shares, saves, posts_total')
      .eq('campaign_id', campaignId)
      .limit(top ? top * 5 : 10000); // fetch more then sort in code
    if (error) throw error;

    let list = (rows || []).map(r => ({
      username: r.tiktok_username,
      views: Number(r.views) || 0,
      likes: Number(r.likes) || 0,
      comments: Number(r.comments) || 0,
      shares: Number(r.shares) || 0,
      saves: Number(r.saves) || 0,
      posts: Number(r.posts_total) || 0,
    })).map(x => ({ ...x, total: x.views + x.likes + x.comments + x.shares + x.saves }));

    // Merge Instagram snapshot from campaign_instagram_participants (treat as separate entries)
    try {
      const { data: igRows } = await supabaseAdmin
        .from('campaign_instagram_participants')
        .select('instagram_username, views, likes, comments, posts_total')
        .eq('campaign_id', campaignId);
      const igList = (igRows || []).map((r:any) => ({
        username: String(r.instagram_username),
        views: Number(r.views)||0,
        likes: Number(r.likes)||0,
        comments: Number(r.comments)||0,
        shares: 0,
        saves: 0,
        posts: Number(r.posts_total)||0,
      })).map(x => ({ ...x, total: x.views + x.likes + x.comments }));
      list = list.concat(igList);
    } catch {}

    // Prefer DB aggregation if forced or snapshot list looks empty/zero
    const allZero = list.length > 0 && list.every(x => (x.total || 0) === 0);
    if (forceDb || allZero) {
      try {
        const { data: parts } = await supabaseAdmin
          .from('campaign_participants')
          .select('tiktok_username')
          .eq('campaign_id', campaignId);
        const usernames = (parts || []).map((p: any) => String(p.tiktok_username).replace(/^@/, '').toLowerCase());
        if (usernames.length) {
          const { data: rows } = await supabaseAdmin
            .from('tiktok_posts_daily')
            .select('username, play_count, digg_count, comment_count, share_count, save_count, post_date')
            .in('username', usernames)
            .gte('post_date', String(campaignStart || '1970-01-01'))
            .lte('post_date', String(campaignEnd || new Date().toISOString().slice(0,10)));
          const agg = new Map<string, { views: number, likes: number, comments: number, shares: number, saves: number, posts: number }>();
          for (const r of rows || []) {
            const u = String(r.username).toLowerCase();
            const cur = agg.get(u) || { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 };
            cur.views += Number(r.play_count) || 0;
            cur.likes += Number(r.digg_count) || 0;
            cur.comments += Number(r.comment_count) || 0;
            cur.shares += Number(r.share_count) || 0;
            cur.saves += Number(r.save_count) || 0;
            cur.posts += 1;
            agg.set(u, cur);
          }
          list = usernames.map(u => {
            const v = agg.get(u) || { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 };
            const username = parts?.find((p: any) => String(p.tiktok_username).replace(/^@/, '').toLowerCase() === u)?.tiktok_username || u;
            const total = v.views + v.likes + v.comments + v.shares + v.saves;
            return { username, ...v, total } as any;
          });

          // Merge Instagram DB aggregation
          try {
            const { data: igParts } = await supabaseAdmin
              .from('campaign_instagram_participants')
              .select('instagram_username')
              .eq('campaign_id', campaignId);
            const igUsernames = (igParts || []).map((r:any)=> String(r.instagram_username).replace(/^@/, '').toLowerCase());
            if (igUsernames.length) {
              const { data: igRows } = await supabaseAdmin
                .from('instagram_posts_daily')
                .select('username, play_count, like_count, comment_count, post_date')
                .in('username', igUsernames)
                .gte('post_date', String(campaignStart || '1970-01-01'))
                .lte('post_date', String(campaignEnd || new Date().toISOString().slice(0,10)));
              const aggIG = new Map<string, { views:number, likes:number, comments:number, posts:number }>();
              for (const r of igRows || []) {
                const u = String((r as any).username).toLowerCase();
                const cur = aggIG.get(u) || { views:0, likes:0, comments:0, posts:0 };
                cur.views += Number((r as any).play_count)||0;
                cur.likes += Number((r as any).like_count)||0;
                cur.comments += Number((r as any).comment_count)||0;
                cur.posts += 1;
                aggIG.set(u, cur);
              }
              const igList = igUsernames.map(u => {
                const v = aggIG.get(u) || { views:0, likes:0, comments:0, posts:0 };
                const username = igParts?.find((p:any)=> String(p.instagram_username).replace(/^@/, '').toLowerCase() === u)?.instagram_username || u;
                const total = v.views + v.likes + v.comments;
                return { username, views: v.views, likes: v.likes, comments: v.comments, shares: 0, saves: 0, posts: v.posts, total } as any;
              });
              list = list.concat(igList);
            }
          } catch {}
        }
      } catch (e) {
        console.warn('[leaderboard] fallback aggregate failed:', (e as any)?.message || e);
      }
    }

    // Optionally merge TikTok + Instagram per employee
    const mergeParam = url.searchParams.get('merge');
    const mergeByEmployee = (mergeParam === '1') || (process.env.LEADERBOARD_MERGE_EMPLOYEE === '1');
    let dataList = list;
    if (mergeByEmployee) {
      try {
        // Build mapping from username to employee_id
        const { data: ep } = await supabaseAdmin
          .from('employee_participants')
          .select('employee_id, tiktok_username')
          .eq('campaign_id', campaignId);
        const { data: eip } = await supabaseAdmin
          .from('employee_instagram_participants')
          .select('employee_id, instagram_username')
          .eq('campaign_id', campaignId);
        const mapTik = new Map<string, string>();
        for (const r of ep || []) mapTik.set(String((r as any).tiktok_username).replace(/^@/, '').toLowerCase(), String((r as any).employee_id));
        const mapIG = new Map<string, string>();
        for (const r of eip || []) mapIG.set(String((r as any).instagram_username).replace(/^@/, '').toLowerCase(), String((r as any).employee_id));

        const groups = new Map<string, { usernames: string[]; views:number; likes:number; comments:number; shares:number; saves:number; posts:number }>();
        for (const it of list) {
          const u = String(it.username||'');
          const keyLower = u.replace(/^@/, '').toLowerCase();
          const empId = mapTik.get(keyLower) || mapIG.get(keyLower);
          const key = empId ? `emp:${empId}` : `user:${keyLower}`;
          const cur = groups.get(key) || { usernames: [], views:0, likes:0, comments:0, shares:0, saves:0, posts:0 };
          cur.usernames.push(u);
          cur.views += Number((it as any).views)||0;
          cur.likes += Number((it as any).likes)||0;
          cur.comments += Number((it as any).comments)||0;
          cur.shares += Number((it as any).shares)||0;
          cur.saves += Number((it as any).saves)||0;
          cur.posts += Number((it as any).posts)||0;
          groups.set(key, cur);
        }
        dataList = Array.from(groups.values()).map(g => {
          const total = g.views + g.likes + g.comments + g.shares + g.saves;
          const label = g.usernames[0] || '-';
          return { username: label, views: g.views, likes: g.likes, comments: g.comments, shares: g.shares, saves: g.saves, posts: g.posts, total } as any;
        });
      } catch {}
    }

    const sortedAll = dataList.sort((a,b) => b.total - a.total);
    const limitedAll = top ? sortedAll.slice(0, top) : sortedAll;
    const data = limitedAll.map((x, i) => ({ rank: i+1, ...x }));

    // Fetch prizes for the campaign
    let prizes: { first_prize: number; second_prize: number; third_prize: number } | null = null;
    const { data: prizeRow } = await supabaseAdmin
      .from('campaign_prizes')
      .select('first_prize, second_prize, third_prize')
      .eq('campaign_id', campaignId)
      .maybeSingle();
    if (prizeRow) {
      prizes = {
        first_prize: Number(prizeRow.first_prize) || 0,
        second_prize: Number(prizeRow.second_prize) || 0,
        third_prize: Number(prizeRow.third_prize) || 0,
      };
    }

    return NextResponse.json({ top, campaignId, start: campaignStart, end: campaignEnd, prizes, data });
  } catch (e: any) {
    console.error('[leaderboard] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
