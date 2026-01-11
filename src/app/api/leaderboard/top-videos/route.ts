import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { hasRequiredHashtag } from '@/lib/hashtag-filter'

export const dynamic = 'force-dynamic'
export const maxDuration = 60; // 60 seconds to stay safe

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const campaignId = url.searchParams.get('campaign_id') || ''
    const platform = (url.searchParams.get('platform') || 'all').toLowerCase() // all, tiktok, instagram
    const daysParam = Number(url.searchParams.get('days') || '30')
    const mode = (url.searchParams.get('mode') || '').toLowerCase() // '' | 'calendar'
    // Allow any days value between 1 and 365 (default 30)
    const windowDays = Math.max(1, Math.min(365, daysParam))
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || '10')))

    const supabase = supabaseAdmin()
    
    // If campaign_id is missing, we aggregate across ALL campaigns (all employees)
    let requiredHashtags: string[] | null = null
    let employeeIds: string[] = []
    if (!campaignId) {
      // All employees (role=karyawan)
      const { data: emps } = await supabase
        .from('users')
        .select('id')
        .eq('role','karyawan')
      employeeIds = (emps||[]).map((r:any)=> String(r.id))
    } else {
      // Get campaign info including required hashtags
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('id, name, required_hashtags')
        .eq('id', campaignId)
        .single()
      requiredHashtags = (campaign as any)?.required_hashtags || null
    }
    
    // Calculate date window
    const now = new Date()
    let endISO = now.toISOString().slice(0, 10)
    let startISO: string
    if (mode === 'calendar') {
      // Start at first day of current month (UTC)
      const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      startISO = s.toISOString().slice(0, 10)
    } else {
      const startDate = new Date()
      startDate.setUTCDate(startDate.getUTCDate() - (windowDays - 1))
      startISO = startDate.toISOString().slice(0, 10)
    }

    // Collect employees according to campaign scope
    if (campaignId) {
      const { data: employees } = await supabase
        .from('employee_groups')
        .select('employee_id')
        .eq('campaign_id', campaignId)
      console.log(`[Top Videos] Campaign ${campaignId}: Found ${employees?.length || 0} employees`)
      if (!employees || employees.length === 0) {
        return NextResponse.json({ 
          videos: [], 
          campaign_id: campaignId,
          required_hashtags: requiredHashtags,
          platform, 
          start: startISO, 
          end: endISO, 
          days: windowDays,
          debug: { employees_count: 0, reason: 'No employees in campaign' }
        })
      }
      employeeIds = employees.map((e: any) => e.employee_id)
    }

    // Get usernames mapping
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, username, tiktok_username, instagram_username')
      .in('id', employeeIds)
    
    const userMap = new Map<string, any>()
    for (const u of users || []) {
      userMap.set(u.id, {
        name: u.full_name || u.username || u.tiktok_username || u.instagram_username || u.id,
        tiktok_username: u.tiktok_username,
        instagram_username: u.instagram_username
      })
    }

    const videos: any[] = []

    // === TIKTOK VIDEOS ===
    if (platform === 'all' || platform === 'tiktok') {
      // Get TikTok usernames for employees
      const tiktokUsernames = Array.from(new Set(
        (users || [])
          .map((u: any) => u.tiktok_username)
          .filter(Boolean)
          .map((u: string) => u.toLowerCase().replace(/^@+/, ''))
      ))

      console.log(`[Top Videos] TikTok: ${tiktokUsernames.length} usernames to query: ${tiktokUsernames.slice(0, 5).join(', ')}${tiktokUsernames.length > 5 ? '...' : ''}`)
      
      if (tiktokUsernames.length > 0) {
        // Query only snapshots whose taken_at falls in window; fallback to post_date if taken_at is NULL
        const orFilter = `and(taken_at.gte.${startISO}T00:00:00Z,taken_at.lte.${endISO}T23:59:59Z),and(taken_at.is.null,post_date.gte.${startISO},post_date.lte.${endISO})`
        const { data: tiktokPosts } = await supabase
          .from('tiktok_posts_daily')
          .select('video_id, username, post_date, taken_at, title, play_count, digg_count, comment_count, share_count, save_count')
          .in('username', tiktokUsernames)
          .or(orFilter)
          .order('play_count', { ascending: false })
          .limit(limit * 200)

        const startTs = new Date(startISO + 'T00:00:00Z').getTime()
        const endTs = new Date(endISO + 'T23:59:59Z').getTime()
        const videoMap = new Map<string, any[]>()
        for (const post of (tiktokPosts || [])) {
          const vid = String(post.video_id)
          if (!videoMap.has(vid)) videoMap.set(vid, [])
          videoMap.get(vid)!.push(post)
        }

        console.log(`[Top Videos] TikTok: Found ${tiktokPosts?.length || 0} total posts, groups=${videoMap.size} window ${startISO}..${endISO}`)

        // Calculate accrual for each video within window
        for (const [videoId, snapshots] of videoMap.entries()) {
          // Sort by date
          snapshots.sort((a, b) => (a.post_date || '').localeCompare(b.post_date || ''))
          
          const first = snapshots[0]
          const last = snapshots[snapshots.length - 1]

          // Determine actual upload date from earliest taken_at across the group
          let takenAtGroup: string | null = null
          for (const s of snapshots) {
            if (s.taken_at) {
              const iso = new Date(s.taken_at).toISOString().slice(0, 10)
              if (!takenAtGroup || iso < takenAtGroup) takenAtGroup = iso
            }
          }
          const actualPostDate = takenAtGroup || snapshots.reduce((min: string, s: any) => {
            return !min || (s.post_date || '') < min ? (s.post_date || min) : min
          }, first.post_date)

          // Strict: require taken_at inside window if available
          const anyTakenInWindow = snapshots.some((s) => s.taken_at && (new Date(s.taken_at).getTime() >= startTs && new Date(s.taken_at).getTime() <= endTs))
          if (!anyTakenInWindow) continue

          // Use only window snapshots to compute accrual within the selected days window
          const windowSnapshots = snapshots.filter((s) => {
            const ts = new Date((s.post_date || actualPostDate) + 'T12:00:00Z').getTime()
            return ts >= startTs && ts <= endTs
          })
          const firstW = windowSnapshots[0] || first
          const lastW = windowSnapshots[windowSnapshots.length - 1] || last
          
          // Filter by hashtag if required
          if (!hasRequiredHashtag(lastW.title, requiredHashtags)) {
            continue;
          }
          
          // Accrual = final - initial (or use final if only one snapshot)
          const isSingle = windowSnapshots.length <= 1
          const views = isSingle 
            ? Number(lastW.play_count || 0)
            : Math.max(0, Number(lastW.play_count || 0) - Number(firstW.play_count || 0))
          const likes = isSingle
            ? Number(lastW.digg_count || 0)
            : Math.max(0, Number(lastW.digg_count || 0) - Number(firstW.digg_count || 0))
          const comments = isSingle
            ? Number(lastW.comment_count || 0)
            : Math.max(0, Number(lastW.comment_count || 0) - Number(firstW.comment_count || 0))
          const shares = isSingle
            ? Number(lastW.share_count || 0)
            : Math.max(0, Number(lastW.share_count || 0) - Number(firstW.share_count || 0))
          const saves = isSingle
            ? Number(lastW.save_count || 0)
            : Math.max(0, Number(lastW.save_count || 0) - Number(firstW.save_count || 0))

          // Find owner user
          let ownerName = last.username
          let ownerId = null
          for (const [uid, info] of userMap.entries()) {
            if (info.tiktok_username?.toLowerCase().replace(/^@+/, '') === last.username.toLowerCase()) {
              ownerName = info.name
              ownerId = uid
              break
            }
          }

          // post_date returned to client uses actual upload date computed above

          videos.push({
            platform: 'tiktok',
            video_id: videoId,
            username: last.username,
            owner_name: ownerName,
            owner_id: ownerId,
            post_date: actualPostDate, // Use actual upload date
            link: `https://www.tiktok.com/@${last.username}/video/${videoId}`,
            metrics: {
              views,
              likes,
              comments,
              shares,
              saves,
              total_engagement: likes + comments + shares + saves
            },
            snapshots_count: snapshots.length
          });
        }
      }
    }

    // === INSTAGRAM VIDEOS ===
    if (platform === 'all' || platform === 'instagram') {
      // Get Instagram usernames for employees
      const instagramUsernames = Array.from(new Set(
        (users || [])
          .map((u: any) => u.instagram_username)
          .filter(Boolean)
          .map((u: string) => u.toLowerCase().replace(/^@+/, ''))
      ))

      // Also get from employee_instagram_participants
      const { data: igParticipants } = await supabase
        .from('employee_instagram_participants')
        .select('instagram_username')
        .in('employee_id', employeeIds)
      
      for (const p of igParticipants || []) {
        if (p.instagram_username) {
          instagramUsernames.push(p.instagram_username.toLowerCase().replace(/^@+/, ''))
        }
      }
      const uniqueIgUsernames = Array.from(new Set(instagramUsernames))

      console.log(`[Top Videos] Instagram: ${uniqueIgUsernames.length} usernames to query: ${uniqueIgUsernames.slice(0, 5).join(', ')}${uniqueIgUsernames.length > 5 ? '...' : ''}`)

      if (uniqueIgUsernames.length > 0) {
        // Query only snapshots whose taken_at falls in window; fallback to post_date if taken_at is NULL
        const orFilter = `and(taken_at.gte.${startISO}T00:00:00Z,taken_at.lte.${endISO}T23:59:59Z),and(taken_at.is.null,post_date.gte.${startISO},post_date.lte.${endISO})`
        const { data: igPosts } = await supabase
          .from('instagram_posts_daily')
          .select('id, code, username, post_date, taken_at, caption, play_count, like_count, comment_count')
          .in('username', uniqueIgUsernames)
          .or(orFilter)
          .order('play_count', { ascending: false })
          .limit(limit * 200)

        const startTs = new Date(startISO + 'T00:00:00Z').getTime()
        const endTs = new Date(endISO + 'T23:59:59Z').getTime()
        const videoMap = new Map<string, any[]>()
        for (const post of (igPosts || [])) {
          const vid = String(post.id)
          if (!videoMap.has(vid)) videoMap.set(vid, [])
          videoMap.get(vid)!.push(post)
        }

        console.log(`[Top Videos] Instagram: Found ${igPosts?.length || 0} total posts, groups=${videoMap.size} window ${startISO}..${endISO}`)

        // Calculate accrual for each post within window
        for (const [postId, snapshots] of videoMap.entries()) {
          snapshots.sort((a, b) => (a.post_date || '').localeCompare(b.post_date || ''))
          
          const first = snapshots[0]
          const last = snapshots[snapshots.length - 1]

          // Determine actual upload date from earliest taken_at across the group
          let takenAtGroup: string | null = null
          for (const s of snapshots) {
            if (s.taken_at) {
              const iso = new Date(s.taken_at).toISOString().slice(0, 10)
              if (!takenAtGroup || iso < takenAtGroup) takenAtGroup = iso
            }
          }
          const actualPostDate = takenAtGroup || snapshots.reduce((min: string, s: any) => {
            return !min || (s.post_date || '') < min ? (s.post_date || min) : min
          }, first.post_date)

          // Strict: require taken_at inside window if available
          const anyTakenInWindow = snapshots.some((s) => s.taken_at && (new Date(s.taken_at).getTime() >= startTs && new Date(s.taken_at).getTime() <= endTs))
          if (!anyTakenInWindow) continue

          // Use only window snapshots to compute accrual within the selected days window
          const windowSnapshots = snapshots.filter((s) => {
            const ts = new Date((s.post_date || actualPostDate) + 'T12:00:00Z').getTime()
            return ts >= startTs && ts <= endTs
          })
          const firstW = windowSnapshots[0] || first
          const lastW = windowSnapshots[windowSnapshots.length - 1] || last
          
          // Filter by hashtag if required
          if (!hasRequiredHashtag(lastW.caption, requiredHashtags)) {
            continue;
          }
          
          const isSingle = windowSnapshots.length <= 1
          const views = isSingle
            ? Number(lastW.play_count || 0)
            : Math.max(0, Number(lastW.play_count || 0) - Number(firstW.play_count || 0))
          const likes = isSingle
            ? Number(lastW.like_count || 0)
            : Math.max(0, Number(lastW.like_count || 0) - Number(firstW.like_count || 0))
          const comments = isSingle
            ? Number(lastW.comment_count || 0)
            : Math.max(0, Number(lastW.comment_count || 0) - Number(firstW.comment_count || 0))

          // Find owner user
          let ownerName = last.username
          let ownerId = null
          for (const [uid, info] of userMap.entries()) {
            if (info.instagram_username?.toLowerCase().replace(/^@+/, '') === last.username.toLowerCase()) {
              ownerName = info.name
              ownerId = uid
              break
            }
          }

          videos.push({
            platform: 'instagram',
            video_id: postId,
            username: last.username,
            owner_name: ownerName,
            owner_id: ownerId,
            post_date: actualPostDate, // Use actual upload date
            link: `https://www.instagram.com/reel/${last.code || postId}/`,
            metrics: {
              views,
              likes,
              comments,
              shares: 0,
              saves: 0,
              total_engagement: likes + comments
            }
          });
        }
      }
    }

    // Sort by views descending and limit
    videos.sort((a, b) => b.metrics.views - a.metrics.views);
    const topVideos = videos.slice(0, limit);

    console.log(`[Top Videos] Final: ${videos.length} total videos (TikTok + Instagram), showing top ${topVideos.length}`)
    if (topVideos.length > 0) {
      console.log(`[Top Videos] Top video: ${topVideos[0].platform} @${topVideos[0].username} - ${topVideos[0].metrics.views} views`)
    }

    // === CALCULATE ACTUAL TOTAL POSTS FROM post_date (accurate count) ===
    // Query unique video_id/id based on post_date in range (not taken_at/snapshots)
    let actualTotalPosts = 0;
    
    // Get TikTok usernames from users table
    const tiktokUsernamesForCount = Array.from(new Set(
      (users || [])
        .map((u: any) => u.tiktok_username)
        .filter(Boolean)
        .map((u: string) => u.toLowerCase().replace(/^@+/, ''))
    ));
    
    // Also add TikTok usernames from employee_participants
    if (employeeIds.length > 0) {
      const { data: ttParticipantsAll } = await supabase
        .from('employee_participants')
        .select('tiktok_username')
        .in('employee_id', employeeIds);
      for (const p of ttParticipantsAll || []) {
        if ((p as any).tiktok_username) {
          tiktokUsernamesForCount.push((p as any).tiktok_username.toLowerCase().replace(/^@+/, ''));
        }
      }
    }
    const uniqueTTUsernamesAll = Array.from(new Set(tiktokUsernamesForCount));
    
    // Get Instagram usernames from users table
    const instagramUsernamesForCount = Array.from(new Set(
      (users || [])
        .map((u: any) => u.instagram_username)
        .filter(Boolean)
        .map((u: string) => u.toLowerCase().replace(/^@+/, ''))
    ));
    
    // Also add from employee_instagram_participants
    if (employeeIds.length > 0) {
      const { data: igParticipantsAll } = await supabase
        .from('employee_instagram_participants')
        .select('instagram_username')
        .in('employee_id', employeeIds);
      for (const p of igParticipantsAll || []) {
        if (p.instagram_username) {
          instagramUsernamesForCount.push(p.instagram_username.toLowerCase().replace(/^@+/, ''));
        }
      }
    }
    const uniqueIgUsernamesAll = Array.from(new Set(instagramUsernamesForCount));
    
    // Count unique TikTok videos by post_date
    if ((platform === 'all' || platform === 'tiktok') && uniqueTTUsernamesAll.length > 0) {
      const { data: ttUnique } = await supabase
        .from('tiktok_posts_daily')
        .select('video_id, username, post_date, title')
        .in('username', uniqueTTUsernamesAll)
        .gte('post_date', startISO)
        .lte('post_date', endISO);
      
      // Get unique video_ids with hashtag filter
      const uniqueTTVideos = new Set<string>();
      for (const row of ttUnique || []) {
        if (requiredHashtags && requiredHashtags.length > 0) {
          if (!hasRequiredHashtag(row.title, requiredHashtags)) continue;
        }
        uniqueTTVideos.add(row.video_id);
      }
      actualTotalPosts += uniqueTTVideos.size;
    }
    
    // Count unique Instagram posts by post_date
    if ((platform === 'all' || platform === 'instagram') && uniqueIgUsernamesAll.length > 0) {
      const { data: igUnique } = await supabase
        .from('instagram_posts_daily')
        .select('id, username, post_date, caption')
        .in('username', uniqueIgUsernamesAll)
        .gte('post_date', startISO)
        .lte('post_date', endISO);
      
      // Get unique ids with hashtag filter
      const uniqueIGPosts = new Set<string>();
      for (const row of igUnique || []) {
        if (requiredHashtags && requiredHashtags.length > 0) {
          if (!hasRequiredHashtag((row as any).caption, requiredHashtags)) continue;
        }
        uniqueIGPosts.add(String((row as any).id));
      }
      actualTotalPosts += uniqueIGPosts.size;
    }

    console.log(`[Top Videos] Actual Total Posts (by post_date): ${actualTotalPosts} (TT usernames: ${uniqueTTUsernamesAll.length}, IG usernames: ${uniqueIgUsernamesAll.length})`)

    return NextResponse.json({
      videos: topVideos,
      campaign_id: campaignId || null,
      required_hashtags: requiredHashtags,
      platform,
      start: startISO,
      end: endISO,
      days: windowDays,
      mode,
      total_found: actualTotalPosts,
      showing: topVideos.length,
      filtered_by_hashtag: requiredHashtags && requiredHashtags.length > 0
    });
  } catch (e: any) {
    console.error('[top-videos] error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
