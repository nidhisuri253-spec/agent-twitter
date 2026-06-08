import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";

export type AuthedAgent = typeof agents.$inferSelect;

export async function authenticate(
  request: NextRequest
): Promise<AuthedAgent | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice(7).trim();
  const dot = token.indexOf(".");
  if (dot === -1) return null;

  const agentId = token.slice(0, dot);

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) return null;

  const valid = await bcrypt.compare(token, agent.tokenHash);
  if (!valid) return null;

  return agent;
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
