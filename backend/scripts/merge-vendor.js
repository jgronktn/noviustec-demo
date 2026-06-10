// Merge two vendor names into one. Updates every ledger sheet that
// stores a vendor name plus rewrites archived document paths and moves
// the per-vendor document folder on disk.
//
// USAGE:
//   node scripts/merge-vendor.js --from "Anthropic" --to "Anthropic, PBC"
//   node scripts/merge-vendor.js --from "Anthropic" --to "Anthropic, PBC" --dry-run
//
// Optional: --company default   (defaults to NOVIUSTEC_COMPANY_ID or "default")
//
// SAFETY:
//   - Stop the API service before running. The script uses the in-process
//     write queue so it's safe relative to itself, but if the service
//     writes a row mid-script the workbook can lose data.
//   - Run --dry-run first to confirm the row counts.
//   - Vendor match is case-sensitive exact match — the script doesn't
//     guess what looks like an alias.

import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

// Load .env so LEDGER_PATH / NOVIUSTEC_COMPANIES_DIR / etc. line up with
// what the API service would see.
const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const { SHEETS } = await import("../src/ledger/schema.js");
const { withWorkbookWrite, getLedgerPath } = await import(
  "../src/ledger/workbook.js"
);
const { slugify, getCompaniesDir } = await import("../src/storage/documents.js");

function parseArgs(argv) {
  const args = { from: null, to: null, company: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--company") args.company = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!args.from || !args.to) {
    printUsage();
    process.exit(2);
  }
  args.company = args.company || process.env.NOVIUSTEC_COMPANY_ID || "default";
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/merge-vendor.js --from "<old>" --to "<new>" [--company <id>] [--dry-run]`);
}

const args = parseArgs(process.argv.slice(2));
const fromSlug = slugify(args.from);
const toSlug = slugify(args.to);

console.log(`Merging vendor: "${args.from}" → "${args.to}"`);
console.log(`  Slug: "${fromSlug}" → "${toSlug}"`);
console.log(`  Company: ${args.company}`);
console.log(`  Ledger:  ${getLedgerPath()}`);
console.log(`  Dry run: ${args.dryRun}`);
console.log("");

if (fromSlug === toSlug && args.from !== args.to) {
  console.warn(
    `WARNING: '${args.from}' and '${args.to}' slugify to the same value (${fromSlug}).`,
  );
  console.warn(
    "  Document folder won't move (already aligned). Ledger rows will still get renamed.",
  );
  console.warn("");
}

// ── Sheets and which columns to touch ───────────────────────────────────
// Each entry: sheet name, list of vendor-name column keys, list of
// document_path column keys (we rewrite the slug fragment inside them).
const TARGETS = [
  { sheet: SHEETS.PENDING, vendorKeys: ["vendor"], pathKeys: [] },
  {
    sheet: SHEETS.AWAITING,
    vendorKeys: ["vendor"],
    pathKeys: ["document_path"],
  },
  {
    sheet: SHEETS.GL,
    vendorKeys: ["vendor"],
    pathKeys: ["document_path"],
  },
  {
    sheet: SHEETS.DOCUMENTS,
    vendorKeys: ["vendor"],
    pathKeys: ["document_path"],
  },
];

const oldPathFragment = `documents/${fromSlug}/`;
const newPathFragment = `documents/${toSlug}/`;

function rewritePath(value) {
  if (typeof value !== "string") return null;
  if (!value.includes(oldPathFragment)) return null;
  return value.split(oldPathFragment).join(newPathFragment);
}

// ── Pass 1: in-memory dry-run scan to report counts before mutating ────
async function planChanges() {
  return withWorkbookWrite(async (wb) => {
    const summary = {};
    for (const target of TARGETS) {
      const sheet = wb.getWorksheet(target.sheet);
      if (!sheet) continue;
      let renamed = 0;
      let repathed = 0;
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        for (const key of target.vendorKeys) {
          const cell = row.getCell(key);
          if (cell.value === args.from) renamed++;
        }
        for (const key of target.pathKeys) {
          const cell = row.getCell(key);
          if (rewritePath(cell.value) != null) repathed++;
        }
      });
      summary[target.sheet] = { renamed, repathed };
    }
    return summary;
  });
}

// ── Pass 2: actually mutate + save ─────────────────────────────────────
async function applyChanges() {
  return withWorkbookWrite(async (wb) => {
    const summary = {};
    for (const target of TARGETS) {
      const sheet = wb.getWorksheet(target.sheet);
      if (!sheet) continue;
      let renamed = 0;
      let repathed = 0;
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        for (const key of target.vendorKeys) {
          const cell = row.getCell(key);
          if (cell.value === args.from) {
            cell.value = args.to;
            renamed++;
          }
        }
        for (const key of target.pathKeys) {
          const cell = row.getCell(key);
          const next = rewritePath(cell.value);
          if (next != null) {
            cell.value = next;
            repathed++;
          }
        }
        if (renamed || repathed) row.commit();
      });
      summary[target.sheet] = { renamed, repathed };
    }
    return summary;
  });
}

// ── File-system: move the per-vendor folder ────────────────────────────
async function moveDocumentFolder() {
  if (fromSlug === toSlug) {
    return { moved: 0, skipped: 0, note: "slug unchanged" };
  }
  const companyDocs = path.join(getCompaniesDir(), args.company, "documents");
  const fromDir = path.join(companyDocs, fromSlug);
  const toDir = path.join(companyDocs, toSlug);
  if (!existsSync(fromDir)) {
    return { moved: 0, skipped: 0, note: `${fromDir} not present` };
  }
  await fs.mkdir(toDir, { recursive: true });
  const entries = await fs.readdir(fromDir);
  let moved = 0;
  let skipped = 0;
  const skippedFiles = [];
  for (const name of entries) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    if (existsSync(dst)) {
      skipped++;
      skippedFiles.push(name);
      continue;
    }
    await fs.rename(src, dst);
    moved++;
  }
  // Remove source dir if empty.
  const remaining = await fs.readdir(fromDir).catch(() => []);
  if (remaining.length === 0) {
    await fs.rmdir(fromDir).catch(() => {});
  }
  return {
    moved,
    skipped,
    skippedFiles,
    note: `from=${fromDir} to=${toDir}`,
  };
}

// ── Run ────────────────────────────────────────────────────────────────
const plan = await planChanges();
console.log("Plan:");
for (const [sheet, counts] of Object.entries(plan)) {
  console.log(
    `  ${sheet.padEnd(20)} rename=${counts.renamed}  repath=${counts.repathed}`,
  );
}
console.log("");

if (args.dryRun) {
  console.log("Dry run — no changes applied.");
  process.exit(0);
}

const applied = await applyChanges();
console.log("Workbook updated:");
for (const [sheet, counts] of Object.entries(applied)) {
  console.log(
    `  ${sheet.padEnd(20)} renamed=${counts.renamed}  repathed=${counts.repathed}`,
  );
}

const folderResult = await moveDocumentFolder();
console.log("");
console.log("Document folder:");
console.log(`  moved=${folderResult.moved}  skipped=${folderResult.skipped}`);
if (folderResult.skippedFiles?.length > 0) {
  console.log(
    `  skipped (already present in destination): ${folderResult.skippedFiles.join(", ")}`,
  );
}
console.log(`  ${folderResult.note}`);
console.log("");
console.log("Done.");
