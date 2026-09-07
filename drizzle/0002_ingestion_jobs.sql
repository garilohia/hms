CREATE TABLE "summary_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"processed_revision" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lease_token" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "summary_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "source_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "summary_jobs" ADD CONSTRAINT "summary_jobs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "summary_job_day" ON "summary_jobs" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "summary_job_pending" ON "summary_jobs" USING btree ("available_at") WHERE "summary_jobs"."revision" > "summary_jobs"."processed_revision";--> statement-breakpoint
CREATE UNIQUE INDEX "sources_stable_key" ON "data_sources" USING btree ("user_id","provider","source_key");