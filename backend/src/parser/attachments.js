// Shared helpers for classifying Postmark attachments.
//
// `isInlineAttachment` detects embeds like email-signature logos that
// have a ContentID AND are referenced as `cid:<ContentID>` inside the
// HtmlBody. Gmail, Outlook, and most clients use this pattern for any
// image laid out inline in HTML — never for a "real" attachment the
// sender wants you to open. Filtering these out:
//
//   - keeps signature logos from polluting the vendor's documents/
//     folder when an invoice is archived
//   - saves vision tokens when the parser would otherwise send a 8KB
//     logo PNG to Haiku alongside the real receipt/invoice

export function isInlineAttachment(att, htmlBody) {
  if (!att || typeof att.ContentID !== "string" || att.ContentID.length === 0) return false;
  if (typeof htmlBody !== "string" || htmlBody.length === 0) return false;
  return htmlBody.includes(`cid:${att.ContentID}`);
}
