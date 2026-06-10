// JSON Schema for the receipt parser's structured output.
// Used with output_config.format on messages.create() — the API enforces this shape.
// Constraints: every object MUST have additionalProperties: false; no numeric/string
// length constraints (silently dropped). See shared/prompt-caching.md and the
// Structured Outputs section of the Claude API docs.

export const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "confidence",
    "vendor",
    "date",
    "total",
    "reference_number",
    "line_items",
    "suggested_category",
    "suggested_payment_source",
    "notes",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["parsed", "not_a_receipt", "ambiguous"],
      description:
        "parsed = clear receipt extracted; not_a_receipt = the document is clearly not a receipt; ambiguous = looks like a receipt but key fields are unreadable.",
    },
    confidence: {
      type: "number",
      description:
        "Self-assessed confidence in the extracted fields, 0.0 to 1.0. Use < 0.5 when guessing significantly. For not_a_receipt, confidence should be high if you're sure.",
    },
    vendor: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "raw_text"],
          properties: {
            name: {
              type: "string",
              description: "Cleaned merchant name (e.g., 'Starbucks').",
            },
            raw_text: {
              type: "string",
              description:
                "Verbatim text near the merchant name, useful for disambiguation.",
            },
          },
        },
        { type: "null" },
      ],
    },
    date: {
      anyOf: [
        {
          type: "string",
          description: "Transaction date in ISO YYYY-MM-DD format.",
        },
        { type: "null" },
      ],
    },
    total: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["amount", "currency"],
          properties: {
            amount: {
              type: "number",
              description: "Final amount paid in major units (12.34 for $12.34).",
            },
            currency: {
              type: "string",
              description: "ISO 4217 currency code (USD, EUR, GBP, etc.).",
            },
          },
        },
        { type: "null" },
      ],
    },
    reference_number: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["value", "kind"],
          properties: {
            value: {
              type: "string",
              description:
                "Reference number printed on the document, verbatim. Examples: 'INV-2026-0042', '149011494', 'TXN-A3F9B2'.",
            },
            kind: {
              type: "string",
              enum: ["invoice", "receipt", "order", "transaction", "confirmation", "other"],
              description:
                "What kind of reference number this is. invoice = invoice number; receipt = receipt number / register reference; order = order number; transaction = card/payment transaction ID; confirmation = booking/order confirmation code; other = anything else (use sparingly).",
            },
          },
        },
        { type: "null" },
      ],
    },
    line_items: {
      type: "array",
      description:
        "Individual items where visible. Leave empty if the document only shows a total.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "amount", "category"],
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
          category: {
            anyOf: [
              {
                type: "string",
                description:
                  "Best-fit per-item category from the provided list. Null if not assignable.",
              },
              { type: "null" },
            ],
          },
        },
      },
    },
    suggested_category: {
      anyOf: [
        {
          type: "string",
          description:
            "Best-fit category from the provided list for the overall transaction. Use the provided value verbatim.",
        },
        { type: "null" },
      ],
    },
    suggested_payment_source: {
      anyOf: [
        {
          type: "string",
          description:
            "Best-fit payment source from the provided list, based on visible card last-4, brand, account info, or context.",
        },
        { type: "null" },
      ],
    },
    notes: {
      type: "string",
      description:
        "Brief freeform explanation: low-confidence reasons, ambiguities, or why status is not_a_receipt.",
    },
  },
};
