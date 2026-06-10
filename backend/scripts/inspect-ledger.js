#!/usr/bin/env node
// Dump the current state of every sheet in the ledger.
// Usage: npm run inspect-ledger

import { existsSync } from "node:fs";
import * as path from "node:path";

const BACKEND_DIR = path.resolve(import.meta.dirname, "..");
const ENV_PATH = path.join(BACKEND_DIR, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}
if (!process.env.LEDGER_PATH) {
  process.env.LEDGER_PATH = path.join(BACKEND_DIR, "companies", "default", "ledger.xlsx");
}

const {
  getLedgerPath,
  getCategories,
  getPaymentSources,
  listPending,
  listTransactions,
  listDocuments,
} = await import("../src/ledger/index.js");

console.log("Ledger:", getLedgerPath());
console.log();

const categories = await getCategories({ activeOnly: false });
console.log(`Categories (${categories.length}):`);
for (const c of categories) console.log(`  - ${c.name} [${c.type}]`);
console.log();

const sources = await getPaymentSources({ activeOnly: false });
console.log(`Payment sources (${sources.length}):`);
if (sources.length === 0) console.log("  (none — add via Excel)");
for (const s of sources) console.log(`  - ${s.name} ${s.last4 ? `••${s.last4}` : ""} [${s.type}]`);
console.log();

const pending = await listPending({ status: "all" });
console.log(`Pending entries (${pending.length}):`);
for (const p of pending) {
  console.log(
    `  - ${p.id} [${p.status}] ${p.vendor ?? "(no vendor)"} ` +
      `${p.total ? `${p.total} ${p.currency ?? ""}` : ""} ` +
      `→ ${p.suggested_category ?? "(no category)"}`,
  );
}
console.log();

const gl = await listTransactions();
console.log(`GL transactions (${gl.length}):`);
for (const t of gl) {
  const dateStr = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : t.date;
  console.log(`  - ${t.id} ${dateStr} ${t.vendor} ${t.amount} ${t.currency} → ${t.category}`);
}
console.log();

const docs = await listDocuments();
console.log(`Archived documents (${docs.length}):`);
for (const d of docs) {
  const dateStr = d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date ?? "(no date)";
  const ref = d.reference_number ? ` ${d.reference_kind ?? "?"}#${d.reference_number}` : "";
  console.log(`  - ${d.id} ${dateStr} ${d.vendor ?? "(no vendor)"}${ref} → ${d.document_path}`);
}
