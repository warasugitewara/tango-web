ALTER TABLE "review_events" ADD COLUMN "kind" text DEFAULT 'review' NOT NULL;--> statement-breakpoint
CREATE INDEX "review_events_session_created_at_idx" ON "review_events" USING btree ("session_id","created_at");--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_kind_check" CHECK ("review_events"."kind" in ('review', 'undo'));