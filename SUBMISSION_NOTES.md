# Submission notes

## How to get into the organiser area

**`/admin` requires an organiser sign-in. No inbox is needed, because the sign-in page prints the link on screen.**

1. Open **`/admin`**. Any unauthenticated request redirects to `/admin/sign-in`.
2. The page lists the seeded organiser accounts as buttons: **`chrissy@ai.engineer`**, `kelsey@ai.engineer`, `swyx@ai.engineer`. Click one, or type the address into the field.
3. The sign-in link appears on the page. Click **Open the organiser area**.

Three clicks from a cold browser to a working session. The link is emailed as well, so either route works.

The speaker portal at `/portal` is unchanged and still signs in by emailed magic link; `/admin/people` has a **Copy sign-in link** action for handing a speaker their link directly.

## Access method chosen, and why

**The on-screen link, not a shared passphrase.**

A passphrase has to be set as a secret on every deployment, and a deployment where nobody set it is a deployment nobody can administer, and the failure mode is being locked out of the entire application. The on-screen link needs no configuration at all, is bounded to accounts that already have `is_admin` set, and reuses the same one-shot, thirty-minute, burn-on-use token machinery as the speaker portal, so it is not a second and weaker way in.

It is on by default. To close it on a real deployment, set `ADMIN_LINK_ON_SCREEN` to `off` in `wrangler.jsonc`; the link is then emailed and nothing else, and the organiser addresses stop being listed on the page. Nothing else about the flow changes.

## What the gate actually covers

- The check runs in the worker's `fetch` handler, before the router. A child route's action runs without its parent's loader ever being called, so a loader-only check would leave every `POST` under `/admin` open while looking protected. Pages, data requests, form posts, CSV downloads and any route added later are all covered.
- `is_admin` is re-read on every request, not trusted from sign-in time, so clearing the flag locks somebody out on their next click.
- `cb_admin` is a separate cookie from `cb_portal`, with a different signing secret and a twelve-hour life. A speaker signing into the portal never gains admin; an organiser can hold both sessions independently.
- The two magic links are separated by a `purpose` column on `auth_tokens`. A portal link pasted into the organiser sign-in is refused, and refused without burning it, so the speaker's link still works afterwards.
- `?next=` is validated to an `/admin` path on the same origin, so the sign-in page cannot be turned into an open redirector.
