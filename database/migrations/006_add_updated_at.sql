ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE orders
SET updated_at = GREATEST(
  COALESCE(failed_at,       created_at),
  COALESCE(completed_at,    created_at),
  COALESCE(sent_to_pos_at,  created_at),
  COALESCE(saved_at,        created_at),
  COALESCE(queued_at,       created_at),
  created_at
)
WHERE updated_at IS NULL;
