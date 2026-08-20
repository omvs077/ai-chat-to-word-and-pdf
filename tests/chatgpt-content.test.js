const test = require('node:test');
const assert = require('node:assert/strict');
const { runExtraction, CHATGPT_CONTENT_JS_PATH } = require('./helpers/dom-harness');

function run(html, sizes, onReady) {
  return runExtraction(html, sizes, onReady, CHATGPT_CONTENT_JS_PATH);
}

// Turndown needs a DOMParser to parse HTML strings. Node's test runner runs
// all *.test.js files in one process (see tests/run.js), so mutating
// global.window/document/etc at module scope here would risk leaking into
// other test files that also touch jsdom globals - this scopes the swap to
// exactly the one test that needs Turndown, restoring afterward either way.
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

test('assistantName is "ChatGPT", not left as Claude\'s default (regression)', async () => {
  // Real bug found on the first real generated export: both generators
  // hard-coded the assistant role label as literally "Claude" regardless
  // of which adapter produced the IR - a genuine ChatGPT export showed
  // "Claude" as the label for every assistant turn. Both generators now
  // read ir.assistantName (defaulting to 'Claude' only when absent, for
  // content.js's own IR which doesn't set it... actually it does now too,
  // see content.js's own result object).
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-1"><div data-message-author-role="user">Hi</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">Hello</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.assistantName, 'ChatGPT');
});

test('detects user and assistant turns via data-message-author-role', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-1"><div data-message-author-role="user">A question.</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">An answer.</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].role, 'user');
  assert.equal(result.turns[1].role, 'assistant');
  assert.equal(result._detectionMethods[0], 'tier1-author-role');
});

test('orders turns by the real conversation-turn-N index, not DOM/capture order', async () => {
  // conversation-turn-N carries the real index directly (confirmed via live
  // DevTools on an actual conversation - turns 10, 11, 14, 18-22 were
  // mounted simultaneously during virtualization), unlike Claude's
  // data-index which needs an ancestor-walk. Turns are deliberately written
  // out of numeric order here to prove the sort is real, not coincidental -
  // indices are widely spaced (10/11/20/21, matching the real gaps seen in
  // a genuine virtualized conversation) so the expected order is
  // unambiguous regardless of role.
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-21"><div data-message-author-role="assistant">Second answer.</div></div>
      <div data-testid="conversation-turn-10"><div data-message-author-role="user">First question.</div></div>
      <div data-testid="conversation-turn-11"><div data-message-author-role="assistant">First answer.</div></div>
      <div data-testid="conversation-turn-20"><div data-message-author-role="user">Second question.</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.turns.length, 4);
  assert.ok(result.turns[0].html.includes('First question'));
  assert.ok(result.turns[1].html.includes('First answer'));
  assert.ok(result.turns[2].html.includes('Second question'));
  assert.ok(result.turns[3].html.includes('Second answer'));
});

// Real markup captured via live DevTools inspection of an actual ChatGPT
// response containing a real cited link (not simplified) - includes both
// the real <a href> ChatGPT renders directly, and the citation-pill chip
// (data-testid="webpage-citation-pill") it appends after the link, which
// wraps a tracking-decorated (?utm_source=chatgpt.com) duplicate URL and
// must be stripped or its favicon+label text leaks into the export as
// noise immediately after the real link.
test('a real cited link survives extraction, with its citation-pill chip stripped', async () => {
  const linkParagraph = `<p data-end="712" data-is-last-node="" data-is-only-node="" data-start="39"><strong data-end="93" data-start="39"><a class="decorated-link" data-end="91" data-start="41" href="https://docs.python.org/3/" rel="noopener" target="_new">Python Documentation<span aria-hidden="true" class="ms-0.5 inline-block align-middle leading-none select-none"><svg aria-hidden="true" class="block h-[0.75em] w-[0.75em] stroke-current stroke-[0.75] select-none" data-rtl-flip="" height="20" width="20" xmlns="http://www.w3.org/2000/svg"><use fill="currentColor" href="/cdn/assets/sprites-core-78807d7e.svg#304883"></use></svg></span></a></strong> is the official reference for Python, with tutorials, language references, standard-library documentation, and practical guides. <span class="contents" data-content-reference-end="242" data-content-reference-start="223"><span class="" data-state="closed"><span class="ms-1 inline-flex max-w-full items-center select-none relative top-[-0.094rem] translate-y-0.5 animate-[show_150ms_ease-in]" data-testid="webpage-citation-pill" style="width: 101px;"><a alt="https://docs.python.org/3/?utm_source=chatgpt.com" class="flex h-4.5 overflow-hidden rounded-xl pe-2 ps-1 text-[9px] font-medium transition-colors duration-150 ease-in-out text-token-text-secondary! bg-[#F4F4F4]! dark:bg-[#303030]! select-none" href="https://docs.python.org/3/?utm_source=chatgpt.com" rel="noopener" style="max-width: 101px;" target="_blank"><span class="relative start-0 bottom-0 flex h-full w-full items-center"><span class="flex h-4 w-full items-center justify-between overflow-hidden" style="opacity: 1; transform: none;"><span class="flex min-w-0 flex-1 items-center gap-1"><span class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"><img alt="" class="h-3 w-3 rounded-full" height="128" src="./test chat_files/favicons" width="128"/></span><span class="max-w-[15ch] grow truncate overflow-hidden text-center">Python documentation</span></span></span></span></a></span></span></span> <strong data-end="311" data-start="261"><a class="decorated-link" data-end="309" data-start="263" href="https://developer.mozilla.org/" rel="noopener" target="_new">MDN Web Docs<span aria-hidden="true" class="ms-0.5 inline-block align-middle leading-none select-none"><svg aria-hidden="true" class="block h-[0.75em] w-[0.75em] stroke-current stroke-[0.75] select-none" data-rtl-flip="" height="20" width="20" xmlns="http://www.w3.org/2000/svg"><use fill="currentColor" href="/cdn/assets/sprites-core-78807d7e.svg#304883"></use></svg></span></a></strong> is one of the best resources for learning web development, covering HTML, CSS, JavaScript, Web APIs, and browser technologies. <span class="contents" data-content-reference-end="440" data-content-reference-start="421"><span class="" data-state="closed"><span class="ms-1 inline-flex max-w-full items-center select-none relative top-[-0.094rem] translate-y-0.5 animate-[show_150ms_ease-in]" data-testid="webpage-citation-pill" style="width: 92px;"><a alt="https://developer.mozilla.org/en-US/docs/MDN/index.html?utm_source=chatgpt.com" class="flex h-4.5 overflow-hidden rounded-xl pe-2 ps-1 text-[9px] font-medium transition-colors duration-150 ease-in-out text-token-text-secondary! bg-[#F4F4F4]! dark:bg-[#303030]! select-none" href="https://developer.mozilla.org/en-US/docs/MDN/index.html?utm_source=chatgpt.com" rel="noopener" style="max-width: 92px;" target="_blank"><span class="relative start-0 bottom-0 flex h-full w-full items-center"><span class="flex h-4 w-full items-center justify-between overflow-hidden" style="opacity: 1; transform: none;"><span class="flex min-w-0 flex-1 items-center gap-1"><span class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"><img alt="" class="h-3 w-3 rounded-full" height="128" src="./test chat_files/favicons(1)" width="128"/></span><span class="max-w-[15ch] grow truncate overflow-hidden text-center">MDN Web Docs</span></span></span></span></a></span></span></span> <strong data-end="526" data-start="477"><a class="decorated-link" data-end="524" data-start="479" href="https://www.freecodecamp.org/" rel="noopener" target="_new">freeCodeCamp<span aria-hidden="true" class="ms-0.5 inline-block align-middle leading-none select-none"><svg aria-hidden="true" class="block h-[0.75em] w-[0.75em] stroke-current stroke-[0.75] select-none" data-rtl-flip="" height="20" width="20" xmlns="http://www.w3.org/2000/svg"><use fill="currentColor" href="/cdn/assets/sprites-core-78807d7e.svg#304883"></use></svg></span></a></strong> is a strong choice for hands-on learning, offering interactive programming lessons, projects, and certifications across areas such as Python, JavaScript, web development, and databases.</p>`;
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-1"><div data-message-author-role="user">Recommend Python docs.</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">${linkParagraph}</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const assistant = result.turns.find(t => t.role === 'assistant');
  assert.ok(assistant.html.includes('href="https://docs.python.org/3/"'), 'the real link must survive');
  assert.ok(!assistant.html.includes('webpage-citation-pill'), 'the citation-pill chip must be stripped');
  assert.ok(!assistant.html.includes('utm_source=chatgpt.com'), 'the tracking-decorated duplicate URL must not leak in');
});

// Real markup pasted directly from live DevTools inspection of an actual
// ChatGPT-generated Python function - CodeMirror-rendered (confirmed via
// the cm-content class and per-token <span> wrapping), not a plain-text
// <pre><code> block the way Claude's are.
//
// Real bug found on the first real generated export: leaving this
// structure as-is in the captured HTML meant Turndown never recognized it
// as a code block at all - the nested per-token <span> elements don't
// match its default pre>code detection, so it fell through to plain
// inline prose, backslash-escaping underscores/equals/brackets the way it
// would for any regular text containing those characters. The real .docx
// showed literal "def binary\_search(arr, target):" as one of many
// separate plain paragraphs (one per original line), all indentation
// lost. The fix normalizes the real <pre> into a clean, plain
// <pre><code>text</code></pre> in the captured HTML - this test checks
// both that normalization directly, and the full real Turndown conversion
// end-to-end, since the intermediate HTML shape alone doesn't prove
// Turndown actually handles it correctly.
test('a real CodeMirror-rendered code block is normalized to a clean pre>code Turndown recognizes correctly', async () => {
  const codeBlock = `<pre class="cm-content q9tKkq_readonly m-0"><code><span class="ͼv">def</span><span> </span><span class="ͼ11">binary_search</span><span>(</span><span class="ͼ11">arr</span><span>, </span><span class="ͼ11">target</span><span>):
    </span><span class="ͼ11">left</span><span>, </span><span class="ͼ11">right</span><span> </span><span class="ͼv">=</span><span> </span><span class="ͼy">0</span><span>, </span><span class="ͼ11">len</span><span>(</span><span class="ͼ11">arr</span><span>) </span><span class="ͼv">-</span><span> </span><span class="ͼy">1</span><span>
    </span><span class="ͼv">while</span><span> </span><span class="ͼ11">left</span><span> </span><span class="ͼv">&lt;=</span><span> </span><span class="ͼ11">right</span><span>:
        </span><span class="ͼ11">mid</span><span> </span><span class="ͼv">=</span><span> (</span><span class="ͼ11">left</span><span> </span><span class="ͼv">+</span><span> </span><span class="ͼ11">right</span><span>) </span><span class="ͼv">//</span><span> </span><span class="ͼy">2</span><span>
        </span><span class="ͼv">if</span><span> </span><span class="ͼ11">arr</span><span>[</span><span class="ͼ11">mid</span><span>] </span><span class="ͼv">==</span><span> </span><span class="ͼ11">target</span><span>:
            </span><span class="ͼv">return</span><span> </span><span class="ͼ11">mid</span><span>
        </span><span class="ͼv">elif</span><span> </span><span class="ͼ11">arr</span><span>[</span><span class="ͼ11">mid</span><span>] </span><span class="ͼv">&lt;</span><span> </span><span class="ͼ11">target</span><span>:
            </span><span class="ͼ11">left</span><span> </span><span class="ͼv">=</span><span> </span><span class="ͼ11">mid</span><span> </span><span class="ͼv">+</span><span> </span><span class="ͼy">1</span><span>
        </span><span class="ͼv">else</span><span>:
            </span><span class="ͼ11">right</span><span> </span><span class="ͼv">=</span><span> </span><span class="ͼ11">mid</span><span> </span><span class="ͼv">-</span><span> </span><span class="ͼy">1</span><span>
    </span><span class="ͼv">return</span><span> </span><span class="ͼv">-</span><span class="ͼy">1</span></code></pre>
`;
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-1"><div data-message-author-role="user">Write binary search.</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">Here is the function:${codeBlock}</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const assistant = result.turns.find(t => t.role === 'assistant');

  assert.ok(!assistant.html.includes('ͼ'), 'no CodeMirror token spans may survive into the captured HTML');
  assert.ok(/<pre><code[^>]*>/.test(assistant.html), 'must be a clean, plain pre>code Turndown recognizes by default');
  assert.ok(assistant.html.includes('def binary_search(arr, target):'));
  assert.ok(assistant.html.includes('    left, right = 0, len(arr) - 1'), 'indentation must survive as real whitespace, not escaped');

  const turndownMarkdown = convertWithTurndown(assistant.html);
  assert.ok(turndownMarkdown.includes('```'), 'must become a real fenced code block, not escaped plain paragraphs');
  assert.ok(turndownMarkdown.includes('def binary_search(arr, target):'));
  assert.ok(!turndownMarkdown.includes('binary\\_search'), 'must NOT be markdown-escaped the way plain-prose underscores would be');
  assert.ok(!turndownMarkdown.includes('mid \\='), 'must NOT be markdown-escaped the way plain-prose equals signs would be');
});

test('returns NO_MESSAGES_FOUND with diagnostics when nothing resembling a message exists', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div>Just some unrelated page content, no chat here.</div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  assert.equal(result.error, 'NO_MESSAGES_FOUND');
  assert.ok(Array.isArray(result.diagnostics) && result.diagnostics.length > 0);
});

test('images/artifacts/toolUses are always empty arrays in v1 (deliberately deferred, not silently guessed)', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-1"><div data-message-author-role="user">Hi</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">Hello</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  for (const t of result.turns) {
    assert.deepEqual(t.images, []);
    assert.deepEqual(t.artifacts, []);
    assert.deepEqual(t.toolUses, []);
  }
});

test('does not mistake a merely-tall non-scrolling wrapper for the real scroll container (regression)', async () => {
  // Real bug found on a live export: a generic "walk up until tall enough"
  // check found a non-scrolling <main> wrapper (confirmed live:
  // scrollHeight 6725 vs clientHeight 858) before ever reaching the real
  // overflow-y:auto scroll container - <main> is naturally tall from
  // normal page layout without itself being the element that scrolls.
  // Setting scrollTop on it did nothing, so extraction hung indefinitely
  // waiting for a scrollHeight that could never change. This reconstructs
  // that exact shape: an outer wrapper that LOOKS scrollable by height
  // alone, wrapping the real scrollable region deeper in the tree.
  const html = `
    <main id="fakeMain" style="height:200px">
      <div id="scrollList" style="overflow-y:auto;height:150px">
        <div data-testid="conversation-turn-1"><div data-message-author-role="user">Hi</div></div>
        <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">Hello there, general kenobi.</div></div>
      </div>
    </main>
    <textarea></textarea>
  `;
  const result = await run(html, {
    fakeMain: { scrollHeight: 6725, clientHeight: 858 }, // tall, but NOT overflow:auto - must be skipped
    scrollList: { scrollHeight: 1343, clientHeight: 844 }, // the real one
  });
  assert.equal(result.turns.length, 2, 'must still find both turns via the real scrollable container, not hang on the fake one');
  assert.ok(result.turns[1].html.includes('general kenobi'));
});

test('does not mistake an unrelated same-named "scrollport" element elsewhere on the page for the real container (regression)', async () => {
  // Real bug found on the very next live export attempt after the fix
  // above: a first attempt at fixing findScrollContainer used a blind
  // document.querySelector('[class*="scrollport" i]') as a shortcut,
  // trusting the real class fragment confirmed via live DevTools. That
  // global query has no concept of ancestry - it can match (and on a real
  // page with multiple similarly-classed regions, did match) an unrelated
  // element elsewhere on the page that happens to share the class
  // fragment but does not actually contain any conversation turns.
  // Detection itself still correctly found all 7 real messages (confirmed
  // via the popup's own diagnostics), but the container.contains(el)
  // filter silently rejected every one of them since the "container"
  // found wasn't an ancestor of any message - export failed fast with
  // NO_MESSAGES_FOUND despite messages genuinely being present. The fix
  // only accepts a scrollport-classed match found by walking UP from the
  // real message element, which is structurally guaranteed to actually
  // contain it.
  const html = `
    <div id="decoyScrollport" class="group/scrollport unrelated-sidebar-region" style="height:100px">
      <div>Some unrelated sidebar content, not the conversation.</div>
    </div>
    <main id="fakeMain" style="height:200px">
      <div id="scrollList" class="group/scrollport" style="overflow-y:auto;height:150px">
        <div data-testid="conversation-turn-1"><div data-message-author-role="user">Hi</div></div>
        <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">Hello there, general kenobi.</div></div>
      </div>
    </main>
    <textarea></textarea>
  `;
  const result = await run(html, {
    decoyScrollport: { scrollHeight: 900, clientHeight: 100 }, // also "tall enough" - must NOT be picked
    fakeMain: { scrollHeight: 6725, clientHeight: 858 },
    scrollList: { scrollHeight: 1343, clientHeight: 844 }, // the real one, also containing the messages
  });
  assert.ok(!result.error, `must not fail with ${result.error} when real messages are present`);
  assert.equal(result.turns.length, 2, 'must find both real turns via the real container, not the unrelated decoy');
  assert.ok(result.turns[1].html.includes('general kenobi'));
});

test('real page title (no " - ChatGPT" suffix observed) and URL round-trip into the result', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-testid="conversation-turn-1"><div data-message-author-role="user">Hi</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant">Hello</div></div>
    </div>
    <textarea></textarea>
  `;
  const result = await run(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } }, (window) => {
    window.document.title = 'My Real Chat Title';
  });
  assert.equal(result.title, 'My Real Chat Title');
});
