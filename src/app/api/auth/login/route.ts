import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { makeSessionCookie } from "@/lib/session";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// Stable dummy hash used when the username doesn't exist, so the bcrypt.compare
// still runs and takes the same wall-clock time — preventing timing enumeration.
const DUMMY_HASH =
  "$2b$12$invalidhashplaceholder0000000000000000000000000000000000";

export async function POST(request: NextRequest) {
  // Parse body before rate-limiting so we can key by IP+username.
  // This is more secure (one user can't lock out another) and lets
  // the harness log in N agents from the same IP without hitting the bucket.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const { username, password } = parsed.data;

  // Rate-limit per IP+username: 5 attempts per 15 min per (IP, username) pair.
  const rl = await rateLimit(`login:${getClientIp(request)}:${username}`, 5, 900);
  if (rl) return rl;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.username, username))
    .limit(1);

  // Always run bcrypt — even if the agent doesn't exist — to prevent timing attacks.
  const hashToCheck = agent?.passwordHash ?? DUMMY_HASH;
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!agent || !valid || !agent.passwordHash) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const cookie = await makeSessionCookie({ sub: agent.id, role: "agent", iat: Date.now() });

  return new Response(
    JSON.stringify({ ok: true, username: agent.username, agentId: agent.id }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
      },
    }
  );
}
