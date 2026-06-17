// inpage.js — injected into the page's MAIN world. Defines window.ethereum as a minimal EIP-1193
// provider that relays every request() to the content script (and on to the background wallet worker).
// No keys here, ever — the page world is untrusted. (TronLink/MetaMask pattern.)
(function () {
  if (window.ethereum && window.ethereum.isAkasha) return;

  let nextId = 1;
  const pending = new Map();          // id -> {resolve, reject}
  const listeners = new Map();        // event -> Set<fn>

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ target: 'akasha-content', kind: 'request', id, method, params }, '*');
    });
  }

  // Results + events come back from the content script.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.target !== 'akasha-inpage') return;
    if (m.kind === 'response') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'request failed'), { code: m.error.code }));
      else p.resolve(m.result);
    } else if (m.kind === 'event') {
      const set = listeners.get(m.event);
      if (set) for (const fn of set) { try { fn(m.data); } catch { /* listener error is the dapp's */ } }
    }
  });

  const provider = {
    isAkasha: true,
    isMetaMask: false,
    chainId: '0x1a751',
    networkVersion: '108369',
    request: (args) => {
      if (!args || typeof args !== 'object') return Promise.reject(new Error('request() expects { method, params }'));
      return send(args.method, args.params);
    },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return this; },
    removeListener(event, fn) { const s = listeners.get(event); if (s) s.delete(fn); return this; },
    // legacy shims some dapps still probe
    enable: () => provider.request({ method: 'eth_requestAccounts' }),
  };

  Object.defineProperty(window, 'ethereum', { value: provider, configurable: false, writable: false });
  window.dispatchEvent(new Event('ethereum#initialized'));
})();
