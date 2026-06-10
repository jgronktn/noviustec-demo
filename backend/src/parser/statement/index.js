// Statement parser entry point.
//
// parseStatement(payload, options)
//   - payload: Postmark-shaped or upload-shaped payload with a single
//     statement PDF attachment.
// Returns:
//   {
//     status: "parsed" | "not_a_statement" | "ambiguous" | "no_content",
//     reason: string | null,
//     extracted: { source, period, currency, balances, lines, notes } | null,
//     validation: { balance_check, balance_check_diff } | null,
//     source: { from, subject, received_at },
//     usage: { ... } | null,
//   }

import { buildContentBlocks } from "../normalize.js";
import { callStatementVision } from "./claude.js";

const BALANCE_TOLERANCE = 0.01;

export async function parseStatement(payload, _options = {}) {
  const attachments = payload?.Attachments ?? [];
  // For statements we expect exactly one PDF; if there are multiple we
  // process the largest. Tag each with the `_kind` discriminator that
  // buildContentBlocks expects — the receipt parser's triage step adds
  // this automatically, but we bypass triage here.
  const supported = [];
  for (const a of attachments) {
    if (typeof a?.ContentType !== "string") continue;
    const ct = a.ContentType.toLowerCase().split(";")[0].trim();
    if (ct === "application/pdf") {
      supported.push({ ...a, _kind: "pdf" });
    } else if (
      ct === "image/jpeg" ||
      ct === "image/png" ||
      ct === "image/webp" ||
      ct === "image/gif"
    ) {
      supported.push({ ...a, _kind: "image" });
    }
  }
  if (supported.length === 0) {
    return baseResult({
      status: "no_content",
      reason: "no_processable_attachments",
      payload,
    });
  }

  // Just pick the largest; statement uploads are single-doc by design.
  supported.sort((a, b) => (b.ContentLength ?? 0) - (a.ContentLength ?? 0));
  const winner = supported.slice(0, 1);

  const { blocks, oversize } = await buildContentBlocks(winner);
  if (blocks.length === 0) {
    return baseResult({
      status: "needs_attention",
      reason: oversize.length > 0 ? "oversize_attachments" : "no_processable_content",
      payload,
    });
  }

  let result;
  try {
    result = await callStatementVision({ payload, contentBlocks: blocks });
  } catch (err) {
    return baseResult({
      status: "needs_attention",
      reason: "parser_exception",
      payload,
      error: err.message,
    });
  }

  const { parsed, usage, stop_reason } = result;

  // Validation: sum of signed line amounts ≈ closing − opening.
  let validation = null;
  if (
    parsed?.balances?.opening != null &&
    parsed?.balances?.closing != null &&
    Array.isArray(parsed.lines)
  ) {
    const lineSum = parsed.lines.reduce(
      (s, ln) => s + (Number(ln.amount) || 0),
      0,
    );
    const expected = parsed.balances.closing - parsed.balances.opening;
    const diff = Math.abs(lineSum - expected);
    validation = {
      balance_check: diff <= BALANCE_TOLERANCE ? "ok" : "mismatch",
      balance_check_diff: Math.round(diff * 100) / 100,
      lines_sum: Math.round(lineSum * 100) / 100,
      expected_change: Math.round(expected * 100) / 100,
    };
  }

  return {
    status: parsed.status ?? "ambiguous",
    reason: parsed.status === "parsed" ? null : (parsed.notes || null),
    extracted: parsed.status === "parsed" ? parsed : null,
    validation,
    source: extractSource(payload),
    usage,
    stop_reason,
  };
}

function baseResult({ status, reason, payload, error }) {
  return {
    status,
    reason: reason ?? null,
    extracted: null,
    validation: null,
    source: extractSource(payload),
    usage: null,
    ...(error ? { error } : {}),
  };
}

function extractSource(payload) {
  return {
    from: payload?.From ?? null,
    subject: payload?.Subject ?? null,
    received_at: payload?.Date ?? null,
  };
}
