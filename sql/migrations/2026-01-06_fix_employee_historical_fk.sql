-- Fix foreign key constraint for employee_historical_metrics
-- Change from employee_accounts(id) to users(id)
-- Date: 2026-01-06

BEGIN;

-- Drop the wrong foreign key constraint
ALTER TABLE public.employee_historical_metrics 
  DROP CONSTRAINT IF EXISTS employee_historical_metrics_employee_id_fkey;

-- Add the correct foreign key constraint to users table
ALTER TABLE public.employee_historical_metrics 
  ADD CONSTRAINT employee_historical_metrics_employee_id_fkey 
  FOREIGN KEY (employee_id) REFERENCES public.users(id) ON DELETE CASCADE;

COMMIT;
