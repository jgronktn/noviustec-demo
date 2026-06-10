// Idempotently add any DEFAULT_CATEGORIES rows that are missing from
// the live ledger. Safe to re-run — addCategory() is a no-op on rows
// whose name already exists (case-insensitive match). Use this when
// schema.js grows a new seed category and existing ledgers need it
// backfilled.
//
// USAGE:
//   node scripts/ensure-categories.js
//
// Reads LEDGER_PATH from backend/.env if present.

import { existsSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_CATEGORIES } from "../src/ledger/schema.js";
import { addCategory } from "../src/ledger/index.js";

const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

let added = 0;
let kept = 0;
for (const c of DEFAULT_CATEGORIES) {
  const result = await addCategory(c);
  if (result.added) {
    console.log(`  + ${result.name}`);
    added++;
  } else {
    kept++;
  }
}
console.log("");
console.log(`Added: ${added}   Already present: ${kept}`);
