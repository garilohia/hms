ALTER TABLE "profiles" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cycle_tracking_enabled" boolean DEFAULT false NOT NULL;