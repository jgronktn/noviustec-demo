// Transfers sheet operations.
//
// A Transfer represents money moving between two of YOUR OWN accounts —
// e.g., paying a credit-card balance from checking, or moving cash from
// checking to savings. It is NOT an expense. P&L tools ignore this
// sheet entirely.
//
// Lifecycle:
//   - addTransfer({...}) — typically from the Record-payment flow when
//     the user settles an awaiting-transfer (card balance), or via the
//     "Mark as transfer" action on a reconciliation panel line.
//   - listTransfers({...}) — filter by date / source / linked awaiting.
//   - getTransfer(id), updateTransfer(id, patch) — standard CRUD.

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const TRANSFER_ID_PREFIX = "xfer_";

const TRANSFER_PATCHABLE_FIELDS = new Set([
  "date",
  "amount",
  "currency",
  "from_source",
  "to_source",
  "description",
  "notes",
  // Allow the auto-link sweep to set the Transfer→Awaiting back-pointer
  // after sum-match / overpayment detection. The reverse pointer
  // (AwaitingPayment.paid_transfer_id) is set via markAwaitingPaid; both
  // sides need to be writable for the link to be bidirectional.
  "awaiting_id",
]);

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") return new Date(v + "T00:00:00Z");
  return null;
}

/**
 * Add a Transfer.
 *
 * @param {object} params
 * @param {Date|string} params.date
 * @param {number}       params.amount        — always positive
 * @param {string}       [params.currency]     — defaults to USD
 * @param {string}       params.from_source   — account name (matches Sources sheet)
 * @param {string}       params.to_source     — account name (matches Sources sheet)
 * @param {string}       [params.description]
 * @param {string}       [params.notes]
 * @param {string}       [params.awaiting_id] — FK if settling an awaiting-transfer
 * @param {string}       [params.source_file]
 * @param {string}       [params.pending_id]
 * @param {"user"|"agent"|"auto-statement"} [params.created_by]
 */
export async function addTransfer(params) {
  const id = TRANSFER_ID_PREFIX + randomUUID().slice(0, 8);
  const row = {
    id,
    date: toDate(params.date),
    amount: params.amount,
    currency: params.currency ?? "USD",
    from_source: params.from_source ?? null,
    to_source: params.to_source ?? null,
    description: params.description ?? "",
    notes: params.notes ?? "",
    awaiting_id: params.awaiting_id ?? null,
    source_file: params.source_file ?? null,
    pending_id: params.pending_id ?? null,
    created_at: new Date().toISOString(),
    created_by: params.created_by ?? "user",
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.TRANSFERS);
    sheet.addRow(row);
  });
  return { id, row };
}

export async function listTransfers({ from, to, from_source, to_source } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.TRANSFERS);
    let rows = readRows(sheet);
    if (from) rows = rows.filter((r) => r.date && new Date(r.date) >= new Date(from));
    if (to) rows = rows.filter((r) => r.date && new Date(r.date) <= new Date(to));
    if (from_source) rows = rows.filter((r) => r.from_source === from_source);
    if (to_source) rows = rows.filter((r) => r.to_source === to_source);
    return rows;
  });
}

export async function getTransfer(id) {
  const rows = await listTransfers();
  return rows.find((r) => r.id === id) ?? null;
}

export async function updateTransfer(id, patch) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.TRANSFERS);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`Transfer not found: ${id}`);
    const applied = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!TRANSFER_PATCHABLE_FIELDS.has(key)) continue;
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
