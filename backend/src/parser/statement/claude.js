// Anthropic SDK call for the statement parser.
//
// Model: Sonnet 4.6 — statements are dense, tabular, and multi-page, which
// Haiku's vision pipeline struggles with. The cost premium is worth it.
// Adaptive thinking is on so the model can reason through layout quirks
// (split date columns, sign conventions, etc.) before emitting JSON.

import Anthropic from "@anthropic-ai/sdk";
import { statementSchema } from "./schema.js";
import { buildSystemBlocks, buildUserContent } from "./prompts.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export async function callStatementVision({ payload, contentBlocks }) {
  const client = getClient();
  const systemBlocks = buildSystemBlocks();
  const userContent = buildUserContent({ payload, contentBlocks });

  // Streamed so multi-page extractions don't trip request timeouts.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemBlocks,
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: statementSchema },
    },
    messages: [{ role: "user", content: userContent }],
  });

  const response = await stream.finalMessage();

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    const err = new Error("Statement parser returned no text block");
    err.response = response;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (parseErr) {
    const err = new Error(
      `Failed to parse JSON from statement parser: ${parseErr.message}`,
    );
    err.cause = parseErr;
    err.rawText = textBlock.text;
    throw err;
  }

  return {
    parsed,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    stop_reason: response.stop_reason,
  };
}
