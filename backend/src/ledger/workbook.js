// Workbook lifecycle: open existing, or create+seed if missing.
// Serializes all mutating operations through an in-process Promise chain so
// concurrent webhooks can't corrupt the file.

import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { SHEETS, COLUMNS, DEFAULT_CATEGORIES, DEFAULT_PAYMENT_SOURCES } from "./schema.js";

// Resolve the ledger path from env at module load. Default: backend/companies/default/ledger.xlsx
// In production, systemd EnvironmentFile sets LEDGER_PATH to /var/app/companies/<companyId>/ledger.xlsx
const BACKEND_DIR = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_LEDGER_PATH = path.join(BACKEND_DIR, "companies", "default", "ledger.xlsx");
const LEDGER_PATH = process.env.LEDGER_PATH
  ? path.resolve(process.env.LEDGER_PATH)
  : DEFAULT_LEDGER_PATH;

export function getLedgerPath() {
  return LEDGER_PATH;
}

// --------------------------------------------------------------------------
// Write serialization: every mutation chains onto this promise.
// Reads also flow through this to ensure they see the latest committed state.
// --------------------------------------------------------------------------
let writeQueue = Promise.resolve();

function enqueue(fn) {
  const next = writeQueue.then(fn, fn);
  // Swallow rejections on the chain itself so one error doesn't poison
  // subsequent operations — the rejection is still returned to the caller.
  writeQueue = next.catch(() => {});
  return next;
}

// --------------------------------------------------------------------------
// Open or create the workbook.
// --------------------------------------------------------------------------
async function loadOrCreate() {
  const wb = new ExcelJS.Workbook();
  if (existsSync(LEDGER_PATH)) {
    await wb.xlsx.readFile(LEDGER_PATH);
    // readFile restores header VALUES but not the in-memory column key
    // associations — re-apply them so addRow(obj) and getCell(key) keep
    // working. Headers in COLUMNS are the canonical truth; user-renamed
    // headers in Excel get reset on next write (intentional). Also lazily
    // adds any sheets that didn't exist when the file was first created —
    // self-migrating schema for existing ledgers.
    let migrated = false;
    for (const sheetName of Object.keys(COLUMNS)) {
      let sheet = wb.getWorksheet(sheetName);
      if (!sheet) {
        sheet = wb.addWorksheet(sheetName);
        sheet.columns = COLUMNS[sheetName];
        styleHeader(sheet);
        sheet.views = [{ state: "frozen", ySplit: 1 }];
        migrated = true;
      } else {
        sheet.columns = COLUMNS[sheetName];
      }
    }
    if (migrated) await wb.xlsx.writeFile(LEDGER_PATH);
    return { workbook: wb, created: false };
  }

  await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  wb.creator = "Noviustec";
  wb.created = new Date();

  for (const sheetName of Object.keys(COLUMNS)) {
    const sheet = wb.addWorksheet(sheetName);
    sheet.columns = COLUMNS[sheetName];
    styleHeader(sheet);
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  // Seed defaults
  const cats = wb.getWorksheet(SHEETS.CATEGORIES);
  for (const c of DEFAULT_CATEGORIES) cats.addRow(c);

  const sources = wb.getWorksheet(SHEETS.SOURCES);
  for (const s of DEFAULT_PAYMENT_SOURCES) sources.addRow(s);

  await wb.xlsx.writeFile(LEDGER_PATH);
  return { workbook: wb, created: true };
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE5E7EB" }, // light gray
  };
  header.commit();
}

// --------------------------------------------------------------------------
// Public helpers — all serialized through the write queue.
// --------------------------------------------------------------------------
export async function withWorkbookRead(fn) {
  return enqueue(async () => {
    const { workbook } = await loadOrCreate();
    return fn(workbook);
  });
}

export async function withWorkbookWrite(fn) {
  return enqueue(async () => {
    const { workbook } = await loadOrCreate();
    const result = await fn(workbook);
    await workbook.xlsx.writeFile(LEDGER_PATH);
    return result;
  });
}

/**
 * Force the workbook to be created+seeded if it doesn't exist yet.
 * Idempotent: returns `{ created: false }` when the file is already there.
 * Used by `npm run init-ledger`.
 */
export async function initLedger() {
  return enqueue(async () => {
    const { created } = await loadOrCreate();
    return { created, path: LEDGER_PATH };
  });
}

/**
 * Read every row of a sheet as an object keyed by column.key.
 * Skips the header row.
 */
export function readRows(sheet) {
  const rows = [];
  const keys = sheet.columns.map((c) => c.key);
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    for (const key of keys) {
      const cell = row.getCell(key);
      obj[key] = unwrapCell(cell.value);
    }
    rows.push(obj);
  });
  return rows;
}

// Excel cells may return RichText / Date / formula objects — flatten to JS
// primitives so callers don't have to think about it.
function unwrapCell(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return v.text;
    if ("result" in v) return v.result; // formula
    if (v instanceof Date) return v;
  }
  return v;
}
