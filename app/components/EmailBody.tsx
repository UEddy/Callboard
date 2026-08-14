/* ------------------------------------------------------------------ *
 * An email body, rendered the way a mail client would.
 *
 * The body is HTML somebody else wrote, merged with values a submitter
 * controls, and the admin app is the one origin where a script tag
 * would do real damage. A sandboxed frame with no allowances runs no
 * script and has no access to this page, which is also the more honest
 * preview: it is roughly the environment the email lands in.
 * ------------------------------------------------------------------ */

const SHELL =
  '<!doctype html><meta charset="utf-8"><style>' +
  "body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;background:#fff;margin:16px}" +
  "a{color:#4f46e5}img{max-width:100%}" +
  "</style>";

export function BodyFrame({
  html,
  title,
  className,
}: {
  html: string;
  title: string;
  className?: string;
}) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={SHELL + html}
      className={
        className ?? "h-72 w-full rounded-md border border-line bg-white"
      }
    />
  );
}
