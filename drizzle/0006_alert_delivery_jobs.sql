ALTER TYPE "public"."consent_type" ADD VALUE 'alert_email';--> statement-breakpoint
ALTER TYPE "public"."consent_type" ADD VALUE 'emergency_contact';--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"alert_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_key" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lease_token" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"first_attempt_at" timestamp with time zone,
	"payload" jsonb,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_kind" CHECK ("alert_deliveries"."recipient_kind" IN ('owner','caregiver','contact')),
	CONSTRAINT "delivery_status" CHECK ("alert_deliveries"."status" IN ('pending','sent','stubbed','cancelled','failed')),
	CONSTRAINT "delivery_channel" CHECK ("alert_deliveries"."channel" IN ('email','push'))
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "rule_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "event_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "event_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "escalation_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "escalation_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "is_historical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "at_rest" boolean;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_alert_recipient" ON "alert_deliveries" USING btree ("alert_id","recipient_kind","recipient_key","channel");--> statement-breakpoint
CREATE INDEX "delivery_subject_idx" ON "alert_deliveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "delivery_due_idx" ON "alert_deliveries" USING btree ("available_at") WHERE "alert_deliveries"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rules_user_key" ON "alert_rules" USING btree ("user_id","rule_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_system_key" ON "alert_rules" USING btree ("rule_key") WHERE "alert_rules"."user_id" IS NULL;--> statement-breakpoint
CREATE INDEX "alerts_source_idx" ON "alerts" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "alerts_due_idx" ON "alerts" USING btree ("escalation_due_at") WHERE "alerts"."escalation_processed_at" IS NULL AND "alerts"."acknowledged_at" IS NULL;