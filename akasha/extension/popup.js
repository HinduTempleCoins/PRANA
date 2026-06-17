// popup.js — the wallet UI. Holds the unlocked vault IN MEMORY (popup lifetime only), drives unlock /
// create, and approves+signs the permissioned requests the background parked. Signing goes through
// window.AkashaWalletCore (wallet-core.bundle.js). The background never sees keys.
/* global AkashaWalletCore, chrome */

const $ = (id) => document.getElementById(id);
let vault = null;         // unlocked vault (in-memory only)
let address = null;

const VAULT_KEY = 'akashaVaultFile';

function show(view) {
  for (const v of ['lockView', 'walletView', 'createView']) $(v).classList.toggle('hide', v !== view);
}

async function unlock() {
  $('lockErr').textContent = '';
  const pw = $('pw').value;
  const { [VAULT_KEY]: vaultFile } = await chrome.storage.local.get([VAULT_KEY]);
  if (!vaultFile) { $('lockErr').textContent = 'No vault yet — create one.'; return; }
  try {
    const r = await AkashaWalletCore.openVault(vaultFile, pw);
    vault = r.vault; address = r.address;
    $('addr').textContent = address;
    await chrome.runtime.sendMessage({ kind: 'wallet:unlocked', accounts: [address] });
    show('walletView');
    renderPending();
  } catch (e) { $('lockErr').textContent = 'Wrong password.'; }
}

async function createNew() {
  $('lockErr').textContent = '';
  const pw = $('pw').value;
  if (!pw || pw.length < 8) { $('lockErr').textContent = 'Choose a password (8+ chars) first.'; return; }
  const r = await AkashaWalletCore.newVault(pw);
  await chrome.storage.local.set({ [VAULT_KEY]: r.vaultFile });
  vault = r.vault; address = r.address;
  $('mnemonic').textContent = r.mnemonic;
  show('createView');
}

function lock() { vault = null; address = null; $('pw').value = ''; show('lockView'); }

async function renderPending() {
  const box = $('pending');
  box.replaceChildren();
  const { pending } = await chrome.runtime.sendMessage({ kind: 'wallet:getPending' });
  if (!pending || !pending.length) {
    const d = document.createElement('div'); d.className = 'mut'; d.textContent = 'No pending requests.'; box.appendChild(d); return;
  }
  for (const req of pending) {
    const card = document.createElement('div'); card.className = 'card';
    const title = document.createElement('div'); title.textContent = req.method;
    const origin = document.createElement('div'); origin.className = 'mut'; origin.style.fontSize = '11px'; origin.textContent = req.origin || '';
    const detail = document.createElement('code'); detail.textContent = summarize(req);
    const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
    const ok = document.createElement('button'); ok.textContent = req.method === 'eth_sendTransaction' ? 'Sign & send' : (req.method === 'eth_requestAccounts' ? 'Connect' : 'Sign');
    const no = document.createElement('button'); no.className = 'ghost'; no.textContent = 'Reject';
    ok.addEventListener('click', () => approve(req));
    no.addEventListener('click', () => reject(req.id));
    row.append(ok, no);
    card.append(title, origin, detail, row);
    box.appendChild(card);
  }
}

function summarize(req) {
  if (req.method === 'eth_sendTransaction') { const t = (req.params && req.params[0]) || {}; return `to ${t.to || '—'}  value ${t.value || '0'}`; }
  if (req.method === 'personal_sign') { return String((req.params && req.params[0]) || '').slice(0, 60); }
  return req.method;
}

async function approve(req) {
  try {
    let result;
    if (req.method === 'eth_requestAccounts' || req.method === 'wallet_requestPermissions') {
      result = [address];
    } else if (req.method === 'wallet_switchEthereumChain' || req.method === 'wallet_addEthereumChain') {
      result = null; // already on PRANA
    } else {
      if (!vault) { lock(); return; }
      result = await AkashaWalletCore.signRequest(vault, req.method, req.params, 0);
    }
    await chrome.runtime.sendMessage({ kind: 'wallet:resolve', id: req.id, result });
  } catch (e) {
    await chrome.runtime.sendMessage({ kind: 'wallet:reject', id: req.id });
  }
  renderPending();
}

async function reject(id) { await chrome.runtime.sendMessage({ kind: 'wallet:reject', id }); renderPending(); }

$('unlockBtn').addEventListener('click', unlock);
$('createBtn').addEventListener('click', createNew);
$('createDone').addEventListener('click', () => { show('walletView'); $('addr').textContent = address; renderPending(); chrome.runtime.sendMessage({ kind: 'wallet:unlocked', accounts: [address] }); });
$('lockBtn').addEventListener('click', lock);
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

// On open, show the right view based on whether a vault exists.
(async () => {
  const { [VAULT_KEY]: vf } = await chrome.storage.local.get([VAULT_KEY]);
  $('lockHint').textContent = vf ? 'Unlock your vault to connect dapps.' : 'No vault yet — set a password and create one.';
  show('lockView');
})();
