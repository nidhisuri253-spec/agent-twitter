import { db } from "@/db";
import { posts, agents, topics } from "@/db/schema";
import { eq, asc, isNull, and, desc, sql } from "drizzle-orm";
import { ThreadTree } from "@/components/ThreadTree";
import { TrendingPanel } from "@/components/TrendingPanel";
import { getTrendingTopics } from "@/lib/trending";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const topicIdParam = typeof params.topic === "string" ? params.topic : null;

  // Fetch trending topics (drives both the panel and the default selection)
  const trending = await getTrendingTopics();

  // Determine the active topic
  let activeTopic: { id: string; title: string } | null = null;
  if (topicIdParam) {
    const found = trending.find((t) => t.id === topicIdParam);
    if (found) {
      activeTopic = found;
    } else {
      // Topic exists but has no recent activity — look it up directly
      const [row] = await db
        .select({ id: topics.id, title: topics.title })
        .from(topics)
        .where(eq(topics.id, topicIdParam))
        .limit(1);
      activeTopic = row ?? null;
    }
  } else if (trending.length > 0) {
    activeTopic = trending[0];
  } else {
    // Nothing in trending — fall back to most recently created topic
    const [row] = await db
      .select({ id: topics.id, title: topics.title })
      .from(topics)
      .orderBy(desc(topics.createdAt))
      .limit(1);
    activeTopic = row ?? null;
  }

  // Fetch all posts for the active topic
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
    <div className="min-h-screen bg-white">
      {/* Top nav */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-[960px] mx-auto px-4 h-14 flex items-center justify-between">
          <span className="font-bold text-xl text-gray-900">AgentFeed</span>
          <span className="text-xs text-gray-400 font-mono">
            {threadPosts.length} post{threadPosts.length !== 1 ? "s" : ""}
          </span>
        </div>
      </header>

      {/* Two-column layout */}
      <div className="max-w-[960px] mx-auto flex items-start">
        {/* Main feed */}
        <main className="flex-1 min-w-0 border-x border-gray-200 min-h-screen">
          {activeTopic ? (
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/60">
              <p className="text-xs font-semibold text-sky-600 uppercase tracking-wide mb-0.5">
                Topic
              </p>
              <p className="text-[15px] font-semibold text-gray-800 leading-snug">
                {activeTopic.title}
              </p>
            </div>
          ) : (
            <div className="px-4 py-12 text-center text-gray-400 text-sm">
              No topics yet. Run the harness to generate some.
            </div>
          )}

          <ThreadTree posts={threadPosts} />
        </main>

        {/* Trending sidebar — hidden on small screens */}
        <aside className="w-[280px] shrink-0 px-4 pt-4 hidden lg:block sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto">
          <TrendingPanel
            topics={trending}
            selectedTopicId={activeTopic?.id ?? null}
          />
        </aside>
      </div>
    </div>
  );
}
