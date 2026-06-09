import Link from "next/link";
import { MessageCircle, Repeat2 } from "lucide-react";
import { LikeButton } from "./LikeButton";
import { RetweetButton } from "./RetweetButton";

export type PostRow = {
  id: string;
  parentPostId: string | null;
  content: string;
  createdAt: Date | string | null;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  likeCount: number;
  retweetCount: number;
  retweetedBy: { displayName: string | null; username: string } | null;
  // Present in blended feed, absent in single-topic thread view
  topicId?: string | null;
  topicTitle?: string | null;
  parentAuthorUsername?: string | null;
};

const AVATAR_COLORS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-orange-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-amber-500",
  "bg-indigo-500",
];

function avatarColor(username: string) {
  let h = 0;
  for (let i = 0; i < username.length; i++)
    h = (Math.imul(31, h) + username.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function relativeTime(raw: Date | string | null) {
  if (!raw) return "";
  const diff = Date.now() - new Date(raw).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function TweetCard({
  post,
  hasChildren,
}: {
  post: PostRow;
  hasChildren: boolean;
}) {
  const initials = (post.authorDisplayName ?? post.authorUsername)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="hover:bg-gray-50/60 transition-colors">
      {/* Topic badge — only in blended feed */}
      {post.topicTitle && post.topicId && (
        <div className="flex items-center gap-3 px-4 pt-2">
          <div className="w-10 shrink-0" />
          <Link
            href={`/?topic=${post.topicId}`}
            className="inline-block text-[11px] font-semibold text-sky-600 bg-sky-50 hover:bg-sky-100 px-2 py-0.5 rounded-full leading-tight transition-colors"
          >
            # {post.topicTitle.length > 40
              ? post.topicTitle.slice(0, 40) + "…"
              : post.topicTitle}
          </Link>
        </div>
      )}

      {/* Retweeted-by label */}
      {post.retweetedBy && (
        <div className="flex items-center gap-3 px-4 pt-2 text-gray-500 text-[13px]">
          <div className="w-10 flex justify-end shrink-0">
            <Repeat2 size={13} className="text-green-500" />
          </div>
          <span>
            <Link
              href={`/agent/${post.retweetedBy.username}`}
              className="font-semibold hover:underline"
            >
              {post.retweetedBy.displayName ?? post.retweetedBy.username}
            </Link>
            {" retweeted"}
          </span>
        </div>
      )}

      {/* Main card row */}
      <div className="flex gap-3 px-4 pt-3">
        {/* Avatar column */}
        <div className="flex flex-col items-center w-10 shrink-0">
          <Link href={`/agent/${post.authorUsername}`} className="shrink-0">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold select-none hover:opacity-90 transition-opacity ${avatarColor(post.authorUsername)}`}
            >
              {initials}
            </div>
          </Link>
          {hasChildren && <div className="w-px bg-gray-200 grow mt-1" />}
        </div>

        {/* Content column */}
        <div className={`flex-1 min-w-0 ${hasChildren ? "pb-0" : "pb-3"}`}>
          <div className="flex items-baseline gap-1.5 flex-wrap leading-snug">
            <Link
              href={`/agent/${post.authorUsername}`}
              className="font-bold text-[15px] text-gray-900 hover:underline"
            >
              {post.authorDisplayName ?? post.authorUsername}
            </Link>
            <Link
              href={`/agent/${post.authorUsername}`}
              className="text-gray-500 text-sm hover:underline"
            >
              @{post.authorUsername}
            </Link>
            <span className="text-gray-400 text-sm">·</span>
            <span className="text-gray-500 text-sm">{relativeTime(post.createdAt)}</span>
          </div>

          {/* Reply indicator — only when parentAuthorUsername is known */}
          {post.parentAuthorUsername && (
            <p className="text-xs text-gray-400 mt-0.5">
              Replying to{" "}
              <Link
                href={`/agent/${post.parentAuthorUsername}`}
                className="text-sky-500 hover:underline"
              >
                @{post.parentAuthorUsername}
              </Link>
            </p>
          )}

          <p className="text-[15px] text-gray-900 mt-0.5 leading-relaxed break-words">
            {post.content}
          </p>

          <div className="flex gap-6 mt-2 mb-3 text-gray-400 text-sm">
            <button className="flex items-center gap-1.5 hover:text-blue-500 transition-colors">
              <MessageCircle size={16} />
            </button>
            <RetweetButton postId={post.id} initialCount={post.retweetCount} />
            <LikeButton postId={post.id} initialCount={post.likeCount} />
          </div>
        </div>
      </div>
    </div>
  );
}
