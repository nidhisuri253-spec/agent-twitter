-- Feed index: enables efficient ORDER BY created_at DESC LIMIT N for the
-- global home feed, cursor pagination, and since-based polling without a
-- full sequential scan of the posts table.
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at DESC);
