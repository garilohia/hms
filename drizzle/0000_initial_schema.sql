CREATE TYPE "public"."caregiver_role" AS ENUM('caregiver', 'guardian');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."consent_authority" AS ENUM('self', 'guardian');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('data_ingestion', 'doctor_sharing', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."metric_type" AS ENUM('heart_rate', 'resting_heart_rate', 'hrv_rmssd', 'spo2', 'skin_temperature', 'respiratory_rate', 'steps', 'active_calories', 'total_calories', 'sleep_stage', 'sleep_duration', 'stress_score', 'weight_kg', 'body_fat_pct', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'blood_glucose', 'vo2max', 'menstrual_flow', 'basal_body_temperature');--> statement-breakpoint
CREATE TYPE "public"."profile_kind" AS ENUM('self', 'dependent');--> statement-breakpoint
CREATE TYPE "public"."profile_role" AS ENUM('patient', 'doctor', 'admin');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('simulator', 'apple_health_export', 'fitbit_export', 'garmin_export', 'generic_csv', 'fitbit_api', 'aggregator');--> statement-breakpoint
CREATE TYPE "public"."metric_quality" AS ENUM('raw', 'derived', 'user_entered');--> statement-breakpoint
CREATE TYPE "public"."sharing_scope" AS ENUM('summary_only', 'full_history', 'alerts');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'attention', 'urgent');--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"metric_type" "metric_type" NOT NULL,
	"comparator" text NOT NULL,
	"threshold_type" text NOT NULL,
	"value" numeric NOT NULL,
	"min_duration_s" integer DEFAULT 0 NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "rule_threshold_type" CHECK ("alert_rules"."threshold_type" IN ('absolute', 'baseline_deviation')),
	CONSTRAINT "rule_comparator" CHECK ("alert_rules"."comparator" IN ('lt', 'lte', 'gt', 'gte')),
	CONSTRAINT "rule_duration" CHECK ("alert_rules"."min_duration_s" >= 0)
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid,
	"metric_snapshot" jsonb NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"escalated_to_contact_at" timestamp with time zone,
	"escalated_to_doctor_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_user_id" uuid,
	"target_table" text NOT NULL,
	"target_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"metric_type" "metric_type" NOT NULL,
	"median" numeric NOT NULL,
	"mad" numeric NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_nonnegative" CHECK ("baselines"."mad" >= 0 AND "baselines"."sample_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "baselines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "caregiver_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"caregiver_id" uuid NOT NULL,
	"role" "caregiver_role" DEFAULT 'caregiver' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"granted_scopes" "sharing_scope"[] NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "caregiver_link_status" CHECK ("caregiver_links"."status" IN ('invited','active','revoked')),
	CONSTRAINT "guardian_full_scope" CHECK ("caregiver_links"."role" <> 'guardian' OR ("caregiver_links"."granted_scopes" @> ARRAY['summary_only','full_history','alerts']::sharing_scope[]))
);
--> statement-breakpoint
ALTER TABLE "caregiver_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"authority" "consent_authority" NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"ip_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"patient_note" text,
	"doctor_note" text,
	"attached_summary_id" uuid,
	"call_url" text,
	CONSTRAINT "consult_type" CHECK ("consults"."type" IN ('urgent_review','trend_review','second_opinion','follow_up')),
	CONSTRAINT "consult_status" CHECK ("consults"."status" IN ('requested','accepted','scheduled','completed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "consults" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cycle_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"period_start" date,
	"period_end" date,
	"phase" text DEFAULT 'unknown' NOT NULL,
	"is_inferred" boolean DEFAULT false NOT NULL,
	"confidence" "confidence" DEFAULT 'low' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cycle_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"rhr" numeric,
	"hrv_avg" numeric,
	"spo2_min" numeric,
	"spo2_avg" numeric,
	"skin_temp_deviation" numeric,
	"sleep_duration_min" numeric,
	"sleep_efficiency" numeric,
	"deep_min" numeric,
	"rem_min" numeric,
	"steps" numeric,
	"active_calories" numeric,
	"stress_avg" numeric,
	"recovery_score" numeric,
	"readiness_score" numeric,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_id_user_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "data_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"category" text NOT NULL,
	"price_inr" numeric,
	"price_usd" numeric,
	"price_gbp" numeric,
	"price_aed" numeric,
	"metrics_supported" "metric_type"[] NOT NULL,
	"battery_days" numeric,
	"has_ecg" boolean DEFAULT false NOT NULL,
	"has_skin_temp" boolean DEFAULT false NOT NULL,
	"has_spo2" boolean DEFAULT false NOT NULL,
	"has_hrv" boolean DEFAULT false NOT NULL,
	"has_screen" boolean DEFAULT false NOT NULL,
	"subscription_required" boolean DEFAULT false NOT NULL,
	"subscription_cost" text,
	"source_urls" text[] NOT NULL,
	"last_verified_at" timestamp with time zone,
	"editorial_note" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "doctor_patient_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"granted_scopes" "sharing_scope"[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "doctor_link_status" CHECK ("doctor_patient_links"."status" IN ('requested','active','revoked'))
);
--> statement-breakpoint
ALTER TABLE "doctor_patient_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration_number" text NOT NULL,
	"registering_council" text NOT NULL,
	"specialities" text[] NOT NULL,
	"languages" text[] NOT NULL,
	"bio" text NOT NULL,
	"consult_fee_inr" numeric NOT NULL,
	"consult_fee_usd" numeric NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "doctors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"storage_path" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "documents_storage_path_unique" UNIQUE("storage_path"),
	CONSTRAINT "document_type" CHECK ("documents"."type" IN ('lab_report','prescription','discharge_summary','other'))
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"confidence" "confidence" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "insight_category" CHECK ("insights"."category" IN ('sleep','stress','recovery','cycle','activity','nutrition_ask_doctor'))
);
--> statement-breakpoint
ALTER TABLE "insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consult_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"attachments" text[] DEFAULT '{}' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"metric_type" "metric_type" NOT NULL,
	"value" numeric NOT NULL,
	"unit" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"duration_s" integer,
	"quality" "metric_quality" DEFAULT 'raw' NOT NULL,
	"external_id" text,
	CONSTRAINT "metrics_duration_nonnegative" CHECK ("metrics"."duration_s" IS NULL OR "metrics"."duration_s" >= 0),
	CONSTRAINT "metrics_value_finite" CHECK ("metrics"."value" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
--> statement-breakpoint
ALTER TABLE "metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" uuid,
	"owner_account_id" uuid NOT NULL,
	"kind" "profile_kind" DEFAULT 'self' NOT NULL,
	"name" text NOT NULL,
	"dob" date NOT NULL,
	"sex_at_birth" text,
	"height_cm" numeric,
	"country_of_residence" text DEFAULT 'IN' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"emergency_contact" jsonb,
	"local_emergency_number" text DEFAULT '112' NOT NULL,
	"role" "profile_role" DEFAULT 'patient' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "profiles_identity_kind" CHECK (("profiles"."kind" = 'self' AND "profiles"."auth_user_id" IS NOT NULL AND "profiles"."owner_account_id" = "profiles"."auth_user_id") OR ("profiles"."kind" = 'dependent' AND "profiles"."auth_user_id" IS NULL AND "profiles"."role" = 'patient'))
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "summary_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "summary_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_links" ADD CONSTRAINT "caregiver_links_patient_id_profiles_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consults" ADD CONSTRAINT "consults_patient_id_profiles_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consults" ADD CONSTRAINT "consults_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consults" ADD CONSTRAINT "consults_attached_summary_id_summary_snapshots_id_fk" FOREIGN KEY ("attached_summary_id") REFERENCES "public"."summary_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_logs" ADD CONSTRAINT "cycle_logs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_patient_links" ADD CONSTRAINT "doctor_patient_links_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_patient_links" ADD CONSTRAINT "doctor_patient_links_patient_id_profiles_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_id_profiles_id_fk" FOREIGN KEY ("id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_consult_id_consults_id_fk" FOREIGN KEY ("consult_id") REFERENCES "public"."consults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_source_id_user_id_data_sources_id_user_id_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."data_sources"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_snapshots" ADD CONSTRAINT "summary_snapshots_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_user_idx" ON "alert_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alerts_user_time_idx" ON "alerts" USING btree ("user_id","fired_at");--> statement-breakpoint
CREATE INDEX "alerts_rule_idx" ON "alerts" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "audit_subject_time_idx" ON "audit_log" USING btree ("target_user_id","at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "baseline_user_metric" ON "baselines" USING btree ("user_id","metric_type");--> statement-breakpoint
CREATE UNIQUE INDEX "caregiver_patient_unique" ON "caregiver_links" USING btree ("patient_id","caregiver_id");--> statement-breakpoint
CREATE INDEX "caregiver_actor_idx" ON "caregiver_links" USING btree ("caregiver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_guardian_per_dependent" ON "caregiver_links" USING btree ("patient_id") WHERE "caregiver_links"."role" = 'guardian' AND "caregiver_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "consents_subject_idx" ON "consents" USING btree ("user_id","consent_type");--> statement-breakpoint
CREATE INDEX "consents_grantor_idx" ON "consents" USING btree ("granted_by");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_active_unique" ON "consents" USING btree ("user_id","consent_type") WHERE "consents"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "consults_patient_idx" ON "consults" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "consults_doctor_idx" ON "consults" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "consults_summary_idx" ON "consults" USING btree ("attached_summary_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_user_day" ON "cycle_logs" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_user_day" ON "daily_summaries" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "sources_user_idx" ON "data_sources" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_brand_model" ON "device_catalog" USING btree ("brand","model");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_patient_unique" ON "doctor_patient_links" USING btree ("doctor_id","patient_id");--> statement-breakpoint
CREATE INDEX "doctor_links_patient_idx" ON "doctor_patient_links" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_registration" ON "doctors" USING btree ("registration_number","registering_council");--> statement-breakpoint
CREATE INDEX "documents_user_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "insights_user_idx" ON "insights" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_consult_idx" ON "messages" USING btree ("consult_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_dedupe" ON "metrics" USING btree ("user_id","metric_type","recorded_at","source_id");--> statement-breakpoint
CREATE INDEX "metrics_source_idx" ON "metrics" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "metrics_timeline_idx" ON "metrics" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE INDEX "profiles_owner_idx" ON "profiles" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "snapshots_user_idx" ON "summary_snapshots" USING btree ("user_id");