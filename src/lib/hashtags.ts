import { sql } from "drizzle-orm";
import { db } from "@/db";

// Pure regex helpers live in hashtag-utils so client components can import them
// without pulling in the DB driver (postgres uses Node.js `fs`).
export { HASHTAG_RE, isValidTag } from "./hashtag-utils";

export type TrendingHashtag = {
  tag: string;
  count: number;
};

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
