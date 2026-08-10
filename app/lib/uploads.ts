/* ------------------------------------------------------------------ *
 * File uploads to R2.
 *
 * These files are served back out of the same origin as the app, so the
 * validation here is a security boundary, not a convenience. Two rules
 * follow from that:
 *
 *   - The browser's Content-Type is a hint, never evidence. Every file
 *     is sniffed against its magic bytes and the extension has to agree.
 *   - The allowlist is types that cannot execute. No SVG (it can carry
 *     script), no HTML, no archives beyond the Office formats we can
 *     identify. Documents are served as attachments so nothing renders
 *     inline in the app's own origin.
 * ------------------------------------------------------------------ */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25MB

export type UploadKind = "image" | "document";

type Spec = {
  ext: string[];
  mime: string;
  /* Returns true when the leading bytes match this format. */
  sniff: (b: Uint8Array) => boolean;
  inline: boolean;
};

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  sig.every((v, i) => b[offset + i] === v);

const SPECS: Record<UploadKind, Spec[]> = {
  image: [
    {
      ext: ["jpg", "jpeg"],
      mime: "image/jpeg",
      sniff: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
      inline: true,
    },
    {
      ext: ["png"],
      mime: "image/png",
      sniff: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      inline: true,
    },
    {
      ext: ["webp"],
      mime: "image/webp",
      // "RIFF" .... "WEBP"
      sniff: (b) =>
        startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
      inline: true,
    },
  ],
  document: [
    {
      ext: ["pdf"],
      mime: "application/pdf",
      sniff: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
      inline: false,
    },
    {
      ext: ["pptx"],
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sniff: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]), // zip
      inline: false,
    },
    {
      ext: ["key"],
      mime: "application/vnd.apple.keynote",
      sniff: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]), // zip
      inline: false,
    },
    {
      ext: ["ppt"],
      mime: "application/vnd.ms-powerpoint",
      sniff: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // OLE2
      inline: false,
    },
  ],
};

export function maxBytesFor(kind: UploadKind) {
  return kind === "image" ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
}

export function acceptAttribute(kind: UploadKind) {
  return SPECS[kind].flatMap((s) => s.ext.map((e) => `.${e}`)).join(",");
}

export function humanTypes(kind: UploadKind) {
  return kind === "image" ? "JPEG, PNG, or WebP" : "PDF, PowerPoint, or Keynote";
}

export function humanSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/* Strip anything that could climb out of the prefix or confuse a header.
   Keeps a readable name so the producer can tell files apart. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 100);
  return cleaned || "file";
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

export function buildKey(
  eventId: string,
  participantId: string,
  filename: string,
) {
  return `events/${eventId}/${participantId}/${safeFilename(filename)}`;
}

export type ValidationOk = {
  ok: true;
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
  inline: boolean;
};
export type ValidationErr = { ok: false; message: string };

export async function validateUpload(
  file: File,
  kind: UploadKind,
): Promise<ValidationOk | ValidationErr> {
  const limit = maxBytesFor(kind);

  if (file.size === 0) {
    return { ok: false, message: "That file is empty." };
  }
  if (file.size > limit) {
    return {
      ok: false,
      message: `That file is ${humanSize(file.size)}. The limit for ${
        kind === "image" ? "images" : "documents"
      } is ${humanSize(limit)}.`,
    };
  }

  const filename = safeFilename(file.name);
  const ext = extensionOf(filename);
  const candidates = SPECS[kind].filter((s) => s.ext.includes(ext));

  if (candidates.length === 0) {
    return {
      ok: false,
      message: `Callboard cannot accept a "${ext || "unknown"}" file here. Use ${humanTypes(kind)}.`,
    };
  }

  const bytes = await file.arrayBuffer();
  const head = new Uint8Array(bytes.slice(0, 16));
  const match = candidates.find((s) => s.sniff(head));

  if (!match) {
    return {
      ok: false,
      message: `That file is named .${ext} but its contents are not a valid ${ext.toUpperCase()} file. Re-export it and try again.`,
    };
  }

  return {
    ok: true,
    bytes,
    contentType: match.mime,
    filename,
    inline: match.inline,
  };
}

/* The public path the app stores in the database and renders in links.
   Encoded per segment so a space or a plus in a filename survives. */
export function publicPathFor(key: string) {
  return `/files/${key.split("/").map(encodeURIComponent).join("/")}`;
}
