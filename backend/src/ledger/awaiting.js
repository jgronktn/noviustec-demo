// AwaitingPayment sheet operations.
//
// An AwaitingPayment row represents an invoice that has been received but
// not yet paid. It does NOT count as an expense in GL (cash-basis: only
// book when money moves). When the receipt later arrives, the user
// matches it to this row via /api/pending/:id/approve with action=match,
// at which point a GL row is created and this row is marked paid.

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const AWAITING_ID_PREFIX = "apw_";

/**
 * Add an awaiting-payment row.
 *
 * @param {object} params
 * @param {string} params.vendor
 * @param {Date|string} params.date - invoice date (YYYY-MM-DD or Date)
 * @param {number} params.amount
 * @param {string} [params.currency] - defaults to "USD"
 * @param {string} [params.reference_number]
 * @param {string} [params.reference_kind]
 * @param {string} [params.description]
 * @param {string} [params.notes]
 * @param {string} [params.document_path] - primary doc relative path
 * @param {string} [params.source_file]
 * @param {string} [params.pending_id]
 */
export async function addAwaitingPayment(params) {
  const id = AWAITING_ID_PREFIX + randomUUID().slice(0, 8);
  const row = {
    id,
    status: "awaiting",
    payment_kind: params.payment_kind ?? "expense", // "expense" | "transfer"
    vendor: params.vendor,
    date:
      typeof params.date === "string"
        ? new Date(params.date + "T00:00:00Z")
        : params.date,
    amount: params.amount,
    currency: params.currency ?? "USD",
    reference_number: params.reference_number ?? null,
    reference_kind: params.reference_kind ?? null,
    description: params.description ?? "",
    notes: params.notes ?? "",
    document_path: params.document_path ?? null,
    source_file: params.source_file ?? null,
    pending_id: params.pending_id ?? null,
    statement_id: params.statement_id ?? null,
    created_at: new Date().toISOString(),
    paid_at: null,
    paid_txn_id: null,
    paid_transfer_id: null,
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.AWAITING);
    sheet.addRow(row);
  });
  return { id, row };
}

export async function listAwaiting({ status = "awaiting" } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.AWAITING);
    const rows = readRows(sheet);
    return status === "all" ? rows : rows.filter((r) => r.status === status);
  });
}

export async function getAwaiting(id) {
  const all = await listAwaiting({ status: "all" });
  return all.find((r) => r.id === id) ?? null;
}

/**
 * Mark an awaiting row as paid. Accepts EITHER paid_txn_id (expense
 * settlement, creates a GL row first) OR paid_transfer_id (transfer
 * settlement, e.g. a card balance paid by moving money between your
 * own accounts). Both fields are persisted; callers supply one.
 */
export async function markAwaitingPaid(
  id,
  { paid_txn_id, paid_transfer_id } = {},
) {
  if (!paid_txn_id && !paid_transfer_id) {
    throw new Error(
      "markAwaitingPaid requires either paid_txn_id or paid_transfer_id",
    );
  }
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.AWAITING);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`AwaitingPayment row not found: ${id}`);
    target.getCell("status").value = "paid";
    target.getCell("paid_at").value = new Date().toISOString();
    if (paid_txn_id) target.getCell("paid_txn_id").value = paid_txn_id;
    if (paid_transfer_id)
      target.getCell("paid_transfer_id").value = paid_transfer_id;
    target.commit();
    return { id, paid_txn_id: paid_txn_id ?? null, paid_transfer_id: paid_transfer_id ?? null };
  });
}

/**
 * Mark an awaiting row as written-off. Used during the
 * card-balance carry-forward — when a new statement supersedes a
 * still-outstanding awaiting-transfer for the same card, the old one
 * gets written off with a note pointing at the new statement so the
 * audit trail is intact.
 */
export async function markAwaitingWrittenOff(id, { note } = {}) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.AWAITING);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`AwaitingPayment row not found: ${id}`);
    target.getCell("status").value = "written_off";
    if (note) {
      const existing = target.getCell("notes").value ?? "";
      target.getCell("notes").value = existing
        ? `${existing} | ${note}`
        : note;
    }
    target.commit();
    return { id };
  });
}

const AWAITING_PATCHABLE_FIELDS = new Set([
  "vendor",
  "date",
  "amount",
  "currency",
  "reference_number",
  "reference_kind",
  "description",
  "notes",
]);

/**
 * Update an AwaitingPayment row in place. Locked fields (immutable here):
 *   id, status, paid_at, paid_txn_id (use markAwaitingPaid),
 *   document_path, source_file, pending_id, created_at.
 *
 * Throws if the row id doesn't exist. Returns the patch keys applied.
 */
export async function updateAwaiting(id, patch) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.AWAITING);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`AwaitingPayment row not found: ${id}`);

    const applied = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!AWAITING_PATCHABLE_FIELDS.has(key)) continue;
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
 * Find awaiting rows for a vendor + total (within ±$0.01) that haven't
 * been paid. Used by /api/pending/:id to suggest matches.
 */
export async function findMatchCandidates({ vendor, total }) {
  if (!vendor || total == null) return [];
  const rows = await listAwaiting({ status: "awaiting" });
  return rows.filter(
    (r) =>
      r.vendor === vendor &&
      Math.abs(Number(r.amount) - Number(total)) < 0.01,
  );
}
