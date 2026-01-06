-- Create table for manual weekly historical data input
CREATE TABLE IF NOT EXISTS weekly_historical_data (
  id BIGSERIAL PRIMARY KEY,
  
  -- Week identification
  week_label TEXT NOT NULL, -- e.g., "W1 Agustus", "W2 September"
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  year INTEGER NOT NULL, -- e.g., 2025
  month INTEGER NOT NULL, -- 1-12
  week_num INTEGER NOT NULL, -- Week number in month (1-5)
  
  -- Campaign/Group identification (NULL = total across all)
  campaign_id TEXT, -- Can be NULL for total data
  group_name TEXT, -- Optional group/campaign name
  
  -- Platform
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'all')),
  
  -- Metrics
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comments BIGINT DEFAULT 0,
  shares BIGINT DEFAULT 0,
  saves BIGINT DEFAULT 0,
  
  -- Metadata
  notes TEXT, -- Optional notes
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  UNIQUE(week_label, year, month, week_num, campaign_id, platform)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_weekly_hist_dates ON weekly_historical_data(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_weekly_hist_campaign ON weekly_historical_data(campaign_id);
CREATE INDEX IF NOT EXISTS idx_weekly_hist_platform ON weekly_historical_data(platform);
CREATE INDEX IF NOT EXISTS idx_weekly_hist_year_month ON weekly_historical_data(year, month);

-- Enable RLS
ALTER TABLE weekly_historical_data ENABLE ROW LEVEL SECURITY;

-- Allow public read access (same as other metrics tables)
CREATE POLICY "Allow public read on weekly_historical_data" ON weekly_historical_data
  FOR SELECT USING (true);

-- Allow authenticated insert/update/delete (admin only)
CREATE POLICY "Allow authenticated write on weekly_historical_data" ON weekly_historical_data
  FOR ALL USING (auth.role() = 'authenticated');

-- Update trigger
CREATE OR REPLACE FUNCTION update_weekly_historical_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER weekly_historical_updated_at_trigger
  BEFORE UPDATE ON weekly_historical_data
  FOR EACH ROW
  EXECUTE FUNCTION update_weekly_historical_updated_at();

-- Helper function to parse week label and generate dates
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
  -- Extract "W1" and "Agustus" from "W1 Agustus"
  week_str := SUBSTRING(label FROM 'W(\d+)');
  month_name := TRIM(SUBSTRING(label FROM 'W\d+\s+(.+)'));
  week_number := week_str::INTEGER;
  
  -- Map Indonesian month names to numbers
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
  
  -- Calculate week start date
  -- W1 starts on first Friday of month (or first day if month starts on Friday)
  -- For simplicity, W1 = days 1-7, W2 = 8-14, W3 = 15-21, W4 = 22-28, W5 = 29-31
  week_start := DATE(year_val || '-' || month_number || '-01') + ((week_number - 1) * 7);
  
  RETURN QUERY SELECT 
    week_start AS start_date,
    LEAST(week_start + 6, (DATE(year_val || '-' || month_number || '-01') + INTERVAL '1 month' - INTERVAL '1 day')::DATE) AS end_date,
    month_number AS month_num,
    week_number AS week_num;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE weekly_historical_data IS 'Manual input for weekly historical metrics data';
