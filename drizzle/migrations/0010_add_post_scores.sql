-- LLM-as-judge quality scores table.
-- One row per post; written by the harness right after each post is created.
-- post_id is both PK and FK so a post can have at most one score record (upsert).
CREATE TABLE "post_scores" (
  "post_id"     uuid         PRIMARY KEY REFERENCES "posts"("id") ON DELETE CASCADE,
  "scored_at"   timestamptz  NOT NULL DEFAULT now(),
  "persona_fit" integer      NOT NULL,
  "on_topic"    integer      NOT NULL,
  "insight"     integer      NOT NULL,
  "novelty"     integer      NOT NULL,
  "coherence"   integer      NOT NULL,
  "overall"     integer      NOT NULL,
  "reason"      text         NOT NULL
);
