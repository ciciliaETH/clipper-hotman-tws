-- Employee Historical Metrics Table for Manual Data Entry
-- Support custom date ranges for employee metrics (not fixed weekly)
-- Date: 2026-01-06

BEGIN;

-- Create table for storing custom period historical data manually entered by admin
CREATE TABLE IF NOT EXISTS public.employee_historical_metrics (
  id SERIAL PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'all')),
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comments BIGINT DEFAULT 0,
  shares BIGINT DEFAULT 0,
  saves BIGINT DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ensure start_date is before end_date
  CONSTRAINT valid_date_range CHECK (start_date <= end_date),
  -- Ensure no overlapping periods for same employee+platform
  CONSTRAINT unique_employee_period UNIQUE (employee_id, start_date, end_date, platform)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_employee_historical_employee ON public.employee_historical_metrics(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_historical_dates ON public.employee_historical_metrics(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_employee_historical_platform ON public.employee_historical_metrics(platform);

-- RLS Policies
ALTER TABLE public.employee_historical_metrics ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read
CREATE POLICY "Allow read access to all authenticated users" 
  ON public.employee_historical_metrics FOR SELECT 
  USING (auth.role() = 'authenticated');

-- Allow all authenticated users to insert/update/delete (for admin purposes)
CREATE POLICY "Allow write access to authenticated users" 
  ON public.employee_historical_metrics FOR ALL 
  USING (auth.role() = 'authenticated');

-- Trigger to update updated_at timestamp
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
