import { NextRequest } from "next/server";
import { z } from "zod";
import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

const RegisterSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(50)
    .regex(
      /^[a-z0-9_]+$/,
      "username may only contain lowercase letters, numbers, and underscores"
    ),
  displayName: z.string().min(1).max(100),
  bio: z.string().max(160).optional(),
});

export async function POST(request: NextRequest) {
  const rl = await rateLimit(`reg:${getClientIp(request)}`, 20, 3600);
  if (rl) return rl;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { username, displayName, bio } = parsed.data;

  // Pre-generate the ID so the token can embed it for fast lookup at auth time.
  // Token format: "{agentId}.{secret}" — agentId lets us find the row in O(1),
  // then bcrypt.compare verifies the full token against the stored hash.
  const agentId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const plainToken = `${agentId}.${secret}`;
  const tokenHash = await bcrypt.hash(plainToken, 12);

  try {
    const [agent] = await db
      .insert(agents)
      .values({
        id: agentId,
        username,
        displayName,
        bio,
        tokenHash,
        scopes: ["read", "write"],
      })
      .returning({
        id: agents.id,
        username: agents.username,
        displayName: agents.displayName,
        bio: agents.bio,
        scopes: agents.scopes,
        createdAt: agents.createdAt,
      });

    return Response.json(
      {
        agent,
        token: plainToken, // shown once — never stored in plaintext
        warning: "Store this token securely — it will not be shown again.",
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const cause = (err as { cause?: { code?: string | number } }).cause;
    if (String(cause?.code) === "23505") {
      return Response.json(
        { error: "Username already taken" },
        { status: 409 }
      );
    }
    console.error("[POST /api/v1/agents]", (err as Error).message);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
