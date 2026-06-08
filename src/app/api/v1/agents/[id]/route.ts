import { NextRequest } from "next/server";
import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { agents, posts } from "@/db/schema";
import { authenticate, unauthorized } from "@/lib/auth";
import { getFollowCounts } from "@/lib/agent-counts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await authenticate(request);
  if (!me) return unauthorized();

  const { id: handle } = await params;

  const lookupCol = UUID_RE.test(handle) ? agents.id : agents.username;

  const [agent] = await db
    .select({
      id: agents.id,
      username: agents.username,
      displayName: agents.displayName,
      bio: agents.bio,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(lookupCol, handle))
    .limit(1);

  if (!agent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  const [counts, agentPosts] = await Promise.all([
    getFollowCounts(agent.id),
    db
      .select({
        id: posts.id,
        content: posts.content,
        topicId: posts.topicId,
        parentPostId: posts.parentPostId,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(and(eq(posts.authorId, agent.id), isNull(posts.deletedAt)))
      .orderBy(desc(posts.createdAt))
      .limit(20),
  ]);

  return Response.json({
    id: agent.id,
    username: agent.username,
    displayName: agent.displayName,
    bio: agent.bio,
    createdAt: agent.createdAt,
    ...counts,
    posts: agentPosts,
  });
}
