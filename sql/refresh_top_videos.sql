-- Function: refresh_top_videos
-- This function will refresh the top_videos table for both Instagram and TikTok
CREATE OR REPLACE FUNCTION refresh_top_videos()
RETURNS void AS $$
BEGIN
  -- Instagram: Insert or update top videos by play_count in the last 30 days
  INSERT INTO top_videos (platform, video_id, username, owner_name, owner_id, post_date, link, play_count, like_count, comment_count, share_count, save_count, total_engagement, taken_at, created_at, updated_at)
  SELECT 'instagram', id, username, NULL, NULL, post_date, CONCAT('https://www.instagram.com/reel/', code), play_count, like_count, comment_count, 0, 0, (like_count + comment_count), taken_at, NOW(), NOW()
  FROM instagram_posts_daily
  WHERE (taken_at >= NOW() - INTERVAL '30 days' OR (taken_at IS NULL AND post_date >= NOW()::date - INTERVAL '30 days'))
  AND play_count IS NOT NULL
  AND play_count = (
    SELECT MAX(play_count) FROM instagram_posts_daily p2 WHERE p2.id = instagram_posts_daily.id
  )
  ON CONFLICT (platform, video_id) DO UPDATE SET
    play_count = EXCLUDED.play_count,
    like_count = EXCLUDED.like_count,
    comment_count = EXCLUDED.comment_count,
    total_engagement = EXCLUDED.total_engagement,
    taken_at = EXCLUDED.taken_at,
    updated_at = NOW();

  -- TikTok: Insert or update top videos by play_count in the last 30 days
  INSERT INTO top_videos (platform, video_id, username, owner_name, owner_id, post_date, link, play_count, like_count, comment_count, share_count, save_count, total_engagement, taken_at, created_at, updated_at)
  SELECT 'tiktok', video_id, username, NULL, NULL, post_date, CONCAT('https://www.tiktok.com/@', username, '/video/', video_id), play_count, digg_count, comment_count, share_count, save_count, (digg_count + comment_count + share_count + save_count), taken_at, NOW(), NOW()
  FROM tiktok_posts_daily
  WHERE (taken_at >= NOW() - INTERVAL '30 days' OR (taken_at IS NULL AND post_date >= NOW()::date - INTERVAL '30 days'))
  AND play_count IS NOT NULL
  AND play_count = (
    SELECT MAX(play_count) FROM tiktok_posts_daily t2 WHERE t2.video_id = tiktok_posts_daily.video_id
  )
  ON CONFLICT (platform, video_id) DO UPDATE SET
    play_count = EXCLUDED.play_count,
    like_count = EXCLUDED.like_count,
    comment_count = EXCLUDED.comment_count,
    share_count = EXCLUDED.share_count,
    save_count = EXCLUDED.save_count,
    total_engagement = EXCLUDED.total_engagement,
    taken_at = EXCLUDED.taken_at,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;