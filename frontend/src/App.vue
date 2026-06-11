<script setup>
import { ref, provide, onMounted, watch } from "vue";
import TokenGate from "./components/TokenGate.vue";
import InboxPanel from "./components/InboxPanel.vue";
import PromptPanel from "./components/PromptPanel.vue";
import DashboardPanel from "./components/DashboardPanel.vue";
import RecordPaymentDialog from "./components/RecordPaymentDialog.vue";
import EditTransactionDialog from "./components/EditTransactionDialog.vue";
import EditAwaitingDialog from "./components/EditAwaitingDialog.vue";
import {
  fetchMainTimeline,
  fetchVendorTimeline,
  fetchCategoryTimeline,
  resetSystem,
} from "./api.js";

// Injected by vite.config.js at build time. Hover the badge to see when
// the bundle was built; the value is the short git SHA (with a "+" suffix
// if the working tree was dirty at build time).
const BUILD_SHA = __BUILD_SHA__;
const BUILD_TIME = __BUILD_TIME__;

const STORAGE_KEY = "noviustec_token";

const token = ref(localStorage.getItem(STORAGE_KEY) || "");
// Message shown on the TokenGate when a token is rejected — either at the
// gate itself or mid-session (a stored token that 401s on a later call).
const authError = ref("");
const clearing = ref(false); // true while a "Clear all" factory reset runs
const selectedPendingId = ref(null);
const inboxKey = ref(0); // bump to force InboxPanel reload after approve/reject

// Expose the token to deeply-nested canvas panels (e.g. FileListPanel
// download buttons) without prop-drilling. Provide the ref itself so
// updates propagate after sign-in / sign-out.
provide("apiToken", token);

// ── Record-payment dialog ──────────────────────────────────────────────
// Mounted at App level so any panel can trigger it without owning its
// own modal state. Panels inject `openPaymentDialog` and call it with
// an awaiting row; the returned Promise resolves to true on success and
// false on cancel, so the caller can update its own local state (e.g.
// mark a card as paid).
const paymentDialogAwaiting = ref(null);
let paymentDialogResolver = null;

function openPaymentDialog(awaiting) {
  return new Promise((resolve) => {
    paymentDialogAwaiting.value = awaiting;
    paymentDialogResolver = resolve;
  });
}
provide("openPaymentDialog", openPaymentDialog);

function handlePaymentSuccess() {
  paymentDialogResolver?.(true);
  paymentDialogResolver = null;
  paymentDialogAwaiting.value = null;
  // A new GL row exists; refresh any visible timeline so the freshly-paid
  // invoice flips status and the new payment card appears.
  signalLedgerChange();
}

function handlePaymentCancel() {
  paymentDialogResolver?.(false);
  paymentDialogResolver = null;
  paymentDialogAwaiting.value = null;
}

// ── Edit dialog (GL transactions + AwaitingPayment rows) ───────────────
// Mounted at App level so any panel can request an edit by id without
// owning its own modal state. Inject `openEditDialog`, call with
// { kind: "transaction" | "awaiting", id }. Returns a Promise<boolean>
// resolving to true if the user saved a change, false on cancel.
const editDialog = ref(null); // { kind, id } | null
let editDialogResolver = null;

function openEditDialog({ kind, id }) {
  if (!kind || !id) return Promise.resolve(false);
  return new Promise((resolve) => {
    editDialog.value = { kind, id };
    editDialogResolver = resolve;
  });
}
provide("openEditDialog", openEditDialog);

function handleEditSuccess() {
  editDialogResolver?.(true);
  editDialogResolver = null;
  editDialog.value = null;
  signalLedgerChange();
}

function handleEditCancel() {
  editDialogResolver?.(false);
  editDialogResolver = null;
  editDialog.value = null;
}

// Agent-pushed canvas panels. Newest on top. Persists across review-panel
// toggles — agent panels stay parked while the user reviews a pending row.
const agentPanels = ref([]); // [{id, kind, title, props}]

function onTokenSet(t) {
  authError.value = "";
  token.value = t;
  localStorage.setItem(STORAGE_KEY, t);
}

function logout() {
  authError.value = "";
  token.value = "";
  localStorage.removeItem(STORAGE_KEY);
  selectedPendingId.value = null;
  agentPanels.value = [];
}

// Factory reset: wipe ALL data on the server, then hard-reload so every panel
// refetches against the now-empty system. Destructive and irreversible —
// guarded by an explicit confirm. Stays signed in (reload keeps the token).
async function clearAll() {
  const ok = window.confirm(
    "Wipe ALL data?\n\n" +
      "This permanently deletes every transaction, pending receipt, awaiting " +
      "invoice, statement, archived document, and inbound email, then resets " +
      "to an empty system.\n\nThis cannot be undone.",
  );
  if (!ok) return;
  clearing.value = true;
  try {
    await resetSystem(token.value);
    window.location.reload();
  } catch (e) {
    clearing.value = false;
    window.alert(`Reset failed: ${e.message}`);
  }
}

function openPending(id) {
  selectedPendingId.value = id;
}

function closeReview() {
  selectedPendingId.value = null;
  inboxKey.value += 1;
}

// Panel kinds that take over the whole canvas — pushing one of these
// clears the existing stack so the canvas isn't split. Vendor + statement
// timelines are dense vertical layouts that don't share well; other
// panels are designed to coexist.
const EXCLUSIVE_KINDS = new Set(["vendor_timeline", "statement_timeline"]);

function onAgentPanel(panel) {
  if (EXCLUSIVE_KINDS.has(panel.kind)) {
    agentPanels.value = [panel];
    return;
  }
  // Otherwise push to front — newest panels appear on top of the stack.
  agentPanels.value = [panel, ...agentPanels.value];
}

function dismissPanel(id) {
  agentPanels.value = agentPanels.value.filter((p) => p.id !== id);
}

function clearPanels() {
  agentPanels.value = [];
}

// ── Ledger-change refresh ─────────────────────────────────────────────
// Anywhere the user mutates the books (approving a pending entry, paying
// an awaiting invoice, etc.) calls signalLedgerChange() via inject. The
// handler refetches every timeline panel currently in the stack so it
// reflects the new state without a page reload. Other panel kinds are
// left alone — re-asking the agent is still the way to refresh them.
async function refreshTimelinePanels() {
  if (!token.value) return;
  if (agentPanels.value.length === 0) return;
  const next = await Promise.all(
    agentPanels.value.map(async (p) => {
      if (p.kind !== "vendor_timeline") return p;
      try {
        const from = p.props?.period?.from || undefined;
        const to = p.props?.period?.to || undefined;
        let data;
        if (p.props?.is_category) {
          data = await fetchCategoryTimeline(token.value, {
            category: p.props.category,
            from,
            to,
          });
        } else if (p.props?.query) {
          data = await fetchVendorTimeline(token.value, {
            vendor: p.props.query,
            from,
            to,
          });
        } else {
          data = await fetchMainTimeline(token.value);
        }
        return {
          ...p,
          title: data.title || p.title,
          props: data.props,
        };
      } catch {
        return p; // keep stale rather than blow up
      }
    }),
  );
  agentPanels.value = next;
}

function signalLedgerChange() {
  refreshTimelinePanels();
}
provide("signalLedgerChange", signalLedgerChange);

// ── Dashboard home screen ──────────────────────────────────────────────
// On sign-in (token first appears), auto-load the global all-vendor
// timeline and push it as the initial canvas panel. Once per session —
// if the user dismisses it, we don't re-push.
let mainTimelineLoaded = false;

async function loadMainTimeline() {
  if (!token.value || mainTimelineLoaded) return;
  mainTimelineLoaded = true;
  try {
    const data = await fetchMainTimeline(token.value);
    onAgentPanel({
      id: "main-timeline",
      kind: data.kind,
      title: data.title,
      props: data.props,
      createdAt: Date.now(),
    });
  } catch (e) {
    // 401 means the stored token is no longer valid — kick back to the gate
    // with an explanation instead of a blank dialog.
    if (e.status === 401) {
      localStorage.removeItem(STORAGE_KEY);
      token.value = "";
      authError.value =
        "Your saved token was rejected by the server. Please re-enter a valid token.";
    }
    // Otherwise: swallow. The user can still interact normally; they
    // just don't get the auto-home screen this session.
    mainTimelineLoaded = false;
  }
}

onMounted(loadMainTimeline);
watch(token, (next, prev) => {
  if (!prev && next) {
    mainTimelineLoaded = false;
    loadMainTimeline();
  }
  if (!next) {
    mainTimelineLoaded = false;
  }
});
</script>

<template>
  <TokenGate v-if="!token" :initial-error="authError" @token-set="onTokenSet" />

  <div v-else class="app-grid">
    <aside class="sidebar">
      <div class="pane inbox-pane">
        <InboxPanel
          :key="inboxKey"
          :token="token"
          :selected-id="selectedPendingId"
          @open="openPending"
        />
      </div>
      <div class="pane prompt-pane">
        <PromptPanel :token="token" @panel="onAgentPanel" />
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="brand">
          <span class="logo">◐</span>
          <span class="name">Noviustec</span>
          <span class="env" :title="`Built ${BUILD_TIME}`">{{ BUILD_SHA }}</span>
        </div>
        <div class="actions">
          <button
            @click="clearAll"
            class="ghost danger"
            :disabled="clearing"
            title="Wipe all data and reset to an empty system"
          >{{ clearing ? "Clearing…" : "Clear All" }}</button>
          <button @click="logout" class="ghost">Sign out</button>
        </div>
      </header>
      <section class="dashboard">
        <DashboardPanel
          :token="token"
          :selected-id="selectedPendingId"
          :panels="agentPanels"
          @close="closeReview"
          @dismiss-panel="dismissPanel"
          @clear-panels="clearPanels"
        />
      </section>
    </main>
  </div>

  <RecordPaymentDialog
    v-if="paymentDialogAwaiting"
    :awaiting="paymentDialogAwaiting"
    @success="handlePaymentSuccess"
    @cancel="handlePaymentCancel"
  />

  <EditTransactionDialog
    v-if="editDialog?.kind === 'transaction'"
    :txn-id="editDialog.id"
    @success="handleEditSuccess"
    @cancel="handleEditCancel"
  />

  <EditAwaitingDialog
    v-if="editDialog?.kind === 'awaiting'"
    :awaiting-id="editDialog.id"
    @success="handleEditSuccess"
    @cancel="handleEditCancel"
  />
</template>

<style scoped>
.app-grid {
  display: grid;
  grid-template-columns: 425px 1fr;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

@media (max-width: 800px) {
  .app-grid {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    height: 100vh;
  }
}

.sidebar {
  display: grid;
  grid-template-rows: 1fr 1fr;
  border-right: 1px solid var(--border);
  background: var(--surface);
  min-height: 0;
}

.pane {
  min-height: 0;
  overflow: hidden;
}

.inbox-pane {
  /* Inner InboxPanel owns its own scroll region (only the list scrolls;
     header + upload zone stay pinned). The pane itself just clips. */
  border-bottom: 1px solid var(--border);
}

.prompt-pane {
  display: flex;
  flex-direction: column;
}

.main {
  display: grid;
  grid-template-rows: 80px 1fr;
  min-height: 0;
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 1.5rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  height: 80px;
  box-sizing: border-box;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.logo {
  font-size: 1.75rem;
  color: var(--accent);
}

.name {
  font-weight: 600;
  font-size: 1.1rem;
}

.env {
  font-size: 0.75rem;
  color: var(--text-muted);
  background: #f0f0eb;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.actions button.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}

.actions button.ghost:hover {
  background: #f5f5f0;
  color: var(--text);
}

/* Clear All — ghost layout but danger-tinted to flag it as destructive.
   Placed after the .ghost rules so it wins on equal specificity. */
.actions button.danger {
  color: var(--danger);
  border-color: transparent;
}

.actions button.danger:hover:not(:disabled) {
  background: #fef2f2;
  color: var(--danger);
}

.dashboard {
  overflow-y: auto;
  padding: 1.5rem;
  background: var(--bg);
  min-height: 0;
}
</style>
