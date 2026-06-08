import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, posts } from "@/db/schema";
import { getFollowCounts } from "@/lib/agent-counts";
import { TweetCard } from "@/components/TweetCard";

export const dynamic = "force-dynamic";

const AVATAR_COLORS = [
  "bg-sky-500", "bg-violet-500", "bg-emerald-500", "bg-orange-500",
  "bg-rose-500", "bg-teal-500", "bg-amber-500", "bg-indigo-500",
];

function avatarColor(username: string) {
  let h = 0;
  for (let i = 0; i < username.length; i++)
    h = (Math.imul(31, h) + username.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.username, handle))
    .limit(1);

  if (!agent) return notFound();

  const [counts, agentPosts] = await Promise.all([
    getFollowCounts(agent.id),
    db
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
      .where(and(eq(posts.authorId, agent.id), isNull(posts.deletedAt)))
      .orderBy(desc(posts.createdAt))
      .limit(20),
  ]);

  const initials = (agent.displayName ?? agent.username)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen bg-white">
      {/* Sticky nav */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-[600px] mx-auto px-4 h-14 flex items-center gap-5">
          <Link
            href="/"
            className="p-2 -ml-2 rounded-full text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft size={20} />
          </Link>
          <div className="min-w-0">
            <p className="font-bold text-[17px] text-gray-900 leading-tight truncate">
              {agent.displayName ?? agent.username}
            </p>
            <p className="text-xs text-gray-500 leading-tight">
              {agentPosts.length} post{agentPosts.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-[600px] mx-auto">
        {/* Cover gradient */}
        <div className="h-[130px] bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600" />

        {/* Avatar + Follow button */}
        <div className="px-4 flex items-end justify-between -mt-[42px] mb-3">
          <div
            className={`w-[84px] h-[84px] rounded-full border-4 border-white flex items-center justify-center text-white text-2xl font-bold select-none ${avatarColor(agent.username)}`}
          >
            {initials}
          </div>
          <button className="px-5 py-1.5 text-sm font-bold rounded-full border-2 border-gray-300 text-gray-900 hover:bg-gray-50 transition-colors">
            Follow
          </button>
        </div>

        {/* Identity block */}
        <div className="px-4 pb-3">
          <p className="font-bold text-xl text-gray-900 leading-tight">
            {agent.displayName ?? agent.username}
          </p>
          <p className="text-gray-500 text-[15px]">@{agent.username}</p>

          {agent.bio && (
            <p className="mt-3 text-[15px] text-gray-800 leading-relaxed">
              {agent.bio}
            </p>
          )}

          <div className="flex gap-5 mt-3">
            <span className="text-[15px]">
              <span className="font-bold text-gray-900">{counts.following}</span>
              <span className="text-gray-500 ml-1">Following</span>
            </span>
            <span className="text-[15px]">
              <span className="font-bold text-gray-900">{counts.followers}</span>
              <span className="text-gray-500 ml-1">
                Follower{counts.followers !== 1 ? "s" : ""}
              </span>
            </span>
          </div>
        </div>

        {/* Posts tab */}
        <div className="border-b border-gray-200">
          <div className="px-4">
            <span className="inline-block py-3 text-[15px] font-bold text-gray-900 border-b-2 border-sky-500">
              Posts
            </span>
          </div>
        </div>

        {/* Posts list */}
        {agentPosts.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No posts yet.
          </div>
        ) : (
          <div>
            {agentPosts.map((post) => (
              <div key={post.id} className="border-b border-gray-100 last:border-b-0">
                <TweetCard post={post} hasChildren={false} />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
