// JSON schema for the statement parser's structured output.
//
// Used with output_config.format on messages.create() — the Anthropic API
// enforces this shape. Constraints learned the hard way:
// - every object needs additionalProperties: false
// - no minimum / maximum / minLength etc (silently dropped at best, 400'd at worst)
// - nullables use anyOf: [{...}, {type: "null"}] — `type: ["string","null"]`
//   with an enum gets rejected ("Enum value X does not match declared type")
// - enums only inside the non-null branch of an anyOf, never alongside a
//   nullable type union.
//
// Two-tier shape: top-level metadata + a flat array of transaction lines.
// Amounts on lines are SIGNED — negative = charge/withdrawal/debit,
// positive = payment/deposit/credit. The model is told this in the prompt.

const nullable = (...schemas) => ({ anyOf: [...schemas, { type: "null" }] });

// Anthropic structured outputs has a hard cap of 16 union-typed
// (nullable / anyOf) parameters per schema. Counting carefully: every
// field below that uses `nullable()` adds one to that budget. We're at
// the limit — see the comment block before each property to keep the
// budget visible if you add more fields.
export const statementSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "confidence",
    "notes",
    "source",
    "period",
    "currency",
    "balances",
    "lines",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["parsed", "not_a_statement", "ambiguous"],
    },
    confidence: {
      type: "number",
      description:
        "Self-assessed confidence 0.0-1.0. Use < 0.5 when significant fields are guessed.",
    },
    // Always-string. Empty string when there's nothing to say.
    notes: { type: "string" },

    // Nullable so the model can return null for not_a_statement cases.   [1]
    source: nullable({
      type: "object",
      additionalProperties: false,
      required: ["name", "last4", "institution", "kind"],
      properties: {
        name: nullable({ type: "string" }), // [2]
        last4: nullable({ type: "string" }), // [3]
        institution: nullable({ type: "string" }), // [4]
        kind: nullable({
          // [5]
          type: "string",
          enum: ["credit_card", "bank_account", "cash", "other"],
        }),
      },
    }),

    period: nullable({
      // [6]
      type: "object",
      additionalProperties: false,
      required: ["start", "end", "statement_date"],
      properties: {
        start: nullable({ type: "string" }), // [7]  YYYY-MM-DD
        end: nullable({ type: "string" }), // [8]
        statement_date: nullable({ type: "string" }), // [9]  close / issue date
      },
    }),

    // Always-string. Use "USD" as the default when the document doesn't
    // explicitly state a currency.
    currency: { type: "string" },

    balances: nullable({
      // [10]
      type: "object",
      additionalProperties: false,
      required: ["opening", "closing", "total_charges", "total_payments"],
      properties: {
        opening: nullable({ type: "number" }), // [11]
        closing: nullable({ type: "number" }), // [12]
        total_charges: nullable({ type: "number" }), // [13]  positive sum of charges
        total_payments: nullable({ type: "number" }), // [14]
      },
    }),

    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line_date", "description", "amount", "balance_after", "notes"],
        properties: {
          line_date: nullable({ type: "string" }), // [15]  YYYY-MM-DD if visible
          // Always-string. Empty string only if the line really has no
          // description text (very rare).
          description: { type: "string" },
          amount: { type: "number" }, // SIGNED — see prompt
          balance_after: nullable({ type: "number" }), // [16]
          // Always-string. Empty by default.
          notes: { type: "string" },
        },
      },
    },
  },
};
