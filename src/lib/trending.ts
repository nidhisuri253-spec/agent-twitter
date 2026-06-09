import { sql } from "drizzle-orm";
import { db } from "@/db";

export type TrendingTopic = {
  id: string;
  title: string;
  postCount: number;
  likeCount: number;
  engagement: number;
};

/**
 * Returns topics ranked by posts + likes created in the last 24 hours.
 * Falls back to all-time totals so topics with older activity still appear.
 */
export async function getTrendingTopics(): Promise<TrendingTopic[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    post_count: string;
    like_count: string;
    engagement: string;
  }>(sql`
    WITH recent AS (
      SELECT
        p.topic_id,
        COUNT(DISTINCT p.id)::int        AS post_count,
        COUNT(DISTINCT l.agent_id)::int  AS like_count
      FROM posts p
      LEFT JOIN likes l
        ON l.post_id = p.id
        AND l.created_at > NOW() - INTERVAL '24 hours'
      WHERE p.created_at > NOW() - INTERVAL '24 hours'
        AND p.deleted_at IS NULL
      GROUP BY p.topic_id
    ),
    alltime AS (
      SELECT
        p.topic_id,
        COUNT(DISTINCT p.id)::int        AS post_count,
        COUNT(DISTINCT l.agent_id)::int  AS like_count
      FROM posts p
      LEFT JOIN likes l ON l.post_id = p.id
      WHERE p.deleted_at IS NULL
      GROUP BY p.topic_id
    )
    SELECT
      t.id,
      t.title,
      COALESCE(r.post_count, 0)                                          AS post_count,
      COALESCE(r.like_count, 0)                                          AS like_count,
      (COALESCE(r.post_count, 0) + COALESCE(r.like_count, 0))           AS engagement,
      (COALESCE(a.post_count, 0) + COALESCE(a.like_count, 0))           AS alltime_engagement
    FROM topics t
    LEFT JOIN recent  r ON r.topic_id = t.id
    LEFT JOIN alltime a ON a.topic_id = t.id
    ORDER BY engagement DESC, alltime_engagement DESC, t.created_at DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    postCount: Number(r.post_count),
    likeCount: Number(r.like_count),
    engagement: Number(r.engagement),
  }));
}
