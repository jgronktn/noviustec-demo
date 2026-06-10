<script setup>
import { ref, computed, onMounted, onBeforeUnmount, inject } from "vue";
import {
  getCategories,
  getPaymentSources,
  createTransaction,
} from "../api.js";

const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");

// Default deposit method is "ach" since most business deposits come in
// via bank transfer or wire. Change to whatever you actually saw.
const form = ref({
  vendor: "",
  amount: null,
  date: new Date().toISOString().slice(0, 10),
  category: "",
  payment_source: "",
  reference_kind: "ach",
  reference_number: "",
  description: "",
  notes: "",
});

const DEPOSIT_METHODS = [
  { value: "ach", label: "ACH / bank transfer" },
  { value: "wire", label: "Wire" },
  { value: "check", label: "Check" },
  { value: "card", label: "Credit / debit card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

const categories = ref([]);
const paymentSources = ref([]);
const error = ref(null);
const loading = ref(true);
const submitting = ref(false);

// Only show income-typed categories in the dropdown — picking an
// expense category here would be a UX bug. If your existing chart
// of accounts has none of `type=income`, run `npm run ensure-categories`
// on the backend or add some via the agent.
const incomeCategories = computed(() =>
  categories.value.filter((c) => c.type === "income"),
);

const canSubmit = computed(
  () =>
    !!form.value.vendor &&
    !!form.value.amount &&
    Number(form.value.amount) > 0 &&
    !!form.value.date &&
    !!form.value.category &&
    !!form.value.payment_source &&
    !submitting.value,
);

function onKeyDown(e) {
  if (e.key === "Escape" && !submitting.value) emit("cancel");
}

onMounted(async () => {
  window.addEventListener("keydown", onKeyDown);
  document.body.style.overflow = "hidden";
  try {
    const [cats, srcs] = await Promise.all([
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    categories.value = Array.isArray(cats) ? cats : cats?.categories ?? [];
    paymentSources.value = Array.isArray(srcs) ? srcs : srcs?.sources ?? [];
  } catch (e) {
    error.value = `Couldn't load categories/sources: ${e.message}`;
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  document.body.style.overflow = "";
});

async function submit() {
  if (!canSubmit.value) return;
  error.value = null;
  submitting.value = true;
  try {
    await createTransaction(token.value, {
      vendor: form.value.vendor.trim(),
      amount: Math.abs(Number(form.value.amount)),
      date: form.value.date,
      category: form.value.category,
      payment_source: form.value.payment_source,
      currency: "USD",
      reference_number: form.value.reference_number || "",
      reference_kind: form.value.reference_kind || "",
      description: form.value.description || "",
      notes: form.value.notes || "",
      entry_type: "income",
    });
    emit("success");
  } catch (e) {
    error.value = e.message || "Save failed.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="add-backdrop" @click.self="!submitting && emit('cancel')">
    <div class="add-card add-card-income" role="dialog" aria-modal="true">
      <header class="add-head">
        <div>
          <span class="add-kicker">Add deposit</span>
          <h3 class="add-title">Quick entry — money coming in</h3>
          <p class="add-sub">
            Books a new GL row tagged as income. Use this for revenue, investor
            capital, loan proceeds, refunds, interest, etc.
          </p>
        </div>
        <button class="add-close" :disabled="submitting" @click="emit('cancel')" aria-label="Close">×</button>
      </header>

      <p v-if="loading" class="add-loading">Loading categories and sources…</p>
      <p
        v-else-if="incomeCategories.length === 0"
        class="add-error"
      >No income categories found. Run <code>npm run ensure-categories</code> on the backend, or add some manually to the Categories sheet.</p>
      <form v-else @submit.prevent="submit" class="add-form">
        <label class="add-field add-wide">
          <span>Source / payer *</span>
          <input
            v-model="form.vendor"
            type="text"
            :disabled="submitting"
            placeholder="Who deposited the money"
            autofocus
          />
        </label>

        <label class="add-field">
          <span>Amount *</span>
          <input
            v-model.number="form.amount"
            type="number"
            step="0.01"
            min="0.01"
            :disabled="submitting"
          />
        </label>

        <label class="add-field">
          <span>Date *</span>
          <input v-model="form.date" type="date" :disabled="submitting" />
        </label>

        <label class="add-field">
          <span>Category *</span>
          <select v-model="form.category" :disabled="submitting">
            <option value="">— pick an income category —</option>
            <option v-for="c in incomeCategories" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </label>

        <label class="add-field">
          <span>Deposited to *</span>
          <select v-model="form.payment_source" :disabled="submitting">
            <option value="">— pick a bank/source —</option>
            <option v-for="s in paymentSources" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
        </label>

        <label class="add-field">
          <span>Deposit method</span>
          <select v-model="form.reference_kind" :disabled="submitting">
            <option v-for="rk in DEPOSIT_METHODS" :key="rk.value" :value="rk.value">{{ rk.label }}</option>
          </select>
        </label>

        <label class="add-field">
          <span>Reference #</span>
          <input
            v-model="form.reference_number"
            type="text"
            :disabled="submitting"
            placeholder="Check #, confirmation, etc."
          />
        </label>

        <label class="add-field add-wide">
          <span>Description</span>
          <input
            v-model="form.description"
            type="text"
            :disabled="submitting"
            placeholder="What the deposit was for"
          />
        </label>

        <label class="add-field add-wide">
          <span>Notes</span>
          <input
            v-model="form.notes"
            type="text"
            :disabled="submitting"
            placeholder="(optional)"
          />
        </label>

        <p v-if="error" class="add-error">{{ error }}</p>

        <div class="add-actions">
          <button type="button" class="ghost" :disabled="submitting" @click="emit('cancel')">Cancel</button>
          <button type="submit" class="primary primary-income" :disabled="!canSubmit">
            {{ submitting ? "Saving…" : "Save deposit" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.add-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 4rem 1rem 2rem;
  z-index: 1000;
  overflow-y: auto;
}

.add-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(640px, 100%);
  padding: 1rem 1.1rem 1.1rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
}

.add-card-income {
  border-top: 3px solid var(--ok);
}

.add-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.85rem;
  padding-bottom: 0.65rem;
  border-bottom: 1px solid var(--border);
}

.add-kicker {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-weight: 700;
  color: var(--ok);
}

.add-title {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.add-sub {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.add-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}

.add-close:hover:not(:disabled) {
  background: #f0f0eb;
  color: var(--text);
}

.add-loading {
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 1rem 0;
}

.add-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.55rem 0.7rem;
}

.add-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.78rem;
  min-width: 0;
}

.add-field.add-wide {
  grid-column: span 2;
}

.add-field > span {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 700;
}

.add-field input,
.add-field select {
  font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  width: 100%;
}

.add-field input:focus,
.add-field select:focus {
  outline: none;
  border-color: var(--ok);
}

.add-error {
  grid-column: span 2;
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.4rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.add-error code {
  font-family: var(--font-mono);
  background: #fff;
  padding: 0 4px;
  border-radius: 3px;
}

.add-actions {
  grid-column: span 2;
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.3rem;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.82rem;
  padding: 0.4rem 0.85rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
}

button.primary-income {
  background: var(--ok);
  border: 1px solid var(--ok);
  color: white;
  font-size: 0.82rem;
  padding: 0.4rem 0.95rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}

button.primary-income:hover:not(:disabled) {
  filter: brightness(0.95);
}

button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 600px) {
  .add-form {
    grid-template-columns: 1fr;
  }
  .add-field.add-wide {
    grid-column: span 1;
  }
  .add-error,
  .add-actions {
    grid-column: span 1;
  }
}
</style>
