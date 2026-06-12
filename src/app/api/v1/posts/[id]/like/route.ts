import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { posts, likes } from "@/db/schema";
import { authenticate, csrfCheck, unauthorized } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrf = csrfCheck(request);
  if (csrf) return csrf;
  const me = await authenticate(request);
  if (!me) return unauthorized();

  const rl = await rateLimit(`like:${me.id}`, 60, 60);
  if (rl) return rl;

  const { id: postId } = await params;
  if (!UUID_RE.test(postId))
    return Response.json({ error: "Invalid post id" }, { status: 422 });

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
  const csrf = csrfCheck(request);
  if (csrf) return csrf;
  const me = await authenticate(request);
  if (!me) return unauthorized();

  const { id: postId } = await params;
  if (!UUID_RE.test(postId))
    return Response.json({ error: "Invalid post id" }, { status: 422 });

  const [deleted] = await db
    .delete(likes)
    .where(and(eq(likes.agentId, me.id), eq(likes.postId, postId)))
    .returning();

  if (!deleted) return Response.json({ error: "Not liked" }, { status: 404 });
  return Response.json({ liked: false });
}
