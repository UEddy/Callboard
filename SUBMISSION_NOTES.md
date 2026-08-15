# Submission notes

START HERE: https://callboard.eddyudotong.workers.dev

The root page is the sign-in. Enter any email address and a magic link is sent.
Any address works, no allowlist, and an account is created on first sign-in.
That is a deliberate demo affordance so you can use your own address without
configuration, and it is noted in the README as something that would not ship in
a real deployment.

If you would rather not check an inbox, the sign-in page also shows the
generated link on screen, and lists three seeded organizer accounts as one-click
buttons. Three clicks from a cold browser to the organizer area.

Sending runs on Resend from a verified domain: mail addressed to any recipient
is accepted, not just the account owner. Every send is logged at /admin/emails
with the provider response, and there is a "send test email" control there if
you want to confirm delivery yourself. Note that a logged status of "sent" means
the provider accepted the message, which is not the same as it landing in a
particular inbox.

SPEAKER PORTAL: /portal
Sign in with a seeded speaker address such as sarah.chen@vectorworks.dev.
Separate session from the organizer one. Organizers can also copy a speaker's
sign-in link from that person's page in the admin, which is how a producer gets
a speaker in without waiting on email.

PUBLIC, NO LOGIN
/e/ai-engineer-worlds-fair-2026   five public views, embeddable
/submit/cfp-2026                  the call for papers form
/api/v1                           JSON API, reads are public
/portal                           speaker portal, its own sign-in

A FIVE MINUTE PATH
1. /admin/forms, open "Call for Speakers 2026". Set the close date to a past
   date and save. A "Before you publish" panel appears reading "The close date
   is in the past, so nobody can submit", the fix is spelled out beside it, and
   the Publish button is disabled with "1 thing to fix first". This is the
   preflight, built after watching a two speaker minimum trap its own author in
   the brief video. Set the date back to clear it.
2. On the same page, the submission limit and drafts settings each resolve into
   a plain "What submitters will experience" panel: "Each person can have 3
   submissions on this form, drafts included. They can only have one draft in
   progress, and must finish or delete it before starting another."
3. /submit/cfp-2026 in a private window. Choose Format = Workshop and two
   workshop-only fields appear with no reload, Workshop Prerequisites and Max
   Attendees. Submit.
4. /admin/submissions, open the new row. The "What happened to this" panel names
   the rule and its reason: "Because Format is Workshop (90 min), sent to
   Workshop Review with 2 reviewers assigned", along with the rule id and date.
   It also says plainly that the rule lists an address for notification but that
   rule driven email is not wired up, so nothing was sent.
5. /admin/decisions, commit the accept queue. The email log fills with one row
   per recipient and the provider's response. Acceptance mail for a session that
   already has a time on the agenda carries a real RFC 5545 invite with a stable
   UID and a sequence number, so assigning a room later updates the speaker's
   existing calendar entry instead of creating a second one. The three
   submissions sitting in the accept queue are not scheduled yet, so their
   acceptance mail carries no invite; to see one, resend a decision for a
   session that is already on the grid, such as SESS-1.
6. /admin/agenda, Conflicts tab. Three conflicts are seeded on purpose: a
   speaker in two places at once, a room double booked, and two sessions from
   the same track running opposite each other. Drag a session between rooms and
   they recompute live.
7. /admin/onboarding. Every accepted speaker by outstanding task, worst first,
   with a "Remind all" control and a per speaker nudge.

Known limitations are stated in the README and here rather than left to be
found: organizer sign-in is open to any address and prints the link on screen,
no multi event support, no file versioning, no Speaker CRM, and no general audit
log beyond the per submission edit trail.
