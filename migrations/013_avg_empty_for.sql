ALTER TABLE empty_for_bounds
  ADD COLUMN IF NOT EXISTS avg_empty_for INTEGER;

ALTER TABLE empty_for_bounds
  DROP CONSTRAINT IF EXISTS empty_for_bounds_avg_empty_for_check;

ALTER TABLE empty_for_bounds
  ADD CONSTRAINT empty_for_bounds_avg_empty_for_check
  CHECK (avg_empty_for IS NULL OR avg_empty_for >= 0);

-- Midpoint when both configured bounds are set.
UPDATE empty_for_bounds
SET avg_empty_for = ROUND((min_empty_for + max_empty_for)::numeric / 2)
WHERE min_empty_for IS NOT NULL AND max_empty_for IS NOT NULL;

-- Last 100 non-excluded cycles for items that do not have both bounds.
WITH ranked AS (
  SELECT
    country,
    item_id,
    COALESCE(adjusted_duration, duration) AS dur,
    ROW_NUMBER() OVER (
      PARTITION BY country, item_id
      ORDER BY depleted_ts DESC
    ) AS rn
  FROM restocks
  WHERE ignored = 0 AND duration IS NOT NULL
),
avgs AS (
  SELECT country, item_id, ROUND(AVG(dur))::INTEGER AS avg_dur
  FROM ranked
  WHERE rn <= 100
  GROUP BY country, item_id
)
INSERT INTO empty_for_bounds (country, item_id, min_empty_for, max_empty_for, avg_empty_for)
SELECT country, item_id, NULL, NULL, avg_dur
FROM avgs
ON CONFLICT (country, item_id) DO UPDATE
SET avg_empty_for = CASE
  WHEN empty_for_bounds.min_empty_for IS NOT NULL
   AND empty_for_bounds.max_empty_for IS NOT NULL
  THEN empty_for_bounds.avg_empty_for
  ELSE EXCLUDED.avg_empty_for
END;
