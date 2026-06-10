// Manual tool-use loop for the bookkeeping agent.
//
// Yields SSE-shaped events: text_delta, tool_use, tool_result, usage, done,
// error. The route handler converts each yielded event into an SSE data
// frame. Streaming uses messages.stream() so text appears word-by-word in
// the UI rather than after a long pause.

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemBlocks } from "./prompt.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { runTool } from "./handlers.js";

const MODEL = "claude-sonnet-4-6";
// Bumped from 4096 — adaptive thinking shares this budget with the
// visible output. Reconciliation-style questions over a moderately sized
// ledger (dozens of GL rows + pending) burn through the smaller budget
// before producing any visible answer.
const MAX_TOKENS = 12000;
const MAX_TURNS = 8;

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export async function* runAgent({ messages, logger, companyName }) {
  const client = getClient();
  const currentDate = new Date().toISOString().slice(0, 10);
  const system = buildSystemBlocks({
    companyName: companyName || "Noviustec",
    currentDate,
  });

  let workingMessages = [...messages];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOL_DEFINITIONS,
      thinking: { type: "adaptive" },
      messages: workingMessages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        yield { type: "text_delta", text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: "usage",
      usage: {
        input_tokens: finalMessage.usage?.input_tokens ?? 0,
        output_tokens: finalMessage.usage?.output_tokens ?? 0,
        cache_creation_input_tokens:
          finalMessage.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens:
          finalMessage.usage?.cache_read_input_tokens ?? 0,
      },
      stop_reason: finalMessage.stop_reason,
      turn,
    };

    if (finalMessage.stop_reason !== "tool_use") {
      logger?.info?.(
        {
          turn,
          stop_reason: finalMessage.stop_reason,
          usage: finalMessage.usage,
        },
        "agent loop finished",
      );
      yield { type: "done", stop_reason: finalMessage.stop_reason };
      return;
    }

    const toolUses = finalMessage.content.filter((b) => b.type === "tool_use");
    const toolResults = [];
    for (const tu of toolUses) {
      yield { type: "tool_use", id: tu.id, name: tu.name, input: tu.input };
      let result;
      let isError = false;
      try {
        result = await runTool(tu.name, tu.input);
      } catch (err) {
        result = { error: err.message };
        isError = true;
        logger?.error?.(
          { tool: tu.name, input: tu.input, err: err.message },
          "agent tool handler failed",
        );
      }

      // Render tools embed a __panel sentinel. Pop it off, yield as a
      // separate `panel` event for the frontend canvas, and let the rest
      // of the result flow back to the model as the tool_result content.
      let panel = null;
      if (result && typeof result === "object" && result.__panel) {
        panel = result.__panel;
        delete result.__panel;
        yield {
          type: "panel",
          tool_use_id: tu.id,
          kind: panel.kind,
          title: panel.title,
          props: panel.props,
        };
      }

      // Tools that need to feed binary content (PDFs, images) into the
      // conversation embed a __tool_content sentinel — an array of
      // Anthropic content blocks (document / image / text). The model
      // receives those blocks verbatim as the tool_result content, not a
      // JSON-stringified version. Strip the sentinel from the result
      // object before logging / SSE so we don't ship base64 to the
      // browser.
      let toolResultContent;
      let loadedContentKinds = null;
      if (result && Array.isArray(result.__tool_content)) {
        toolResultContent = result.__tool_content;
        loadedContentKinds = result.__tool_content
          .map((b) => b?.type)
          .filter(Boolean);
        delete result.__tool_content;
      } else {
        toolResultContent = JSON.stringify(result);
      }

      yield {
        type: "tool_result",
        id: tu.id,
        name: tu.name,
        ok: !isError,
        rows: typeof result?.count === "number" ? result.count : null,
        rendered: panel ? panel.kind : null,
        loaded_content: loadedContentKinds,
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: toolResultContent,
        is_error: isError,
      });
    }

    workingMessages = [
      ...workingMessages,
      { role: "assistant", content: finalMessage.content },
      { role: "user", content: toolResults },
    ];
  }

  logger?.warn?.({ max_turns: MAX_TURNS }, "agent exceeded max turns");
  yield { type: "error", error: `Agent exceeded max turns (${MAX_TURNS})` };
}
