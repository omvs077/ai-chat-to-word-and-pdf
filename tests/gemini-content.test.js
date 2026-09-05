const test = require('node:test');
const assert = require('node:assert/strict');
const { runExtraction, GEMINI_CONTENT_JS_PATH } = require('./helpers/dom-harness');

function run(html, sizes, onReady) {
  return runExtraction(html, sizes, onReady, GEMINI_CONTENT_JS_PATH);
}

// Turndown needs a DOMParser to parse HTML strings. Same isolated-swap
// pattern chatgpt-content.test.js uses, so a global jsdom leak here can't
// affect other test files running in the same process (see tests/run.js).
function convertWithTurndown(html) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const saved = { window: global.window, document: global.document, DOMParser: global.DOMParser, Node: global.Node };
  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMParser = dom.window.DOMParser;
  global.Node = dom.window.Node;
  try {
    delete require.cache[require.resolve('../lib/vendor/turndown.umd.js')];
    const TurndownService = require('../lib/vendor/turndown.umd.js');
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    return turndown.turndown(html);
  } finally {
    global.window = saved.window;
    global.document = saved.document;
    global.DOMParser = saved.DOMParser;
    global.Node = saved.Node;
  }
}

// Wraps a turn pair in the real confirmed container shape: div.conversation-
// container pairing one <user-query> with one <model-response>, inside the
// real confirmed scroll surface class chat-history-scroll-container.
function turn(userHtml, modelHtml) {
  return `<div class="conversation-container"><user-query>${userHtml}</user-query><model-response>${modelHtml}</model-response></div>`;
}

function wrapScroll(turnsHtml) {
  return `
    <div id="scrollList" class="chat-history-scroll-container" style="overflow-y:auto;height:400px">
      ${turnsHtml}
    </div>
    <textarea></textarea>
  `;
}

test('assistantName is "Gemini"', async () => {
  const html = wrapScroll(turn('Hi', 'Hello'));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.assistantName, 'Gemini');
});

test('detects user and assistant turns via the real user-query/model-response custom elements', async () => {
  const html = wrapScroll(turn('A question.', 'An answer.'));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].role, 'user');
  assert.equal(result.turns[1].role, 'assistant');
  assert.equal(result._detectionMethods[0], 'tier1-custom-elements');
});

test('orders turns by real div.conversation-container DOM position, not capture order', async () => {
  // No confirmed per-turn index attribute exists on gemini.google.com (see
  // file header) - ordering is derived purely from conversation-container
  // position, so this proves that derivation is real, not coincidental, by
  // capturing turns already in their natural order (unlike the ChatGPT
  // equivalent test, which can shuffle DOM order because it has a real
  // numeric index attribute to sort by instead).
  const html = wrapScroll(
    turn('First question.', 'First answer.') +
    turn('Second question.', 'Second answer.')
  );
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.turns.length, 4);
  assert.ok(result.turns[0].html.includes('First question'));
  assert.ok(result.turns[1].html.includes('First answer'));
  assert.ok(result.turns[2].html.includes('Second question'));
  assert.ok(result.turns[3].html.includes('Second answer'));
});

test('title strips the real " - Google Gemini" suffix (confirmed via a real captured <title>test chat## - Google Gemini</title>)', async () => {
  const html = wrapScroll(turn('Hi', 'Hello'));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } }, (window) => {
    window.document.title = 'test chat## - Google Gemini';
  });
  assert.equal(result.title, 'test chat##');
});

test('NO_MESSAGES_FOUND diagnostic when nothing matches', async () => {
  const html = wrapScroll('<div>nothing relevant here</div>');
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.error, 'NO_MESSAGES_FOUND');
  assert.ok(Array.isArray(result.diagnostics));
});

test('strips UI-only chrome tagged with the real hide-from-message-actions/hide-on-print markers', async () => {
  // Real, confirmed: Gemini itself tags 15+/19+ real UI-only elements (table
  // export buttons, image hover controls, follow-up chips, the action bar)
  // this way - a single native "don't export this" signal instead of hunting
  // individual leaks one at a time.
  const modelHtml = `
    <div class="markdown"><p>Real answer text.</p></div>
    <div hide-from-message-actions class="follow-up-container"><div class="follow-up-text">Want more detail?</div></div>
    <div class="actions-container-v2 hide-on-print">Copy Like Dislike Share</div>
  `;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const md = convertWithTurndown(result.turns[1].html);
  assert.ok(md.includes('Real answer text'));
  assert.ok(!md.includes('Want more detail'), 'follow-up suggestion chip must not leak');
  assert.ok(!md.includes('Copy Like Dislike Share'), 'action bar must not leak');
});

test('strips the real screen-reader-only sr-only labels (duplicate prompt text and hidden "Gemini said" heading)', async () => {
  // Real captured shape: h5.screen-reader-user-query-label duplicates the
  // user's own prompt; h6.screen-reader-model-response-label is a hidden
  // "Gemini said" heading with no visible on-page counterpart - same leaked-
  // sr-only-heading bug class ChatGPT's "ChatGPT said:" h4.sr-only had.
  const userHtml = `<h5 class="cdk-visually-hidden screen-reader-user-query-label"><span>You said</span> Explain X <!-- --></h5><p class="query-text-line"> Explain X </p>`;
  const modelHtml = `<h6 class="cdk-visually-hidden screen-reader-model-response-label">Gemini said</h6><div class="markdown"><p>X is...</p></div>`;
  const html = wrapScroll(turn(userHtml, modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const userMd = convertWithTurndown(result.turns[0].html);
  const modelMd = convertWithTurndown(result.turns[1].html);
  assert.ok(!userMd.includes('You said'), 'sr-only "You said" label must not leak');
  assert.ok(!modelMd.includes('Gemini said'), 'sr-only "Gemini said" heading must not leak');
  assert.ok(modelMd.includes('X is'));
});

test('strips a real captured inline citation chip (no extractable href - see file header) without leaking its markup', async () => {
  // Real bytes captured live from gemini.google.com - a <source-inline-chip>
  // with a real <button>, jslog tracking data, and a visible source title
  // ("Intuz"), but genuinely NO href anywhere in this element (confirmed: the
  // real URL only loads into a dialog on click).
  //
  // Deliberately NOT nested inside a <p> here (unlike the real live page,
  // where it sits inside a <p>/<b>) - this fixture is built from an HTML
  // *string*, which goes through the standard HTML5 parsing algorithm; that
  // algorithm auto-closes an open <p> the instant it sees a nested <div>
  // (invalid content model), splitting the paragraph before extraction even
  // runs. The real live page never hits this: Angular constructs its DOM via
  // direct createElement/appendChild calls, which bypass that parser rule
  // entirely, so the real (spec-invalid but real) nesting survives intact
  // there. Production code strips by querySelectorAll, which finds these
  // elements regardless of nesting depth either way - this is a fixture-
  // construction limitation of string-based jsdom tests, not a difference in
  // what the adapter itself does.
  const realChip = '<sources-carousel-inline _nghost-ng-c3125870364="" ng-version="0.0.0-PLACEHOLDER"> <source-inline-chip _ngcontent-ng-c3125870364="" _nghost-ng-c592720860="" class="ng-star-inserted"><div _ngcontent-ng-c592720860="" class="source-inline-chip-container luminous-sources hide-from-message-actions ng-star-inserted"><button _ngcontent-ng-c592720860="" aria-expanded="false" aria-haspopup="dialog" aria-label="View source details for citation from Intuz. Press Enter to open sources dialogue." cdkoverlayorigin="" class="button multiple-button ng-star-inserted"><div _ngcontent-ng-c592720860="" class="source-label-container gds-body-s ng-star-inserted" dir="auto"><span _ngcontent-ng-c592720860="" class="source-title" style="max-width: 20ch;">Intuz</span></div></button></div></source-inline-chip></sources-carousel-inline>';
  const modelHtml = `<div class="markdown"><p>React has many stars.</p>${realChip}</div>`;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const md = convertWithTurndown(result.turns[1].html);
  assert.ok(md.includes('React has many stars'));
  assert.ok(!md.includes('Intuz'), 'citation chip with no real href must not leak a fake/dead reference');
  assert.ok(!md.includes('dialogue'), 'no raw button/aria markup must leak');
});

test('a real model-authored link-block (genuine <a href>, unlike the citation chip) survives as a real markdown link', async () => {
  const realLinkBlock = '<link-block _nghost-ng-c1062658809="" class="ng-star-inserted"><a _ngcontent-ng-c1062658809="" href="https://github.com/facebook/react" rel="noopener" target="_blank">facebook/react Repository</a></link-block>';
  const modelHtml = `<div class="markdown"><p><i>Source:</i> ${realLinkBlock}</p></div>`;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const md = convertWithTurndown(result.turns[1].html);
  assert.ok(md.includes('[facebook/react Repository](https://github.com/facebook/react)'));
});

test('a real captured table converts to real GFM pipe-row text, one row per line (Turndown has no table support on its own - confirmed by testing the unmodified real fixture first; a fully rendered grid table in the Word/PDF output is a separate, larger change - see file header)', async () => {
  const fs = require('fs');
  const realTable = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'gemini-real-table.html'), 'utf8');
  const modelHtml = `<div class="markdown"><p>Here is a comparison:</p>${realTable}</div>`;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const md = convertWithTurndown(result.turns[1].html);
  const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
  assert.ok(lines.includes('| Browser | Manifest V3 Support | Extension Store Size | Release Year |'));
  assert.ok(lines.includes('| --- | --- | --- | --- |'));
  // Each data row survives as its own real, separate line (the core fix -
  // without normalizeTables every cell collapses into one run-on paragraph,
  // confirmed empirically before this fix existed). Cell-level bold
  // (real in the capture: <td><span><b>Google Chrome</b></span></td>) is
  // deliberately flattened to plain text here - see cellMarkdown's comment.
  assert.ok(lines.some(l => l.includes('Google Chrome') && l.includes('2008')), 'each row must survive as its own real line');
  assert.ok(lines.some(l => l.includes('Mozilla Firefox') && l.includes('2004')));
  assert.ok(lines.some(l => l.includes('Apple Safari') && l.includes('2003')));
});

test('a real captured code-block converts to a correctly fenced block with the real language, no leaked label line', async () => {
  const fs = require('fs');
  const realCodeBlock = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'gemini-real-codeblock.html'), 'utf8');
  const modelHtml = `<div class="markdown"><p><b>Python String Reversal</b></p>${realCodeBlock}</div>`;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const md = convertWithTurndown(result.turns[1].html);
  assert.ok(md.includes('```python'), 'real language label must land in the fence info-string');
  assert.ok(md.includes('def reverse_string(s: str) -> str:'));
  assert.ok(md.includes('    return s[::-1]'), 'real indentation must survive');
  assert.ok(!/\n\s*Python\s*\n\s*```/.test(md), 'the language label must not also leak as its own stray line above the fence');
});

test('real captured KaTeX math (inline and block) converts to $..$/$$..$$ using the real data-math LaTeX source, not the KaTeX HTML soup', async () => {
  const fs = require('fs');
  const realInline = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'gemini-real-math-inline.html'), 'utf8');
  const realBlock = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'gemini-real-math-block.html'), 'utf8');
  const modelHtml = `<div class="markdown"><p>For ${realInline} the solutions are:</p><div>${realBlock}</div></div>`;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.ok(result.turns[1].html.includes('$ax^2 + bx + c = 0$'), 'inline math must use the real data-math source verbatim in the captured html');
  assert.ok(result.turns[1].html.includes('$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$'), 'block math must use the real data-math source verbatim');
  assert.ok(!result.turns[1].html.includes('katex'), 'no KaTeX HTML soup should survive normalization');
});

test('a real blob: image is extracted separately and the raw <img> is removed from html (no broken/duplicate image reference)', async () => {
  const modelHtml = `
    <generated-image class="luminous-layout"><single-image class="generated-image large"><div class="image-container"><button class="image-button"><img alt=", AI generated" class="image animate loaded" src="blob:https://gemini.google.com/1b44afd7-35bb-4d75-9c09-60fdce80f386"/></button></div></single-image></generated-image>
  `;
  const html = wrapScroll(turn('Generate an image', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const modelTurn = result.turns[1];
  assert.equal(modelTurn.images.length, 1);
  assert.equal(modelTurn.images[0].src, 'blob:https://gemini.google.com/1b44afd7-35bb-4d75-9c09-60fdce80f386');
  assert.ok(!modelTurn.html.includes('<img'), 'raw <img> must be removed from html to avoid a dead ![](blob:...) reference');
});

test('a real "You stopped this response" notice survives as plain readable text (no icon-font/glyph issue, unlike Claude\'s interrupted banner)', async () => {
  const modelHtml = `
    <div class="markdown"><p>Partial answer before the stop...</p></div>
    <response-info-line role="status"><div class="info-line-container"><div class="divider-line"></div><div class="info-content"><span>You stopped this response</span></div><div class="divider-line"></div></div></response-info-line>
  `;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const md = convertWithTurndown(result.turns[1].html);
  assert.ok(md.includes('You stopped this response'));
});

test('a third-party extension\'s injected UI (e.g. a competing export button) is stripped defensively', async () => {
  const modelHtml = `
    <div class="markdown"><p>Answer text.</p></div>
    <saveai-chat-export-btn data-wxt-shadow-root=""></saveai-chat-export-btn>
  `;
  const html = wrapScroll(turn('Q', modelHtml));
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.ok(!result.turns[1].html.includes('saveai-chat-export-btn'));
});
