-- Bootstrap all schema for Clipper Dashboard (TikTok + Instagram)
-- Run this once on a fresh Supabase/Postgres project (SQL Editor)
-- Recommended role: postgres (to allow extensions and policies)

-- ============================
-- 0) Extensions (safe to run)
-- ============================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_net;         -- used by cron/HTTP
CREATE EXTENSION IF NOT EXISTS pg_cron;        -- only if you plan to use cron scripts

-- =====================================================================================
-- The following blocks are a concatenation of migration files in chronological order.
-- Each block manages its own transaction (BEGIN/COMMIT) and is idempotent when possible.
-- =====================================================================================

-- Bootstrap base users table (app-level users), required by later migrations
-- Supabase auth users live in auth.users; this is an application profile table.
BEGIN;
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  username TEXT,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'umum',
  tiktok_username TEXT,
  tiktok_sec_uid TEXT,
  instagram_username TEXT,
  profile_picture_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMIT;

-- Ensure required profile columns exist on existing installations
BEGIN;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;
COMMIT;

-- Bootstrap base social_metrics table (required before ALTER and policies)
BEGIN;
CREATE TABLE IF NOT EXISTS public.social_metrics (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  followers INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMIT;

-- 2025-10-23_tiktok_only.sql
-- Clipper Dashboard Migration: TikTok-only focus
-- Date: 2025-10-23

BEGIN;

-- 1) USERS: ensure TikTok username column exists, remove unused columns
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tiktok_username TEXT;

-- Drop unused columns if they exist (safe to keep if you prefer)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'instagram_username'
  ) THEN
    ALTER TABLE public.users DROP COLUMN instagram_username;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'youtube_username'
  ) THEN
    ALTER TABLE public.users DROP COLUMN youtube_username;
  END IF;
END $$;

-- 2) SOCIAL_METRICS: align columns and constraints for TikTok-only
ALTER TABLE public.social_metrics
  ADD COLUMN IF NOT EXISTS followers INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ;

-- Ensure unique key for upsert on (user_id, platform)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' AND indexname = 'idx_social_metrics_user_platform'
  ) THEN
    CREATE UNIQUE INDEX idx_social_metrics_user_platform 
      ON public.social_metrics (user_id, platform);
  END IF;
END $$;

-- Constrain platform to TikTok only
-- Try dropping common constraint names if they exist, then add a new one
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_schema='public' AND table_name='social_metrics' AND constraint_name='social_metrics_platform_check'
  ) THEN
    ALTER TABLE public.social_metrics DROP CONSTRAINT social_metrics_platform_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_schema='public' AND table_name='social_metrics' AND constraint_name='social_metrics_platform_ck'
  ) THEN
    ALTER TABLE public.social_metrics DROP CONSTRAINT social_metrics_platform_ck;
  END IF;
  -- Add new check constraint (skip if already exists)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'social_metrics_platform_tiktok_chk'
  ) THEN
    ALTER TABLE public.social_metrics 
      ADD CONSTRAINT social_metrics_platform_tiktok_chk CHECK (platform = 'tiktok');
  END IF;
END $$;

-- 3) TIKTOK_POSTS_DAILY: create table for daily post aggregates
CREATE TABLE IF NOT EXISTS public.tiktok_posts_daily (
  video_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  sec_uid TEXT,
  post_date DATE NOT NULL,
  comment_count INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  digg_count INTEGER DEFAULT 0,
  save_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for faster campaign aggregations
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_username ON public.tiktok_posts_daily(username);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_post_date ON public.tiktok_posts_daily(post_date);

-- 4) RLS policies updates for social_metrics
-- Allow users to update their own metrics
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='social_metrics' AND policyname='Users can update own metrics'
  ) THEN
    CREATE POLICY "Users can update own metrics" ON public.social_metrics FOR UPDATE
      USING (user_id = auth.uid());
  END IF;
END $$;

-- Allow admins to insert/update all metrics (for admin fetching others' data)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='social_metrics' AND policyname='Admin can insert all metrics'
  ) THEN
    CREATE POLICY "Admin can insert all metrics" ON public.social_metrics FOR INSERT
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='social_metrics' AND policyname='Admin can update all metrics'
  ) THEN
    CREATE POLICY "Admin can update all metrics" ON public.social_metrics FOR UPDATE
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

-- 5) RPC: get_user_profile
-- Drop first to avoid return type mismatch errors if it already exists
DROP FUNCTION IF EXISTS public.get_user_profile();

CREATE OR REPLACE FUNCTION public.get_user_profile()
RETURNS public.users
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM public.users WHERE id = auth.uid();
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.get_user_profile() TO authenticated;

COMMIT;

-- 2025-10-23_campaigns.sql
BEGIN;

-- Campaigns table
CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Campaign participants (supports internal user or external by username)
CREATE TABLE IF NOT EXISTS public.campaign_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  tiktok_username TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_participants_campaign ON public.campaign_participants(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_participants_username ON public.campaign_participants(tiktok_username);

-- RLS: enable if you want anon access to be restricted
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_participants ENABLE ROW LEVEL SECURITY;

-- Admin can manage all
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage campaigns' AND tablename='campaigns') THEN
    CREATE POLICY "Admin manage campaigns" ON public.campaigns FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage campaign_participants' AND tablename='campaign_participants') THEN
    CREATE POLICY "Admin manage campaign_participants" ON public.campaign_participants FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

COMMIT;

-- 2025-10-23_campaign_metrics_fn.sql
BEGIN;

-- Series aggregation by interval
CREATE OR REPLACE FUNCTION public.campaign_series(
  campaign UUID,
  start_date DATE,
  end_date DATE,
  p_interval TEXT DEFAULT 'daily'
)
RETURNS TABLE(
  bucket_date DATE,
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  saves BIGINT
)
LANGUAGE sql
STABLE
AS $$
WITH usernames AS (
  SELECT LOWER(tiktok_username) AS username
  FROM public.campaign_participants
  WHERE campaign_id = campaign
), posts AS (
  SELECT p.post_date::date AS d,
         p.play_count::bigint AS views,
         p.digg_count::bigint AS likes,
         p.comment_count::bigint AS comments,
         p.share_count::bigint AS shares,
         p.save_count::bigint AS saves
  FROM public.tiktok_posts_daily p
  JOIN usernames u ON u.username = p.username
  WHERE p.post_date BETWEEN start_date AND end_date
)
SELECT
  CASE
    WHEN p_interval = 'weekly' THEN date_trunc('week', d)::date
    WHEN p_interval = 'monthly' THEN date_trunc('month', d)::date
    ELSE d
  END AS bucket_date,
  SUM(views) AS views,
  SUM(likes) AS likes,
  SUM(comments) AS comments,
  SUM(shares) AS shares,
  SUM(saves) AS saves
FROM posts
GROUP BY 1
ORDER BY 1;
$$;

-- Participant totals ranking
CREATE OR REPLACE FUNCTION public.campaign_participant_totals(
  campaign UUID,
  start_date DATE,
  end_date DATE
)
RETURNS TABLE(
  username TEXT,
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  saves BIGINT
)
LANGUAGE sql
STABLE
AS $$
SELECT p.username,
       SUM(p.play_count)::bigint AS views,
       SUM(p.digg_count)::bigint AS likes,
       SUM(p.comment_count)::bigint AS comments,
       SUM(p.share_count)::bigint AS shares,
       SUM(p.save_count)::bigint AS saves
FROM public.tiktok_posts_daily p
JOIN public.campaign_participants cp ON LOWER(cp.tiktok_username) = p.username
WHERE cp.campaign_id = campaign
  AND p.post_date BETWEEN start_date AND end_date
GROUP BY p.username
ORDER BY views DESC;
$$;

GRANT EXECUTE ON FUNCTION public.campaign_series(UUID, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_participant_totals(UUID, DATE, DATE) TO authenticated;

COMMIT;

-- 2025-10-24_employee_accounts.sql
BEGIN;

-- Mapping table: which employee handles which umum-account
CREATE TABLE IF NOT EXISTS public.employee_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  account_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_accounts_pair ON public.employee_accounts(employee_id, account_user_id);

ALTER TABLE public.employee_accounts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage employee_accounts' AND tablename='employee_accounts') THEN
    CREATE POLICY "Admin manage employee_accounts" ON public.employee_accounts FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

-- Helper aggregation for a list of usernames within a date range
CREATE OR REPLACE FUNCTION public.user_totals_in_range(
  usernames TEXT[],
  start_date DATE,
  end_date DATE
)
RETURNS TABLE(
  username TEXT,
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  saves BIGINT
)
LANGUAGE sql
STABLE
AS $$
SELECT p.username,
       SUM(p.play_count)::bigint AS views,
       SUM(p.digg_count)::bigint AS likes,
       SUM(p.comment_count)::bigint AS comments,
       SUM(p.share_count)::bigint AS shares,
       SUM(p.save_count)::bigint AS saves
FROM public.tiktok_posts_daily p
WHERE p.username = ANY (usernames)
  AND p.post_date BETWEEN start_date AND end_date
GROUP BY p.username
ORDER BY views DESC;
$$;

GRANT EXECUTE ON FUNCTION public.user_totals_in_range(TEXT[], DATE, DATE) TO authenticated;

COMMIT;

-- 2025-10-24_ensure_tiktok_posts_daily_schema.sql
BEGIN;

-- 1) Create table if missing
CREATE TABLE IF NOT EXISTS public.tiktok_posts_daily (
  video_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  sec_uid TEXT,
  post_date DATE NOT NULL,
  comment_count INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  digg_count INTEGER DEFAULT 0,
  save_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Ensure columns exist (idempotent)
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS sec_uid TEXT;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS post_date DATE;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS comment_count INTEGER DEFAULT 0;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS play_count INTEGER DEFAULT 0;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS share_count INTEGER DEFAULT 0;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS digg_count INTEGER DEFAULT 0;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS save_count INTEGER DEFAULT 0;
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.tiktok_posts_daily ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 3) Ensure PK on video_id exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tiktok_posts_daily'::regclass
      AND contype = 'p'
  ) THEN
    -- Drop duplicate video_id if any before setting PK (optional, skip for safety)
    ALTER TABLE public.tiktok_posts_daily ADD CONSTRAINT tiktok_posts_daily_pkey PRIMARY KEY (video_id);
  END IF;
END $$;

-- 4) Helpful indexes
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_username ON public.tiktok_posts_daily(username);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_post_date ON public.tiktok_posts_daily(post_date);

COMMIT;

-- 2025-10-24_leaderboard_fn.sql
BEGIN;

-- Drop existing function first because return type changed
DROP FUNCTION IF EXISTS public.leaderboard_tiktok(TEXT, DATE, DATE, INTEGER, UUID);

CREATE OR REPLACE FUNCTION public.leaderboard_tiktok(
  metric TEXT,
  start_date DATE,
  end_date DATE,
  top_n INTEGER DEFAULT 15,
  campaign UUID DEFAULT NULL
)
RETURNS TABLE(
  username TEXT,
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  saves BIGINT,
  total BIGINT
)
LANGUAGE sql
STABLE
AS $$
WITH base AS (
  SELECT LOWER(tp.username) AS username,
         COALESCE(SUM(tp.play_count),0)::bigint AS views,
         COALESCE(SUM(tp.digg_count),0)::bigint AS likes,
         COALESCE(SUM(tp.comment_count),0)::bigint AS comments,
         COALESCE(SUM(tp.share_count),0)::bigint AS shares,
         COALESCE(SUM(tp.save_count),0)::bigint AS saves,
         (COALESCE(SUM(tp.play_count),0)
        + COALESCE(SUM(tp.digg_count),0)
        + COALESCE(SUM(tp.comment_count),0)
        + COALESCE(SUM(tp.share_count),0)
        + COALESCE(SUM(tp.save_count),0))::bigint AS total
  FROM public.tiktok_posts_daily tp
  JOIN public.users u
    ON LOWER(u.tiktok_username) = LOWER(tp.username)
   AND u.role = 'umum'
  WHERE tp.post_date BETWEEN start_date AND end_date
  GROUP BY 1
), filtered AS (
  SELECT b.*
  FROM base b
  WHERE campaign IS NULL
     OR EXISTS (
       SELECT 1 FROM public.campaign_participants cp
       WHERE cp.campaign_id = campaign
         AND LOWER(cp.tiktok_username) = b.username
     )
)
SELECT *
FROM filtered
ORDER BY CASE
           WHEN metric = 'likes' THEN likes
           WHEN metric = 'comments' THEN comments
           WHEN metric = 'shares' THEN shares
           WHEN metric = 'saves' THEN saves
           WHEN metric = 'views' THEN views
           ELSE total -- default or 'total'
         END DESC NULLS LAST
LIMIT top_n;
$$;

GRANT EXECUTE ON FUNCTION public.leaderboard_tiktok(TEXT, DATE, DATE, INTEGER, UUID) TO authenticated;

COMMIT;

-- 2025-10-24_social_metrics_extend.sql
BEGIN;

-- Extend social_metrics with columns used by app (idempotent)
ALTER TABLE public.social_metrics
  ADD COLUMN IF NOT EXISTS followers INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saves INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ;

-- History snapshots (append-only)
CREATE TABLE IF NOT EXISTS public.social_metrics_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  followers INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  captured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sm_hist_user_platform ON public.social_metrics_history(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_sm_hist_captured_at ON public.social_metrics_history(captured_at DESC);

COMMIT;

-- 2025-10-24_users_add_secuid.sql
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tiktok_sec_uid TEXT;

CREATE INDEX IF NOT EXISTS idx_users_tiktok_sec_uid ON public.users(tiktok_sec_uid);

COMMIT;

-- 2025-10-24_fix_tiktok_posts_daily.sql
BEGIN;

ALTER TABLE public.tiktok_posts_daily
  ADD COLUMN IF NOT EXISTS save_count INTEGER DEFAULT 0;

COMMIT;

-- 2025-11-20_employee_groups.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_groups_pair ON public.employee_groups(employee_id, campaign_id);

ALTER TABLE public.employee_groups ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage employee_groups' AND tablename='employee_groups') THEN
    CREATE POLICY "Admin manage employee_groups" ON public.employee_groups FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

COMMIT;

-- 2025-11-20_employee_participants.sql
-- 2025-11-20_employee_participants_unique.sql
BEGIN;

create table if not exists employee_participants (
  employee_id uuid not null references users(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  tiktok_username text not null,
  created_at timestamptz not null default now(),
  primary key (employee_id, campaign_id, tiktok_username)
);

create index if not exists employee_participants_campaign_idx on employee_participants(campaign_id);
create index if not exists employee_participants_username_idx on employee_participants(tiktok_username);

create unique index if not exists employee_participants_unique_campaign_username
  on employee_participants(campaign_id, tiktok_username);

COMMIT;

-- 2025-11-20_user_tiktok_usernames.sql
BEGIN;

create table if not exists user_tiktok_usernames (
  user_id uuid not null references users(id) on delete cascade,
  tiktok_username text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tiktok_username)
);
create index if not exists user_tiktok_usernames_username_idx on user_tiktok_usernames(tiktok_username);

COMMIT;

-- 2025-11-21_fix_tiktok_posts_daily_schema.sql
BEGIN;

ALTER TABLE public.tiktok_posts_daily
  ADD COLUMN IF NOT EXISTS video_id TEXT,
  ADD COLUMN IF NOT EXISTS username TEXT,
  ADD COLUMN IF NOT EXISTS sec_uid TEXT,
  ADD COLUMN IF NOT EXISTS post_date DATE,
  ADD COLUMN IF NOT EXISTS comment_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS play_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS share_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS digg_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS save_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$
DECLARE
  pk_name text;
  has_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tiktok_posts_daily' AND column_name='id'
  ) INTO has_id;

  SELECT conname INTO pk_name FROM pg_constraint
  WHERE conrelid='public.tiktok_posts_daily'::regclass AND contype='p' LIMIT 1;

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.tiktok_posts_daily DROP CONSTRAINT %I', pk_name);
  END IF;

  IF has_id THEN
    ALTER TABLE public.tiktok_posts_daily DROP COLUMN IF EXISTS id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.tiktok_posts_daily'::regclass AND contype='p'
  ) THEN
    ALTER TABLE public.tiktok_posts_daily ADD CONSTRAINT tiktok_posts_daily_pkey PRIMARY KEY (video_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_username ON public.tiktok_posts_daily(username);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_post_date ON public.tiktok_posts_daily(post_date);

COMMIT;

-- 2025-11-21_groups.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.group_members (
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, employee_id)
);

CREATE TABLE IF NOT EXISTS public.group_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  tiktok_username TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_id, tiktok_username)
);
CREATE INDEX IF NOT EXISTS idx_group_participants_group ON public.group_participants(group_id);
CREATE INDEX IF NOT EXISTS idx_group_participants_username ON public.group_participants(tiktok_username);

CREATE TABLE IF NOT EXISTS public.group_participant_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  tiktok_username TEXT NOT NULL,
  followers BIGINT DEFAULT 0,
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comments BIGINT DEFAULT 0,
  shares BIGINT DEFAULT 0,
  saves BIGINT DEFAULT 0,
  posts_total INTEGER DEFAULT 0,
  metrics_json JSONB,
  last_refreshed TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_id, tiktok_username)
);
CREATE INDEX IF NOT EXISTS idx_group_participant_snapshots_group ON public.group_participant_snapshots(group_id);
CREATE INDEX IF NOT EXISTS idx_group_participant_snapshots_username ON public.group_participant_snapshots(tiktok_username);

CREATE OR REPLACE VIEW public.group_leaderboard AS
SELECT
  gps.group_id,
  gps.tiktok_username,
  gps.followers,
  gps.views,
  gps.likes,
  gps.comments,
  gps.shares,
  gps.saves,
  gps.posts_total,
  (COALESCE(gps.views,0)+COALESCE(gps.likes,0)+COALESCE(gps.comments,0)+COALESCE(gps.shares,0)+COALESCE(gps.saves,0)) AS total,
  gps.last_refreshed
FROM public.group_participant_snapshots gps;

CREATE OR REPLACE FUNCTION public.upsert_group_participant_snapshot(
  p_group_id UUID,
  p_tiktok_username TEXT,
  p_followers BIGINT,
  p_views BIGINT,
  p_likes BIGINT,
  p_comments BIGINT,
  p_shares BIGINT,
  p_saves BIGINT,
  p_posts_total INTEGER,
  p_metrics_json JSONB DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.group_participant_snapshots (
    group_id, tiktok_username, followers, views, likes, comments, shares, saves, posts_total, metrics_json, last_refreshed
  ) VALUES (
    p_group_id, LOWER(REGEXP_REPLACE(p_tiktok_username, '^@', '')), p_followers, p_views, p_likes, p_comments, p_shares, p_saves, p_posts_total, p_metrics_json, NOW()
  )
  ON CONFLICT (group_id, tiktok_username) DO UPDATE SET
    followers = EXCLUDED.followers,
    views = EXCLUDED.views,
    likes = EXCLUDED.likes,
    comments = EXCLUDED.comments,
    shares = EXCLUDED.shares,
    saves = EXCLUDED.saves,
    posts_total = EXCLUDED.posts_total,
    metrics_json = EXCLUDED.metrics_json,
    last_refreshed = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_participant_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage groups' AND tablename='groups') THEN
    CREATE POLICY "Admin manage groups" ON public.groups FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage group_members' AND tablename='group_members') THEN
    CREATE POLICY "Admin manage group_members" ON public.group_members FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage group_participants' AND tablename='group_participants') THEN
    CREATE POLICY "Admin manage group_participants" ON public.group_participants FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage group_participant_snapshots' AND tablename='group_participant_snapshots') THEN
    CREATE POLICY "Admin manage group_participant_snapshots" ON public.group_participant_snapshots FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

COMMIT;

-- 2025-11-24_instagram_posts_daily.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.instagram_posts_daily (
  id TEXT PRIMARY KEY, -- prefer IG pk or id
  username TEXT NOT NULL,
  post_date DATE NOT NULL,
  play_count BIGINT DEFAULT 0,
  like_count BIGINT DEFAULT 0,
  comment_count BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_user_date
  ON public.instagram_posts_daily(username, post_date);

CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_post_date ON public.instagram_posts_daily(post_date);

ALTER TABLE public.instagram_posts_daily ENABLE ROW LEVEL SECURITY;

COMMIT;

-- 2025-12-03_instagram_posts_add_code.sql + 2025-12-03_instagram_posts_add_caption.sql
BEGIN;

-- Add missing columns used by fetch-ig upserts
ALTER TABLE public.instagram_posts_daily 
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS caption TEXT;

-- Index for code (shortcode)
CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_code 
  ON public.instagram_posts_daily(code) WHERE code IS NOT NULL;

-- GIN index and regular index for caption search/filters
CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_caption_gin 
  ON public.instagram_posts_daily USING gin(to_tsvector('simple', COALESCE(caption, '')));
CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_caption 
  ON public.instagram_posts_daily (caption) WHERE caption IS NOT NULL;

COMMIT;

BEGIN;

  instagram_username TEXT PRIMARY KEY,
  instagram_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.instagram_user_ids ENABLE ROW LEVEL SECURITY;

COMMIT;

-- 2026-01-06_employee_historical_metrics.sql
BEGIN;

-- Aggregate historical totals table (no per-employee column)
CREATE TABLE IF NOT EXISTS public.employee_historical_metrics (
  id BIGSERIAL PRIMARY KEY,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok','instagram','all')),
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comments BIGINT DEFAULT 0,
  shares BIGINT DEFAULT 0,
  saves BIGINT DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_date_range CHECK (start_date <= end_date)
);

-- Ensure unique period per platform
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'unique_employee_period' AND conrelid = 'public.employee_historical_metrics'::regclass
  ) THEN
    ALTER TABLE public.employee_historical_metrics DROP CONSTRAINT unique_employee_period;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'unique_period_platform' AND conrelid = 'public.employee_historical_metrics'::regclass
  ) THEN
    ALTER TABLE public.employee_historical_metrics 
      ADD CONSTRAINT unique_period_platform UNIQUE (start_date, end_date, platform);
  END IF;
END $$;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_employee_historical_dates 
  ON public.employee_historical_metrics(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_employee_historical_platform 
  ON public.employee_historical_metrics(platform);

-- RLS and policies
ALTER TABLE public.employee_historical_metrics ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='employee_historical_metrics' AND policyname='Allow read access to all authenticated users'
  ) THEN
    CREATE POLICY "Allow read access to all authenticated users" 
      ON public.employee_historical_metrics FOR SELECT 
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='employee_historical_metrics' AND policyname='Allow write access to authenticated users'
  ) THEN
    CREATE POLICY "Allow write access to authenticated users" 
      ON public.employee_historical_metrics FOR ALL 
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_employee_historical_metrics_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_employee_historical_metrics_timestamp ON public.employee_historical_metrics;
CREATE TRIGGER trigger_update_employee_historical_metrics_timestamp
  BEFORE UPDATE ON public.employee_historical_metrics
  FOR EACH ROW
  EXECUTE FUNCTION public.update_employee_historical_metrics_timestamp();

COMMIT;
-- 2025-11-24_user_instagram_usernames.sql
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS instagram_username TEXT;

CREATE TABLE IF NOT EXISTS public.user_instagram_usernames (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  instagram_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, instagram_username)
);

CREATE INDEX IF NOT EXISTS user_instagram_usernames_username_idx
  ON public.user_instagram_usernames(instagram_username);

COMMIT;

-- 2025-11-24_employee_instagram_participants.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_instagram_participants (
  employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  instagram_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, campaign_id, instagram_username)
);

CREATE INDEX IF NOT EXISTS employee_instagram_participants_campaign_idx ON public.employee_instagram_participants(campaign_id);
CREATE INDEX IF NOT EXISTS employee_instagram_participants_username_idx ON public.employee_instagram_participants(instagram_username);

ALTER TABLE public.employee_instagram_participants ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage employee_instagram_participants' AND tablename='employee_instagram_participants') THEN
    CREATE POLICY "Admin manage employee_instagram_participants" ON public.employee_instagram_participants FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

COMMIT;

-- 2025-11-24_campaign_instagram_participants.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.campaign_instagram_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  instagram_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_ig_participant ON public.campaign_instagram_participants(campaign_id, instagram_username);
CREATE INDEX IF NOT EXISTS idx_campaign_ig_participants_campaign ON public.campaign_instagram_participants(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_ig_participants_username ON public.campaign_instagram_participants(instagram_username);

ALTER TABLE public.campaign_instagram_participants ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Admin manage campaign_instagram_participants' AND tablename='campaign_instagram_participants') THEN
    CREATE POLICY "Admin manage campaign_instagram_participants" ON public.campaign_instagram_participants FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;
END $$;

COMMIT;

-- 2025-11-24_campaign_instagram_participants_snapshot.sql
BEGIN;

ALTER TABLE public.campaign_instagram_participants
  ADD COLUMN IF NOT EXISTS followers BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS likes BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS views BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS posts_total INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metrics_json JSONB,
  ADD COLUMN IF NOT EXISTS last_refreshed TIMESTAMPTZ;

COMMIT;

-- 2025-12-01_instagram_post_metrics_history.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.instagram_post_metrics_history (
  id BIGSERIAL PRIMARY KEY,
  post_id TEXT NOT NULL,
  username TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  play_count BIGINT DEFAULT 0,
  like_count BIGINT DEFAULT 0,
  comment_count BIGINT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ig_post_hist_post_time ON public.instagram_post_metrics_history(post_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_post_hist_user_time ON public.instagram_post_metrics_history(username, captured_at DESC);

CREATE OR REPLACE FUNCTION public.fn_log_instagram_post_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.instagram_post_metrics_history (post_id, username, captured_at, play_count, like_count, comment_count)
  VALUES (NEW.id, NEW.username, NOW(), NEW.play_count, NEW.like_count, NEW.comment_count);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_ig_post_snapshot ON public.instagram_posts_daily;
CREATE TRIGGER trg_log_ig_post_snapshot
AFTER INSERT OR UPDATE ON public.instagram_posts_daily
FOR EACH ROW EXECUTE FUNCTION public.fn_log_instagram_post_snapshot();

ALTER TABLE public.instagram_post_metrics_history ENABLE ROW LEVEL SECURITY;

COMMIT;

-- 2025-12-04_supabase_storage_avatars.sql (policies for avatars bucket)
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can upload own profile pictures'
  ) THEN
    CREATE POLICY "Users can upload own profile pictures"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'avatars' 
      AND (storage.foldername(name))[1] = 'profile-pictures'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Anyone can view avatars'
  ) THEN
    CREATE POLICY "Anyone can view avatars"
    ON storage.objects
    FOR SELECT
    TO public
    USING (bucket_id = 'avatars');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can update own profile pictures'
  ) THEN
    CREATE POLICY "Users can update own profile pictures"
    ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'avatars' 
      AND (storage.foldername(name))[1] = 'profile-pictures'
    )
    WITH CHECK (
      bucket_id = 'avatars' 
      AND (storage.foldername(name))[1] = 'profile-pictures'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can delete own profile pictures'
  ) THEN
    CREATE POLICY "Users can delete own profile pictures"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'avatars' 
      AND (storage.foldername(name))[1] = 'profile-pictures'
    );
  END IF;
END $$;

COMMIT;

-- 2025-12-09_refresh_retry_queue.sql
-- Persistent retry queue for platform refreshes
create table if not exists refresh_retry_queue (
  id bigserial primary key,
  platform text not null check (platform in ('tiktok','instagram')),
  username text not null,
  last_error text,
  retry_count int not null default 0,
  next_retry_at timestamptz not null default now(),
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform, username)
);

create index if not exists idx_refresh_retry_queue_due on refresh_retry_queue(platform, next_retry_at);

create or replace function set_updated_at_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgrelid = 'public.refresh_retry_queue'::regclass 
      AND tgname = 'trg_refresh_retry_queue_updated_at'
  ) THEN
    CREATE TRIGGER trg_refresh_retry_queue_updated_at
    BEFORE UPDATE ON refresh_retry_queue
    FOR EACH ROW EXECUTE FUNCTION set_updated_at_timestamp();
  END IF;
END $$;

-- 2026-01-06_weekly_historical_data.sql
CREATE TABLE IF NOT EXISTS weekly_historical_data (
  id BIGSERIAL PRIMARY KEY,
  week_label TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  week_num INTEGER NOT NULL,
  campaign_id TEXT,
  group_name TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'all')),
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comments BIGINT DEFAULT 0,
  shares BIGINT DEFAULT 0,
  saves BIGINT DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(week_label, year, month, week_num, campaign_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_weekly_hist_dates ON weekly_historical_data(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_weekly_hist_campaign ON weekly_historical_data(campaign_id);
CREATE INDEX IF NOT EXISTS idx_weekly_hist_platform ON weekly_historical_data(platform);
CREATE INDEX IF NOT EXISTS idx_weekly_hist_year_month ON weekly_historical_data(year, month);

ALTER TABLE weekly_historical_data ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='weekly_historical_data' AND policyname='Allow public read on weekly_historical_data'
  ) THEN
    CREATE POLICY "Allow public read on weekly_historical_data" ON public.weekly_historical_data
      FOR SELECT USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='weekly_historical_data' AND policyname='Allow authenticated write on weekly_historical_data'
  ) THEN
    CREATE POLICY "Allow authenticated write on weekly_historical_data" ON public.weekly_historical_data
      FOR ALL USING (auth.role() = 'authenticated');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION update_weekly_historical_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS weekly_historical_updated_at_trigger ON weekly_historical_data;
CREATE TRIGGER weekly_historical_updated_at_trigger
  BEFORE UPDATE ON weekly_historical_data
  FOR EACH ROW
  EXECUTE FUNCTION update_weekly_historical_updated_at();

CREATE OR REPLACE FUNCTION parse_week_label(label TEXT, year_val INTEGER)
RETURNS TABLE(start_date DATE, end_date DATE, month_num INTEGER, week_num INTEGER) AS $$
DECLARE
  month_name TEXT;
  week_str TEXT;
  week_number INTEGER;
  month_number INTEGER;
  month_start DATE;
  week_start DATE;
BEGIN
  week_str := SUBSTRING(label FROM 'W(\d+)');
  month_name := TRIM(SUBSTRING(label FROM 'W\d+\s+(.+)'));
  week_number := week_str::INTEGER;

  month_number := CASE LOWER(month_name)
    WHEN 'januari' THEN 1
    WHEN 'februari' THEN 2
    WHEN 'maret' THEN 3
    WHEN 'april' THEN 4
    WHEN 'mei' THEN 5
    WHEN 'juni' THEN 6
    WHEN 'juli' THEN 7
    WHEN 'agustus' THEN 8
    WHEN 'september' THEN 9
    WHEN 'oktober' THEN 10
    WHEN 'november' THEN 11
    WHEN 'desember' THEN 12
    ELSE NULL
  END;

  IF month_number IS NULL THEN
    RAISE EXCEPTION 'Invalid month name: %', month_name;
  END IF;

  week_start := DATE(year_val || '-' || month_number || '-01') + ((week_number - 1) * 7);

  RETURN QUERY SELECT 
    week_start AS start_date,
    LEAST(week_start + 6, (DATE(year_val || '-' || month_number || '-01') + INTERVAL '1 month' - INTERVAL '1 day')::DATE) AS end_date,
    month_number AS month_num,
    week_number AS week_num;
END;
$$ LANGUAGE plpgsql;

-- 2026-01-09_instagram_add_taken_at.sql
BEGIN;

ALTER TABLE public.instagram_posts_daily 
  ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_instagram_posts_daily_taken_at 
  ON public.instagram_posts_daily(taken_at);

ALTER TABLE public.tiktok_posts_daily 
  ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_daily_taken_at 
  ON public.tiktok_posts_daily(taken_at);

COMMIT;

-- supabase/sql/instagram_normalize_backfill.sql (normalization + triggers + backfill)
-- You can safely re-run this. It includes updates and trigger creations.

-- Helpers
create or replace function strip_at_lower(t text)
returns text language sql immutable as $$
  select case when t is null then null else lower(regexp_replace(t, '^@+', '')) end
$$;

-- One-time normalization
update instagram_posts_daily
set username = strip_at_lower(username)
where username is not null and (username ~ '^@' or username <> lower(username));

update user_instagram_usernames
set instagram_username = strip_at_lower(instagram_username)
where instagram_username is not null and (instagram_username ~ '^@' or instagram_username <> lower(instagram_username));

update campaign_instagram_participants
set instagram_username = strip_at_lower(instagram_username)
where instagram_username is not null and (instagram_username ~ '^@' or instagram_username <> lower(instagram_username));

update employee_instagram_participants
set instagram_username = strip_at_lower(instagram_username)
where instagram_username is not null and (instagram_username ~ '^@' or instagram_username <> lower(instagram_username));

update users
set instagram_username = strip_at_lower(instagram_username)
where instagram_username is not null and (instagram_username ~ '^@' or instagram_username <> lower(instagram_username));

-- Triggers
DROP TRIGGER IF EXISTS trg_norm_ig_posts ON instagram_posts_daily;
create or replace function trg_norm_ig_posts_fn()
returns trigger language plpgsql as $$
begin
  new.username := strip_at_lower(new.username);
  return new;
end$$;
create trigger trg_norm_ig_posts
before insert or update on instagram_posts_daily
for each row execute function trg_norm_ig_posts_fn();

create or replace function trg_norm_map_fn()
returns trigger language plpgsql as $$
begin
  new.instagram_username := strip_at_lower(new.instagram_username);
  return new;
end$$;

DROP TRIGGER IF EXISTS trg_norm_map ON user_instagram_usernames;
create trigger trg_norm_map
before insert or update on user_instagram_usernames
for each row execute function trg_norm_map_fn();

DROP TRIGGER IF EXISTS trg_norm_camp_ig ON campaign_instagram_participants;
create trigger trg_norm_camp_ig
before insert or update on campaign_instagram_participants
for each row execute function trg_norm_map_fn();

DROP TRIGGER IF EXISTS trg_norm_emp_ig ON employee_instagram_participants;
create trigger trg_norm_emp_ig
before insert or update on employee_instagram_participants
for each row execute function trg_norm_map_fn();

DROP TRIGGER IF EXISTS trg_norm_users_ig ON users;
create or replace function trg_norm_users_ig_fn()
returns trigger language plpgsql as $$
begin
  if new.instagram_username is not null then
    new.instagram_username := strip_at_lower(new.instagram_username);
  end if;
  return new;
end$$;
create trigger trg_norm_users_ig
before insert or update on users
for each row execute function trg_norm_users_ig_fn();

-- Backfill maps
insert into employee_instagram_participants (employee_id, campaign_id, instagram_username)
select eg.employee_id,
       eg.campaign_id,
       strip_at_lower(us.instagram_username)
from employee_groups eg
join users us on us.id = eg.employee_id
where strip_at_lower(us.instagram_username) is not null
on conflict (employee_id, campaign_id, instagram_username) do nothing;

insert into employee_instagram_participants (employee_id, campaign_id, instagram_username)
select eg.employee_id,
       eg.campaign_id,
       strip_at_lower(ui.instagram_username)
from employee_groups eg
join user_instagram_usernames ui on ui.user_id = eg.employee_id
where strip_at_lower(ui.instagram_username) is not null
on conflict (employee_id, campaign_id, instagram_username) do nothing;

insert into campaign_instagram_participants (campaign_id, instagram_username)
select distinct eip.campaign_id, eip.instagram_username
from employee_instagram_participants eip
on conflict (campaign_id, instagram_username) do nothing;

-- Indexes
create index if not exists idx_ig_posts_username_date on instagram_posts_daily (username, post_date);
create index if not exists idx_emp_ig_part_employee on employee_instagram_participants (employee_id, campaign_id);
create index if not exists idx_camp_ig_part on campaign_instagram_participants (campaign_id, instagram_username);
create index if not exists idx_user_ig_alias on user_instagram_usernames (user_id, instagram_username);
