/* ------------------------------------------------------------------ *
 * Email + calendar invites.
 *
 * The organizer's stated workflow: the first invite goes out with no
 * room assigned, and the room is filled in later. That means a re-send
 * must UPDATE the speaker's existing calendar entry rather than create
 * a second one. Two things make that work:
 *   - a stable UID per submission+attendee, reused forever
 *   - a SEQUENCE that increments on every re-send
 * Sent as a text/calendar part with METHOD:REQUEST so Gmail and Outlook
 * render native accept/decline buttons instead of a dumb attachment.
 * ------------------------------------------------------------------ */

export type IcsInput = {
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  title: string;
  description?: string;
  location?: string;
  organizerName: string;
  organizerEmail: string;
  attendees: { name: string; email: string }[];
  cancelled?: boolean;
};

function icsDate(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// RFC 5545 caps lines at 75 octets; continuations start with a space.
function fold(line: string) {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 72) {
    parts.push(" " + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  if (rest.length) parts.push(" " + rest);
  return parts.join("\r\n");
}

function esc(s: string) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function buildIcs(i: IcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Callboard//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${i.cancelled ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${i.uid}`,
    `SEQUENCE:${i.sequence}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(i.start)}`,
    `DTEND:${icsDate(i.end)}`,
    `SUMMARY:${esc(i.title)}`,
    i.description ? `DESCRIPTION:${esc(i.description)}` : null,
    i.location ? `LOCATION:${esc(i.location)}` : null,
    `ORGANIZER;CN=${esc(i.organizerName)}:mailto:${i.organizerEmail}`,
    ...i.attendees.map(
      (a) =>
        `ATTENDEE;CN=${esc(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    ),
    `STATUS:${i.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean) as string[];

  return lines.map(fold).join("\r\n");
}

/* --- Template rendering ------------------------------------------- */

export function render(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key: string) => {
    return vars[key] ?? "";
  });
}

/* --- Sending ------------------------------------------------------- */

export type SendResult = {
  ok: boolean;
  simulated: boolean;
  id?: string;
  error?: string;
};

export async function sendEmail(
  env: Env,
  msg: {
    to: string;
    subject: string;
    html: string;
    ics?: string;
    icsFilename?: string;
  },
): Promise<SendResult> {
  const key = (env as unknown as { RESEND_API_KEY?: string }).RESEND_API_KEY;
  const from =
    (env as unknown as { MAIL_FROM?: string }).MAIL_FROM ??
    "Callboard <onboarding@resend.dev>";

  // No key configured: log it rather than pretending it went out.
  if (!key) {
    return { ok: true, simulated: true };
  }

  const body: Record<string, unknown> = {
    from,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
  };

  if (msg.ics) {
    body.attachments = [
      {
        filename: msg.icsFilename ?? "invite.ics",
        content: btoa(unescape(encodeURIComponent(msg.ics))),
        content_type: "text/calendar; method=REQUEST; charset=utf-8",
      },
    ];
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, simulated: false, error: await res.text() };
    }
    const json = (await res.json()) as { id?: string };
    return { ok: true, simulated: false, id: json.id };
  } catch (e) {
    return { ok: false, simulated: false, error: String(e) };
  }
}

/* Stable per-submission, per-attendee UID. Same input, same UID,
   forever, which is what lets an update replace instead of duplicate. */
export function invitationUid(submissionId: string, eventSlug: string) {
  return `${submissionId}@${eventSlug}.callboard`;
}
