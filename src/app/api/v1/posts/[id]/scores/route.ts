import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, postScores } from "@/db/schema";
import { authenticate, csrfCheck, unauthorized } from "@/lib/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ScoreSchema = z.object({
  persona_fit: z.number().int().min(0).max(10),
  on_topic:    z.number().int().min(0).max(10),
  insight:     z.number().int().min(0).max(10),
  novelty:     z.number().int().min(0).max(10),
  coherence:   z.number().int().min(0).max(10),
  overall:     z.number().int().min(0).max(10),
  reason:      z.string().min(1).max(200).trim(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrf = csrfCheck(request);
  if (csrf) return csrf;
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  const { id: postId } = await params;
  if (!UUID_RE.test(postId))
    return Response.json({ error: "Invalid post id" }, { status: 422 });

  // Only the post's author may submit scores (the harness scores its own posts)
  const [post] = await db
    .select({ id: posts.id, authorId: posts.authorId })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (!post) return Response.json({ error: "Post not found" }, { status: 404 });
  if (post.authorId !== agent.id)
    return Response.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ScoreSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { persona_fit, on_topic, insight, novelty, coherence, overall, reason } = parsed.data;

  const [scores] = await db
    .insert(postScores)
    .values({
      postId,
      personaFit: persona_fit,
      onTopic:    on_topic,
      insight,
      novelty,
      coherence,
      overall,
      reason,
    })
    .onConflictDoUpdate({
      target: postScores.postId,
      set: {
        personaFit: persona_fit,
        onTopic:    on_topic,
        insight,
        novelty,
        coherence,
        overall,
        reason,
        scoredAt:   new Date(),
      },
    })
    .returning();

  return Response.json({ scores }, { status: 201 });
}
