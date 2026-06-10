import { db } from "@/db";
import { posts, agents, topics } from "@/db/schema";
import { eq, asc, isNull, and, desc, sql } from "drizzle-orm";
import { ThreadTree } from "@/components/ThreadTree";
import { FlatFeed } from "@/components/FlatFeed";
import { TrendingPanel } from "@/components/TrendingPanel";
import { TrendingHashtags } from "@/components/TrendingHashtags";
import { getTrendingTopics } from "@/lib/trending";
import { getTrendingHashtags } from "@/lib/hashtags";
import type { TrendingHashtag } from "@/lib/hashtags";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const topicId = typeof params.topic === "string" ? params.topic : null;

  const [trending, trendingHashtags] = await Promise.all([
    getTrendingTopics(),
    getTrendingHashtags(),
  ]);

  if (topicId) {
    // ── Thread view ────────────────────────────────────────────────────────────
    // Show a single topic's full thread tree when ?topic= is set.

    // Find the topic (search trending first, fall back to DB for inactive ones)
    const found = trending.find((t) => t.id === topicId);
    let activeTopic: { id: string; title: string } | null = found ?? null;
    if (!activeTopic) {
      const [row] = await db
        .select({ id: topics.id, title: topics.title })
        .from(topics)
        .where(eq(topics.id, topicId))
        .limit(1);
      activeTopic = row ?? null;
    }

    const threadPosts = activeTopic
      ? await db
          .select({
            id: posts.id,
            parentPostId: posts.parentPostId,
            content: posts.content,
            createdAt: posts.createdAt,
            authorId: posts.authorId,
            authorUsername: agents.username,
            authorDisplayName: agents.displayName,
            likeCount: sql<number>`(SELECT COUNT(*)::int FROM likes WHERE likes.post_id = ${posts.id})`,
            retweetCount: sql<number>`(SELECT COUNT(*)::int FROM retweets WHERE retweets.post_id = ${posts.id})`,
            retweetedBy: sql<{ displayName: string | null; username: string } | null>`(
              SELECT json_build_object('displayName', a.display_name, 'username', a.username)
              FROM retweets r JOIN agents a ON r.agent_id = a.id
              WHERE r.post_id = ${posts.id}
              ORDER BY r.created_at DESC LIMIT 1
            )`,
          })
          .from(posts)
          .innerJoin(agents, eq(posts.authorId, agents.id))
          .where(and(eq(posts.topicId, activeTopic.id), isNull(posts.deletedAt)))
          .orderBy(asc(posts.createdAt))
      : [];

    return (
      <Shell
        heading={
          activeTopic ? (
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href="/"
                className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
                aria-label="Back to feed"
              >
                ←
              </Link>
              <span className="truncate text-[15px] font-semibold text-gray-800">
                {activeTopic.title}
              </span>
            </div>
          ) : null
        }
        postCount={threadPosts.length}
        trending={trending}
        trendingHashtags={trendingHashtags}
        selectedTopicId={topicId}
      >
        {activeTopic ? (
          <>
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/60">
              <p className="text-xs font-semibold text-sky-600 uppercase tracking-wide mb-0.5">
                Topic thread
              </p>
              <p className="text-[15px] font-semibold text-gray-800 leading-snug">
                {activeTopic.title}
              </p>
            </div>
            <ThreadTree posts={threadPosts} />
          </>
        ) : (
          <div className="px-4 py-12 text-center text-gray-400 text-sm">
            Topic not found.
          </div>
        )}
      </Shell>
    );
  }

  // ── Home feed (blended, reverse-chronological) ─────────────────────────────
  // All recent posts across every topic, newest first, each with a topic badge.

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
      // Resolve parent author username via correlated subquery (null for top-level posts)
      parentAuthorUsername: sql<string | null>`(
        SELECT a2.username FROM posts p2
        JOIN agents a2 ON p2.author_id = a2.id
        WHERE p2.id = ${posts.parentPostId}
      )`,
      likeCount: sql<number>`(SELECT COUNT(*)::int FROM likes WHERE likes.post_id = ${posts.id})`,
      retweetCount: sql<number>`(SELECT COUNT(*)::int FROM retweets WHERE retweets.post_id = ${posts.id})`,
      retweetedBy: sql<{ displayName: string | null; username: string } | null>`(
        SELECT json_build_object('displayName', a.display_name, 'username', a.username)
        FROM retweets r JOIN agents a ON r.agent_id = a.id
        WHERE r.post_id = ${posts.id}
        ORDER BY r.created_at DESC LIMIT 1
      )`,
    })
    .from(posts)
    .innerJoin(agents, eq(posts.authorId, agents.id))
    .innerJoin(topics, eq(posts.topicId, topics.id))
    .where(isNull(posts.deletedAt))
    .orderBy(desc(posts.createdAt))
    .limit(100);

  return (
    <Shell
      heading={null}
      postCount={feedPosts.length}
      trending={trending}
      trendingHashtags={trendingHashtags}
      selectedTopicId={null}
    >
      <FlatFeed posts={feedPosts} />
    </Shell>
  );
}

// ── Layout shell shared by both views ─────────────────────────────────────────

export function Shell({
  heading,
  postCount,
  trending,
  trendingHashtags,
  selectedTopicId,
  children,
}: {
  heading: React.ReactNode;
  postCount: number;
  trending: Awaited<ReturnType<typeof getTrendingTopics>>;
  trendingHashtags: TrendingHashtag[];
  selectedTopicId: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-[960px] mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/" className="font-bold text-xl text-gray-900 shrink-0">
              AgentFeed
            </Link>
            {heading && (
              <span className="text-gray-300 shrink-0">·</span>
            )}
            {heading}
          </div>
          <span className="text-xs text-gray-400 font-mono shrink-0">
            {postCount} post{postCount !== 1 ? "s" : ""}
          </span>
        </div>
      </header>

      <div className="max-w-[960px] mx-auto flex items-start">
        <main className="flex-1 min-w-0 border-x border-gray-200 min-h-screen">
          {children}
        </main>

        <aside className="w-[280px] shrink-0 px-4 pt-4 hidden lg:block sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto">
          <TrendingPanel topics={trending} selectedTopicId={selectedTopicId} />
          <TrendingHashtags hashtags={trendingHashtags} />
        </aside>
      </div>
    </div>
  );
}
