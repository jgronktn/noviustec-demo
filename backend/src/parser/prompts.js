// Prompt construction for the receipt parser.
//
// Caching strategy: the stable parts (instructions + user's category/source
// taxonomy) go in the system array with cache_control: ephemeral on the last
// block. Per-receipt content (email metadata, attachments) goes in messages
// after the cache breakpoint.
//
// Caveat: Haiku 4.5's minimum cacheable prefix is 4096 tokens. With small
// dev category lists the marker is harmless but won't actually cache —
// usage.cache_read_input_tokens is the canonical check.

const SYSTEM_PROMPT_BASE = `You are a receipt parser for a bookkeeping system. You will be given EITHER one or more document/image attachments from an inbound email, OR the cleaned text of the email body itself (when the receipt is embedded in HTML rather than attached), plus the email's metadata. Your job is to classify the input and, if it is a receipt, extract its fields into the provided JSON schema.

Output rules:
- "status": "parsed" if you extracted clear receipt-equivalent data; "not_a_receipt" if the document is clearly something else (legal filing, personal photo, marketing flyer, plain message, calendar invite, contract, video, multi-line account statement covering many transactions, etc.); "ambiguous" if the document looks like a receipt-equivalent but key fields are unreadable or missing.
- A "receipt-equivalent" includes more than just vendor-issued receipts. The following all count as "parsed" if they document a single payment with clear fields:
  - vendor receipts / invoices / order confirmations
  - bank-issued payment confirmations and "Payment Details" pages (e.g. a check posting, a wire confirmation, an ACH transfer detail page)
  - check images and check stubs
  - Zelle / Venmo / Cash App / payment-app transaction confirmations
  These document an outgoing payment we need to book. Treat them like receipts. A multi-line bank/credit-card statement covering many transactions is NOT receipt-equivalent (one payment per document is the rule of thumb).
- "confidence": 0.0-1.0 self-assessed. Use < 0.5 when guessing significantly. For "not_a_receipt", confidence should be high if you are sure.
- "vendor.name": cleaned merchant name (e.g., "Starbucks", not "STARBUCKS STORE #04421 SEATTLE WA"). Null for non-receipts. If a "Known vendors" list is provided below and the merchant on this document is clearly one of them, use the EXACT spelling from that list — do not introduce a variant. Only invent a new vendor name when no listed vendor matches. For bank-issued payment confirmations (check images, "Payment Details" pages, ACH/wire confirmations, payment-app screenshots), vendor.name is the PAYEE — the recipient of the payment — NOT the bank that issued the document. The bank itself goes in suggested_payment_source.
- "vendor.raw_text": verbatim text near the merchant name, helpful for disambiguation.
- "date": transaction date in ISO YYYY-MM-DD format. Null if not visible.
- "total": the FINAL amount charged to the card or bank account, including any tax AND any tip (handwritten or printed). On a credit-card receipt where the printed "Total" line shows the pre-tip amount and a tip is written below it, you MUST add the tip into "total" yourself — the bookkeeping system needs to match the actual charge that hits the bank statement, not just the printed total. Use major units (12.34 for $12.34). Currency in ISO 4217 (USD, EUR, GBP, etc.).
- "reference_number": if the document prints an invoice number, receipt number, order number, transaction ID, check number, or confirmation code, populate {"value": "<verbatim string>", "kind": "<one of invoice/receipt/order/transaction/confirmation/other>"}.

  IMPORTANT — kind reflects what kind of DOCUMENT this is, NOT what the document happens to reference. A receipt that mentions an invoice number is still a RECEIPT (kind: "receipt"), not an invoice. Use this precedence to pick the kind:

    1. If the document is clearly a RECEIPT — labeled "Receipt", "Payment Receipt", "Order Receipt"; shows "Paid", "Paid in Full", "Payment Successful", "Thank you for your payment"; has a register-tape format with the payment already settled; or comes AFTER payment as a confirmation of money already moved — then kind = "receipt", regardless of whether the document also cites an invoice number, order number, or other reference. Use the receipt number itself as the value when visible; fall back to the cited invoice/order number only if no receipt number is printed. Note this in "notes" if you fell back.

    2. If the document is clearly an INVOICE — labeled "Invoice" with no payment confirmation; shows "Amount Due", "Due By", "Please remit"; is a bill being delivered to us asking for future payment — then kind = "invoice".

    3. If the document is an order confirmation that hasn't been paid/shipped yet, kind = "order".

    4. Bank "Payment Details" / check posting / ACH confirmation → kind = "confirmation".

    5. Generic transaction id (Uber trip, card auth code, etc.) when none of the above fit → kind = "transaction".

    6. Use "other" only when none fit.

  Examples — note the precedence:
    - Vendor PDF clearly labeled "Invoice #149011494" with "Amount Due" → {"value": "149011494", "kind": "invoice"}
    - Anthropic Receipt PDF that says "Receipt" at top, "Paid", AND cites "Invoice #INV-ABC" — {"value": "<receipt number>", "kind": "receipt"}. Only use the invoice number if no separate receipt number is printed, and say so in notes.
    - Register receipt with "Ref: A3F9B2" → {"value": "A3F9B2", "kind": "receipt"}
    - Uber email with "Trip ID: 12345-abc" → {"value": "12345-abc", "kind": "transaction"}
    - Bank "Payment Details" page for check #1234 → {"value": "1234", "kind": "confirmation"}

  Null if no reference number is visible.
- "line_items": individual line items where visible. Leave empty array if the receipt only shows a total. Each item has description, amount, and an optional per-item category from the provided list.
- "suggested_category": best-fit category from the provided list for the OVERALL transaction. Use the exact provided string. Null if you cannot confidently pick one.
- "suggested_payment_source": best-fit payment source from the provided list, based on visible card last-4, card brand, account info, or context. Use the exact provided string. Null if not determinable.
- "notes": brief freeform explanation. Use for low-confidence reasons, ambiguities, or why classification is not_a_receipt.

For "not_a_receipt": set vendor, date, total, suggested_category, suggested_payment_source all to null, leave line_items empty, briefly say why in notes.

Cloud-link documents, password-protected PDFs, or PDFs you cannot read: classify as "not_a_receipt" with high confidence and explain in notes — the user will retrieve content manually.

Below is the user's category and payment-source taxonomy. Use the provided values verbatim when suggesting — do not invent new ones.`;

export function buildSystemBlocks({ categories, paymentSources, knownVendors = [] }) {
  const taxonomy = formatTaxonomy(categories, paymentSources, knownVendors);
  return [
    { type: "text", text: SYSTEM_PROMPT_BASE },
    {
      type: "text",
      text: taxonomy,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function formatTaxonomy(categories, paymentSources, knownVendors) {
  const catLines = categories
    .map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`)
    .join("\n");
  const srcLines = paymentSources
    .map((s) => {
      const last4 = s.last4 ? ` (••${s.last4})` : "";
      const desc = s.description ? ` — ${s.description}` : "";
      return `- ${s.name}${last4}${desc}`;
    })
    .join("\n");
  const vendorLines = knownVendors.map((v) => `- ${v}`).join("\n");
  return (
    `## Categories\n${catLines || "(none provided)"}\n\n` +
    `## Payment sources\n${srcLines || "(none provided)"}\n\n` +
    `## Known vendors\n${vendorLines || "(none yet — first time seeing a vendor)"}`
  );
}

export function buildUserContent({ payload, contentBlocks }) {
  const metadataLines = [
    `Email subject: ${payload?.Subject ?? "(none)"}`,
    `From: ${payload?.From ?? "(unknown)"}`,
    `Received: ${payload?.Date ?? "(unknown)"}`,
  ];
  const body = payload?.TextBody?.trim();
  if (body) {
    metadataLines.push("", "Email body preview (forwarded email context may be here):", truncate(body, 1500));
  }
  return [
    ...contentBlocks,
    { type: "text", text: metadataLines.join("\n") },
  ];
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + "\n[...truncated]";
}
