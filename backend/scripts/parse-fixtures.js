#!/usr/bin/env node
// Run the receipt parser against fixtures in backend/inbound-log/.
//
// Usage:
//   node scripts/parse-fixtures.js               # all fixtures
//   node scripts/parse-fixtures.js <filename>    # one fixture
//
// Requires ANTHROPIC_API_KEY — auto-loaded from backend/.env if present,
// otherwise must be set in the calling environment.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";

const BACKEND_DIR = path.resolve(import.meta.dirname, "..");
const ENV_PATH = path.join(BACKEND_DIR, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const { parseReceipt } = await import("../src/parser/index.js");
const { getCategories, getPaymentSources, getLedgerPath } = await import("../src/ledger/index.js");

const FIXTURE_DIR = path.join(BACKEND_DIR, "inbound-log");

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set. Export it from backend/.env first.");
    process.exit(1);
  }

  const arg = process.argv[2];
  const files = arg
    ? [arg]
    : (await fs.readdir(FIXTURE_DIR))
        .filter((f) => f.endsWith(".json") && !f.endsWith("-meta.json") && !f.endsWith("-parsed.json"))
        .sort();

  // Taxonomy comes from the ledger (auto-creates with seeded categories if missing).
  const [categories, paymentSources] = await Promise.all([
    getCategories(),
    getPaymentSources(),
  ]);
  console.log(
    `Ledger: ${getLedgerPath()} | categories=${categories.length} sources=${paymentSources.length}`,
  );

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;

  for (const filename of files) {
    const fullPath = path.isAbsolute(filename) ? filename : path.join(FIXTURE_DIR, filename);
    console.log("\n" + "=".repeat(72));
    console.log("FIXTURE:", path.basename(fullPath));
    console.log("=".repeat(72));

    let payload;
    try {
      payload = JSON.parse(await fs.readFile(fullPath, "utf-8"));
    } catch (err) {
      console.error("  Failed to read/parse:", err.message);
      continue;
    }

    const t0 = Date.now();
    try {
      const result = await parseReceipt(payload, { categories, paymentSources });
      const ms = Date.now() - t0;
      // Compact summary line
      const proposal = result.proposal;
      const vendor = proposal?.vendor?.name ?? null;
      const total = proposal?.total ? `${proposal.total.amount} ${proposal.total.currency}` : null;
      console.log(
        `→ ${result.status}` +
          (result.reason ? ` (${result.reason})` : "") +
          (vendor ? ` | ${vendor}` : "") +
          (total ? ` | ${total}` : "") +
          ` | ${ms}ms`,
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.usage) {
        totalIn += result.usage.input_tokens;
        totalOut += result.usage.output_tokens;
        totalCacheRead += result.usage.cache_read_input_tokens;
        totalCacheCreate += result.usage.cache_creation_input_tokens;
      }
    } catch (err) {
      console.error("  Parser threw:", err.message);
      if (err.rawText) console.error("  Raw model output (first 500):", err.rawText.slice(0, 500));
      if (err.response) console.error("  Response stop_reason:", err.response.stop_reason);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log("TOTAL USAGE");
  console.log("=".repeat(72));
  console.log(`  input_tokens:               ${totalIn}`);
  console.log(`  output_tokens:              ${totalOut}`);
  console.log(`  cache_read_input_tokens:    ${totalCacheRead}`);
  console.log(`  cache_creation_input_tokens: ${totalCacheCreate}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
