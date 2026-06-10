// PendingInbox operations.
//
// addPending(): called by the webhook after parsing — persists the workflow
//   state for a parsed receipt that needs user approval.
// listPending(): for the upcoming approval UI.
// getPending(id): for fetching a single row.
// updatePendingStatus(): for marking approved/rejected (used by approval flow).

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const PENDING_ID_PREFIX = "pnd_";

/**
 * Add a pending entry from a parser result.
 *
 * @param {object} params
 * @param {string} params.source_file - filename of the saved Postmark payload (e.g. "inbound-2026-...json")
 * @param {object} params.result - the full parseReceipt() result object
 * @returns {Promise<{ id: string, row: object }>}
 */
export async function addPending({ source_file, result }) {
  const id = newPendingId();
  const row = pendingRowFromResult(id, source_file, result);
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.PENDING);
    sheet.addRow(row);
  });
  return { id, row };
}

// The inbox's default "active" view: rows still in flight or awaiting review.
// processing = parse running, pending = ready to review, failed = parse gave
// up (not a receipt / error). approved + rejected are terminal and excluded.
const ACTIVE_PENDING_STATUSES = new Set(["processing", "pending", "failed"]);

export async function listPending({ status = "pending" } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.PENDING);
    const rows = readRows(sheet);
    if (status === "all") return rows;
    if (status === "active") {
      return rows.filter((r) => ACTIVE_PENDING_STATUSES.has(r.status));
    }
    return rows.filter((r) => r.status === status);
  });
}

/**
 * Insert a "processing" placeholder the instant an email arrives, before the
 * (multi-second) vision parse runs — so the inbox shows the receipt is being
 * worked on. processReceiptPayload() later resolves this same row to "pending"
 * (with the parsed data) or "failed". The email Subject is stashed in `reason`
 * purely so the UI can show "Parsing <subject>…".
 */
export async function addProcessingPlaceholder({ source_file, subject = null }) {
  const id = newPendingId();
  const row = {
    id,
    status: "processing",
    received_at: new Date().toISOString(),
    source_file,
    vendor: null,
    date: null,
    total: null,
    currency: null,
    reference_number: null,
    reference_kind: null,
    suggested_category: null,
    suggested_source: null,
    confidence: null,
    reason: subject ? `Parsing “${subject}”…` : "Parsing…",
    resolved_at: null,
    resolution_notes: null,
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.PENDING);
    sheet.addRow(row);
  });
  return { id, row };
}

/**
 * Resolve a processing placeholder to a terminal "failed" state — the parse
 * concluded the email isn't a trackable receipt, or it threw. Records the
 * reason so the inbox can show why.
 */
export async function markPendingFailed(id, reason) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.PENDING);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`Pending row not found: ${id}`);
    target.getCell("status").value = "failed";
    target.getCell("reason").value = String(reason || "could_not_parse");
    target.getCell("resolved_at").value = new Date().toISOString();
    target.commit();
    return { id };
  });
}

export async function getPending(id) {
  const all = await listPending({ status: "all" });
  return all.find((r) => r.id === id) ?? null;
}

/**
 * Update a pending row's status. Used by the approval flow:
 *   - approve → moves to GL via transactions.addTransaction() AND marks here as approved
 *   - reject → marks here as rejected, no GL row created
 *
 * We resolve the row by `id`, not by sheet row number, because Excel-side
 * edits could shift rows.
 */
export async function updatePendingStatus(id, { status, resolution_notes = "" }) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.PENDING);
    const idCol = sheet.getColumn("id");
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) {
      throw new Error(`Pending row not found: ${id}`);
    }
    target.getCell("status").value = status;
    target.getCell("resolved_at").value = new Date().toISOString();
    target.getCell("resolution_notes").value = resolution_notes;
    target.commit();
    return { id, status };
  });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function newPendingId() {
  return PENDING_ID_PREFIX + randomUUID().slice(0, 8);
}

function pendingRowFromResult(id, source_file, result) {
  const p = result.proposal;
  return {
    id,
    status: result.status === "parsed" ? "pending" : "pending", // both parsed and needs_attention land as pending — they all need user review
    received_at: new Date().toISOString(),
    source_file,
    vendor: p?.vendor?.name ?? null,
    date: p?.date ? parseDateOrNull(p.date) : null,
    total: p?.total?.amount ?? null,
    currency: p?.total?.currency ?? null,
    reference_number: p?.reference_number?.value ?? null,
    reference_kind: p?.reference_number?.kind ?? null,
    suggested_category: p?.suggested_category ?? null,
    suggested_source: p?.suggested_payment_source ?? null,
    confidence: p?.confidence ?? null,
    reason: result.reason ?? null,
    resolved_at: null,
    resolution_notes: null,
  };
}

/**
 * Overwrite the parsed-data fields of an existing PendingInbox row from a
 * fresh parseReceipt() result. Used by /api/pending/:id/reparse to refresh
 * rows that were parsed before some parser improvement (e.g. before
 * reference_number extraction shipped). Keeps id, received_at,
 * source_file, resolved_at, resolution_notes intact. Status is left as-is
 * unless `opts.status` is given — the webhook pipeline passes "pending" to
 * promote a "processing" placeholder once parsing lands.
 */
export async function updatePendingFromParse(id, result, { status } = {}) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.PENDING);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) {
      throw new Error(`Pending row not found: ${id}`);
    }
    const p = result.proposal;
    target.getCell("vendor").value = p?.vendor?.name ?? null;
    target.getCell("date").value = p?.date ? parseDateOrNull(p.date) : null;
    target.getCell("total").value = p?.total?.amount ?? null;
    target.getCell("currency").value = p?.total?.currency ?? null;
    target.getCell("reference_number").value = p?.reference_number?.value ?? null;
    target.getCell("reference_kind").value = p?.reference_number?.kind ?? null;
    target.getCell("suggested_category").value = p?.suggested_category ?? null;
    target.getCell("suggested_source").value = p?.suggested_payment_source ?? null;
    target.getCell("confidence").value = p?.confidence ?? null;
    target.getCell("reason").value = result.reason ?? null;
    if (status) target.getCell("status").value = status;
    target.commit();
    return { id };
  });
}

function parseDateOrNull(iso) {
  // Stored as a real Date so Excel formats nicely. We trust the parser's
  // YYYY-MM-DD output; if it's malformed, leave the cell blank rather than
  // surfacing 1970-01-01.
  const d = new Date(iso + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}
