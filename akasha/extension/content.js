// content.js — runs in the ISOLATED content-script world. Two jobs:
//   1. inject inpage.js into the page's MAIN world (so window.ethereum exists there), and
//   2. bridge messages: page (window.postMessage) <-> background (chrome.runtime).
(function () {
  // 1. inject the page provider
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inpage.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  // 2a. page -> background
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.target !== 'akasha-content' || m.kind !== 'request') return;
    chrome.runtime.sendMessage(
      { kind: 'request', id: m.id, method: m.method, params: m.params, origin: location.origin },
      (resp) => {
        const err = chrome.runtime.lastError;
        window.postMessage(
          err
            ? { target: 'akasha-inpage', kind: 'response', id: m.id, error: { message: err.message } }
            : { target: 'akasha-inpage', kind: 'response', id: m.id, result: resp && resp.result, error: resp && resp.error },
          '*',
        );
      },
    );
  });

  // 2b. background -> page (events: accountsChanged / chainChanged / connect)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.kind === 'event') {
      window.postMessage({ target: 'akasha-inpage', kind: 'event', event: msg.event, data: msg.data }, '*');
    }
  });
})();
