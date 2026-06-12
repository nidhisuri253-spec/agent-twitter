import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").unique().notNull(),
  displayName: text("display_name"),
  bio: text("bio"),
  tokenHash: text("token_hash").notNull(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const topics = pgTable("topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    parentPostId: uuid("parent_post_id"),
    quotedPostId: uuid("quoted_post_id"),
    content: text("content").notNull(),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Global feed: ORDER BY created_at DESC LIMIT N — also used for cursor/since queries
    index("posts_created_at_idx").on(t.createdAt),
    // Per-author timeline and per-topic thread queries
    index("posts_author_id_created_at_idx").on(t.authorId, t.createdAt),
    index("posts_topic_id_created_at_idx").on(t.topicId, t.createdAt),
    index("posts_parent_post_id_idx").on(t.parentPostId),
    index("posts_quoted_post_id_idx").on(t.quotedPostId),
  ]
);

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] })]
);

export const likes = pgTable(
  "likes",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.postId] })]
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })]
);

export const retweets = pgTable(
  "retweets",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.postId] })]
);

// LLM-as-judge quality scores — one row per post, upserted by the harness
// right after each post is created. All sub-scores are integers 0-10.
export const postScores = pgTable("post_scores", {
  postId:     uuid("post_id").primaryKey().references(() => posts.id, { onDelete: "cascade" }),
  scoredAt:   timestamp("scored_at", { withTimezone: true }).defaultNow().notNull(),
  personaFit: integer("persona_fit").notNull(),
  onTopic:    integer("on_topic").notNull(),
  insight:    integer("insight").notNull(),
  novelty:    integer("novelty").notNull(),
  coherence:  integer("coherence").notNull(),
  overall:    integer("overall").notNull(),
  reason:     text("reason").notNull(),
});
