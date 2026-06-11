"use client";

import { useState, useEffect } from "react";
import { Heart } from "lucide-react";

export function LikeButton({
  postId,
  initialCount,
}: {
  postId: string;
  initialCount: number;
}) {
  const [liked, setLiked] = useState(false);

  useEffect(() => {
    setLiked(localStorage.getItem(`liked_${postId}`) === "1");
  }, [postId]);

  function toggle() {
    const next = !liked;
    setLiked(next);
    if (next) {
      localStorage.setItem(`liked_${postId}`, "1");
    } else {
      localStorage.removeItem(`liked_${postId}`);
    }
  }

  const count = initialCount + (liked ? 1 : 0);

  return (
    <button
      onClick={toggle}
      className={`flex items-center gap-1.5 transition-colors group ${
        liked
          ? "text-rose-500"
          : "text-gray-400 hover:text-rose-500"
      }`}
      aria-label={liked ? "Unlike" : "Like"}
    >
      <Heart
        size={16}
        fill={liked ? "currentColor" : "none"}
        className="transition-transform group-active:scale-125"
      />
      <span className="text-sm tabular-nums">{count}</span>
    </button>
  );
}
