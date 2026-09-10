ALTER TABLE "alert_rules" DROP CONSTRAINT "rule_threshold_type";--> statement-breakpoint
UPDATE public.alerts
SET acknowledged_at=coalesce(acknowledged_at,now()),escalation_processed_at=coalesce(escalation_processed_at,now())
WHERE metric_snapshot->>'rule_key' IN ('temp-shift','temp-rise-fast','temp-drop-fast');--> statement-breakpoint
UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL
WHERE status='pending' AND alert_id IN (SELECT id FROM public.alerts WHERE metric_snapshot->>'rule_key' IN ('temp-shift','temp-rise-fast','temp-drop-fast'));--> statement-breakpoint
DELETE FROM public.alert_rules WHERE rule_key IN ('temp-shift','temp-rise-fast','temp-drop-fast');--> statement-breakpoint
INSERT INTO public.alert_rules(id,rule_key,metric_type,comparator,threshold_type,value,min_duration_s,severity) VALUES
('00000000-0000-4000-a000-000000000006','skin-temp-high','skin_temperature','gt','baseline_deviation',4,1800,'attention'),
('00000000-0000-4000-a000-000000000009','skin-temp-low','skin_temperature','lt','baseline_deviation',4,1800,'attention');--> statement-breakpoint
ALTER TABLE "device_catalog" ADD COLUMN "update_class" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_catalog" ADD COLUMN "connection_path" text DEFAULT 'Manual import' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_catalog" ADD COLUMN "latency_label" text DEFAULT 'Only when the user imports data' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_catalog" ADD COLUMN "realtime_capable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "rule_threshold_type" CHECK ("alert_rules"."threshold_type" IN ('absolute', 'baseline_deviation'));--> statement-breakpoint
ALTER TABLE "device_catalog" ADD CONSTRAINT "device_update_class" CHECK ("device_catalog"."update_class" IN ('live','near_realtime','delayed','manual','partner'));--> statement-breakpoint
UPDATE public.summary_jobs SET revision=revision+1,available_at=now();--> statement-breakpoint
NOTIFY pgrst,'reload schema';
