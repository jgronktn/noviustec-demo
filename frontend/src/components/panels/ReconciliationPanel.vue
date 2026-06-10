<script setup>
import { ref, computed, inject, onMounted } from "vue";
import {
  matchStatementLine,
  unmatchStatementLine,
  fetchReconciliation,
  bookStatementLineAsTransaction,
  markStatementLineAsTransfer,
  getCategories,
  getPaymentSources,
} from "../../api.js";

const props = defineProps({
  data: { type: Object, required: true },
});

const token = inject("apiToken");
const signalLedgerChange = inject("signalLedgerChange", () => {});

// Local mirror of the panel data so we can re-fetch after manual
// matches without waiting for the parent to push fresh props.
const view = ref(props.data);

// Per-line state machine for the action expansion. activeAction is one of
// null | "match" | "book" | "transfer". Only one line can have an action
// open at a time; opening on a different line auto-closes the first.
const activeLineId = ref(null);
const activeAction = ref(null);
const pickingError = ref(null);
const busyLineIds = ref(new Set());

// Categories + payment sources loaded once on mount for the dropdowns.
// Fall back to empty arrays so the forms still render if the fetch fails.
const categories = ref([]);
const paymentSources = ref([]);

onMounted(async () => {
  try {
    const [cats, srcs] = await Promise.all([
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    categories.value = Array.isArray(cats) ? cats : cats?.categories ?? [];
    paymentSources.value = Array.isArray(srcs) ? srcs : srcs?.sources ?? [];
  } catch (e) {
    pickingError.value = `Couldn't load categories/sources: ${e.message}`;
  }
});

// In-progress form state for the Book / Mark forms — keyed by lineId
// so re-renders don't blow away what the user has typed.
const bookForms = ref({});
const transferForms = ref({});

function bookFormFor(line) {
  if (!bookForms.value[line.id]) {
    // Sensible defaults: vendor pre-fills from the statement source
    // (most fees come from the issuing bank), category defaults to the
    // best-guess from the line description.
    const guessedCategory = guessCategoryForLine(line);
    bookForms.value[line.id] = {
      vendor: view.value.statement.source ?? "",
      category: guessedCategory,
      date: line.line_date || view.value.statement.statement_date || "",
      payment_source: view.value.statement.source ?? "",
      description: line.description || "",
      notes: "",
    };
  }
  return bookForms.value[line.id];
}

function transferFormFor(line) {
  if (!transferForms.value[line.id]) {
    transferForms.value[line.id] = {
      other_source: "",
      date: line.line_date || view.value.statement.statement_date || "",
      description: line.description || "",
      notes: "",
    };
  }
  return transferForms.value[line.id];
}

// Tiny heuristic so the Book form starts with the "right" category
// pre-selected for fees and interest. The user can override; this is
// just a starting point for the most common card-statement extras.
function guessCategoryForLine(line) {
  const desc = String(line?.description ?? "").toLowerCase();
  const findByName = (re) =>
    categories.value.find((c) => re.test(String(c.name ?? "").toLowerCase()));
  if (/interest|finance charge|periodic finance/.test(desc)) {
    return findByName(/interest/)?.name ?? "";
  }
  if (/late fee|past due|delinquent|nsf|overdraft|wire fee/.test(desc)) {
    return findByName(/bank fee/)?.name ?? "";
  }
  return "";
}

function setAction(lineId, action) {
  activeLineId.value = lineId;
  activeAction.value = action;
  pickingError.value = null;
}

function closeAction() {
  activeLineId.value = null;
  activeAction.value = null;
}

function isActive(lineId, action) {
  return activeLineId.value === lineId && activeAction.value === action;
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

function shortDate(d) {
  return d ? String(d).slice(0, 10) : "—";
}

function setBusy(lineId, busy) {
  const next = new Set(busyLineIds.value);
  if (busy) next.add(lineId);
  else next.delete(lineId);
  busyLineIds.value = next;
}

async function refresh() {
  try {
    const fresh = await fetchReconciliation(token.value, view.value.statement.id);
    view.value = fresh;
  } catch (e) {
    pickingError.value = `Refresh failed: ${e.message}`;
  }
}

async function manualMatch(lineId, txnId) {
  pickingError.value = null;
  setBusy(lineId, true);
  try {
    await matchStatementLine(token.value, lineId, txnId);
    await refresh();
    closeAction();
    signalLedgerChange();
  } catch (e) {
    pickingError.value = e.message || "Match failed.";
  } finally {
    setBusy(lineId, false);
  }
}

async function submitBook(line) {
  pickingError.value = null;
  const form = bookFormFor(line);
  if (!form.vendor || !form.category || !form.date || !form.payment_source) {
    pickingError.value = "Vendor, category, date, and payment source are required.";
    return;
  }
  setBusy(line.id, true);
  try {
    await bookStatementLineAsTransaction(token.value, line.id, {
      vendor: form.vendor,
      category: form.category,
      date: form.date,
      payment_source: form.payment_source,
      description: form.description,
      notes: form.notes,
    });
    delete bookForms.value[line.id];
    await refresh();
    closeAction();
    signalLedgerChange();
  } catch (e) {
    pickingError.value = e.message || "Book-as-transaction failed.";
  } finally {
    setBusy(line.id, false);
  }
}

async function submitTransfer(line) {
  pickingError.value = null;
  const form = transferFormFor(line);
  if (!form.other_source || !form.date) {
    pickingError.value = "Other account and date are required.";
    return;
  }
  setBusy(line.id, true);
  try {
    await markStatementLineAsTransfer(token.value, line.id, {
      other_source: form.other_source,
      date: form.date,
      description: form.description,
      notes: form.notes,
    });
    delete transferForms.value[line.id];
    await refresh();
    closeAction();
    signalLedgerChange();
  } catch (e) {
    pickingError.value = e.message || "Mark-as-transfer failed.";
  } finally {
    setBusy(line.id, false);
  }
}

async function unmatch(lineId) {
  pickingError.value = null;
  setBusy(lineId, true);
  try {
    await unmatchStatementLine(token.value, lineId);
    await refresh();
    signalLedgerChange();
  } catch (e) {
    pickingError.value = e.message || "Unmatch failed.";
  } finally {
    setBusy(lineId, false);
  }
}

// Match-picker dropdown: when the user clicks "Match…" on an unmatched
// line, show GL candidates ordered by source match → amount → date. We
// use the broader all_unreconciled_gl_in_period list so the picker still
// works when the user hasn't normalized payment_source names to match
// the statement's source (e.g. statement says "Mastercard ••9475" but
// GL rows are tagged "Brex Card"). Source-matched rows sort to the top
// and source-mismatched ones get a warning chip in the template.
function candidatesForLine(line) {
  const targetAmount = Math.abs(Number(line.amount));
  const pool =
    view.value.all_unreconciled_gl_in_period ?? view.value.unreconciled_gl;
  return [...pool]
    .map((g) => ({
      ...g,
      // Default source_matches=true preserves behavior for older payloads
      // that don't include the flag (defense against version skew).
      source_matches: g.source_matches !== false,
      _amount_diff: Math.abs(Number(g.amount) - targetAmount),
      _date_diff: g.date && line.line_date
        ? Math.abs(new Date(g.date) - new Date(line.line_date)) / 86400000
        : 999,
    }))
    .sort((a, b) => {
      if (a.source_matches !== b.source_matches) {
        return a.source_matches ? -1 : 1;
      }
      if (a._amount_diff !== b._amount_diff) return a._amount_diff - b._amount_diff;
      return a._date_diff - b._date_diff;
    });
}

// Source-mismatch is the most common foot-gun on credit-card statements
// — surface the diagnostic any time we have unmatched debits AND there
// are GL rows in the period whose source doesn't agree with the
// statement's source. The original "only when zero matched" rule hid
// the diagnostic exactly when it was most useful (some GL rows happened
// to match, masking that many others were silently filtered out).
const shouldShowSourceDiagnostic = computed(() => {
  const sd = view.value?.source_diagnostic;
  if (!sd) return false;
  if (!sd.gl_sources_not_matching || sd.gl_sources_not_matching.length === 0) {
    return false;
  }
  const hasUnmatchedDebits = (view.value?.counts?.unmatched_debit ?? 0) > 0;
  const noMatches = sd.gl_matched_count === 0;
  return noMatches || hasUnmatchedDebits;
});

const statusPillClass = computed(() => {
  const s = view.value?.statement?.status;
  if (s === "reconciled") return "status-reconciled";
  if (s === "partially_reconciled") return "status-partially_reconciled";
  if (s === "needs_attention") return "status-needs_attention";
  return "status-imported";
});

// If the agent gave us an error string we render only that.
const hasError = computed(() => view.value && typeof view.value.error === "string");
</script>

<template>
  <div v-if="hasError" class="rc-empty">
    {{ view.error }}
  </div>

  <div v-else class="rc-panel">
    <!-- Header -->
    <header class="rc-head">
      <div class="rc-head-main">
        <h3 class="rc-source">{{ view.statement.source }}</h3>
        <p class="rc-period mono">
          {{ shortDate(view.statement.period_start) }} →
          {{ shortDate(view.statement.period_end) }}
          · close {{ shortDate(view.statement.statement_date) }}
        </p>
      </div>
      <div class="rc-head-stats">
        <span class="status-pill" :class="statusPillClass">
          {{ view.statement.status.replace(/_/g, " ") }}
        </span>
        <span class="count-chip">{{ view.counts.matched }} matched</span>
        <span class="count-chip warn" v-if="view.counts.unmatched_debit > 0">
          {{ view.counts.unmatched_debit }} unmatched
        </span>
        <span class="count-chip muted" v-if="view.counts.unmatched_credit > 0">
          {{ view.counts.unmatched_credit }} credits
        </span>
        <span class="count-chip info" v-if="view.counts.unreconciled_gl > 0">
          {{ view.counts.unreconciled_gl }} GL only
        </span>
      </div>
    </header>

    <!-- Balances summary line -->
    <p class="rc-balances mono">
      Opening {{ fmt(view.statement.opening_balance, view.statement.currency) }}
      · Closing {{ fmt(view.statement.closing_balance, view.statement.currency) }}
      · Charges {{ fmt(view.statement.total_charges, view.statement.currency) }}
      · Payments {{ fmt(view.statement.total_payments, view.statement.currency) }}
    </p>

    <p v-if="pickingError" class="rc-error">{{ pickingError }}</p>

    <!-- Source diagnostic — shown when source-name mismatch is likely
         filtering candidates (always show when there are unmatched
         debits and some GL rows use a different source name). -->
    <div
      v-if="shouldShowSourceDiagnostic"
      class="rc-diagnostic"
    >
      <strong v-if="view.source_diagnostic.gl_matched_count === 0">
        No GL rows matched this statement's source.
      </strong>
      <strong v-else>
        Some GL rows in this period use a different source name than this statement.
      </strong>
      The statement says
      <code>{{ view.source_diagnostic.statement_source }}</code>
      but the GL rows in this period use:
      <ul>
        <li
          v-for="s in view.source_diagnostic.gl_sources_not_matching"
          :key="s.name"
        ><code>{{ s.name }}</code> ({{ s.count }})</li>
      </ul>
      Tip: open one of those GL rows on the timeline and rename its
      <em>Payment source</em> to match the statement (matching on the
      last 4 of the account is enough). You can also still match them
      here — mismatched rows are marked with a
      <span class="src-warn-inline">different source</span> chip in the
      picker below.
    </div>

    <!-- Matched -->
    <section v-if="view.matched.length > 0" class="rc-section">
      <h4 class="rc-section-title">Matched ({{ view.matched.length }})</h4>
      <div class="rc-pair-list">
        <div
          v-for="pair in view.matched"
          :key="pair.id"
          class="rc-pair"
          :class="{ busy: busyLineIds.has(pair.id) }"
        >
          <div class="rc-line side-line">
            <div class="rc-line-head">
              <span class="mono date">{{ shortDate(pair.line_date) }}</span>
              <span
                class="amount mono"
                :class="{ negative: Number(pair.amount) < 0, positive: Number(pair.amount) > 0 }"
              >{{ fmt(pair.amount, view.statement.currency) }}</span>
            </div>
            <p class="rc-desc">{{ pair.description }}</p>
            <span class="method-tag" :class="`method-${pair.match_method || 'auto'}`">
              {{ pair.match_method || "auto" }}
            </span>
          </div>

          <div class="rc-link-arrow">↔</div>

          <div class="rc-gl side-gl" v-if="pair.matched_txn">
            <div class="rc-line-head">
              <span class="mono date">{{ shortDate(pair.matched_txn.date) }}</span>
              <span class="amount mono">{{ fmt(pair.matched_txn.amount, pair.matched_txn.currency) }}</span>
            </div>
            <p class="rc-desc">
              <strong>{{ pair.matched_txn.vendor || "—" }}</strong>
              <span v-if="pair.matched_txn.category"> · {{ pair.matched_txn.category }}</span>
            </p>
            <p class="rc-sub mono">{{ pair.matched_txn.id }}</p>
          </div>
          <div v-else class="rc-gl side-gl missing">
            <p class="rc-desc">Linked txn {{ pair.matched_txn_id }} not found.</p>
          </div>

          <button
            class="rc-unmatch ghost"
            :disabled="busyLineIds.has(pair.id)"
            @click="unmatch(pair.id)"
            title="Break the link between this line and the GL row"
          >Unmatch</button>
        </div>
      </div>
    </section>

    <!-- Unmatched debit lines (matchable, awaiting user action) -->
    <section v-if="view.unmatched_debits.length > 0" class="rc-section">
      <h4 class="rc-section-title">
        Unmatched statement lines ({{ view.unmatched_debits.length }})
      </h4>
      <div class="rc-line-list">
        <div
          v-for="line in view.unmatched_debits"
          :key="line.id"
          class="rc-unmatched"
          :class="{ busy: busyLineIds.has(line.id) }"
        >
          <div class="rc-line side-line">
            <div class="rc-line-head">
              <span class="mono date">{{ shortDate(line.line_date) }}</span>
              <span class="amount mono negative">{{ fmt(line.amount, view.statement.currency) }}</span>
            </div>
            <p class="rc-desc">{{ line.description }}</p>
          </div>

          <!-- Action panel: only one mode active per line at a time. -->
          <div v-if="isActive(line.id, 'match')" class="rc-picker">
            <p class="rc-picker-title">Match to which GL row?</p>
            <div
              v-if="candidatesForLine(line).length === 0"
              class="rc-picker-empty"
            >No unreconciled GL rows in this period.</div>
            <ul v-else class="rc-picker-list">
              <li
                v-for="g in candidatesForLine(line)"
                :key="g.id"
                class="rc-picker-item"
                :class="{ exact: g._amount_diff <= 0.01, mismatch: !g.source_matches }"
              >
                <button
                  class="rc-picker-btn"
                  :disabled="busyLineIds.has(line.id)"
                  @click="manualMatch(line.id, g.id)"
                >
                  <span class="mono">{{ shortDate(g.date) }}</span>
                  <strong>{{ g.vendor || "—" }}</strong>
                  <span class="mono">{{ fmt(g.amount, g.currency) }}</span>
                  <span class="picker-tags">
                    <span v-if="g._amount_diff <= 0.01" class="exact-tag">exact</span>
                    <span
                      v-if="!g.source_matches"
                      class="src-warn-tag"
                      :title="`GL payment_source is '${g.payment_source}' — doesn't match statement source '${view.statement.source}'`"
                    >{{ g.payment_source || "no source" }}</span>
                  </span>
                </button>
              </li>
            </ul>
            <button class="ghost" @click="closeAction">Cancel</button>
          </div>

          <div v-else-if="isActive(line.id, 'book')" class="rc-action-form">
            <p class="rc-picker-title">Book as new transaction</p>
            <div class="rc-form-grid">
              <label>
                <span>Vendor</span>
                <input
                  v-model="bookFormFor(line).vendor"
                  type="text"
                  placeholder="Who charged this?"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label>
                <span>Category</span>
                <select
                  v-model="bookFormFor(line).category"
                  :disabled="busyLineIds.has(line.id)"
                >
                  <option value="">— pick a category —</option>
                  <option
                    v-for="c in categories"
                    :key="c.name"
                    :value="c.name"
                  >{{ c.name }}</option>
                </select>
              </label>
              <label>
                <span>Date</span>
                <input
                  v-model="bookFormFor(line).date"
                  type="date"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label>
                <span>Payment source</span>
                <select
                  v-model="bookFormFor(line).payment_source"
                  :disabled="busyLineIds.has(line.id)"
                >
                  <option value="">— pick a source —</option>
                  <option
                    v-for="s in paymentSources"
                    :key="s.name"
                    :value="s.name"
                  >{{ s.name }}</option>
                </select>
              </label>
              <label class="span-2">
                <span>Description</span>
                <input
                  v-model="bookFormFor(line).description"
                  type="text"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label class="span-2">
                <span>Notes</span>
                <input
                  v-model="bookFormFor(line).notes"
                  type="text"
                  placeholder="(optional)"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <div class="span-2 rc-amount-readout">
                Amount: <strong class="mono">{{ fmt(Math.abs(Number(line.amount)), view.statement.currency) }}</strong>
                <span class="hint">(from statement line)</span>
              </div>
            </div>
            <div class="rc-form-actions">
              <button
                class="primary"
                :disabled="busyLineIds.has(line.id)"
                @click="submitBook(line)"
              >Book transaction</button>
              <button class="ghost" @click="closeAction">Cancel</button>
            </div>
          </div>

          <div v-else-if="isActive(line.id, 'transfer')" class="rc-action-form">
            <p class="rc-picker-title">
              Mark as transfer (money out of <code>{{ view.statement.source }}</code>)
            </p>
            <div class="rc-form-grid">
              <label class="span-2">
                <span>To account</span>
                <select
                  v-model="transferFormFor(line).other_source"
                  :disabled="busyLineIds.has(line.id)"
                >
                  <option value="">— pick the receiving account —</option>
                  <option
                    v-for="s in paymentSources"
                    :key="s.name"
                    :value="s.name"
                    :disabled="s.name === view.statement.source"
                  >{{ s.name }}</option>
                </select>
              </label>
              <label>
                <span>Date</span>
                <input
                  v-model="transferFormFor(line).date"
                  type="date"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label class="span-2">
                <span>Description</span>
                <input
                  v-model="transferFormFor(line).description"
                  type="text"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label class="span-2">
                <span>Notes</span>
                <input
                  v-model="transferFormFor(line).notes"
                  type="text"
                  placeholder="(optional)"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <div class="span-2 rc-amount-readout">
                Amount: <strong class="mono">{{ fmt(Math.abs(Number(line.amount)), view.statement.currency) }}</strong>
                <span class="hint">(from statement line)</span>
              </div>
            </div>
            <div class="rc-form-actions">
              <button
                class="primary"
                :disabled="busyLineIds.has(line.id)"
                @click="submitTransfer(line)"
              >Save transfer</button>
              <button class="ghost" @click="closeAction">Cancel</button>
            </div>
          </div>

          <div v-else class="rc-action-row">
            <button
              class="rc-match-btn primary"
              :disabled="busyLineIds.has(line.id)"
              @click="setAction(line.id, 'match')"
            >Match…</button>
            <button
              class="ghost"
              :disabled="busyLineIds.has(line.id)"
              @click="setAction(line.id, 'book')"
              title="Create a new GL row from this line (late fees, finance charges, anything that should hit the books)"
            >Book as new…</button>
            <button
              class="ghost"
              :disabled="busyLineIds.has(line.id)"
              @click="setAction(line.id, 'transfer')"
              title="Treat this as a transfer between two of your accounts"
            >Mark as transfer…</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Unmatched credits (income or transfer-in) -->
    <section v-if="view.unmatched_credits.length > 0" class="rc-section">
      <h4 class="rc-section-title muted">
        Deposits / credits ({{ view.unmatched_credits.length }})
        <span class="hint">— mark transfers in; income matching isn't built yet</span>
      </h4>
      <div class="rc-line-list">
        <div
          v-for="line in view.unmatched_credits"
          :key="line.id"
          class="rc-unmatched"
          :class="{ busy: busyLineIds.has(line.id) }"
        >
          <div class="rc-line side-line">
            <div class="rc-line-head">
              <span class="mono date">{{ shortDate(line.line_date) }}</span>
              <span class="amount mono positive">{{ fmt(line.amount, view.statement.currency) }}</span>
            </div>
            <p class="rc-desc">{{ line.description }}</p>
          </div>

          <div v-if="isActive(line.id, 'transfer')" class="rc-action-form">
            <p class="rc-picker-title">
              Mark as transfer (money into <code>{{ view.statement.source }}</code>)
            </p>
            <div class="rc-form-grid">
              <label class="span-2">
                <span>From account</span>
                <select
                  v-model="transferFormFor(line).other_source"
                  :disabled="busyLineIds.has(line.id)"
                >
                  <option value="">— pick the sending account —</option>
                  <option
                    v-for="s in paymentSources"
                    :key="s.name"
                    :value="s.name"
                    :disabled="s.name === view.statement.source"
                  >{{ s.name }}</option>
                </select>
              </label>
              <label>
                <span>Date</span>
                <input
                  v-model="transferFormFor(line).date"
                  type="date"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label class="span-2">
                <span>Description</span>
                <input
                  v-model="transferFormFor(line).description"
                  type="text"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <label class="span-2">
                <span>Notes</span>
                <input
                  v-model="transferFormFor(line).notes"
                  type="text"
                  placeholder="(optional)"
                  :disabled="busyLineIds.has(line.id)"
                />
              </label>
              <div class="span-2 rc-amount-readout">
                Amount: <strong class="mono">{{ fmt(Math.abs(Number(line.amount)), view.statement.currency) }}</strong>
                <span class="hint">(from statement line)</span>
              </div>
            </div>
            <div class="rc-form-actions">
              <button
                class="primary"
                :disabled="busyLineIds.has(line.id)"
                @click="submitTransfer(line)"
              >Save transfer</button>
              <button class="ghost" @click="closeAction">Cancel</button>
            </div>
          </div>

          <div v-else class="rc-action-row">
            <button
              class="ghost"
              :disabled="busyLineIds.has(line.id)"
              @click="setAction(line.id, 'transfer')"
              title="Treat this as a transfer between two of your accounts"
            >Mark as transfer…</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Unreconciled GL (in source+period, not pointed at by any line) -->
    <section v-if="view.unreconciled_gl.length > 0" class="rc-section">
      <h4 class="rc-section-title">
        GL rows with no matching statement line ({{ view.unreconciled_gl.length }})
        <span class="hint">— recorded in your books but not on this statement</span>
      </h4>
      <div class="rc-gl-list">
        <div
          v-for="g in view.unreconciled_gl"
          :key="g.id"
          class="rc-gl-row"
        >
          <span class="mono date">{{ shortDate(g.date) }}</span>
          <strong>{{ g.vendor || "—" }}</strong>
          <span class="rc-desc">{{ g.category || "—" }}</span>
          <span class="amount mono">{{ fmt(g.amount, g.currency) }}</span>
          <span class="mono rc-sub">{{ g.id }}</span>
        </div>
      </div>
    </section>

    <div
      v-if="view.matched.length === 0 && view.unmatched_debits.length === 0 && view.unmatched_credits.length === 0 && view.unreconciled_gl.length === 0"
      class="rc-empty"
    >Nothing to show — no statement lines and no GL rows in this source/period.</div>
  </div>
</template>

<style scoped>
.rc-panel {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.rc-empty {
  color: var(--text-muted);
  font-size: 0.9rem;
  padding: 1rem 0;
}

/* ── Header ─────────────────────────────────────────────────────────── */
.rc-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.rc-source {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.rc-period {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.rc-head-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.status-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-family: var(--font-mono);
}

.status-pill.status-imported {
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.status-pill.status-partially_reconciled {
  background: #fffbeb;
  color: #b45309;
  border: 1px solid #fde68a;
}

.status-pill.status-reconciled {
  background: #f0fdf4;
  color: var(--ok);
  border: 1px solid #bbf7d0;
}

.status-pill.status-needs_attention {
  background: #fef2f2;
  color: var(--danger);
  border: 1px solid #fecaca;
}

.count-chip {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  padding: 1px 7px;
  border-radius: 3px;
  background: #f0f0eb;
  color: var(--text-muted);
}

.count-chip.warn {
  background: #fffbeb;
  color: #b45309;
}

.count-chip.muted {
  background: #f0f0eb;
  color: var(--text-muted);
}

.count-chip.info {
  background: #eff6ff;
  color: #1d4ed8;
}

.rc-balances {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.rc-error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.4rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.rc-diagnostic {
  font-size: 0.8rem;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: var(--radius);
  padding: 0.65rem 0.85rem;
  line-height: 1.5;
}

.rc-diagnostic ul {
  margin: 0.35rem 0;
  padding-left: 1.25rem;
}

.rc-diagnostic code {
  font-family: var(--font-mono);
  font-size: 0.78rem;
}

/* ── Sections ──────────────────────────────────────────────────────── */
.rc-section {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.rc-section-title {
  margin: 0;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text);
}

.rc-section-title.muted {
  color: var(--text-muted);
}

.rc-section-title .hint {
  font-size: 0.7rem;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted);
  font-style: italic;
  margin-left: 0.4rem;
}

/* ── Matched pairs ─────────────────────────────────────────────────── */
.rc-pair-list,
.rc-line-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.rc-pair {
  display: grid;
  grid-template-columns: 1fr 32px 1fr auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.rc-pair.busy {
  opacity: 0.6;
  pointer-events: none;
}

.rc-line,
.rc-gl {
  font-size: 0.78rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.side-line {
  background: #fffbeb;
  border-radius: 4px;
  padding: 0.35rem 0.5rem;
}

.side-gl {
  background: #eff6ff;
  border-radius: 4px;
  padding: 0.35rem 0.5rem;
}

.side-gl.missing {
  background: #fef2f2;
  color: var(--danger);
}

.rc-line-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.rc-line-head .date {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.rc-line-head .amount {
  font-weight: 600;
  font-size: 0.85rem;
}

.amount.negative {
  color: var(--danger);
}

.amount.positive {
  color: var(--ok);
}

.rc-desc {
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.78rem;
}

.rc-sub {
  font-size: 0.65rem;
  color: var(--text-muted);
}

.method-tag {
  font-size: 0.6rem;
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  background: #f0f0eb;
  color: var(--text-muted);
  padding: 1px 6px;
  border-radius: 3px;
  align-self: flex-start;
}

.method-tag.method-manual {
  background: #eff6ff;
  color: #1d4ed8;
}

.rc-link-arrow {
  font-size: 0.95rem;
  color: var(--text-muted);
  text-align: center;
}

.rc-unmatch {
  font-size: 0.7rem;
  padding: 0.25rem 0.55rem;
}

/* ── Unmatched lines ───────────────────────────────────────────────── */
.rc-unmatched {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  flex-wrap: wrap;
}

.rc-unmatched .rc-line {
  flex: 1 1 240px;
}

.rc-unmatched.busy {
  opacity: 0.6;
  pointer-events: none;
}

.rc-match-btn {
  padding: 0.3rem 0.7rem;
  font-size: 0.78rem;
  align-self: center;
}

.rc-picker {
  flex: 1 1 100%;
  background: #fafaf5;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.5rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.rc-picker-title {
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-muted);
  font-weight: 600;
}

.rc-picker-empty {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
}

.rc-picker-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 220px;
  overflow-y: auto;
}

.rc-picker-btn {
  display: grid;
  grid-template-columns: 90px 1fr 110px auto;
  align-items: baseline;
  gap: 0.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.3rem 0.55rem;
  cursor: pointer;
  text-align: left;
  font-size: 0.78rem;
  width: 100%;
}

.rc-picker-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: #fafaf5;
}

.rc-picker-item.exact .rc-picker-btn {
  border-color: #bbf7d0;
}

.picker-tags {
  display: inline-flex;
  gap: 0.3rem;
  align-items: center;
  justify-self: end;
}

.exact-tag {
  font-size: 0.6rem;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--ok);
  background: #f0fdf4;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
}

.src-warn-tag {
  font-size: 0.6rem;
  font-family: var(--font-mono);
  font-weight: 600;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  padding: 0 5px;
  border-radius: 3px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.src-warn-inline {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  font-weight: 600;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  padding: 0 5px;
  border-radius: 3px;
}

.rc-picker-item.mismatch .rc-picker-btn {
  border-color: #fde68a;
  background: #fffdf5;
}

/* ── Action row (Match… / Book as new… / Mark as transfer…) ─────── */
.rc-action-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
  align-self: center;
}

/* ── Inline Book / Mark-as-transfer form ────────────────────────── */
.rc-action-form {
  flex: 1 1 100%;
  background: #fafaf5;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.6rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.rc-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 0.6rem;
}

.rc-form-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.74rem;
}

.rc-form-grid label > span {
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
}

.rc-form-grid input,
.rc-form-grid select {
  font-size: 0.82rem;
  padding: 0.32rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  width: 100%;
}

.rc-form-grid input:focus,
.rc-form-grid select:focus {
  outline: none;
  border-color: var(--accent);
}

.rc-form-grid .span-2 {
  grid-column: span 2;
}

.rc-amount-readout {
  font-size: 0.78rem;
  color: var(--text-muted);
  padding: 0.25rem 0;
}

.rc-amount-readout .hint {
  font-style: italic;
  margin-left: 0.4rem;
}

.rc-form-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* ── Unmatched credits ─────────────────────────────────────────────── */
.rc-credit {
  display: grid;
  grid-template-columns: 90px 110px 1fr;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.78rem;
}

/* ── Unreconciled GL ──────────────────────────────────────────────── */
.rc-gl-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.rc-gl-row {
  display: grid;
  grid-template-columns: 90px 160px 1fr 110px 110px;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.78rem;
}

.rc-gl-row .rc-desc {
  font-style: italic;
  color: var(--text-muted);
}

.mono {
  font-family: var(--font-mono);
}

.date {
  font-family: var(--font-mono);
  color: var(--text-muted);
}

button.primary {
  font-size: 0.8rem;
  padding: 0.35rem 0.85rem;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.78rem;
  padding: 0.3rem 0.65rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .rc-pair {
    grid-template-columns: 1fr;
  }
  .rc-link-arrow {
    transform: rotate(90deg);
  }
  .rc-gl-row {
    grid-template-columns: 1fr;
  }
}
</style>
