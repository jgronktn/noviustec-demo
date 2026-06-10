<script setup>
import { ref, inject, onMounted } from "vue";
import { recordTransferPayment, getPaymentSources } from "../api.js";

const props = defineProps({
  // { id, vendor (the to_source), amount, currency, date }
  awaiting: { type: Object, required: true },
});
const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");

const today = new Date().toISOString().slice(0, 10);
const form = ref({
  date: today,
  from_source: "",
  description: "",
  notes: "",
});

const paymentSources = ref([]);
const loadingLookups = ref(true);
const submitting = ref(false);
const error = ref(null);

async function loadLookups() {
  try {
    const s = await getPaymentSources(token.value);
    // Filter out the to_source (the card itself) — you can't transfer
    // money to a card from itself. Match case-insensitive on name AND
    // last4 to drop both representations.
    const toName = (props.awaiting.vendor ?? "").toLowerCase().trim();
    const toLast4 = extractLast4(props.awaiting.vendor);
    paymentSources.value = (s.sources ?? []).filter((src) => {
      const n = (src.name ?? "").toLowerCase().trim();
      const l4 = src.last4 ?? extractLast4(src.name);
      if (n && n === toName) return false;
      if (toLast4 && l4 && l4 === toLast4) return false;
      return true;
    });
  } catch {
    /* surfaced inline if user submits */
  } finally {
    loadingLookups.value = false;
  }
}

function extractLast4(s) {
  if (!s) return null;
  const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
  return m ? m[1] : null;
}

onMounted(loadLookups);

async function submit() {
  error.value = null;
  if (!form.value.date) {
    error.value = "Transfer date is required.";
    return;
  }
  if (!form.value.from_source) {
    error.value = "Pick the account you're transferring from.";
    return;
  }
  submitting.value = true;
  try {
    await recordTransferPayment(token.value, props.awaiting.id, {
      date: form.value.date,
      from_source: form.value.from_source,
      description: form.value.description || "",
      notes: form.value.notes || "",
    });
    emit("success");
  } catch (e) {
    error.value = e.message || "Failed to record transfer.";
  } finally {
    submitting.value = false;
  }
}

function fmt(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
</script>

<template>
  <form class="rtf" @submit.prevent="submit">
    <p class="rtf-flow">
      <span class="rtf-flow-label">Moving</span>
      <strong>{{ fmt(awaiting.amount, awaiting.currency) }}</strong>
      <span class="rtf-flow-arrow">→</span>
      <span class="rtf-flow-to">{{ awaiting.vendor || "(unknown)" }}</span>
    </p>

    <div class="rtf-grid">
      <label>
        <span>Transfer date</span>
        <input type="date" v-model="form.date" required />
      </label>
      <label>
        <span>From account</span>
        <input
          type="text"
          list="rtf-payment-sources"
          v-model="form.from_source"
          :placeholder="loadingLookups ? 'Loading…' : 'Checking / savings — type or pick'"
          required
        />
        <datalist id="rtf-payment-sources">
          <option v-for="s in paymentSources" :key="s.name" :value="s.name">
            {{ s.last4 ? `${s.name} · ••${s.last4}` : s.name }}
          </option>
        </datalist>
        <span
          v-if="paymentSources.length === 0 && !loadingLookups"
          class="rtf-hint"
        >No other sources on file — typing one will save it for next time.</span>
      </label>
    </div>

    <label class="rtf-row">
      <span>Description (optional)</span>
      <input
        type="text"
        v-model="form.description"
        placeholder="e.g. autopay, monthly payment"
      />
    </label>
    <label class="rtf-row">
      <span>Notes (optional)</span>
      <input type="text" v-model="form.notes" />
    </label>

    <p v-if="error" class="rtf-error">{{ error }}</p>

    <div class="rtf-actions">
      <span class="rtf-summary">
        Books a Transfer of {{ fmt(awaiting.amount, awaiting.currency) }}
        from your selected account to {{ awaiting.vendor || "this account" }} and
        marks the balance paid. No GL row is created.
      </span>
      <button
        type="button"
        class="ghost"
        :disabled="submitting"
        @click="emit('cancel')"
      >Cancel</button>
      <button type="submit" class="primary" :disabled="submitting">
        {{ submitting ? "Saving…" : "Record transfer" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.rtf {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.rtf-flow {
  margin: 0 0 0.2rem;
  font-size: 0.85rem;
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.rtf-flow-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}

.rtf-flow-arrow {
  color: var(--accent);
  font-weight: 700;
}

.rtf-flow-to {
  font-weight: 600;
}

.rtf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.55rem 0.65rem;
}

.rtf label,
.rtf-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.rtf label span,
.rtf-row span {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
}

.rtf input {
  font-size: 0.85rem;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.rtf-hint {
  font-size: 0.7rem !important;
  color: var(--text-muted) !important;
  font-style: italic;
  text-transform: none !important;
  letter-spacing: 0 !important;
  font-weight: 400 !important;
  margin-top: 0.1rem;
}

.rtf-error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.35rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.rtf-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-top: 0.4rem;
}

.rtf-summary {
  margin-right: auto;
  font-size: 0.72rem;
  color: var(--text-muted);
  font-style: italic;
  flex: 1 1 240px;
  min-width: 0;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.8rem;
  padding: 0.3rem 0.7rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
}

button.primary {
  font-size: 0.8rem;
  padding: 0.35rem 0.85rem;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
