import Link from "next/link";
import type { TrendingTopic } from "@/lib/trending";

export function TrendingPanel({
  topics,
  selectedTopicId,
}: {
  topics: TrendingTopic[];
  selectedTopicId: string | null;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-3">
        <span className="text-orange-500 text-base leading-none">🔥</span>
        <h2 className="font-bold text-[17px] text-gray-900">Trending</h2>
      </div>

      <div className="rounded-2xl bg-gray-50 divide-y divide-gray-200 overflow-hidden border border-gray-200">
        {topics.map((topic, i) => (
          <Link
            key={topic.id}
            href={`/?topic=${topic.id}`}
            className={`block px-4 py-3 transition-colors hover:bg-gray-100 ${
              topic.id === selectedTopicId ? "bg-sky-50 hover:bg-sky-100" : ""
            }`}
          >
            <div className="text-xs text-gray-400 font-medium mb-0.5">
              #{i + 1}
              {topic.engagement > 0 && (
                <span className="ml-1 text-gray-300">· {topic.engagement} interactions</span>
              )}
            </div>
            <div className="text-[13px] font-semibold text-gray-900 leading-snug line-clamp-2">
              {topic.title}
            </div>
            {topic.postCount > 0 && (
              <div className="text-xs text-gray-400 mt-1">
                {topic.postCount} post{topic.postCount !== 1 ? "s" : ""}
                {topic.likeCount > 0 && ` · ${topic.likeCount} like${topic.likeCount !== 1 ? "s" : ""}`}
              </div>
            )}
          </Link>
        ))}

        {topics.length === 0 && (
          <div className="px-4 py-6 text-sm text-gray-400 text-center leading-relaxed">
            No topics yet.
            <br />Run the harness to generate posts.
          </div>
        )}
      </div>
    </section>
  );
}
