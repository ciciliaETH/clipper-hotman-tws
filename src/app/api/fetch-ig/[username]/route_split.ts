import { NextResponse } from 'next/server';
import { createClient as createAdmin } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { rapidApiRequest } from '@/lib/rapidapi';
import { parseMs, resolveTimestamp, resolveCounts } from './helpers';
import { fetchAllProviders, fetchProfileData, fetchLinksData, IG_HOST, IG_SCRAPER_HOST } from './providers';
import { resolveUserIdViaLink, resolveUserId } from './resolvers';

export const dynamic = 'force-dynamic';

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

export async function GET(req: Request, context: any) {
  const { username } = await context.params as { username: string };
  if (!username) return NextResponse.json({ error: 'username required' }, { status: 400 });
  
  const norm = String(username).replace(/^@/, '').toLowerCase();
  const url = new URL(req.url);
  const cleanup = String(url.searchParams.get('cleanup')||'');
  const debug = url.searchParams.get('debug') === '1';
  const allowUsernameFallback = (process.env.FETCH_IG_ALLOW_USERNAME_FALLBACK === '1') || (url.searchParams.get('allow_username') === '1');

  const supa = admin();
  const upserts: any[] = [];
  let source = 'reels:user_id';
  // PATCH: Track aggregator totals for fallback dummy row
  let aggregatorTotals = { views: 0, likes: 0, comments: 0 };
  
  try {
    let userId = await resolveUserIdViaLink(norm, supa);
    let edges: any[] = [];

    if (!userId) {
      const infoEndpoints = [
        `https://${IG_HOST}/api/instagram/user?username=${encodeURIComponent(norm)}`,
        `https://${IG_HOST}/api/instagram/userinfo?username=${encodeURIComponent(norm)}`,
        `https://${IG_HOST}/api/instagram/username?username=${encodeURIComponent(norm)}`,
      ];
      for (const u of infoEndpoints) {
        try {
          const ij = await rapidApiRequest<any>({ url: u, method: 'GET', rapidApiHost: IG_HOST, timeoutMs: 15000 });
          const cand = ij?.result?.user || ij?.user || ij?.result || {};
          const pk = cand?.pk || cand?.id || cand?.pk_id || ij?.result?.pk || ij?.result?.id;
          if (pk) { userId = String(pk); break; }
        } catch {}
      }
    }

    if (userId) {
      try { 
        await supa.from('instagram_user_ids').upsert({ 
          instagram_username: norm, 
          instagram_user_id: String(userId), 
          created_at: new Date().toISOString() 
        }, { onConflict: 'instagram_username' }); 
      } catch {}

      const results = await fetchAllProviders(userId);
      // PATCH: If aggregator present, track totals
      const aggregatorResult = results.find(r => r.source === 'aggregator');
      if (aggregatorResult) {
        aggregatorTotals.views = Number(aggregatorResult.views || aggregatorResult.total_views || 0);
        aggregatorTotals.likes = Number(aggregatorResult.likes || aggregatorResult.total_likes || 0);
        aggregatorTotals.comments = Number(aggregatorResult.comments || aggregatorResult.total_comments || 0);
      }
      const scraperResult = results.find(r => r.source === 'scraper' && r.items.length > 0);
      const anySuccessful = results.find(r => r.items.length > 0);
      const bestResult = scraperResult || anySuccessful;
      
      if (bestResult && bestResult.items.length > 0) {
        if (bestResult.source === 'scraper') {
          for (const it of bestResult.items) {
            const id = String(it?.id || it?.code || ''); 
            if (!id) continue;
            
            const ms = parseMs(it?.taken_at) || parseMs(it?.device_timestamp) || parseMs(it?.taken_at_timestamp) || parseMs(it?.timestamp) || parseMs(it?.taken_at_ms) || parseMs(it?.created_at) || parseMs(it?.created_at_utc) || null;
            if (!ms) continue;
            
            const post_date = new Date(ms).toISOString().slice(0,10);
            let play = Number(it?.play_count ?? it?.ig_play_count ?? it?.view_count ?? it?.video_view_count ?? 0) || 0;
            let like = Number(it?.like_count ?? 0) || 0;
            let comment = Number(it?.comment_count ?? 0) || 0;
            
            if ((play + like + comment) === 0) {
              try {
                const cj = await rapidApiRequest<any>({ 
                  url: `https://${IG_HOST}/api/instagram/media_info?id=${encodeURIComponent(id)}`, 
                  method: 'GET', 
                  rapidApiHost: IG_HOST, 
                  timeoutMs: 15000,
                  maxPerKeyRetries: 2
                });
                const m = cj?.result?.items?.[0] || cj?.result?.media || cj?.result || cj?.item || cj;
                play = Number(m?.play_count || m?.view_count || m?.video_view_count || 0) || 0;
                like = Number(m?.like_count || m?.edge_liked_by?.count || 0) || 0;
                comment = Number(m?.comment_count || m?.edge_media_to_comment?.count || 0) || 0;
              } catch {}
            }
            
            upserts.push({ id, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
          }
          source = 'scraper:multi-retry';
        } else if (bestResult.source === 'best') {
          for (const it of bestResult.items) {
            const media = it;
            const code = String(media?.code || '');
            const pid = String(media?.id || media?.pk || code || ''); 
            if (!pid) continue;
            
            const ms = parseMs(media?.taken_at) || parseMs(media?.device_timestamp) || parseMs(media?.taken_at_timestamp) || parseMs(media?.timestamp) || null;
            if (!ms) continue;
            
            const post_date = new Date(ms).toISOString().slice(0,10);
            let play = Number(media?.play_count || media?.view_count || media?.video_view_count || 0) || 0;
            let like = Number(media?.like_count || 0) || 0;
            let comment = Number(media?.comment_count || 0) || 0;
            
            if ((play + like + comment) === 0) {
              const counts = await resolveCounts(media, { id: pid, code });
              if (counts) { play = counts.play; like = counts.like; comment = counts.comment; }
            }
            
            upserts.push({ id: pid, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
          }
          source = 'best:multi-retry';
        } else {
          edges = bestResult.items;
          source = `${bestResult.source}:multi-retry`;
        }
      }
    }

    if (allowUsernameFallback && upserts.length === 0) {
      const medias = await fetchProfileData(norm);
      for (const m of medias) {
        const id = String(m?.id || m?.shortcode || ''); 
        if (!id) continue;
        const ms = parseMs(m?.timestamp) || parseMs(m?.taken_at) || null; 
        if (!ms) continue;
        const post_date = new Date(ms).toISOString().slice(0,10);
        let play = Number(m?.video_views || m?.play_count || m?.view_count || m?.video_view_count || 0) || 0;
        let like = Number(m?.like || m?.like_count || 0) || 0;
        let comment = Number(m?.comment_count || 0) || 0;
        if ((play + like + comment) === 0) {
          const counts = await resolveCounts({ id, code: m?.shortcode }, { id, code: m?.shortcode });
          if (counts) { play = counts.play; like = counts.like; comment = counts.comment; }
        }
        if ((play + like + comment) === 0) continue;
        upserts.push({ id, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
      }
      if (upserts.length > 0) source = 'profile1:username';
    }

    if (!Array.isArray(edges)) edges = [];
    const linksMap = new Map<string, number>();
    
    const linksArr = await fetchLinksData(`https://www.instagram.com/${norm}/reels/`);
    for (const it of linksArr) {
      const sc = String(it?.shortcode || it?.meta?.shortcode || '');
      const ts = parseMs(it?.takenAt || it?.meta?.takenAt);
      if (sc && ts) linksMap.set(sc, ts);
    }
    
    const telemetry = { edges: 0, linkMatches: 0, detailResolves: 0, skippedNoTimestamp: 0, fallbackLinksUsed: 0 } as any;
    for (const e of edges) {
      const node = e?.node || e?.media || e;
      const media = node?.media || node;
      const id = String(media?.pk || media?.id || media?.code || '');
      if (!id) continue;
      telemetry.edges += 1;
      
      let ms = parseMs(media?.taken_at) || parseMs(media?.taken_at_ms) || parseMs(media?.device_timestamp) || parseMs(media?.timestamp) || parseMs(node?.taken_at) || parseMs(node?.caption?.created_at) || parseMs(node?.caption?.created_at_utc);
      
      if (!ms) {
        const code = String(media?.code || node?.code || '');
        if (code && linksMap.has(code)) { 
          ms = linksMap.get(code)!; 
          telemetry.linkMatches += 1; 
        }
        if (!ms) {
          ms = await resolveTimestamp(media, node);
          if (ms) telemetry.detailResolves += 1;
        }
        if (!ms) { 
          telemetry.skippedNoTimestamp += 1; 
          continue; 
        }
      }
      
      const d = new Date(ms!);
      const post_date = d.toISOString().slice(0,10);
      let play = Number(media?.play_count ?? media?.view_count ?? media?.video_view_count ?? 0) || 0;
      let like = Number(media?.like_count ?? media?.edge_liked_by?.count ?? 0) || 0;
      let comment = Number(media?.comment_count ?? media?.edge_media_to_comment?.count ?? 0) || 0;
      
      if ((play + like + comment) === 0) {
        const fixed = await resolveCounts(media, node);
        if (fixed) { 
          play = fixed.play; 
          like = fixed.like; 
          comment = fixed.comment; 
        }
      }
      if ((play + like + comment) === 0) continue;
      upserts.push({ id, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
    }

    if (allowUsernameFallback && upserts.length === 0 && linksMap.size > 0) {
      const urls = [
        `https://www.instagram.com/${norm}/reels/`,
        `https://www.instagram.com/${norm}/reels`,
        `https://www.instagram.com/${norm}/`
      ];
      let arr: any[] = [];
      for (const p of urls) {
        const tmp = await fetchLinksData(p);
        if (Array.isArray(tmp) && tmp.length) { 
          arr = tmp; 
          break; 
        }
      }
      for (const it of arr) {
        const sc = String(it?.shortcode || it?.meta?.shortcode || '');
        const ts = parseMs(it?.takenAt || it?.meta?.takenAt);
        if (!sc || !ts) continue;
        const post_date = new Date(ts).toISOString().slice(0,10);
        let views = Number(it?.playCount || it?.viewCount || 0) || 0;
        let likes = Number(it?.likeCount || 0) || 0;
        let comments = Number(it?.commentCount || 0) || 0;
        if ((views + likes + comments) === 0) {
          const counts = await resolveCounts({ code: sc }, { code: sc });
          if (counts) { 
            views = counts.play; 
            likes = counts.like; 
            comments = counts.comment; 
          }
        }
        if ((views + likes + comments) === 0) continue;
        upserts.push({ id: sc, username: norm, post_date, play_count: views, like_count: likes, comment_count: comments });
        telemetry.fallbackLinksUsed += 1;
      }
    }

    if (allowUsernameFallback && upserts.length === 0) {
      const urls = [`https://www.instagram.com/${norm}/`, `https://instagram.com/${norm}/`];
      let arr: any[] = [];
      for (const p of urls) {
        const tmp = await fetchLinksData(p);
        if (Array.isArray(tmp) && tmp.length) { 
          arr = tmp; 
          break; 
        }
      }
      for (const it of arr) {
        const sc = String(it?.shortcode || it?.meta?.shortcode || ''); 
        if (!sc) continue;
        let ms = parseMs(it?.takenAt || it?.meta?.takenAt) || null;
        
        if (!ms) {
          try {
            const info = await rapidApiRequest<any>({ 
              url: `https://${IG_HOST}/api/instagram/post_info?code=${encodeURIComponent(sc)}`, 
              method: 'GET', 
              rapidApiHost: IG_HOST, 
              timeoutMs: 15000 
            });
            const m = info?.result?.items?.[0] || info?.result?.media || info?.result || info?.item || info;
            ms = parseMs(m?.taken_at) || parseMs(m?.taken_at_ms) || null;
            const post_date = ms ? new Date(ms).toISOString().slice(0,10) : null;
            let views = Number(m?.play_count || m?.view_count || m?.video_view_count || 0) || 0;
            let likes = Number(m?.like_count || m?.edge_liked_by?.count || 0) || 0;
            let comments = Number(m?.comment_count || m?.edge_media_to_comment?.count || 0) || 0;
            if ((views + likes + comments) === 0) {
              const counts = await resolveCounts({ code: sc }, { code: sc });
              if (counts) { 
                views = counts.play; 
                likes = counts.like; 
                comments = counts.comment; 
              }
            }
            if (post_date && (views + likes + comments) > 0) {
              upserts.push({ 
                id: sc, 
                username: norm, 
                post_date, 
                play_count: views, 
                like_count: likes, 
                comment_count: comments 
              });
            }
          } catch {}
        } else {
          const post_date = new Date(ms).toISOString().slice(0,10);
          let views = Number(it?.playCount || it?.viewCount || 0) || 0;
          let likes = Number(it?.likeCount || 0) || 0;
          let comments = Number(it?.commentCount || 0) || 0;
          if ((views + likes + comments) === 0) {
            const counts = await resolveCounts({ code: sc }, { code: sc });
            if (counts) { 
              views = counts.play; 
              likes = counts.like; 
              comments = counts.comment; 
            }
          }
          if ((views + likes + comments) === 0) continue;
          upserts.push({ id: sc, username: norm, post_date, play_count: views, like_count: likes, comment_count: comments });
        }
      }
    }

    if (upserts.length === 0) {
      const userId2 = userId || await resolveUserId(norm, supa);
      if (userId2) {
        const sj = await rapidApiRequest<any>({ 
          url: `https://${IG_SCRAPER_HOST}/get_instagram_reels_details_from_id?user_id=${encodeURIComponent(userId2)}`, 
          method: 'GET', 
          rapidApiHost: IG_SCRAPER_HOST, 
          timeoutMs: 20000 
        });
        const reels: any[] = (sj?.data?.reels || sj?.reels || sj?.data?.items || sj?.items || []) as any[];
        for (const it of reels) {
          const id = String(it?.id || it?.code || ''); 
          if (!id) continue;
          const ms = parseMs(it?.taken_at) || parseMs(it?.device_timestamp) || null; 
          if (!ms) continue;
          const post_date = new Date(ms).toISOString().slice(0,10);
          let play = Number(it?.play_count ?? it?.ig_play_count ?? 0) || 0;
          let like = Number(it?.like_count ?? 0) || 0;
          let comment = Number(it?.comment_count ?? 0) || 0;
          if ((play + like + comment) === 0) {
            const counts = await resolveCounts({ id, code: it?.code }, { id, code: it?.code });
            if (counts) { 
              play = counts.play; 
              like = counts.like; 
              comment = counts.comment; 
            }
          }
          if ((play + like + comment) === 0) continue;
          upserts.push({ id, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
        }
        if (upserts.length > 0) source = 'scraper:user_id';
      }
    }

    if (upserts.length) {
      if (cleanup === 'today') {
        const today = new Date().toISOString().slice(0,10);
        try { 
          await supa.from('instagram_posts_daily').delete().eq('username', norm).eq('post_date', today); 
        } catch {}
      }
      const chunk = 500;
      for (let i=0; i<upserts.length; i+=chunk) {
        const part = upserts.slice(i, i+chunk);
        await supa.from('instagram_posts_daily').upsert(part, { onConflict: 'id' });
      }
    }

    // PATCH: If upserts is empty, use aggregatorTotals
    const totals = upserts.reduce((a, r)=>({
      views: a.views + (r.play_count || 0),
      likes: a.likes + (r.like_count || 0),
      comments: a.comments + (r.comment_count || 0),
      posts_total: a.posts_total + 1,
    }), { views: 0, likes: 0, comments: 0, posts_total: 0 });
    if (upserts.length === 0 && (aggregatorTotals.views > 0 || aggregatorTotals.likes > 0 || aggregatorTotals.comments > 0)) {
      totals.views = aggregatorTotals.views;
      totals.likes = aggregatorTotals.likes;
      totals.comments = aggregatorTotals.comments;
      const today = new Date().toISOString().slice(0,10);
      await supa.from('instagram_posts_daily').upsert([
        {
          id: `${norm}_force_${today}`,
          username: norm,
          post_date: today,
          play_count: totals.views,
          like_count: totals.likes,
          comment_count: totals.comments
        }
      ], { onConflict: 'id' });
    }

    const totals = upserts.reduce((a, r)=>({
      views: a.views + (r.play_count || 0),
      likes: a.likes + (r.like_count || 0),
      comments: a.comments + (r.comment_count || 0),
      posts_total: a.posts_total + 1,
    }), { views: 0, likes: 0, comments: 0, posts_total: 0 });
    // PATCH: If upserts is empty, use aggregatorTotals
    if (upserts.length === 0 && (aggregatorTotals.views > 0 || aggregatorTotals.likes > 0 || aggregatorTotals.comments > 0)) {
      totals.views = aggregatorTotals.views;
      totals.likes = aggregatorTotals.likes;
      totals.comments = aggregatorTotals.comments;
    }

    const allowCreateUser = (process.env.FETCH_IG_CREATE_USER === '1') || (url.searchParams.get('create') === '1');
    let ownerUserId: string | null = null;
    
    const { data: u1 } = await supa.from('users').select('id').eq('instagram_username', norm).maybeSingle();
    if (u1?.id) ownerUserId = u1.id;
    
    if (!ownerUserId) {
      const { data: u2 } = await supa.from('user_instagram_usernames').select('user_id').eq('instagram_username', norm).maybeSingle();
      if (u2?.user_id) ownerUserId = u2.user_id as string;
    }
    
    if (!ownerUserId) {
      const { data: emp } = await supa.from('employee_instagram_participants').select('employee_id').eq('instagram_username', norm).limit(1);
      if (emp && emp.length > 0 && emp[0].employee_id) ownerUserId = emp[0].employee_id as string;
    }
    
    if (!ownerUserId && allowCreateUser) {
      const newId = randomUUID();
      // CRITICAL: Only set instagram_username, do NOT overwrite username field
      // username field should remain NULL for auto-created accounts
      const { error: upErr } = await supa.from('users').upsert({ 
        id: newId, 
        email: `${norm}@example.com`, 
        role: 'umum', 
        instagram_username: norm 
      }, { onConflict: 'id' });
      if (!upErr) ownerUserId = newId;
    }

    let metricsInserted = false;
    let metricsError: string | null = null;
    let aggregatedMetrics: any = null;
    
    if (ownerUserId) {
      try {
        const handles = new Set<string>();
        handles.add(norm);
        
        const { data: u1 } = await supa.from('users').select('instagram_username').eq('id', ownerUserId).maybeSingle();
        if (u1?.instagram_username) handles.add(String(u1.instagram_username).replace(/^@/, '').toLowerCase());
        
        const { data: u2 } = await supa.from('user_instagram_usernames').select('instagram_username').eq('user_id', ownerUserId);
        for (const r of u2||[]) handles.add(String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
        
        const { data: u3 } = await supa.from('employee_instagram_participants').select('instagram_username').eq('employee_id', ownerUserId);
        for (const r of u3||[]) handles.add(String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
        
        if (handles.size > 0) {
          const all = Array.from(handles);
          const winDays = 60;
          const start = new Date();
          start.setUTCDate(start.getUTCDate()-winDays+1);
          const startISO = start.toISOString().slice(0,10);
          
          const { data: rows } = await supa
            .from('instagram_posts_daily')
            .select('play_count, like_count, comment_count, username, post_date')
            .in('username', all)
            .gte('post_date', startISO);
            
          const agg = (rows||[]).reduce((a:any,r:any)=>({
            views: a.views + (Number(r.play_count)||0),
            likes: a.likes + (Number(r.like_count)||0),
            comments: a.comments + (Number(r.comment_count)||0),
          }), { views:0, likes:0, comments:0 });
          
          aggregatedMetrics = { ...agg, handles: all, postsCount: rows?.length || 0 };
          const nowIso = new Date().toISOString();
          
          await supa.from('social_metrics').upsert({
            user_id: ownerUserId,
            platform: 'instagram',
            followers: 0,
            likes: agg.likes,
            views: agg.views,
            comments: agg.comments,
            shares: 0,
            saves: 0,
            last_updated: nowIso,
          }, { onConflict: 'user_id,platform' });
          
          await supa.from('social_metrics_history').insert({
            user_id: ownerUserId,
            platform: 'instagram',
            followers: 0,
            likes: agg.likes,
            views: agg.views,
            comments: agg.comments,
            shares: 0,
            saves: 0,
            captured_at: nowIso,
          });
          
          metricsInserted = true;
        }
      } catch (e) {
        metricsError = (e as any)?.message || String(e);
        console.warn('[fetch-ig] social_metrics upsert failed:', metricsError);
      }
    }

    return NextResponse.json({ 
      instagram: totals, 
      inserted: upserts.length, 
      user_id: userId, 
      owner_user_id: ownerUserId,
      metrics_inserted: metricsInserted,
      metrics_error: metricsError,
      aggregated: debug ? aggregatedMetrics : undefined,
      source, 
      telemetry: debug ? telemetry : undefined 
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
