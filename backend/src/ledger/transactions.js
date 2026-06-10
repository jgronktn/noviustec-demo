// GL (General Ledger) operations.
//
// addTransaction(): writes an approved transaction. Called from the approval
//   flow when the user accepts a pending row (with any adjustments).
// listTransactions(): for reporting / agent tool surface later.

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const TXN_ID_PREFIX = "txn_";

/**
 * Append a transaction to the GL.
 *
 * @param {object} params
 * @param {string} params.vendor
 * @param {Date|string} params.date - JS Date or ISO YYYY-MM-DD
 * @param {string} params.category
 * @param {string} [params.payment_source]
 * @param {number} params.amount
 * @param {string} [params.currency] - defaults to "USD"
 * @param {string} [params.description]
 * @param {string} [params.notes]
 * @param {string} [params.source_file] - filename of the original Postmark payload
 * @param {string} [params.pending_id] - source PendingInbox row id (for traceability)
 * @param {"user"|"agent"} [params.created_by]
 */
export async function addTransaction(params) {
  const id = TXN_ID_PREFIX + randomUUID().slice(0, 8);
  const row = {
    id,
    date: typeof params.date === "string" ? new Date(params.date + "T00:00:00Z") : params.date,
    vendor: params.vendor,
    description: params.description ?? "",
    category: params.category,
    payment_source: params.payment_source ?? null,
    amount: params.amount,
    currency: params.currency ?? "USD",
    reference_number: params.reference_number ?? null,
    reference_kind: params.reference_kind ?? null,
    document_path: params.document_path ?? null,
    notes: params.notes ?? "",
    source_file: params.source_file ?? null,
    pending_id: params.pending_id ?? null,
    created_at: new Date().toISOString(),
    created_by: params.created_by ?? "user",
    // "expense" (money out) or "income" (deposit). Null on legacy
    // rows is treated as "expense" by every reader.
    entry_type: params.entry_type === "income" ? "income" : "expense",
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.GL);
    sheet.addRow(row);
  });
  return { id, row };
}

export async function getTransaction(id) {
  const all = await listTransactions();
  return all.find((t) => t.id === id) ?? null;
}

const TXN_PATCHABLE_FIELDS = new Set([
  "vendor",
  "date",
  "amount",
  "currency",
  "category",
  "payment_source",
  "reference_number",
  "reference_kind",
  "description",
  "notes",
  // Toggling a row between expense and income is a legitimate
  // correction (booking mistake, miscategorization). Patchable.
  "entry_type",
]);

/**
 * Update an existing GL row in place. Only whitelisted fields are
 * patchable — id, document_path, source_file, pending_id, created_at,
 * created_by are intentionally locked because they encode provenance.
 *
 * Throws if the row id doesn't exist. Coerces YYYY-MM-DD strings into
 * Date objects so the date cell renders consistently. Returns the
 * applied patch keys for the route to log + the row's id.
 */
export async function updateTransaction(id, patch) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.GL);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`GL row not found: ${id}`);

    const applied = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!TXN_PATCHABLE_FIELDS.has(key)) continue;
      if (value === undefined) continue;
      if (
        key === "date" &&
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
      ) {
        target.getCell(key).value = new Date(value + "T00:00:00Z");
      } else {
        target.getCell(key).value = value;
      }
      applied.push(key);
    }
    if (applied.length > 0) target.commit();
    return { id, fields_updated: applied };
  });
}

/**
 * Remove a GL row by id. Returns { id, deleted: true } on success;
 * throws if not found. Cascade safety is the caller's responsibility
 * — this just deletes the row from the sheet. The route handler
 * checks FKs (statement-line links, awaiting paid_txn_id, Documents
 * rows) before invoking this.
 */
export async function deleteTransaction(id) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.GL);
    let targetRowNumber = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) targetRowNumber = rowNumber;
    });
    if (targetRowNumber === null) {
      throw new Error(`GL row not found: ${id}`);
    }
    sheet.spliceRows(targetRowNumber, 1);
    return { id, deleted: true };
  });
}

export async function listTransactions({ from, to, category, payment_source } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.GL);
    let rows = readRows(sheet);
    if (from) rows = rows.filter((r) => r.date && new Date(r.date) >= new Date(from));
    if (to) rows = rows.filter((r) => r.date && new Date(r.date) <= new Date(to));
    if (category) rows = rows.filter((r) => r.category === category);
    if (payment_source) rows = rows.filter((r) => r.payment_source === payment_source);
    return rows;
  });
}
