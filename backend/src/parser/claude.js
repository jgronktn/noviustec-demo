// Anthropic SDK call for the receipt parser.
//
// Model: claude-haiku-4-5 (vision-capable, supports structured outputs).
// Structured output: output_config.format with the proposalSchema.
// Caching: cache_control on the last system block (set in prompts.js).
// Thinking: omitted — receipt parsing is one-shot extraction.

import Anthropic from "@anthropic-ai/sdk";
import { proposalSchema } from "./schema.js";
import { buildSystemBlocks, buildUserContent } from "./prompts.js";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1500;

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

export async function callVision({ payload, contentBlocks, categories, paymentSources, knownVendors }) {
  const client = getClient();
  const systemBlocks = buildSystemBlocks({ categories, paymentSources, knownVendors });
  const userContent = buildUserContent({ payload, contentBlocks });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemBlocks,
    output_config: {
      format: { type: "json_schema", schema: proposalSchema },
    },
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    const err = new Error("Claude returned no text block");
    err.response = response;
    throw err;
  }

  let proposal;
  try {
    proposal = JSON.parse(textBlock.text);
  } catch (parseErr) {
    const err = new Error(`Failed to parse JSON from Claude: ${parseErr.message}`);
    err.cause = parseErr;
    err.rawText = textBlock.text;
    throw err;
  }

  return {
    proposal,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    stop_reason: response.stop_reason,
  };
}
