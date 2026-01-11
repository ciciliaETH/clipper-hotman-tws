-- Add taken_at column to store actual video creation timestamp
-- For both Instagram and TikTok posts
-- Date: 2026-01-09

BEGIN;

-- Instagram: Add column to store the original taken_at timestamp
ALTER TABLE public.instagram_posts_daily 
  ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_taken_at 
  ON public.instagram_posts_daily(taken_at);

-- TikTok: Add column to store the original create_time timestamp  
ALTER TABLE public.tiktok_posts_daily 
  ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_taken_at 
  ON public.tiktok_posts_daily(taken_at);

COMMIT;
