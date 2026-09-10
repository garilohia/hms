ALTER TYPE "public"."provider" ADD VALUE 'google_health_api' BEFORE 'aggregator';--> statement-breakpoint
ALTER TYPE "public"."provider" ADD VALUE 'whoop_api' BEFORE 'aggregator';--> statement-breakpoint

CREATE TABLE "hms_private"."integration_connections" (
  "user_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "public"."data_sources"("id") ON DELETE CASCADE,
  "external_account_id" text NOT NULL,
  "encrypted_tokens" text NOT NULL,
  "granted_scopes" text[] NOT NULL DEFAULT '{}',
  "token_expires_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "provider"),
  UNIQUE ("source_id"),
  CONSTRAINT "integration_provider_check" CHECK ("provider" IN ('google_health','whoop'))
);--> statement-breakpoint

CREATE INDEX "integration_connections_source_idx" ON "hms_private"."integration_connections" ("source_id");--> statement-breakpoint
ALTER TABLE "hms_private"."integration_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hms_private"."integration_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hms_private"."integration_connections" FROM PUBLIC, anon, authenticated;
