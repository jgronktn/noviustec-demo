// Read, add, and edit categories. The Categories sheet IS the source of
// truth; edits here write it in place so the app (and agent) can manage the
// chart of categories without hand-editing the workbook.

import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const ACTIVE_VALUES = new Set([true, "TRUE", "true", 1, "1"]);
export function categoryIsActive(row) {
  return ACTIVE_VALUES.has(row?.active);
}

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

/**
 * Edit an existing category in place: rename, change type/description, or
 * archive/restore (active). Resolves the target by its current `name`
 * (case-insensitive).
 *
 * A rename cascades across booked GL rows (transactions store the category
 * NAME, not a row id), so history keeps the renamed label instead of dangling
 * on the old name. Returns { name, old_name, renamed, recategorized, active }.
 *
 * @param {string} name - current category name
 * @param {object} patch - { name?, type?, description?, active? }
 */
export async function updateCategory(name, patch = {}) {
  const current = String(name || "").trim();
  if (!current) throw new Error("updateCategory: name required");
  const { name: newNameRaw, type, description, active } = patch;

  return withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.CATEGORIES);
    const allRows = readRows(sheet);

    let target = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const nm = String(row.getCell("name").value || "").trim();
      if (nm.toLowerCase() === current.toLowerCase()) target = row;
    });
    if (!target) throw new Error(`Category not found: ${current}`);
    const oldName = String(target.getCell("name").value || "").trim();

    // Rename (guard against colliding with a DIFFERENT existing category;
    // re-casing the same name is allowed).
    let newName = oldName;
    const wanted = newNameRaw == null ? null : String(newNameRaw).trim();
    if (wanted && wanted.toLowerCase() !== oldName.toLowerCase()) {
      const collision = allRows.some(
        (r) =>
          String(r.name || "").trim().toLowerCase() === wanted.toLowerCase() &&
          String(r.name || "").trim().toLowerCase() !== oldName.toLowerCase(),
      );
      if (collision) throw new Error(`A category named "${wanted}" already exists`);
      newName = wanted;
      target.getCell("name").value = newName;
    } else if (wanted && wanted !== oldName) {
      // Pure re-casing (e.g. "travel" → "Travel").
      newName = wanted;
      target.getCell("name").value = newName;
    }

    if (type != null) target.getCell("type").value = type;
    if (description != null) target.getCell("description").value = description;
    if (active != null) target.getCell("active").value = !!active;
    target.commit();

    // Cascade a rename across GL rows so booked transactions follow the label.
    let recategorized = 0;
    if (newName !== oldName) {
      const gl = wb.getWorksheet(SHEETS.GL);
      gl.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const c = String(row.getCell("category").value || "").trim();
        if (c.toLowerCase() === oldName.toLowerCase()) {
          row.getCell("category").value = newName;
          row.commit();
          recategorized += 1;
        }
      });
    }

    return {
      name: newName,
      old_name: oldName,
      renamed: newName !== oldName,
      recategorized,
      active: target.getCell("active").value,
    };
  });
}
