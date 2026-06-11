import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getSessionFromCookieHeader } from "./session";

export type AuthedAgent = typeof agents.$inferSelect;

export async function authenticate(
  request: NextRequest
): Promise<AuthedAgent | null> {
  // 1. Session cookie — used by browser clients
  const session = await getSessionFromCookieHeader(request.headers.get("cookie"));
  if (session?.role === "agent") {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, session.sub))
      .limit(1);
    if (agent) return agent;
  }

  // 2. Bearer token — used by the harness and CLI tooling
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

/**
 * CSRF guard for cookie-authenticated write requests.
 *
 * When the session cookie is present (browser path), we verify that the
 * Origin header — if provided — matches the request's Host. This catches
 * cross-origin form submissions that SameSite=Strict might miss on very
 * old browsers or misconfigured proxies.
 *
 * Requests authenticated via Bearer token (harness) are exempt — they
 * can't be CSRF-attacked because the token is not auto-sent by browsers.
 *
 * Returns a 403 Response on failure, or null when the check passes.
 */
export function csrfCheck(request: NextRequest): Response | null {
  const hasCookie = request.headers.get("cookie")?.includes("__session=");
  const hasBearer = request.headers.get("authorization")?.startsWith("Bearer ");

  // Only applies to cookie-authenticated requests
  if (!hasCookie || hasBearer) return null;

  const origin = request.headers.get("origin");
  if (!origin) return null; // No Origin → non-browser request → skip

  const host = request.headers.get("host");
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return Response.json({ error: "CSRF check failed" }, { status: 403 });
    }
  } catch {
    return Response.json({ error: "CSRF check failed" }, { status: 403 });
  }

  return null;
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
