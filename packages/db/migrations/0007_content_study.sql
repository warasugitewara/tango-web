CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deck_id" uuid NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_key" text,
	"external_id" text,
	"source_url" text,
	"source_title" text,
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_status_check" CHECK ("cards"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"new_card_limit" integer DEFAULT 20 NOT NULL,
	"archived_at" timestamp with time zone,
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decks_new_card_limit_check" CHECK ("decks"."new_card_limit" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "card_schedules" (
	"card_id" uuid PRIMARY KEY NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"last_review_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"scheduler_version" text NOT NULL,
	"request_retention" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_schedules_state_check" CHECK ("card_schedules"."state" in ('new', 'learning', 'review', 'relearning')),
	CONSTRAINT "card_schedules_version_check" CHECK ("card_schedules"."version" >= 1),
	CONSTRAINT "card_schedules_request_retention_check" CHECK ("card_schedules"."request_retention" between 0.70 and 0.97)
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"learning_day" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"response_duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_events_rating_check" CHECK ("review_events"."rating" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"deck_ids" jsonb,
	"learning_day" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "study_sessions_mode_check" CHECK ("study_sessions"."mode" in ('all', 'selected')),
	CONSTRAINT "study_sessions_deck_ids_check" CHECK (("study_sessions"."mode" = 'selected') = ("study_sessions"."deck_ids" is not null))
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_schedules" ADD CONSTRAINT "card_schedules_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_deck_id_idx" ON "cards" USING btree ("deck_id");--> statement-breakpoint
CREATE INDEX "cards_trashed_at_idx" ON "cards" USING btree ("trashed_at");--> statement-breakpoint
CREATE INDEX "cards_content_hash_idx" ON "cards" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_external_identity_uidx" ON "cards" USING btree ("deck_id","source_key","external_id") WHERE "cards"."source_key" is not null and "cards"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "decks_principal_id_idx" ON "decks" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "decks_trashed_at_idx" ON "decks" USING btree ("trashed_at");--> statement-breakpoint
CREATE INDEX "card_schedules_due_at_idx" ON "card_schedules" USING btree ("due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_events_principal_idempotency_uidx" ON "review_events" USING btree ("principal_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "review_events_card_id_idx" ON "review_events" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "review_events_principal_learning_day_idx" ON "review_events" USING btree ("principal_id","learning_day");--> statement-breakpoint
CREATE INDEX "study_sessions_principal_id_idx" ON "study_sessions" USING btree ("principal_id");