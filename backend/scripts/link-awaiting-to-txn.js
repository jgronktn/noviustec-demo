// Retroactively link an AwaitingPayment row to an existing GL transaction.
//
// USE CASE: You wrote a check / paid by card / bought something *before*
// any invoice existed in the system, so the payment was booked to GL on
// its own (typically with reference_kind=confirmation / transaction). The
// vendor's invoice arrives later, you upload it, the parser saves it to
// AwaitingPayment — but now the books show the same money in both places.
//
// This script flips the awaiting row to status=paid, sets its paid_txn_id
// to the GL row you already have, and cross-links the invoice's archived
// PDF (Documents row) to the same transaction. After running, the
// timeline pairs the two as an invoice → payment relationship and the
// per-side totals reconcile.
//
// USAGE:
//   node scripts/link-awaiting-to-txn.js --awaiting apw_xxxxxxxx --txn txn_xxxxxxxx
//   node scripts/link-awaiting-to-txn.js --awaiting apw_xxxxxxxx --txn txn_xxxxxxxx --dry-run
//
// SAFETY: stop the API service first (`sudo systemctl stop noviustec-api`)
// so the script's writes don't race the in-process write queue inside the
// service. Restart after.

import { existsSync } from "node:fs";
import * as path from "node:path";

const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const {
  getAwaiting,
  getTransaction,
  markAwaitingPaid,
  attachDocumentsToTransaction,
  listDocuments,
} = await import("../src/ledger/index.js");

function parseArgs(argv) {
  const args = { awaiting: null, txn: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--awaiting") args.awaiting = argv[++i];
    else if (a === "--txn") args.txn = argv[++i];
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
  if (!args.awaiting || !args.txn) {
    printUsage();
    process.exit(2);
  }
  return args;
}

function printUsage() {
  console.log(
    `Usage: node scripts/link-awaiting-to-txn.js --awaiting <apw_id> --txn <txn_id> [--dry-run]`,
  );
}

function fmtAmount(n, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(n);
}

const args = parseArgs(process.argv.slice(2));

const aw = await getAwaiting(args.awaiting);
if (!aw) {
  console.error(`AwaitingPayment row not found: ${args.awaiting}`);
  process.exit(1);
}
const txn = await getTransaction(args.txn);
if (!txn) {
  console.error(`GL transaction not found: ${args.txn}`);
  process.exit(1);
}

console.log("Linking awaiting → transaction:");
console.log(
  `  awaiting  ${aw.id}  vendor="${aw.vendor}"  date=${String(aw.date).slice(0, 10)}  amount=${fmtAmount(aw.amount, aw.currency)}  status=${aw.status}`,
);
console.log(
  `  txn       ${txn.id}  vendor="${txn.vendor}"  date=${String(txn.date).slice(0, 10)}  amount=${fmtAmount(txn.amount, txn.currency)}  ref_kind=${txn.reference_kind}`,
);
console.log("");

// Sanity checks — these aren't fatal but worth printing so the operator
// can bail out if they don't match.
const awAmount = Number(aw.amount);
const txnAmount = Number(txn.amount);
if (Math.abs(awAmount - txnAmount) > 0.01) {
  console.warn(
    `WARNING: amounts differ — awaiting=${awAmount} vs txn=${txnAmount}. Continuing anyway.`,
  );
}
if (
  (aw.vendor || "").toLowerCase().trim() !==
  (txn.vendor || "").toLowerCase().trim()
) {
  console.warn(
    `WARNING: vendor names differ — "${aw.vendor}" vs "${txn.vendor}". Continuing anyway.`,
  );
}
if (aw.status !== "awaiting") {
  console.warn(
    `WARNING: awaiting status is "${aw.status}", not "awaiting". Continuing anyway.`,
  );
}

// What documents will be cross-linked?
const docs = await listDocuments({});
const awaitingDocs = docs.filter((d) => d.awaiting_id === aw.id && !d.txn_id);
console.log(
  `Documents currently tied to ${aw.id} with no txn_id: ${awaitingDocs.length}`,
);
for (const d of awaitingDocs) {
  console.log(
    `  - ${d.id}  ${d.filename}  (kind=${d.reference_kind})  → will get txn_id=${txn.id}`,
  );
}
console.log("");

if (args.dryRun) {
  console.log("Dry run — no changes applied.");
  process.exit(0);
}

await markAwaitingPaid(aw.id, { paid_txn_id: txn.id });
console.log(`AwaitingPayment ${aw.id} → status=paid  paid_txn_id=${txn.id}`);

const { updated } = await attachDocumentsToTransaction({
  awaiting_id: aw.id,
  txn_id: txn.id,
});
console.log(`Documents updated with txn_id=${txn.id}: ${updated}`);

console.log("");
console.log("Done.");
