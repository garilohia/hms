ALTER TABLE "alert_rules" DROP CONSTRAINT "rule_threshold_type";--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "rule_threshold_type" CHECK ("alert_rules"."threshold_type" IN ('absolute', 'baseline_deviation', 'rate_change'));--> statement-breakpoint
INSERT INTO "public"."alert_rules" (id,rule_key,metric_type,comparator,threshold_type,value,min_duration_s,severity)
VALUES
  ('00000000-0000-4000-a000-000000000009','temp-rise-fast','skin_temperature','gt','rate_change',2,60,'urgent'),
  ('00000000-0000-4000-a000-000000000010','temp-drop-fast','skin_temperature','lt','rate_change',2,60,'urgent')
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
UPDATE public.summary_jobs SET revision=revision+1,available_at=now();
