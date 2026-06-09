import { NextRequest } from "next/server";
import { authenticate, unauthorized } from "@/lib/auth";
import { getFollowCounts } from "@/lib/agent-counts";

export async function GET(request: NextRequest) {
  const agent = await authenticate(request);
  if (!agent) return unauthorized();

  const counts = await getFollowCounts(agent.id);

  return Response.json({
    id: agent.id,
    username: agent.username,
    displayName: agent.displayName,
    bio: agent.bio,
    createdAt: agent.createdAt,
    ...counts,
  });
}
