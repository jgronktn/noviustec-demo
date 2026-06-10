// Receipt parser entry point.
//
// parseReceipt(payload, { categories, paymentSources })
//   - payload: Postmark inbound webhook body (parsed JSON object)
//   - categories: [{ name, description? }]
//   - paymentSources: [{ name, last4?, description? }]
//
// Returns:
//   {
//     status: "parsed" | "not_a_receipt" | "needs_attention" | "no_content",
//     reason: string | null,           // why, when status != "parsed"
//     proposal: <proposalSchema> | null,
//     source: { from, subject, received_at, attachments_seen, skipped },
//     usage: { input_tokens, output_tokens, cache_*_input_tokens } | null,
//     cloud_links?: string[],          // only when reason === "cloud_link"
//     oversize?: [{ name, bytes }],    // only when reason === "oversize_attachments"
//   }

import { triage } from "./triage.js";
import { buildContentBlocks } from "./normalize.js";
import { buildInlineHtmlBlock } from "./inline-html.js";
import { callVision } from "./claude.js";

export async function parseReceipt(payload, options = {}) {
  const { categories = [], paymentSources = [], knownVendors = [] } = options;
  const triageResult = triage(payload);

  if (triageResult.kind === "no_content") {
    return baseResult({
      status: "no_content",
      reason: triageResult.reason,
      payload,
      triageResult,
    });
  }

  if (triageResult.kind === "cloud_link") {
    return {
      ...baseResult({
        status: "needs_attention",
        reason: "cloud_link",
        payload,
        triageResult,
      }),
      cloud_links: triageResult.links,
    };
  }

  if (triageResult.kind === "unsupported_format") {
    return baseResult({
      status: "needs_attention",
      reason: "unsupported_format",
      payload,
      triageResult,
    });
  }

  if (triageResult.kind === "inline_html") {
    const block = buildInlineHtmlBlock({
      htmlBody: payload?.HtmlBody,
      textBody: payload?.TextBody,
    });
    if (!block) {
      return baseResult({
        status: "no_content",
        reason: "empty_body",
        payload,
        triageResult,
      });
    }
    return callAndMap({
      payload,
      triageResult,
      contentBlocks: [block],
      categories,
      paymentSources,
      knownVendors,
    });
  }

  // receipt_candidate
  const { blocks, oversize, compressed } = await buildContentBlocks(triageResult.attachments);
  if (blocks.length === 0) {
    return {
      ...baseResult({
        status: "needs_attention",
        reason: oversize.length > 0 ? "oversize_attachments" : "no_processable_content",
        payload,
        triageResult,
      }),
      ...(oversize.length > 0 ? { oversize } : {}),
    };
  }

  return callAndMap({
    payload,
    triageResult,
    contentBlocks: blocks,
    categories,
    paymentSources,
    knownVendors,
    extra: {
      ...(oversize.length > 0 ? { oversize } : {}),
      ...(compressed.length > 0 ? { compressed } : {}),
    },
  });
}

async function callAndMap({ payload, triageResult, contentBlocks, categories, paymentSources, knownVendors, extra = {} }) {
  const { proposal, usage, stop_reason } = await callVision({
    payload,
    contentBlocks,
    categories,
    paymentSources,
    knownVendors,
  });

  const mapped = mapModelStatus(proposal.status, proposal.confidence);
  return {
    status: mapped.status,
    reason: mapped.reason,
    proposal,
    source: extractSource(payload, triageResult),
    usage,
    stop_reason,
    ...extra,
  };
}

function mapModelStatus(modelStatus, confidence) {
  if (modelStatus === "parsed") {
    if (typeof confidence === "number" && confidence < 0.5) {
      return { status: "needs_attention", reason: "low_confidence" };
    }
    return { status: "parsed", reason: null };
  }
  if (modelStatus === "not_a_receipt") return { status: "not_a_receipt", reason: null };
  if (modelStatus === "ambiguous") return { status: "needs_attention", reason: "ambiguous" };
  return { status: "needs_attention", reason: "unknown_model_status" };
}

function baseResult({ status, reason, payload, triageResult }) {
  return {
    status,
    reason,
    proposal: null,
    source: extractSource(payload, triageResult),
    usage: null,
  };
}

function extractSource(payload, triageResult) {
  const attachmentsSeen = (payload?.Attachments ?? []).map((a) => ({
    name: a?.Name ?? null,
    content_type: a?.ContentType ?? null,
    size_bytes: a?.ContentLength ?? null,
  }));
  return {
    from: payload?.From ?? null,
    subject: payload?.Subject ?? null,
    received_at: payload?.Date ?? null,
    attachments_seen: attachmentsSeen,
    skipped: triageResult?.skipped ?? [],
  };
}
