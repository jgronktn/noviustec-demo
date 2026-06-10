// Statements + StatementLines sheet operations.
//
// A Statements row represents one uploaded bank or credit-card statement.
// Each row in StatementLines is one transaction on that statement. Matching
// statement lines to GL rows (reconciliation) is a separate workflow — for
// now the parser just imports the data so the user has a record of what
// statements have been uploaded and what they contained.

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const STATEMENT_ID_PREFIX = "stmt_";
const STATEMENT_LINE_ID_PREFIX = "stmtl_";

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") return new Date(v + "T00:00:00Z");
  return null;
}

/**
 * Add a statement and all its parsed lines in one atomic write.
 *
 * @param {object} params
 * @param {object} params.statement - { source, period_start, period_end, statement_date,
 *   currency, opening_balance, closing_balance, total_charges, total_payments,
 *   transaction_count, document_path, original_filename, source_file, pending_id,
 *   status, notes }
 * @param {Array<object>} params.lines - [{ line_date, description, amount,
 *   balance_after?, notes? }, ...]
 * @returns {Promise<{ id: string, line_ids: string[] }>}
 */
export async function addStatement({ statement, lines = [] }) {
  const id = STATEMENT_ID_PREFIX + randomUUID().slice(0, 8);
  const now = new Date().toISOString();

  return withWorkbookWrite(async (wb) => {
    const stmtSheet = wb.getWorksheet(SHEETS.STATEMENTS);
    stmtSheet.addRow({
      id,
      status: statement.status ?? "imported",
      source: statement.source,
      period_start: toDate(statement.period_start),
      period_end: toDate(statement.period_end),
      statement_date: toDate(statement.statement_date),
      currency: statement.currency ?? "USD",
      opening_balance: statement.opening_balance ?? null,
      closing_balance: statement.closing_balance ?? null,
      total_charges: statement.total_charges ?? null,
      total_payments: statement.total_payments ?? null,
      transaction_count: lines.length,
      document_path: statement.document_path ?? null,
      original_filename: statement.original_filename ?? null,
      source_file: statement.source_file ?? null,
      pending_id: statement.pending_id ?? null,
      created_at: now,
      notes: statement.notes ?? "",
    });

    const linesSheet = wb.getWorksheet(SHEETS.STATEMENT_LINES);
    const line_ids = [];
    for (const ln of lines) {
      const line_id = STATEMENT_LINE_ID_PREFIX + randomUUID().slice(0, 8);
      linesSheet.addRow({
        id: line_id,
        statement_id: id,
        line_date: toDate(ln.line_date),
        description: ln.description ?? "",
        amount: ln.amount,
        balance_after: ln.balance_after ?? null,
        matched_txn_id: null,
        match_method: null,
        notes: ln.notes ?? "",
        created_at: now,
      });
      line_ids.push(line_id);
    }
    return { id, line_ids };
  });
}

export async function listStatements({ status, source } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.STATEMENTS);
    let rows = readRows(sheet);
    if (status && status !== "all") rows = rows.filter((r) => r.status === status);
    if (source) rows = rows.filter((r) => r.source === source);
    return rows;
  });
}

export async function getStatement(id) {
  const rows = await listStatements();
  return rows.find((r) => r.id === id) ?? null;
}

const STATEMENT_LINE_PATCHABLE = new Set([
  "matched_txn_id",
  "matched_transfer_id",
  "match_method",
  "notes",
]);

/**
 * Update a single StatementLine row in place. Used by the reconciliation
 * workflow to set / clear the matched_txn_id link to a GL row.
 *
 * Locked fields: id, statement_id, line_date, description, amount,
 * balance_after, created_at — everything that's source-of-truth from
 * the parser. The reconciliation flow only ever writes the match
 * pointer.
 */
export async function updateStatementLine(id, patch) {
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.STATEMENT_LINES);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`StatementLine not found: ${id}`);

    const applied = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!STATEMENT_LINE_PATCHABLE.has(key)) continue;
      target.getCell(key).value = value;
      applied.push(key);
    }
    if (applied.length > 0) target.commit();
    return { id, fields_updated: applied };
  });
}

/**
 * Update a single Statements row in place. Used by reconciliation to
 * flip status (imported → partially_reconciled → reconciled) without
 * touching the per-line data.
 */
export async function updateStatement(id, patch) {
  const PATCHABLE = new Set(["status", "notes"]);
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.STATEMENTS);
    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell("id").value === id) target = row;
    });
    if (!target) throw new Error(`Statement not found: ${id}`);
    const applied = [];
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!PATCHABLE.has(k)) continue;
      target.getCell(k).value = v;
      applied.push(k);
    }
    if (applied.length > 0) target.commit();
    return { id, fields_updated: applied };
  });
}

export async function listStatementLines({ statement_id } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.STATEMENT_LINES);
    let rows = readRows(sheet);
    if (statement_id) rows = rows.filter((r) => r.statement_id === statement_id);
    return rows;
  });
}
