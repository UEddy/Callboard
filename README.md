# Callboard

Callboard is an open source call for speakers and event programme management tool. It covers the whole arc of putting a conference programme together: you build a submission form, speakers submit through a public link without creating a password, a review committee scores what came in, you stage accept and decline decisions and send them as a batch with real calendar invites attached, you drag the accepted sessions onto a room grid that tells you when you have double booked a room or a person, and you chase speakers for headshots and slides from a dashboard that sorts the worst offenders to the top. It runs on Cloudflare Workers with a D1 database, so a full event fits inside free tier limits and deploys with one push.

## Screenshots

<!-- TODO: Admin submissions list, showing the status tabs and the "Not sent" flag -->

<!-- TODO: Form builder, showing the publish preflight panel and the conditional logic row -->

<!-- TODO: Public submission form, the proposal step with a conditional field visible -->

<!-- TODO: Speaker portal, the task list with an overdue item -->

<!-- TODO: Evaluation, the scoring queue with weighted criteria -->

<!-- TODO: Evaluation results, the weighted ranking table -->

<!-- TODO: Decisions, the accept queue and the recent mail log with sequence numbers -->

<!-- TODO: Agenda, the room grid mid drag with a conflict highlighted -->

<!-- TODO: Agenda conflicts tab -->

<!-- TODO: Speaker onboarding dashboard, the task matrix sorted worst first -->

## What it does

The brief asked for six things. Here is where each one lives and what is actually built.

### 1. Custom forms with conditional logic and routing

`/admin/forms` and `/admin/forms/:formId`.

Fields come from a per event library (`field_definitions`), so "Track" means the same thing on every form and reporting lines up across forms. A form pulls fields out of that library into two steps, the proposal itself and the speaker details. Each field can be made required, reordered, or removed, except locked system fields like title and email which can be reordered but not deleted.

Conditional logic is set per field: "only show this field when Format is Workshop (90 min)". The rule is stored as JSON on the form field row and evaluated live in the browser as the submitter types, so the workshop prerequisites question appears the moment someone picks a workshop format and never appears for anyone else.

Routing rules run at submit time, from both the public form and the API, through one shared implementation so the two cannot drift. A rule matches on any answer with `eq`, `neq`, `in`, or `contains`, and can set the track, attach tags, and send the submission to an evaluation plan with reviewers assigned. The demo event seeds three: workshops go to the workshop review plan, LLM Infra submissions get the infra track, and sponsor tagged submissions get the sponsor tag.

The same list is served three ways: /admin/submissions for everything, /admin/abstracts and /admin/sessions scoped by submission kind, all from one implementation so the scoped views cannot drift. Status is editable inline from the pill on any of them, saved optimistically. Nothing on these screens sends email. An Options menu on each list, on the agenda, and on the evaluation results, exports exactly the rows on screen as CSV or XLSX, carrying the active tab, search, filters and sort into the export.

Everything a rule does is recorded on the submission as a routing trail and shown on the submission detail page under "How it got here", in plain language: `Because Format is "Workshop (90 min)": sent to Workshop Review with 2 reviewers assigned`.

Submissions carry as many people as the form allows. The builder picks which roles submitters may add, drawn from the personas library, with an optional minimum and maximum per role and a cap across all roles. The public form adds the submitter automatically as the primary Speaker and lets them add co participants with name, email, role, company, job title and biography. Every participant and their role shows on the submissions list and the detail page.

The library itself is at /admin/library, in five tabs. Fields defines the field definitions with type, options, help text and validation, and names the forms each one is used on before you delete it. Tags shows how many submissions carry each one. Personas defines the roles the participant picker offers. Rooms are the columns on the agenda grid, with capacity and order. Tracks are the programme's subject strands, with the colour that identifies a session everywhere it appears. All five feed the rest of the app immediately, and destructive edits propagate: renaming a persona rewrites the participant rules on every form naming it, and deleting a tag pulls it out of the submissions and routing rules referencing it, since a JSON array has no foreign key to protect it.

Deleting a room or a track names what it is about to disturb before it happens, and offers somewhere to put it. A room lists the sessions in it by reference, and deleting either moves them into another room, keeping their times, or leaves them scheduled with no room and says so. A track lists its submissions, the routing rule that assigns it, the task scoped to it and the embed filtered to it, then either moves all of that to another track or clears it. The embed filter in particular is rewritten rather than left pointing at a track that no longer exists, because that failure mode is a public programme page that quietly renders nothing. The one reference not rewritten is a task with nowhere to move to: it carries real completion records for real people, so widening its audience to every accepted speaker would assign work nobody meant to ask for. It keeps its scope, the Tasks screen already labels that "a deleted track", and the confirmation says which task it is and that it now applies to nobody.

Both are reachable from /admin/agenda, since that is where a producer is standing when they discover the room is missing: the header links to each tab, every room column header links to its own entry, and a grid with no rooms at all says so and offers to add one rather than drawing an empty table.

### 2. Self-service speaker portal

`/portal`.

Speakers sign in with a magic link emailed to them, no password. Once in, they see every submission they are attached to with a plain language status ("Under review", not "accept_queue"), the scheduled time and room for anything accepted, a task list of everything still owed, and a profile form for the bio and headshot that end up on the website and in the emcee's notes.

The Submissions tab shows each one in full: every answer the form collected, in the order the form asked for it and under the label the speaker saw when they answered, rather than the raw `answers` keys. Conditional fields follow the same rule they did on the form, so the workshop prerequisites only appear on the workshop. Accepted sessions carry the day, the time in the event's zone, the length and the room, or say the room is still to be confirmed. Everyone else on the submission is listed with their role.

While the form is still open the speaker can edit the proposal from there, through the same field renderer and the same save path as the public form, which means routing re-runs on their edit exactly as it would have at submit time. Once the close date passes the submission goes read only with a line saying when editing closed and who to contact. The profile also takes pronouns and gender, both optional, both free text with the common answers offered as suggestions.

Headshots and slides are real uploads into R2, stored under `events/{eventId}/{participantId}/{filename}` and served back through `/files/...`. Images are capped at 5MB and documents at 25MB. Every upload also offers a paste-a-link alternative, because plenty of speakers keep slides in Drive or Notion and would rather send the link than a copy.

### 3. Automated comms with real calendar invites

`/admin/decisions`, with the mail machinery in `app/lib/email.ts`.

Email templates are stored per event with `{{participant.firstName}}` style variables and a `{{#room}}...{{/room}}` block that only renders once a room exists. Acceptance emails carry an `.ics` calendar part built by hand to RFC 5545, sent with `METHOD:REQUEST` so Gmail and Outlook show native accept and decline buttons rather than an inert attachment.

Submitters get a confirmation the moment they finish, from the public form and the API alike, carrying the reference, the title, the event name and a magic link straight into their portal. It is a per-form toggle in the form builder, on by default: a submitter who gets no acknowledgement assumes it failed and submits again, and the organiser reconciles the duplicate.

The success page hands them into the portal directly as well, without waiting for that email. Submitting sets the portal session cookie alongside the submit one, so the countdown on the thank you page leads somewhere they are already signed in. It is the second per-form toggle, `auto_redirect_to_portal`, also on by default; off replaces the countdown with a Continue button and nothing moves on its own.

Sending is real, through Resend, when `RESEND_API_KEY` is set. When it is not set, nothing is faked: the send is recorded in the email log with status `queued`, and the Decisions page shows a banner saying email is not connected. Every send, real or queued, writes a row to `email_log` with the recipient, subject, template, status, any error, and the calendar sequence number.

That log is a screen of its own at `/admin/emails`, filterable by template, status and recipient, showing the calendar sequence beside each row so a re-send that updated an invitation is distinguishable from one that made a second entry. Opening a row renders the body exactly as it went out, merge fields already substituted, in a sandboxed frame: the body is HTML somebody else wrote merged with values a submitter controls, and the admin origin is the one place where a script tag in a name would do real damage.

The top of that screen answers "is mail working" in a sentence rather than a table, over a rolling seven days: how many sent, queued and failed, and when something has failed, who it was to and why, in the provider's own words pulled out of whatever JSON it returned. It reads from the log rather than from the provider, because the log is the thing that survives the provider changing its API. One caveat it cannot lie about: `sent` means the provider accepted the message, not that it arrived, and a verified sending domain will happily accept an address that later bounces.

Beside it is Send test email: pick any template, type an address, and it goes out merged from a real submission rather than from "Sample Speaker", because half of what is being checked is whether the template reads right with actual names in it. The subject is prefixed `[Test]` and the send is logged like any other, so a failing test shows up in the health panel where it belongs. No sign-in token is minted for a test: a magic link is a way into that speaker's portal, and the test is going to whatever address the organiser typed, which is not theirs.

The same screen composes. Pick recipients from the participants, grouped by what they are to the event, either load a saved template into the boxes or write a one-off, preview the merged result for the first recipient before anything is sent, and every send lands in the log with its body. Loading an acceptance template here names the fields a hand-written send cannot fill, `{{submission.title}}` and the `{{#room}}` sections among them, rather than letting them arrive empty or as literal text.

### 4. Evaluation and scoring

`/admin/evaluation`.

Plans are built on the Plans tab: a name, a score scale, a blind review toggle, and a criteria editor. Each criterion is numeric (the radio scale), a dropdown of the author's own options each carrying the number it scores, or free text, which is recorded and shown but stays out of the arithmetic. Beneath the criteria the weighting is resolved into a sentence, live as the numbers are typed, in the same spirit as the form builder's "what submitters will experience": "Relevance counts for 30 percent, Technical Depth 30 percent, Speaker Credibility 20 percent, Clarity 20 percent." Weights are relative, so 30/30/20/20 and 3/3/2/2 are the same plan and only the percentages say so.

Editing a plan that has already been scored against says how many reviews are affected before anything is saved, and nothing it does deletes a score. Changing a weight re-totals every affected submission. Removing a criterion leaves its scores on record and stops counting them, which falls out of the average being computed over the plan's current criteria rather than over whatever rows exist: put the criterion back and its scores count again. Only deleting the plan destroys work, and that confirmation says exactly how much. A free text answer is stored with a null value rather than a nought, because a nought would drag every average that touched it towards the bottom of the scale.

An evaluation plan defines weighted criteria on a configurable scale, and can be marked blind so evaluator screens hide the speaker's identity. The Review tab is a queue: one submission at a time, the criteria with their weights and descriptions beside it, and a count of how many are left. The Results tab ranks every submission by weighted average, normalised by the sum of the weights that were actually scored, and shows how many of the assigned reviews are complete. The Evaluators tab shows per reviewer progress and the recorded conflicts of interest.

The Review panel on a submission's own page carries the whole score, not a list of names: each reviewer's weighted total, what they gave every criterion against that plan's scale with the criterion's weight beside it, and the comment they left, printed under the criterion it was about rather than pooled at the bottom. That is the material a producer needs open in front of them when a decision is argued about. A reviewer who has not scored yet says so instead of showing zeros. Where the plan is marked blind the identity is replaced by "Reviewer 1" and "Reviewer 2", stable per submission so two reviewers stay distinguishable, and the name is dropped in the loader rather than hidden in the markup: withholding it on screen while shipping it in the page's own JSON payload would be a blindfold with a hole in it. The scores and the comments still show, because blind review is about who said it, not what was said.

The Options menu on that tab exports the evaluations dataset, one row per review rather than per submission, because reviewer names, per-criterion scores and comments only exist at that grain and a committee arguing about a decision needs to see who said what. Each row carries the rank, the submission's weighted score and its review progress, then the plan, the reviewer, their review status and round, their own weighted score, a column per criterion labelled with its weight, and their comments labelled by the criterion they were left on. Plans that score different things share one stable column set, so a workshop review simply leaves the main programme's criteria empty. Scores are written as numbers, not text, so the sheet can be sorted and averaged without anybody retyping a column. The rows come out in the order the screen is in, sort parameters included, and the weighted average itself comes from `app/lib/evaluation.ts`, shared with the table: an export that recomputed the formula with its own copy is how a committee ends up arguing about a ranking that no longer matches the screen.

Score, submission and review count are sortable both ways from the column headers, with the arrow on the active column and the order stated above the table in words. It lives in the URL as `?sort=score&dir=asc`, so "the ranking by review count, fewest first" is a link a chair can send to a co-chair and a reload does not throw it away. Two things stay fixed whatever the order: rank is worked out once from the score, so sorting by title does not renumber it, and a submission nobody has reviewed sits at the bottom in both directions, because no score is not the same as a low one.

Auto-assign spreads unreviewed submissions across evaluators round robin, two reviewers each by default, skipping anyone with a recorded conflict.

Conflicts get recorded two ways. Callboard detects the one it can see, an evaluator working at the same company as a speaker. The rest only the evaluator knows, so there is a Declare a conflict control in their review queue: pick a reason, confirm, and the submission leaves their queue permanently, every assignment they hold on it goes with it, and auto-assign will not hand it back. Whose conflict it is comes from the assignment rather than a hidden field, because a participant id in a form is a way to record a conflict against somebody else. Both kinds show on the Evaluators tab with who cannot review what and why, tagged `auto` or `declared`, and that list is scoped to the event rather than to submissions that still have an assignment: a conflict that vanished from the record the moment it did its job would be worse than not writing it down.

### 5. Drag and drop schedule with conflict detection

`/admin/agenda`.

A room by time grid, thirty minute slots, one tab per event day, derived in the event's timezone so the builder's Day 1 is the same date as the public agenda's. Accepted sessions that have no slot sit in a tray on the left. Drag one onto the grid, or click it and then click the slot, which matters on a laptop trackpad and for anyone who cannot drag. Placed sessions can be dragged again to move them, or removed back to the tray.

Session length is read out of the format string rather than looked up in a table of the four spellings the demo happens to use, so "Talk (30 min)", "Workshop (120 min)", "Panel (1.5 hours)" and "Demo (45m)" all lay out correctly and a format an organiser invents this afternoon works too. Names with a conventional length and no number in them, like a bare "Keynote", fall back to that convention, and anything unreadable falls back to thirty minutes. Every block shows the length it is using and says "assumed" when Callboard picked it, because a session sized wrong is otherwise indistinguishable from a session scheduled wrong.

Placing a session is a draft. Nothing reaches the public agenda until Publish, which names how many sessions are about to go live, mentions any unresolved conflicts, and reports what it did. Until then the public sees the session with its time to be confirmed, which is the truth. Unpublish all pulls the whole grid back to draft the same way, so a producer can rearrange a live programme without the audience watching it happen.

Four kinds of conflict are detected on every load and surfaced both as a red outline on the offending block and as a list in the Conflicts tab:

- A room double booked.
- A speaker scheduled in two places at once, including co-speakers on separate sessions.
- Two sessions from the same track running at the same time in different rooms, flagged amber rather than red, because attendees having to choose is a judgement call rather than an error.
- Anything falling outside event days or event hours.

### 6. Real-time onboarding dashboard

`/admin/onboarding`.

The tasks themselves are defined at /admin/tasks: name, description, kind, who they apply to (all accepted speakers, one track, or one role), due date and whether they are required, with reordering. Creating a task generates its assignments immediately, one per person rather than one per submission, so a speaker with two accepted sessions still owes one headshot.

A matrix of accepted speakers against onboarding tasks (headshot, bio, slides, recording release, travel confirmation), one coloured dot per cell, sorted worst first: most overdue items, then least complete, then alphabetically. Four counters across the top: accepted speakers, fully onboarded, speakers with overdue items, and total open items. Accepting a submission is what creates the task assignments, so the dashboard fills itself as decisions go out.

### Beyond the brief: the participant roster

`/admin/people` and `/admin/people/:id`.

Everyone attached to the event in one list: name, email, company, job title, the roles they hold across their submissions, and how much of their task list is done. Search covers name, email and company, and an involvement filter answers the four questions a producer actually asks a roster: who has submitted, who got in, who is reviewing, and who is on the list having done nothing yet. The counts on the filters describe the list you are looking at rather than the whole event, so they stay true while a search is applied.

A person's page is the producer's version of the speaker portal: bio, headshot, job title, company, social links, their submissions with status and schedule, their tasks with the file each one produced, and every object actually sitting under their prefix in R2 rather than only the ones a form recorded a URL for. All of it is editable, including uploading a headshot on somebody's behalf, through the same validation and the same bucket path the portal uses. People can also be created from scratch, for the moderator or evaluator who never comes through a form.

Copy sign-in link is here too. It mints the same single-use token the emailed magic link uses, valid for 72 hours, for the speaker who cannot find the email. It is not a second, weaker way in: same table, same burn on use, and the page says out loud that whoever holds the link is signed in as that person. The link is displayed for copying and never emailed, which is the point: it works when mail does not.

The other half of that is on the email log. When a send that carried a sign-in link fails at the provider, the link is kept on the log row, so a bounce leaves the organiser holding something to pass on rather than the speaker stuck at a sign-in form. The row reads the token back before offering it and says whether it is still live, already used, or expired, and only offers the copy box while it would actually work. Successful sends keep nothing: the link is in the inbox where it belongs. None of this changes what the sign-in screen tells a visitor, which stays identical for a known and an unknown address.

### Beyond the brief: the dashboard

`/admin`.

One screen, one loader, a fixed number of queries: the date and a countdown, four counters, a status row that links into the matching tab of the submissions list, an "also check" section, and the eight most recent submissions.

The nudges are the part worth having. Each one is derived from real rows and each disappears at zero, so an empty section means nothing needs attention rather than being a permanent fixture people learn to skip. Covered: decisions recorded but never emailed, scheduling conflicts, accepted sessions with no slot, submissions awaiting a decision, decisions staged but uncommitted, accepted speakers missing a bio or headshot, overdue speaker tasks, submissions with no reviewer, and forms left open past their deadline. They are ordered by how much damage each does if ignored.

Conflict counting imports the agenda's own detector rather than reimplementing it. A dashboard that says two conflicts while the agenda shows three is worse than no dashboard, because the producer stops believing both numbers.

### Beyond the brief: the public display layer

`/e/:eventSlug`, with the views in `app/components/PublicViews.tsx` and the producer's side at `/admin/embeds`.

Five views of the same programme, each on its own URL: `/e/:eventSlug/agenda`, `/sessions`, `/speakers`, `/schedule`, and `/gallery`. A bare `/e/:eventSlug` opens the agenda. Every view carries a switcher and day and track filters, and every view works inside an iframe with `?embed=1`, which strips the header, the switcher, and the footer so it sits inside a host page without looking bolted on. One route module serves all five, so the path selects the view rather than duplicating the implementation, and an unrecognised view returns 404 rather than silently falling back to the agenda.

The three list views, sessions, speakers and gallery, share one search control. It is a plain GET form, so it works without JavaScript, leaves a URL a visitor can share, and filters on the server: `?q=` narrows on session title and speaker name together, combines with the existing `track` and `day` parameters rather than replacing them, and the count beside the box is the number of things actually on screen. One query serves both kinds of view, because a visitor typing a name wants that person's talks on the sessions list and that person on the speakers list. A session is in scope when its title or anybody on it matches; the speaker list is then narrowed to the people who matched by name plus everybody on a session that matched by title, so searching a name returns that speaker rather than them and all their co-presenters. The search is deliberately absent from the agenda grid and the itinerary: those are shaped by time, and hiding rows inside them leaves holes in a timetable rather than a shorter list. An empty result says what was searched for rather than implying the programme has not been published.

Descriptions are on by default on the sessions list and the itinerary, clamped to three lines with a Show more toggle, because a programme of titles alone does not tell anybody how to spend their afternoon. The toggle is a hidden checkbox and two labels rather than component state, so expanding works with no JavaScript at all, which matters on a page that is cached at the edge and often read inside somebody else's iframe. JavaScript's only job is deciding whether the toggle is worth showing: it asks the browser whether the paragraph is actually clipped, and re-asks on resize, because the same text is three lines on a laptop and seven on a phone. The server-rendered guess errs towards showing the toggle, since a toggle with nothing to reveal is a smaller failure than an abstract clipped with no way to open it.

Every speaker name carries their job title and company beside it, on one line each rather than a comma-separated run that stops being readable the moment two speakers both have titles. The agenda grid does the same where the block has the height for it: a cell is as tall as its session is long, so titles appear from an hour upwards and the description from ninety minutes, clamped and with no toggle. Expanding a cell would push every other column's rows out of line, and a grid that does that has stopped being a grid.

Every entry opens. `/e/:eventSlug/sessions/SESS-4` is one session in full: the day, the start-to-end range in the event's zone with the visitor's own time beside it when it differs, the room, the description, track, format, level, and every speaker with their photo, title, company and bio. `/e/:eventSlug/speakers/:id` is one speaker: photo, bio, title, company, social links, and their sessions with time and room. The ref is in the session URL rather than the id because this is a link people paste into chat, and either form resolves. Both are reachable from wherever the thing appears — an agenda block, a session card, an itinerary row, a speakers list row, a gallery card, the speaker panel on a session, and a session listed under a speaker — and both render under `?embed=1` with no page chrome, the same contract the list views have.

Back returns to the view the visitor came from, with its filters and its search intact, because the link that brought them here carried `from=<view>` alongside them. It stays put for the whole journey: speakers list to a speaker to one of their talks still offers Back to the speakers list rather than swapping it for the sessions list halfway. `from` is only ever one of the five view slugs, checked against them on the way out; a path taken from a query parameter and rendered as an href is somebody else's open redirect. A link pasted cold, with no `from`, falls back to the list that thing belongs to, so there is always a way into the programme.

`/` redirects to the public agenda of the first event, so the deployed domain lands on the programme rather than a framework starter page.

`/admin/embeds` turns a view into a saved configuration with its own public token. A producer picks the format, filters by track or day, toggles which fields show, and copies an iframe snippet. The preview renders the live page in a desktop frame and a 390px mobile frame side by side rather than behind a toggle, because the failure worth catching, an agenda grid that overflows on a phone, is only obvious when the narrow frame is on screen next to the wide one. Because the snippet carries the token rather than the settings, changing the configuration later updates every page that embedded it without anyone editing HTML. Switching an embed off stops it rendering rather than quietly falling back to a default.

The whole surface reads accepted submissions only, and no route in it reads a cookie, which is what makes it safe to cache at the edge: `s-maxage=300` with `stale-while-revalidate=3600`.

### Beyond the brief: optional Airtable sync

`/admin/integrations`, with the client in `app/lib/airtable.ts`.

Producers already live in Airtable, so Callboard can mirror accepted sessions and speakers into a base and read producer edits back. D1 stays the primary datastore throughout: the integration is off by default, nothing in the app depends on it, and removing the key changes nothing about the data.

Push upserts accepted sessions into a table you name, and speakers into a second table if you name one. Each submission stores its Airtable record id, so a second push updates the row instead of creating another one. Pull reads edits back for title, description, format, level, status, and track.

Both directions are manual buttons. Nothing runs on a schedule.

## Product decisions we made

This is the section worth reading. Each of these is a small piece of judgement that the data model or the screen would not have forced on us.

### Publish preflight that blocks a form before it can trap submitters

A form builder will happily let you build a form nobody can complete. Before a form can be published, Callboard runs a preflight and separates blockers from warnings. Blockers stop the publish button outright: a close date already in the past, a dropdown or radio field with no options to choose from, no email field anywhere on the form, a per person submission limit below one, and any participant role with a minimum above one. That last one is the failure this whole check exists for, so the message names it: requiring two speakers blocks anyone submitting alone, and they only find out after writing the proposal. The publish action re-runs the preflight server side, because a blocker that only disables a button is not a blocker. Warnings are advice and do not stop anything: more than twelve required fields, or no close date at all.

Why: the failure mode we cared about is not the organiser being inconvenienced, it is a speaker halfway through a proposal hitting a field they cannot answer and giving up. That damage is invisible to the organiser, because the people it happens to never appear in the admin. Blocking at publish time is the only moment the software can catch it.

### The plain English "what submitters will experience" resolver

Three settings on a form interact in ways that are not obvious from three separate inputs: submissions per person, whether multiple drafts are allowed, and the close date. Under those controls sits a paragraph that reads the current values back in ordinary sentences, for example: "Each person can have 3 submissions on this form, drafts included. They can only have one draft in progress, and must finish or delete it before starting another. The form stops accepting entries on September 15, 2026."

Why: event producers are not the people who wrote the settings. The resolver removes the need to reason about combinations of checkboxes, and it makes a wrong setting look wrong immediately rather than three weeks later in a support email. The same numbers are shown to submitters on the form's welcome step, so both sides are reading the same statement of the rules.

### Magic links instead of passwords

Speakers never set a password. The portal takes an email address, mints a single use token that expires in thirty minutes, and signs the person in when they follow it. The token is burned on use. Requesting a link for an unknown address returns exactly the same response as a known one, so the endpoint cannot be used to find out who submitted.

Why: a speaker touches this system perhaps six times across a year. A password is pure friction and generates support load ("I can't log in") at exactly the moment you need slides. It also removes password storage from the project entirely, which is one fewer thing to get wrong in a tool other people will self host.

The same reasoning drives what the screen says after you ask for a link. A known address, an unknown address, and an address whose email failed to send all produce the identical confirmation, because any difference between them turns the form into a way to test who is registered. Delivery failures go to the email log and the server logs, where the organiser can act on them, rather than to the visitor. The one exception is deliberate: with no mail provider configured, the link is rendered on the page so the flow can be exercised in development, and that state cannot occur once `RESEND_API_KEY` is set.

### The success page hands over to the portal instead of saying goodbye

Finishing a submission sets the portal cookie as well as the submit one, and the thank you page counts down from ten and then goes to `/portal`. The countdown is visible, the "Go now" link skips it, and the whole thing is a per-form toggle that turns into a plain Continue button when it is off.

Why: the minute after someone submits is the only minute when they are still in the frame of mind to add a headshot, and every design that ends at "thanks, we'll be in touch" spends it. Sending them onward is worth doing, but only in a way the reader can see coming: an unannounced redirect reads as a bug to the person it happens to, and one they cannot skip is worse. The countdown and the link are the price of moving someone's browser for them. The toggle exists because some producers deliberately end the flow on their own thank you copy, and a redirect nobody asked for would talk over it.

The signed-in part is the point, not a convenience. Landing on a sign-in form immediately after proving who you are by filling in an entire proposal is where people give up, and the portal is where the tasks live.

### The close date is the edit deadline, and the software says so out loud

A speaker can edit their proposal from the portal for exactly as long as the form is open, and the moment it shuts the submission goes read only with a line naming the day it closed. The check lives in one function that the public form and the portal both call, so the two cannot disagree about whether a form is taking entries. It is re-run inside the save action as well, because a close date that only hides a button is not a close date: the browser still has the old page open, and the tab someone left open on Friday must not be able to rewrite a proposal on Monday.

Why: the alternative organisers actually use is a mailbox full of "can you change my title to". Letting speakers fix their own typos removes that work, but only if the cutoff is real and legible. A speaker who is told editing has closed, and on what date, sends one email to the right person; a speaker who finds a form that silently refuses to save assumes the software is broken and sends three.

### Pronouns and gender are free text, with suggestions

Both fields are optional, both save whatever is typed, and both offer the common answers as a datalist rather than a dropdown. Neither has a complete list, and a fixed one is a promise that it is complete. The gender field says on screen that it is not shown on the public programme, which is a statement about the code rather than a policy: the public views select their columns explicitly and this is not one of them.

Why: the failure mode of a picker here is that someone has to choose the nearest wrong answer about themselves before they can carry on filling in a form, which is a bad experience delivered by software that thought it was being helpful. A text box with suggestions costs the same and cannot do that. And putting the "not published" claim next to the field, rather than in a privacy page nobody opens, is what makes it possible for someone to decide whether to answer.

### Conflict of interest blocking in evaluator auto-assignment

Auto-assign hands submissions to reviewers round robin, but it checks the `evaluator_conflicts` table before each assignment and skips any pairing that is recorded there. It keeps cycling through the evaluator list until it has filled the reviewer count or run out of eligible people, rather than dropping the submission. The demo data includes a real case: Elena Novak and Sarah Chen both work at Vectorworks, so Elena cannot be assigned Sarah's session.

Why: an accidental assignment is not something you can undo after the fact. Once a reviewer has read a proposal from their own company and scored it, the score is tainted whether or not anyone notices, and committee trust is the thing that makes a review process worth running at all. Filtering at assignment time is cheap; a review board arguing about a compromised score is not.

### The nudge button with a 24-hour cooldown and a full email log

Every speaker row with outstanding work has one Remind button, and there is a "Remind all" for everyone with open items. Pressing it sends: the reminder is rendered from the `task_reminder` template against that person's own outstanding list, item by item with due dates in the event's timezone, sent through the mail provider, and written to the email log with the body that went out. The screen reports what actually happened, counting sent, queued when no provider is configured, and failed with the provider's first error, rather than claiming a reminder went out because a row was written. `last_nudged_at` is stamped only when the send succeeded, so "reminded yesterday" is never a lie and a bounce leaves the producer free to try again. The row then shows when the last nudge went out, in words ("today", "yesterday", "4d ago"), and anything inside the 24-hour window is highlighted amber with a tooltip saying to give them a moment. Someone with nothing outstanding is skipped and counted as skipped: a reminder listing nothing teaches people to ignore the next one.

Why: chasing is the actual job in the last fortnight before an event, and the failure is not forgetting to chase, it is chasing the same person three times in a morning because two producers are both looking at the same spreadsheet. Making the last contact visible on the row is what prevents that. Note that the cooldown currently warns rather than hard blocks, on the reasoning that a producer sometimes genuinely does need to send twice in a day, and the email log keeps them honest about it.

### The "Not sent" flag for decided but unnotified submissions

A submission can be marked accepted or declined and have no email on record. The submissions table shows this as a red "Not sent" in the Notified column, and the Decisions page has a dedicated "Decided but never told" section with a Send now button per row.

Why: this is the single worst failure this kind of software has. A speaker who was accepted three weeks ago and never told has already booked something else, and there is no recovering the slot. Because the state is derived (`decided_at` is set and `notified_at` is null) rather than a flag anyone has to maintain, it catches every cause: a send that failed, a batch that was interrupted, a status changed by hand in the database. It is loud on purpose.

### Human readable refs like SESS-4

Every submission gets a short sequential reference, `SESS-4` for sessions and `ABS-12` for abstracts, unique per event, allocated at draft creation. It appears on the submission list, the scheduling blocks, the evaluation screens, the speaker portal, the email templates, and the calendar invite filename.

Why: UUIDs are correct and unusable. The people running an event talk to each other on the phone and in Slack, and "can you look at SESS-4" is a sentence a person can say. It also gives the speaker a reference they can quote back in an email, which is what makes the support thread resolvable.

### ICS invites with a stable UID and an incrementing SEQUENCE

The organiser's real workflow is that acceptances go out before the schedule is finalised, so the first invite often has a time but no room, and the room is filled in later. Calendar invites are built so that a later send updates the entry the speaker already has instead of adding a second one. Two things make that work: the UID is derived from the submission id and the event slug, so it is identical forever for that session and that speaker, and the SEQUENCE is computed from the highest sequence already recorded in the email log for that submission and incremented on every send. The sequence number is shown in the mail log so it is auditable.

Why: the alternative is a speaker with two entries in their calendar, one of which is wrong, and no way for them to tell which. Getting UID and SEQUENCE right is the difference between a calendar invite that behaves like the ones people get from their own colleagues and one that behaves like spam. It costs nothing at build time and it is close to impossible to retrofit once the wrong invites have gone out.

### Times belong to the event, not to the reader

Every displayed time is derived from the event's stored IANA zone through `Intl`, set on `/admin/settings`. There is no offset constant anywhere: the previous `EVENT_UTC_OFFSET = -7` was correct for one event in one October and silently wrong either side of a daylight saving change, and it had been copied into seven files.

The event's own time is always the primary reading, labelled with the zone, because that is what the room and the printed programme say. The viewer's equivalent is secondary and appears only when it differs: `9:00 AM PDT (5:00 PM your time)`. The viewer's zone is detected in the browser and written to a cookie, so the server renders the secondary reading itself rather than popping it in after hydration.

Instants are stored as UTC and only ever interpreted through a zone at the edges. Changing the event timezone therefore re-reads the same moments rather than moving anything: the agenda, the portal, the API and the emails all shift together, and the calendar invites, which carry UTC instants, do not change at all.

That includes the inputs. A `datetime-local` field carries a wall clock reading with no zone attached, so whoever reads it decides which clock, and left to the browser's own getters it means the producer's clock: a deadline typed in Berlin for a conference in California lands nine hours out, and on Cloudflare the server-side read is UTC, which is nobody's deadline at all. The event settings dates and the form builder's close date now go through one pair of functions in `app/lib/tz.ts`, against the event's zone, and each field is labelled with the zone it means.

### Dark mode is a palette, not a pile of variants

The previous attempt at dark mode was ad hoc `dark:` variants, and it shipped white label text on white cards wherever a variant had been forgotten. The rewrite makes that failure structurally impossible rather than fixing the instances. Both palettes are declared in full in `app/app.css` and exposed as ordinary Tailwind colour utilities, so `bg-surface` and `text-dim` are theme aware by construction. There is no `dark:` variant anywhere in the route files and no raw Tailwind colour either, which is a property you can check with one grep rather than by looking at screens. Form controls get a themed background from a base rule, so a control that forgets to declare one is still readable.

Switching is done entirely on the client: the click handler sets data-theme on the document element and writes the cookie with document.cookie, so the palette flips on the next frame with no request and no loader revalidation. Revalidating every loader on the page to repaint a palette is what made the first version take about a quarter of a second. The surrounding form still posts to /theme when JavaScript is unavailable, but that path is never taken otherwise.

The preference is a cookie read in the root loader, so the correct palette is in the first byte of HTML. With no cookie there is no `data-theme` attribute at all and the `prefers-color-scheme` media query decides, which is how the server renders the system preference correctly without knowing it. localStorage cannot do this: it is only readable after JavaScript runs, which is one paint too late.

Author-supplied colours, the track and tag hues that come from the database as light-mode hex, are passed in as a custom property and mixed by the theme. On a dark canvas the chip mixes toward the surface and the label toward white, so a mid indigo track tag stays readable instead of disappearing.

Why the fuss: the reason half-applied dark modes persist is that verifying them means opening every screen and squinting. Making every colour come from one file turns that into a static check, and the contrast of every pair the app actually renders is then arithmetic rather than opinion.

### Routing writes down its reasons, in the submitter's language

Routing is the feature most likely to make a producer distrust the tool, because a submission silently appears in a track nobody chose and there is nothing to inspect. So every rule that fires records what it matched and what it did, denormalised into a sentence at the moment it ran: `Because Format is "Workshop (90 min)": sent to Workshop Review with 2 reviewers assigned`. The trail is stored as text rather than as foreign keys, so editing or deleting a rule next month does not rewrite the history of why something landed where it did.

Rules re-evaluate on every save of the proposal step, not just the first, because a submitter who switches from workshop to talk should not stay in the workshop queue. That has a consequence worth stating: re-routing removes review assignments for plans the submission is no longer routed to. It only ever removes assignments that routing itself created, which the previous trail identifies, so a producer's manual auto-assign is never undone, and it never removes an assignment that already has a score against it.

Why: the two failure modes are opposite and both bad. Routing that never re-evaluates leaves submissions in queues that no longer make sense. Routing that re-evaluates carelessly deletes a reviewer's work. Reading the old trail is what lets it tell the difference between its own earlier decision and a human's.

### Uploads are validated by their bytes, not by what the browser claims

Uploaded files are served back from the app's own origin, which makes the upload path a security boundary rather than a convenience. Three rules follow. The Content-Type the browser sends is treated as a hint and never trusted: every file is checked against its magic bytes, and the extension has to agree with what the bytes say, so a text file renamed `headshot.png` is rejected with "that file is named .png but its contents are not a valid PNG file". The allowlist is limited to formats that cannot execute, which is why SVG is not accepted even though it is an image. And on the way back out, only real images are served inline, with everything else forced to download, plus `nosniff` and a restrictive CSP on every response.

Filenames are sanitised down to a conservative character set, so `../../../../etc/passwd.png` is stored as `passwd.png` inside the participant's own prefix.

Why: the naive version of this feature is four lines that write `file` to a bucket and hand back a URL, and it gives anyone who can reach the form a way to host arbitrary content on your domain. The failure is not that a speaker uploads something odd, it is that the file is then served from the same origin as the admin session. Sniffing the bytes and refusing to render anything inline costs almost nothing and closes that off. The size limits matter for a duller reason: a producer needs to know why an upload failed, and "that file is 6.0MB, the limit for images is 5.0MB" is a sentence they can act on without asking anyone.

### Airtable sync keeps D1 authoritative, and says so when it overrules you

The sync is two manual buttons, not a background job, and the conflict rule is decided per field rather than per record. On pull, a field is taken from Airtable only if the local row has not changed since the last push. If both sides changed, Callboard keeps its own value and lists what it ignored in the banner: "SESS-2 title: kept Sandboxing Agents, ignored Sandboxing Agents (Airtable edit)". Rows created directly in Airtable are counted and reported but never imported, because a submission needs a speaker, a form, and a ref, and inventing those from a spreadsheet row produces a record that breaks everything downstream. Scheduling, decisions, and evaluation are push only.

Why: a two-way sync that silently picks a winner is worse than no sync, because you cannot tell whether the thing you are looking at is what you typed. Two rules make it trustworthy. The primary store wins ties, so there is always an answer to "which one is real". And every overruled edit is named on screen, so the producer who made it finds out immediately rather than discovering next week that their change evaporated. Keeping decisions and scheduling out of the pull path is the same instinct: an edit in a spreadsheet should not be able to send an acceptance email or move a session.

## Stack and architecture

- React Router v8 in framework mode, server side rendered, running as a Cloudflare Worker (`workers/app.ts` hands the Worker `env` and `ctx` to the router via a `RouterContextProvider`).
- Cloudflare D1 as the database, accessed through Drizzle ORM. 24 tables, defined in `app/db/schema.ts`, with the migrations in `drizzle/`.
- A public display layer at `/e/:eventSlug` with five views, embeddable in an iframe, cached at the edge and never reading a cookie.
- Cloudflare R2 for speaker uploads, bound as `BUCKET`. Files go in under `events/{eventId}/{participantId}/{filename}` and come back out through the `/files/*` route.
- Resend for outbound email. The ICS builder is hand written against RFC 5545 rather than pulled from a library, which is a few dozen lines and avoids a dependency that would have to run inside the Workers runtime.
- Tailwind CSS v4, no component library. Both colour palettes are defined once in `app/app.css` as CSS variables and exposed as Tailwind colour utilities, so there is not a single `dark:` variant or raw Tailwind colour anywhere in the route files.
- Every mutation is a plain HTML form posting to a route action, with an `intent` field selecting the operation. The agenda grid uses a fetcher so that dragging does not navigate. There is no client side data store and no API layer.

Two structural choices are worth calling out. Submissions use hybrid storage: the six things the application reasons about (title, description, status, track, format, level) are real indexed columns, and everything else a custom form collects goes into a JSON `answers` column. That keeps filtering and sorting fast and indexable without limiting what a form can ask for. And loaders fan out into a fixed number of queries regardless of row count, fetching related speakers in one follow up query keyed by id rather than per row, so no page has an N+1.

### Performance

Measured locally against the built Worker (`wrangler dev --local`) with the demo seed loaded, warm, ten requests per page. Each page renders its own server timing in the corner of the header, which is where these come from.

| Page | Server render | Queries |
| --- | --- | --- |
| `/portal` (signed out) | 6 to 18 ms | 1 |
| `/admin/agenda` | 17 to 28 ms | 4 |
| `/admin/onboarding` | 16 to 36 ms | 3 |
| `/admin/forms` | 13 to 32 ms | 2 |
| `/admin/submissions` | 18 to 32 ms | 4 |
| `/admin/decisions` | 14 to 31 ms | 3 |
| `/submit/cfp-2026` | 20 to 31 ms | 4 |
| `/admin/evaluation?tab=results` | 23 to 43 ms | 6 |

The query count is the page's own loader. Admin pages run one extra query in the shared layout, and the signed in portal runs five rather than one, or nine on the Submissions tab, which additionally fetches the form behind each submission, the field labels that make its answers readable, everyone else attached to it, and the tracks the edit form offers. Those four only run on that tab. None of these counts grow with the number of rows.

End to end HTTP time on the same machine, including SSR and transfer: 24 to 49 ms for the submissions list, 49 to 70 ms for the agenda, 72 to 84 ms for the evaluation results. These are local numbers on a laptop against local D1, not production edge numbers, but they are honest and they are the same code path that runs deployed.

Bundle sizes from `npm run build`: the Worker is 1040 KiB uncompressed across three modules, of which `index.js` is 50.6 kB (12.3 kB gzipped). Client assets total 476 kB uncompressed, split per route, with the largest route chunk at 12.9 kB (3.5 kB gzipped) and the shared client entry at 185.8 kB (58.6 kB gzipped).

## Local setup

Requires Node 22 and npm.

```bash
git clone <your-fork-url> callboard
cd callboard
npm install

# Create the local D1 tables
npx wrangler d1 migrations apply callboard --local

# Load the demo event: one conference, 14 submissions across every status,
# 12 people, tasks in mixed states, scored evaluations, two planted schedule
# conflicts, and email templates
npx wrangler d1 execute callboard --local --file=./scripts/seed.sql

# Shift the seeded dates into the past relative to today, so submissions
# read as "3d ago" rather than sitting in the future
npx wrangler d1 execute callboard --local --file=./scripts/fix-dates.sql

npm run dev
```

The app comes up on `http://localhost:5173`. Start at `/admin/submissions` for the organiser side and `/submit/cfp-2026` for the public form. The seed is re-runnable: it deletes the demo event first and leaves anything else in the database alone.

The two scripts in `scripts/` are deliberately outside `drizzle/`. Wrangler treats every `.sql` file in the migrations directory as a migration, so while they lived there, a routine `d1 migrations apply` would run the seed and wipe the event. Keep new helper scripts in `scripts/` and `drizzle/` for migrations only.

To send real email locally, create a `.dev.vars` file:

```
RESEND_API_KEY=re_your_key
MAIL_FROM=Callboard <you@yourdomain.com>
```

Without it everything still works, and sends are recorded in the log as queued rather than delivered.

To run the production build locally instead of the dev server:

```bash
npm run build
npx wrangler dev --local
```

## Deploy

Deployment is a GitHub Actions workflow (`.github/workflows/deploy.yml`) that runs on every push to `main` and can also be triggered manually. It installs, builds, and runs `wrangler deploy`.

The workflow does not apply D1 migrations yet. After adding one you must run `npx wrangler d1 migrations apply callboard --remote` yourself before the deploy reaches production. Deploying code that expects a column the database does not have takes the public submission form down, which has already happened once: three migrations sat unapplied while every deploy reported success.

A ready-to-use migration step is commented into `.github/workflows/deploy.yml`. It needs `CLOUDFLARE_API_TOKEN` to carry D1 edit permission as well as Workers; with only Workers it fails with "the given account is not authorized" (code 7403). Widen the token and uncomment the step, and code and schema can only ship together.

Set two repository secrets:

- `CLOUDFLARE_API_TOKEN`, with Workers Scripts edit and D1 edit permissions
- `CLOUDFLARE_ACCOUNT_ID`

Before the first deploy, create the remote database and point `wrangler.jsonc` at it:

```bash
npx wrangler d1 create callboard          # copy the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply callboard --remote
npx wrangler r2 bucket create callboard-uploads
npx wrangler r2 bucket create callboard-uploads-preview
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
```

`migrations apply --remote` runs schema migrations only. The demo seed lives in `scripts/` and is never applied automatically, so a deploy cannot overwrite a real event with demo data.

`npm run deploy` does the same thing from a workstation.

## Known limitations

Stated plainly, because a judge will find them anyway.

- **There is no authentication on `/admin`.** Anyone who can reach the URL can accept submissions and send email. The magic link and session tables exist and the speaker portal uses them; the admin side does not. This is the first thing to fix before anyone runs a real call for speakers on this.
- **The public form does not verify the email address it is given, and finishing a submission now signs you into that address's portal.** Type a real speaker's address at the account step, complete a proposal, and the success page hands you their portal: their other submissions, their tasks, their profile. The unverified email was always a weakness, since it let a stranger resume that person's draft, but the portal handoff widens what it reaches. The fix is to make the account step mint a magic link rather than trust the address, which is the same mechanism the portal already uses for sign-in.

- **Uploaded files are reachable by anyone holding the URL.** Objects are served from `/files/...` with no authentication check, so a slide deck is protected only by its path being hard to guess. Headshots are meant to be public; slides are not. This needs signed URLs or a session check on the serving route.
- **Batch email sending is sequential.** Committing a queue of decisions loops over submissions, then over speakers within each, awaiting each Resend call in turn. It is fine for the tens of emails a single event needs, and it will hit the Workers CPU limit on a batch of hundreds. It should be a queue.
- **The Airtable key is stored in plain text in D1.** Combined with `/admin` having no authentication, anyone who can reach the admin URL can use the key. The page masks it on screen and never sends the saved value back to the browser, but that is UI hygiene, not protection. It belongs in Workers secrets or an encrypted column.
- **Airtable sync is bounded by what one request can do.** It is sequential with a gap between calls to respect Airtable's five-per-second limit, and it caps at 2000 records a run. A few hundred sessions will be slow, and a very large base will hit the Workers CPU limit. It should be a queue.

Also unfinished, in case it saves you clicking:

- Rule driven notifications are not sent. A routing rule can list addresses to notify, and the trail records that it wanted to, but no email goes out.
- Conflicts of interest are stored and respected by the auto-assigner, but nothing detects them at submission time. The same company matches in the demo data were recorded by the seed.
- A Resend account in test mode can only send to its own owner. Confirmation and sign-in emails to real speakers will fail with a 403 until a sending domain is verified; the failure is recorded in the email log. Nobody is locked out by it: a failed send keeps the sign-in link it was carrying on its log row, so the organiser can copy it from `/admin/emails` and pass it on, and `/admin/people` can mint a fresh one for anybody at any time.
- Nothing rate limits the magic link form. A visitor can request links as fast as they can click, which is both a mail bill and a way to flood one inbox. It needs a per address cooldown.
- `/` is still the React Router starter page, and `/admin` has no dashboard behind it. Four sidebar entries (Abstracts, Sessions, People, Tasks, Emails, Settings) are navigation targets with no route behind them yet.

## Licence

MIT. See `LICENSE`.
