// Document archive: on approval, extract the original PDF/image bytes from
// the saved Postmark payload (or upload payload) and write them to a
// per-vendor folder under the company's data root.
//
// Layout:
//   companies/{companyId}/documents/{vendor-slug}/{date}_{kind}-{ref}.{ext}
//
// Returns the path RELATIVE TO the company root so the ledger row's
// document_path column lives alongside the ledger.xlsx and resolves locally
// when the whole company folder is zipped and handed to an accountant.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { isInlineAttachment } from "../parser/attachments.js";

// Companies root resolution mirrors ledger/workbook.js: env var if set,
// otherwise relative to the backend directory. Production keeps the env
// var unset and the default `backend/companies/` resolves correctly under
// systemd's WorkingDirectory.
const BACKEND_DIR = path.resolve(import.meta.dirname, "..", "..");
const COMPANIES_DIR = process.env.NOVIUSTEC_COMPANIES_DIR
  ? path.resolve(process.env.NOVIUSTEC_COMPANIES_DIR)
  : path.join(BACKEND_DIR, "companies");

export function getCompaniesDir() {
  return COMPANIES_DIR;
}

/**
 * Archive an uploaded bank/credit-card statement to:
 *   companies/{companyId}/statements/{source-slug}/{statement-close-date}.{ext}
 *
 * Unlike receipts (which are vendor-organized), statements are organized
 * by payment source — one folder per card/account — with the statement
 * close date as the filename so multiple statements per source sort and
 * resolve unambiguously.
 *
 * @param {object} params
 * @param {string} params.companyId
 * @param {string} params.source           - payment source name (Sources sheet)
 * @param {string} params.statementDate    - YYYY-MM-DD (statement close date)
 * @param {string} params.contentBase64    - base64 file bytes (from the upload payload)
 * @param {string} params.contentType      - MIME (e.g. "application/pdf")
 * @param {string} [params.originalFilename]
 * @returns {Promise<{ document_path, absolute_path, filename }>}
 */
export async function archiveStatement({
  companyId,
  source,
  statementDate,
  contentBase64,
  contentType,
  originalFilename,
}) {
  const ext = EXT_BY_MIME.get(
    String(contentType ?? "")
      .toLowerCase()
      .split(";")[0]
      .trim(),
  );
  if (!ext) {
    throw new Error(`Unsupported statement content type: ${contentType}`);
  }
  const sourceSlug = slugify(source) || "unknown-source";
  const dir = path.join(COMPANIES_DIR, companyId, "statements", sourceSlug);
  await fs.mkdir(dir, { recursive: true });

  const dateKey =
    statementDate && /^\d{4}-\d{2}-\d{2}$/.test(statementDate)
      ? statementDate
      : new Date().toISOString().slice(0, 10);
  const filename = `${dateKey}.${ext}`;
  const absolutePath = path.join(dir, filename);
  await fs.writeFile(absolutePath, Buffer.from(contentBase64, "base64"));

  return {
    document_path: path.posix.join("statements", sourceSlug, filename),
    absolute_path: absolutePath,
    filename,
    original_filename: originalFilename ?? null,
  };
}

/**
 * Resolve a statement document_path (relative to the company root) to an
 * absolute filesystem path. Defends against path traversal — the resolved
 * path must stay inside the company's statements/ tree.
 */
export function resolveStatementPath({ companyId, documentPath }) {
  if (!documentPath || typeof documentPath !== "string") return null;
  const companyRoot = path.join(COMPANIES_DIR, companyId);
  const statementsRoot = path.join(companyRoot, "statements");
  const absolute = path.resolve(companyRoot, documentPath);
  if (!absolute.startsWith(statementsRoot + path.sep)) return null;
  return absolute;
}

// Map MIME types we accept to filesystem extensions.
const EXT_BY_MIME = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

/**
 * Archive every viewable PDF/image attached to the source payload.
 *
 * Returns one record per archived file. For each, we try to identify the
 * document's own kind+reference from its source filename (Anthropic's
 * "Invoice-XXX.pdf" / "Receipt-YYY.pdf" pattern, DigitalOcean's
 * "DigitalOcean Invoice ... (XXX).pdf", etc.). If the source filename
 * doesn't make the kind obvious, we fall back to the parser's overall
 * reference for the PRIMARY (largest) doc and leave the rest unlabeled.
 *
 * The caller (the approve endpoint) writes one Documents row per record
 * and uses the first record's path as the GL row's `document_path`
 * (primary doc).
 *
 * @param {object} params
 * @param {string}   params.companyId
 * @param {string}   params.logDir
 * @param {string}   params.sourceFile        - basename of the payload (inbound-*.json or upload-*.json)
 * @param {string}   params.vendor            - approved vendor name
 * @param {string}   params.date              - YYYY-MM-DD
 * @param {object|null} params.reference      - approve body's { value, kind } (the parser's primary)
 * @param {string}   params.pendingId         - pending row id (for filename fallback)
 * @returns {Promise<Array<{document_path,absolute_path,filename,original_filename,reference_kind,reference_number}>>}
 */
export async function archiveAttachments({
  companyId,
  logDir,
  sourceFile,
  vendor,
  date,
  reference,
  pendingId,
}) {
  if (!sourceFile) return [];

  const payloadPath = path.join(logDir, sourceFile);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(payloadPath, "utf-8"));
  } catch {
    return [];
  }

  const supported = collectArchivableAttachments(payload?.Attachments, payload?.HtmlBody ?? "");
  if (supported.length === 0) return [];

  const vendorSlug = slugify(vendor) || "unknown-vendor";
  const vendorDir = path.join(COMPANIES_DIR, companyId, "documents", vendorSlug);
  await fs.mkdir(vendorDir, { recursive: true });

  // Sort: largest first → the parser-matched primary tends to fall to index 0.
  supported.sort((a, b) => (b.ContentLength ?? 0) - (a.ContentLength ?? 0));

  const records = [];
  for (let i = 0; i < supported.length; i++) {
    const att = supported[i];
    const ct = att.ContentType.toLowerCase().split(";")[0].trim();
    const ext = EXT_BY_MIME.get(ct);
    if (!ext) continue;

    // Per-attachment kind/reference: try to read it off the source filename.
    const fromName = parseFilenameForRefAndKind(att.Name);

    // The parser extracted ONE reference across the whole email. Apply it to
    // the doc that "matches" — same kind from filename, or just the first
    // (largest) doc if filename doesn't say. The other docs keep their
    // filename-derived metadata.
    let kind = fromName.kind;
    let value = fromName.value;
    if (reference?.value && reference?.kind) {
      const isMatch =
        fromName.kind === reference.kind ||
        (fromName.kind === null && i === 0); // first doc gets the parser's ref if filename was ambiguous
      if (isMatch) {
        kind = reference.kind;
        value = reference.value;
      }
    }

    const filename = buildFilename({
      date,
      reference: kind && value ? { kind, value } : null,
      vendorSlug,
      pendingId,
      idx: i,
      ext,
    });

    const absolutePath = path.join(vendorDir, filename);
    await fs.writeFile(absolutePath, Buffer.from(att.Content, "base64"));

    records.push({
      document_path: path.posix.join("documents", vendorSlug, filename),
      absolute_path: absolutePath,
      filename,
      original_filename: att.Name ?? null,
      reference_kind: kind,
      reference_number: value,
    });
  }
  return records;
}

/**
 * Backward-compat wrapper for the old single-doc call site. Returns the
 * first record (the primary doc) in the same shape `archiveDocument` used
 * to return, or null if nothing was archived.
 */
export async function archiveDocument(params) {
  const records = await archiveAttachments(params);
  if (records.length === 0) return null;
  const first = records[0];
  return { document_path: first.document_path, absolute_path: first.absolute_path };
}

/**
 * Resolve a document_path (relative to the company root) to an absolute
 * filesystem path. Validates that the resolved path stays inside the
 * company's documents directory — defense against path traversal in the
 * stored value.
 */
export function resolveDocumentPath({ companyId, documentPath }) {
  if (!documentPath || typeof documentPath !== "string") return null;
  const companyRoot = path.join(COMPANIES_DIR, companyId);
  const documentsRoot = path.join(companyRoot, "documents");
  const absolute = path.resolve(companyRoot, documentPath);
  if (!absolute.startsWith(documentsRoot + path.sep)) return null;
  return absolute;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function collectArchivableAttachments(attachments, htmlBody) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  return attachments.filter((a) => {
    if (typeof a?.ContentType !== "string" || typeof a?.Content !== "string") return false;
    if (a.Content.length === 0) return false;
    const ct = a.ContentType.toLowerCase().split(";")[0].trim();
    if (!EXT_BY_MIME.has(ct)) return false;
    // Skip inline images (email signature logos, etc.) referenced via cid:
    // in the HtmlBody. Same detection the triage stage uses.
    if (isInlineAttachment(a, htmlBody)) return false;
    // Legacy: skip Outlook's tiny ~WRD000X.jpg layout artifacts (~824B).
    if ((a.ContentLength ?? 0) < 2048 && (a.Name ?? "").startsWith("~WRD")) return false;
    return true;
  });
}

/**
 * Heuristic: extract reference_kind and reference_number from a source
 * filename. Handles the common shapes vendors use:
 *   "Invoice-6XZNJ8IH-0001.pdf"        → { kind: "invoice", value: "6XZNJ8IH-0001" }
 *   "Receipt-2460-0226-5803.pdf"        → { kind: "receipt", value: "2460-0226-5803" }
 *   "Order_12345.pdf"                   → { kind: "order", value: "12345" }
 *   "DigitalOcean Invoice 2026 Feb (29209657-540085122).pdf"
 *                                       → { kind: "invoice", value: "29209657-540085122" }
 *   "149011494.pdf"                     → { kind: null, value: null }
 *   "lunch.jpg"                         → { kind: null, value: null }
 */
function parseFilenameForRefAndKind(filename) {
  if (!filename || typeof filename !== "string") return { kind: null, value: null };
  const stem = filename.replace(/\.[a-z0-9]+$/i, "");

  // Find the leftmost kind keyword.
  const kindMatch = stem.match(/(invoice|receipt|order|confirmation|transaction)/i);
  if (!kindMatch) return { kind: null, value: null };
  const kind = kindMatch[1].toLowerCase();

  // Pull the reference: look for content in parens first (DigitalOcean style),
  // then fall back to the chars after the kind keyword + separator.
  const parenMatch = stem.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    return { kind, value: parenMatch[1].trim() };
  }
  // Everything after the kind word, stripped of leading separators.
  const after = stem.slice(kindMatch.index + kindMatch[0].length).replace(/^[\s_-]+/, "");
  if (!after) return { kind, value: null };
  return { kind, value: after };
}

function buildFilename({ date, reference, vendorSlug, pendingId, idx, ext }) {
  const datePart = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "undated";
  if (reference?.value && reference?.kind) {
    return `${datePart}_${reference.kind}-${sanitizeRef(reference.value)}.${ext}`;
  }
  // Fallback when neither the parser nor the filename heuristic identified
  // a reference. Disambiguate multiple docs via the index.
  const suffix = (pendingId || "").replace(/^pnd_/, "") || "noref";
  const idxPart = typeof idx === "number" && idx > 0 ? `-${idx + 1}` : "";
  return `${datePart}_${vendorSlug}-${suffix}${idxPart}.${ext}`;
}

export function slugify(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^\w\s-]+/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function sanitizeRef(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
