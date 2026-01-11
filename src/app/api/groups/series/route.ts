import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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

export async function GET(req: Request) {
  try {
    const supa = adminClient();
    const url = new URL(req.url);
    const interval = (url.searchParams.get('interval') || 'daily').toLowerCase() as 'daily'|'weekly'|'monthly';
    const mode = (url.searchParams.get('mode')||'accrual').toLowerCase();
    const respectHashtags = url.searchParams.get('respect_hashtags') === '1';
    const snapshotsOnly = url.searchParams.get('snapshots_only') !== '0';
    let startISO = url.searchParams.get('start');
    let endISO = url.searchParams.get('end');
    const daysQ = Number(url.searchParams.get('days')||'0');
    const windowDays = ([7,28,60] as number[]).includes(daysQ) ? daysQ : 0;
    if (mode==='accrual' && windowDays>0) {
      const end = new Date();
      const start = new Date(); start.setUTCDate(end.getUTCDate()-(windowDays-1));
      startISO = start.toISOString().slice(0,10);
      endISO = end.toISOString().slice(0,10);
    }
    if (!startISO || !endISO) {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate()-30);
      startISO = start.toISOString().slice(0,10);
      endISO = end.toISOString().slice(0,10);
    }

    // Helper available for both modes: derive IG usernames for a campaign
    const deriveIGUsernamesForCampaign = async (client: ReturnType<typeof adminClient>, campaignId: string): Promise<string[]> => {
      // 1) Prefer explicit campaign IG participants
      try {
        const { data: igParts } = await client
          .from('campaign_instagram_participants')
          .select('instagram_username')
          .eq('campaign_id', campaignId);
        const arr = (igParts||[]).map((r:any)=> String(r.instagram_username||'')
          .trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
        if (arr.length) return Array.from(new Set(arr));
      } catch {}
      // 2) Fallback to employee_instagram_participants
      try {
        const { data: empIg } = await client
          .from('employee_instagram_participants')
          .select('instagram_username')
          .eq('campaign_id', campaignId);
        const arr = (empIg||[]).map((r:any)=> String(r.instagram_username||'')
          .trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
        if (arr.length) return Array.from(new Set(arr));
      } catch {}
      // 3) Derive from TikTok participants' owners → IG usernames
      try {
        const { data: ttParts } = await client
          .from('campaign_participants')
          .select('tiktok_username')
          .eq('campaign_id', campaignId);
        const ttHandles = (ttParts||[]).map((r:any)=> String(r.tiktok_username||'')
          .trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
        if (ttHandles.length) {
          const owners = new Set<string>();
          // explicit mapping table user_tiktok_usernames
          try {
            const { data: mapRows } = await client
              .from('user_tiktok_usernames')
              .select('user_id, tiktok_username')
              .in('tiktok_username', ttHandles);
            for (const r of mapRows||[]) owners.add(String((r as any).user_id));
          } catch {}
          // users.tiktok_username direct
          try {
            const { data: userRows } = await client
              .from('users')
              .select('id')
              .in('tiktok_username', ttHandles);
            for (const r of userRows||[]) owners.add(String((r as any).id));
          } catch {}
          if (owners.size) {
            const ids = Array.from(owners);
            const set = new Set<string>();
            try {
              const { data: igMap } = await client
                .from('user_instagram_usernames')
                .select('instagram_username, user_id')
                .in('user_id', ids);
              for (const r of igMap||[]) {
                const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
                if (u) set.add(u);
              }
            } catch {}
            try {
              const { data: igUsers } = await client
                .from('users')
                .select('instagram_username, id')
                .in('id', ids);
              for (const r of igUsers||[]) {
                const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
                if (u) set.add(u);
              }
            } catch {}
            if (set.size) return Array.from(set);
          }
        }
      } catch {}
      // 4) Last fallback: employees in this campaign (employee_groups) → IG aliases/profiles
      try {
        const { data: eg } = await client
          .from('employee_groups')
          .select('employee_id')
          .eq('campaign_id', campaignId);
        const empIds = Array.from(new Set((eg||[]).map((r:any)=> String(r.employee_id))));
        if (empIds.length) {
          const set = new Set<string>();
          try {
            const { data: igMap } = await client
              .from('user_instagram_usernames')
              .select('instagram_username, user_id')
              .in('user_id', empIds);
            for (const r of igMap||[]) {
              const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
              if (u) set.add(u);
            }
          } catch {}
          try {
            const { data: igUsers } = await client
              .from('users')
              .select('instagram_username, id')
              .in('id', empIds);
            for (const r of igUsers||[]) {
              const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
              if (u) set.add(u);
            }
          } catch {}
          if (set.size) return Array.from(set);
        }
      } catch {}
      return [];
    };

    // Accrual mode: aggregate from social_metrics_history deltas across all employees
    // snapshots_only default ON (no augmentation from posts_daily)
    if (mode === 'accrual') {
      const start = startISO!; const end = endISO!;
      // keys (daily)
      const keys:string[] = []; const ds=new Date(start+'T00:00:00Z'); const de=new Date(end+'T00:00:00Z'); for (let d=new Date(ds); d<=de; d.setUTCDate(d.getUTCDate()+1)) keys.push(d.toISOString().slice(0,10));
      // Baseline: gunakan snapshot TERAKHIR sebelum start (tidak harus tepat H-1)
      // Untuk menjamin konsistensi antara window 7/28 hari, ambil lookback beberapa hari ke belakang.
      const baselineLookbackDays = 30; // kompromi performa vs akurasi
      const baselineFrom = new Date(start+'T00:00:00Z'); baselineFrom.setUTCDate(baselineFrom.getUTCDate()-baselineLookbackDays);
      const prev = new Date(start+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1); const prevISO = prev.toISOString().slice(0,10);
      // all employees
      const { data: emps } = await supa.from('users').select('id').eq('role','karyawan');
      const allEmpIds = (emps||[]).map((u:any)=> String(u.id));

      const calcSeries = async (ids:string[]) => {
        const totalMap = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
        const add = (date:string, v:any)=>{ if (date < start || date > end) return; const cur = totalMap.get(date) || { views:0, likes:0, comments:0, shares:0, saves:0 }; cur.views+=v.views; cur.likes+=v.likes; cur.comments+=v.comments; cur.shares+=v.shares; cur.saves+=v.saves; totalMap.set(date, cur); };
        const buildPlat = async (plat:'tiktok'|'instagram')=>{
          if (!ids.length) return;
          const { data: rows } = await supa
            .from('social_metrics_history')
            .select('user_id, views, likes, comments, shares, saves, captured_at')
            .in('user_id', ids)
            .eq('platform', plat)
            // ambil snapshot mulai baseline lookback agar ada prev sebelum start
            .gte('captured_at', baselineFrom.toISOString().slice(0,10)+'T00:00:00Z')
            .lte('captured_at', end+'T23:59:59Z')
            .order('user_id', { ascending: true })
            .order('captured_at', { ascending: true });
          const byUser = new Map<string, any[]>();
          for (const r of rows||[]) { const uid=String((r as any).user_id); const arr=byUser.get(uid)||[]; arr.push(r); byUser.set(uid, arr); }
          for (const [, arr] of byUser.entries()) {
            // Build last snapshot per day
            const lastByDay = new Map<string, any>();
            for (const r of arr) { const d=String((r as any).captured_at).slice(0,10); lastByDay.set(d, r); }
            // Cari snapshot terakhir SEBELUM start (<= H-1), bukan hanya tepat H-1
            let prevSnap: any = null;
            {
              // scan mundur max baselineLookbackDays hari
              const base = new Date(start+'T00:00:00Z');
              for (let i=1;i<=baselineLookbackDays;i++) {
                const d = new Date(base); d.setUTCDate(d.getUTCDate()-i);
                const key = d.toISOString().slice(0,10);
                const cand = lastByDay.get(key);
                if (cand) { prevSnap = cand; break; }
              }
            }
            let prev = prevSnap;
            for (const d of keys) {
              const cur = lastByDay.get(d);
              if (cur && prev) {
                const dv=Math.max(0, Number((cur as any).views||0)-Number((prev as any).views||0));
                const dl=Math.max(0, Number((cur as any).likes||0)-Number((prev as any).likes||0));
                const dc=Math.max(0, Number((cur as any).comments||0)-Number((prev as any).comments||0));
                const ds=Math.max(0, Number((cur as any).shares||0)-Number((prev as any).shares||0));
                const dsv=Math.max(0, Number((cur as any).saves||0)-Number((prev as any).saves||0));
                add(d, { views: dv, likes: dl, comments: dc, shares: ds, saves: dsv });
              }
              if (cur) prev = cur;
            }
          }
        };
        await buildPlat('tiktok'); await buildPlat('instagram');
        return keys.map(k=> ({ date:k, ...(totalMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
      };

      // platform-separated series across all employees (for legend sync)
      const calcSeriesPlatform = async (ids:string[], plat:'tiktok'|'instagram') => {
        const map = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
        if (ids.length) {
          const { data: rows } = await supa
            .from('social_metrics_history')
            .select('user_id, views, likes, comments, shares, saves, captured_at')
            .in('user_id', ids)
            .eq('platform', plat)
            .gte('captured_at', baselineFrom.toISOString().slice(0,10)+'T00:00:00Z')
            .lte('captured_at', end+'T23:59:59Z')
            .order('user_id', { ascending: true })
            .order('captured_at', { ascending: true });
          const byUser = new Map<string, any[]>();
          for (const r of rows||[]) { const uid=String((r as any).user_id); const arr=byUser.get(uid)||[]; arr.push(r); byUser.set(uid, arr); }
          for (const [, arr] of byUser.entries()) {
            const lastByDay = new Map<string, any>();
            for (const r of arr) { const d=String((r as any).captured_at).slice(0,10); lastByDay.set(d, r); }
            let prevSnap: any = null;
            {
              const base = new Date(start+'T00:00:00Z');
              for (let i=1;i<=baselineLookbackDays;i++) {
                const d = new Date(base); d.setUTCDate(d.getUTCDate()-i);
                const key = d.toISOString().slice(0,10);
                const cand = lastByDay.get(key);
                if (cand) { prevSnap = cand; break; }
              }
            }
            let prev = prevSnap;
            for (const d of keys) {
              const cur = lastByDay.get(d);
              if (cur && prev) {
                const dv=Math.max(0, Number((cur as any).views||0)-Number((prev as any).views||0));
                const dl=Math.max(0, Number((cur as any).likes||0)-Number((prev as any).likes||0));
                const dc=Math.max(0, Number((cur as any).comments||0)-Number((prev as any).comments||0));
                const ds=Math.max(0, Number((cur as any).shares||0)-Number((prev as any).shares||0));
                const dsv=Math.max(0, Number((cur as any).saves||0)-Number((prev as any).saves||0));
                if (d >= start && d <= end) {
                  const curAgg = map.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
                  curAgg.views+=dv; curAgg.likes+=dl; curAgg.comments+=dc; curAgg.shares+=ds; curAgg.saves+=dsv; map.set(d, curAgg);
                }
              }
              if (cur) prev = cur;
            }
          }
        }
        return keys.map(k => ({ date:k, ...(map.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
      };
      // Helper: derive TT usernames for a campaign from participants and employee mappings
      const deriveTTUsernames = async (campaignId: string, empIds: string[]): Promise<string[]> => {
        const set = new Set<string>();
        // explicit campaign participants
        try {
          const { data: ttParts } = await supa
            .from('campaign_participants')
            .select('tiktok_username')
            .eq('campaign_id', campaignId);
          for (const r of ttParts||[]) { const u=String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (u) set.add(u); }
        } catch {}
        if (empIds.length) {
          try {
            const { data: map } = await supa
              .from('user_tiktok_usernames')
              .select('tiktok_username, user_id')
              .in('user_id', empIds);
            for (const r of map||[]) { const u=String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (u) set.add(u); }
          } catch {}
          try {
            const { data: users } = await supa
              .from('users')
              .select('tiktok_username, id')
              .in('id', empIds);
            for (const r of users||[]) { const u=String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (u) set.add(u); }
          } catch {}
        }
        return Array.from(set);
      };

      // Accumulate totals while producing per-campaign series with fallbacks
      const groups:any[] = [];
      const totalMap = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
      const totalTTMap = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
      const totalIGMap = new Map<string,{views:number;likes:number;comments:number}>();

      // per-campaign breakdown
      const { data: campaigns } = await supa.from('campaigns').select('id, name, required_hashtags').order('start_date', { ascending: true });
      if (campaigns && campaigns.length) {
        const { data: empGroups } = await supa
          .from('employee_groups')
          .select('campaign_id, employee_id')
          .in('campaign_id', campaigns.map((c:any)=> c.id));
        const byCamp = new Map<string, string[]>();
        for (const r of empGroups||[]) { const cid=String((r as any).campaign_id); const uid=String((r as any).employee_id); const arr=byCamp.get(cid)||[]; arr.push(uid); byCamp.set(cid, arr); }

        // Helper: if employee_groups is empty for a campaign, derive employee ids from campaign_participants by mapping tiktok usernames to users
        const resolveIdsFromParticipants = async (campaignId: string): Promise<string[]> => {
          try {
            const { data: parts } = await supa
              .from('campaign_participants')
              .select('tiktok_username')
              .eq('campaign_id', campaignId);
            const handles = Array.from(new Set((parts||[])
              .map((r:any)=> String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase())
              .filter(Boolean)));
            if (!handles.length) return [];
            const set = new Set<string>();
            // map via user_tiktok_usernames
            try {
              const { data: mapRows } = await supa
                .from('user_tiktok_usernames')
                .select('user_id, tiktok_username')
                .in('tiktok_username', handles);
              for (const r of mapRows||[]) set.add(String((r as any).user_id));
            } catch {}
            // map via users.tiktok_username
            try {
              const { data: userRows } = await supa
                .from('users')
                .select('id, tiktok_username')
                .in('tiktok_username', handles);
              for (const r of userRows||[]) set.add(String((r as any).id));
            } catch {}
            return Array.from(set);
          } catch { return []; }
        };

        for (const camp of campaigns) {
          let ids = byCamp.get(camp.id) || [];
          if (!ids.length) {
            ids = await resolveIdsFromParticipants(camp.id);
          }
          // History-based (strict snapshots)
          const series_tiktok_hist = await calcSeriesPlatform(ids, 'tiktok');
          const series_instagram_hist = await calcSeriesPlatform(ids, 'instagram');

          // Build quick lookup maps for history values
          const ttHistMap = new Map(series_tiktok_hist.map(s=>[s.date, s] as const));
          const igHistMap = new Map(series_instagram_hist.map(s=>[s.date, s] as const));

          // Optional: augmentation from posts_daily (disabled unless snapshots_only=0)
          const ttHandles = await deriveTTUsernames(camp.id, ids);
          const igHandles = await deriveIGUsernamesForCampaign(supa, camp.id);

          const requiredHashtags: string[] = Array.isArray((camp as any)?.required_hashtags) ? (camp as any).required_hashtags : [];

          if (respectHashtags && requiredHashtags.length && ttHandles.length && !snapshotsOnly) {
            const { data: ttRows } = await supa
              .from('tiktok_posts_daily')
              .select('username, post_date, play_count, digg_count, comment_count, share_count, save_count, title')
              .in('username', ttHandles)
              .gte('post_date', start)
              .lte('post_date', end);
            const tmp = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
            for (const r of ttRows||[]) {
              const title = String((r as any).title||'');
              if (!hasRequiredHashtag(title, requiredHashtags)) continue;
              const d = String((r as any).post_date);
              const cur = tmp.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              cur.views += Number((r as any).play_count)||0;
              cur.likes += Number((r as any).digg_count)||0;
              cur.comments += Number((r as any).comment_count)||0;
              cur.shares += Number((r as any).share_count)||0;
              cur.saves += Number((r as any).save_count)||0;
              tmp.set(d, cur);
            }
            for (const k of keys) {
              const pv = tmp.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              ttHistMap.set(k, { date:k, ...pv });
            }
          } else if (!snapshotsOnly && ttHandles.length) {
            const { data: ttRows } = await supa
              .from('tiktok_posts_daily')
              .select('username, post_date, play_count, digg_count, comment_count, share_count, save_count')
              .in('username', ttHandles)
              .gte('post_date', start)
              .lte('post_date', end);
            const tmp = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
            for (const r of ttRows||[]) {
              const d = String((r as any).post_date);
              const cur = tmp.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              cur.views += Number((r as any).play_count)||0;
              cur.likes += Number((r as any).digg_count)||0;
              cur.comments += Number((r as any).comment_count)||0;
              cur.shares += Number((r as any).share_count)||0;
              cur.saves += Number((r as any).save_count)||0;
              tmp.set(d, cur);
            }
            // merge: use posts_daily when history value is fully zero
            for (const k of keys) {
              const hv = ttHistMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
              const pv = tmp.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              if ((hv.views+hv.likes+hv.comments+hv.shares+hv.saves) === 0 && (pv.views+pv.likes+pv.comments+pv.shares+pv.saves)>0) {
                ttHistMap.set(k, { date:k, ...pv });
              }
            }
          }

          if (respectHashtags && requiredHashtags.length && igHandles.length && !snapshotsOnly) {
            const { data: igRows } = await supa
              .from('instagram_posts_daily')
              .select('username, post_date, play_count, like_count, comment_count, caption')
              .in('username', igHandles)
              .gte('post_date', start)
              .lte('post_date', end);
            const tmp = new Map<string,{views:number;likes:number;comments:number}>();
            for (const r of igRows||[]) {
              const caption = String((r as any).caption||'');
              if (!hasRequiredHashtag(caption, requiredHashtags)) continue;
              const d = String((r as any).post_date);
              const cur = tmp.get(d) || { views:0, likes:0, comments:0 };
              cur.views += Number((r as any).play_count)||0;
              cur.likes += Number((r as any).like_count)||0;
              cur.comments += Number((r as any).comment_count)||0;
              tmp.set(d, cur);
            }
            for (const k of keys) {
              const pv = tmp.get(k) || { views:0, likes:0, comments:0 };
              igHistMap.set(k, { date:k, views: pv.views, likes: pv.likes, comments: pv.comments } as any);
            }
          } else if (!snapshotsOnly && igHandles.length) {
            const { data: igRows } = await supa
              .from('instagram_posts_daily')
              .select('username, post_date, play_count, like_count, comment_count')
              .in('username', igHandles)
              .gte('post_date', start)
              .lte('post_date', end);
            const tmp = new Map<string,{views:number;likes:number;comments:number}>();
            for (const r of igRows||[]) {
              const d = String((r as any).post_date);
              const cur = tmp.get(d) || { views:0, likes:0, comments:0 };
              cur.views += Number((r as any).play_count)||0;
              cur.likes += Number((r as any).like_count)||0;
              cur.comments += Number((r as any).comment_count)||0;
              tmp.set(d, cur);
            }
            for (const k of keys) {
              const hv = igHistMap.get(k) || { date:k, views:0, likes:0, comments:0 } as any;
              const pv = tmp.get(k) || { views:0, likes:0, comments:0 };
              if ((hv.views+hv.likes+hv.comments) === 0 && (pv.views+pv.likes+pv.comments)>0) {
                igHistMap.set(k, { date:k, views: pv.views, likes: pv.likes, comments: pv.comments } as any);
              }
            }
          }

          // Merge TikTok + IG into total series for this campaign
          const series = keys.map(k => {
            const tt = ttHistMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
            const ig = igHistMap.get(k) || { date:k, views:0, likes:0, comments:0 } as any;
            return {
              date: k,
              views: (tt.views||0) + (ig.views||0),
              likes: (tt.likes||0) + (ig.likes||0),
              comments: (tt.comments||0) + (ig.comments||0),
              shares: tt.shares||0,
              saves: tt.saves||0,
            };
          });
          const series_tiktok = keys.map(k => ({ date:k, ...(ttHistMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
          const series_instagram = keys.map(k => ({ date:k, ...(igHistMap.get(k) || { views:0, likes:0, comments:0 }) } as any));

          groups.push({ id: camp.id, name: camp.name || camp.id, series, series_tiktok, series_instagram });

          // accumulate totals maps
          for (const k of keys) {
            const tt = ttHistMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
            const ig = igHistMap.get(k) || { date:k, views:0, likes:0, comments:0 } as any;
            const cur = totalMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
            cur.views += (tt.views||0)+(ig.views||0);
            cur.likes += (tt.likes||0)+(ig.likes||0);
            cur.comments += (tt.comments||0)+(ig.comments||0);
            cur.shares += tt.shares||0;
            cur.saves += tt.saves||0;
            totalMap.set(k, cur);
            const ttc = totalTTMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
            ttc.views += tt.views||0; ttc.likes += tt.likes||0; ttc.comments += tt.comments||0; ttc.shares += tt.shares||0; ttc.saves += tt.saves||0;
            totalTTMap.set(k, ttc);
            const igc = totalIGMap.get(k) || { views:0, likes:0, comments:0 };
            igc.views += ig.views||0; igc.likes += ig.likes||0; igc.comments += ig.comments||0;
            totalIGMap.set(k, igc);
          }
        }
      }

      // Build total arrays from maps (already include fallbacks)
      let total = keys.map(k=> ({ date:k, ...(totalMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
      let total_tiktok = keys.map(k=> ({ date:k, ...(totalTTMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
      let total_instagram = keys.map(k=> ({ date:k, ...(totalIGMap.get(k) || { views:0, likes:0, comments:0 }) as any } as any));

      // Apply accrual cutoff to ALL platforms server-side for robustness
      const u = new URL(req.url);
      const cutoff = String(u.searchParams.get('cutoff') || process.env.ACCRUAL_CUTOFF_DATE || '2026-01-02');
      const trim = u.searchParams.get('trim') === '1';
      const zeroBefore = (arr:any[] = []) => arr.map((s:any)=> (String(s.date) <= cutoff ? { ...s, views:0, likes:0, comments:0, shares:0, saves:0 } : s));
      total = zeroBefore(total);
      total_tiktok = zeroBefore(total_tiktok);
      total_instagram = zeroBefore(total_instagram);
      if (trim) {
        const keep = (s:any)=> String(s.date) >= cutoff;
        total = total.filter(keep);
        total_tiktok = total_tiktok.filter(keep);
        total_instagram = total_instagram.filter(keep);
      }
      let maskedGroups = groups.map((g:any)=> ({
        ...g,
        series: zeroBefore(g.series||[]),
        series_tiktok: zeroBefore(g.series_tiktok||[]),
        series_instagram: zeroBefore(g.series_instagram||[]),
      }));
      if (trim) {
        const keep = (s:any)=> String(s.date) >= cutoff;
        maskedGroups = maskedGroups.map((g:any)=> ({
          ...g,
          series: (g.series||[]).filter(keep),
          series_tiktok: (g.series_tiktok||[]).filter(keep),
          series_instagram: (g.series_instagram||[]).filter(keep),
        }));
      }

      const totals = total.reduce((acc:any, s:any)=>({ views:acc.views+s.views, likes:acc.likes+s.likes, comments:acc.comments+s.comments, shares:acc.shares+s.shares, saves:acc.saves+s.saves }), { views:0, likes:0, comments:0, shares:0, saves:0 });

      return NextResponse.json({ interval: 'daily', start, end, groups: maskedGroups, total, total_tiktok, total_instagram, totals, mode:'accrual' });
    }

    // get all campaigns (groups) for post date series
    const { data: campaigns, error: cErr } = await supa
      .from('campaigns')
      .select('id, name')
      .order('start_date', { ascending: true });
    if (cErr) throw cErr;

    const groups: Array<{ id: string; name: string; series: Array<{date:string; views:number; likes:number; comments:number; shares:number; saves:number}>, series_tiktok?: Array<{date:string; views:number; likes:number; comments:number; shares:number; saves:number}>, series_instagram?: Array<{date:string; views:number; likes:number; comments:number}> }>=[];

    // accumulate total by date across groups
    const totalMap = new Map<string, { views:number; likes:number; comments:number; shares:number; saves:number }>();
    // also keep platform-separated totals for legend sync
    const totalTTMap = new Map<string, { views:number; likes:number; comments:number; shares:number; saves:number }>();
    const totalIGMap = new Map<string, { views:number; likes:number; comments:number }>();

    // helpers for zero-fill keys
    const buildKeys = (mode: 'daily'|'weekly'|'monthly', s: string, e: string): string[] => {
      const keys: string[] = [];
      const ds = new Date(s+'T00:00:00Z');
      const de = new Date(e+'T00:00:00Z');
      if (mode === 'daily') {
        for (let d = new Date(ds); d <= de; d.setUTCDate(d.getUTCDate()+1)) keys.push(d.toISOString().slice(0,10));
      } else if (mode === 'weekly') {
        const d = new Date(ds);
        const day = d.getUTCDay();
        const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day+6)%7));
        for (let wk = new Date(monday); wk <= de; wk.setUTCDate(wk.getUTCDate()+7)) keys.push(wk.toISOString().slice(0,10));
      } else {
        const mStart = new Date(Date.UTC(ds.getUTCFullYear(), ds.getUTCMonth(), 1));
        const mEnd = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1));
        for (let d = new Date(mStart); d <= mEnd; d.setUTCMonth(d.getUTCMonth()+1)) keys.push(d.toISOString().slice(0,10));
      }
      return keys;
    };
    const keys = buildKeys(interval, startISO!, endISO!);

    // (moved to deriveIGUsernamesForCampaign above)

    const aggInstagramSeries = async (handles: string[], startISO: string, endISO: string, interval: 'daily'|'weekly'|'monthly') => {
      if (!handles.length) return new Map<string, { views:number; likes:number; comments:number }>();
      const map = new Map<string, { views:number; likes:number; comments:number }>();
      const base = supa.from('instagram_posts_daily')
        .select('username, post_date, play_count, like_count, comment_count')
        .in('username', handles)
        .gte('post_date', startISO)
        .lte('post_date', endISO);
      const { data: rows } = await base;
      for (const r of rows||[]) {
        let key: string;
        const dStr = String((r as any).post_date);
        if (interval === 'monthly') {
          const d = new Date(dStr+'T00:00:00Z');
          key = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0,10);
        } else if (interval === 'weekly') {
          const d = new Date(dStr+'T00:00:00Z');
          const day = d.getUTCDay();
          const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day+6)%7));
          key = monday.toISOString().slice(0,10);
        } else {
          key = dStr;
        }
        const cur = map.get(key) || { views:0, likes:0, comments:0 };
        cur.views += Number((r as any).play_count)||0;
        cur.likes += Number((r as any).like_count)||0;
        cur.comments += Number((r as any).comment_count)||0;
        map.set(key, cur);
      }
      return map;
    };

    for (const camp of campaigns || []) {
      // TikTok series via RPC
      const { data: seriesRows } = await supa
        .rpc('campaign_series_v2', {
          campaign: camp.id,
          start_date: startISO,
          end_date: endISO,
          p_interval: interval,
        } as any);
      const ttRaw = (seriesRows || []).map((r:any)=>({
        date: String(r.bucket_date),
        views: Number(r.views)||0,
        likes: Number(r.likes)||0,
        comments: Number(r.comments)||0,
        shares: Number(r.shares)||0,
        saves: Number(r.saves)||0,
      }));
      const ttMap = new Map(ttRaw.map(s=>[s.date, s] as const));

      // Instagram series aggregated from instagram_posts_daily for this campaign
      const igHandles = await deriveIGUsernamesForCampaign(supa, camp.id);
      const igMap = await aggInstagramSeries(igHandles, startISO!, endISO!, interval);

      // zero-fill per date key and merge TT + IG
      const series = keys.map(k => {
        const tt = ttMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        const ig = igMap.get(k) || { views:0, likes:0, comments:0 };
        return {
          date: k,
          views: tt.views + ig.views,
          likes: tt.likes + ig.likes,
          comments: tt.comments + ig.comments,
          shares: tt.shares, // IG shares not tracked here
          saves: tt.saves,   // IG saves not tracked here
        };
      });
      // Platform-separated series for this campaign (for consistent UI legends)
      const series_tiktok = keys.map(k => {
        const tt = ttMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        return { date: k, views: tt.views, likes: tt.likes, comments: tt.comments, shares: tt.shares, saves: tt.saves };
      });
      const series_instagram = keys.map(k => {
        const ig = igMap.get(k) || { views:0, likes:0, comments:0 };
        return { date: k, views: ig.views, likes: ig.likes, comments: ig.comments } as any;
      });

      groups.push({ id: camp.id, name: camp.name || camp.id, series, series_tiktok, series_instagram });
      for (const s of series) {
        const cur = totalMap.get(s.date) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views += s.views; cur.likes += s.likes; cur.comments += s.comments; cur.shares += s.shares; cur.saves += s.saves;
        totalMap.set(s.date, cur);
      }
      // accumulate platform-separated totals
      for (const k of keys) {
        const tt = ttMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        const ig = igMap.get(k) || { views:0, likes:0, comments:0 };
        const ttCur = totalTTMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        ttCur.views += tt.views; ttCur.likes += tt.likes; ttCur.comments += tt.comments; ttCur.shares += tt.shares; ttCur.saves += tt.saves;
        totalTTMap.set(k, ttCur);
        const igCur = totalIGMap.get(k) || { views:0, likes:0, comments:0 };
        igCur.views += ig.views; igCur.likes += ig.likes; igCur.comments += ig.comments;
        totalIGMap.set(k, igCur);
      }
    }

    // Build total series with zero-fill to ensure full range
    const totalFilled = keys.map(k => {
      const v = totalMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      return { date: k, ...v };
    });
    const totalTT = keys.map(k => {
      const v = totalTTMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      return { date: k, ...v };
    });
    const totalIG = keys.map(k => {
      const v = totalIGMap.get(k) || { views:0, likes:0, comments:0 };
      return { date: k, views: v.views, likes: v.likes, comments: v.comments, shares: 0, saves: 0 };
    });

    // Totals summary computed from series for consistency with chart
    const totals = totalFilled.reduce((acc:any, s:any)=>({
      views: acc.views + (s.views||0),
      likes: acc.likes + (s.likes||0),
      comments: acc.comments + (s.comments||0),
      shares: acc.shares + (s.shares||0),
      saves: acc.saves + (s.saves||0),
    }), { views:0, likes:0, comments:0, shares:0, saves:0 });

    return NextResponse.json({ interval, start: startISO, end: endISO, groups, total: totalFilled, total_tiktok: totalTT, total_instagram: totalIG, totals });
  } catch (e:any) {
    // Tambahkan stack trace ke response agar error detail bisa dilihat
    return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
