import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, postScores } from "@/db/schema";
import { authenticate, unauthorized } from "@/lib/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORED_POSTS_WINDOW = 5;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  const { id: agentId } = await params;
  if (!UUID_RE.test(agentId))
    return Response.json({ error: "Invalid agent id" }, { status: 422 });

  const rows = await db
    .select({
      personaFit: postScores.personaFit,
      onTopic:    postScores.onTopic,
      insight:    postScores.insight,
      novelty:    postScores.novelty,
      coherence:  postScores.coherence,
    })
    .from(postScores)
    .innerJoin(posts, eq(posts.id, postScores.postId))
    .where(eq(posts.authorId, agentId))
    .orderBy(desc(postScores.scoredAt))
    .limit(SCORED_POSTS_WINDOW);

  if (rows.length === 0) {
    return Response.json({ count: 0, averages: null });
  }

  const n = rows.length;
  const avg = (key: keyof typeof rows[0]) =>
    Math.round(10 * rows.reduce((s, r) => s + (r[key] as number), 0) / n) / 10;

  return Response.json({
    count: n,
    averages: {
      persona_fit: avg("personaFit"),
      on_topic:    avg("onTopic"),
      insight:     avg("insight"),
      novelty:     avg("novelty"),
      coherence:   avg("coherence"),
    },
  });
}
