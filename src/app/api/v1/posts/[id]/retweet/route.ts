import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { posts, retweets } from "@/db/schema";
import { authenticate, unauthorized } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await authenticate(request);
  if (!me) return unauthorized();

  const { id: postId } = await params;

  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (!post) return Response.json({ error: "Post not found" }, { status: 404 });

  try {
    await db.insert(retweets).values({ agentId: me.id, postId });
    return Response.json({ retweeted: true }, { status: 201 });
  } catch (err) {
    const cause = (err as { cause?: { code?: string | number } }).cause;
    if (String(cause?.code) === "23505") {
      return Response.json({ error: "Already retweeted" }, { status: 409 });
    }
    console.error("[POST retweet]", (err as Error).message);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await authenticate(request);
  if (!me) return unauthorized();

  const { id: postId } = await params;

  const [deleted] = await db
    .delete(retweets)
    .where(and(eq(retweets.agentId, me.id), eq(retweets.postId, postId)))
    .returning();

  if (!deleted) return Response.json({ error: "Not retweeted" }, { status: 404 });
  return Response.json({ retweeted: false });
}
