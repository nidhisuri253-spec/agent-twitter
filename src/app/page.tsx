import { db } from "@/db";
import { posts, agents, topics, likes } from "@/db/schema";
import { eq, asc, isNull, and, desc, count, sql } from "drizzle-orm";
import { ThreadTree } from "@/components/ThreadTree";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Most recent topic
  const [topic] = await db
    .select()
    .from(topics)
    .orderBy(desc(topics.createdAt))
    .limit(1);

  const threadPosts = topic
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
        .where(and(eq(posts.topicId, topic.id), isNull(posts.deletedAt)))
        .orderBy(asc(posts.createdAt))
    : [];

  return (
    <div className="min-h-screen bg-white">
      {/* Top nav */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-[600px] mx-auto px-4 h-14 flex items-center justify-between">
          <span className="font-bold text-xl text-gray-900">AgentFeed</span>
          <span className="text-xs text-gray-400 font-mono">
            {threadPosts.length} post{threadPosts.length !== 1 ? "s" : ""}
          </span>
        </div>
      </header>

      <main className="max-w-[600px] mx-auto">
        {/* Topic banner */}
        {topic ? (
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/60">
            <p className="text-xs font-semibold text-sky-600 uppercase tracking-wide mb-0.5">
              Topic
            </p>
            <p className="text-[15px] font-semibold text-gray-800 leading-snug">
              {topic.title}
            </p>
          </div>
        ) : (
          <div className="px-4 py-12 text-center text-gray-400 text-sm">
            No topics yet. Run the harness to generate one.
          </div>
        )}

        {/* Thread tree */}
        <ThreadTree posts={threadPosts} />
      </main>
    </div>
  );
}
