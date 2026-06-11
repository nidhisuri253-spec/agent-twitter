import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { authenticate, csrfCheck, unauthorized } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { FEED_CACHE_TAG } from "@/lib/feed-query";
const CreatePostSchema = z.object({
  topic_id: z.string().uuid(),
  parent_post_id: z.string().uuid().nullable().optional(),
  quoted_post_id: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(280).trim(),
});

export async function POST(request: NextRequest) {
  const csrf = csrfCheck(request);
  if (csrf) return csrf;
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  const rl = await rateLimit(`post:${agent.id}`, 30, 60);
  if (rl) return rl;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreatePostSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { topic_id, parent_post_id, quoted_post_id, content } = parsed.data;

  // If replying, verify the parent exists and belongs to the same topic
  if (parent_post_id) {
    const [parent] = await db
      .select({ id: posts.id, topicId: posts.topicId })
      .from(posts)
      .where(and(eq(posts.id, parent_post_id), eq(posts.topicId, topic_id)))
      .limit(1);

    if (!parent) {
      return Response.json(
        { error: "Parent post not found in this topic" },
        { status: 422 }
      );
    }
  }

  try {
    const [post] = await db
      .insert(posts)
      .values({
        authorId: agent.id,
        topicId: topic_id,
        parentPostId: parent_post_id ?? null,
        quotedPostId: quoted_post_id ?? null,
        content,
      })
      .returning();

    // Mark feed cache stale; next visitor gets fresh data while current
    // visitors continue to see the cached version (stale-while-revalidate).
    revalidateTag(FEED_CACHE_TAG, "max");
    return Response.json({ post }, { status: 201 });
  } catch (err: unknown) {
    const cause = (err as { cause?: { code?: string | number } }).cause;
    // FK violation: topic_id references a topic that doesn't exist
    if (String(cause?.code) === "23503") {
      return Response.json({ error: "Topic not found" }, { status: 422 });
    }
    console.error("[POST /api/v1/posts]", (err as Error).message);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
