import { isInlineAttachment } from "./attachments.js";

// Pure-JS triage of an inbound Postmark payload.
// Classifies the payload before we pay for vision tokens.
//
// Outcomes:
//   { kind: "no_content", reason }              - empty/garbage/test stub
//   { kind: "cloud_link", links, skipped }      - body references Drive/Dropbox/etc.
//   { kind: "unsupported_format", skipped }     - only DOCX/ZIP/HEIC/etc. attached
//   { kind: "inline_html", skipped }            - no parseable attachments but the
//                                                 email has body content; the receipt
//                                                 may be embedded in HtmlBody/TextBody
//   { kind: "receipt_candidate", attachments, skipped }
//       - has at least one PDF/JPEG/PNG/WEBP/GIF; `attachments` entries carry _kind

const CLOUD_LINK_PATTERNS = [
  /drive\.google\.com\/file\/d\//i,
  /drive\.google\.com\/open\?id=/i,
  /docs\.google\.com\/(document|spreadsheets|presentation)\/d\//i,
  /dropbox\.com\/(s|scl)\//i,
  /onedrive\.live\.com\//i,
  /1drv\.ms\//i,
  /wetransfer\.com\/(downloads|t)\//i,
  /mega\.nz\//i,
  /icloud\.com\/iclouddrive\//i,
  /box\.com\/s\//i,
];

const URL_RE = /https?:\/\/[^\s<>"')]+/g;

const SUPPORTED_DOC_TYPES = new Set(["application/pdf"]);
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function triage(payload) {
  if (!payload || typeof payload !== "object") {
    return { kind: "no_content", reason: "empty_payload", skipped: [] };
  }

  const attachments = Array.isArray(payload.Attachments) ? payload.Attachments : [];
  const htmlBody = payload?.HtmlBody ?? "";
  const supported = [];
  const skipped = [];
  for (const att of attachments) {
    const kind = classifyAttachment(att);
    // Inline images embedded in the HTML body (signature logos, etc.) are
    // identified by a ContentID that's referenced as cid:... in HtmlBody.
    // They're never real receipts — skip before they cost vision tokens.
    if ((kind === "pdf" || kind === "image") && isInlineAttachment(att, htmlBody)) {
      skipped.push({
        name: att?.Name ?? "(unnamed)",
        content_type: att?.ContentType ?? null,
        size_bytes: att?.ContentLength ?? null,
        reason: "inline_signature",
      });
      continue;
    }
    if (kind === "pdf" || kind === "image") {
      supported.push({ ...att, _kind: kind });
    } else {
      skipped.push({
        name: att?.Name ?? "(unnamed)",
        content_type: att?.ContentType ?? null,
        size_bytes: att?.ContentLength ?? null,
        reason: kind,
      });
    }
  }

  if (supported.length > 0) {
    return { kind: "receipt_candidate", attachments: supported, skipped };
  }

  // No supported attachments — look for cloud links in body
  const bodyText = [payload.TextBody ?? "", payload.HtmlBody ?? ""].join("\n");
  const cloudLinks = extractCloudLinks(bodyText);
  if (cloudLinks.length > 0) {
    return { kind: "cloud_link", links: cloudLinks, skipped };
  }

  if (skipped.length > 0) {
    return { kind: "unsupported_format", skipped };
  }

  // No attachments, no cloud links. If the email has body content, treat it as
  // an inline-HTML receipt candidate — many vendors (Amazon, Stripe, Intuit,
  // DoorDash, Uber, etc.) email receipts as HTML with no attachment.
  if (hasBodyContent(payload)) {
    return { kind: "inline_html", skipped: [] };
  }
  return { kind: "no_content", reason: "no_attachments", skipped: [] };
}

function classifyAttachment(att) {
  if (!att || typeof att.ContentType !== "string") return "missing_content_type";
  const ct = att.ContentType.toLowerCase().split(";")[0].trim();
  if (SUPPORTED_DOC_TYPES.has(ct)) return "pdf";
  if (SUPPORTED_IMAGE_TYPES.has(ct)) return "image";
  if (ct === "image/heic" || ct === "image/heif") return "heic_unsupported_v1";
  if (ct === "message/rfc822") return "nested_email_unsupported_v1";
  if (ct.startsWith("application/vnd.openxmlformats")) return "office_doc_unsupported";
  if (ct === "application/msword" || ct === "application/vnd.ms-excel") return "legacy_office_unsupported";
  if (ct === "application/zip" || ct === "application/x-zip-compressed") return "zip_unsupported";
  return `unsupported:${ct}`;
}

function extractCloudLinks(text) {
  const found = new Set();
  const urls = text.match(URL_RE) ?? [];
  for (const url of urls) {
    if (CLOUD_LINK_PATTERNS.some((p) => p.test(url))) {
      found.add(url);
    }
  }
  return [...found];
}

function hasBodyContent(payload) {
  return Boolean(
    (payload.TextBody && payload.TextBody.trim()) ||
      (payload.HtmlBody && payload.HtmlBody.trim()),
  );
}
