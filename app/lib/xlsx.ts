/* ------------------------------------------------------------------ *
 * A minimal XLSX writer, no dependencies.
 *
 * Why not a library: SheetJS unpacks to 7.5MB, exceljs to 21.8MB, and
 * even write-excel-file to 1.8MB, against a server bundle that is
 * currently about 780KB in total. None of that is justified to emit a
 * single sheet of strings.
 *
 * An .xlsx is a ZIP containing five small XML files, so that is what
 * this builds. Entries are deflated with the runtime's own
 * CompressionStream where available and stored uncompressed otherwise,
 * which Excel reads either way.
 * ------------------------------------------------------------------ */

export type Cell = string | number | null | undefined;

const enc = new TextEncoder();

/* --- CRC32, needed by the ZIP container ---------------------------- */

let CRC_TABLE: Uint32Array | null = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(bytes: Uint8Array) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* --- XML ------------------------------------------------------------ */

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Excel rejects most control characters outright.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export function columnName(index: number) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/* Inline strings rather than a shared string table: one less part to
   write, and these sheets are not big enough for the deduplication to
   matter. */
function sheetXml(rows: Cell[][]) {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === undefined || value === "") return "";
          const ref = `${columnName(c)}${r + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(
            String(value),
          )}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");

  const widths = (rows[0] ?? [])
    .map((_, c) => `<col min="${c + 1}" max="${c + 1}" width="24" customWidth="1"/>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

function workbookXml(sheetName: string) {
  /* Excel refuses these characters in a sheet name and caps it at 31. */
  const safe = sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(safe)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/* --- ZIP ------------------------------------------------------------- */

type Entry = {
  name: string;
  raw: Uint8Array;
  body: Uint8Array;
  method: number;
  crc: number;
};

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function u16(v: number) {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

export async function buildXlsx(
  rows: Cell[][],
  sheetName = "Export",
): Promise<Uint8Array> {
  const files: { name: string; text: string }[] = [
    { name: "[Content_Types].xml", text: CONTENT_TYPES },
    { name: "_rels/.rels", text: ROOT_RELS },
    { name: "xl/workbook.xml", text: workbookXml(sheetName) },
    { name: "xl/_rels/workbook.xml.rels", text: WORKBOOK_RELS },
    { name: "xl/worksheets/sheet1.xml", text: sheetXml(rows) },
  ];

  const entries: Entry[] = [];
  for (const f of files) {
    const raw = enc.encode(f.text);
    const deflated = await deflateRaw(raw);
    const useDeflate = deflated !== null && deflated.length < raw.length;
    entries.push({
      name: f.name,
      raw,
      body: useDeflate ? deflated! : raw,
      method: useDeflate ? 8 : 0,
      crc: crc32(raw),
    });
  }

  const chunks: number[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    offsets.push(offset);
    const header = [
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(e.method),
      ...u16(0), // mod time
      ...u16(0x2821), // mod date, a fixed 2000-01-01 keeps output deterministic
      ...u32(e.crc),
      ...u32(e.body.length),
      ...u32(e.raw.length),
      ...u16(nameBytes.length),
      ...u16(0),
    ];
    chunks.push(...header, ...nameBytes, ...e.body);
    offset += header.length + nameBytes.length + e.body.length;
  }

  const cdStart = offset;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nameBytes = enc.encode(e.name);
    const central = [
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(e.method),
      ...u16(0),
      ...u16(0x2821),
      ...u32(e.crc),
      ...u32(e.body.length),
      ...u32(e.raw.length),
      ...u16(nameBytes.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offsets[i]),
    ];
    chunks.push(...central, ...nameBytes);
    offset += central.length + nameBytes.length;
  }

  const cdSize = offset - cdStart;
  chunks.push(
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(cdSize),
    ...u32(cdStart),
    ...u16(0),
  );

  return new Uint8Array(chunks);
}

/* --- CSV -------------------------------------------------------------- */

/* A leading =, +, - or @ makes Excel and Sheets treat the cell as a
   formula, which turns an exported speaker biography into code
   execution on the producer's machine. Prefixing with an apostrophe is
   the standard defence and is invisible once opened. */
function csvCell(value: Cell) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(rows: Cell[][]): Uint8Array {
  const text = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  // A BOM so Excel opens UTF-8 correctly rather than mangling accents.
  return enc.encode(`﻿${text}`);
}
