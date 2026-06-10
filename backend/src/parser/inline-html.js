// Convert the HTML/text body of an email into a text content block for Claude.
// Used when there are no parseable attachments but the receipt is embedded in
// the email body itself (Amazon, Stripe, Intuit, DoorDash, etc.).

import { convert } from "html-to-text";

const MAX_TEXT_LEN = 50_000; // ~12K tokens of plain text — generous; real receipts <10K

const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false,
  selectors: [
    // Skip tracking pixels, layout images, and any other inline graphics
    { selector: "img", format: "skip" },
    // Preserve link URLs (helpful for receipt links / view-in-browser fallbacks)
    {
      selector: "a",
      options: { ignoreHref: false, hideLinkHrefIfSameAsText: true },
    },
    // Strip head/style/script — they shouldn't render but some clients embed them
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "head", format: "skip" },
  ],
};

/**
 * Build a single text content block from the email body.
 * Prefers HtmlBody (more structure), falls back to TextBody.
 * Returns null if neither body has meaningful content.
 */
export function buildInlineHtmlBlock({ htmlBody, textBody }) {
  let extracted = "";

  if (htmlBody && htmlBody.trim()) {
    try {
      extracted = convert(htmlBody, HTML_TO_TEXT_OPTIONS).trim();
    } catch {
      // Fall through to TextBody if conversion fails
      extracted = "";
    }
  }

  // Fall back to TextBody when HTML conversion yielded nothing or HtmlBody was empty
  if (!extracted && textBody && textBody.trim()) {
    extracted = textBody.trim();
  }

  if (!extracted) return null;

  if (extracted.length > MAX_TEXT_LEN) {
    extracted = extracted.slice(0, MAX_TEXT_LEN) + "\n[...truncated]";
  }

  return {
    type: "text",
    text:
      "--- BEGIN EMAIL BODY ---\n" +
      "This email has no PDF or image attachment. Any receipt content is embedded in the email body below. " +
      "Treat the body as the receipt source: extract vendor, date, total, line items, etc., from it.\n\n" +
      extracted +
      "\n--- END EMAIL BODY ---",
  };
}
