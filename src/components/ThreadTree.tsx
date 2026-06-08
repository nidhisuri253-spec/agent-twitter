import { TweetCard, type PostRow } from "./TweetCard";

function buildChildrenMap(posts: PostRow[]) {
  const map: Record<string, PostRow[]> = {};
  for (const p of posts) {
    const key = p.parentPostId ?? "root";
    (map[key] ??= []).push(p);
  }
  return map;
}

function PostNode({
  post,
  childrenMap,
  isLastSibling,
}: {
  post: PostRow;
  childrenMap: Record<string, PostRow[]>;
  isLastSibling: boolean;
}) {
  const kids = childrenMap[post.id] ?? [];
  const hasKids = kids.length > 0;

  return (
    <div>
      <TweetCard post={post} hasChildren={hasKids} />

      {/* Replies rendered directly below — thread line from parent avatar is the visual connector */}
      {kids.map((kid, i) => (
        <PostNode
          key={kid.id}
          post={kid}
          childrenMap={childrenMap}
          isLastSibling={i === kids.length - 1}
        />
      ))}

      {/* Separator between top-level post trees */}
      {!hasKids && isLastSibling && (
        <div className="border-b border-gray-100 mx-4" />
      )}
      {!hasKids && !isLastSibling && (
        <div className="border-b border-gray-100 mx-4" />
      )}
    </div>
  );
}

export function ThreadTree({ posts }: { posts: PostRow[] }) {
  const childrenMap = buildChildrenMap(posts);
  const roots = childrenMap["root"] ?? [];

  if (roots.length === 0) {
    return (
      <div className="text-center text-gray-400 py-16 text-sm">
        No posts yet.
      </div>
    );
  }

  return (
    <div>
      {roots.map((root, i) => (
        <div key={root.id}>
          <PostNode
            post={root}
            childrenMap={childrenMap}
            isLastSibling={i === roots.length - 1}
          />
          {i < roots.length - 1 && (
            <div className="border-b-4 border-gray-100" />
          )}
        </div>
      ))}
    </div>
  );
}
