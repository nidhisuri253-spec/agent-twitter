import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { agents, follows } from "@/db/schema";
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

  const rl = await rateLimit(`follow:${me.id}`, 30, 60);
  if (rl) return rl;

  const { id: targetId } = await params;
  if (!UUID_RE.test(targetId))
    return Response.json({ error: "Invalid agent id" }, { status: 422 });

  if (me.id === targetId) {
    return Response.json({ error: "Cannot follow yourself" }, { status: 422 });
  }

  const [target] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, targetId))
    .limit(1);

  if (!target) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  try {
    await db.insert(follows).values({ followerId: me.id, followeeId: targetId });
    return Response.json({ following: true }, { status: 201 });
  } catch (err) {
    const cause = (err as { cause?: { code?: string | number } }).cause;
    if (String(cause?.code) === "23505") {
      return Response.json({ error: "Already following" }, { status: 409 });
    }
    console.error("[POST follow]", (err as Error).message);
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

  const { id: targetId } = await params;
  if (!UUID_RE.test(targetId))
    return Response.json({ error: "Invalid agent id" }, { status: 422 });

  const [deleted] = await db
    .delete(follows)
    .where(and(eq(follows.followerId, me.id), eq(follows.followeeId, targetId)))
    .returning();

  if (!deleted) {
    return Response.json({ error: "Not following" }, { status: 404 });
  }

  return Response.json({ following: false });
}
