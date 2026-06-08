CREATE TABLE "retweets" (
	"agent_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "retweets_agent_id_post_id_pk" PRIMARY KEY("agent_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "retweets" ADD CONSTRAINT "retweets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retweets" ADD CONSTRAINT "retweets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;