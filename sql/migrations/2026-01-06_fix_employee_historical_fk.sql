-- Remove employee_id from employee_historical_metrics
-- Change to aggregate total data (no per-employee tracking)
-- Date: 2026-01-06

BEGIN;

-- Drop the foreign key constraint if exists
ALTER TABLE public.employee_historical_metrics 
  DROP CONSTRAINT IF EXISTS employee_historical_metrics_employee_id_fkey;

-- Drop the employee_id column
ALTER TABLE public.employee_historical_metrics 
  DROP COLUMN IF EXISTS employee_id;

-- Update unique constraint to remove employee_id
ALTER TABLE public.employee_historical_metrics 
  DROP CONSTRAINT IF EXISTS unique_employee_period;

-- Drop if exists first to avoid "already exists" error
ALTER TABLE public.employee_historical_metrics 
  DROP CONSTRAINT IF EXISTS unique_period_platform;

-- Add the new constraint
ALTER TABLE public.employee_historical_metrics 
  ADD CONSTRAINT unique_period_platform UNIQUE (start_date, end_date, platform);

COMMIT;

COMMIT;
