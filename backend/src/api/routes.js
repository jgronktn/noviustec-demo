// /api/* routes, registered as a Fastify plugin.
//
// All routes in this plugin are gated by a bearer-token preHandler. The
// /webhooks/* and /health endpoints stay open because they live in the
// parent (server.js) scope — Fastify hooks are scoped to the plugin they
// were registered in.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  getCategories,
  getPaymentSources,
  ensurePaymentSource,
  listPending,
  getPending,
  deletePending,
  updatePendingStatus,
  updatePendingFromParse,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  listTransactions,
  updateAwaiting,
  getLedgerPath,
  resetLedger,
  getDocument,
  getKnownVendors,
  addStatement,
  getStatement,
  listStatements,
  updateStatementLine,
  listStatementLines,
  listDocuments,
} from "../ledger/index.js";
import { parseReceipt } from "../parser/index.js";
import {
  processReceiptPayload,
  buildUploadPayload,
  SUPPORTED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
} from "../processor.js";
import {
  archiveAttachments,
  resolveDocumentPath,
  archiveStatement,
  resolveStatementPath,
} from "../storage/documents.js";
import { parseStatement } from "../parser/statement/index.js";
import {
  getTransaction,
  addDocument,
  attachDocumentsToTransaction,
  addAwaitingPayment,
  listAwaiting,
  getAwaiting,
  markAwaitingPaid,
  markAwaitingWrittenOff,
  findMatchCandidates,
  addTransfer,
  listTransfers,
  getTransfer,
  updateTransfer,
} from "../ledger/index.js";
import { runAgent } from "../agent/loop.js";
import { buildTimelineProps } from "../agent/handlers.js";
import {
  autoMatchStatement,
  buildReconciliationView,
} from "../reconciliation/index.js";

// Hardcoded for single-tenant v1. Eventually derived from authenticated session.
const COMPANY_ID = process.env.NOVIUSTEC_COMPANY_ID || "default";
const COMPANY_NAME = process.env.NOVIUSTEC_COMPANY_NAME || "Noviustec";

const MIME_BY_EXT = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const VIEWABLE_MIMES = new Set(Object.values(MIME_BY_EXT));

function pickFirstViewableAttachment(attachments) {
  if (!Array.isArray(attachments)) return null;
  const supported = attachments.filter((a) => {
    if (typeof a?.ContentType !== "string" || typeof a?.Content !== "string") return false;
    const ct = a.ContentType.toLowerCase().split(";")[0].trim();
    return VIEWABLE_MIMES.has(ct);
  });
  if (supported.length === 0) return null;
  const pdfs = supported.filter((a) => a.ContentType.toLowerCase().startsWith("application/pdf"));
  const pool = pdfs.length > 0 ? pdfs : supported;
  pool.sort((a, b) => (b.ContentLength ?? 0) - (a.ContentLength ?? 0));
  return pool[0];
}

function sanitizeForHeader(name) {
  if (!name) return "document";
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

function serializeArchivedDoc(r) {
  return {
    filename: r.filename,
    original_filename: r.original_filename,
    reference_kind: r.reference_kind,
    reference_number: r.reference_number,
    document_path: r.document_path,
  };
}

// Read at module load. Updates require service restart, which is fine —
// systemd loads .env via EnvironmentFile= and restart picks up changes.
const API_TOKEN = process.env.NOVIUSTEC_API_TOKEN || null;

// Kept in sync with the CORS config in server.js. The SSE handler hijacks
// the response (so @fastify/cors's onSend hook is bypassed), so we have to
// echo the same Access-Control-Allow-Origin header manually for the
// browser to accept the streamed response.
const ALLOWED_ORIGINS = new Set([
  "https://demo.noviustec.com",
  "http://localhost:5500",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function corsHeadersFor(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

/**
 * Initial Statement.status when a statement is imported. Four outcomes:
 *   - "needs_attention" — parser flagged a balance-check mismatch
 *     (opening + charges - payments != closing within tolerance).
 *   - "reconciled"     — the statement has NO activity worth matching
 *     (zero lines AND zero total charges AND zero total payments). A
 *     no-activity month has nothing to pair against the GL, so it's
 *     already as reconciled as it can be.
 *   - "imported"       — the default. Lines exist and need matching.
 */
function deriveInitialStatementStatus({ validation, ext }) {
  if (validation?.balance_check === "mismatch") return "needs_attention";
  const lineCount = Array.isArray(ext.lines) ? ext.lines.length : 0;
  const charges = Math.abs(Number(ext.balances?.total_charges) || 0);
  const payments = Math.abs(Number(ext.balances?.total_payments) || 0);
  if (lineCount === 0 && charges < 0.01 && payments < 0.01) return "reconciled";
  return "imported";
}

// Last-4 sniffer used by the auto-link heuristic in mark-as-transfer.
// Matches "••XXXX", "•XXXX", "**XXXX", "XX-XXXX" — same shape as the
// reconciliation module's matcher.
function extractLast4(s) {
  if (!s) return null;
  const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
  return m ? m[1] : null;
}

function sameAccountName(a, b) {
  if (!a || !b) return false;
  const aa = String(a).toLowerCase().trim();
  const bb = String(b).toLowerCase().trim();
  if (aa === bb) return true;
  const la = extractLast4(a);
  const lb = extractLast4(b);
  return !!(la && lb && la === lb);
}

/**
 * Brute-force subset-sum: return the unique subset of `items` whose
 * `amount` totals `target` within `tolerance`. Returns null when zero
 * subsets match OR when more than one does (ambiguous → caller must
 * not auto-resolve). Refuses to enumerate when N > 16 (65 K subsets
 * is fine, much more is wasted CPU on the request path).
 */
function findUniqueSubsetSummingTo(items, target, tolerance = 0.01) {
  const N = items.length;
  if (N === 0 || N > 16) return null;
  let foundMask = -1;
  for (let mask = 1; mask < 1 << N; mask++) {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) sum += Number(items[i].amount);
    }
    if (Math.abs(sum - target) <= tolerance) {
      if (foundMask !== -1) return null; // ambiguous: multiple subsets sum
      foundMask = mask;
    }
  }
  if (foundMask === -1) return null;
  const out = [];
  for (let i = 0; i < N; i++) {
    if (foundMask & (1 << i)) out.push(items[i]);
  }
  return out;
}

/**
 * For an awaiting, find the next-period statement on the same source so
 * we can compute the overpayment upper bound. The "next" statement is
 * the one whose period starts at or after the awaiting's originating
 * statement's period_end. Returns the statement row or null.
 */
async function findNextStatementForAwaiting(awaiting, allStatements) {
  if (!awaiting?.statement_id) return null;
  const origin = allStatements.find((s) => s.id === awaiting.statement_id);
  if (!origin) return null;
  const originEnd = origin.period_end ? new Date(origin.period_end) : null;
  if (!originEnd) return null;
  const after = allStatements
    .filter(
      (s) =>
        s.id !== origin.id &&
        sameAccountName(s.source, origin.source) &&
        s.period_start &&
        new Date(s.period_start) >= originEnd,
    )
    .sort(
      (a, b) => new Date(a.period_start) - new Date(b.period_start),
    );
  return after[0] ?? null;
}

/**
 * Find the unique outstanding awaiting-transfer that the given Transfer
 * would settle. Two-pass match:
 *
 *   Pass A — EXACT subset-sum. Any unique subset of unlinked Transfers
 *   (each paying INTO the awaiting's vendor) summing to the awaiting's
 *   amount within $0.01.
 *
 *   Pass B — OVERPAYMENT within the carry-forward window. Single
 *   Transfer (subset size 1) whose amount is in [awaiting.amount,
 *   awaiting.amount + nextStatement.total_charges + $0.01]. Models the
 *   common "paid the statement closing balance + a bit toward new
 *   charges that accrued since the statement date" pattern. The
 *   overshoot is implicitly carried forward by the next statement's
 *   opening balance — already reflected in the data, we just need to
 *   acknowledge the settlement.
 *
 * The new Transfer must be part of the winning match for either pass.
 * Returns { awaiting, subset, mode, overpayment } or null. Ambiguous
 * matches (multiple awaitings or multiple subsets) → null.
 */
function findAutoLinkSubset({
  newTransfer,
  unlinkedTransfers,
  outstandingAwaitings,
  nextStatementByAwaitingId,
}) {
  const candidateAwaitings = outstandingAwaitings.filter(
    (aw) => (aw.payment_kind || "expense") === "transfer",
  );
  // Pass A — exact subset-sum.
  const exactWinners = [];
  for (const aw of candidateAwaitings) {
    const eligible = unlinkedTransfers.filter((t) =>
      sameAccountName(t.to_source, aw.vendor),
    );
    if (eligible.length === 0) continue;
    const target = Math.abs(Number(aw.amount));
    const subset = findUniqueSubsetSummingTo(eligible, target, 0.01);
    if (!subset) continue;
    if (!subset.some((t) => t.id === newTransfer.id)) continue;
    exactWinners.push({ awaiting: aw, subset, mode: "exact" });
    if (exactWinners.length > 1) return null;
  }
  if (exactWinners.length === 1) return exactWinners[0];

  // Pass B — single-transfer overpayment within carry-forward window.
  const overpayWinners = [];
  for (const aw of candidateAwaitings) {
    if (!sameAccountName(newTransfer.to_source, aw.vendor)) continue;
    const awAmount = Math.abs(Number(aw.amount));
    const trAmount = Math.abs(Number(newTransfer.amount));
    if (trAmount < awAmount) continue;
    const nextStmt = nextStatementByAwaitingId.get(aw.id);
    if (!nextStmt) continue;
    const nextCharges = Number(nextStmt.total_charges);
    if (!Number.isFinite(nextCharges) || nextCharges < 0) continue;
    const upperBound = awAmount + nextCharges;
    if (trAmount > upperBound + 0.01) continue;
    overpayWinners.push({
      awaiting: aw,
      subset: [newTransfer],
      mode: "overpayment",
      overpayment: Math.round((trAmount - awAmount) * 100) / 100,
      next_statement_id: nextStmt.id,
    });
    if (overpayWinners.length > 1) return null;
  }
  return overpayWinners.length === 1 ? overpayWinners[0] : null;
}

export default async function apiRoutes(fastify, opts) {
  const logDir = opts.logDir;

  // ─────────────────────────────────────────────────────────────────────────
  // Auth gate: bearer token check for every /api/* route in this plugin.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.addHook("preHandler", async (req, reply) => {
    if (!API_TOKEN) {
      reply.code(503).send({
        error: "NOVIUSTEC_API_TOKEN not configured on server",
      });
      return reply;
    }
    const header = req.headers.authorization || "";
    const m = header.match(/^Bearer\s+(.+)$/);
    if (!m || m[1] !== API_TOKEN) {
      reply.code(401).send({ error: "Unauthorized" });
      return reply;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/admin/reset — DESTRUCTIVE factory reset (demo only).
  // Wipes the ledger (transactions, pending, awaiting, statements, document
  // metadata), every archived document/statement file, AND the inbound-log,
  // then recreates an empty, seeded ledger. Gated behind ENABLE_DEMO_RESET so
  // it can never fire on a deployment that hasn't explicitly opted in.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post("/api/admin/reset", async (req, reply) => {
    if (process.env.ENABLE_DEMO_RESET !== "1") {
      return reply.code(403).send({
        error:
          "Reset is disabled on this server. Set ENABLE_DEMO_RESET=1 in the backend .env to enable it.",
      });
    }

    // Wipe + recreate the ledger and its archived document/statement files.
    const result = await resetLedger();

    // Clear the inbound-log dir (saved Postmark payloads + parsed sidecars),
    // leaving the directory itself in place.
    let logsCleared = 0;
    try {
      const files = await fs.readdir(logDir);
      await Promise.all(
        files.map((f) =>
          fs
            .rm(path.join(logDir, f), { recursive: true, force: true })
            .then(() => {
              logsCleared += 1;
            }),
        ),
      );
    } catch (err) {
      req.log.error({ err }, "reset: failed clearing inbound-log");
    }

    req.log.warn(
      { logs_cleared: logsCleared, recreated: result.recreated },
      "DEMO FACTORY RESET performed — all data wiped",
    );
    return { ok: true, logs_cleared: logsCleared };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/inbox — raw Postmark payload listing (kept from earlier).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/inbox", async () => {
    const files = await fs.readdir(logDir);
    const entries = await Promise.all(
      files
        .filter(
          (f) =>
            f.endsWith(".json") &&
            !f.endsWith("-meta.json") &&
            !f.endsWith("-parsed.json"),
        )
        .map(async (filename) => {
          const filepath = path.join(logDir, filename);
          const stat = await fs.stat(filepath);
          const content = await fs.readFile(filepath, "utf-8");
          const data = JSON.parse(content);
          return {
            filename,
            received_at: stat.mtime.toISOString(),
            from: data.From,
            subject: data.Subject,
            attachment_count: data.Attachments?.length ?? 0,
            size_bytes: stat.size,
          };
        }),
    );
    entries.sort((a, b) => b.received_at.localeCompare(a.received_at));
    return { count: entries.length, emails: entries };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/categories — for UI dropdowns.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/categories",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            include_archived: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req) => {
      const categories = await getCategories({ activeOnly: !req.query.include_archived });
      return { count: categories.length, categories };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/sources — for UI dropdowns.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/sources",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            include_archived: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req) => {
      const sources = await getPaymentSources({ activeOnly: !req.query.include_archived });
      return { count: sources.length, sources };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/pending — list pending entries. Default: status=pending.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/pending",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: [
                "active",
                "processing",
                "pending",
                "failed",
                "approved",
                "rejected",
                "all",
              ],
              default: "pending",
            },
          },
        },
      },
    },
    async (req) => {
      const entries = await listPending({ status: req.query.status });
      return { count: entries.length, entries };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/pending/:id — single row + the full proposal from its sidecar,
  // plus suggested_action and match_candidates for the awaiting workflow.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/pending/:id", async (req, reply) => {
    const row = await getPending(req.params.id);
    if (!row) return reply.code(404).send({ error: "Pending entry not found" });

    let proposal = null;
    if (row.source_file) {
      const parsedName = row.source_file.replace(/\.json$/, "-parsed.json");
      const parsedPath = path.join(logDir, parsedName);
      try {
        const text = await fs.readFile(parsedPath, "utf-8");
        proposal = JSON.parse(text);
      } catch {
        proposal = null; // sidecar missing or unreadable
      }
    }

    // Suggest workflow action + surface match candidates for the awaiting flow.
    // The LLM's reference_kind drives the default; the user can override.
    const llmKind = proposal?.proposal?.reference_number?.kind ?? row.reference_kind ?? null;
    let match_candidates = [];
    if (row.vendor && row.total != null) {
      match_candidates = await findMatchCandidates({ vendor: row.vendor, total: row.total });
    }
    let suggested_action;
    if (match_candidates.length > 0) {
      // A receipt-like entry where we already have an awaiting invoice. Suggest match.
      suggested_action = "match";
    } else if (llmKind === "invoice") {
      // Invoice with no prior awaiting → save as awaiting payment.
      suggested_action = "to_awaiting";
    } else {
      suggested_action = "to_gl";
    }

    return { ...row, proposal, suggested_action, match_candidates };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/pending/:id — remove a pending entry from the inbox (used to
  // dismiss a failed/processing row). Approved entries are protected: they're
  // already booked to the GL, so deleting the inbox record would orphan that
  // history — reject with 409.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.delete("/api/pending/:id", async (req, reply) => {
    const { id } = req.params;
    const row = await getPending(id);
    if (!row) {
      return reply.code(404).send({ error: "Pending entry not found" });
    }
    if (row.status === "approved") {
      return reply.code(409).send({
        error: "Cannot remove an approved entry — it's already booked to the ledger.",
      });
    }
    await deletePending(id);
    return { ok: true, id, deleted: true };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/pending/:id/approve — writes to GL, marks pending approved.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/pending/:id/approve",
    {
      schema: {
        body: {
          type: "object",
          required: ["vendor", "date", "total", "category"],
          additionalProperties: false,
          properties: {
            vendor: { type: "string", minLength: 1 },
            date: { type: "string" }, // YYYY-MM-DD
            total: { type: "number" },
            currency: { type: "string", default: "USD" },
            category: { type: "string", minLength: 1 },
            payment_source: { type: ["string", "null"], default: null },
            reference_number: { type: ["string", "null"], default: null },
            reference_kind: {
              type: ["string", "null"],
              enum: ["invoice", "receipt", "order", "transaction", "confirmation", "other", null],
              default: null,
            },
            description: { type: "string", default: "" },
            notes: { type: "string", default: "" },
            action: {
              type: "string",
              enum: ["to_gl", "to_awaiting", "match"],
              default: "to_gl",
            },
            match_id: { type: ["string", "null"], default: null },
          },
        },
      },
    },
    async (req, reply) => {
      const row = await getPending(req.params.id);
      if (!row) return reply.code(404).send({ error: "Pending entry not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `Cannot approve a ${row.status} entry` });
      }

      const action = req.body.action ?? "to_gl";

      if (action === "match" && !req.body.match_id) {
        return reply.code(400).send({ error: "match_id required when action=match" });
      }

      // Archive every viewable PDF/image (could be multiple — Anthropic
      // emails ship Invoice+Receipt for the same charge). The first
      // record returned is the primary doc (largest; usually the one
      // matching the parser's reference). GL's document_path points
      // to it; full archive list lives in the Documents sheet.
      const reference = req.body.reference_number
        ? { value: req.body.reference_number, kind: req.body.reference_kind ?? "other" }
        : null;
      let archivedDocs = [];
      try {
        archivedDocs = await archiveAttachments({
          companyId: COMPANY_ID,
          logDir,
          sourceFile: row.source_file,
          vendor: req.body.vendor,
          date: req.body.date,
          reference,
          pendingId: row.id,
        });
      } catch (err) {
        req.log.error({ err, pending_id: row.id }, "document archive failed; proceeding anyway");
      }
      const primary = archivedDocs[0] ?? null;

      // ─── Branch 1: save as AwaitingPayment, no GL row ────────────────────
      if (action === "to_awaiting") {
        const { id: awaitingId } = await addAwaitingPayment({
          vendor: req.body.vendor,
          date: req.body.date,
          amount: req.body.total,
          currency: req.body.currency ?? "USD",
          reference_number: req.body.reference_number ?? null,
          reference_kind: req.body.reference_kind ?? null,
          description: req.body.description ?? "",
          notes: req.body.notes ?? "",
          document_path: primary?.document_path ?? null,
          source_file: row.source_file,
          pending_id: row.id,
        });

        const docIds = [];
        for (const rec of archivedDocs) {
          try {
            const { id } = await addDocument({
              vendor: req.body.vendor,
              date: req.body.date,
              reference_kind: rec.reference_kind,
              reference_number: rec.reference_number,
              filename: rec.filename,
              original_filename: rec.original_filename,
              document_path: rec.document_path,
              txn_id: null,
              awaiting_id: awaitingId,
              pending_id: row.id,
            });
            docIds.push(id);
          } catch (err) {
            req.log.error({ err, file: rec.filename }, "failed to write Documents row");
          }
        }

        await updatePendingStatus(row.id, {
          status: "approved",
          resolution_notes: `→ ${awaitingId} (awaiting payment)`,
        });

        req.log.info(
          {
            pending_id: row.id,
            awaiting_id: awaitingId,
            action: "to_awaiting",
            vendor: req.body.vendor,
            total: req.body.total,
            reference_number: req.body.reference_number ?? null,
            documents_archived: archivedDocs.length,
            document_ids: docIds,
          },
          "pending approved as awaiting payment",
        );

        return {
          pending_id: row.id,
          awaiting_id: awaitingId,
          action: "to_awaiting",
          document_path: primary?.document_path ?? null,
          documents: archivedDocs.map(serializeArchivedDoc),
        };
      }

      // ─── Branch 2: match a receipt to an existing AwaitingPayment ─────────
      if (action === "match") {
        const awaiting = await getAwaiting(req.body.match_id);
        if (!awaiting) {
          return reply.code(404).send({ error: `AwaitingPayment row not found: ${req.body.match_id}` });
        }
        if (awaiting.status !== "awaiting") {
          return reply
            .code(409)
            .send({ error: `Cannot match to AwaitingPayment with status=${awaiting.status}` });
        }

        const { id: transactionId } = await addTransaction({
          vendor: req.body.vendor,
          date: req.body.date,
          amount: req.body.total,
          currency: req.body.currency ?? "USD",
          category: req.body.category,
          payment_source: req.body.payment_source ?? null,
          reference_number: req.body.reference_number ?? null,
          reference_kind: req.body.reference_kind ?? null,
          document_path: primary?.document_path ?? awaiting.document_path ?? null,
          description: req.body.description ?? "",
          notes: req.body.notes ?? "",
          source_file: row.source_file,
          pending_id: row.id,
          created_by: "user",
        });

        // Backfill the AwaitingPayment row → paid, link to the new GL txn.
        await markAwaitingPaid(req.body.match_id, { paid_txn_id: transactionId });

        // Backfill Documents rows that were originally linked only to the
        // awaiting row (the invoice PDFs) — now they're also part of this txn.
        await attachDocumentsToTransaction({
          awaiting_id: req.body.match_id,
          txn_id: transactionId,
        });

        // Plus: write Documents rows for THIS pending's archives (the receipt).
        const docIds = [];
        for (const rec of archivedDocs) {
          try {
            const { id } = await addDocument({
              vendor: req.body.vendor,
              date: req.body.date,
              reference_kind: rec.reference_kind,
              reference_number: rec.reference_number,
              filename: rec.filename,
              original_filename: rec.original_filename,
              document_path: rec.document_path,
              txn_id: transactionId,
              awaiting_id: req.body.match_id,
              pending_id: row.id,
            });
            docIds.push(id);
          } catch (err) {
            req.log.error({ err, file: rec.filename }, "failed to write Documents row");
          }
        }

        await updatePendingStatus(row.id, {
          status: "approved",
          resolution_notes: `→ ${transactionId} (matched ${req.body.match_id})`,
        });

        req.log.info(
          {
            pending_id: row.id,
            transaction_id: transactionId,
            matched_awaiting_id: req.body.match_id,
            action: "match",
            vendor: req.body.vendor,
            total: req.body.total,
            documents_archived: archivedDocs.length,
            document_ids: docIds,
          },
          "pending approved by matching to awaiting payment",
        );

        return {
          pending_id: row.id,
          transaction_id: transactionId,
          matched_awaiting_id: req.body.match_id,
          action: "match",
          document_path: primary?.document_path ?? null,
          documents: archivedDocs.map(serializeArchivedDoc),
        };
      }

      // ─── Branch 3: default — straight to GL (current behavior) ────────────
      const { id: transactionId } = await addTransaction({
        vendor: req.body.vendor,
        date: req.body.date,
        amount: req.body.total,
        currency: req.body.currency ?? "USD",
        category: req.body.category,
        payment_source: req.body.payment_source ?? null,
        reference_number: req.body.reference_number ?? null,
        reference_kind: req.body.reference_kind ?? null,
        document_path: primary?.document_path ?? null,
        description: req.body.description ?? "",
        notes: req.body.notes ?? "",
        source_file: row.source_file,
        pending_id: row.id,
        created_by: "user",
      });

      const docIds = [];
      for (const rec of archivedDocs) {
        try {
          const { id } = await addDocument({
            vendor: req.body.vendor,
            date: req.body.date,
            reference_kind: rec.reference_kind,
            reference_number: rec.reference_number,
            filename: rec.filename,
            original_filename: rec.original_filename,
            document_path: rec.document_path,
            txn_id: transactionId,
            pending_id: row.id,
          });
          docIds.push(id);
        } catch (err) {
          req.log.error({ err, file: rec.filename }, "failed to write Documents row");
        }
      }

      await updatePendingStatus(row.id, {
        status: "approved",
        resolution_notes: `→ ${transactionId}`,
      });

      req.log.info(
        {
          pending_id: row.id,
          transaction_id: transactionId,
          action: "to_gl",
          vendor: req.body.vendor,
          total: req.body.total,
          reference_number: req.body.reference_number ?? null,
          documents_archived: archivedDocs.length,
          document_ids: docIds,
          primary_document_path: primary?.document_path ?? null,
        },
        "pending approved",
      );

      return {
        pending_id: row.id,
        transaction_id: transactionId,
        action: "to_gl",
        document_path: primary?.document_path ?? null,
        documents: archivedDocs.map(serializeArchivedDoc),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/awaiting — list AwaitingPayment rows.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/awaiting",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["awaiting", "paid", "written_off", "rejected", "all"],
              default: "awaiting",
            },
            vendor: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      let entries = await listAwaiting({ status: req.query.status });
      if (req.query.vendor) {
        entries = entries.filter((r) => r.vendor === req.query.vendor);
      }
      return { count: entries.length, entries };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/awaiting/:id/pay-transfer — settle an awaiting-transfer
  // row (e.g. a credit-card balance) by recording a money movement
  // between two of your own accounts. Creates a Transfer row and marks
  // the awaiting paid (paid_transfer_id set, status=paid). Validated
  // against payment_kind="transfer" — refuses to settle an expense
  // awaiting via this path.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/awaiting/:id/pay-transfer",
    {
      schema: {
        body: {
          type: "object",
          required: ["date", "from_source"],
          additionalProperties: false,
          properties: {
            date: { type: "string" }, // YYYY-MM-DD, transfer date
            from_source: { type: "string", minLength: 1 },
            notes: { type: "string", default: "" },
            description: { type: "string", default: "" },
          },
        },
      },
    },
    async (req, reply) => {
      const awaiting = await getAwaiting(req.params.id);
      if (!awaiting) {
        return reply.code(404).send({ error: "AwaitingPayment row not found" });
      }
      if (awaiting.status !== "awaiting") {
        return reply
          .code(409)
          .send({ error: `Cannot pay an awaiting with status=${awaiting.status}` });
      }
      // Legacy rows (no payment_kind set) default to "expense". Refuse to
      // settle them via the transfer path — caller should use /pay.
      const kind = awaiting.payment_kind || "expense";
      if (kind !== "transfer") {
        return reply.code(400).send({
          error: `Awaiting payment_kind is ${kind}; use /pay for expense settlements`,
        });
      }

      // Register the from_source in the Sources sheet on first use.
      const { name: canonicalFrom } = await ensurePaymentSource(req.body.from_source);
      // to_source is the awaiting's vendor (the account it's owed against
      // — for a card balance, that's the card account).
      const toSource = awaiting.vendor;
      try {
        if (toSource) await ensurePaymentSource(toSource);
      } catch {
        /* best-effort */
      }

      const { id: transferId } = await addTransfer({
        date: req.body.date,
        amount: awaiting.amount,
        currency: awaiting.currency ?? "USD",
        from_source: canonicalFrom || req.body.from_source,
        to_source: toSource,
        description:
          req.body.description ||
          `Payment of ${awaiting.vendor ?? "card"} balance`,
        notes: req.body.notes ?? "",
        awaiting_id: awaiting.id,
        created_by: "user",
      });

      await markAwaitingPaid(awaiting.id, { paid_transfer_id: transferId });

      req.log.info(
        {
          awaiting_id: awaiting.id,
          transfer_id: transferId,
          action: "pay_transfer",
          from_source: canonicalFrom || req.body.from_source,
          to_source: toSource,
          amount: awaiting.amount,
        },
        "awaiting-transfer settled",
      );

      return {
        awaiting_id: awaiting.id,
        transfer_id: transferId,
        action: "pay_transfer",
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/awaiting/:id — single AwaitingPayment row.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/awaiting/:id", async (req, reply) => {
    const row = await getAwaiting(req.params.id);
    if (!row) return reply.code(404).send({ error: "AwaitingPayment row not found" });
    return row;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/transactions — create a GL row from an agent-proposed
  // draft AFTER the user clicks Approve in TransactionDraftPanel. This
  // is the ONE write path for the propose-then-approve flow: the agent
  // never calls this; the frontend panel does, in response to a human
  // click.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/transactions",
    {
      schema: {
        body: {
          type: "object",
          required: ["vendor", "amount", "date", "category"],
          additionalProperties: false,
          properties: {
            vendor: { type: "string", minLength: 1 },
            amount: { type: "number" }, // positive expense amount
            date: { type: "string", minLength: 1 }, // YYYY-MM-DD
            category: { type: "string", minLength: 1 },
            payment_source: { type: "string" },
            currency: { type: "string", default: "USD" },
            reference_number: { type: "string" },
            reference_kind: { type: "string" }, // check | card | ach | wire | cash | other
            description: { type: "string" },
            notes: { type: "string" },
            // "expense" (default — money out) or "income" (deposit).
            entry_type: { type: "string", enum: ["expense", "income"] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        // If a payment_source was given, register it (so it shows in
        // future Sources dropdowns even if it's a brand-new account).
        let canonicalSource = req.body.payment_source || null;
        if (canonicalSource) {
          try {
            const { name } = await ensurePaymentSource(canonicalSource);
            if (name) canonicalSource = name;
          } catch (err) {
            req.log.error(
              { err: err.message },
              "ensurePaymentSource failed on agent-proposed txn; continuing",
            );
          }
        }
        const { id: transactionId } = await addTransaction({
          date: req.body.date,
          vendor: req.body.vendor,
          description: req.body.description || "",
          category: req.body.category,
          payment_source: canonicalSource,
          amount: Math.abs(Number(req.body.amount)),
          currency: req.body.currency || "USD",
          reference_number: req.body.reference_number || null,
          reference_kind: req.body.reference_kind || null,
          notes: req.body.notes || "",
          entry_type:
            req.body.entry_type === "income" ? "income" : "expense",
          created_by: "agent-proposal",
        });
        req.log.info(
          {
            transaction_id: transactionId,
            vendor: req.body.vendor,
            amount: req.body.amount,
            category: req.body.category,
            payment_source: canonicalSource,
          },
          "transaction booked from agent proposal",
        );
        return { transaction_id: transactionId };
      } catch (err) {
        req.log.error(
          { err: err.message },
          "agent-proposed transaction write failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/transactions/:id — single GL row by id. Used by the timeline
  // edit dialog to fetch the full record (notes, description, etc.) that
  // the timeline event doesn't carry.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/transactions/:id", async (req, reply) => {
    const row = await getTransaction(req.params.id);
    if (!row) return reply.code(404).send({ error: "Transaction not found" });
    return row;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/transactions/:id — edit a GL row from the timeline.
  // Only patchable fields accepted (id / provenance / created_at locked).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.patch(
    "/api/transactions/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            vendor: { type: "string", minLength: 1 },
            date: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string", minLength: 1 },
            category: { type: "string", minLength: 1 },
            payment_source: { type: ["string", "null"] },
            reference_number: { type: ["string", "null"] },
            // Free-text string (or null). Was strictly enumerated, but
            // every new write path (Book-as-new → "statement",
            // propose_transaction → "check"/"card"/"ach"/etc.) broke
            // editing for previously-saved rows. The frontend dropdown
            // remains the UX guardrail.
            reference_kind: { type: ["string", "null"] },
            description: { type: "string" },
            notes: { type: "string" },
            entry_type: { type: "string", enum: ["expense", "income"] },
          },
        },
      },
    },
    async (req, reply) => {
      const existing = await getTransaction(req.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "Transaction not found" });
      }

      // Register a brand-new payment source on edit just like Record-payment
      // does — keeps the Sources sheet in sync with what's in the GL.
      const patch = { ...req.body };
      if (patch.payment_source) {
        try {
          const { name } = await ensurePaymentSource(patch.payment_source);
          if (name) patch.payment_source = name;
        } catch (err) {
          req.log.error(
            { err: err.message },
            "ensurePaymentSource during edit failed; keeping raw value",
          );
        }
      }

      try {
        const result = await updateTransaction(req.params.id, patch);
        const updated = await getTransaction(req.params.id);
        req.log.info(
          {
            txn_id: req.params.id,
            fields: result.fields_updated,
          },
          "GL row edited",
        );
        return updated;
      } catch (err) {
        req.log.error(
          { err: err.message, txn_id: req.params.id },
          "updateTransaction failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/transactions/:id — remove a GL row. Cascade-safe: refuses
  // when the row is referenced by any other sheet, with a helpful error
  // body listing what would need to be unlinked first. Used by the
  // EditTransactionDialog's Delete button (with a confirm step on the
  // frontend).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.delete("/api/transactions/:id", async (req, reply) => {
    const txnId = req.params.id;
    try {
      const existing = await getTransaction(txnId);
      if (!existing) {
        return reply.code(404).send({ error: "Transaction not found" });
      }

      // FK checks — refuse the delete if anything points at this row.
      const blockers = [];

      const [allLines, allAwaiting, allDocs] = await Promise.all([
        listStatementLines(),
        listAwaiting({ status: "all" }),
        listDocuments(),
      ]);

      const linkedLine = allLines.find((l) => l.matched_txn_id === txnId);
      if (linkedLine) {
        blockers.push(
          `Matched on statement line ${linkedLine.id} — unmatch it first (reconciliation panel).`,
        );
      }
      const linkedAwaiting = allAwaiting.find((a) => a.paid_txn_id === txnId);
      if (linkedAwaiting) {
        blockers.push(
          `Settles awaiting ${linkedAwaiting.id} (${linkedAwaiting.vendor}) — record a different payment first, or void the awaiting.`,
        );
      }
      const linkedDocs = allDocs.filter((d) => d.txn_id === txnId);
      if (linkedDocs.length > 0) {
        blockers.push(
          `${linkedDocs.length} Document row(s) point at this transaction (${linkedDocs.map((d) => d.id).join(", ")}). Detach or delete them first.`,
        );
      }

      if (blockers.length > 0) {
        return reply.code(409).send({
          error: "Cannot delete — other rows reference this transaction.",
          blockers,
        });
      }

      const result = await deleteTransaction(txnId);
      req.log.info(
        {
          txn_id: txnId,
          vendor: existing.vendor,
          amount: existing.amount,
        },
        "transaction deleted",
      );
      return result;
    } catch (err) {
      req.log.error(
        { err: err.message, txn_id: txnId },
        "deleteTransaction failed",
      );
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/awaiting/:id — edit an AwaitingPayment row from the timeline.
  // Does NOT touch status / paid_at / paid_txn_id (use Record-payment).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.patch(
    "/api/awaiting/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            vendor: { type: "string", minLength: 1 },
            date: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string", minLength: 1 },
            reference_number: { type: ["string", "null"] },
            reference_kind: {
              type: ["string", "null"],
              enum: [
                "invoice",
                "receipt",
                "order",
                "transaction",
                "confirmation",
                "other",
                null,
              ],
            },
            description: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const existing = await getAwaiting(req.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "AwaitingPayment row not found" });
      }
      try {
        const result = await updateAwaiting(req.params.id, req.body);
        const updated = await getAwaiting(req.params.id);
        req.log.info(
          {
            awaiting_id: req.params.id,
            fields: result.fields_updated,
          },
          "AwaitingPayment row edited",
        );
        return updated;
      } catch (err) {
        req.log.error(
          { err: err.message, awaiting_id: req.params.id },
          "updateAwaiting failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/awaiting/:id/pay — record a manual payment against an
  // outstanding invoice when there's no receipt to parse (check from your
  // bank, credit-card charge with no vendor receipt, etc). Books a GL row
  // using the AwaitingPayment row's vendor/amount + the user-supplied
  // payment date/source/category, marks the awaiting row paid, and
  // re-attaches any archived invoice docs to the new transaction.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/awaiting/:id/pay",
    {
      schema: {
        body: {
          type: "object",
          required: ["date", "category", "payment_source"],
          additionalProperties: false,
          properties: {
            date: { type: "string" }, // YYYY-MM-DD, payment date
            category: { type: "string", minLength: 1 },
            payment_source: { type: "string", minLength: 1 },
            reference_number: { type: ["string", "null"], default: null },
            reference_kind: {
              type: ["string", "null"],
              enum: [
                "invoice",
                "receipt",
                "order",
                "transaction",
                "confirmation",
                "other",
                null,
              ],
              default: "confirmation",
            },
            description: { type: "string", default: "" },
            notes: { type: "string", default: "" },
          },
        },
      },
    },
    async (req, reply) => {
      const awaiting = await getAwaiting(req.params.id);
      if (!awaiting) {
        return reply.code(404).send({ error: "AwaitingPayment row not found" });
      }
      if (awaiting.status !== "awaiting") {
        return reply
          .code(409)
          .send({ error: `Cannot pay an AwaitingPayment with status=${awaiting.status}` });
      }

      // Register the payment source in the Sources sheet on first use so
      // future Record-payment forms have it in the dropdown. ensurePaymentSource
      // returns the canonical spelling if the user re-used an existing one
      // (case-insensitive), keeping the GL consistent.
      const { name: canonicalSource, added: sourceAdded } =
        await ensurePaymentSource(req.body.payment_source);

      const { id: transactionId } = await addTransaction({
        vendor: awaiting.vendor,
        date: req.body.date,
        amount: awaiting.amount,
        currency: awaiting.currency ?? "USD",
        category: req.body.category,
        payment_source: canonicalSource || req.body.payment_source,
        reference_number: req.body.reference_number ?? null,
        reference_kind: req.body.reference_kind ?? "confirmation",
        document_path: awaiting.document_path ?? null,
        description: req.body.description ?? "",
        notes: req.body.notes ?? "",
        source_file: null,
        pending_id: null,
        created_by: "user",
      });

      // Carry the invoice's Documents rows forward to the new txn so the
      // GL→Documents link is intact. (No new docs to add — there's no
      // source receipt for this payment.)
      await attachDocumentsToTransaction({
        awaiting_id: req.params.id,
        txn_id: transactionId,
      });

      await markAwaitingPaid(req.params.id, { paid_txn_id: transactionId });

      req.log.info(
        {
          awaiting_id: req.params.id,
          transaction_id: transactionId,
          action: "manual_pay",
          vendor: awaiting.vendor,
          amount: awaiting.amount,
          payment_source: canonicalSource || req.body.payment_source,
          payment_source_added: sourceAdded,
          reference_number: req.body.reference_number ?? null,
        },
        "manual payment recorded",
      );

      return {
        awaiting_id: req.params.id,
        transaction_id: transactionId,
        action: "manual_pay",
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/transactions?vendor=...&from=...&to=...&limit=50
  // Read-only list endpoint used by the "Link existing payment" picker
  // in RecordPaymentDialog. Each row carries an `already_linked` flag —
  // true when some AwaitingPayment row already has paid_txn_id = this
  // row's id, so the picker can warn before linking again.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/transactions", async (req, reply) => {
    try {
      const limit = Math.min(
        Math.max(Number(req.query.limit) || 50, 1),
        200,
      );
      const all = await listTransactions({
        from: req.query.from,
        to: req.query.to,
      });
      const v = String(req.query.vendor || "").trim().toLowerCase();
      let rows = v
        ? all.filter((r) =>
            String(r.vendor || "")
              .toLowerCase()
              .includes(v),
          )
        : all;

      // Sort newest-first.
      rows.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      });
      rows = rows.slice(0, limit);

      // Mark rows that already settle one or more awaitings. Multi-link
      // is legitimate (one payment for several invoices) — the picker
      // shows the count as context, not as a block.
      const allAwaiting = await listAwaiting({ status: "all" });
      const linkedByTxnId = new Map();
      for (const a of allAwaiting) {
        if (!a.paid_txn_id) continue;
        if (!linkedByTxnId.has(a.paid_txn_id)) {
          linkedByTxnId.set(a.paid_txn_id, []);
        }
        linkedByTxnId.get(a.paid_txn_id).push({
          id: a.id,
          vendor: a.vendor,
          amount: a.amount,
        });
      }
      return rows.map((r) => {
        const links = linkedByTxnId.get(r.id) ?? [];
        return {
          id: r.id,
          date: r.date,
          vendor: r.vendor,
          amount: r.amount,
          currency: r.currency ?? "USD",
          category: r.category,
          payment_source: r.payment_source,
          reference_number: r.reference_number,
          reference_kind: r.reference_kind,
          description: r.description,
          entry_type: r.entry_type === "income" ? "income" : "expense",
          already_linked: links.length > 0,
          already_linked_count: links.length,
          already_linked_awaitings: links,
        };
      });
    } catch (err) {
      req.log.error(
        { err: err.message },
        "GET /api/transactions failed",
      );
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/awaiting/:id/link-txn — attach an outstanding awaiting to
  // an EXISTING GL transaction (one that was booked some other way —
  // parser approval, propose_transaction, etc.) rather than creating a
  // brand new row. Used by the "Link existing payment" tab in the
  // RecordPaymentDialog.
  //
  // Cascade-safe: refuses if the target txn already settles a different
  // awaiting. Re-attaches the awaiting's Documents rows to the txn so
  // the invoice → payment link is intact going forward.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/awaiting/:id/link-txn",
    {
      schema: {
        body: {
          type: "object",
          required: ["txn_id"],
          additionalProperties: false,
          properties: {
            txn_id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const awaiting = await getAwaiting(req.params.id);
      if (!awaiting) {
        return reply.code(404).send({ error: "AwaitingPayment row not found" });
      }
      if (awaiting.status !== "awaiting") {
        return reply.code(409).send({
          error: `Cannot link a payment to an awaiting with status=${awaiting.status}`,
        });
      }
      const txn = await getTransaction(req.body.txn_id);
      if (!txn) {
        return reply.code(404).send({ error: "Transaction not found" });
      }

      // Multi-link is legitimate — one GL payment can settle several
      // awaiting invoices from the same vendor (or different vendors,
      // for grouped payments like a check covering multiple bills).
      // We just log it for the audit trail.
      const allAwaiting = await listAwaiting({ status: "all" });
      const alsoLinked = allAwaiting.filter(
        (a) => a.paid_txn_id === txn.id && a.id !== awaiting.id,
      );

      // Re-attach the awaiting's invoice docs to the GL row so the
      // invoice→payment relationship is preserved in Documents.
      try {
        await attachDocumentsToTransaction({
          awaiting_id: awaiting.id,
          txn_id: txn.id,
        });
      } catch (err) {
        req.log.error(
          { err: err.message, awaiting_id: awaiting.id, txn_id: txn.id },
          "attachDocumentsToTransaction during link failed; continuing",
        );
      }

      await markAwaitingPaid(awaiting.id, { paid_txn_id: txn.id });

      req.log.info(
        {
          awaiting_id: awaiting.id,
          txn_id: txn.id,
          action: "link_existing_txn",
          vendor: awaiting.vendor,
          awaiting_amount: awaiting.amount,
          txn_amount: txn.amount,
          also_settles: alsoLinked.map((a) => a.id),
        },
        "awaiting linked to existing transaction",
      );

      return {
        awaiting_id: awaiting.id,
        transaction_id: txn.id,
        action: "link_existing_txn",
        also_settles: alsoLinked.map((a) => a.id),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/documents/pending/:id — preview the document attached to a
  // pending entry BEFORE approval. Reads the base64 attachment out of the
  // saved inbound/upload payload and streams it. For inline-HTML rows (no
  // attachment) returns 404.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/pending/:id", async (req, reply) => {
    const row = await getPending(req.params.id);
    if (!row) return reply.code(404).send({ error: "Pending entry not found" });
    if (!row.source_file) return reply.code(404).send({ error: "No source file recorded" });

    const payloadPath = path.join(logDir, row.source_file);
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(payloadPath, "utf-8"));
    } catch {
      return reply.code(404).send({ error: "Source payload missing" });
    }
    const att = pickFirstViewableAttachment(payload?.Attachments);
    if (!att) {
      return reply.code(404).send({ error: "No archivable attachment in source payload" });
    }
    const buffer = Buffer.from(att.Content, "base64");
    reply
      .header("Content-Type", att.ContentType)
      .header("Content-Disposition", `inline; filename="${sanitizeForHeader(att.Name)}"`)
      .send(buffer);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/documents/transaction/:txn_id — stream the archived document
  // for an approved GL transaction. Looks up document_path on the row,
  // resolves it safely inside the company's documents/ tree, and streams.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/transaction/:txn_id", async (req, reply) => {
    const txn = await getTransaction(req.params.txn_id);
    if (!txn) return reply.code(404).send({ error: "Transaction not found" });
    if (!txn.document_path) {
      return reply.code(404).send({ error: "No document archived for this transaction" });
    }
    const absolute = resolveDocumentPath({ companyId: COMPANY_ID, documentPath: txn.document_path });
    if (!absolute) return reply.code(400).send({ error: "Invalid document path" });

    try {
      const buffer = await fs.readFile(absolute);
      const ext = path.extname(absolute).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      reply
        .header("Content-Type", mime)
        .header("Content-Disposition", `inline; filename="${path.basename(absolute)}"`)
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: "Document file missing on disk" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/documents/by-id/:doc_id — stream an archived document by its
  // Documents-sheet ID. Used by the dashboard file browser, which deals in
  // doc IDs rather than txn IDs (a single txn can have multiple docs).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/by-id/:doc_id", async (req, reply) => {
    const doc = await getDocument(req.params.doc_id);
    if (!doc) return reply.code(404).send({ error: "Document not found" });
    if (!doc.document_path) {
      return reply.code(404).send({ error: "Document has no archived path" });
    }
    const absolute = resolveDocumentPath({
      companyId: COMPANY_ID,
      documentPath: doc.document_path,
    });
    if (!absolute) return reply.code(400).send({ error: "Invalid document path" });

    try {
      const buffer = await fs.readFile(absolute);
      const ext = path.extname(absolute).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      reply
        .header("Content-Type", mime)
        .header(
          "Content-Disposition",
          `inline; filename="${path.basename(absolute)}"`,
        )
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: "Document file missing on disk" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/files/ledger — download the active company's ledger workbook.
  // The file lives outside the documents/ tree so it gets its own route.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/files/ledger", async (req, reply) => {
    const ledgerPath = getLedgerPath();
    try {
      const buffer = await fs.readFile(ledgerPath);
      reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="${path.basename(ledgerPath)}"`,
        )
        .send(buffer);
    } catch (err) {
      req.log.error({ err: err.message, ledgerPath }, "ledger read failed");
      return reply.code(404).send({ error: "Ledger workbook not found" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/upload — direct upload of a receipt PDF/image. Body has the
  // file base64-encoded. Wrapped in a Postmark-shaped synthetic payload so
  // it flows through the exact same parser path as inbound email. Runs
  // synchronously (~5s for the vision call); returns the parsed result.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/upload",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "content_type", "content_base64"],
          additionalProperties: false,
          properties: {
            filename: { type: "string", minLength: 1 },
            content_type: { type: "string", minLength: 1 },
            content_base64: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { filename, content_type, content_base64, description } = req.body;

      if (!SUPPORTED_UPLOAD_TYPES.has(content_type)) {
        return reply.code(400).send({
          error: `Unsupported content type: ${content_type}. Allowed: ${[...SUPPORTED_UPLOAD_TYPES].join(", ")}`,
        });
      }

      const decodedBytes = Math.floor((content_base64.length * 3) / 4);
      if (decodedBytes > MAX_UPLOAD_BYTES) {
        return reply.code(400).send({
          error: `File too large: ${decodedBytes} bytes (max ${MAX_UPLOAD_BYTES})`,
        });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sourceFilename = `upload-${stamp}.json`;
      const payload = buildUploadPayload({ filename, content_type, content_base64, description });

      try {
        await fs.writeFile(
          path.join(logDir, sourceFilename),
          JSON.stringify(payload, null, 2),
        );
      } catch (err) {
        req.log.error({ err, file: sourceFilename }, "failed to write upload payload");
        return reply.code(500).send({ error: "Failed to persist upload" });
      }

      req.log.info(
        { file: sourceFilename, filename, content_type, bytes: decodedBytes },
        "upload received",
      );

      try {
        const { result, pending_id } = await processReceiptPayload({
          payload,
          logger: req.log,
          logDir,
          sourceFilename,
        });
        return {
          pending_id,
          source_file: sourceFilename,
          status: result.status,
          reason: result.reason,
          proposal: result.proposal,
        };
      } catch (err) {
        return reply
          .code(500)
          .send({ error: `Parser failed: ${err.message}`, source_file: sourceFilename });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/pending/:id/reparse — re-run the parser on the saved payload,
  // overwrite the existing PendingInbox row's data fields, and write a
  // fresh -parsed.json sidecar. Useful when an entry was parsed before
  // some parser improvement (e.g. reference_number extraction) and the
  // pending row is missing fields.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post("/api/pending/:id/reparse", async (req, reply) => {
    const row = await getPending(req.params.id);
    if (!row) return reply.code(404).send({ error: "Pending entry not found" });
    if (row.status !== "pending") {
      return reply.code(409).send({ error: `Cannot reparse a ${row.status} entry` });
    }
    if (!row.source_file) {
      return reply.code(400).send({ error: "No source_file recorded for this row" });
    }

    const payloadPath = path.join(logDir, row.source_file);
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(payloadPath, "utf-8"));
    } catch {
      return reply.code(404).send({ error: "Source payload missing or unreadable" });
    }

    let result;
    try {
      const [categories, paymentSources, knownVendors] = await Promise.all([
        getCategories().catch(() => []),
        getPaymentSources().catch(() => []),
        getKnownVendors().catch(() => []),
      ]);
      result = await parseReceipt(payload, {
        categories,
        paymentSources,
        knownVendors,
      });
    } catch (err) {
      return reply.code(500).send({ error: `Parser failed: ${err.message}` });
    }

    // Fresh sidecar overwrites the prior one.
    const parsedPath = path.join(
      logDir,
      row.source_file.replace(/\.json$/, "-parsed.json"),
    );
    await fs
      .writeFile(parsedPath, JSON.stringify(result, null, 2))
      .catch((err) => req.log.error({ err }, "failed to write reparsed sidecar"));

    // Update existing pending row in place — keeps id, status, source_file
    // intact so the UI/links stay valid.
    try {
      await updatePendingFromParse(row.id, result);
    } catch (err) {
      return reply.code(500).send({ error: `Failed to update pending row: ${err.message}` });
    }

    req.log.info(
      {
        pending_id: row.id,
        status: result.status,
        reference_kind: result.proposal?.reference_number?.kind ?? null,
        reference_number: result.proposal?.reference_number?.value ?? null,
        vendor: result.proposal?.vendor?.name ?? null,
        total: result.proposal?.total?.amount ?? null,
        usage: result.usage,
      },
      "pending reparsed",
    );

    return {
      pending_id: row.id,
      status: result.status,
      reason: result.reason,
      proposal: result.proposal,
      usage: result.usage,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/pending/:id/reject — marks pending rejected, no GL row.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/pending/:id/reject",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const row = await getPending(req.params.id);
      if (!row) return reply.code(404).send({ error: "Pending entry not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `Cannot reject a ${row.status} entry` });
      }

      const parts = [
        req.body.reason ? `Reason: ${req.body.reason}` : "",
        req.body.notes ?? "",
      ].filter(Boolean);
      const resolutionNotes = parts.join(" | ") || "Rejected";

      await updatePendingStatus(row.id, {
        status: "rejected",
        resolution_notes: resolutionNotes,
      });

      req.log.info({ pending_id: row.id, reason: req.body.reason }, "pending rejected");
      return { pending_id: row.id, status: "rejected" };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/main-timeline — the global, all-vendor timeline used as the
  // dashboard's home screen on login. Returns the same payload shape that
  // the agent tool show_main_timeline emits, so the frontend can render
  // it via the existing VendorTimelinePanel.vue component.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/main-timeline",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const props = await buildTimelineProps({
        vendor: null,
        from: req.query.from,
        to: req.query.to,
      });
      return {
        kind: "vendor_timeline",
        title: "All activity",
        props,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/vendor-timeline?vendor=X — single-vendor timeline payload,
  // shape-compatible with show_vendor_timeline. Used by the frontend to
  // refetch a vendor timeline panel after a ledger mutation.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/vendor-timeline",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["vendor"],
          properties: {
            vendor: { type: "string", minLength: 1 },
            from: { type: "string" },
            to: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const props = await buildTimelineProps({
        vendor: req.query.vendor,
        from: req.query.from,
        to: req.query.to,
      });
      return {
        kind: "vendor_timeline",
        title: `Timeline · ${props.vendor || req.query.vendor}`,
        props,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/upload-statement — direct upload of a bank or credit-card
  // statement PDF. Runs the statement parser, archives the PDF under
  // companies/{id}/statements/{source-slug}/{close-date}.pdf, and writes a
  // Statements row plus one StatementLines row per parsed transaction. No
  // reconciliation here — that's a separate, later workflow.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/upload-statement",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "content_type", "content_base64"],
          additionalProperties: false,
          properties: {
            filename: { type: "string", minLength: 1 },
            content_type: { type: "string", minLength: 1 },
            content_base64: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { filename, content_type, content_base64, description } = req.body;

      const ct = content_type.toLowerCase().split(";")[0].trim();
      if (!SUPPORTED_UPLOAD_TYPES.has(ct)) {
        return reply.code(400).send({
          error: `Unsupported content type: ${content_type}. Allowed: ${[...SUPPORTED_UPLOAD_TYPES].join(", ")}`,
        });
      }

      const decodedBytes = Math.floor((content_base64.length * 3) / 4);
      if (decodedBytes > MAX_UPLOAD_BYTES) {
        return reply.code(400).send({
          error: `File too large: ${decodedBytes} bytes (max ${MAX_UPLOAD_BYTES})`,
        });
      }

      // Persist a synthetic upload payload alongside receipts so the parser
      // and any reparse step can rerun against it later.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sourceFilename = `statement-${stamp}.json`;
      const payload = buildUploadPayload({
        filename,
        content_type,
        content_base64,
        description,
      });
      try {
        await fs.writeFile(
          path.join(logDir, sourceFilename),
          JSON.stringify(payload, null, 2),
        );
      } catch (err) {
        req.log.error(
          { err, file: sourceFilename },
          "failed to write statement upload payload",
        );
        return reply.code(500).send({ error: "Failed to persist upload" });
      }

      req.log.info(
        {
          file: sourceFilename,
          filename,
          content_type,
          bytes: decodedBytes,
        },
        "statement upload received",
      );

      // Parse.
      let parseResult;
      try {
        parseResult = await parseStatement(payload);
      } catch (err) {
        req.log.error({ err: err.message }, "statement parser threw");
        return reply.code(500).send({
          error: `Parser failed: ${err.message}`,
          source_file: sourceFilename,
        });
      }

      // Persist the parser output sidecar so future debugging / reparse
      // doesn't need to re-invoke Anthropic.
      const parsedPath = path.join(
        logDir,
        sourceFilename.replace(/\.json$/, "-parsed.json"),
      );
      await fs
        .writeFile(parsedPath, JSON.stringify(parseResult, null, 2))
        .catch((err) =>
          req.log.error({ err }, "failed to write statement -parsed sidecar"),
        );

      if (parseResult.status !== "parsed" || !parseResult.extracted) {
        req.log.info(
          {
            source_file: sourceFilename,
            status: parseResult.status,
            reason: parseResult.reason,
            usage: parseResult.usage,
          },
          "statement parse did not produce extractable data",
        );
        return reply.code(200).send({
          source_file: sourceFilename,
          status: parseResult.status,
          reason: parseResult.reason,
          validation: parseResult.validation,
        });
      }

      const ext = parseResult.extracted;
      const sourceName =
        ext.source?.name
          ? ext.source.last4
            ? `${ext.source.name} ••${ext.source.last4}`
            : ext.source.name
          : `Unknown source · ${stamp}`;

      // Register the source so future Record-payment forms see it.
      let canonicalSource = sourceName;
      try {
        const { name } = await ensurePaymentSource(sourceName);
        if (name) canonicalSource = name;
      } catch (err) {
        req.log.error(
          { err: err.message },
          "ensurePaymentSource failed; falling back to raw name",
        );
      }

      // Archive the PDF on disk.
      let archive = null;
      const statementDate =
        ext.period?.statement_date ||
        ext.period?.end ||
        new Date().toISOString().slice(0, 10);
      try {
        archive = await archiveStatement({
          companyId: COMPANY_ID,
          source: canonicalSource,
          statementDate,
          contentBase64: content_base64,
          contentType: ct,
          originalFilename: filename,
        });
      } catch (err) {
        req.log.error(
          { err: err.message },
          "statement archive failed; continuing without document_path",
        );
      }

      // Persist to ledger.
      const stmtId = await addStatement({
        statement: {
          source: canonicalSource,
          source_kind: ext.source?.kind ?? null,
          period_start: ext.period?.start ?? null,
          period_end: ext.period?.end ?? null,
          statement_date: statementDate,
          currency: ext.currency ?? "USD",
          opening_balance: ext.balances?.opening ?? null,
          closing_balance: ext.balances?.closing ?? null,
          total_charges: ext.balances?.total_charges ?? null,
          total_payments: ext.balances?.total_payments ?? null,
          document_path: archive?.document_path ?? null,
          original_filename: filename,
          source_file: sourceFilename,
          status: deriveInitialStatementStatus({
            validation: parseResult.validation,
            ext,
          }),
          notes:
            parseResult.validation?.balance_check === "mismatch"
              ? `Balance check off by ${parseResult.validation.balance_check_diff}`
              : "",
        },
        lines: ext.lines ?? [],
      });

      // ── Auto-create awaiting-transfer for the closing balance ──────────
      // Credit-card statements model an obligation: you owe the card
      // issuer the closing balance, and you'll settle it by transferring
      // money in from another account. The carry-forward rule: any
      // still-outstanding awaiting-transfer for the same card source
      // gets written off ("superseded") because the new statement's
      // closing balance already reflects whatever portion wasn't paid.
      let awaitingTransferId = null;
      let supersededAwaitingIds = [];
      const isCreditCard = ext.source?.kind === "credit_card";
      const closingBalance = Number(ext.balances?.closing);
      const shouldCreateAwaiting =
        isCreditCard &&
        Number.isFinite(closingBalance) &&
        closingBalance > 0.01;
      if (shouldCreateAwaiting) {
        // Find outstanding awaiting-transfers tied to this card source.
        try {
          const priorAwaiting = await listAwaiting({ status: "awaiting" });
          const sameCard = priorAwaiting.filter(
            (r) =>
              r.payment_kind === "transfer" &&
              r.vendor === canonicalSource,
          );
          for (const old of sameCard) {
            await markAwaitingWrittenOff(old.id, {
              note: `Superseded by statement ${stmtId.id} — balance carried forward into the new closing balance`,
            });
            supersededAwaitingIds.push(old.id);
          }
        } catch (err) {
          req.log.error(
            { err: err.message },
            "carry-forward of prior awaiting-transfer failed; continuing",
          );
        }

        try {
          const { id: aid } = await addAwaitingPayment({
            payment_kind: "transfer",
            vendor: canonicalSource,
            date: statementDate,
            amount: Math.round(closingBalance * 100) / 100,
            currency: ext.currency ?? "USD",
            reference_number: stmtId.id,
            reference_kind: "statement",
            description: `Card balance for ${ext.period?.start ?? "?"} → ${ext.period?.end ?? "?"}`,
            notes: supersededAwaitingIds.length
              ? `Carries forward: ${supersededAwaitingIds.join(", ")}`
              : "",
            statement_id: stmtId.id,
            source_file: sourceFilename,
          });
          awaitingTransferId = aid;
        } catch (err) {
          req.log.error(
            { err: err.message },
            "auto-creating awaiting-transfer for closing balance failed; continuing",
          );
        }
      }

      req.log.info(
        {
          statement_id: stmtId.id,
          source: canonicalSource,
          source_kind: ext.source?.kind ?? null,
          period: { from: ext.period?.start, to: ext.period?.end },
          line_count: ext.lines?.length ?? 0,
          awaiting_transfer_id: awaitingTransferId,
          superseded_awaiting_ids: supersededAwaitingIds,
          validation: parseResult.validation,
          usage: parseResult.usage,
        },
        "statement imported",
      );

      return {
        statement_id: stmtId.id,
        line_count: ext.lines?.length ?? 0,
        source: canonicalSource,
        period: ext.period,
        balances: ext.balances,
        validation: parseResult.validation,
        document_path: archive?.document_path ?? null,
        awaiting_transfer_id: awaitingTransferId,
        superseded_awaiting_ids: supersededAwaitingIds,
        status:
          parseResult.validation?.balance_check === "mismatch"
            ? "needs_attention"
            : "imported",
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/statements/:id/reconcile — run the auto-match heuristic
  // against any unmatched negative-amount lines on the statement.
  // Idempotent: only touches lines without an existing match_method.
  // Updates Statements.status as a side effect.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post("/api/statements/:id/reconcile", async (req, reply) => {
    try {
      const result = await autoMatchStatement(req.params.id);
      req.log.info(
        {
          statement_id: req.params.id,
          matched: result.matched,
          attempted: result.attempted,
        },
        "statement auto-match run",
      );
      return result;
    } catch (err) {
      const notFound = /Statement not found/i.test(err.message ?? "");
      req.log.error(
        { err: err.message, statement_id: req.params.id },
        "autoMatchStatement failed",
      );
      return reply.code(notFound ? 404 : 500).send({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/statements/:id/reconciliation — return the full panel
  // payload (matched pairs + unmatched lines + unreconciled GL +
  // source diagnostic). Stateless; doesn't mutate anything.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/statements/:id/reconciliation", async (req, reply) => {
    const view = await buildReconciliationView(req.params.id);
    if (!view) return reply.code(404).send({ error: "Statement not found" });
    return view;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/statement-lines/:id/match — manually pair a statement line
  // with a GL transaction. Use when the auto-match heuristic missed.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/statement-lines/:id/match",
    {
      schema: {
        body: {
          type: "object",
          required: ["txn_id"],
          additionalProperties: false,
          properties: { txn_id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params;
        const txn = await getTransaction(req.body.txn_id);
        if (!txn) {
          return reply.code(404).send({ error: "Transaction not found" });
        }
        // Reject if the GL row is already matched to a different line.
        const allLines = await listStatementLines();
        const otherClaim = allLines.find(
          (l) => l.matched_txn_id === req.body.txn_id && l.id !== id,
        );
        if (otherClaim) {
          return reply.code(409).send({
            error: `Transaction ${req.body.txn_id} is already matched to line ${otherClaim.id}`,
          });
        }
        const result = await updateStatementLine(id, {
          matched_txn_id: req.body.txn_id,
          match_method: "manual",
        });
        req.log.info(
          { line_id: id, txn_id: req.body.txn_id, method: "manual" },
          "statement line matched",
        );
        return result;
      } catch (err) {
        req.log.error(
          { err: err.message, line_id: req.params.id },
          "manual match failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/statement-lines/:id/unmatch — clear an existing match,
  // returning the line to the unmatched bucket.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post("/api/statement-lines/:id/unmatch", async (req, reply) => {
    try {
      const result = await updateStatementLine(req.params.id, {
        matched_txn_id: null,
        matched_transfer_id: null,
        match_method: null,
      });
      req.log.info({ line_id: req.params.id }, "statement line unmatched");
      return result;
    } catch (err) {
      req.log.error(
        { err: err.message, line_id: req.params.id },
        "unmatch failed",
      );
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/statement-lines/:id/book-as-transaction — turn an unmatched
  // statement debit line into a GL transaction in one click. Used for
  // late fees, finance charges, and any other charge that appeared on
  // the statement but wasn't already in the books from a receipt.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/statement-lines/:id/book-as-transaction",
    {
      schema: {
        body: {
          type: "object",
          required: ["vendor", "category", "date", "payment_source"],
          additionalProperties: false,
          properties: {
            vendor: { type: "string", minLength: 1 },
            category: { type: "string", minLength: 1 },
            date: { type: "string", minLength: 1 }, // YYYY-MM-DD
            payment_source: { type: "string", minLength: 1 },
            description: { type: "string", default: "" },
            notes: { type: "string", default: "" },
            reference_kind: { type: "string", default: "statement" },
          },
        },
      },
    },
    async (req, reply) => {
      const { id: lineId } = req.params;
      try {
        const allLines = await listStatementLines();
        const line = allLines.find((l) => l.id === lineId);
        if (!line) {
          return reply.code(404).send({ error: "Statement line not found" });
        }
        if (line.matched_txn_id || line.matched_transfer_id) {
          return reply
            .code(409)
            .send({ error: "Statement line is already matched" });
        }
        const stmt = await getStatement(line.statement_id);

        // Register payment source if new — same convention as Record-payment.
        const { name: canonicalSource } = await ensurePaymentSource(
          req.body.payment_source,
        );

        // Statement debits are stored as negative amounts (charges); the
        // GL row's amount is always the absolute value of the charge.
        const amount = Math.abs(Number(line.amount));

        const { id: txnId } = await addTransaction({
          date: req.body.date,
          vendor: req.body.vendor,
          description: req.body.description || line.description || "",
          category: req.body.category,
          payment_source: canonicalSource || req.body.payment_source,
          amount,
          currency: stmt?.currency ?? "USD",
          reference_number: stmt?.id ?? null,
          reference_kind: req.body.reference_kind || "statement",
          notes: req.body.notes ?? "",
          source_file: stmt?.source_file ?? null,
          created_by: "user",
        });

        await updateStatementLine(lineId, {
          matched_txn_id: txnId,
          matched_transfer_id: null,
          match_method: "manual",
        });

        req.log.info(
          {
            line_id: lineId,
            txn_id: txnId,
            vendor: req.body.vendor,
            category: req.body.category,
            amount,
          },
          "statement line booked as new transaction",
        );

        return { line_id: lineId, txn_id: txnId };
      } catch (err) {
        req.log.error(
          { err: err.message, line_id: lineId },
          "book-as-transaction failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/statement-lines/:id/mark-as-transfer — turn an unmatched
  // statement line into a Transfer row in one click. For a debit line,
  // money is leaving this account → from_source = statement source.
  // For a credit line, money is arriving → to_source = statement source.
  // The opposite side is the user-picked counterparty (other_source).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/statement-lines/:id/mark-as-transfer",
    {
      schema: {
        body: {
          type: "object",
          required: ["other_source", "date"],
          additionalProperties: false,
          properties: {
            other_source: { type: "string", minLength: 1 },
            date: { type: "string", minLength: 1 },
            description: { type: "string", default: "" },
            notes: { type: "string", default: "" },
          },
        },
      },
    },
    async (req, reply) => {
      const { id: lineId } = req.params;
      try {
        const allLines = await listStatementLines();
        const line = allLines.find((l) => l.id === lineId);
        if (!line) {
          return reply.code(404).send({ error: "Statement line not found" });
        }
        if (line.matched_txn_id || line.matched_transfer_id) {
          return reply
            .code(409)
            .send({ error: "Statement line is already matched" });
        }
        const stmt = await getStatement(line.statement_id);
        if (!stmt) {
          return reply
            .code(404)
            .send({ error: "Parent statement not found" });
        }

        const { name: canonicalOther } = await ensurePaymentSource(
          req.body.other_source,
        );

        const amount = Math.abs(Number(line.amount));
        const isDebit = Number(line.amount) < 0;
        // Debit on the statement → money LEFT this account → from = statement source.
        // Credit on the statement → money ARRIVED at this account → to = statement source.
        const fromSource = isDebit
          ? stmt.source
          : canonicalOther || req.body.other_source;
        const toSource = isDebit
          ? canonicalOther || req.body.other_source
          : stmt.source;

        // Create the Transfer first (unlinked); we'll then run the
        // sum-match resolver across all unlinked transfers to see if
        // this one closes the loop on an awaiting-transfer (either by
        // itself or as the final piece of a multi-payment paydown).
        const { id: transferId, row: transferRow } = await addTransfer({
          date: req.body.date,
          amount,
          currency: stmt.currency ?? "USD",
          from_source: fromSource,
          to_source: toSource,
          description: req.body.description || line.description || "",
          notes: req.body.notes ?? "",
          source_file: stmt.source_file ?? null,
          created_by: "user",
        });

        // ── Auto-link: exact subset-sum OR carry-forward overpayment ────
        let autoLink = null;
        try {
          const [allUnlinked, allAwaiting, allStatements] = await Promise.all(
            [
              listTransfers().then((rows) =>
                rows.filter((t) => !t.awaiting_id),
              ),
              listAwaiting({ status: "awaiting" }),
              listStatements({ status: "all" }),
            ],
          );
          // The new Transfer is included in allUnlinked (just inserted,
          // awaiting_id is null until we link it below).
          const newTransfer = allUnlinked.find((t) => t.id === transferId) ?? {
            id: transferId,
            ...transferRow,
            awaiting_id: null,
          };
          // Pre-compute next-statement lookup for each candidate awaiting.
          // The overpayment-window pass needs the next-period total_charges
          // to compute the acceptable upper bound.
          const nextStatementByAwaitingId = new Map();
          for (const aw of allAwaiting) {
            const next = await findNextStatementForAwaiting(aw, allStatements);
            if (next) nextStatementByAwaitingId.set(aw.id, next);
          }
          autoLink = findAutoLinkSubset({
            newTransfer,
            unlinkedTransfers: allUnlinked,
            outstandingAwaitings: allAwaiting,
            nextStatementByAwaitingId,
          });
          if (autoLink) {
            for (const t of autoLink.subset) {
              await updateTransfer(t.id, { awaiting_id: autoLink.awaiting.id });
            }
            // For overpayments, append a note that explains why the
            // awaiting is being marked paid even though the amounts
            // didn't exactly match — the overshoot was credited toward
            // the next statement's opening balance.
            if (autoLink.mode === "overpayment") {
              const existingNotes = autoLink.awaiting.notes || "";
              const overNote = `Overpaid by $${autoLink.overpayment.toFixed(2)} via xfer ${transferId} — applied to next statement (${autoLink.next_statement_id}).`;
              const combinedNotes = existingNotes
                ? `${existingNotes}\n${overNote}`
                : overNote;
              await updateAwaiting(autoLink.awaiting.id, {
                notes: combinedNotes,
              });
            }
            await markAwaitingPaid(autoLink.awaiting.id, {
              paid_transfer_id: transferId,
            });
          }
        } catch (err) {
          req.log.error(
            { err: err.message, transfer_id: transferId },
            "auto-link sweep failed; transfer remains unlinked",
          );
        }

        await updateStatementLine(lineId, {
          matched_txn_id: null,
          matched_transfer_id: transferId,
          match_method: "manual",
        });

        req.log.info(
          {
            line_id: lineId,
            transfer_id: transferId,
            from_source: fromSource,
            to_source: toSource,
            amount,
            auto_linked_awaiting: autoLink?.awaiting?.id ?? null,
            auto_linked_subset: autoLink
              ? autoLink.subset.map((t) => t.id)
              : null,
            auto_link_mode: autoLink?.mode ?? null,
            overpayment: autoLink?.overpayment ?? null,
          },
          "statement line marked as transfer",
        );

        return {
          line_id: lineId,
          transfer_id: transferId,
          auto_linked_awaiting: autoLink?.awaiting?.id ?? null,
          auto_linked_subset_size: autoLink ? autoLink.subset.length : 0,
          auto_link_mode: autoLink?.mode ?? null,
          overpayment: autoLink?.overpayment ?? null,
        };
      } catch (err) {
        req.log.error(
          { err: err.message, line_id: lineId },
          "mark-as-transfer failed",
        );
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/documents/statement/:id — download an archived statement PDF.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/statement/:id", async (req, reply) => {
    const stmt = await getStatement(req.params.id);
    if (!stmt) return reply.code(404).send({ error: "Statement not found" });
    if (!stmt.document_path) {
      return reply.code(404).send({ error: "No archived document for this statement" });
    }
    const absolute = resolveStatementPath({
      companyId: COMPANY_ID,
      documentPath: stmt.document_path,
    });
    if (!absolute) return reply.code(400).send({ error: "Invalid document path" });
    try {
      const buffer = await fs.readFile(absolute);
      const ext = path.extname(absolute).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      reply
        .header("Content-Type", mime)
        .header(
          "Content-Disposition",
          `inline; filename="${path.basename(absolute)}"`,
        )
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: "Statement file missing on disk" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/agent/chat — bookkeeping agent (Sonnet 4.6 + read-only tools),
  // streamed back as Server-Sent Events. Each event line is:
  //   data: {"type":"text_delta","text":"..."}
  //
  // Event types emitted: text_delta, tool_use, tool_result, usage, done, error.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/agent/chat",
    {
      schema: {
        body: {
          type: "object",
          required: ["messages"],
          additionalProperties: false,
          properties: {
            messages: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["role", "content"],
                additionalProperties: false,
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  // string or content-block array — SDK validates the shape
                  content: {},
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const started = Date.now();
      req.log.info(
        { msg_count: req.body.messages.length },
        "agent chat started",
      );

      // Hijack so we own the response lifecycle end-to-end. Two reasons:
      //
      // 1) CORS — we set Access-Control-Allow-Origin manually here
      //    (mirroring what @fastify/cors's onSend hook would have set on a
      //    normal response), because hijacking bypasses that hook.
      // 2) Connection: close — using keep-alive with this streamed response
      //    leaves the connection in a state where the next browser request
      //    intermittently fails (NetworkError on alternating attempts).
      //    Closing per-request adds ~one TLS handshake; well worth the
      //    reliability.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...corsHeadersFor(req.headers.origin),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "close",
        "X-Accel-Buffering": "no", // disable nginx proxy buffering
      });

      let lastWriteAt = Date.now();
      const send = (event) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        lastWriteAt = Date.now();
      };

      // Adaptive thinking can sit silently for tens of seconds while the
      // model reasons over a moderately sized ledger. Without traffic on
      // the socket, nginx hits its proxy_read_timeout (~60s default) and
      // drops the response — the browser surfaces that as a generic
      // NetworkError. SSE comments (`: ping\n\n`) are spec-defined no-ops
      // for clients but count as bytes on the wire, keeping nginx happy.
      const KEEPALIVE_QUIET_MS = 20_000;
      const keepalive = setInterval(() => {
        if (res.writableEnded) return;
        if (Date.now() - lastWriteAt >= KEEPALIVE_QUIET_MS) {
          res.write(": ping\n\n");
          lastWriteAt = Date.now();
        }
      }, 5_000);

      // If the client disconnects mid-stream we still want to drain the
      // agent loop's logging in `finally`, but stop writing.
      req.raw.on("close", () => {
        if (!res.writableEnded) res.end();
      });

      try {
        for await (const event of runAgent({
          messages: req.body.messages,
          logger: req.log,
          companyName: COMPANY_NAME,
        })) {
          send(event);
        }
      } catch (err) {
        req.log.error(
          { err: err.message, stack: err.stack },
          "agent loop failed",
        );
        send({ type: "error", error: err.message });
      } finally {
        clearInterval(keepalive);
        req.log.info(
          { duration_ms: Date.now() - started },
          "agent chat finished",
        );
        if (!res.writableEnded) res.end();
      }
    },
  );
}
