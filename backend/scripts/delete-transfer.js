// One-off targeted deletion of a Transfer row by id. Also clears any
// StatementLine.matched_transfer_id pointing at it (so the source
// statement line goes back to "unmatched"). Validates that the Transfer
// is not the only settling artifact on an awaiting-transfer — if it is,
// you'll be asked to confirm with --force.
//
// USAGE:
//   node scripts/delete-transfer.js <transfer_id> [--force]
//
// Reads LEDGER_PATH from backend/.env if present. Always backs up the
// workbook before mutating.

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ExcelJS from "exceljs";

const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const TRANSFER_ID = process.argv[2];
const FORCE = process.argv.includes("--force");

if (!TRANSFER_ID || TRANSFER_ID.startsWith("-")) {
  console.error("Usage: delete-transfer.js <transfer_id> [--force]");
  process.exit(1);
}

const { getLedgerPath } = await import("../src/ledger/index.js");
const LEDGER_PATH = await getLedgerPath();
if (!existsSync(LEDGER_PATH)) {
  console.error(`Ledger not found: ${LEDGER_PATH}`);
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(LEDGER_PATH);

// ── Find the Transfer row ───────────────────────────────────────────
const transfersSheet = wb.getWorksheet("Transfers");
if (!transfersSheet) {
  console.error("No Transfers sheet found.");
  process.exit(1);
}

let transferRowNumber = null;
let transferSnapshot = null;
transfersSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
  if (rowNumber === 1) return;
  const id = String(row.getCell(1).value ?? "").trim();
  if (id === TRANSFER_ID) {
    transferRowNumber = rowNumber;
    transferSnapshot = {
      id,
      date: row.getCell(2).value,
      amount: row.getCell(3).value,
      from_source: row.getCell(5).value,
      to_source: row.getCell(6).value,
      awaiting_id: row.getCell(9).value,
    };
  }
});

if (!transferRowNumber) {
  console.error(`Transfer not found: ${TRANSFER_ID}`);
  process.exit(1);
}

console.log("About to delete:");
console.log(`  id:           ${transferSnapshot.id}`);
console.log(`  date:         ${transferSnapshot.date}`);
console.log(`  amount:       ${transferSnapshot.amount}`);
console.log(`  from → to:    ${transferSnapshot.from_source} → ${transferSnapshot.to_source}`);
console.log(`  awaiting_id:  ${transferSnapshot.awaiting_id || "(none)"}`);
console.log("");

// ── Sanity: if this Transfer is linked to an awaiting that's now paid
//    SOLELY because of this Transfer, refuse without --force. ─────────
if (transferSnapshot.awaiting_id && !FORCE) {
  console.error(
    `This Transfer settles awaiting ${transferSnapshot.awaiting_id}. ` +
      `Re-run with --force to delete anyway (the awaiting will NOT be flipped back to 'awaiting' automatically — fix it by hand).`,
  );
  process.exit(1);
}

// ── Find StatementLines pointing at this Transfer ─────────────────────
const linesSheet = wb.getWorksheet("StatementLines");
const linesToUnlink = [];
if (linesSheet) {
  // Column for matched_transfer_id: position 8 per schema.js.
  linesSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const mtid = String(row.getCell(8).value ?? "").trim();
    if (mtid === TRANSFER_ID) {
      linesToUnlink.push({
        row,
        rowNumber,
        line_id: String(row.getCell(1).value ?? "").trim(),
      });
    }
  });
}
console.log(`Statement lines to unlink: ${linesToUnlink.length}`);
for (const l of linesToUnlink) {
  console.log(`  ${l.line_id} (row ${l.rowNumber})`);
}
console.log("");

// ── Apply: backup → mutate → save ─────────────────────────────────────
const backup = LEDGER_PATH.replace(
  /\.xlsx$/,
  `.pre-delete-transfer-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`,
);
await fs.copyFile(LEDGER_PATH, backup);
console.log(`Backup: ${backup}`);

for (const l of linesToUnlink) {
  l.row.getCell(8).value = null; // matched_transfer_id
  l.row.getCell(9).value = null; // match_method (best-effort: clear it too)
  l.row.commit();
}

transfersSheet.spliceRows(transferRowNumber, 1);

await wb.xlsx.writeFile(LEDGER_PATH);
console.log(`Deleted transfer ${TRANSFER_ID} from ${LEDGER_PATH}`);
