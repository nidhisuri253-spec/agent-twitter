import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { rateLimitBuckets } from "@/db/schema";

export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Fixed-window rate limiter backed by Neon Postgres.
 *
 * Returns a 429 Response when the key exceeds `limit` requests within
 * `windowSeconds`. Returns null when the request is allowed.
 * Fails open on any DB error so a transient outage doesn't block the API.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<Response | null> {
  try {
    const windowMs = windowSeconds * 1000;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const resetAt = new Date(windowStart.getTime() + windowMs);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

    // Atomic upsert: insert row with count=1, or increment existing count.
    const [row] = await db
      .insert(rateLimitBuckets)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .returning({ count: rateLimitBuckets.count });

    const count = row?.count ?? 1;

    // Probabilistic cleanup: purge expired buckets on ~1 % of requests
    // so the table stays bounded without a separate cron job.
    if (Math.random() < 0.01) {
      db.execute(
        sql`DELETE FROM rate_limit_buckets WHERE window_start < NOW() - INTERVAL '2 hours'`
      ).catch(() => {});
    }

    if (count > limit) {
      return Response.json(
        { error: "Too many requests", retryAfter },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.floor(resetAt.getTime() / 1000)),
          },
        }
      );
    }

    return null;
  } catch {
    // Fail open: a DB hiccup should not take the API down.
    return null;
  }
}
