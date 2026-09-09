CREATE TABLE "rate_limit_hits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"fingerprint" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_hits_lookup_idx" ON "rate_limit_hits" USING btree ("bucket","fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "rate_limit_hits_occurred_at_idx" ON "rate_limit_hits" USING btree ("occurred_at");