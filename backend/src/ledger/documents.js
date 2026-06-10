// Documents sheet operations.
//
// One row per archived file. A single GL transaction can have multiple
// document rows (e.g., Anthropic emails both an Invoice and a Receipt for
// the same charge — both worth tracking even though only one $50 line
// goes into the GL).

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const DOC_ID_PREFIX = "doc_";

/**
 * Append a document row.
 *
 * @param {object} params
 * @param {string}   params.vendor
 * @param {Date|string} params.date          - JS Date or ISO YYYY-MM-DD
 * @param {string|null} params.reference_kind
 * @param {string|null} params.reference_number
 * @param {string}   params.filename         - our canonical name on disk
 * @param {string}   params.original_filename - what the source called it
 * @param {string}   params.document_path    - relative to company root
 * @param {string|null} params.txn_id        - GL FK (null if doc not tied to a txn)
 * @param {string|null} params.pending_id    - PendingInbox FK
 */
export async function addDocument(params) {
  const id = DOC_ID_PREFIX + randomUUID().slice(0, 8);
  const row = {
    id,
    vendor: params.vendor ?? null,
    date:
      typeof params.date === "string"
        ? new Date(params.date + "T00:00:00Z")
        : (params.date ?? null),
    reference_kind: params.reference_kind ?? null,
    reference_number: params.reference_number ?? null,
    filename: params.filename,
    original_filename: params.original_filename ?? null,
    document_path: params.document_path,
    txn_id: params.txn_id ?? null,
    pending_id: params.pending_id ?? null,
    created_at: new Date().toISOString(),
    awaiting_id: params.awaiting_id ?? null,
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.DOCUMENTS);
    sheet.addRow(row);
  });
  return { id, row };
}

/**
 * Backfill txn_id on Documents rows that were originally archived against
 * an AwaitingPayment row (so txn_id was null). Called from the approve
 * endpoint when an awaiting invoice gets matched to its receipt: the
 * invoice's prior Documents row now belongs to the same GL transaction.
 */
export async function attachDocumentsToTransaction({ awaiting_id, txn_id }) {
  if (!awaiting_id || !txn_id) return { updated: 0 };
  let updated = 0;
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.DOCUMENTS);
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const rowAwaitingId = row.getCell("awaiting_id").value;
      const rowTxnId = row.getCell("txn_id").value;
      if (rowAwaitingId === awaiting_id && !rowTxnId) {
        row.getCell("txn_id").value = txn_id;
        row.commit();
        updated += 1;
      }
    });
  });
  return { updated };
}

export async function listDocuments({ txn_id, pending_id } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.DOCUMENTS);
    let rows = readRows(sheet);
    if (txn_id) rows = rows.filter((r) => r.txn_id === txn_id);
    if (pending_id) rows = rows.filter((r) => r.pending_id === pending_id);
    return rows;
  });
}

export async function getDocument(id) {
  const all = await listDocuments();
  return all.find((r) => r.id === id) ?? null;
}

/**
 * Distinct vendor names seen across the books (Documents + AwaitingPayment
 * + GL). Used as context for the receipt parser so new variants of an
 * existing vendor name don't drift in ("Anthropic" vs "Anthropic, PBC").
 */
export async function getKnownVendors() {
  return withWorkbookRead(async (wb) => {
    const seen = new Set();
    const sheets = ["Documents", "AwaitingPayment", "GL"];
    for (const name of sheets) {
      const sheet = wb.getWorksheet(name);
      if (!sheet) continue;
      for (const r of readRows(sheet)) {
        if (r.vendor && typeof r.vendor === "string") {
          seen.add(r.vendor.trim());
        }
      }
    }
    seen.delete("");
    return [...seen].sort((a, b) => a.localeCompare(b));
  });
}
