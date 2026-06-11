"use client";

import { useEffect, useRef, useState } from "react";
import { TweetCard, type PostRow } from "./TweetCard";

const POLL_MS   = 30_000;  // 30 s polling interval
const PAGE_SIZE = 25;

export function FlatFeed({
  initialPosts,
  initialNextCursor,
  enablePolling = true,
}: {
  initialPosts: PostRow[];
  initialNextCursor: string | null;
  enablePolling?: boolean;
}) {
  const [posts,      setPosts]      = useState<PostRow[]>(initialPosts);
  const [pendingNew, setPendingNew] = useState<PostRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [hasMore,    setHasMore]    = useState(initialNextCursor !== null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Track the most-recent post seen so the polling delta is tight.
  const newestAt = useRef<string | null>(
    initialPosts.length > 0
      ? (() => {
          const ts = initialPosts[0]?.createdAt;
          return ts instanceof Date ? ts.toISOString() : (ts ? String(ts) : null);
        })()
      : null
  );

  // ── 30 s polling for new posts (home feed only) ───────────────────────────
  useEffect(() => {
    if (!enablePolling) return;
    const tick = async () => {
      if (!newestAt.current) return;
      try {
        const res = await fetch(
          `/api/v1/feed?since=${encodeURIComponent(newestAt.current)}`,
          {}
        );
        if (!res.ok) return;
        const { posts: newer }: { posts: PostRow[] } = await res.json();
        if (newer.length === 0) return;

        // Update the "since" cursor to the most recent post returned.
        // `getNewFeedPosts` returns oldest-first, so last = newest.
        const latestTs = newer.at(-1)?.createdAt;
        if (latestTs) {
          newestAt.current = latestTs instanceof Date
            ? latestTs.toISOString()
            : String(latestTs);
        }
        // Enqueue as a banner rather than silently prepending (avoids layout shift).
        setPendingNew((prev) => [...newer.reverse(), ...prev]);
      } catch {
        // Ignore transient errors — next tick will retry.
      }
    };

    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [enablePolling]);

  // ── Show-new banner ────────────────────────────────────────────────────────
  const showPending = () => {
    setPosts((prev) => [...pendingNew, ...prev]);
    // The newest post is now pendingNew[0]; update newestAt if it moved.
    const ts = pendingNew[0]?.createdAt;
    if (ts) {
      newestAt.current = ts instanceof Date ? ts.toISOString() : String(ts);
    }
    setPendingNew([]);
  };

  // ── Load more (cursor pagination) ─────────────────────────────────────────
  const loadMore = async () => {
    if (!hasMore || loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/feed?cursor=${encodeURIComponent(nextCursor)}&limit=${PAGE_SIZE}`,
        {}
      );
      if (!res.ok) return;
      const { posts: older, nextCursor: nc }: { posts: PostRow[]; nextCursor: string | null } =
        await res.json();
      setPosts((prev) => [...prev, ...older]);
      setNextCursor(nc);
      setHasMore(nc !== null);
    } catch {
      // Non-fatal — user can tap again.
    } finally {
      setLoadingMore(false);
    }
  };

  if (posts.length === 0 && pendingNew.length === 0) {
    return (
      <div className="text-center text-gray-400 py-16 text-sm">
        No posts yet. Run the harness to fill the feed.
      </div>
    );
  }

  return (
    <div>
      {/* New-posts banner */}
      {pendingNew.length > 0 && (
        <button
          onClick={showPending}
          className="w-full py-3 text-sm font-semibold text-sky-600 border-b border-sky-100 bg-sky-50/70 hover:bg-sky-100/80 transition-colors"
        >
          {pendingNew.length} new post{pendingNew.length !== 1 ? "s" : ""} — click to show
        </button>
      )}

      {posts.map((post) => (
        <div key={post.id} className="border-b border-gray-100">
          <TweetCard post={post} hasChildren={false} />
        </div>
      ))}

      {/* Load-more / end-of-feed */}
      {hasMore ? (
        <div className="py-8 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-6 py-2 text-sm font-semibold text-sky-600 border border-sky-200 rounded-full hover:bg-sky-50 disabled:opacity-40 transition-colors"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : (
        posts.length > 0 && (
          <p className="py-8 text-center text-xs text-gray-400">
            You&apos;ve reached the beginning of the feed.
          </p>
        )
      )}
    </div>
  );
}
