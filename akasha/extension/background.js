// background.js — the wallet service worker (MV3, type:module). DEPENDENCY-FREE on purpose: it never
// touches keys or ethers. It routes EIP-1193 requests using request-router.mjs:
//   local        → answered here
//   passthrough  → fetched from the PRANA JSON-RPC node (host_permission)
//   permissioned → queued; the POPUP (which holds the unlocked vault) approves + signs, then resolves it
//   refused/invalid → error
// The popup is the only place keys live; it pushes authorized accounts + signed results back here.

import { classify, answerLocal, parseRequest, PRANA_CHAIN_ID_HEX } from './request-router.mjs';

const RPC_URL = 'https://rpc.prana.alpha.melek.salon';
const state = { chainIdHex: PRANA_CHAIN_ID_HEX, authorizedAccounts: [] };
const pending = new Map();     // id -> { sendResponse, method, params, origin }
let pendingSeq = 1;

// Restore authorized accounts across worker restarts.
chrome.storage.local.get(['authorizedAccounts'], (o) => {
  if (Array.isArray(o.authorizedAccounts)) state.authorizedAccounts = o.authorizedAccounts;
});

async function passthrough(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
  });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { code: j.error.code });
  return j.result;
}

function queuePermissioned(method, params, origin, sendResponse) {
  const id = pendingSeq++;
  pending.set(id, { sendResponse, method, params, origin });
  // Surface the request: a badge + open the popup so the user can approve/sign.
  chrome.action.setBadgeText({ text: String(pending.size) });
  if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
}

// Page requests (from content.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.kind !== 'request') return false;
  const parsed = parseRequest({ method: msg.method, params: msg.params });
  if (!parsed.ok) { sendResponse({ error: { code: -32602, message: parsed.reason } }); return false; }
  const kind = classify(parsed.method);

  if (kind === 'refused') { sendResponse({ error: { code: 4200, message: parsed.method + ' is disabled in Akasha' } }); return false; }
  if (kind === 'invalid') { sendResponse({ error: { code: -32602, message: 'invalid method' } }); return false; }
  if (kind === 'local') { sendResponse({ result: answerLocal(parsed.method, state).result }); return false; }
  if (kind === 'passthrough') {
    passthrough(parsed.method, parsed.params)
      .then((result) => sendResponse({ result }))
      .catch((e) => sendResponse({ error: { code: e.code || -32603, message: e.message } }));
    return true; // async
  }
  // permissioned: park it for the popup; keep the channel open until resolved/rejected.
  queuePermissioned(parsed.method, parsed.params, msg.origin, sendResponse);
  return true;
});

// Popup control messages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.kind || !msg.kind.startsWith('wallet:')) return false;
  switch (msg.kind) {
    case 'wallet:getPending': {
      const list = [...pending.entries()].map(([id, p]) => ({ id, method: p.method, params: p.params, origin: p.origin }));
      sendResponse({ pending: list, state });
      return false;
    }
    case 'wallet:unlocked': {
      // popup unlocked the vault; record authorized accounts + tell pages.
      state.authorizedAccounts = Array.isArray(msg.accounts) ? msg.accounts : [];
      chrome.storage.local.set({ authorizedAccounts: state.authorizedAccounts });
      broadcastEvent('accountsChanged', state.authorizedAccounts);
      sendResponse({ ok: true });
      return false;
    }
    case 'wallet:resolve': {
      const p = pending.get(msg.id);
      if (p) { p.sendResponse({ result: msg.result }); pending.delete(msg.id); }
      chrome.action.setBadgeText({ text: pending.size ? String(pending.size) : '' });
      sendResponse({ ok: true });
      return false;
    }
    case 'wallet:reject': {
      const p = pending.get(msg.id);
      if (p) { p.sendResponse({ error: { code: 4001, message: 'User rejected the request.' } }); pending.delete(msg.id); }
      chrome.action.setBadgeText({ text: pending.size ? String(pending.size) : '' });
      sendResponse({ ok: true });
      return false;
    }
    default: return false;
  }
});

function broadcastEvent(event, data) {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) { try { chrome.tabs.sendMessage(t.id, { kind: 'event', event, data }); } catch { /* tab without our content script */ } }
  });
}
