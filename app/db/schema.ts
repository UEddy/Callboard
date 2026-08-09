import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Helpers -------------------------------------------------------------------

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);

// Event ---------------------------------------------------------------------

export const events = sqliteTable("events", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  startsAt: integer("starts_at", { mode: "timestamp" }),
  endsAt: integer("ends_at", { mode: "timestamp" }),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  logoUrl: text("logo_url"),
  backgroundUrl: text("background_url"),
  submissionLimitPerUser: integer("submission_limit_per_user").default(3),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rooms = sqliteTable("rooms", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  capacity: integer("capacity"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("rooms_event_idx").on(t.eventId)]);

export const tracks = sqliteTable("tracks", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#6366f1"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("tracks_event_idx").on(t.eventId)]);

// Library: reusable field definitions, tags, personas ------------------------
// Defined once per event so "Track" means the same thing on every form.

export const fieldDefinitions = sqliteTable("field_definitions", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  // text | textarea | wysiwyg | dropdown | multiselect | checkbox | radio
  // | email | phone | url | date | file | number
  type: text("type").notNull(),
  options: text("options", { mode: "json" }).$type<string[]>(),
  // { maxLength, min, max, pattern, accept }
  validation: text("validation", { mode: "json" }).$type<Record<string, unknown>>(),
  helpText: text("help_text"),
  // Locked fields are system fields the user may reorder but not delete.
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("field_def_event_key_idx").on(t.eventId, t.key)]);

export const tags = sqliteTable("tags", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#94a3b8"),
}, (t) => [index("tags_event_idx").on(t.eventId)]);

export const personas = sqliteTable("personas", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // Speaker, Sponsor, Moderator, Panelist
}, (t) => [index("personas_event_idx").on(t.eventId)]);

// Forms ---------------------------------------------------------------------

export const forms = sqliteTable("forms", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  publicSlug: text("public_slug").notNull().unique(),
  kind: text("kind").notNull().default("sessions"), // abstracts | sessions
  status: text("status").notNull().default("draft"), // draft | open | closed
  version: integer("version").notNull().default(1),
  collectParticipants: integer("collect_participants", { mode: "boolean" }).notNull().default(true),

  welcomeHtml: text("welcome_html"),
  termsHtml: text("terms_html"),
  successHtml: text("success_html"),

  closeAt: integer("close_at", { mode: "timestamp" }),
  reminderAt: integer("reminder_at", { mode: "timestamp" }),
  submissionLimit: integer("submission_limit"),
  allowMultipleDrafts: integer("allow_multiple_drafts", { mode: "boolean" }).notNull().default(false),

  adminNotifyNew: text("admin_notify_new", { mode: "json" }).$type<string[]>(),
  adminNotifyUpdate: text("admin_notify_update", { mode: "json" }).$type<string[]>(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("forms_event_idx").on(t.eventId)]);

export const formFields = sqliteTable("form_fields", {
  id: id(),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  fieldDefinitionId: text("field_definition_id").notNull()
    .references(() => fieldDefinitions.id, { onDelete: "cascade" }),
  step: text("step").notNull().default("submission"), // submission | participant
  sortOrder: integer("sort_order").notNull().default(0),
  required: integer("required", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  // { showIf: { fieldKey, op: "eq"|"neq"|"in"|"contains", value } }
  conditionalRule: text("conditional_rule", { mode: "json" }).$type<Record<string, unknown>>(),
}, (t) => [index("form_fields_form_idx").on(t.formId, t.step, t.sortOrder)]);

// Category-based routing: when answer X, assign track / plan / tags / notify.
export const routingRules = sqliteTable("routing_rules", {
  id: id(),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  whenFieldKey: text("when_field_key").notNull(),
  whenOp: text("when_op").notNull().default("eq"),
  whenValue: text("when_value").notNull(),
  assignTrackId: text("assign_track_id").references(() => tracks.id, { onDelete: "set null" }),
  assignPlanId: text("assign_plan_id"),
  assignTagIds: text("assign_tag_ids", { mode: "json" }).$type<string[]>(),
  notifyEmails: text("notify_emails", { mode: "json" }).$type<string[]>(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("routing_rules_form_idx").on(t.formId)]);

// Participants --------------------------------------------------------------

export const participants = sqliteTable("participants", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  salutation: text("salutation"),
  honorific: text("honorific"),
  company: text("company"),
  jobTitle: text("job_title"),
  phone: text("phone"),
  bio: text("bio"),
  headshotUrl: text("headshot_url"),
  // { linkedin, twitter, facebook, website }
  links: text("links", { mode: "json" }).$type<Record<string, string>>(),
  isEvaluator: integer("is_evaluator", { mode: "boolean" }).notNull().default(false),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("participants_event_email_idx").on(t.eventId, t.email)]);

// Magic-link auth. Short-lived, single-use.
export const authTokens = sqliteTable("auth_tokens", {
  id: id(),
  participantId: text("participant_id").notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: createdAt(),
});

export const sessions = sqliteTable("sessions", {
  id: id(),
  participantId: text("participant_id").notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: createdAt(),
});

// Submissions ---------------------------------------------------------------
// Hybrid storage: the six fields the app reasons about are real indexed
// columns. Everything else the form builder collects lives in `answers`.

export const submissions = sqliteTable("submissions", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  formId: text("form_id").references(() => forms.id, { onDelete: "set null" }),

  // Human-readable ref shown everywhere: SESS-4, ABS-12
  ref: text("ref").notNull(),
  refSeq: integer("ref_seq").notNull(),
  kind: text("kind").notNull().default("sessions"), // abstracts | sessions

  // --- indexed, queryable columns ---
  title: text("title").notNull().default(""),
  description: text("description"),
  // draft | submitted | pending | accept_queue | accepted
  // | decline_queue | declined | withdrawn
  status: text("status").notNull().default("draft"),
  trackId: text("track_id").references(() => tracks.id, { onDelete: "set null" }),
  format: text("format"),   // Keynote, Workshop, Lightning Talk
  level: text("level"),     // Beginner, Intermediate, Advanced

  // --- everything else the form collected ---
  answers: text("answers", { mode: "json" }).$type<Record<string, unknown>>(),
  tagIds: text("tag_ids", { mode: "json" }).$type<string[]>(),

  // Scheduling
  roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
  startsAt: integer("starts_at", { mode: "timestamp" }),
  endsAt: integer("ends_at", { mode: "timestamp" }),
  isDraftSchedule: integer("is_draft_schedule", { mode: "boolean" }).notNull().default(true),

  submittedAt: integer("submitted_at", { mode: "timestamp" }),
  decidedAt: integer("decided_at", { mode: "timestamp" }),
  notifiedAt: integer("notified_at", { mode: "timestamp" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("submissions_event_ref_idx").on(t.eventId, t.ref),
  index("submissions_status_idx").on(t.eventId, t.status),
  index("submissions_track_idx").on(t.eventId, t.trackId),
  index("submissions_schedule_idx").on(t.eventId, t.roomId, t.startsAt),
]);

export const submissionParticipants = sqliteTable("submission_participants", {
  id: id(),
  submissionId: text("submission_id").notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  participantId: text("participant_id").notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("Speaker"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
}, (t) => [
  uniqueIndex("sub_part_idx").on(t.submissionId, t.participantId),
  index("sub_part_participant_idx").on(t.participantId),
]);

// Tasks: speaker onboarding -------------------------------------------------

export const tasks = sqliteTable("tasks", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // upload_headshot | upload_slides | confirm_bio | sign_release
  // | confirm_attendance | custom
  kind: text("kind").notNull().default("custom"),
  // all_accepted_speakers | track:<id> | persona:<id> | submission:<id>
  appliesTo: text("applies_to").notNull().default("all_accepted_speakers"),
  dueAt: integer("due_at", { mode: "timestamp" }),
  required: integer("required", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("tasks_event_idx").on(t.eventId)]);

export const taskAssignments = sqliteTable("task_assignments", {
  id: id(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  participantId: text("participant_id").notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").references(() => submissions.id, { onDelete: "cascade" }),
  // not_started | in_progress | complete | overdue | waived
  status: text("status").notNull().default("not_started"),
  fileUrl: text("file_url"),
  notes: text("notes"),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  lastNudgedAt: integer("last_nudged_at", { mode: "timestamp" }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("task_assign_idx").on(t.taskId, t.participantId, t.submissionId),
  index("task_assign_status_idx").on(t.status),
  index("task_assign_participant_idx").on(t.participantId),
]);

// Evaluation ----------------------------------------------------------------

export const evaluationPlans = sqliteTable("evaluation_plans", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // [{ key, name, weight, description }]
  criteria: text("criteria", { mode: "json" })
    .$type<{ key: string; name: string; weight: number; description?: string }[]>(),
  scaleMin: integer("scale_min").notNull().default(1),
  scaleMax: integer("scale_max").notNull().default(5),
  rounds: integer("rounds").notNull().default(1),
  anonymize: integer("anonymize", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("eval_plans_event_idx").on(t.eventId)]);

export const evaluatorConflicts = sqliteTable("evaluator_conflicts", {
  id: id(),
  participantId: text("participant_id").notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  reason: text("reason").notNull().default("same_company"),
  autoDetected: integer("auto_detected", { mode: "boolean" }).notNull().default(true),
}, (t) => [uniqueIndex("eval_conflict_idx").on(t.participantId, t.submissionId)]);

export const assignments = sqliteTable("assignments", {
  id: id(),
  planId: text("plan_id").notNull().references(() => evaluationPlans.id, { onDelete: "cascade" }),
  participantId: text("participant_id").notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  status: text("status").notNull().default("pending"), // pending | complete | skipped
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("assignment_idx").on(t.planId, t.participantId, t.submissionId, t.round),
  index("assignment_evaluator_idx").on(t.participantId, t.status),
  index("assignment_submission_idx").on(t.submissionId),
]);

export const scores = sqliteTable("scores", {
  id: id(),
  assignmentId: text("assignment_id").notNull()
    .references(() => assignments.id, { onDelete: "cascade" }),
  criterionKey: text("criterion_key").notNull(),
  value: integer("value").notNull(),
  comment: text("comment"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("score_idx").on(t.assignmentId, t.criterionKey)]);

// Email ---------------------------------------------------------------------

export const emailTemplates = sqliteTable("email_templates", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  // on_submit | on_accept | on_decline | on_task_assigned
  // | task_reminder | schedule_published | custom
  trigger: text("trigger").notNull().default("custom"),
  attachIcs: integer("attach_ics", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
}, (t) => [uniqueIndex("email_tmpl_idx").on(t.eventId, t.key)]);

export const emailLog = sqliteTable("email_log", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  participantId: text("participant_id").references(() => participants.id, { onDelete: "set null" }),
  submissionId: text("submission_id").references(() => submissions.id, { onDelete: "set null" }),
  templateKey: text("template_key").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("queued"), // queued | sent | failed
  error: text("error"),
  // Bumped on every re-send so calendar clients update rather than duplicate.
  icsUid: text("ics_uid"),
  icsSequence: integer("ics_sequence").default(0),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  createdAt: createdAt(),
}, (t) => [
  index("email_log_event_idx").on(t.eventId, t.createdAt),
  index("email_log_participant_idx").on(t.participantId),
]);

// Embeds --------------------------------------------------------------------

export const embeds = sqliteTable("embeds", {
  id: id(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // agenda | session_list | schedule_itinerary | speaker_list | speaker_gallery
  format: text("format").notNull().default("agenda"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  publicToken: text("public_token").notNull().unique(),
  style: text("style", { mode: "json" }).$type<Record<string, unknown>>(),
  filters: text("filters", { mode: "json" }).$type<Record<string, unknown>>(),
  fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [index("embeds_event_idx").on(t.eventId)]);
