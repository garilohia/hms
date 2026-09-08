CREATE TABLE "profile_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"guardian_account_id" uuid NOT NULL,
	"recipient_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "profile_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_transfers" ADD CONSTRAINT "profile_transfers_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_recipient_idx" ON "profile_transfers" USING btree ("recipient_account_id");--> statement-breakpoint
CREATE INDEX "transfer_guardian_idx" ON "profile_transfers" USING btree ("guardian_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_pending_subject" ON "profile_transfers" USING btree ("user_id") WHERE "profile_transfers"."accepted_at" IS NULL AND "profile_transfers"."revoked_at" IS NULL;