import { eq } from "drizzle-orm";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { follows } from "@/db/schema";

export async function getFollowCounts(agentId: string) {
  const [[{ followers }], [{ following }]] = await Promise.all([
    db.select({ followers: count() }).from(follows).where(eq(follows.followeeId, agentId)),
    db.select({ following: count() }).from(follows).where(eq(follows.followerId, agentId)),
  ]);
  return { followers, following };
}
