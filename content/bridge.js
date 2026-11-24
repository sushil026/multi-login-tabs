// Isolated-world relay between the page shim (main world) and the background worker. Only active in profile tabs.
//   page -> worker : document.cookie writes
//   worker -> page : "cookies changed" pushes, answered with the current document.cookie view
(() => {
  const timings = performance.getEntriesByType('navigation')[0]?.serverTiming ?? [];
  if (!timings.some((t) => t.name === 'mlx')) return;

  const send = (message) => chrome.runtime.sendMessage(message);

  window.addEventListener('__mlx_cookie_set', (event) => {
    send({ type: 'set-document-cookie', url: location.href, cookie: String(event.detail) }).catch(() => {});
  });

  const refresh = async () => {
    const value = await send({ type: 'get-document-cookie', url: location.href });
    if (typeof value === 'string') window.dispatchEvent(new CustomEvent('__mlx_cookies', { detail: value }));
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'cookies-changed') refresh().catch(() => {});
  });
})();
