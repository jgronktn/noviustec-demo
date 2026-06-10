<script setup>
import { ref, onMounted, inject, computed } from "vue";
import {
  getCategories,
  getPaymentSources,
  createTransaction,
} from "../../api.js";

const props = defineProps({
  data: { type: Object, required: true },
});

const token = inject("apiToken");
const signalLedgerChange = inject("signalLedgerChange", () => {});

// Local mutable copy of the agent's proposal — the user can edit
// anything before clicking Approve. The original proposal stays in
// props.data.proposal so we can show a diff if needed.
const form = ref({
  ...props.data.proposal,
});

const categories = ref([]);
const paymentSources = ref([]);
const error = ref(null);
const busy = ref(false);
const bookedId = ref(null);

onMounted(async () => {
  try {
    const [cats, srcs] = await Promise.all([
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    categories.value = Array.isArray(cats) ? cats : cats?.categories ?? [];
    paymentSources.value = Array.isArray(srcs) ? srcs : srcs?.sources ?? [];
  } catch (e) {
    error.value = `Couldn't load categories/sources: ${e.message}`;
  }
});

const REFERENCE_KINDS = [
  { value: "", label: "(none)" },
  { value: "check", label: "Check" },
  { value: "card", label: "Credit card" },
  { value: "ach", label: "ACH / bank transfer" },
  { value: "wire", label: "Wire" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

const canSubmit = computed(() => {
  return (
    !!form.value.vendor &&
    !!form.value.amount &&
    Number(form.value.amount) > 0 &&
    !!form.value.date &&
    !!form.value.category &&
    !!form.value.payment_source &&
    !busy.value &&
    !bookedId.value
  );
});

function fmt(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

async function approve() {
  error.value = null;
  busy.value = true;
  try {
    const result = await createTransaction(token.value, {
      vendor: form.value.vendor.trim(),
      amount: Math.abs(Number(form.value.amount)),
      date: form.value.date,
      category: form.value.category,
      payment_source: form.value.payment_source,
      currency: form.value.currency || "USD",
      reference_number: form.value.reference_number || "",
      reference_kind: form.value.reference_kind || "",
      description: form.value.description || "",
      notes: form.value.notes || "",
    });
    bookedId.value = result.transaction_id;
    signalLedgerChange();
  } catch (e) {
    error.value = e.message || "Book failed.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="td-root">
    <header class="td-head">
      <p class="td-sub">
        Agent draft — review and edit, then Approve to book into the GL.
        Nothing is written until you click Approve.
      </p>
    </header>

    <div v-if="error" class="td-error">{{ error }}</div>

    <div v-if="bookedId" class="td-success">
      <strong>Booked.</strong>
      <span class="mono">{{ bookedId }}</span>
      written to the GL.
    </div>

    <div class="td-form" :class="{ 'td-locked': bookedId }">
      <label class="td-field td-field-wide">
        <span class="td-label">Vendor *</span>
        <input
          v-model="form.vendor"
          type="text"
          :disabled="busy || bookedId"
          placeholder="Who got paid"
        />
      </label>

      <label class="td-field">
        <span class="td-label">Amount *</span>
        <input
          v-model.number="form.amount"
          type="number"
          step="0.01"
          min="0.01"
          :disabled="busy || bookedId"
        />
      </label>

      <label class="td-field">
        <span class="td-label">Date *</span>
        <input
          v-model="form.date"
          type="date"
          :disabled="busy || bookedId"
        />
      </label>

      <label class="td-field">
        <span class="td-label">Category *</span>
        <select v-model="form.category" :disabled="busy || bookedId">
          <option value="">— pick a category —</option>
          <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>

      <label class="td-field">
        <span class="td-label">Payment source *</span>
        <select v-model="form.payment_source" :disabled="busy || bookedId">
          <option value="">— pick a source —</option>
          <option v-for="s in paymentSources" :key="s.name" :value="s.name">{{ s.name }}</option>
        </select>
      </label>

      <label class="td-field">
        <span class="td-label">Payment method</span>
        <select v-model="form.reference_kind" :disabled="busy || bookedId">
          <option v-for="rk in REFERENCE_KINDS" :key="rk.value" :value="rk.value">{{ rk.label }}</option>
        </select>
      </label>

      <label class="td-field">
        <span class="td-label">Reference #</span>
        <input
          v-model="form.reference_number"
          type="text"
          :disabled="busy || bookedId"
          placeholder="Check #, confirmation #, etc."
        />
      </label>

      <label class="td-field td-field-wide">
        <span class="td-label">Description</span>
        <input
          v-model="form.description"
          type="text"
          :disabled="busy || bookedId"
          placeholder="What was paid for"
        />
      </label>

      <label class="td-field td-field-wide">
        <span class="td-label">Notes</span>
        <textarea
          v-model="form.notes"
          :disabled="busy || bookedId"
          rows="2"
          placeholder="(optional)"
        />
      </label>
    </div>

    <div class="td-readout">
      Booking <strong class="mono">{{ fmt(form.amount) }}</strong>
      to <strong>{{ form.vendor || "—" }}</strong>
      on <strong class="mono">{{ form.date || "—" }}</strong>
      <span v-if="form.category"> · category {{ form.category }}</span>
      <span v-if="form.payment_source"> · via {{ form.payment_source }}</span>
    </div>

    <div v-if="!bookedId" class="td-actions">
      <button
        class="primary"
        :disabled="!canSubmit"
        @click="approve"
      >{{ busy ? "Booking…" : "Approve and book" }}</button>
    </div>
  </div>
</template>

<style scoped>
.td-root {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.td-head {
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.td-sub {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.td-error {
  font-size: 0.82rem;
  color: var(--danger);
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
  padding: 0.45rem 0.6rem;
}

.td-success {
  font-size: 0.82rem;
  color: var(--ok);
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
  padding: 0.5rem 0.6rem;
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.td-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.55rem 0.7rem;
}

.td-locked {
  opacity: 0.7;
}

.td-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.78rem;
  min-width: 0;
}

.td-field-wide {
  grid-column: span 2;
}

.td-label {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 700;
}

.td-field input,
.td-field select,
.td-field textarea {
  font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  width: 100%;
  font-family: inherit;
}

.td-field input:focus,
.td-field select:focus,
.td-field textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.td-readout {
  font-size: 0.8rem;
  color: var(--text-muted);
  background: #fafaf5;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.5rem 0.65rem;
  line-height: 1.5;
}

.td-actions {
  display: flex;
  gap: 0.55rem;
  justify-content: flex-end;
}

button.primary {
  font-size: 0.85rem;
  padding: 0.45rem 1rem;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mono {
  font-family: var(--font-mono);
}

@media (max-width: 600px) {
  .td-form {
    grid-template-columns: 1fr;
  }
  .td-field-wide {
    grid-column: span 1;
  }
}
</style>
