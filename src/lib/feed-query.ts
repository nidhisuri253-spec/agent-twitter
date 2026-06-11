// Shared feed query used by both the SSR page (initial render) and the
// /api/v1/feed route (pagination + polling).  Wrapped in unstable_cache so
// every cursor position has its own 20-second server-side cache slot.
// When new posts are written, POST /api/v1/posts calls revalidateTag("feed")
// to flush all slots immediately.

import { unstable_cache } from "next/cache";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, posts, topics } from "@/db/schema";

export const FEED_PAGE_SIZE = 25;
export const FEED_CACHE_TAG = "feed";

const PROBE_FILTER = sql`NOT starts_with(${agents.username}, '_probe_')`;

// Full column list — identical to what page.tsx used to query inline.
// Must stay in sync with PostRow in TweetCard.tsx.
const feedSelect = {
  id: posts.id,
  parentPostId: posts.parentPostId,
  content: posts.content,
  createdAt: posts.createdAt,
  authorId: posts.authorId,
  authorUsername: agents.username,
  authorDisplayName: agents.displayName,
  topicId: topics.id,
  topicTitle: topics.title,
  parentAuthorUsername: sql<string | null>`(
    SELECT a2.username FROM posts p2
    JOIN agents a2 ON p2.author_id = a2.id
    WHERE p2.id = ${posts.parentPostId}
  )`,
  likeCount: sql<number>`(SELECT COUNT(*)::int FROM likes WHERE likes.post_id = ${posts.id})`,
  retweetCount: sql<number>`(
    SELECT COUNT(*)::int FROM retweets WHERE retweets.post_id = ${posts.id}
  ) + (
    SELECT COUNT(*)::int FROM posts qp
    WHERE qp.quoted_post_id = ${posts.id} AND qp.deleted_at IS NULL
  )`,
  replyCount: sql<number>`(SELECT COUNT(*)::int FROM posts r WHERE r.parent_post_id = ${posts.id} AND r.deleted_at IS NULL)`,
  retweetedBy: sql<{ displayName: string | null; username: string } | null>`(
    SELECT json_build_object('displayName', a.display_name, 'username', a.username)
    FROM retweets r JOIN agents a ON r.agent_id = a.id
    WHERE r.post_id = ${posts.id}
    ORDER BY r.created_at DESC LIMIT 1
  )`,
  quotedPost: sql<{
    id: string;
    content: string;
    authorUsername: string;
    authorDisplayName: string | null;
  } | null>`(
    SELECT json_build_object(
      'id', qp.id, 'content', qp.content,
      'authorUsername', qa.username, 'authorDisplayName', qa.display_name
    )
    FROM posts qp JOIN agents qa ON qp.author_id = qa.id
    WHERE qp.id = ${posts.quotedPostId}
  )`,
};

// Cursor-based page: posts created BEFORE `cursor` (oldest last).
// cursor = ISO timestamp string of the last post on the previous page.
async function _getFeedPage(cursor: string | null) {
  const where = cursor
    ? and(isNull(posts.deletedAt), lt(posts.createdAt, new Date(cursor)), PROBE_FILTER)
    : and(isNull(posts.deletedAt), PROBE_FILTER);

  return db
    .select(feedSelect)
    .from(posts)
    .innerJoin(agents, eq(posts.authorId, agents.id))
    .innerJoin(topics, eq(posts.topicId, topics.id))
    .where(where)
    .orderBy(desc(posts.createdAt))
    .limit(FEED_PAGE_SIZE);
}

// Each cursor position gets its own 20s cache entry.
// All entries share the "feed" tag so revalidateTag("feed") flushes them all.
export const getCachedFeedPage = unstable_cache(
  _getFeedPage,
  ["feed-page"],
  { revalidate: 20, tags: [FEED_CACHE_TAG] }
);

// Since-based fetch: posts created AFTER `since` (newest first after reversal).
// Used by the 30s polling loop — never cached.
export async function getNewFeedPosts(since: string) {
  return db
    .select(feedSelect)
    .from(posts)
    .innerJoin(agents, eq(posts.authorId, agents.id))
    .innerJoin(topics, eq(posts.topicId, topics.id))
    .where(and(isNull(posts.deletedAt), gt(posts.createdAt, new Date(since)), PROBE_FILTER))
    .orderBy(asc(posts.createdAt))
    .limit(50);
}
