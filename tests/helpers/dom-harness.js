// Shared test harness: loads the real content.js into a jsdom window and
// runs extractClaudeChat() against whatever HTML a test provides. Used by
// every content.js test so the jsdom/vm setup boilerplate lives in one
// place instead of being copy-pasted per test file.

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const CONTENT_JS_PATH = path.join(__dirname, '..', '..', 'content', 'content.js');

/**
 * @param {string} bodyHtml - HTML to put in <body>. Must include a
 *   #scrollList container with overflow-y:auto for the scroll-walk to find,
 *   and a <textarea> or [contenteditable] so Tier 3 fallback can locate a
 *   compose box if needed.
 * @param {object} [sizes] - override scrollHeight/clientHeight per element id,
 *   e.g. { scrollList: { scrollHeight: 2000, clientHeight: 400 } }
 * @returns {Promise<object>} the object extractClaudeChat() resolves to
 */
async function runExtraction(bodyHtml, sizes = {}) {
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

  const scriptSrc = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
  const run = new Function(
    'window', 'document', 'location', 'getComputedStyle', 'Node',
    `return (${scriptSrc.trim().replace(/^\uFEFF/, '').replace(/;$/, '')});`
  );
  return run(window, window.document, window.location, window.getComputedStyle, window.Node);
}

module.exports = { runExtraction };
