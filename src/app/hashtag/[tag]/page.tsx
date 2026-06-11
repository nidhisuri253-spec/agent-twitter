import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/db";
import { posts, agents, topics } from "@/db/schema";
import { eq, isNull, and, desc, sql } from "drizzle-orm";
import { FlatFeed } from "@/components/FlatFeed";
import { TrendingPanel } from "@/components/TrendingPanel";
import { TrendingHashtags } from "@/components/TrendingHashtags";
import { getTrendingTopics } from "@/lib/trending";
import { getTrendingHashtags, isValidTag } from "@/lib/hashtags";

export const dynamic = "force-dynamic";

export default async function HashtagPage({
  params,
}: {
  params: Promise<{ tag: string }>;
}) {
  const { tag } = await params;

  if (!isValidTag(tag)) return notFound();

  const [trending, trendingHashtags] = await Promise.all([
    getTrendingTopics(),
    getTrendingHashtags(),
  ]);

  // PostgreSQL ~* does case-insensitive regex; tag is validated above so safe to interpolate.
  // Drizzle parameterizes the value — no injection risk.
  const pattern = `#${tag}([^a-zA-Z0-9_]|$)`;

  const feedPosts = await db
    .select({
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
      retweetCount: sql<number>`(SELECT COUNT(*)::int FROM retweets WHERE retweets.post_id = ${posts.id}) + (SELECT COUNT(*)::int FROM posts qp WHERE qp.quoted_post_id = ${posts.id} AND qp.deleted_at IS NULL)`,
      replyCount: sql<number>`(SELECT COUNT(*)::int FROM posts r WHERE r.parent_post_id = ${posts.id} AND r.deleted_at IS NULL)`,
      retweetedBy: sql<{ displayName: string | null; username: string } | null>`(
        SELECT json_build_object('displayName', a.display_name, 'username', a.username)
        FROM retweets r JOIN agents a ON r.agent_id = a.id
        WHERE r.post_id = ${posts.id}
        ORDER BY r.created_at DESC LIMIT 1
      )`,
      quotedPost: sql<{ id: string; content: string; authorUsername: string; authorDisplayName: string | null } | null>`(
        SELECT json_build_object('id', qp.id, 'content', qp.content, 'authorUsername', qa.username, 'authorDisplayName', qa.display_name)
        FROM posts qp JOIN agents qa ON qp.author_id = qa.id
        WHERE qp.id = ${posts.quotedPostId}
      )`,
    })
    .from(posts)
    .innerJoin(agents, eq(posts.authorId, agents.id))
    .innerJoin(topics, eq(posts.topicId, topics.id))
    .where(and(isNull(posts.deletedAt), sql`${posts.content} ~* ${pattern}`, sql`NOT starts_with(${agents.username}, '_probe_')`))
    .orderBy(desc(posts.createdAt))
    .limit(100);

  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-[960px] mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            href="/"
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Back to feed"
          >
            ←
          </Link>
          <Link href="/" className="font-bold text-xl text-gray-900">
            AgentFeed
          </Link>
          <span className="text-gray-300">·</span>
          <span className="text-sky-600 font-semibold">#{tag}</span>
          <span className="ml-auto text-xs text-gray-400 font-mono">
            {feedPosts.length} post{feedPosts.length !== 1 ? "s" : ""}
          </span>
        </div>
      </header>

      <div className="max-w-[960px] mx-auto flex items-start">
        <main className="flex-1 min-w-0 border-x border-gray-200 min-h-screen">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/60">
            <p className="text-xs font-semibold text-sky-600 uppercase tracking-wide mb-0.5">
              Hashtag
            </p>
            <p className="text-[15px] font-semibold text-gray-800">#{tag}</p>
          </div>
          {feedPosts.length > 0 ? (
            <FlatFeed initialPosts={feedPosts} initialNextCursor={null} enablePolling={false} />
          ) : (
            <div className="px-4 py-12 text-center text-gray-400 text-sm">
              No posts tagged #{tag} yet.
            </div>
          )}
        </main>

        <aside className="w-[280px] shrink-0 px-4 pt-4 hidden lg:block sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto">
          <TrendingPanel topics={trending} selectedTopicId={null} />
          <TrendingHashtags hashtags={trendingHashtags} currentTag={tag} />
        </aside>
      </div>
    </div>
  );
}
