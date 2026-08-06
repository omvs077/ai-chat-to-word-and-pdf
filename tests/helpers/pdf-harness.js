// Shared test harness for pdf-generator.js. Uses vm.runInContext (not a
// plain new Function) because jsPDF's UMD build needs to attach itself to
// `window.jspdf`, and fonts-base64.js needs to attach to `window.PDF_FONTS`
// / `window.PDF_FONT_COVERAGE` - both only happen correctly when run as a
// real script against the window global, not called as an isolated function.

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB_DIR = path.join(__dirname, '..', '..', 'lib');

function loadWindow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  // jsdom's own Blob polyfill only implements slice()/size/type - missing
  // arrayBuffer()/text()/stream(). Node's native Blob has the full API and
  // is what doc.output('blob') actually needs for tests to read the result.
  window.Blob = globalThis.Blob;
  const ctx = dom.getInternalVMContext();

  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'vendor', 'jspdf.umd.min.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'vendor', 'fonts-base64.js'), 'utf8'), ctx);
  // markdown-blocks.js already sets window.MarkdownBlocks itself (including
  // parseInlineRuns, which pdf-generator.js now also depends on for real
  // link support) - no need to re-declare a narrower stub here.
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'markdown-blocks.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'pdf-generator.js'), 'utf8'), ctx);

  return window;
}

/** Generates a PDF blob for a single assistant turn with the given markdown. */
async function generateFor(markdown) {
  const window = loadWindow();
  const ir = {
    title: 'Test',
    url: 'https://x',
    exportedAt: new Date().toISOString(),
    turns: [{ role: 'assistant', markdown }],
  };
  const blob = await window.generatePdf(ir);
  return Buffer.from(await blob.arrayBuffer());
}

module.exports = { loadWindow, generateFor };
