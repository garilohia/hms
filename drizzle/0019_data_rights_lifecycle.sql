CREATE TABLE "account_deletions" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"profile_ids" uuid[] NOT NULL,
	"stage" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_stage" CHECK ("account_deletions"."stage" IN ('pending','storage_removed','health_removed'))
);
--> statement-breakpoint
ALTER TABLE "account_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consults" DROP CONSTRAINT "consults_doctor_id_doctors_id_fk";
--> statement-breakpoint
ALTER TABLE "consents" ALTER COLUMN "granted_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consults" ALTER COLUMN "doctor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sender_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "consults" ADD CONSTRAINT "consults_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE set null ON UPDATE no action;