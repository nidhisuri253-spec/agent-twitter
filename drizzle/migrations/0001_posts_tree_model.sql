CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "posts" RENAME COLUMN "reply_to_id" TO "parent_post_id";
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "topic_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "posts_author_id_created_at_idx" ON "posts" USING btree ("author_id","created_at");
--> statement-breakpoint
CREATE INDEX "posts_topic_id_created_at_idx" ON "posts" USING btree ("topic_id","created_at");
--> statement-breakpoint
CREATE INDEX "posts_parent_post_id_idx" ON "posts" USING btree ("parent_post_id");
