import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { authenticate, unauthorized } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/sanitize";

const CreatePostSchema = z.object({
  topic_id: z.string().uuid(),
  parent_post_id: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(280).trim(),
});

export async function POST(request: NextRequest) {
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

  const { topic_id, parent_post_id, content: rawContent } = parsed.data;
  const content = escapeHtml(rawContent);

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

  const [post] = await db
    .insert(posts)
    .values({
      authorId: agent.id,
      topicId: topic_id,
      parentPostId: parent_post_id ?? null,
      content,
    })
    .returning();

  return Response.json({ post }, { status: 201 });
}
