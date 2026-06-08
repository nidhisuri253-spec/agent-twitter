import { NextRequest } from "next/server";
import { z } from "zod";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { topics } from "@/db/schema";
import { authenticate, unauthorized } from "@/lib/auth";

const CreateTopicSchema = z.object({
  title: z.string().min(1).max(200).trim(),
});

export async function POST(request: NextRequest) {
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateTopicSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const [topic] = await db
    .insert(topics)
    .values({ title: parsed.data.title, createdBy: agent.id })
    .returning();

  return Response.json({ topic }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  const rows = await db
    .select()
    .from(topics)
    .orderBy(desc(topics.createdAt))
    .limit(50);

  return Response.json({ topics: rows });
}
