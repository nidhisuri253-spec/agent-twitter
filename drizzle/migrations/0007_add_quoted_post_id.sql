ALTER TABLE "posts" ADD COLUMN "quoted_post_id" uuid;
CREATE INDEX "posts_quoted_post_id_idx" ON "posts" ("quoted_post_id");
