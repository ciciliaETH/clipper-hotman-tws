import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';
import { hasRequiredHashtag } from '@/lib/hashtag-filter';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes - complex accrual calculations

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
    // Rolling preset window for accrual; ignore arbitrary start/end when days provided
    const daysQ = Number(url.searchParams.get('days') || '0');
    const windowDays = daysQ > 0 ? daysQ : 7;
    const cutoff = String(url.searchParams.get('cutoff') || process.env.ACCRUAL_CUTOFF_DATE || '2026-01-02');
    const customMode = url.searchParams.get('custom') === '1';
    
    // Calculate date range
    let startISO: string;
    let endISO: string;
    
    console.log('[DEBUG API] Received params:', { 
      daysQ, 
      windowDays, 
      cutoff, 
      customMode,
      hasCutoff: url.searchParams.has('cutoff'),
      defaultCutoff: process.env.ACCRUAL_CUTOFF_DATE || '2026-01-02'
    });
    
    if (customMode) {
      // Custom date mode: cutoff is the start date, calculate end date from days parameter
      startISO = cutoff;
      const endDate = new Date(cutoff + 'T00:00:00Z');
      endDate.setUTCDate(endDate.getUTCDate() + (windowDays - 1));
      endISO = endDate.toISOString().slice(0, 10);
      console.log('[DEBUG API] Custom date mode:', { startISO, endISO, windowDays });
    } else {
      // Preset mode: rolling window from today
      endISO = new Date().toISOString().slice(0,10);
      startISO = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(windowDays-1)); return d.toISOString().slice(0,10) })();
      console.log('[DEBUG API] Preset mode:', { startISO, endISO, windowDays });
    }
    
    const respectHashtags = url.searchParams.get('respect_hashtags') === '1';
    // snapshots_only: default ON (strict accrual from social_metrics_history only)
    const snapshotsOnly = url.searchParams.get('snapshots_only') !== '0';
    const maskParam = String(url.searchParams.get('mask') || '1');
    const trimParam = url.searchParams.get('trim') === '1';

    // Fetch campaign required_hashtags for filtering
    const { data: campaign } = await admin
      .from('campaigns')
      .select('id, name, required_hashtags')
      .eq('id', id)
      .single();
    const requiredHashtags = campaign?.required_hashtags || null;

    // Get campaign handles and the official list of employees in this campaign
    const { data: ttParts } = await admin.from('campaign_participants').select('tiktok_username').eq('campaign_id', id);
    const ttHandles = Array.from(new Set((ttParts||[]).map((r:any)=> String(r.tiktok_username).replace(/^@/,'').toLowerCase())));
    const { data: igParts } = await admin.from('campaign_instagram_participants').select('instagram_username').eq('campaign_id', id);
    const igHandlesBase = Array.from(new Set((igParts||[]).map((r:any)=> String(r.instagram_username).replace(/^@/,'').toLowerCase())));
    // Restrict accrual computation to employees that are in employee_groups for this campaign
    const { data: egEmployees } = await admin.from('employee_groups').select('employee_id').eq('campaign_id', id);
    const allowedEmpIds = new Set<string>((egEmployees||[]).map((r:any)=> String(r.employee_id)));

    // Map handles -> user ids
    const userIdsTT = new Set<string>();
    const userIdsIG = new Set<string>();
    if (ttHandles.length) {
      const { data: u1 } = await admin.from('users').select('id, tiktok_username').in('tiktok_username', ttHandles);
      for (const r of u1||[]) { const uid=String((r as any).id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsTT.add(uid); }
      const { data: map } = await admin.from('user_tiktok_usernames').select('user_id, tiktok_username').in('tiktok_username', ttHandles);
      for (const r of map||[]) { const uid=String((r as any).user_id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsTT.add(uid); }
    }
    if (igHandlesBase.length) {
      const { data: u1 } = await admin.from('users').select('id, instagram_username').in('instagram_username', igHandlesBase);
      for (const r of u1||[]) { const uid=String((r as any).id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsIG.add(uid); }
      const { data: map } = await admin.from('user_instagram_usernames').select('user_id, instagram_username').in('instagram_username', igHandlesBase);
      for (const r of map||[]) { const uid=String((r as any).user_id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsIG.add(uid); }
    }
    // Derive more IG owners and handles from employees in this campaign even if IG participants table is empty
    const igHandlesExtra = new Set<string>();
    if (allowedEmpIds.size > 0) {
      try {
        const { data: uMap } = await admin
          .from('user_instagram_usernames')
          .select('user_id, instagram_username')
          .in('user_id', Array.from(allowedEmpIds));
        for (const r of uMap||[]) {
          const uid = String((r as any).user_id);
          const h = String((r as any).instagram_username||'').replace(/^@/,'').toLowerCase();
          if (h) { userIdsIG.add(uid); igHandlesExtra.add(h); }
        }
      } catch {}
      try {
        const { data: uMain } = await admin
          .from('users')
          .select('id, instagram_username')
          .in('id', Array.from(allowedEmpIds));
        for (const r of uMain||[]) {
          const uid = String((r as any).id);
          const h = String((r as any).instagram_username||'').replace(/^@/,'').toLowerCase();
          if (h) { userIdsIG.add(uid); igHandlesExtra.add(h); }
        }
      } catch {}
    }
    const igHandles = Array.from(new Set([ ...igHandlesBase, ...Array.from(igHandlesExtra) ]));
    // Fallback: if IG participants are not explicitly listed, derive IG owners from TT owners
    if (userIdsTT.size) {
      const ttOwnerIds = Array.from(userIdsTT);
      for (const uid of ttOwnerIds) { if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsIG.add(uid); }
    }

    // Helper to aggregate deltas per day from social_metrics_history with optional hashtag filtering
    const buildAccrual = async (ids: string[], platform: 'tiktok'|'instagram', userIdToHandle: Map<string, string>) => {
      if (!ids.length) return new Map<string, {views:number;likes:number;comments:number;shares:number;saves:number}>();
      
      // If hashtag filtering enabled, identify which user_ids have valid posts
      let validUserIds: Set<string> | null = null;
      if (respectHashtags && requiredHashtags && requiredHashtags.length > 0) {
        validUserIds = new Set<string>();
        const handles = Array.from(userIdToHandle.values()).filter(Boolean);
        if (handles.length > 0) {
          if (platform === 'tiktok') {
            const { data: posts } = await admin
              .from('tiktok_posts_daily')
              .select('username, video_id, title, post_date')
              .in('username', handles)
              .gte('post_date', startISO)
              .lte('post_date', endISO);
            for (const post of posts || []) {
              const title = String((post as any).title || '');
              if (hasRequiredHashtag(title, requiredHashtags)) {
                const username = String((post as any).username).toLowerCase();
                // Find user_id for this username
                for (const [uid, handle] of userIdToHandle.entries()) {
                  if (handle === username) validUserIds.add(uid);
                }
              }
            }
          } else if (platform === 'instagram') {
            const { data: posts } = await admin
              .from('instagram_posts_daily')
              .select('username, id, caption, post_date')
              .in('username', handles)
              .gte('post_date', startISO)
              .lte('post_date', endISO);
            for (const post of posts || []) {
              const caption = String((post as any).caption || '');
              if (hasRequiredHashtag(caption, requiredHashtags)) {
                const username = String((post as any).username).toLowerCase();
                // Find user_id for this username
                for (const [uid, handle] of userIdToHandle.entries()) {
                  if (handle === username) validUserIds.add(uid);
                }
              }
            }
          }
        }
      }
      
      // Baseline lookback: cari snapshot terakhir SEBELUM start (tidak harus tepat H-1)
      const baselineLookbackDays = 30;
      const baselineFrom = new Date(startISO+'T00:00:00Z'); baselineFrom.setUTCDate(baselineFrom.getUTCDate()-baselineLookbackDays);
      const prev = new Date(startISO+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
      const prevISO = prev.toISOString().slice(0,10);
      const { data: rows } = await admin
        .from('social_metrics_history')
        .select('user_id, platform, views, likes, comments, shares, saves, captured_at')
        .in('user_id', ids)
        .eq('platform', platform)
        .gte('captured_at', baselineFrom.toISOString().slice(0,10) + 'T00:00:00Z')
        .lte('captured_at', endISO + 'T23:59:59Z')
        .order('user_id', { ascending: true })
        .order('captured_at', { ascending: true });
      const byUser = new Map<string, any[]>();
      for (const r of rows||[]) {
        const uid = String((r as any).user_id);
        // If hashtag filtering active and user has no valid posts, skip
        if (validUserIds && !validUserIds.has(uid)) continue;
        const arr = byUser.get(uid) || []; arr.push(r); byUser.set(uid, arr);
      }
      const out = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
      const add = (date:string, v:{views:number;likes:number;comments:number;shares:number;saves:number})=>{
        const cur = out.get(date) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views += v.views; cur.likes += v.likes; cur.comments += v.comments; cur.shares += v.shares; cur.saves += v.saves; out.set(date, cur);
      };
      // Robust daily accrual: for each user, use LAST snapshot per day and compute
      // delta = max(0, last(day) - last(prev_day)), preventing over-count from jitter.
      const days: string[] = [];
      for (let d = new Date(startISO+'T00:00:00Z'); d <= new Date(endISO+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
        days.push(new Date(d).toISOString().slice(0,10));
      }
      for (const [uid, arr] of byUser.entries()) {
        // Build last snapshot per day map (including baseline day prevISO)
        const lastByDay = new Map<string, any>();
        for (const r of arr) {
          const d = String((r as any).captured_at).slice(0,10);
          lastByDay.set(d, r); // rows are ordered; last set wins
        }
        // Determine baseline = snapshot terakhir SEBELUM start (scan mundur hingga baselineLookbackDays)
        let prevSnap:any = null;
        {
          const base = new Date(startISO+'T00:00:00Z');
          for (let i=1;i<=baselineLookbackDays;i++) {
            const d = new Date(base); d.setUTCDate(d.getUTCDate()-i);
            const key = d.toISOString().slice(0,10);
            const cand = lastByDay.get(key);
            if (cand) { prevSnap = cand; break; }
          }
        }
        for (const d of days) {
          const cur = lastByDay.get(d);
          if (cur && prevSnap) {
            const dv = Math.max(0, Number((cur as any).views||0) - Number((prevSnap as any).views||0));
            const dl = Math.max(0, Number((cur as any).likes||0) - Number((prevSnap as any).likes||0));
            const dc = Math.max(0, Number((cur as any).comments||0) - Number((prevSnap as any).comments||0));
            const ds = Math.max(0, Number((cur as any).shares||0) - Number((prevSnap as any).shares||0));
            const dsv = Math.max(0, Number((cur as any).saves||0) - Number((prevSnap as any).saves||0));
            add(d, { views: dv, likes: dl, comments: dc, shares: ds, saves: dsv });
          }
          if (cur) prevSnap = cur;
        }
      }
      return out;
    };

    // Build user_id -> handle mappings for hashtag filtering
    const userIdToTikTok = new Map<string, string>();
    const userIdToInstagram = new Map<string, string>();
    if (userIdsTT.size > 0) {
      const { data: ttUsers } = await admin.from('users').select('id, tiktok_username').in('id', Array.from(userIdsTT));
      for (const u of ttUsers || []) {
        if ((u as any).tiktok_username) userIdToTikTok.set(String((u as any).id), String((u as any).tiktok_username).replace(/^@/, '').toLowerCase());
      }
      const { data: ttMap } = await admin.from('user_tiktok_usernames').select('user_id, tiktok_username').in('user_id', Array.from(userIdsTT));
      for (const r of ttMap || []) {
        const uid = String((r as any).user_id);
        if (!userIdToTikTok.has(uid)) userIdToTikTok.set(uid, String((r as any).tiktok_username).replace(/^@/, '').toLowerCase());
      }
    }
    if (userIdsIG.size > 0) {
      const { data: igUsers } = await admin.from('users').select('id, instagram_username').in('id', Array.from(userIdsIG));
      for (const u of igUsers || []) {
        if ((u as any).instagram_username) userIdToInstagram.set(String((u as any).id), String((u as any).instagram_username).replace(/^@/, '').toLowerCase());
      }
      const { data: igMap } = await admin.from('user_instagram_usernames').select('user_id, instagram_username').in('user_id', Array.from(userIdsIG));
      for (const r of igMap || []) {
        const uid = String((r as any).user_id);
        if (!userIdToInstagram.has(uid)) userIdToInstagram.set(uid, String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
      }
    }

    // When snapshotsOnly=true, force IDs to the official employees in this campaign
    if (snapshotsOnly) {
      // override both platform ID sets to include all allowed employees; hashtag filtering skipped
      userIdsTT.clear(); userIdsIG.clear();
      for (const uid of Array.from(allowedEmpIds)) { userIdsTT.add(uid); userIdsIG.add(uid); }
    }

    let ttMap = await buildAccrual(Array.from(userIdsTT), 'tiktok', userIdToTikTok);
    const sumMap = (m:Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>)=>{
      let v=0,l=0,c=0,s=0,sv=0; for (const x of m.values()) { v+=x.views; l+=x.likes; c+=x.comments; s+=x.shares; sv+=x.saves; }
      return { views:v, likes:l, comments:c, shares:s, saves:sv };
    };
    const debugFlag = url.searchParams.get('debug') === '1';
    const debug:any = debugFlag ? { inputs: { tt_handles: ttHandles, ig_handles: igHandlesBase }, sources: {} } : null;
    if (debugFlag) debug.sources.tt_history_before = sumMap(ttMap);
    // Optional fallback/augmentation from posts_daily (disabled when snapshotsOnly= true)
    if (!snapshotsOnly) {
      const ttAllHandles = Array.from(new Set([
        ...ttHandles,
        ...Array.from(userIdToTikTok.values()).filter(Boolean)
      ]));
      if (ttAllHandles.length > 0) {
      const { data: rowsTT } = await admin
        .from('tiktok_posts_daily')
        .select('username, post_date, play_count, digg_count, comment_count, share_count, save_count, title')
        .in('username', ttAllHandles)
        .gte('post_date', startISO)
        .lte('post_date', endISO);
        const tmp = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
        for (const r of rowsTT || []) {
          if (respectHashtags && requiredHashtags && requiredHashtags.length) {
            const title = String((r as any).title || '');
            if (!hasRequiredHashtag(title, requiredHashtags)) continue;
          }
          const d = String((r as any).post_date);
          const cur = tmp.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
          cur.views += Number((r as any).play_count)||0;
          cur.likes += Number((r as any).digg_count)||0;
          cur.comments += Number((r as any).comment_count)||0;
          cur.shares += Number((r as any).share_count)||0;
          cur.saves += Number((r as any).save_count)||0;
          tmp.set(d, cur);
        }
        // merge only for dates missing in history map (or zero values)
        for (const [d, v] of tmp.entries()) {
          const existed = ttMap.get(d);
          if (!existed || (existed.views+existed.likes+existed.comments+existed.shares+existed.saves) === 0) {
            ttMap.set(d, v);
          }
        }
        if (debugFlag) { debug.sources.tt_posts_daily = sumMap(tmp); debug.sources.tt_after_merge = sumMap(ttMap); }
      }
    }
    let igMap = await buildAccrual(Array.from(userIdsIG), 'instagram', userIdToInstagram);
    if (debugFlag) debug.sources.ig_history_before = sumMap(igMap);
    if (!snapshotsOnly) {
      const igAllHandles = Array.from(new Set([
        ...igHandles,
        ...Array.from(userIdToInstagram.values()).filter(Boolean)
      ]));
      if (igAllHandles.length > 0) {
      const { data: rowsIG } = await admin
        .from('instagram_posts_daily')
        .select('username, post_date, play_count, like_count, comment_count, caption')
        .in('username', igAllHandles)
        .gte('post_date', startISO)
        .lte('post_date', endISO);
        const tmp = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
        for (const r of rowsIG || []) {
          if (respectHashtags && requiredHashtags && requiredHashtags.length) {
            const cap = String((r as any).caption || '');
            if (!hasRequiredHashtag(cap, requiredHashtags)) continue;
          }
          const d = String((r as any).post_date);
          const cur = tmp.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
          cur.views += Number((r as any).play_count)||0;
          cur.likes += Number((r as any).like_count)||0;
          cur.comments += Number((r as any).comment_count)||0;
          tmp.set(d, cur);
        }
        for (const [d, v] of tmp.entries()) {
          const existed = igMap.get(d);
          if (!existed || (existed.views+existed.likes+existed.comments+existed.shares+existed.saves) === 0) {
            igMap.set(d, v);
          }
        }
        if (debugFlag) { debug.sources.ig_posts_daily = sumMap(tmp); debug.sources.ig_after_merge = sumMap(igMap); debug.inputs.ig_query_handles = igAllHandles; }
      }
    }

    // Build zero-filled series
    const ds = new Date(startISO+'T00:00:00Z');
    const de = new Date(endISO+'T00:00:00Z');
    const seriesTikTok: any[] = []; const seriesInstagram: any[] = [];
    for (let d = new Date(ds); d <= de; d.setUTCDate(d.getUTCDate()+1)) {
      const key = d.toISOString().slice(0,10);
      const tv = ttMap.get(key) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      const iv = igMap.get(key) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      seriesTikTok.push({ date: key, ...tv });
      seriesInstagram.push({ date: key, ...iv });
    }
    const merge = new Map<string,{date:string;views:number;likes:number;comments:number;shares:number;saves:number}>();
    const push = (arr:any[])=>{ for (const s of arr) { const cur = merge.get(s.date) || { date:s.date, views:0, likes:0, comments:0, shares:0, saves:0 }; cur.views+=s.views; cur.likes+=s.likes; cur.comments+=s.comments; cur.shares+=s.shares; cur.saves+=s.saves; merge.set(s.date, cur); } };
    push(seriesTikTok); push(seriesInstagram);
    let seriesTotal = Array.from(merge.values()).sort((a,b)=> a.date.localeCompare(b.date));

    // Apply masking optionally (default on). When mask=0, return full values.
    // Now requested: cutoff applies to ALL platforms.
    if (maskParam !== '0') {
      const mask = (arr:any[]) => arr.map((s:any)=> (s.date <= cutoff ? { ...s, views:0, likes:0, comments:0, shares:0, saves:0 } : s));
      seriesTikTok.splice(0, seriesTikTok.length, ...mask(seriesTikTok));
      seriesInstagram.splice(0, seriesInstagram.length, ...mask(seriesInstagram));
      seriesTotal = mask(seriesTotal);
    }

    // Optional: trim dates older than cutoff entirely so x-axis starts at cutoff
    if (trimParam) {
      const keep = (s:any)=> String(s.date) >= cutoff;
      const fTT = seriesTikTok.filter(keep);
      const fIG = seriesInstagram.filter(keep);
      const fTO = seriesTotal.filter(keep);
      seriesTikTok.splice(0, seriesTikTok.length, ...fTT);
      seriesInstagram.splice(0, seriesInstagram.length, ...fIG);
      seriesTotal.splice(0, seriesTotal.length, ...fTO);
    }

    // Recompute totals AFTER masking so header numbers match the chart
    const totals = seriesTotal.reduce((a:any, s:any)=> ({ views:a.views+s.views, likes:a.likes+s.likes, comments:a.comments+s.comments, shares:a.shares+s.shares, saves:a.saves+s.saves }), { views:0, likes:0, comments:0, shares:0, saves:0 });

    return NextResponse.json({ 
      start: startISO,
      start_requested: startISO,
      cutoff_applied: cutoff,
      end: endISO, 
      series_total: seriesTotal, 
      series_tiktok: seriesTikTok, 
      series_instagram: seriesInstagram, 
      totals,
      required_hashtags: requiredHashtags,
      filtered_by_hashtag: requiredHashtags && requiredHashtags.length > 0,
      debug: debugFlag ? debug : undefined
    });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
