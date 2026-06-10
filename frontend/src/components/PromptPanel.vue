<script setup>
import { ref, computed, nextTick, useTemplateRef } from "vue";
import { streamAgentResponse } from "../api.js";

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(["panel"]);

const prompt = ref("");
const busy = ref(false);
// turn: { kind: "user"|"agent", text: string, toolCalls?: [{ name, status, rows }], error?: string }
const history = ref([]);
const historyEl = useTemplateRef("historyEl");

const canSend = computed(() => prompt.value.trim().length > 0 && !busy.value);

function apiMessages() {
  return history.value
    .filter((t) => (t.text && t.text.length > 0) || t.kind === "user")
    .map((t) => ({
      role: t.kind === "user" ? "user" : "assistant",
      content: t.text,
    }));
}

async function scrollToBottom() {
  await nextTick();
  if (historyEl.value) historyEl.value.scrollTop = historyEl.value.scrollHeight;
}

async function submit() {
  const text = prompt.value.trim();
  if (!text || busy.value) return;
  busy.value = true;

  history.value.push({ kind: "user", text });
  const agentTurn = { kind: "agent", text: "", toolCalls: [], error: null };
  history.value.push(agentTurn);
  prompt.value = "";
  await scrollToBottom();

  try {
    const messages = apiMessages();
    await streamAgentResponse(props.token, messages, (event) => {
      if (event.type === "text_delta") {
        agentTurn.text += event.text;
        scrollToBottom();
      } else if (event.type === "tool_use") {
        agentTurn.toolCalls.push({
          id: event.id,
          name: event.name,
          status: "running",
          rows: null,
        });
        scrollToBottom();
      } else if (event.type === "tool_result") {
        const tc = agentTurn.toolCalls.find((c) => c.id === event.id);
        if (tc) {
          tc.status = event.ok ? "done" : "error";
          tc.rows = event.rows;
          tc.rendered = event.rendered ?? null;
        }
      } else if (event.type === "panel") {
        emit("panel", {
          id: crypto.randomUUID(),
          kind: event.kind,
          title: event.title,
          props: event.props,
          createdAt: Date.now(),
        });
      } else if (event.type === "error") {
        agentTurn.error = event.error;
      }
      // usage + done are recorded server-side; nothing to render here.
    });
  } catch (err) {
    agentTurn.error =
      err.status === 401 ? "Token rejected (401)" : err.message;
  } finally {
    busy.value = false;
    scrollToBottom();
  }
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="prompt-panel">
    <header class="head">
      <h3>Ask</h3>
    </header>

    <div v-if="history.length > 0" ref="historyEl" class="history">
      <div
        v-for="(turn, i) in history"
        :key="i"
        class="turn"
        :class="turn.kind"
      >
        <span class="label">{{ turn.kind === "user" ? "You" : "Agent" }}</span>
        <p v-if="turn.text" class="text">{{ turn.text }}</p>
        <p
          v-else-if="turn.kind === 'agent' && busy && i === history.length - 1 && (turn.toolCalls?.length ?? 0) === 0"
          class="text thinking"
        >
          Thinking…
        </p>
        <ul
          v-if="turn.toolCalls && turn.toolCalls.length > 0"
          class="tool-calls"
        >
          <li
            v-for="tc in turn.toolCalls"
            :key="tc.id"
            :class="['tool', `tool-${tc.status}`]"
          >
            <span class="tool-name">{{ tc.name }}</span>
            <span class="tool-status">
              <template v-if="tc.status === 'running'">…</template>
              <template v-else-if="tc.status === 'done'">
                {{ tc.rows != null ? `${tc.rows} rows` : "ok" }}
              </template>
              <template v-else>failed</template>
            </span>
          </li>
        </ul>
        <p v-if="turn.error" class="turn-error">⚠ {{ turn.error }}</p>
      </div>
    </div>

    <div v-else class="empty-hint">
      <p>Natural-language interface to your books.</p>
      <p class="examples">Try:</p>
      <ul>
        <li>"Show a vendor activity"</li>
        <li>"Show spend by category"</li>
        <li>"Show spend by month"</li>
        <li>"Show outstanding invoices"</li>
      </ul>
    </div>

    <form class="composer" @submit.prevent="submit">
      <textarea
        v-model="prompt"
        @keydown="onKeydown"
        :disabled="busy"
        placeholder="Ask anything about your books…"
        rows="3"
      />
      <div class="composer-actions">
        <span class="hint">⌘/Ctrl+Enter</span>
        <button type="submit" :disabled="!canSend" class="primary">
          {{ busy ? "…" : "Send" }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.prompt-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0.75rem;
  background: var(--surface);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.head h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.history {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  padding-right: 0.25rem;
}

.turn {
  font-size: 0.85rem;
}

.turn .label {
  font-weight: 600;
  font-size: 0.7rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.turn p.text {
  margin: 0.2rem 0 0;
  line-height: 1.4;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.turn.user p.text {
  color: var(--text);
}

.turn.agent p.text {
  color: var(--text);
}

.turn p.text.thinking {
  color: var(--text-muted);
  font-style: italic;
}

.turn-error {
  margin: 0.3rem 0 0;
  font-size: 0.75rem;
  color: var(--danger);
}

.tool-calls {
  margin: 0.3rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.tool {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.7rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
  background: #f0f0eb;
  border-radius: 3px;
  padding: 1px 6px;
  align-self: flex-start;
  max-width: 100%;
}

.tool-name::before {
  content: "🔧 ";
}

.tool-status {
  color: var(--text-muted);
}

.tool-done .tool-status {
  color: var(--ok);
}

.tool-error .tool-status {
  color: var(--danger);
}

.empty-hint {
  flex: 1;
  overflow-y: auto;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.empty-hint p {
  margin: 0 0 0.5rem;
}

.empty-hint .examples {
  margin-top: 0.75rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}

.empty-hint ul {
  margin: 0.25rem 0 0;
  padding-left: 1rem;
  list-style: disc;
}

.empty-hint li {
  margin-bottom: 0.25rem;
  line-height: 1.3;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: auto;
}

.composer textarea {
  resize: none;
  font-size: 0.85rem;
  padding: 0.5rem 0.6rem;
}

.composer textarea:disabled {
  opacity: 0.65;
}

.composer-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.composer-actions .hint {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.composer-actions button {
  padding: 0.35rem 0.9rem;
  font-size: 0.85rem;
}
</style>
