// Read + add categories. Edits beyond add (rename, deactivate, reorder) are
// "edit the Excel file directly" for v1 — the ledger is the source of truth.

import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

export async function getCategories({ activeOnly = true } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.CATEGORIES);
    const rows = readRows(sheet);
    return activeOnly ? rows.filter((r) => r.active === true || r.active === "TRUE" || r.active === 1) : rows;
  });
}

/**
 * Append a category to the Categories sheet. Idempotent on `name`
 * (case-insensitive) — if a row with the same name exists the call is
 * a no-op and returns { added: false, name: <existing> }. Safe to call
 * from a startup-seeding script.
 */
export async function addCategory({ name, type = "expense", description = "", account_code = "", active = true }) {
  if (!name || !name.trim()) throw new Error("addCategory: name required");
  const trimmed = name.trim();
  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.CATEGORIES);
    const existing = readRows(sheet).find(
      (r) => String(r.name || "").trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) return { added: false, name: existing.name };
    sheet.addRow({ name: trimmed, type, description, account_code, active });
    return { added: true, name: trimmed };
  });
}
