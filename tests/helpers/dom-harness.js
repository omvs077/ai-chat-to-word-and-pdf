// Shared test harness: loads a real content-script adapter into a jsdom
// window and runs its extraction IIFE against whatever HTML a test
// provides. Originally built for content.js (Claude) only; parameterized
// to also run chatgpt-content.js so both adapters' real jsdom/vm setup
// boilerplate lives in one place instead of being duplicated per adapter.

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const CONTENT_JS_PATH = path.join(__dirname, '..', '..', 'content', 'content.js');
const CHATGPT_CONTENT_JS_PATH = path.join(__dirname, '..', '..', 'content', 'chatgpt-content.js');

/**
 * @param {string} bodyHtml - HTML to put in <body>. Must include a
 *   #scrollList container with overflow-y:auto for the scroll-walk to find,
 *   and a <textarea> or [contenteditable] so Tier 3 fallback can locate a
 *   compose box if needed.
 * @param {object} [sizes] - override scrollHeight/clientHeight per element id,
 *   e.g. { scrollList: { scrollHeight: 2000, clientHeight: 400 } }
 * @param {(window: object) => void} [onReady] - optional hook invoked with
 *   the live jsdom `window` right before extraction starts, for tests that
 *   need to schedule a delayed DOM mutation (e.g. flipping
 *   data-is-streaming) to prove extraction actually waits on it.
 * @param {string} [scriptPath] - which adapter file to run; defaults to
 *   content.js (Claude). Pass CHATGPT_CONTENT_JS_PATH for the ChatGPT
 *   adapter's tests.
 * @returns {Promise<object>} the object the adapter's extraction IIFE resolves to
 */
async function runExtraction(bodyHtml, sizes = {}, onReady, scriptPath = CONTENT_JS_PATH) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      const override = sizes[this.id];
      if (override && 'scrollHeight' in override) return override.scrollHeight;
      return this.id ? 0 : 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      const override = sizes[this.id];
      if (override && 'clientHeight' in override) return override.clientHeight;
      return 0;
    },
  });

  const realGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = (el) => {
    const real = realGetComputedStyle(el);
    if (sizes[el.id]) {
      return new Proxy(real, { get(t, p) { return p === 'overflowY' ? 'auto' : t[p]; } });
    }
    return real;
  };

  // jsdom does no layout at all, so it doesn't implement innerText (used by
  // both adapters' extractCodeBlocks) - real Chrome supports it everywhere,
  // this gap is test-environment-only. textContent is an exact stand-in for
  // the code-block fixtures these tests use (real newline characters
  // already present in the source, no hidden elements to differ on).
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent; },
  });

  const scriptSrc = fs.readFileSync(scriptPath, 'utf8');
  const run = new Function(
    'window', 'document', 'location', 'getComputedStyle', 'Node',
    `return (${scriptSrc.trim().replace(/^\uFEFF/, '').replace(/;$/, '')});`
  );
  if (onReady) onReady(window);
  return run(window, window.document, window.location, window.getComputedStyle, window.Node);
}

module.exports = { runExtraction, CONTENT_JS_PATH, CHATGPT_CONTENT_JS_PATH };
