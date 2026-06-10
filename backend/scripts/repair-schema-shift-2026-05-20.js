// One-off repair after the schema migration in commit 4e031d8 (the
// transfers / payment_kind / matched_transfer_id work).
//
// Mistake: that commit inserted new columns MID-SHEET (Payment_Kind at
// position 3 of AwaitingPayment, Source_Kind at position 4 of
// Statements, Matched_Transfer_ID at position 8 of StatementLines).
// ExcelJS reassigns column keys on load but doesn't move existing
// cell data — so every pre-migration row ended up with its values
// shifted one column to the right of where the new headers expected
// them. The Awaiting panel renders empty, the agent gets garbled
// fields, etc.
//
// This script snapshots each damaged row's cells positionally, then
// rewrites them at the correct new-schema positions. Idempotent:
// detection signals only fire on damaged rows; rows added under the
// new schema are skipped. A backup copy of the workbook is written
// alongside before any mutation.
//
// USAGE:
//   node scripts/repair-schema-shift-2026-05-20.js --dry-run
//   node scripts/repair-schema-shift-2026-05-20.js
//
// SAFETY: stop the service first
//   sudo systemctl stop noviustec-api
// then run with --dry-run to confirm counts, then run without --dry-run
// to apply, then start the service back up.
//
// GOING FORWARD: future column additions to existing sheets MUST APPEND
// at the end of the schema array. Never insert mid-sheet.

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ExcelJS from "exceljs";

const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const BACKEND_DIR = path.resolve(import.meta.dirname, "..");
const LEDGER_PATH = process.env.LEDGER_PATH
  ? path.resolve(process.env.LEDGER_PATH)
  : path.join(BACKEND_DIR, "companies", "default", "ledger.xlsx");

const DRY_RUN = process.argv.includes("--dry-run");

if (!existsSync(LEDGER_PATH)) {
  console.error(`Ledger not found: ${LEDGER_PATH}`);
  process.exit(1);
}

console.log(`Ledger: ${LEDGER_PATH}`);
console.log(`Mode:   ${DRY_RUN ? "DRY RUN (no writes)" : "APPLY"}`);
console.log("");

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(LEDGER_PATH);

// ── AwaitingPayment ────────────────────────────────────────────────────
// Damaged rows have an old-style Vendor name at the Payment_Kind slot
// (position 3). Pristine rows added under the new schema have
// Payment_Kind = "expense" or "transfer".
function repairAwaitingPayment(sheet) {
  if (!sheet) return { repaired: 0, skipped: 0 };
  let repaired = 0;
  let skipped = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const pk = String(row.getCell(3).value ?? "").trim().toLowerCase();
    if (pk === "" || pk === "expense" || pk === "transfer") {
      skipped++;
      return;
    }
    // Snapshot the 16 old-schema cell values.
    const v = [];
    for (let i = 1; i <= 16; i++) v.push(row.getCell(i).value);
    // Rewrite at new-schema positions.
    row.getCell(1).value = v[0]; // ID
    row.getCell(2).value = v[1]; // Status
    row.getCell(3).value = "expense"; // Payment_Kind (legacy default)
    row.getCell(4).value = v[2]; // Vendor
    row.getCell(5).value = v[3]; // Date
    row.getCell(6).value = v[4]; // Amount
    row.getCell(7).value = v[5]; // Currency
    row.getCell(8).value = v[6]; // Reference_Number
    row.getCell(9).value = v[7]; // Reference_Kind
    row.getCell(10).value = v[8]; // Description
    row.getCell(11).value = v[9]; // Notes
    row.getCell(12).value = v[10]; // Document_Path
    row.getCell(13).value = v[11]; // Source_File
    row.getCell(14).value = v[12]; // Pending_ID
    row.getCell(15).value = null; // Statement_ID (new column)
    row.getCell(16).value = v[13]; // Created_At
    row.getCell(17).value = v[14]; // Paid_At
    row.getCell(18).value = v[15]; // Paid_TXN_ID
    row.getCell(19).value = null; // Paid_Transfer_ID (new column)
    row.commit();
    repaired++;
  });
  return { repaired, skipped };
}

// ── Statements ─────────────────────────────────────────────────────────
// Damaged rows have a date-shaped value at the Source_Kind slot
// (position 4). Pristine rows have null or one of the kind strings.
function looksLikeDateValue(v) {
  if (v == null) return false;
  if (v instanceof Date) return true;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

function repairStatements(sheet) {
  if (!sheet) return { repaired: 0, skipped: 0 };
  let repaired = 0;
  let skipped = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    if (!looksLikeDateValue(row.getCell(4).value)) {
      skipped++;
      return;
    }
    // Snapshot 18 old-schema cell values.
    const v = [];
    for (let i = 1; i <= 18; i++) v.push(row.getCell(i).value);
    row.getCell(1).value = v[0]; // ID
    row.getCell(2).value = v[1]; // Status
    row.getCell(3).value = v[2]; // Source
    row.getCell(4).value = null; // Source_Kind (new)
    row.getCell(5).value = v[3]; // Period_Start
    row.getCell(6).value = v[4]; // Period_End
    row.getCell(7).value = v[5]; // Statement_Date
    row.getCell(8).value = v[6]; // Currency
    row.getCell(9).value = v[7]; // Opening_Balance
    row.getCell(10).value = v[8]; // Closing_Balance
    row.getCell(11).value = v[9]; // Total_Charges
    row.getCell(12).value = v[10]; // Total_Payments
    row.getCell(13).value = v[11]; // Transaction_Count
    row.getCell(14).value = v[12]; // Document_Path
    row.getCell(15).value = v[13]; // Original_Filename
    row.getCell(16).value = v[14]; // Source_File
    row.getCell(17).value = v[15]; // Pending_ID
    row.getCell(18).value = v[16]; // Created_At
    row.getCell(19).value = v[17]; // Notes
    row.commit();
    repaired++;
  });
  return { repaired, skipped };
}

// ── StatementLines ─────────────────────────────────────────────────────
// Damaged rows have old Match_Method in the Matched_Transfer_ID slot
// (position 8), OR their Created_At at the old position 10 instead of
// the new position 11.
function repairStatementLines(sheet) {
  if (!sheet) return { repaired: 0, skipped: 0 };
  let repaired = 0;
  let skipped = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const mtid = String(row.getCell(8).value ?? "").trim().toLowerCase();
    const pos10 = row.getCell(10).value;
    const pos11 = row.getCell(11).value;
    const isDamaged =
      mtid === "auto" ||
      mtid === "manual" ||
      // Created_At for new rows lives at position 11. If position 11 is
      // empty but position 10 looks like a timestamp, the row is old.
      ((pos11 == null || pos11 === "") &&
        (pos10 instanceof Date ||
          /^\d{4}-\d{2}-\d{2}T/.test(String(pos10 ?? ""))));
    if (!isDamaged) {
      skipped++;
      return;
    }
    const v = [];
    for (let i = 1; i <= 10; i++) v.push(row.getCell(i).value);
    row.getCell(1).value = v[0]; // ID
    row.getCell(2).value = v[1]; // Statement_ID
    row.getCell(3).value = v[2]; // Line_Date
    row.getCell(4).value = v[3]; // Description
    row.getCell(5).value = v[4]; // Amount
    row.getCell(6).value = v[5]; // Balance_After
    row.getCell(7).value = v[6]; // Matched_TXN_ID
    row.getCell(8).value = null; // Matched_Transfer_ID (new)
    row.getCell(9).value = v[7]; // Match_Method
    row.getCell(10).value = v[8]; // Notes
    row.getCell(11).value = v[9]; // Created_At
    row.commit();
    repaired++;
  });
  return { repaired, skipped };
}

const awRes = repairAwaitingPayment(wb.getWorksheet("AwaitingPayment"));
const stRes = repairStatements(wb.getWorksheet("Statements"));
const slRes = repairStatementLines(wb.getWorksheet("StatementLines"));

console.log(
  `AwaitingPayment  repaired=${awRes.repaired}  skipped=${awRes.skipped}`,
);
console.log(
  `Statements       repaired=${stRes.repaired}  skipped=${stRes.skipped}`,
);
console.log(
  `StatementLines   repaired=${slRes.repaired}  skipped=${slRes.skipped}`,
);
console.log("");

if (DRY_RUN) {
  console.log("Dry run — workbook NOT written.");
  process.exit(0);
}

const backup = LEDGER_PATH.replace(
  /\.xlsx$/,
  `.pre-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`,
);
await fs.copyFile(LEDGER_PATH, backup);
console.log(`Backup: ${backup}`);
await wb.xlsx.writeFile(LEDGER_PATH);
console.log(`Repaired ledger written to: ${LEDGER_PATH}`);
