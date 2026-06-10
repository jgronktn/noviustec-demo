// Read payment sources from the ledger.

import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

export async function getPaymentSources({ activeOnly = true } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.SOURCES);
    const rows = readRows(sheet);
    return activeOnly ? rows.filter((r) => r.active === true || r.active === "TRUE" || r.active === 1) : rows;
  });
}

/**
 * Make sure a payment-source name exists in the Sources sheet. Used by
 * the manual-pay flow so the user can type a new source ("Chase Business
 * Visa ••1234") inline without having to edit Excel first. Idempotent —
 * if the name already exists (case-insensitive), no row is added.
 *
 * Returns `{ added: boolean, name: string }`. `name` is the canonical
 * spelling — if an existing row matched case-insensitively, returns
 * that row's name to keep the GL consistent.
 */
export async function ensurePaymentSource(rawName) {
  const name = String(rawName ?? "").trim();
  if (!name) return { added: false, name: "" };

  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.SOURCES);
    let canonical = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const existing = String(row.getCell("name").value ?? "").trim();
      if (existing && existing.toLowerCase() === name.toLowerCase()) {
        canonical = existing;
      }
    });
    if (canonical) return { added: false, name: canonical };

    sheet.addRow({
      name,
      type: "other",
      last4: null,
      institution: null,
      description: "Added via Record-payment form",
      active: true,
    });
    return { added: true, name };
  });
}
