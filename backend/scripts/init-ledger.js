#!/usr/bin/env node
// Idempotently create the ledger workbook with default categories.
// Usage: npm run init-ledger
// Honors LEDGER_PATH env var (auto-loaded from backend/.env if present).

import { existsSync } from "node:fs";
import * as path from "node:path";

const BACKEND_DIR = path.resolve(import.meta.dirname, "..");
const ENV_PATH = path.join(BACKEND_DIR, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

// Default LEDGER_PATH is relative — resolve against backend/ so it works
// regardless of where the script is run from.
if (!process.env.LEDGER_PATH) {
  process.env.LEDGER_PATH = path.join(BACKEND_DIR, "companies", "default", "ledger.xlsx");
}

const { initLedger, getLedgerPath } = await import("../src/ledger/index.js");

const { created } = await initLedger();
console.log(created ? "Created" : "Already exists", "→", getLedgerPath());
