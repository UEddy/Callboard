-- Callboard demo seed
-- Apply:  npx wrangler d1 execute callboard --local --file=./scripts/seed.sql
--
-- Deliberately NOT in ./drizzle. Wrangler treats every .sql file in the
-- migrations directory as a migration, so living there meant a routine
-- `d1 migrations apply` would silently wipe and reseed the event.
-- Re-runnable: wipes the demo event first, leaves everything else alone.

DELETE FROM events WHERE id = 'evt_aiewf26';

-- Event ---------------------------------------------------------------------

INSERT INTO events (id, slug, name, description, starts_at, ends_at, timezone, submission_limit_per_user)
VALUES (
  'evt_aiewf26',
  'ai-engineer-worlds-fair-2026',
  'AI Engineer World''s Fair 2026',
  'Three days of talks and workshops for engineers building with LLMs. San Francisco, October 12-14, 2026.',
  1791763200, 1791936000, 'America/Los_Angeles', 3
);

-- Rooms ---------------------------------------------------------------------

INSERT INTO rooms (id, event_id, name, capacity, sort_order) VALUES
  ('rm_ggb', 'evt_aiewf26', 'Golden Gate Ballroom', 400, 0),
  ('rm_mission', 'evt_aiewf26', 'Mission Hall', 180, 1),
  ('rm_presidio', 'evt_aiewf26', 'Presidio Room', 120, 2),
  ('rm_bay', 'evt_aiewf26', 'Workshop Bay', 60, 3);

-- Tracks --------------------------------------------------------------------

INSERT INTO tracks (id, event_id, name, color, sort_order) VALUES
  ('trk_aieng', 'evt_aiewf26', 'AI Engineering', '#6366f1', 0),
  ('trk_agents', 'evt_aiewf26', 'Agents & Tool Use', '#ec4899', 1),
  ('trk_evals', 'evt_aiewf26', 'Evals & Observability', '#f59e0b', 2),
  ('trk_rag', 'evt_aiewf26', 'RAG & Retrieval', '#10b981', 3),
  ('trk_infra', 'evt_aiewf26', 'LLM Infra', '#0ea5e9', 4);

-- Tags & personas -----------------------------------------------------------

INSERT INTO tags (id, event_id, name, color) VALUES
  ('tag_oss', 'evt_aiewf26', 'Open Source', '#10b981'),
  ('tag_prod', 'evt_aiewf26', 'Production War Story', '#f43f5e'),
  ('tag_research', 'evt_aiewf26', 'Research', '#8b5cf6'),
  ('tag_beginner', 'evt_aiewf26', 'Newcomer Friendly', '#0ea5e9'),
  ('tag_sponsor', 'evt_aiewf26', 'Sponsor Session', '#f59e0b');

INSERT INTO personas (id, event_id, name) VALUES
  ('per_speaker', 'evt_aiewf26', 'Speaker'),
  ('per_sponsor', 'evt_aiewf26', 'Sponsor'),
  ('per_mod', 'evt_aiewf26', 'Moderator'),
  ('per_panel', 'evt_aiewf26', 'Panelist');

-- Field library -------------------------------------------------------------

INSERT INTO field_definitions (id, event_id, key, label, type, options, validation, help_text, locked) VALUES
  ('fd_title', 'evt_aiewf26', 'title', 'Title', 'text', NULL, '{"maxLength":255}', 'Keep it under 80 characters if you can.', 1),
  ('fd_desc', 'evt_aiewf26', 'description', 'Description', 'wysiwyg', NULL, '{"maxLength":5000}', 'What will attendees walk away knowing?', 1),
  ('fd_format', 'evt_aiewf26', 'format', 'Format', 'dropdown', '["Keynote","Talk (25 min)","Workshop (90 min)","Lightning Talk (10 min)"]', NULL, NULL, 0),
  ('fd_track', 'evt_aiewf26', 'track', 'Track', 'dropdown', '["AI Engineering","Agents & Tool Use","Evals & Observability","RAG & Retrieval","LLM Infra"]', NULL, NULL, 0),
  ('fd_level', 'evt_aiewf26', 'level', 'Audience Level', 'dropdown', '["Beginner","Intermediate","Advanced"]', NULL, NULL, 0),
  ('fd_tags', 'evt_aiewf26', 'tags', 'Tags', 'multiselect', '["Open Source","Production War Story","Research","Newcomer Friendly","Sponsor Session"]', NULL, NULL, 0),
  ('fd_takeaways', 'evt_aiewf26', 'takeaways', 'Key Takeaways', 'textarea', NULL, '{"maxLength":1000}', 'Three bullets is ideal.', 0),
  ('fd_wsprereq', 'evt_aiewf26', 'workshop_prereqs', 'Workshop Prerequisites', 'textarea', NULL, '{"maxLength":1000}', 'What should attendees install beforehand?', 0),
  ('fd_wscap', 'evt_aiewf26', 'workshop_capacity', 'Max Attendees', 'number', NULL, '{"min":10,"max":200}', NULL, 0),
  ('fd_first', 'evt_aiewf26', 'first_name', 'First Name', 'text', NULL, '{"maxLength":255}', NULL, 1),
  ('fd_last', 'evt_aiewf26', 'last_name', 'Last Name', 'text', NULL, '{"maxLength":255}', NULL, 1),
  ('fd_email', 'evt_aiewf26', 'email', 'Email', 'email', NULL, NULL, NULL, 1),
  ('fd_phone', 'evt_aiewf26', 'phone', 'Mobile Phone', 'phone', NULL, NULL, 'Only used for day-of logistics.', 0),
  ('fd_bio', 'evt_aiewf26', 'bio', 'Biography', 'wysiwyg', NULL, '{"maxLength":5000}', NULL, 0),
  ('fd_company', 'evt_aiewf26', 'company', 'Company', 'text', NULL, '{"maxLength":255}', NULL, 0),
  ('fd_jobtitle', 'evt_aiewf26', 'job_title', 'Job Title', 'text', NULL, '{"maxLength":255}', NULL, 0),
  ('fd_headshot', 'evt_aiewf26', 'headshot', 'Headshot', 'file', NULL, '{"accept":"image/*"}', 'Square, at least 800x800.', 0);

-- Form ----------------------------------------------------------------------

INSERT INTO forms (
  id, event_id, name, public_slug, kind, status, version, collect_participants,
  welcome_html, terms_html, success_html,
  close_at, reminder_at, submission_limit, allow_multiple_drafts,
  admin_notify_new, admin_notify_update,
  participant_roles, participant_cap
) VALUES (
  'frm_cfp26', 'evt_aiewf26', 'Call for Speakers 2026', 'cfp-2026',
  'sessions', 'open', 1, 1,
  '<h2>Speak at AI Engineer World''s Fair 2026</h2><p>We are looking for talks and workshops from people shipping real systems. Production war stories beat product demos every time.</p>',
  '<p>By submitting you agree to be recorded and to have your session published on our YouTube channel.</p>',
  '<h3>Thanks, we have it.</h3><p>Reviews go out the week of September 22. You can edit your submission until the deadline from your speaker portal.</p>',
  1789491540, 1788886740, 3, 0,
  '["swyx@ai.engineer","chrissy@ai.engineer"]',
  '["swyx@ai.engineer"]',
  '[{"role":"Speaker","min":1,"max":3},{"role":"Moderator","min":0,"max":1},{"role":"Panelist","min":0,"max":4}]', 5
);

INSERT INTO form_fields (id, form_id, field_definition_id, step, sort_order, required, locked, conditional_rule) VALUES
  ('ff_1', 'frm_cfp26', 'fd_title', 'submission', 0, 1, 1, NULL),
  ('ff_2', 'frm_cfp26', 'fd_desc', 'submission', 1, 1, 1, NULL),
  ('ff_3', 'frm_cfp26', 'fd_format', 'submission', 2, 1, 0, NULL),
  ('ff_4', 'frm_cfp26', 'fd_track', 'submission', 3, 1, 0, NULL),
  ('ff_5', 'frm_cfp26', 'fd_level', 'submission', 4, 1, 0, NULL),
  ('ff_6', 'frm_cfp26', 'fd_tags', 'submission', 5, 0, 0, NULL),
  ('ff_7', 'frm_cfp26', 'fd_takeaways', 'submission', 6, 1, 0, NULL),
  ('ff_8', 'frm_cfp26', 'fd_wsprereq', 'submission', 7, 1, 0, '{"showIf":{"fieldKey":"format","op":"eq","value":"Workshop (90 min)"}}'),
  ('ff_9', 'frm_cfp26', 'fd_wscap', 'submission', 8, 0, 0, '{"showIf":{"fieldKey":"format","op":"eq","value":"Workshop (90 min)"}}'),
  ('ff_10', 'frm_cfp26', 'fd_first', 'participant', 0, 1, 1, NULL),
  ('ff_11', 'frm_cfp26', 'fd_last', 'participant', 1, 1, 1, NULL),
  ('ff_12', 'frm_cfp26', 'fd_email', 'participant', 2, 1, 1, NULL),
  ('ff_13', 'frm_cfp26', 'fd_company', 'participant', 3, 1, 0, NULL),
  ('ff_14', 'frm_cfp26', 'fd_jobtitle', 'participant', 4, 0, 0, NULL),
  ('ff_15', 'frm_cfp26', 'fd_phone', 'participant', 5, 0, 0, NULL),
  ('ff_16', 'frm_cfp26', 'fd_bio', 'participant', 6, 1, 0, NULL),
  ('ff_17', 'frm_cfp26', 'fd_headshot', 'participant', 7, 0, 0, NULL);

-- Evaluation plan (referenced by a routing rule, so it comes first) ----------

INSERT INTO evaluation_plans (id, event_id, name, criteria, scale_min, scale_max, rounds, anonymize) VALUES
  ('plan_main', 'evt_aiewf26', 'Main Program Review',
   '[{"key":"relevance","name":"Relevance","weight":30,"description":"Does this matter to engineers shipping today?"},{"key":"depth","name":"Technical Depth","weight":30,"description":"Is there real substance beyond a product pitch?"},{"key":"speaker","name":"Speaker Credibility","weight":20,"description":"Have they actually built this?"},{"key":"clarity","name":"Clarity","weight":20,"description":"Is the abstract well written and specific?"}]',
   1, 5, 1, 1),
  ('plan_ws', 'evt_aiewf26', 'Workshop Review',
   '[{"key":"handson","name":"Hands On Value","weight":50,"description":"Will attendees build something?"},{"key":"prereq","name":"Prerequisite Clarity","weight":25,"description":"Is setup realistic for 90 minutes?"},{"key":"depth","name":"Technical Depth","weight":25,"description":"Is there real substance?"}]',
   1, 5, 1, 0);

-- Routing: workshops go to the workshop review plan automatically ------------

INSERT INTO routing_rules (id, form_id, when_field_key, when_op, when_value, assign_track_id, assign_plan_id, assign_tag_ids, notify_emails, sort_order) VALUES
  ('rr_ws', 'frm_cfp26', 'format', 'eq', 'Workshop (90 min)', NULL, 'plan_ws', NULL, '["workshops@ai.engineer"]', 0),
  ('rr_infra', 'frm_cfp26', 'track', 'eq', 'LLM Infra', 'trk_infra', 'plan_main', NULL, NULL, 1),
  ('rr_sponsor', 'frm_cfp26', 'tags', 'contains', 'Sponsor Session', NULL, NULL, '["tag_sponsor"]', '["sponsors@ai.engineer"]', 2);

-- Participants --------------------------------------------------------------

INSERT INTO participants (id, event_id, email, first_name, last_name, company, job_title, bio, links, is_evaluator, is_admin) VALUES
  ('p_swyx', 'evt_aiewf26', 'swyx@ai.engineer', 'Shawn', 'Wang', 'AI Engineer', 'Curator', 'Organizer of the AI Engineer World''s Fair.', '{"twitter":"https://x.com/swyx"}', 0, 1),
  ('p_chrissy', 'evt_aiewf26', 'chrissy@ai.engineer', 'Chrissy', 'Alvarez', 'AI Engineer', 'Program Director', NULL, NULL, 1, 1),
  ('p_kelsey', 'evt_aiewf26', 'kelsey@ai.engineer', 'Kelsey', 'Mohland', 'AI Engineer', 'Producer', NULL, NULL, 1, 1),
  ('p_chen', 'evt_aiewf26', 'sarah.chen@vectorworks.dev', 'Sarah', 'Chen', 'Vectorworks', 'Staff Engineer', 'Sarah has spent four years making retrieval systems fail less often in production. She writes about the parts nobody benchmarks.', '{"linkedin":"https://linkedin.com/in/sarahchen","website":"https://sarahchen.dev"}', 0, 0),
  ('p_okafor', 'evt_aiewf26', 'd.okafor@runloop.io', 'Daniel', 'Okafor', 'Runloop', 'Principal Engineer', 'Daniel builds agent infrastructure and has strong opinions about sandboxing.', '{"twitter":"https://x.com/dokafor"}', 0, 0),
  ('p_lindqvist', 'evt_aiewf26', 'maja@evalkit.dev', 'Maja', 'Lindqvist', 'EvalKit', 'Founder', 'Maja started EvalKit after watching three teams ship LLM features with no regression testing at all.', '{"website":"https://evalkit.dev"}', 0, 0),
  ('p_torres', 'evt_aiewf26', 'r.torres@northbeam.ai', 'Rafael', 'Torres', 'Northbeam', 'ML Platform Lead', 'Rafael runs inference for a few hundred million requests a month and would like to talk about the bill.', NULL, 0, 0),
  ('p_ito', 'evt_aiewf26', 'yuki.ito@kaido.jp', 'Yuki', 'Ito', 'Kaido', 'Research Engineer', 'Yuki works on long context retrieval and Japanese language evaluation.', NULL, 0, 0),
  ('p_ferreira', 'evt_aiewf26', 'bruno@stackline.dev', 'Bruno', 'Ferreira', 'Stackline', 'Engineering Manager', NULL, NULL, 0, 0),
  ('p_novak', 'evt_aiewf26', 'e.novak@vectorworks.dev', 'Elena', 'Novak', 'Vectorworks', 'Developer Advocate', 'Elena teaches people to use vector databases without shooting themselves in the foot.', NULL, 0, 0),
  ('p_adeyemi', 'evt_aiewf26', 'tunde@parallelgraph.com', 'Tunde', 'Adeyemi', 'ParallelGraph', 'CTO', NULL, NULL, 0, 0),
  ('p_bergman', 'evt_aiewf26', 'lisa.bergman@quorum.sh', 'Lisa', 'Bergman', 'Quorum', 'Staff SRE', NULL, NULL, 0, 0);

-- Submissions ---------------------------------------------------------------
-- Every list tab has content. Two schedule conflicts are planted on purpose.
--   Conflict 1: SESS-2 and SESS-3 both in Golden Gate Ballroom at 14:00 Oct 12.
--   Conflict 2: Sarah Chen speaks in SESS-1 and SESS-4 at the same 10:00 slot.

INSERT INTO submissions (id, event_id, form_id, ref, ref_seq, kind, title, description, status, track_id, format, level, answers, tag_ids, room_id, starts_at, ends_at, is_draft_schedule, submitted_at, decided_at, notified_at) VALUES

  ('sub_1', 'evt_aiewf26', 'frm_cfp26', 'SESS-1', 1, 'sessions',
   'Your RAG Pipeline Is Lying To You',
   '<p>Retrieval metrics look great in eval and fall apart in production. We instrumented ours end to end and found three failure modes nobody writes about.</p>',
   'accepted', 'trk_rag', 'Talk (25 min)', 'Intermediate',
   '{"takeaways":"How to instrument retrieval in prod\nThe three failure modes\nWhat to alert on"}',
   '["tag_prod","tag_oss"]', 'rm_ggb', 1791824400, 1791825900, 0, 1788307200, 1789344000, 1789347600),

  ('sub_2', 'evt_aiewf26', 'frm_cfp26', 'SESS-2', 2, 'sessions',
   'Sandboxing Agents Without Losing Your Mind',
   '<p>Every agent framework hand-waves the execution boundary. Here is what actually holds up when the model decides to run rm -rf.</p>',
   'accepted', 'trk_agents', 'Talk (25 min)', 'Advanced',
   '{"takeaways":"Threat model for tool-calling agents\nContainer vs microVM tradeoffs\nWhat we shipped"}',
   '["tag_prod"]', 'rm_ggb', 1791838800, 1791840300, 0, 1788393600, 1789344000, 1789347600),

  ('sub_3', 'evt_aiewf26', 'frm_cfp26', 'SESS-3', 3, 'sessions',
   'Regression Testing for LLM Features',
   '<p>Your prompt changed and something broke three weeks later. A practical eval harness you can add to CI this afternoon.</p>',
   'accepted', 'trk_evals', 'Talk (25 min)', 'Beginner',
   '{"takeaways":"Golden datasets that stay useful\nScoring without a human in the loop\nWiring it into CI"}',
   '["tag_oss","tag_beginner"]', 'rm_ggb', 1791838800, 1791840300, 0, 1788480000, 1789344000, 1789347600),

  ('sub_4', 'evt_aiewf26', 'frm_cfp26', 'SESS-4', 4, 'sessions',
   'Hybrid Search in Ninety Minutes',
   '<p>Hands on workshop. Build a hybrid dense and sparse retrieval pipeline from an empty repo and measure why it beats either one alone.</p>',
   'accepted', 'trk_rag', 'Workshop (90 min)', 'Intermediate',
   '{"takeaways":"BM25 and embeddings together\nReranking that earns its latency\nMeasuring the delta","workshop_prereqs":"Python 3.11, Docker, and an OpenAI API key. Clone the repo before you arrive.","workshop_capacity":60}',
   '["tag_oss"]', 'rm_bay', 1791824400, 1791829800, 0, 1788566400, 1789344000, 1789347600),

  ('sub_5', 'evt_aiewf26', 'frm_cfp26', 'SESS-5', 5, 'sessions',
   'The Inference Bill: A Postmortem',
   '<p>We cut inference spend by 71 percent over two quarters. Most of it was not model selection.</p>',
   'accepted', 'trk_infra', 'Talk (25 min)', 'Intermediate',
   '{"takeaways":"Where the money actually goes\nCaching that works\nWhen to self host"}',
   '["tag_prod"]', 'rm_mission', 1791828000, 1791829500, 0, 1788652800, 1789344000, NULL),

  ('sub_6', 'evt_aiewf26', 'frm_cfp26', 'SESS-6', 6, 'sessions',
   'Opening Keynote: What Changed This Year',
   '<p>A survey of what actually shipped in AI engineering over the last twelve months, and what it means for the year ahead.</p>',
   'accepted', 'trk_aieng', 'Keynote', 'Beginner',
   '{"takeaways":"The year in review\nWhat is now table stakes\nWhat is still unsolved"}',
   NULL, 'rm_ggb', 1791820800, 1791823500, 0, 1788739200, 1789344000, 1789347600),

  ('sub_7', 'evt_aiewf26', 'frm_cfp26', 'SESS-7', 7, 'sessions',
   'Long Context Retrieval for Japanese',
   '<p>Tokenization assumptions baked into most retrieval stacks quietly degrade non-Latin languages. Measurements and fixes.</p>',
   'accept_queue', 'trk_rag', 'Talk (25 min)', 'Advanced',
   '{"takeaways":"Where tokenizers hurt recall\nBenchmark results\nPractical mitigations"}',
   '["tag_research"]', NULL, NULL, NULL, 1, 1788825600, NULL, NULL),

  ('sub_8', 'evt_aiewf26', 'frm_cfp26', 'SESS-8', 8, 'sessions',
   'Observability for Agent Traces',
   '<p>Agent runs are trees, not lines. Standard APM tooling renders them uselessly. What we built instead.</p>',
   'accept_queue', 'trk_evals', 'Talk (25 min)', 'Intermediate',
   '{"takeaways":"Why span-based tracing breaks\nA tree-first data model\nOpen source tooling"}',
   '["tag_oss"]', NULL, NULL, NULL, 1, 1788912000, NULL, NULL),

  ('sub_9', 'evt_aiewf26', 'frm_cfp26', 'SESS-9', 9, 'sessions',
   'Introducing ParallelGraph Cloud',
   '<p>A walkthrough of our new managed platform and how it accelerates agent development.</p>',
   'decline_queue', 'trk_agents', 'Talk (25 min)', 'Beginner',
   '{"takeaways":"Platform overview\nPricing\nGetting started"}',
   '["tag_sponsor"]', NULL, NULL, NULL, 1, 1788998400, NULL, NULL),

  ('sub_10', 'evt_aiewf26', 'frm_cfp26', 'SESS-10', 10, 'sessions',
   'Ten Prompt Engineering Tricks',
   '<p>A rapid tour of prompting techniques that have worked for us.</p>',
   'declined', 'trk_aieng', 'Lightning Talk (10 min)', 'Beginner',
   '{"takeaways":"Ten tricks"}',
   NULL, NULL, NULL, NULL, 1, 1789084800, 1789430400, 1789434000),

  ('sub_11', 'evt_aiewf26', 'frm_cfp26', 'SESS-11', 11, 'sessions',
   'Running Postgres as a Vector Store at Scale',
   '<p>pgvector past a hundred million rows. Index choices, maintenance windows, and the query patterns that fall over.</p>',
   'pending', 'trk_infra', 'Talk (25 min)', 'Advanced',
   '{"takeaways":"HNSW vs IVFFlat at scale\nMaintenance cost\nWhen to move off Postgres"}',
   '["tag_prod"]', NULL, NULL, NULL, 1, 1789171200, NULL, NULL),

  ('sub_12', 'evt_aiewf26', 'frm_cfp26', 'SESS-12', 12, 'sessions',
   'Evaluating Multi Turn Conversations',
   '<p>Single turn evals miss almost everything that matters in a chat product.</p>',
   'pending', 'trk_evals', 'Talk (25 min)', 'Intermediate',
   '{"takeaways":"Why single turn evals mislead\nConversation-level metrics\nAnnotation strategy"}',
   NULL, NULL, NULL, NULL, 1, 1789257600, NULL, NULL),

  ('sub_13', 'evt_aiewf26', 'frm_cfp26', 'SESS-13', 13, 'sessions',
   'Untitled draft',
   '<p></p>',
   'draft', NULL, NULL, NULL,
   '{}', NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL),

  ('sub_14', 'evt_aiewf26', 'frm_cfp26', 'SESS-14', 14, 'sessions',
   'Fine Tuning Small Models on a Budget',
   '<p>Withdrawn by the submitter, scheduling conflict.</p>',
   'withdrawn', 'trk_infra', 'Talk (25 min)', 'Intermediate',
   '{"takeaways":"LoRA economics"}',
   NULL, NULL, NULL, NULL, 1, 1789344000, NULL, NULL);

-- A second form and two abstracts, so /admin/abstracts has something in it
-- and the kind scoping is visible rather than theoretical.

INSERT INTO forms (
  id, event_id, name, public_slug, kind, status, version, collect_participants,
  welcome_html, success_html, close_at, submission_limit, allow_multiple_drafts,
  participant_roles, participant_cap
) VALUES (
  'frm_abs26', 'evt_aiewf26', 'Call for Abstracts 2026', 'abstracts-2026',
  'abstracts', 'open', 1, 1,
  '<p>Pitch an idea in a paragraph. We will help you shape it into a session.</p>',
  '<p>Got it. We read abstracts in batches every fortnight.</p>',
  1789491540, 5, 1,
  '[{"role":"Speaker","min":1,"max":2}]', 2
);

INSERT INTO submissions (id, event_id, form_id, ref, ref_seq, kind, title, description, status, track_id, format, level, answers, tag_ids, is_draft_schedule, submitted_at) VALUES
  ('sub_a1', 'evt_aiewf26', 'frm_abs26', 'ABS-1', 101, 'abstracts',
   'Something About Vector Index Maintenance',
   '<p>Rough idea: nobody talks about what happens to an index six months in. I have numbers.</p>',
   'pending', 'trk_infra', NULL, NULL, '{}', NULL, 1, 1789257600),
  ('sub_a2', 'evt_aiewf26', 'frm_abs26', 'ABS-2', 102, 'abstracts',
   'Teaching Non Engineers To Read Evals',
   '<p>Half formed. Our PMs could not read our eval dashboards, so we rebuilt them.</p>',
   'accept_queue', 'trk_evals', NULL, NULL, '{}', NULL, 1, 1789344000);

-- Speakers on submissions ---------------------------------------------------

INSERT INTO submission_participants (id, submission_id, participant_id, role, sort_order, is_primary) VALUES
  ('sp_1', 'sub_1', 'p_chen', 'Speaker', 0, 1),
  ('sp_2', 'sub_2', 'p_okafor', 'Speaker', 0, 1),
  ('sp_3', 'sub_3', 'p_lindqvist', 'Speaker', 0, 1),
  ('sp_4', 'sub_4', 'p_chen', 'Speaker', 0, 1),
  ('sp_5', 'sub_4', 'p_novak', 'Speaker', 1, 0),
  ('sp_6', 'sub_5', 'p_torres', 'Speaker', 0, 1),
  ('sp_7', 'sub_6', 'p_swyx', 'Speaker', 0, 1),
  ('sp_8', 'sub_7', 'p_ito', 'Speaker', 0, 1),
  ('sp_9', 'sub_8', 'p_ferreira', 'Speaker', 0, 1),
  ('sp_10', 'sub_9', 'p_adeyemi', 'Speaker', 0, 1),
  ('sp_11', 'sub_10', 'p_bergman', 'Speaker', 0, 1),
  ('sp_12', 'sub_11', 'p_bergman', 'Speaker', 0, 1),
  ('sp_13', 'sub_12', 'p_lindqvist', 'Speaker', 0, 1),
  ('sp_14', 'sub_13', 'p_ferreira', 'Speaker', 0, 1),
  ('sp_15', 'sub_14', 'p_torres', 'Speaker', 0, 1),
  ('sp_16', 'sub_a1', 'p_bergman', 'Speaker', 0, 1),
  ('sp_17', 'sub_a2', 'p_novak', 'Speaker', 0, 1);

-- Onboarding tasks ----------------------------------------------------------

INSERT INTO tasks (id, event_id, name, description, kind, applies_to, due_at, required, sort_order) VALUES
  ('tsk_headshot', 'evt_aiewf26', 'Upload your headshot', 'Square image, at least 800x800. Used on the website and in signage.', 'upload_headshot', 'all_accepted_speakers', 1790467200, 1, 0),
  ('tsk_bio', 'evt_aiewf26', 'Confirm your biography', 'Check the bio we have on file and edit if needed. This is what the emcee reads.', 'confirm_bio', 'all_accepted_speakers', 1790467200, 1, 1),
  ('tsk_slides', 'evt_aiewf26', 'Upload your slides', 'PDF or Keynote. We load them onto the house machine in advance.', 'upload_slides', 'all_accepted_speakers', 1791244800, 1, 2),
  ('tsk_release', 'evt_aiewf26', 'Sign the recording release', 'Required before we can publish your talk.', 'sign_release', 'all_accepted_speakers', 1790467200, 1, 3),
  ('tsk_attend', 'evt_aiewf26', 'Confirm travel and arrival', 'Let us know your arrival day so we can schedule your tech check.', 'confirm_attendance', 'all_accepted_speakers', 1790812800, 0, 4);

-- Mixed completion so the onboarding dashboard has a real spread -------------

INSERT INTO task_assignments (id, task_id, participant_id, submission_id, status, completed_at, last_nudged_at) VALUES
  ('ta_1', 'tsk_headshot', 'p_chen', 'sub_1', 'complete', 1789603200, NULL),
  ('ta_2', 'tsk_bio', 'p_chen', 'sub_1', 'complete', 1789603200, NULL),
  ('ta_3', 'tsk_slides', 'p_chen', 'sub_1', 'not_started', NULL, NULL),
  ('ta_4', 'tsk_release', 'p_chen', 'sub_1', 'complete', 1789689600, NULL),
  ('ta_5', 'tsk_attend', 'p_chen', 'sub_1', 'not_started', NULL, NULL),

  ('ta_6', 'tsk_headshot', 'p_okafor', 'sub_2', 'not_started', NULL, 1789948800),
  ('ta_7', 'tsk_bio', 'p_okafor', 'sub_2', 'not_started', NULL, 1789948800),
  ('ta_8', 'tsk_slides', 'p_okafor', 'sub_2', 'not_started', NULL, NULL),
  ('ta_9', 'tsk_release', 'p_okafor', 'sub_2', 'overdue', NULL, 1789948800),
  ('ta_10', 'tsk_attend', 'p_okafor', 'sub_2', 'not_started', NULL, NULL),

  ('ta_11', 'tsk_headshot', 'p_lindqvist', 'sub_3', 'complete', 1789516800, NULL),
  ('ta_12', 'tsk_bio', 'p_lindqvist', 'sub_3', 'complete', 1789516800, NULL),
  ('ta_13', 'tsk_slides', 'p_lindqvist', 'sub_3', 'in_progress', NULL, NULL),
  ('ta_14', 'tsk_release', 'p_lindqvist', 'sub_3', 'complete', 1789516800, NULL),
  ('ta_15', 'tsk_attend', 'p_lindqvist', 'sub_3', 'complete', 1789603200, NULL),

  ('ta_16', 'tsk_headshot', 'p_novak', 'sub_4', 'complete', 1789776000, NULL),
  ('ta_17', 'tsk_bio', 'p_novak', 'sub_4', 'not_started', NULL, NULL),
  ('ta_18', 'tsk_slides', 'p_novak', 'sub_4', 'not_started', NULL, NULL),
  ('ta_19', 'tsk_release', 'p_novak', 'sub_4', 'not_started', NULL, NULL),
  ('ta_20', 'tsk_attend', 'p_novak', 'sub_4', 'waived', NULL, NULL),

  ('ta_21', 'tsk_headshot', 'p_torres', 'sub_5', 'complete', 1789430400, NULL),
  ('ta_22', 'tsk_bio', 'p_torres', 'sub_5', 'complete', 1789430400, NULL),
  ('ta_23', 'tsk_slides', 'p_torres', 'sub_5', 'complete', 1790035200, NULL),
  ('ta_24', 'tsk_release', 'p_torres', 'sub_5', 'complete', 1789430400, NULL),
  ('ta_25', 'tsk_attend', 'p_torres', 'sub_5', 'complete', 1789516800, NULL),

  ('ta_26', 'tsk_headshot', 'p_swyx', 'sub_6', 'complete', 1789344000, NULL),
  ('ta_27', 'tsk_bio', 'p_swyx', 'sub_6', 'complete', 1789344000, NULL),
  ('ta_28', 'tsk_slides', 'p_swyx', 'sub_6', 'not_started', NULL, NULL),
  ('ta_29', 'tsk_release', 'p_swyx', 'sub_6', 'complete', 1789344000, NULL),
  ('ta_30', 'tsk_attend', 'p_swyx', 'sub_6', 'complete', 1789344000, NULL);

-- Evaluation ----------------------------------------------------------------

UPDATE participants SET is_evaluator = 1 WHERE id IN ('p_chrissy', 'p_kelsey');

INSERT INTO assignments (id, plan_id, participant_id, submission_id, round, status) VALUES
  ('as_1', 'plan_main', 'p_chrissy', 'sub_7', 1, 'complete'),
  ('as_2', 'plan_main', 'p_chrissy', 'sub_8', 1, 'complete'),
  ('as_3', 'plan_main', 'p_chrissy', 'sub_11', 1, 'pending'),
  ('as_4', 'plan_main', 'p_chrissy', 'sub_12', 1, 'pending'),
  ('as_5', 'plan_main', 'p_kelsey', 'sub_7', 1, 'complete'),
  ('as_6', 'plan_main', 'p_kelsey', 'sub_8', 1, 'pending'),
  ('as_7', 'plan_main', 'p_kelsey', 'sub_9', 1, 'complete'),
  ('as_8', 'plan_main', 'p_kelsey', 'sub_11', 1, 'pending'),
  ('as_9', 'plan_ws', 'p_chrissy', 'sub_4', 1, 'complete');

INSERT INTO scores (id, assignment_id, criterion_key, value, comment) VALUES
  ('sc_1', 'as_1', 'relevance', 5, 'Nobody is covering this and it affects a lot of people.'),
  ('sc_2', 'as_1', 'depth', 5, NULL),
  ('sc_3', 'as_1', 'speaker', 4, NULL),
  ('sc_4', 'as_1', 'clarity', 4, 'Abstract is a little dense but the substance is there.'),
  ('sc_5', 'as_2', 'relevance', 4, NULL),
  ('sc_6', 'as_2', 'depth', 4, NULL),
  ('sc_7', 'as_2', 'speaker', 4, NULL),
  ('sc_8', 'as_2', 'clarity', 5, NULL),
  ('sc_9', 'as_5', 'relevance', 5, NULL),
  ('sc_10', 'as_5', 'depth', 4, NULL),
  ('sc_11', 'as_5', 'speaker', 5, NULL),
  ('sc_12', 'as_5', 'clarity', 4, NULL),
  ('sc_13', 'as_7', 'relevance', 2, 'This is a product pitch.'),
  ('sc_14', 'as_7', 'depth', 1, NULL),
  ('sc_15', 'as_7', 'speaker', 3, NULL),
  ('sc_16', 'as_7', 'clarity', 3, NULL),
  ('sc_17', 'as_9', 'handson', 5, 'Strong prereq list, realistic scope for 90 minutes.'),
  ('sc_18', 'as_9', 'prereq', 5, NULL),
  ('sc_19', 'as_9', 'depth', 4, NULL);

-- Elena Novak and Sarah Chen are both Vectorworks, so Elena cannot review
-- Sarah's session. Auto-detected on company match.

INSERT INTO evaluator_conflicts (id, participant_id, submission_id, reason, auto_detected) VALUES
  ('ec_1', 'p_novak', 'sub_1', 'same_company', 1);

-- Email templates -----------------------------------------------------------

INSERT INTO email_templates (id, event_id, key, name, subject, body_html, "trigger", attach_ics, enabled) VALUES
  ('et_confirm', 'evt_aiewf26', 'submission_confirmation', 'Submission Confirmation',
   'We have your submission: {{submission.title}}',
   '<p>Hi {{participant.firstName}},</p><p>Thanks for submitting <strong>{{submission.title}}</strong> to {{event.name}}.</p><p>Your reference is <strong>{{submission.ref}}</strong>. Quote it if you need to get in touch about this proposal.</p><p><a href="{{magicLinkUrl}}">Open your speaker portal</a> to review or update it until {{form.closeAt}}. That link signs you in directly and works once, for {{expiresInHours}} hours. After that you can request a new one at {{portalUrl}}.</p>',
   'on_submit', 0, 1),
  ('et_accept', 'evt_aiewf26', 'acceptance', 'Acceptance',
   'You are speaking at {{event.name}}',
   '<p>Hi {{participant.firstName}},</p><p>We would love to have <strong>{{submission.title}}</strong> at {{event.name}}. Congratulations.</p><p>Your session is scheduled for {{submission.startsAt}}{{#room}} in {{room.name}}{{/room}}. A calendar invite is attached.</p><p>There are a few things we need from you before the event. <a href="{{portalUrl}}">See your task list</a>.</p>',
   'on_accept', 1, 1),
  ('et_decline', 'evt_aiewf26', 'decline', 'Decline',
   'About your {{event.name}} submission',
   '<p>Hi {{participant.firstName}},</p><p>Thanks for submitting <strong>{{submission.title}}</strong>. We had far more strong proposals than slots this year and could not fit it in.</p><p>We hope you will submit again next year.</p>',
   'on_decline', 0, 1),
  ('et_magic', 'evt_aiewf26', 'magic_link', 'Sign-in Link',
   'Your sign-in link for {{event.name}}',
   '<p>Hi {{participant.firstName}},</p><p>Here is your sign-in link for {{event.name}}. It works once and expires in {{expiresInMinutes}} minutes.</p><p><a href="{{magicLinkUrl}}">Open your speaker portal</a></p><p>If you did not ask for this, you can ignore it and nothing will happen.</p>',
   'magic_link', 0, 1),
  ('et_reminder', 'evt_aiewf26', 'task_reminder', 'Task Reminder',
   'Still need a few things from you for {{event.name}}',
   '<p>Hi {{participant.firstName}},</p><p>You have {{openTaskCount}} outstanding item(s) before {{event.name}}:</p>{{taskList}}<p><a href="{{portalUrl}}">Complete them here</a></p>',
   'task_reminder', 0, 1),
  ('et_schedule', 'evt_aiewf26', 'schedule_published', 'Schedule Update',
   'Your session time has been updated',
   '<p>Hi {{participant.firstName}},</p><p><strong>{{submission.title}}</strong> is now scheduled for {{submission.startsAt}}{{#room}} in {{room.name}}{{/room}}.</p><p>Your calendar invite has been updated automatically.</p>',
   'schedule_published', 1, 1);

-- Embeds --------------------------------------------------------------------

INSERT INTO embeds (id, event_id, name, format, enabled, public_token, style, filters, fields) VALUES
  ('emb_agenda', 'evt_aiewf26', 'Public Agenda', 'agenda', 1, 'pub_agenda_aiewf26',
   '{"accent":"#6366f1","font":"system","density":"comfortable"}',
   '{"status":["accepted"],"includeDrafts":false}',
   '{"showRoom":true,"showTrack":true,"showSpeakers":true,"showLevel":false}'),
  ('emb_speakers', 'evt_aiewf26', 'Speaker Gallery', 'speaker_gallery', 1, 'pub_speakers_aiewf26',
   '{"accent":"#6366f1","columns":4}',
   '{"status":["accepted"]}',
   '{"showCompany":true,"showBio":true,"showLinks":true}');
