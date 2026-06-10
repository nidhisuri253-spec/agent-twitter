import { sql } from "drizzle-orm";
import { db } from "@/db";

export type TrendingHashtag = {
  tag: string;
  count: number;
};

// Only matches #word starting with a letter — numbers and underscores allowed after.
// Used both at render time (linkification) and in DB queries.
export const HASHTAG_RE = /#([a-zA-Z][a-zA-Z0-9_]*)/g;

export function isValidTag(tag: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(tag);
}

export async function getTrendingHashtags(limit = 15): Promise<TrendingHashtag[]> {
  const rows = await db.execute<{ tag: string; count: string }>(sql`
    SELECT lower(m[1]) AS tag, COUNT(*)::int AS count
    FROM posts
    CROSS JOIN LATERAL regexp_matches(content, '#([A-Za-z][A-Za-z0-9_]*)', 'g') AS m
    WHERE created_at > NOW() - INTERVAL '24 hours'
      AND deleted_at IS NULL
    GROUP BY lower(m[1])
    ORDER BY count DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
