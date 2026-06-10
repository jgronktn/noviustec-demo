// Reply-by-email after parsing an inbound receipt/invoice.
//
// When a user emails a receipt to our Postmark inbound address we now
// send a confirmation reply back: "got your email — here's what we
// extracted" on success, or "got it but couldn't parse" on failure.
//
// Direct UI uploads have no real sender (From: "(uploaded by user)"),
// so the email module silently no-ops on those — the natural filter is
// extractSenderEmail() returning null for non-RFC-822 senders.
//
// Postmark's outbound API uses the same server token as inbound (server
// tokens are bidirectional), so no new credential is required. Two
// env vars gate the feature:
//   POSTMARK_TOKEN — already set for inbound
//   POSTMARK_FROM  — sender address, e.g. notifications@demo.noviustec.com.
//                    Must be on a domain you've verified with Postmark
//                    (DKIM/SPF). If unset, this module no-ops.

const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";

export async function sendParseReply({ payload, result, logger }) {
  const token = process.env.POSTMARK_TOKEN;
  const from = process.env.POSTMARK_FROM;
  if (!token || !from) {
    logger?.debug?.(
      {
        missing: !token ? "POSTMARK_TOKEN" : "POSTMARK_FROM",
      },
      "parse-reply email skipped — config incomplete",
    );
    return { sent: false, reason: "config_incomplete" };
  }

  const senderEmail = extractSenderEmail(payload);
  if (!senderEmail) {
    // Direct uploads + uploads with synthetic senders land here.
    return { sent: false, reason: "no_sender" };
  }

  const subject = buildReplySubject(payload);
  const { text, html } = buildReplyBody({ payload, result });

  try {
    const res = await fetch(POSTMARK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: from,
        To: senderEmail,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
        MessageStream: "outbound",
      }),
    });
    if (!res.ok) {
      let body = {};
      try {
        body = await res.json();
      } catch {}
      logger?.error?.(
        { status: res.status, body, to: senderEmail },
        "Postmark reply send failed",
      );
      return { sent: false, reason: "postmark_error", status: res.status };
    }
    const data = await res.json();
    logger?.info?.(
      {
        to: senderEmail,
        postmark_message_id: data.MessageID,
        parse_status: result.status,
        parse_reason: result.reason ?? null,
      },
      "parse-reply email sent",
    );
    return { sent: true, postmark_message_id: data.MessageID };
  } catch (err) {
    logger?.error?.(
      { err: err.message, to: senderEmail },
      "Postmark reply send threw",
    );
    return { sent: false, reason: "exception" };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function extractSenderEmail(payload) {
  if (payload?.FromFull?.Email) return payload.FromFull.Email.trim();
  const from = String(payload?.From ?? "").trim();
  // Form: "Name <email@example.com>"
  const bracket = from.match(/<\s*([^>]+?)\s*>/);
  if (bracket) return bracket[1];
  // Bare email — skip synthetic senders like "(uploaded by user)"
  if (from.includes("@") && !from.startsWith("(")) return from;
  return null;
}

function buildReplySubject(payload) {
  const orig = String(payload?.Subject ?? "").trim() || "your receipt";
  // Don't double-prefix; case-insensitive match.
  return /^re:\s/i.test(orig) ? orig : `Re: ${orig}`;
}

function fmtAmount(amount, currency = "USD") {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

function buildReplyBody({ payload, result }) {
  const status = result?.status ?? "unknown";
  const reason = result?.reason ?? null;
  const proposal = result?.proposal ?? null;

  // ── Success path ─────────────────────────────────────────────────────
  if (status === "parsed") {
    return buildSuccessBody({ proposal });
  }

  // ── Low-confidence success ──────────────────────────────────────────
  if (status === "needs_attention" && reason === "low_confidence") {
    return buildLowConfidenceBody({ proposal });
  }

  // ── Specific failure reasons ─────────────────────────────────────────
  if (status === "needs_attention" && reason === "cloud_link") {
    return buildCloudLinkBody({ payload, result });
  }
  if (status === "needs_attention" && reason === "oversize_attachments") {
    return buildOversizeBody({ result });
  }
  if (status === "needs_attention" && reason === "unsupported_format") {
    return buildUnsupportedBody({ result });
  }
  if (status === "no_content" || reason === "empty_body" || reason === "no_processable_content") {
    return buildNoContentBody();
  }

  // ── Generic not-a-receipt or unknown failure ────────────────────────
  if (status === "not_a_receipt") {
    return buildNotAReceiptBody({ result });
  }

  return buildGenericFailureBody({ status, reason });
}

const SIGNATURE_TEXT = "\n— Noviustec\n";
const SIGNATURE_HTML = `<p style="color:#888;font-size:12px;margin-top:24px">— Noviustec</p>`;

function wrapHtml(inner) {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:560px">${inner}${SIGNATURE_HTML}</body></html>`;
}

function buildSuccessBody({ proposal }) {
  const vendor = proposal?.vendor?.name ?? "(not extracted)";
  const date = proposal?.date ?? "(not extracted)";
  const amount = proposal?.total?.amount ?? null;
  const currency = proposal?.total?.currency ?? "USD";
  const total = amount != null ? fmtAmount(amount, currency) : "(not extracted)";
  const refValue = proposal?.reference_number?.value ?? null;
  const refKind = proposal?.reference_number?.kind ?? null;
  const refLine = refValue ? `${refValue}${refKind ? ` (${refKind})` : ""}` : "(none)";
  const category = proposal?.suggested_category ?? "(uncategorized)";

  const text =
    `Got your email — here's what we extracted:\n\n` +
    `  Vendor:     ${vendor}\n` +
    `  Date:       ${date}\n` +
    `  Total:      ${total}\n` +
    `  Reference:  ${refLine}\n` +
    `  Category:   ${category}\n\n` +
    `This entry is now in your inbox awaiting your review at demo.noviustec.com.` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email — here's what we extracted:</p>` +
      `<table cellpadding="4" style="border-collapse:collapse;font-size:14px">` +
      `<tr><td style="color:#666">Vendor</td><td><strong>${escapeHtml(vendor)}</strong></td></tr>` +
      `<tr><td style="color:#666">Date</td><td>${escapeHtml(date)}</td></tr>` +
      `<tr><td style="color:#666">Total</td><td><strong>${escapeHtml(total)}</strong></td></tr>` +
      `<tr><td style="color:#666">Reference</td><td>${escapeHtml(refLine)}</td></tr>` +
      `<tr><td style="color:#666">Category</td><td>${escapeHtml(category)}</td></tr>` +
      `</table>` +
      `<p>This entry is now in your inbox awaiting your review at <a href="https://demo.noviustec.com">demo.noviustec.com</a>.</p>`,
  );

  return { text, html };
}

function buildLowConfidenceBody({ proposal }) {
  const vendor = proposal?.vendor?.name ?? "(not extracted)";
  const amount = proposal?.total?.amount ?? null;
  const currency = proposal?.total?.currency ?? "USD";
  const total = amount != null ? fmtAmount(amount, currency) : "(not extracted)";

  const text =
    `Got your email. I extracted some data but the confidence is low — please double-check before approving:\n\n` +
    `  Vendor:  ${vendor}\n` +
    `  Total:   ${total}\n\n` +
    `Review it at demo.noviustec.com.` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email. I extracted some data but the <strong>confidence is low</strong> — please double-check before approving:</p>` +
      `<p>Vendor: ${escapeHtml(vendor)}<br>Total: ${escapeHtml(total)}</p>` +
      `<p>Review it at <a href="https://demo.noviustec.com">demo.noviustec.com</a>.</p>`,
  );

  return { text, html };
}

function buildCloudLinkBody({ result }) {
  const links = (result?.cloud_links ?? []).slice(0, 5);
  const linksText = links.length > 0 ? `\n\nLinks I saw:\n${links.map((l) => `  - ${l}`).join("\n")}` : "";
  const linksHtml =
    links.length > 0
      ? `<p>Links I saw:</p><ul>${links.map((l) => `<li><code>${escapeHtml(l)}</code></li>`).join("")}</ul>`
      : "";

  const text =
    `Got your email, but it points at cloud-hosted files (Drive / Dropbox / OneDrive etc.) — I can't follow those automatically.\n\n` +
    `Please download the file and reply with it as a direct attachment, or upload it at demo.noviustec.com.${linksText}` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email, but it points at cloud-hosted files (Drive / Dropbox / OneDrive etc.) — I can't follow those automatically.</p>` +
      `<p>Please download the file and reply with it as a direct attachment, or upload it at <a href="https://demo.noviustec.com">demo.noviustec.com</a>.</p>` +
      linksHtml,
  );

  return { text, html };
}

function buildOversizeBody({ result }) {
  const oversize = (result?.oversize ?? []).map((o) => `${o.name} (${o.bytes} bytes)`);
  const listText = oversize.length > 0 ? `\n\n  ${oversize.join("\n  ")}` : "";
  const text =
    `Got your email, but the attachment(s) are too large for me to process${listText}\n\n` +
    `Try compressing the file or uploading directly at demo.noviustec.com.` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email, but the attachment(s) are too large for me to process.</p>` +
      (oversize.length > 0
        ? `<ul>${oversize.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>`
        : "") +
      `<p>Try compressing the file or uploading directly at <a href="https://demo.noviustec.com">demo.noviustec.com</a>.</p>`,
  );

  return { text, html };
}

function buildUnsupportedBody({ result }) {
  const text =
    `Got your email, but I couldn't read the attachment format. I currently handle PDF, JPG, PNG, WEBP, and GIF.\n\n` +
    `If this is a receipt, please re-send as one of those formats or upload at demo.noviustec.com.` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email, but I couldn't read the attachment format. I currently handle <strong>PDF, JPG, PNG, WEBP, GIF</strong>.</p>` +
      `<p>If this is a receipt, please re-send as one of those formats or upload at <a href="https://demo.noviustec.com">demo.noviustec.com</a>.</p>`,
  );

  return { text, html };
}

function buildNoContentBody() {
  const text =
    `Got your email, but I didn't find any readable content — no attachments and no usable email body. Could you re-send the receipt as a PDF or image attachment?` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email, but I didn't find any readable content — no attachments and no usable email body.</p>` +
      `<p>Could you re-send the receipt as a PDF or image attachment?</p>`,
  );

  return { text, html };
}

function buildNotAReceiptBody({ result }) {
  const notes = result?.proposal?.notes ?? null;
  const notesText = notes ? `\n\nReason: ${notes}` : "";
  const text =
    `Got your email, but I couldn't identify it as a receipt or invoice. Nothing has been added to your books.${notesText}\n\n` +
    `If this should be tracked anyway, you can upload it manually at demo.noviustec.com.` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email, but I couldn't identify it as a receipt or invoice. Nothing has been added to your books.</p>` +
      (notes ? `<p style="color:#666"><em>Reason: ${escapeHtml(notes)}</em></p>` : "") +
      `<p>If this should be tracked anyway, you can upload it manually at <a href="https://demo.noviustec.com">demo.noviustec.com</a>.</p>`,
  );

  return { text, html };
}

function buildGenericFailureBody({ status, reason }) {
  const text =
    `Got your email, but I couldn't parse the financial details (status: ${status}${reason ? `, reason: ${reason}` : ""}).\n\n` +
    `You can upload it manually at demo.noviustec.com to track it anyway.` +
    SIGNATURE_TEXT;

  const html = wrapHtml(
    `<p>Got your email, but I couldn't parse the financial details (status: <code>${escapeHtml(status)}</code>${reason ? `, reason: <code>${escapeHtml(reason)}</code>` : ""}).</p>` +
      `<p>You can upload it manually at <a href="https://demo.noviustec.com">demo.noviustec.com</a> to track it anyway.</p>`,
  );

  return { text, html };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
