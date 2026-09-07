import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").defaultRandom().primaryKey();
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const created = () => at("created_at").defaultNow().notNull();
const json = (name: string) => jsonb(name).$type<Record<string, unknown>>();
export const profileRole = pgEnum("profile_role", ["patient", "doctor", "admin"]);
export const profileKind = pgEnum("profile_kind", ["self", "dependent"]);
export const consentType = pgEnum("consent_type", ["data_ingestion", "doctor_sharing", "marketing"]);
export const consentAuthority = pgEnum("consent_authority", ["self", "guardian"]);
export const provider = pgEnum("provider", ["simulator", "apple_health_export", "fitbit_export", "garmin_export", "generic_csv", "fitbit_api", "aggregator"]);
export const metricType = pgEnum("metric_type", ["heart_rate", "resting_heart_rate", "hrv_rmssd", "spo2", "skin_temperature", "respiratory_rate", "steps", "active_calories", "total_calories", "sleep_stage", "sleep_duration", "stress_score", "weight_kg", "body_fat_pct", "blood_pressure_systolic", "blood_pressure_diastolic", "blood_glucose", "vo2max", "menstrual_flow", "basal_body_temperature"]);
export const quality = pgEnum("metric_quality", ["raw", "derived", "user_entered"]);
export const severity = pgEnum("alert_severity", ["info", "attention", "urgent"]);
export const confidence = pgEnum("confidence", ["low", "medium", "high"]);
export const scope = pgEnum("sharing_scope", ["summary_only", "full_history", "alerts"]);
export const caregiverRole = pgEnum("caregiver_role", ["caregiver", "guardian"]);

export const profiles = pgTable("profiles", {
  id: id(), authUserId: uuid("auth_user_id").unique(), ownerAccountId: uuid("owner_account_id").notNull(),
  kind: profileKind("kind").default("self").notNull(), name: text("name").notNull(), dob: date("dob").notNull(),
  sexAtBirth: text("sex_at_birth"), heightCm: numeric("height_cm"), countryOfResidence: text("country_of_residence").default("IN").notNull(),
  timezone: text("timezone").default("Asia/Kolkata").notNull(), emergencyContact: json("emergency_contact"),
  localEmergencyNumber: text("local_emergency_number").default("112").notNull(),
  role: profileRole("role").default("patient").notNull(), createdAt: created(),
}, t => [index("profiles_owner_idx").on(t.ownerAccountId), check("profiles_identity_kind", sql`(${t.kind} = 'self' AND ${t.authUserId} IS NOT NULL AND ${t.ownerAccountId} = ${t.authUserId}) OR (${t.kind} = 'dependent' AND ${t.authUserId} IS NULL AND ${t.role} = 'patient')`)]).enableRLS();

const patient = () => uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" });
export const consents = pgTable("consents", {
  id: id(), userId: patient(), grantedBy: uuid("granted_by").notNull(), authority: consentAuthority("authority").notNull(),
  consentType: consentType("consent_type").notNull(), grantedAt: at("granted_at").defaultNow().notNull(),
  revokedAt: at("revoked_at"), policyVersion: text("policy_version").notNull(), ipHash: text("ip_hash").notNull(),
}, t => [index("consents_subject_idx").on(t.userId, t.consentType), index("consents_grantor_idx").on(t.grantedBy), uniqueIndex("consents_active_unique").on(t.userId, t.consentType).where(sql`${t.revokedAt} IS NULL`)]).enableRLS();

export const dataSources = pgTable("data_sources", {
  id: id(), userId: patient(), provider: provider("provider").notNull(), status: text("status").default("connected").notNull(),
  sourceKey: text("source_key").default(sql`gen_random_uuid()::text`).notNull(),
  lastSyncAt: at("last_sync_at"), metadata: json("metadata").default({}).notNull(), createdAt: created(),
}, t => [index("sources_user_idx").on(t.userId), unique("sources_id_user_unique").on(t.id, t.userId), uniqueIndex("sources_stable_key").on(t.userId, t.provider, t.sourceKey)]).enableRLS();

export const summaryJobs = pgTable("summary_jobs", {
  id: id(), userId: patient(), day: date("day").notNull(), revision: integer("revision").default(1).notNull(),
  processedRevision: integer("processed_revision").default(0).notNull(), availableAt: at("available_at").defaultNow().notNull(),
  lockedUntil: at("locked_until"), leaseToken: uuid("lease_token"), attempts: integer("attempts").default(0).notNull(), lastError: text("last_error"),
}, t => [uniqueIndex("summary_job_day").on(t.userId, t.day), index("summary_job_pending").on(t.availableAt).where(sql`${t.revision} > ${t.processedRevision}`)]).enableRLS();

export const metrics = pgTable("metrics", {
  id: id(), userId: patient(), sourceId: uuid("source_id").notNull(), metricType: metricType("metric_type").notNull(),
  value: numeric("value").notNull(), unit: text("unit").notNull(), recordedAt: at("recorded_at").notNull(),
  durationS: integer("duration_s"), quality: quality("quality").default("raw").notNull(), externalId: text("external_id"),
}, t => [
  uniqueIndex("metrics_dedupe").on(t.userId, t.metricType, t.recordedAt, t.sourceId),
  index("metrics_source_idx").on(t.sourceId), index("metrics_timeline_idx").on(t.userId, t.recordedAt),
  foreignKey({ columns: [t.sourceId, t.userId], foreignColumns: [dataSources.id, dataSources.userId] }).onDelete("cascade"),
  check("metrics_duration_nonnegative", sql`${t.durationS} IS NULL OR ${t.durationS} >= 0`),
  check("metrics_value_finite", sql`${t.value} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`),
]).enableRLS();

export const dailySummaries = pgTable("daily_summaries", {
  id: id(), userId: patient(), day: date("day").notNull(), rhr: numeric("rhr"), hrvAvg: numeric("hrv_avg"),
  spo2Min: numeric("spo2_min"), spo2Avg: numeric("spo2_avg"), skinTempDeviation: numeric("skin_temp_deviation"),
  sleepDurationMin: numeric("sleep_duration_min"), sleepEfficiency: numeric("sleep_efficiency"), deepMin: numeric("deep_min"), remMin: numeric("rem_min"),
  steps: numeric("steps"), activeCalories: numeric("active_calories"), stressAvg: numeric("stress_avg"),
  recoveryScore: numeric("recovery_score"), readinessScore: numeric("readiness_score"), computedAt: at("computed_at").defaultNow().notNull(),
}, t => [uniqueIndex("summary_user_day").on(t.userId, t.day)]).enableRLS();

export const baselines = pgTable("baselines", {
  id: id(), userId: patient(), metricType: metricType("metric_type").notNull(), median: numeric("median").notNull(),
  mad: numeric("mad").notNull(), sampleCount: integer("sample_count").notNull(), computedAt: at("computed_at").defaultNow().notNull(),
}, t => [uniqueIndex("baseline_user_metric").on(t.userId, t.metricType), check("baseline_nonnegative", sql`${t.mad} >= 0 AND ${t.sampleCount} >= 0`)]).enableRLS();

export const alertRules = pgTable("alert_rules", {
  id: id(), userId: uuid("user_id").references(() => profiles.id, { onDelete: "cascade" }),
  metricType: metricType("metric_type").notNull(), comparator: text("comparator").notNull(),
  thresholdType: text("threshold_type").notNull(), value: numeric("value").notNull(),
  minDurationS: integer("min_duration_s").default(0).notNull(), severity: severity("severity").notNull(), enabled: boolean("enabled").default(true).notNull(),
}, t => [index("rules_user_idx").on(t.userId), check("rule_threshold_type", sql`${t.thresholdType} IN ('absolute', 'baseline_deviation')`),
  check("rule_comparator", sql`${t.comparator} IN ('lt', 'lte', 'gt', 'gte')`), check("rule_duration", sql`${t.minDurationS} >= 0`)]).enableRLS();

export const alerts = pgTable("alerts", {
  id: id(), userId: patient(), ruleId: uuid("rule_id").references(() => alertRules.id, { onDelete: "set null" }),
  metricSnapshot: json("metric_snapshot").notNull(), severity: severity("severity").notNull(),
  firedAt: at("fired_at").defaultNow().notNull(), acknowledgedAt: at("acknowledged_at"),
  escalatedToContactAt: at("escalated_to_contact_at"), escalatedToDoctorAt: at("escalated_to_doctor_at"),
}, t => [index("alerts_user_time_idx").on(t.userId, t.firedAt), index("alerts_rule_idx").on(t.ruleId)]).enableRLS();

export const insights = pgTable("insights", {
  id: id(), userId: patient(), category: text("category").notNull(), title: text("title").notNull(), body: text("body").notNull(),
  evidence: json("evidence").notNull(), confidence: confidence("confidence").notNull(), createdAt: created(), dismissedAt: at("dismissed_at"),
}, t => [index("insights_user_idx").on(t.userId, t.createdAt), check("insight_category", sql`${t.category} IN ('sleep','stress','recovery','cycle','activity','nutrition_ask_doctor')`)]).enableRLS();

export const cycleLogs = pgTable("cycle_logs", {
  id: id(), userId: patient(), day: date("day").notNull(), periodStart: date("period_start"), periodEnd: date("period_end"),
  phase: text("phase").default("unknown").notNull(), isInferred: boolean("is_inferred").default(false).notNull(), confidence: confidence("confidence").default("low").notNull(),
}, t => [uniqueIndex("cycle_user_day").on(t.userId, t.day)]).enableRLS();

export const doctors = pgTable("doctors", {
  id: uuid("id").primaryKey().references(() => profiles.id, { onDelete: "cascade" }), registrationNumber: text("registration_number").notNull(),
  registeringCouncil: text("registering_council").notNull(), specialities: text("specialities").array().notNull(), languages: text("languages").array().notNull(),
  bio: text("bio").notNull(), consultFeeInr: numeric("consult_fee_inr").notNull(), consultFeeUsd: numeric("consult_fee_usd").notNull(),
  available: boolean("available").default(false).notNull(), verifiedAt: at("verified_at"),
}, t => [uniqueIndex("doctor_registration").on(t.registrationNumber, t.registeringCouncil)]).enableRLS();

export const doctorPatientLinks = pgTable("doctor_patient_links", {
  id: id(), doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
  patientId: uuid("patient_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  status: text("status").default("requested").notNull(), grantedScopes: scope("granted_scopes").array().notNull(),
  createdAt: created(), revokedAt: at("revoked_at"),
}, t => [uniqueIndex("doctor_patient_unique").on(t.doctorId, t.patientId), index("doctor_links_patient_idx").on(t.patientId),
  check("doctor_link_status", sql`${t.status} IN ('requested','active','revoked')`)]).enableRLS();

export const caregiverLinks = pgTable("caregiver_links", {
  id: id(), patientId: uuid("patient_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  caregiverId: uuid("caregiver_id").notNull(), role: caregiverRole("role").default("caregiver").notNull(),
  status: text("status").default("invited").notNull(), grantedScopes: scope("granted_scopes").array().notNull(),
  invitedBy: text("invited_by").notNull(), createdAt: created(), revokedAt: at("revoked_at"),
}, t => [uniqueIndex("caregiver_patient_unique").on(t.patientId, t.caregiverId), index("caregiver_actor_idx").on(t.caregiverId),
  uniqueIndex("one_guardian_per_dependent").on(t.patientId).where(sql`${t.role} = 'guardian' AND ${t.status} = 'active'`),
  check("caregiver_link_status", sql`${t.status} IN ('invited','active','revoked')`),
  check("guardian_full_scope", sql`${t.role} <> 'guardian' OR (${t.grantedScopes} @> ARRAY['summary_only','full_history','alerts']::sharing_scope[])`)]).enableRLS();

export const summarySnapshots = pgTable("summary_snapshots", {
  id: id(), userId: patient(), body: json("body").notNull(), createdAt: created(),
}, t => [index("snapshots_user_idx").on(t.userId)]).enableRLS();

export const consults = pgTable("consults", {
  id: id(), patientId: uuid("patient_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
  type: text("type").notNull(), status: text("status").default("requested").notNull(), requestedAt: at("requested_at").defaultNow().notNull(),
  scheduledFor: at("scheduled_for"), completedAt: at("completed_at"), patientNote: text("patient_note"), doctorNote: text("doctor_note"),
  attachedSummaryId: uuid("attached_summary_id").references(() => summarySnapshots.id, { onDelete: "set null" }), callUrl: text("call_url"),
}, t => [index("consults_patient_idx").on(t.patientId), index("consults_doctor_idx").on(t.doctorId), index("consults_summary_idx").on(t.attachedSummaryId),
  check("consult_type", sql`${t.type} IN ('urgent_review','trend_review','second_opinion','follow_up')`),
  check("consult_status", sql`${t.status} IN ('requested','accepted','scheduled','completed','cancelled')`)]).enableRLS();

export const messages = pgTable("messages", {
  id: id(), consultId: uuid("consult_id").notNull().references(() => consults.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").notNull(), body: text("body").notNull(), attachments: text("attachments").array().default([]).notNull(),
  sentAt: at("sent_at").defaultNow().notNull(), readAt: at("read_at"),
}, t => [index("messages_consult_idx").on(t.consultId, t.sentAt), index("messages_sender_idx").on(t.senderId)]).enableRLS();

export const documents = pgTable("documents", {
  id: id(), userId: patient(), type: text("type").notNull(), storagePath: text("storage_path").notNull().unique(),
  uploadedAt: at("uploaded_at").defaultNow().notNull(), title: text("title").notNull(), tags: text("tags").array().default([]).notNull(),
}, t => [index("documents_user_idx").on(t.userId), check("document_type", sql`${t.type} IN ('lab_report','prescription','discharge_summary','other')`)]).enableRLS();

export const deviceCatalog = pgTable("device_catalog", {
  id: id(), brand: text("brand").notNull(), model: text("model").notNull(), category: text("category").notNull(),
  priceInr: numeric("price_inr"), priceUsd: numeric("price_usd"), priceGbp: numeric("price_gbp"), priceAed: numeric("price_aed"),
  metricsSupported: metricType("metrics_supported").array().notNull(), batteryDays: numeric("battery_days"),
  hasEcg: boolean("has_ecg").default(false).notNull(), hasSkinTemp: boolean("has_skin_temp").default(false).notNull(),
  hasSpo2: boolean("has_spo2").default(false).notNull(), hasHrv: boolean("has_hrv").default(false).notNull(), hasScreen: boolean("has_screen").default(false).notNull(),
  subscriptionRequired: boolean("subscription_required").default(false).notNull(), subscriptionCost: text("subscription_cost"),
  sourceUrls: text("source_urls").array().notNull(), lastVerifiedAt: at("last_verified_at"), editorialNote: text("editorial_note").notNull(),
}, t => [uniqueIndex("device_brand_model").on(t.brand, t.model)]).enableRLS();

export const auditLog = pgTable("audit_log", {
  id: id(), actorId: uuid("actor_id"), action: text("action").notNull(), targetUserId: uuid("target_user_id"),
  targetTable: text("target_table").notNull(), targetId: uuid("target_id"), at: at("at").defaultNow().notNull(), metadata: json("metadata").default({}).notNull(),
}, t => [index("audit_subject_time_idx").on(t.targetUserId, t.at), index("audit_actor_idx").on(t.actorId)]).enableRLS();
