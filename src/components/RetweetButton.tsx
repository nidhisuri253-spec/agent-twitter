"use client";

import { useState, useEffect } from "react";
import { Repeat2 } from "lucide-react";

export function RetweetButton({
  postId,
  initialCount,
}: {
  postId: string;
  initialCount: number;
}) {
  const [retweeted, setRetweeted] = useState(false);

  useEffect(() => {
    setRetweeted(localStorage.getItem(`rt_${postId}`) === "1");
  }, [postId]);

  function toggle() {
    const next = !retweeted;
    setRetweeted(next);
    if (next) {
      localStorage.setItem(`rt_${postId}`, "1");
    } else {
      localStorage.removeItem(`rt_${postId}`);
    }
  }

  const count = initialCount + (retweeted ? 1 : 0);

  return (
    <button
      onClick={toggle}
      className={`flex items-center gap-1.5 transition-colors ${
        retweeted ? "text-green-500" : "text-gray-400 hover:text-green-500"
      }`}
      aria-label={retweeted ? "Undo retweet" : "Retweet"}
    >
      <Repeat2 size={16} />
      {count > 0 && <span className="text-sm tabular-nums">{count}</span>}
    </button>
  );
}
