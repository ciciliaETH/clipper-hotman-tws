-- Automatically snapshot social_metrics into social_metrics_history on insert/update
-- Date: 2026-01-18

BEGIN;

-- Create trigger function
CREATE OR REPLACE FUNCTION public.fn_snapshot_social_metrics()
RETURNS trigger AS $$
BEGIN
  -- For UPDATEs, skip when no metric changed
  IF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.followers,0) = COALESCE(OLD.followers,0)
       AND COALESCE(NEW.likes,0) = COALESCE(OLD.likes,0)
       AND COALESCE(NEW.views,0) = COALESCE(OLD.views,0)
       AND COALESCE(NEW.comments,0) = COALESCE(OLD.comments,0)
       AND COALESCE(NEW.shares,0) = COALESCE(OLD.shares,0)
       AND COALESCE(NEW.saves,0) = COALESCE(OLD.saves,0) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Debounce: if a snapshot exists in the last 30 seconds, skip to avoid duplicates
  IF EXISTS (
    SELECT 1 FROM public.social_metrics_history h
    WHERE h.user_id = NEW.user_id
      AND h.platform = NEW.platform
      AND h.captured_at > NOW() - INTERVAL '30 seconds'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.social_metrics_history(
    user_id, platform, followers, likes, views, comments, shares, saves, captured_at
  ) VALUES (
    NEW.user_id, NEW.platform,
    COALESCE(NEW.followers,0), COALESCE(NEW.likes,0), COALESCE(NEW.views,0),
    COALESCE(NEW.comments,0), COALESCE(NEW.shares,0), COALESCE(NEW.saves,0),
    NOW()
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_snapshot_social_metrics ON public.social_metrics;

-- Create AFTER trigger for insert and update
CREATE TRIGGER trg_snapshot_social_metrics
AFTER INSERT OR UPDATE ON public.social_metrics
FOR EACH ROW EXECUTE FUNCTION public.fn_snapshot_social_metrics();

COMMIT;
