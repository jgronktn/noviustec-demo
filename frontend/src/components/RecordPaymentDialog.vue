<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import RecordPaymentForm from "./RecordPaymentForm.vue";
import RecordTransferForm from "./RecordTransferForm.vue";
import LinkExistingPayment from "./LinkExistingPayment.vue";

const props = defineProps({
  // { id, vendor, amount, currency, reference_number?, date?, payment_kind? }
  awaiting: { type: Object, required: true },
});
const emit = defineEmits(["success", "cancel"]);

// payment_kind === "transfer" means this awaiting represents a credit-
// card balance (or other inter-account obligation) that gets settled
// via a Transfer record, not a GL row. Default is "expense" for
// backward-compat with awaitings created before the column existed.
const isTransfer = computed(
  () => (props.awaiting.payment_kind || "expense") === "transfer",
);

// Tab state for expense awaitings — "new" creates a fresh GL row,
// "link" attaches to an existing one. Transfer awaitings always use
// the transfer form; no tab toggle is shown.
const mode = ref("new"); // "new" | "link"

function onKeyDown(e) {
  if (e.key === "Escape") emit("cancel");
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  // Prevent the page underneath from scrolling while the modal is open.
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  document.body.style.overflow = "";
});
</script>

<template>
  <div class="rpd-backdrop" @click.self="emit('cancel')">
    <div class="rpd-card" role="dialog" aria-modal="true">
      <header class="rpd-head">
        <div>
          <span class="rpd-kicker">
            {{ isTransfer ? "Record transfer" : "Record payment" }}
          </span>
          <h3 class="rpd-title">{{ awaiting.vendor }}</h3>
          <p v-if="awaiting.reference_number" class="rpd-sub">
            {{ isTransfer ? "Statement" : "Invoice" }}
            {{ awaiting.reference_number }}<template v-if="awaiting.date">
              · {{ awaiting.date }}</template
            >
          </p>
        </div>
        <button class="rpd-close" @click="emit('cancel')" aria-label="Close">×</button>
      </header>
      <RecordTransferForm
        v-if="isTransfer"
        :awaiting="awaiting"
        @success="emit('success')"
        @cancel="emit('cancel')"
      />
      <template v-else>
        <div class="rpd-tabs" role="tablist">
          <button
            type="button"
            class="rpd-tab"
            :class="{ active: mode === 'new' }"
            @click="mode = 'new'"
          >New payment</button>
          <button
            type="button"
            class="rpd-tab"
            :class="{ active: mode === 'link' }"
            @click="mode = 'link'"
          >Link existing</button>
        </div>
        <RecordPaymentForm
          v-if="mode === 'new'"
          :awaiting="awaiting"
          @success="emit('success')"
          @cancel="emit('cancel')"
        />
        <LinkExistingPayment
          v-else
          :awaiting="awaiting"
          @success="emit('success')"
          @cancel="emit('cancel')"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.rpd-backdrop {
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

.rpd-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(640px, 100%);
  padding: 1rem 1.1rem 1.1rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
}

.rpd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.85rem;
  padding-bottom: 0.65rem;
  border-bottom: 1px solid var(--border);
}

.rpd-kicker {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-weight: 700;
  color: var(--text-muted);
}

.rpd-title {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.rpd-sub {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.rpd-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}

.rpd-close:hover {
  background: #f0f0eb;
  color: var(--text);
}

.rpd-tabs {
  display: flex;
  gap: 0.3rem;
  margin-bottom: 0.85rem;
  border-bottom: 1px solid var(--border);
}

.rpd-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.4rem 0.75rem;
  font-size: 0.82rem;
  color: var(--text-muted);
  cursor: pointer;
  margin-bottom: -1px;
}

.rpd-tab:hover {
  color: var(--text);
}

.rpd-tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
</style>
