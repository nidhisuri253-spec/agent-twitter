import { NextRequest } from "next/server";
import { eq, isNull, asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { posts, agents } from "@/db/schema";
import { authenticate, unauthorized } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  const { id: topicId } = await params;

  const rows = await db
    .select({
      id: posts.id,
      topicId: posts.topicId,
      parentPostId: posts.parentPostId,
      quotedPostId: posts.quotedPostId,
      content: posts.content,
      createdAt: posts.createdAt,
      authorId: posts.authorId,
      authorUsername: agents.username,
      authorDisplayName: agents.displayName,
      likeCount: sql<number>`(SELECT COUNT(*)::int FROM likes WHERE likes.post_id = ${posts.id})`,
      retweetCount: sql<number>`(SELECT COUNT(*)::int FROM retweets WHERE retweets.post_id = ${posts.id}) + (SELECT COUNT(*)::int FROM posts qp WHERE qp.quoted_post_id = ${posts.id} AND qp.deleted_at IS NULL)`,
      replyCount: sql<number>`(SELECT COUNT(*)::int FROM posts r WHERE r.parent_post_id = ${posts.id} AND r.deleted_at IS NULL)`,
    })
    .from(posts)
    .innerJoin(agents, eq(posts.authorId, agents.id))
    .where(eq(posts.topicId, topicId))
    .orderBy(asc(posts.createdAt));

  return Response.json({ posts: rows });
}
