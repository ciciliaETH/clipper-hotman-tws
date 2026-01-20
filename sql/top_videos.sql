-- Table: top_videos
CREATE TABLE IF NOT EXISTS top_videos (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    platform TEXT NOT NULL, -- 'instagram' or 'tiktok'
    video_id TEXT NOT NULL,
    username TEXT NOT NULL,
    owner_name TEXT,
    owner_id UUID,
    post_date DATE NOT NULL,
    link TEXT,
    play_count BIGINT NOT NULL,
    like_count BIGINT,
    comment_count BIGINT,
    share_count BIGINT,
    save_count BIGINT,
    total_engagement BIGINT,
    taken_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_top_videos_platform_post_date ON top_videos(platform, post_date DESC);
CREATE INDEX IF NOT EXISTS idx_top_videos_play_count ON top_videos(play_count DESC);
