ALTER TABLE "baselines" ADD COLUMN "window_end" date;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "skin_temp_avg" numeric;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "night_spo2_min" numeric;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "weight_kg" numeric;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "bp_systolic" numeric;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "bp_diastolic" numeric;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "contains_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "source_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "metric_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD COLUMN "recovery_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "insights" ADD COLUMN "insight_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "insights" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "insights_user_key" ON "insights" USING btree ("user_id","insight_key");