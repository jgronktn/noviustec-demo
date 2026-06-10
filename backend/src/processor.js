// Shared receipt-processing pipeline.
//
// Used by:
// - the Postmark webhook (fire-and-forget after writing the raw payload)
// - the /api/upload endpoint (synchronous; result returned to the client)
//
// Caller is responsible for writing the source payload (inbound-<ts>.json or
// upload-<ts>.json) to disk before calling this. This module:
//   1. Calls parseReceipt() with categories+sources read from the ledger
//   2. Writes the parser result to a -parsed.json sidecar
//   3. Writes a PendingInbox row for parsed/needs_attention results
//   4. Logs a "receipt parsed" line via Pino
// On parser error: writes an error sidecar, logs, then re-throws so the
// caller can decide how to surface it (webhook swallows; upload returns 500).

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { parseReceipt } from "./parser/index.js";
import {
  getCategories,
  getPaymentSources,
  getKnownVendors,
  addPending,
} from "./ledger/index.js";
import { sendParseReply } from "./notifications/email.js";

const SUPPORTED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// Upload cap. Generous enough for raw phone photos; the parser's
// normalize stage will compress oversized images before the Anthropic
// call (which has a 5 MiB per-image hard limit). Postmark inbound and
// nginx are both configured for 30MB body limits, so base64-inflated
// uploads up to ~22MB will fit through the pipeline.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export { SUPPORTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES };

export async function processReceiptPayload({ payload, logger, logDir, sourceFilename }) {
  const parsedFilename = sourceFilename.replace(/\.json$/, "-parsed.json");
  const parsedPath = path.join(logDir, parsedFilename);

  try {
    const [categories, paymentSources, knownVendors] = await Promise.all([
      getCategories().catch(() => []),
      getPaymentSources().catch(() => []),
      getKnownVendors().catch(() => []),
    ]);

    const result = await parseReceipt(payload, {
      categories,
      paymentSources,
      knownVendors,
    });
    await fs.writeFile(parsedPath, JSON.stringify(result, null, 2));

    let pendingId = null;
    if (result.status === "parsed" || result.status === "needs_attention") {
      try {
        const { id } = await addPending({ source_file: sourceFilename, result });
        pendingId = id;
      } catch (err) {
        logger.error({ err, file: sourceFilename }, "failed to add pending row");
      }
    }

    logger.info(
      {
        file: sourceFilename,
        pending_id: pendingId,
        status: result.status,
        reason: result.reason,
        vendor: result.proposal?.vendor?.name ?? null,
        total: result.proposal?.total ?? null,
        confidence: result.proposal?.confidence ?? null,
        usage: result.usage,
      },
      "receipt parsed",
    );

    // Fire-and-forget confirmation email back to the sender. No-ops for
    // direct UI uploads (synthetic "(uploaded by user)" From), for missing
    // POSTMARK_FROM config, and for Postmark API errors — none of those
    // should block the webhook from returning 200.
    sendParseReply({ payload, result, logger }).catch((err) =>
      logger.error({ err: err.message }, "sendParseReply unexpected throw"),
    );

    return { result, pending_id: pendingId, source_file: sourceFilename };
  } catch (err) {
    const errorRecord = {
      status: "error",
      reason: "parser_exception",
      error: {
        message: err.message,
        stack: err.stack,
        raw_text: err.rawText,
      },
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(parsedPath, JSON.stringify(errorRecord, null, 2)).catch(() => {});
    logger.error({ err, file: sourceFilename }, "receipt parser failed");
    throw err;
  }
}

/**
 * Build a Postmark-shaped synthetic payload from a direct upload so it flows
 * through the same parser path as inbound emails. The triage stage looks at
 * `Attachments[].ContentType`; the prompt builder reads `Subject`/`From`/
 * `Date`/`TextBody` as context.
 */
export function buildUploadPayload({ filename, content_type, content_base64, description }) {
  // Estimate decoded byte size from base64 length. Off by a byte or two due
  // to padding; fine for the ContentLength field which is used only for the
  // 5MB size guard in normalize.js.
  const decodedBytes = Math.floor((content_base64.length * 3) / 4);
  return {
    From: "(uploaded by user)",
    Subject: filename || "Direct upload",
    Date: new Date().toUTCString(),
    TextBody: description?.trim() ? `User context: ${description.trim()}` : "",
    Attachments: [
      {
        Name: filename || "upload.bin",
        Content: content_base64,
        ContentType: content_type,
        ContentLength: decodedBytes,
      },
    ],
  };
}
