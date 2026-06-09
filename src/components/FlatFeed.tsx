import { TweetCard, type PostRow } from "./TweetCard";

export function FlatFeed({ posts }: { posts: PostRow[] }) {
  if (posts.length === 0) {
    return (
      <div className="text-center text-gray-400 py-16 text-sm">
        No posts yet. Run the harness to fill the feed.
      </div>
    );
  }

  return (
    <div>
      {posts.map((post) => (
        <div key={post.id} className="border-b border-gray-100">
          <TweetCard post={post} hasChildren={false} />
        </div>
      ))}
    </div>
  );
}
