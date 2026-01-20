import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';
import { hasRequiredHashtag } from '@/lib/hashtag-filter';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds to stay safe

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

async function canViewCampaign(campaignId: string) {
  const supabase = await createServerSSR();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('users').select('role').eq('id', user.id).single();
  const role = data?.role;
  if (role === 'admin' || role === 'super_admin') return true;
  const admin = adminClient();
  const { data: eg } = await admin.from('employee_groups').select('employee_id').eq('campaign_id', campaignId).eq('employee_id', user.id).maybeSingle();
  return !!eg;
}

export async function GET(req: Request, context: any) {
  try {
    const supabase = adminClient();
    const { id } = await context.params; // employee id

    // Filters: prefer explicit start/end (from group UI), else fall back to campaign window
    const url = new URL(req.url);
    const campaignId = url.searchParams.get('campaign_id') || null;
    const interval = (url.searchParams.get('interval') as 'daily'|'weekly'|'monthly'|null) || 'daily';
    const mode = (url.searchParams.get('mode') || 'postdate').toLowerCase() as 'postdate'|'accrual';

    // Authorization: admin or assigned to this campaign
    if (!campaignId) {
      const isAdmin = await ensureAdmin();
      if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    } else {
      const allowed = await canViewCampaign(campaignId);
      if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let start: string | null = url.searchParams.get('start') || null;
    let end: string | null = url.searchParams.get('end') || null;
    if (campaignId) {
      if (!start || !end) {
        const { data: camp } = await supabase
          .from('campaigns')
          .select('start_date, end_date')
          .eq('id', campaignId)
          .maybeSingle();
        if (!start && camp?.start_date) start = camp.start_date as string;
        if (!end) end = (camp?.end_date as string | null) || new Date().toISOString().slice(0,10);
      }
    }

    // resolve usernames for this employee
    let usernames: string[] = [];
    let igUsernames: string[] = [];
    if (campaignId) {
      // prefer per-campaign assignment using employee_participants
      const { data: ep } = await supabase
        .from('employee_participants')
        .select('tiktok_username')
        .eq('employee_id', id)
        .eq('campaign_id', campaignId);
      usernames = (ep || []).map((x:any)=> String(x.tiktok_username)).filter(Boolean);
    }
    if (!usernames.length) {
      // fallback to employee_accounts (legacy)
      const { data: accounts } = await supabase
        .from('employee_accounts')
        .select('account_user_id')
        .eq('employee_id', id);
      const accountIds = (accounts || []).map((a:any)=>a.account_user_id);
      if (accountIds.length > 0) {
        const { data: aus } = await supabase.from('users').select('tiktok_username').in('id', accountIds);
        usernames = (aus || []).map((x:any)=>x.tiktok_username).filter(Boolean);
      }
    }

    // Resolve Instagram usernames for this employee
    try {
      if (campaignId) {
        // campaign-specific IG list
        const { data: igEp } = await supabase
          .from('employee_instagram_participants')
          .select('instagram_username')
          .eq('employee_id', id)
          .eq('campaign_id', campaignId);
        igUsernames = (igEp || []).map((r:any)=> String(r.instagram_username)).filter(Boolean);
      }
      if (!igUsernames.length) {
        // fallback to global mapping for the user
        const { data: igMap } = await supabase
          .from('user_instagram_usernames')
          .select('instagram_username')
          .eq('user_id', id);
        igUsernames = (igMap || []).map((r:any)=> String(r.instagram_username)).filter(Boolean);
      }
      if (!igUsernames.length) {
        // final fallback: profile field on users (instagram_username + extra_instagram_usernames)
        const { data: igProfile } = await supabase
          .from('users')
          .select('instagram_username, extra_instagram_usernames')
          .eq('id', id)
          .maybeSingle();
        const arr:string[] = [];
        if (igProfile?.instagram_username) arr.push(String(igProfile.instagram_username));
        if (Array.isArray((igProfile as any)?.extra_instagram_usernames)) {
          for (const u of (igProfile as any).extra_instagram_usernames) if (u) arr.push(String(u));
        }
        if (arr.length) igUsernames = arr;
      }
      if (!igUsernames.length) {
        // additional fallback: collect from linked employee accounts (same as TikTok flow)
        const { data: empAcc } = await supabase
          .from('employee_accounts')
          .select('account_user_id')
          .eq('employee_id', id);
        const accountIds = Array.from(new Set((empAcc||[]).map((r:any)=> r.account_user_id))).filter(Boolean);
        if (accountIds.length) {
          const usernamesFromAccounts: string[] = [];
          try {
            const { data: accUsers } = await supabase
              .from('users')
              .select('instagram_username, id, extra_instagram_usernames')
              .in('id', accountIds);
            for (const u of accUsers || []) {
              if ((u as any).instagram_username) usernamesFromAccounts.push(String((u as any).instagram_username));
              if (Array.isArray((u as any).extra_instagram_usernames)) {
                for (const ex of (u as any).extra_instagram_usernames) if (ex) usernamesFromAccounts.push(String(ex));
              }
            }
          } catch {}
          try {
            const { data: accMap } = await supabase
              .from('user_instagram_usernames')
              .select('instagram_username, user_id')
              .in('user_id', accountIds);
            for (const r of accMap || []) if ((r as any).instagram_username) usernamesFromAccounts.push(String((r as any).instagram_username));
          } catch {}
          if (usernamesFromAccounts.length) igUsernames = usernamesFromAccounts;
        }
      }
    } catch {}
    // As an ultimate fallback, mirror TikTok usernames to try query IG dataset.
    if (!igUsernames.length) igUsernames = [...usernames];
    // Normalize & dedupe early
    igUsernames = Array.from(new Set(igUsernames.map((u)=> String(u).replace(/^@+/, '').toLowerCase()).filter(Boolean)));

    // Ensure campaign mapping exists so future queries don't miss
    if (campaignId && igUsernames.length) {
      try {
        const campRows = igUsernames.map(u => ({ campaign_id: campaignId, instagram_username: u }));
        const empRows = igUsernames.map(u => ({ employee_id: id, campaign_id: campaignId, instagram_username: u }));
        await supabase.from('campaign_instagram_participants').upsert(campRows, { onConflict: 'campaign_id,instagram_username', ignoreDuplicates: true });
        await supabase.from('employee_instagram_participants').upsert(empRows, { onConflict: 'employee_id,campaign_id,instagram_username', ignoreDuplicates: true });
      } catch {}
    }

    if (usernames.length === 0 && igUsernames.length === 0) return NextResponse.json({ series: [], totals: {}, interval });

    // Fetch campaign hashtags for filtering
    let requiredHashtags: string[] | null = null;
    if (campaignId) {
      try {
        const { data: camp } = await supabase
          .from('campaigns')
          .select('required_hashtags')
          .eq('id', campaignId)
          .single();
        requiredHashtags = (camp as any)?.required_hashtags || null;
      } catch {}
    }

    // Accrual mode: build series from social_metrics_history deltas (per captured day)
    if (mode === 'accrual') {
      // Rolling preset window or custom date range
      const daysQ = Number(url.searchParams.get('days') || '0');
      const windowDays = daysQ > 0 ? daysQ : 7;
      const cutoffParam = url.searchParams.get('cutoff');
      const customMode = url.searchParams.get('custom') === '1';
      
      let startISO: string;
      let endISO: string;
      
      if (customMode && cutoffParam) {
        // Custom date mode: use cutoff as start, calculate end from days
        startISO = cutoffParam;
        const endD = new Date(cutoffParam + 'T00:00:00Z');
        endD.setUTCDate(endD.getUTCDate() + (windowDays - 1));
        endISO = endD.toISOString().slice(0,10);
      } else {
        // Preset mode: rolling window from today
        endISO = new Date().toISOString().slice(0,10);
        startISO = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(windowDays-1)); return d.toISOString().slice(0,10) })();
      }
      
      // startISO / endISO already set from preset window or custom date above
      // fetch history for this employee id for both platforms
      // include snapshot sehari sebelum start agar delta hari pertama tidak hilang
      const pre = new Date(startISO+'T00:00:00Z'); pre.setUTCDate(pre.getUTCDate()-1);
      const preISO = pre.toISOString().slice(0,10);
      const { data: hist } = await supabase
        .from('social_metrics_history')
        .select('platform, views, likes, comments, shares, saves, captured_at')
        .eq('user_id', id)
        .gte('captured_at', preISO+'T00:00:00Z')
        .lte('captured_at', endISO+'T23:59:59Z')
        .order('captured_at', { ascending: true });
      const sep = (plat:'tiktok'|'instagram') => (hist||[]).filter((r:any)=> String(r.platform)===plat).map(r=>({
        date: String((r as any).captured_at).slice(0,10),
        views: Number((r as any).views)||0,
        likes: Number((r as any).likes)||0,
        comments: Number((r as any).comments)||0,
        shares: Number((r as any).shares)||0,
        saves: Number((r as any).saves)||0,
      }));
      const accSeries = (arr:any[]) => {
        const byDate = new Map<string, any[]>();
        for (const r of arr) { const a=byDate.get(r.date)||[]; a.push(r); byDate.set(r.date,a); }
        // ensure chronological array by date of captured (already aggregated per day if multiple rows)
        const days = Array.from(byDate.keys()).sort();
        const out:any[] = [];
        let prev:{views:number;likes:number;comments:number;shares:number;saves:number}|null=null;
        for (const d of days) {
          const list = byDate.get(d)!;
          // merge same-day snapshots to the latest one
          const last = list[list.length-1];
          if (!prev) { prev = last; continue; }
          const dv = Math.max(0, (last.views||0) - (prev.views||0));
          const dl = Math.max(0, (last.likes||0) - (prev.likes||0));
          const dc = Math.max(0, (last.comments||0) - (prev.comments||0));
          const ds = Math.max(0, (last.shares||0) - (prev.shares||0));
          const dsv = Math.max(0, (last.saves||0) - (prev.saves||0));
          if (d >= startISO && d <= endISO) out.push({ date: d, views: dv, likes: dl, comments: dc, shares: ds, saves: dsv });
          prev = last;
        }
        return out;
      };
      let tikTok = accSeries(sep('tiktok'));
      let insta = accSeries(sep('instagram'));
      // snapshots_only default ON; tidak ada fallback posts_daily agar selaras dengan definisi accrual berbasis snapshot
      const snapshotsOnly = (new URL(req.url)).searchParams.get('snapshots_only') !== '0';
      if (!snapshotsOnly) {
        try {
          const handlesTT = Array.from(new Set((usernames||[]).map((u:string)=> String(u).replace(/^@/, '').toLowerCase()).filter(Boolean)));
          if (handlesTT.length) {
            const { data: ttRows } = await supabase
              .from('tiktok_posts_daily')
              .select('post_date, play_count, digg_count, comment_count, share_count, save_count, username, title')
              .in('username', handlesTT)
              .gte('post_date', startISO)
              .lte('post_date', endISO);
            const dayAgg = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
            for (const r of ttRows||[]) {
              if (!hasRequiredHashtag((r as any).title, requiredHashtags)) continue;
              const d = String((r as any).post_date);
              const cur = dayAgg.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              cur.views += Number((r as any).play_count)||0;
              cur.likes += Number((r as any).digg_count)||0;
              cur.comments += Number((r as any).comment_count)||0;
              cur.shares += Number((r as any).share_count)||0;
              cur.saves += Number((r as any).save_count)||0;
              dayAgg.set(d, cur);
            }
            const mapTT = new Map(tikTok.map((s:any)=> [String(s.date), s] as const));
            for (const [d, v] of dayAgg.entries()) {
              const existed = mapTT.get(d);
              if (!existed || ((existed.views||0)+(existed.likes||0)+(existed.comments||0)+(existed.shares||0)+(existed.saves||0)) === 0) {
                mapTT.set(d, { date: d, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves });
              }
            }
            tikTok = Array.from(mapTT.values()).sort((a:any,b:any)=> String(a.date).localeCompare(String(b.date)));
          }
        } catch {}
      }

      // Fallback: if no IG history rows for this employee (common on first runs),
      // derive accrual per-day directly from instagram_posts_daily using resolved IG usernames
      const instaSum = (arr:any[])=> (arr||[]).reduce((a:number,s:any)=> a + Number(s.views||0) + Number(s.likes||0) + Number(s.comments||0) + Number(s.shares||0) + Number(s.saves||0), 0);
      if (!snapshotsOnly && (((!insta || insta.length === 0) || instaSum(insta) === 0) && (igUsernames && igUsernames.length))) {
        try {
          const igHandles = Array.from(new Set(igUsernames.map((u:string)=> String(u).replace(/^@/, '').toLowerCase())));
          if (igHandles.length) {
            const { data: igRows } = await supabase
              .from('instagram_posts_daily')
              .select('post_date, play_count, like_count, comment_count, username, caption')
              .in('username', igHandles)
              .gte('post_date', startISO)
              .lte('post_date', endISO);
            const map = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
            for (const r of igRows||[]) {
              // Apply hashtag filter
              if (!hasRequiredHashtag((r as any).caption, requiredHashtags)) continue;
              
              const d = String((r as any).post_date);
              const cur = map.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              cur.views += Number((r as any).play_count)||0;
              cur.likes += Number((r as any).like_count)||0;
              cur.comments += Number((r as any).comment_count)||0;
              map.set(d, cur);
            }
            insta = Array.from(map.entries()).map(([date,v])=> ({ date, views:v.views, likes:v.likes, comments:v.comments, shares:0, saves:0 }))
              .sort((a,b)=> a.date.localeCompare(b.date));
          }
        } catch {}
      }
      const bucket = (dateStr:string, mode:'daily'|'weekly'|'monthly')=>{
        if (mode==='weekly') {
          const d = new Date(dateStr+'T00:00:00Z');
          const day = d.getUTCDay();
          const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day+6)%7));
          return monday.toISOString().slice(0,10);
        }
        if (mode==='monthly') {
          const d = new Date(dateStr+'T00:00:00Z');
          return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0,10);
        }
        return dateStr;
      };
      const group = (arr:any[], mode:'daily'|'weekly'|'monthly')=>{
        if (mode==='daily') return arr;
        const map = new Map<string,{date:string;views:number;likes:number;comments:number;shares:number;saves:number}>();
        for (const s of arr||[]) {
          const k = bucket(s.date, mode);
          const cur = map.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
          cur.views+=s.views; cur.likes+=s.likes; cur.comments+=s.comments; cur.shares+=s.shares; cur.saves+=s.saves; map.set(k, cur);
        }
        return Array.from(map.values()).sort((a,b)=> a.date.localeCompare(b.date));
      };
      // zero-fill daily
      const ds = new Date(startISO+'T00:00:00Z');
      const de = new Date(endISO+'T00:00:00Z');
      const mapTT = new Map(tikTok.map((s:any)=>[s.date,s]));
      const mapIG = new Map(insta.map((s:any)=>[s.date,s]));
      let seriesTikTok:any[]=[]; let seriesInstagram:any[]=[]; const merge=new Map<string, any>();
      for (let d = new Date(ds); d <= de; d.setUTCDate(d.getUTCDate()+1)) {
        const key = d.toISOString().slice(0,10);
        const tv = mapTT.get(key) || { date:key, views:0, likes:0, comments:0, shares:0, saves:0 };
        const iv = mapIG.get(key) || { date:key, views:0, likes:0, comments:0, shares:0, saves:0 };
        seriesTikTok.push(tv); seriesInstagram.push(iv);
        const cur = merge.get(key) || { date:key, views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views+=tv.views+iv.views; cur.likes+=tv.likes+iv.likes; cur.comments+=tv.comments+iv.comments; cur.shares+=tv.shares+iv.shares; cur.saves+=tv.saves+iv.saves; merge.set(key, cur);
      }
      // apply bucket group when requested
      seriesTikTok = group(seriesTikTok, interval);
      seriesInstagram = group(seriesInstagram, interval);
      const series = group(Array.from(merge.values()).sort((a,b)=> a.date.localeCompare(b.date)), interval);
      const totals = series.reduce((a:any,s:any)=>({ views:a.views+s.views, likes:a.likes+s.likes, comments:a.comments+s.comments, shares:a.shares+s.shares, saves:a.saves+s.saves, posts:0 }), { views:0, likes:0, comments:0, shares:0, saves:0, posts:0 });
      return NextResponse.json({ series, series_tiktok: seriesTikTok, series_instagram: seriesInstagram, totals, totals_tiktok:{}, totals_instagram:{}, interval });
    }

    // Compute totals within the requested date range from tiktok_posts_daily and instagram_posts_daily for assigned usernames.
    // Fall back to campaign_participants snapshots only if start/end are not available.
    const normUsernames = Array.from(new Set(usernames.map((u:string)=> String(u).replace(/^@/, '').toLowerCase()).filter(Boolean)));
    const normIG = Array.from(new Set(igUsernames.map((u:string)=> String(u).replace(/^@/, '').toLowerCase()).filter(Boolean)));
    let totalsTikTok = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 } as any;
    let totalsInstagram = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 } as any;
    if (start && end) {
      const { data: rows, error: aggErr } = await supabase
        .from('tiktok_posts_daily')
        .select('play_count, digg_count, comment_count, share_count, save_count, title')
        .in('username', normUsernames)
        .gte('post_date', start)
        .lte('post_date', end);
      for (const r of rows || []) {
        // Apply hashtag filter
        if (!hasRequiredHashtag((r as any).title, requiredHashtags)) continue;
        
        totalsTikTok.views += Number((r as any).play_count) || 0;
        totalsTikTok.likes += Number((r as any).digg_count) || 0;
        totalsTikTok.comments += Number((r as any).comment_count) || 0;
        totalsTikTok.shares += Number((r as any).share_count) || 0;
        totalsTikTok.saves += Number((r as any).save_count) || 0;
        totalsTikTok.posts += 1;
      }
      const { data: igRows } = await supabase
        .from('instagram_posts_daily')
        .select('play_count, like_count, comment_count, caption')
        .in('username', normIG)
        .gte('post_date', start)
        .lte('post_date', end);
      for (const r of igRows || []) {
        // Apply hashtag filter
        if (!hasRequiredHashtag((r as any).caption, requiredHashtags)) continue;
        
        totalsInstagram.views += Number((r as any).play_count)||0;
        totalsInstagram.likes += Number((r as any).like_count)||0;
        totalsInstagram.comments += Number((r as any).comment_count)||0;
        totalsInstagram.posts += 1;
      }
    }
    // If IG still zero and campaignId provided, fallback to snapshots campaign_instagram_participants
    if ((totalsInstagram.views + totalsInstagram.likes + totalsInstagram.comments) === 0 && campaignId && normIG.length) {
      const { data: snapsIG2 } = await supabase
        .from('campaign_instagram_participants')
        .select('instagram_username, views, likes, comments, posts_total')
        .eq('campaign_id', campaignId)
        .in('instagram_username', normIG);
      for (const r of snapsIG2 || []) {
        totalsInstagram.views += Number((r as any).views || 0);
        totalsInstagram.likes += Number((r as any).likes || 0);
        totalsInstagram.comments += Number((r as any).comments || 0);
        totalsInstagram.posts += Number((r as any).posts_total || 0);
      }
    }
    // Fallback to snapshots (useful when DB has no rows for the window)
    if ((totalsTikTok.views + totalsTikTok.likes + totalsTikTok.comments + totalsTikTok.shares + totalsTikTok.saves + totalsInstagram.views + totalsInstagram.likes + totalsInstagram.comments) === 0) {
      const { data: snaps } = await supabase
        .from('campaign_participants')
        .select('tiktok_username, views, likes, comments, shares, saves, posts_total')
        .eq('campaign_id', campaignId)
        .in('tiktok_username', usernames);
      const totalsSnap = (snaps || []).reduce((acc:any, r:any) => ({
        views: acc.views + Number(r.views || 0),
        likes: acc.likes + Number(r.likes || 0),
        comments: acc.comments + Number(r.comments || 0),
        shares: acc.shares + Number(r.shares || 0),
        saves: acc.saves + Number(r.saves || 0),
        posts: acc.posts + Number((r as any).posts_total || 0),
      }), { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 });
      totalsTikTok = totalsSnap; // best effort
    }

    // Build series using RPC that aggregates by usernames subset within group window
    let series: any[] = [];
    let seriesTikTok: any[] = [];
    let seriesInstagram: any[] = [];
    try {
      const { data: rows, error: rpcErr } = await supabase.rpc('campaign_series_usernames', {
        start_date: start || null,
        end_date: end || null,
        usernames: usernames,
        p_interval: interval,
      } as any);
      if (!rpcErr) {
        seriesTikTok = (rows || []).map((r: any) => ({
          date: String(r.bucket_date),
          views: Number(r.views)||0,
          likes: Number(r.likes)||0,
          comments: Number(r.comments)||0,
          shares: Number(r.shares)||0,
          saves: Number(r.saves)||0,
        }));
      }
    } catch {}

    // Instagram series (group by date in range)
    try {
      const { data: rows } = await supabase
        .from('instagram_posts_daily')
        .select('post_date, play_count, like_count, comment_count')
        .in('username', normIG)
        .gte('post_date', start || '1970-01-01')
        .lte('post_date', end || new Date().toISOString().slice(0,10));
      const map = new Map<string,{views:number;likes:number;comments:number}>();
      for (const r of rows||[]) {
        const key = String((r as any).post_date);
        const cur = map.get(key) || { views:0, likes:0, comments:0 };
        cur.views += Number((r as any).play_count)||0;
        cur.likes += Number((r as any).like_count)||0;
        cur.comments += Number((r as any).comment_count)||0;
        map.set(key, cur);
      }
      // Bucket IG by requested interval (daily/weekly/monthly)
      const bucketKey = (dStr:string) => {
        if (interval === 'weekly') {
          const d = new Date(dStr+'T00:00:00Z');
          const day = d.getUTCDay();
          const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day+6)%7));
          return monday.toISOString().slice(0,10);
        }
        if (interval === 'monthly') {
          const d = new Date(dStr+'T00:00:00Z');
          return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0,10);
        }
        return dStr;
      };
      const buck = new Map<string,{date:string;views:number;likes:number;comments:number;shares:number;saves:number}>();
      for (const [d,v] of Array.from(map.entries())) {
        const k = bucketKey(d);
        const cur = buck.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views += v.views; cur.likes += v.likes; cur.comments += v.comments; buck.set(k, cur);
      }
      seriesInstagram = Array.from(buck.values()).sort((a,b)=> a.date.localeCompare(b.date));
    } catch {}

    // Build canonical key range across start..end with requested interval to align TT and IG arrays
    const buildKeys = (s?:string|null, e?:string|null): string[] => {
      const s0 = s || new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10);
      const e0 = e || new Date().toISOString().slice(0,10);
      const keys:string[] = [];
      const bump = (d:Date) => {
        if (interval==='weekly') { d.setUTCDate(d.getUTCDate()+7); }
        else if (interval==='monthly') { d.setUTCMonth(d.getUTCMonth()+1); }
        else { d.setUTCDate(d.getUTCDate()+1); }
      };
      const startKey = (()=>{
        if (interval==='weekly') {
          const d=new Date(s0+'T00:00:00Z'); const day=d.getUTCDay(); d.setUTCDate(d.getUTCDate()-((day+6)%7)); return d;
        }
        if (interval==='monthly') { const d=new Date(s0+'T00:00:00Z'); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
        return new Date(s0+'T00:00:00Z');
      })();
      const endDate = new Date(e0+'T00:00:00Z');
      for (let d=new Date(startKey); d<=endDate; bump(d)) keys.push(d.toISOString().slice(0,10));
      return keys;
    };
    const keys = buildKeys(start, end);
    const mapTT = new Map(seriesTikTok.map((s:any)=>[s.date, s]));
    const mapIG = new Map(seriesInstagram.map((s:any)=>[s.date, s]));
    const alignedTT:any[] = []; const alignedIG:any[] = []; const merged:any[] = [];
    for (const k of keys) {
      const t = mapTT.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
      const ig = mapIG.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
      alignedTT.push(t); alignedIG.push(ig);
      merged.push({ date:k, views:(t.views||0)+(ig.views||0), likes:(t.likes||0)+(ig.likes||0), comments:(t.comments||0)+(ig.comments||0), shares:(t.shares||0)+(ig.shares||0), saves:(t.saves||0)+(ig.saves||0) });
    }
    seriesTikTok = alignedTT; seriesInstagram = alignedIG; series = merged;

    // Historical disabled: always empty
    let historical: any[] = [];

    const totals = {
      views: (totalsTikTok.views||0)+(totalsInstagram.views||0),
      likes: (totalsTikTok.likes||0)+(totalsInstagram.likes||0),
      comments: (totalsTikTok.comments||0)+(totalsInstagram.comments||0),
      shares: (totalsTikTok.shares||0)+(totalsInstagram.shares||0),
      saves: (totalsTikTok.saves||0)+(totalsInstagram.saves||0),
      posts: (totalsTikTok.posts||0)+(totalsInstagram.posts||0),
    };
    return NextResponse.json({ 
      series, 
      series_tiktok: seriesTikTok, 
      series_instagram: seriesInstagram, 
      historical,
      totals, 
      totals_tiktok: totalsTikTok, 
      totals_instagram: totalsInstagram, 
      interval, 
      resolved_usernames: { tiktok: normUsernames, instagram: normIG }, 
      window: { start, end } 
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
