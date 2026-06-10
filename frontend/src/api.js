// Thin fetch wrapper for the Noviustec API.
//
// In dev (Vite serving on :5173), BASE_URL is empty and Vite's proxy
// forwards /api/* to http://127.0.0.1:3000. In prod, VITE_API_URL is set
// at build time via .env.production to https://api-demo.noviustec.com.

const BASE_URL = import.meta.env.VITE_API_URL || "";

async function request(token, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    // body was empty or non-JSON; treat as `{}`
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const listPending = (token, status = "pending") =>
  request(token, "GET", `/api/pending?status=${encodeURIComponent(status)}`);

export const getPending = (token, id) =>
  request(token, "GET", `/api/pending/${encodeURIComponent(id)}`);

export const approvePending = (token, id, body) =>
  request(token, "POST", `/api/pending/${encodeURIComponent(id)}/approve`, body);

export const rejectPending = (token, id, body) =>
  request(token, "POST", `/api/pending/${encodeURIComponent(id)}/reject`, body);

export const reparsePending = (token, id) =>
  request(token, "POST", `/api/pending/${encodeURIComponent(id)}/reparse`);

export const getCategories = (token) =>
  request(token, "GET", "/api/categories");

export const getPaymentSources = (token) =>
  request(token, "GET", "/api/sources");

export const listAwaiting = (token, status = "awaiting") =>
  request(token, "GET", `/api/awaiting?status=${encodeURIComponent(status)}`);

/**
 * Fetch the global, all-vendor timeline payload. Used by App.vue to
 * auto-load the dashboard home screen on login. Returns
 * { kind, title, props } — the same shape the agent's panel events have.
 */
export const fetchMainTimeline = (token) =>
  request(token, "GET", "/api/main-timeline");

/** Single-vendor timeline. Used by App.vue to refetch a vendor timeline
 *  panel after a ledger mutation. */
export function fetchVendorTimeline(token, { vendor, from, to } = {}) {
  const params = new URLSearchParams({ vendor });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return request(token, "GET", `/api/vendor-timeline?${params.toString()}`);
}

/** Fetch one GL transaction by id (used by the timeline edit dialog). */
export const fetchTransaction = (token, id) =>
  request(token, "GET", `/api/transactions/${encodeURIComponent(id)}`);

/** Fetch one AwaitingPayment row by id. */
export const fetchAwaiting = (token, id) =>
  request(token, "GET", `/api/awaiting/${encodeURIComponent(id)}`);

/** Edit a GL transaction. Body is a partial — only patchable fields are accepted server-side. */
export const updateTransaction = (token, id, body) =>
  request(token, "PATCH", `/api/transactions/${encodeURIComponent(id)}`, body);

/**
 * Delete a GL transaction. Returns 409 with a `blockers` array when
 * the row is referenced by statement lines, awaiting rows, or
 * Documents — the dialog surfaces those reasons so the user knows
 * what to unlink first.
 */
export const deleteTransaction = (token, id) =>
  request(token, "DELETE", `/api/transactions/${encodeURIComponent(id)}`);

/**
 * Search existing GL transactions for the "Link existing payment"
 * picker. Filters by vendor (substring) and optional date range.
 * Each row carries `already_linked` and `already_linked_to` (an
 * awaiting id) when some other awaiting already settles it.
 */
export const searchTransactions = (token, { vendor, from, to, limit } = {}) => {
  const params = new URLSearchParams();
  if (vendor) params.set("vendor", vendor);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return request(token, "GET", `/api/transactions${qs ? `?${qs}` : ""}`);
};

/**
 * Link an outstanding awaiting to an existing GL transaction (rather
 * than creating a new one via Record-payment). The awaiting flips to
 * paid; its Documents rows get re-attached to the linked txn.
 */
export const linkExistingTxnToAwaiting = (token, awaitingId, txnId) =>
  request(
    token,
    "POST",
    `/api/awaiting/${encodeURIComponent(awaitingId)}/link-txn`,
    { txn_id: txnId },
  );

/**
 * Create a new GL transaction. Used by TransactionDraftPanel when the
 * user clicks Approve on an agent-proposed draft. The agent itself
 * NEVER calls this endpoint — propose_transaction renders a panel,
 * and only this approve-click path writes to the ledger.
 */
export const createTransaction = (token, body) =>
  request(token, "POST", "/api/transactions", body);

/** Edit an AwaitingPayment row (status / paid_txn_id are not patchable here — use Record-payment). */
export const updateAwaiting = (token, id, body) =>
  request(token, "PATCH", `/api/awaiting/${encodeURIComponent(id)}`, body);

/** Fetch the reconciliation view for a statement (panel payload). */
export const fetchReconciliation = (token, statementId) =>
  request(
    token,
    "GET",
    `/api/statements/${encodeURIComponent(statementId)}/reconciliation`,
  );

/** Trigger the auto-match heuristic against a statement. Returns counts. */
export const reconcileStatement = (token, statementId) =>
  request(
    token,
    "POST",
    `/api/statements/${encodeURIComponent(statementId)}/reconcile`,
  );

/** Manually pair a statement line with a GL transaction. */
export const matchStatementLine = (token, lineId, txnId) =>
  request(
    token,
    "POST",
    `/api/statement-lines/${encodeURIComponent(lineId)}/match`,
    { txn_id: txnId },
  );

/** Clear an existing match on a statement line. */
export const unmatchStatementLine = (token, lineId) =>
  request(
    token,
    "POST",
    `/api/statement-lines/${encodeURIComponent(lineId)}/unmatch`,
  );

/**
 * Book an unmatched statement debit line as a brand-new GL transaction
 * (late fees, finance charges, anything missing from the books). The
 * server creates the GL row and matches the statement line to it in
 * one call. Body:
 *   { vendor, category, date, payment_source, description?, notes? }
 */
export const bookStatementLineAsTransaction = (token, lineId, body) =>
  request(
    token,
    "POST",
    `/api/statement-lines/${encodeURIComponent(lineId)}/book-as-transaction`,
    body,
  );

/**
 * Mark an unmatched statement line as an inter-account transfer. The
 * server creates a Transfer row whose direction is inferred from the
 * line's sign (debit=out, credit=in) and matches the line to it. Body:
 *   { other_source, date, description?, notes? }
 */
export const markStatementLineAsTransfer = (token, lineId, body) =>
  request(
    token,
    "POST",
    `/api/statement-lines/${encodeURIComponent(lineId)}/mark-as-transfer`,
    body,
  );

/**
 * Record a manual payment against an outstanding AwaitingPayment row.
 * No receipt document required — for checks, credit-card charges with
 * no vendor receipt, etc. Books a GL row using the awaiting row's
 * vendor + amount.
 */
export const recordPayment = (token, awaitingId, body) =>
  request(
    token,
    "POST",
    `/api/awaiting/${encodeURIComponent(awaitingId)}/pay`,
    body,
  );

/**
 * Settle an awaiting-transfer (e.g. credit-card balance) by recording a
 * money movement between two of your own accounts. Body:
 *   { date, from_source, description?, notes? }
 * The to_source is implicit (the awaiting's vendor).
 */
export const recordTransferPayment = (token, awaitingId, body) =>
  request(
    token,
    "POST",
    `/api/awaiting/${encodeURIComponent(awaitingId)}/pay-transfer`,
    body,
  );

/**
 * DESTRUCTIVE: wipe all data (transactions, pending, awaiting, documents,
 * statements, inbound emails) and reset the system to an empty state.
 * Demo-only — the server gates this behind ENABLE_DEMO_RESET.
 */
export const resetSystem = (token) =>
  request(token, "POST", "/api/admin/reset");

/** Quick health check, no auth. */
export async function healthCheck() {
  const res = await fetch(`${BASE_URL}/health`);
  return res.json();
}

/**
 * Open the document attached to a pending entry in a new tab.
 * Uses fetch+blob so the bearer token can travel in the header rather
 * than the URL.
 */
export async function openPendingDocument(token, pendingId) {
  return openDocumentBlob(token, `/api/documents/pending/${encodeURIComponent(pendingId)}`);
}

/** Same for an approved GL transaction's archived document. */
export async function openTransactionDocument(token, txnId) {
  return openDocumentBlob(token, `/api/documents/transaction/${encodeURIComponent(txnId)}`);
}

/**
 * Fetch an authenticated download (PDF / image / xlsx) and trigger a
 * Save-As dialog with the provided filename. Works cross-origin because
 * the blob is created from in-memory bytes, sidestepping the same-origin
 * limit on the native <a download> attribute.
 */
export async function downloadFile(token, apiPath, filename) {
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke a bit later so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function openDocumentBlob(token, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  // Free the object URL after the window has a chance to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Upload a single PDF/image. Reads the file, base64-encodes it, POSTs to /api/upload. */
export async function uploadReceipt(token, { file, description }) {
  const content_base64 = await fileToBase64(file);
  return request(token, "POST", "/api/upload", {
    filename: file.name,
    content_type: file.type,
    content_base64,
    description: description || "",
  });
}

/** Upload a bank or credit-card statement PDF for parsing + import. */
export async function uploadStatement(token, { file, description }) {
  const content_base64 = await fileToBase64(file);
  return request(token, "POST", "/api/upload-statement", {
    filename: file.name,
    content_type: file.type,
    content_base64,
    description: description || "",
  });
}

/**
 * Stream a chat turn from the bookkeeping agent. POSTs the full message
 * history and consumes the SSE response, invoking `onEvent` with each
 * parsed event ({type: "text_delta"|"tool_use"|"tool_result"|"usage"|"done"|"error", ...}).
 * Resolves when the stream closes.
 */
export async function streamAgentResponse(token, messages, onEvent) {
  const res = await fetch(`${BASE_URL}/api/agent/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (!res.body) {
    throw new Error("Streaming not supported by this browser");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; within a frame, fields
    // are line-delimited. We only emit `data:` lines.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep partial trailing line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // ignore malformed frames rather than aborting the stream
      }
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<type>;base64,<content>" — strip the prefix.
      const r = reader.result;
      const comma = typeof r === "string" ? r.indexOf(",") : -1;
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
