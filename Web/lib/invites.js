// invites.js
// =========================================================================
// Thin client for the Worker's /invites endpoints. Pure data — the renderer
// owns the DOM. We hold the message catalog in module state because it
// rarely changes and the cost of re-fetching it on every modal open is silly.
// =========================================================================

let messageCatalog = null;

export async function loadMessageCatalog(serverURL) {
  if (messageCatalog) return messageCatalog;
  const r = await fetch(`${serverURL}/invites/messages`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!r.ok) throw new Error("messages http " + r.status);
  const data = await r.json();
  messageCatalog = data?.messages ?? {};
  return messageCatalog;
}

export function getMessageText(id) {
  return messageCatalog?.[id] ?? null;
}

export function getMessageCatalog() {
  return messageCatalog ?? {};
}

export async function sendInvite(serverURL, sessionToken, toID, messageId) {
  const r = await fetch(`${serverURL}/invites`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ toID, messageId }),
  });
  return parseJSON(r);
}

export async function fetchInbox(serverURL, sessionToken) {
  const r = await fetch(`${serverURL}/invites/inbox`, {
    credentials: "include",
    headers: { authorization: `Bearer ${sessionToken}` },
    cache: "no-store",
  });
  if (!r.ok) return { ok: false, status: r.status };
  const data = await r.json();
  return { ok: true, invites: Array.isArray(data?.invites) ? data.invites : [] };
}

export async function fetchOutbox(serverURL, sessionToken) {
  const r = await fetch(`${serverURL}/invites/outbox`, {
    credentials: "include",
    headers: { authorization: `Bearer ${sessionToken}` },
    cache: "no-store",
  });
  if (!r.ok) return { ok: false, status: r.status };
  const data = await r.json();
  return { ok: true, invites: Array.isArray(data?.invites) ? data.invites : [] };
}

export async function respondToInvite(serverURL, sessionToken, inviteId, action) {
  const r = await fetch(`${serverURL}/invites/${inviteId}/${action}`, {
    method: "POST",
    credentials: "include",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  return parseJSON(r);
}

export async function withdrawInvite(serverURL, sessionToken, inviteId) {
  const r = await fetch(`${serverURL}/invites/${inviteId}`, {
    method: "DELETE",
    credentials: "include",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  return parseJSON(r);
}

async function parseJSON(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data?.error ?? "http_error" };
  return { ok: true, ...data };
}
