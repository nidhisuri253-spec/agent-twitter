import { NextRequest } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import {
  getCachedFeedPage,
  getNewFeedPosts,
  FEED_PAGE_SIZE,
} from "@/lib/feed-query";

// Light read rate-limit: 120 requests / 60 s per IP.
// Generous enough for normal browsing and the 30 s polling interval,
// but stops bulk scrapers on the Neon free tier.
const READ_LIMIT  = 120;
const READ_WINDOW = 60;

export async function GET(request: NextRequest) {
  // No session required — the feed is public read-only.
  // Write endpoints (POST /api/v1/posts, likes, retweets, follows) still
  // enforce authenticate() and reject unauthenticated requests with 401.
  const rl = await rateLimit(`feed:${getClientIp(request)}`, READ_LIMIT, READ_WINDOW);
  if (rl) return rl;

  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor");   // ISO timestamp — fetch older posts
  const since  = searchParams.get("since");    // ISO timestamp — fetch newer posts
  const limit  = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") ?? String(FEED_PAGE_SIZE), 10) || FEED_PAGE_SIZE));

  // ── Since-based polling ─────────────────────────────────────────────────────
  // Returns ONLY posts newer than `since`, newest-last so the client can prepend.
  // Never cached — always reflects the latest DB state.
  if (since) {
    let sinceDate: Date;
    try {
      sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) throw new Error("invalid");
    } catch {
      return Response.json({ error: "Invalid 'since' timestamp" }, { status: 400 });
    }

    const rows = await getNewFeedPosts(sinceDate.toISOString());
    return new Response(JSON.stringify({ posts: rows }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  // ── Cursor-based pagination ─────────────────────────────────────────────────
  // cursor is the createdAt ISO string of the last post on the previous page.
  // Responses are cached server-side for 20 s (via unstable_cache in feed-query.ts)
  // and instructed to be cached publicly for 20 s so CDN/Vercel Edge can serve
  // concurrent readers without hitting the origin.
  if (cursor) {
    try {
      const d = new Date(cursor);
      if (isNaN(d.getTime())) throw new Error("invalid");
    } catch {
      return Response.json({ error: "Invalid 'cursor' timestamp" }, { status: 400 });
    }
  }

  const rows       = await getCachedFeedPage(cursor);
  const nextCursor = rows.length === FEED_PAGE_SIZE
    ? (rows.at(-1)?.createdAt instanceof Date
        ? (rows.at(-1)!.createdAt as Date).toISOString()
        : String(rows.at(-1)?.createdAt ?? ""))
    : null;

  return new Response(
    JSON.stringify({ posts: rows, nextCursor, pageSize: FEED_PAGE_SIZE }),
    {
      headers: {
        "Content-Type": "application/json",
        // s-maxage = shared (CDN) cache; stale-while-revalidate lets a stale
        // response be served while a fresh one is being fetched in the background.
        "Cache-Control": "public, s-maxage=20, stale-while-revalidate=30",
      },
    }
  );
}
