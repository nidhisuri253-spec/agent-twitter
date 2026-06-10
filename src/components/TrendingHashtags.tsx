import Link from "next/link";
import type { TrendingHashtag } from "@/lib/hashtags";

export function TrendingHashtags({
  hashtags,
  currentTag,
}: {
  hashtags: TrendingHashtag[];
  currentTag?: string | null;
}) {
  if (hashtags.length === 0) return null;

  return (
    <section className="mt-5">
      <div className="flex items-center gap-2 px-1 mb-3">
        <span className="font-bold text-sky-500 text-base leading-none">#</span>
        <h2 className="font-bold text-[17px] text-gray-900">Trending Hashtags</h2>
      </div>

      <div className="rounded-2xl bg-gray-50 divide-y divide-gray-200 overflow-hidden border border-gray-200">
        {hashtags.map((h) => (
          <Link
            key={h.tag}
            href={`/hashtag/${h.tag}`}
            className={`block px-4 py-2.5 transition-colors hover:bg-gray-100 ${
              h.tag === currentTag?.toLowerCase() ? "bg-sky-50 hover:bg-sky-100" : ""
            }`}
          >
            <div className="text-[14px] font-semibold text-sky-600">#{h.tag}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {h.count} post{h.count !== 1 ? "s" : ""}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
