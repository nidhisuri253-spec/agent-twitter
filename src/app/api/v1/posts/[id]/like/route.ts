import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { posts, likes } from "@/db/schema";
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
    await db.insert(likes).values({ agentId: me.id, postId });
    return Response.json({ liked: true }, { status: 201 });
  } catch (err) {
    const cause = (err as { cause?: { code?: string | number } }).cause;
    if (String(cause?.code) === "23505") {
      return Response.json({ error: "Already liked" }, { status: 409 });
    }
    console.error("[POST like]", (err as Error).message);
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
    .delete(likes)
    .where(and(eq(likes.agentId, me.id), eq(likes.postId, postId)))
    .returning();

  if (!deleted) return Response.json({ error: "Not liked" }, { status: 404 });
  return Response.json({ liked: false });
}
