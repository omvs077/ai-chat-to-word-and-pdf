const test = require('node:test');
const assert = require('node:assert/strict');
const { runExtraction } = require('./helpers/dom-harness');

test('does not capture sidebar/nav elements that share a reused styling class', async () => {
  const html = `
    <div id="sidebar" style="overflow-y:auto;height:100px">
      <div class="font-claude-response" data-testid="sidebar-preview-not-a-real-message">
        design system for Sys-Apps
      </div>
    </div>
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="0" data-testid="user-message">First user message with enough text.</div>
      <div data-index="1" class="font-claude-response">First assistant reply, plenty of text.</div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, {
    scrollList: { scrollHeight: 2000, clientHeight: 400 },
    sidebar: { scrollHeight: 500, clientHeight: 100 },
  });

  assert.equal(result.turns.length, 2, 'should capture exactly the 2 real turns, nothing extra');
  const contaminated = result.turns.some(t => t.html.includes('Sys-Apps'));
  assert.equal(contaminated, false, 'sidebar text must never appear in captured turns');
});

test('orders turns correctly by document position when some turns lack a resolvable data-index', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="0" data-testid="user-message">First user message with enough text.</div>
      <div data-index="1" class="font-claude-response">First assistant reply text.</div>
      <div data-testid="user-message">Second user message, no data-index ancestor.</div>
      <div class="font-claude-response">Second assistant reply, no data-index ancestor.</div>
      <div data-index="2" data-testid="user-message">Third user message with a real data-index.</div>
      <div data-index="3" class="font-claude-response">Third assistant reply with a real data-index.</div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });

  assert.equal(result.turns.length, 6);
  const order = result.turns.map(t => t.html.trim());
  assert.deepEqual(order, [
    'First user message with enough text.',
    'First assistant reply text.',
    'Second user message, no data-index ancestor.',
    'Second assistant reply, no data-index ancestor.',
    'Third user message with a real data-index.',
    'Third assistant reply with a real data-index.',
  ]);
});

test('still orders correctly by pure data-index when DOM order differs from index order (regression)', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="2" data-testid="user-message">User turn 2</div>
      <div data-index="3" class="font-claude-response">Assistant turn 2</div>
      <div data-index="0" data-testid="user-message">User turn 0</div>
      <div data-index="1" class="font-claude-response">Assistant turn 0</div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const order = result.turns.map(t => t.html.trim());
  assert.deepEqual(order, ['User turn 0', 'Assistant turn 0', 'User turn 2', 'Assistant turn 2']);
});

test('captures tool-use/status widgets (Ran N commands, Connecting to visualize...) as real content', async () => {
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="0" data-testid="user-message">First user message with enough text.</div>
      <div data-index="1">
        <button class="group/status flex items-center gap-2" aria-expanded="false">
          <span class="truncate font-base">Ran 7 commands</span>
        </button>
        <div class="font-claude-response">First assistant reply text, plenty of characters.</div>
      </div>
      <div data-index="2" data-testid="user-message">Second user message with enough text.</div>
      <div data-index="3">
        <button class="group/status flex items-center gap-2" aria-expanded="false">
          <span class="truncate font-base">Connecting to visualize...</span>
        </button>
        <div class="font-claude-response">Second assistant reply text, no leaked widget.</div>
      </div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const assistantTurns = result.turns.filter(t => t.role === 'assistant');

  assert.equal(assistantTurns.length, 2);
  assert.deepEqual(assistantTurns[0].toolUses, ['Ran 7 commands']);
  assert.deepEqual(assistantTurns[1].toolUses, ['Connecting to visualize...']);
  assert.equal(assistantTurns[0].toolUses.includes('Connecting to visualize...'), false);
  assert.equal(assistantTurns[1].toolUses.includes('Ran 7 commands'), false);
  assert.equal(assistantTurns[0].html.includes('Ran 7'), false);
  assert.equal(assistantTurns[1].html.includes('Connecting'), false);
});

test('captures real artifact cards (title + format) and strips them from turn html', async () => {
  // Real markup captured via live DevTools inspection of an actual artifact
  // card on claude.ai. No data-testid exists on any element here - the
  // previous '[data-testid*="artifact" i]' selector matched nothing against
  // this real DOM and silently dropped every artifact.
  const artifactCardHtml = `
    <div class="flex flex-col gap-2 py-2 pl-2">
      <div class="group/artifact-block relative flex text-left font-ui rounded-lg overflow-hidden border-0.5 transition duration-300 w-full hover:bg-bg-000/50 px-4 border-border-300 hover:border-border-200">
        <button type="button" class="absolute inset-0 cursor-pointer rounded-[inherit]" aria-label="View Geru blocks project handoff"></button>
        <div class="artifact-block-cell flex flex-1 align-start justify-between w-full">
          <div class="flex flex-1 gap-2 min-w-0">
            <div class="flex items-end w-[68px] relative shrink-0 pointer-events-none" aria-hidden="true"></div>
            <div class="flex flex-col gap-1 py-4 min-w-0 flex-1">
              <div class="leading-tight text-sm line-clamp-1">Geru blocks project handoff</div>
              <div class="text-xs line-clamp-1 text-text-400 opacity-100 transition-opacity duration-200">Document<span class="opacity-50"> · </span>MD&nbsp;</div>
            </div>
          </div>
          <div class="relative z-[1] flex items-center pointer-events-none">
            <button type="button" aria-label="Download Geru blocks project handoff">Download</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="0" data-testid="user-message">User message asking for a project handoff doc.</div>
      <div data-index="1" class="font-claude-response">Here you go, plenty of surrounding reply text.${artifactCardHtml}</div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const assistantTurn = result.turns.find(t => t.role === 'assistant');

  assert.equal(assistantTurn.artifacts.length, 1);
  assert.equal(assistantTurn.artifacts[0].title, 'Geru blocks project handoff');
  assert.equal(assistantTurn.artifacts[0].format, 'Document · MD');
  assert.equal(assistantTurn.html.includes('Geru blocks project handoff'), false, 'artifact card must be stripped from the turn html, not left in place alongside the extracted data');
  assert.equal(assistantTurn.html.includes('artifact-block'), false);
});

test('captures format for single-format artifact cards (e.g. ZIP) with no "·" separator (regression)', async () => {
  // Real markup: a ZIP artifact's meta line has no middle-dot separator at
  // all (unlike "Document · MD"), which broke a '·'-based format lookup.
  const zipCardHtml = `
    <div class="flex flex-col gap-2 py-2 pl-2">
      <div class="group/artifact-block relative flex text-left font-ui rounded-lg overflow-hidden">
        <button type="button" class="absolute inset-0" aria-label="View Geru blocks stage1 scaffold"></button>
        <div class="artifact-block-cell flex flex-1 align-start justify-between w-full">
          <div class="flex flex-1 gap-2 min-w-0">
            <div class="flex flex-col gap-1 py-4 min-w-0 flex-1">
              <div class="leading-tight text-sm line-clamp-1">Geru blocks stage1 scaffold</div>
              <div class="text-xs line-clamp-1 text-text-400 opacity-100 transition-opacity duration-200">ZIP&nbsp;</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="0" data-testid="user-message">User message asking for a scaffold zip.</div>
      <div data-index="1" class="font-claude-response">Here it is, plenty of surrounding reply text.${zipCardHtml}</div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const assistantTurn = result.turns.find(t => t.role === 'assistant');

  assert.equal(assistantTurn.artifacts.length, 1);
  assert.equal(assistantTurn.artifacts[0].title, 'Geru blocks stage1 scaffold');
  assert.equal(assistantTurn.artifacts[0].format, 'ZIP');
});

test('an interrupted response gets a clean marker, not a raw icon-font glyph or leaked button labels', async () => {
  // Real markup captured via live DevTools inspection of an actual
  // interrupted response on claude.ai (the "Claude's response was
  // interrupted." Banner, its Anthropicons icon span, and its Edit
  // prompt/Try again buttons - all real, not simplified stand-ins). The
  // icon renders via a private-use-area codepoint (\ue08f) with no glyph
  // in the embedded PDF/DOCX fonts - almost certainly the real root cause
  // of a historical mojibake-glyph bug reported in an earlier session.
  const lastUserHtml = `<div class="grid grid-cols-1 gap-2 relative [&amp;_ul]:!space-y-0 [&amp;_ol]:!space-y-0 [&amp;_ul]:pl-8 [&amp;_ol]:pl-8" data-testid="user-message"><p class="whitespace-pre-wrap break-words">Write a very long, detailed explanation of how TCP/IP networking works, covering all seven OSI layers with examples.</p></div>`;
  const lastAssistantHtml = `<div class="font-claude-response relative leading-[1.65rem] [&amp;_pre&gt;div]:bg-bg-000/50 [&amp;_pre&gt;div]:border-0.5 [&amp;_pre&gt;div]:border-border-400 [&amp;_.ignore-pre-bg&gt;div]:bg-transparent [&amp;_.standard-markdown_:is(p,blockquote,h1,h2,h3,h4,h5,h6)]:pl-2 [&amp;_.standard-markdown_:is(p,blockquote,ul,ol,h1,h2,h3,h4,h5,h6)]:pr-8 [&amp;_.progressive-markdown_:is(p,blockquote,h1,h2,h3,h4,h5,h6)]:pl-2 [&amp;_.progressive-markdown_:is(p,blockquote,ul,ol,h1,h2,h3,h4,h5,h6)]:pr-8"><div class="contents" data-find-omitted=""></div><div><div class="standard-markdown grid-cols-1 grid [&amp;_&gt;_*]:min-w-0 gap-3 [&amp;_&gt;_*:last-child]:mb-0 print:block print:[&amp;_&gt;_*_+_*]:mt-3 standard-markdown"><h2 class="mt-3 -mb-1 text-[1.375rem] font-bold" dir="ltr">How TCP/IP Networking Works: The Complete Picture</h2>
<p class="font-claude-response-body break-words whitespace-normal" dir="ltr">When you type a URL into your browser and a webpage appears, dozens of distinct operations happen across multiple layers of abstraction — each one solving a specific problem so the layers above it don't have to worry about it. The OSI (Open Systems Interconnection) model is the conceptual framework used to describe this process in seven layers, while TCP/IP is the actual suite of protocols the internet runs on today. TCP/IP predates the OSI model and doesn't map onto it perfectly, but the OSI layers remain the standard vocabulary for talking about networking, so I'll walk through all seven and show how TCP/IP protocols fit into each one.</p>
<p class="font-claude-response-body break-words whitespace-normal" dir="ltr">Here's the layer stack for reference before</p></div></div><div class="mt-2 pl-1"><div class="flex items-start gap-xs rounded-card px-lg py-md font-sans text-body bg-surface-1 text-primary shadow-card-ring w-full" data-cds="Banner" role="status"><span class="flex h-[1lh] shrink-0 items-center text-secondary"><span aria-hidden="true" data-cds="Icon" style='font-family: var(--font-anthropicons, Anthropicons-Variable); font-feature-settings: "liga" 0; font-optical-sizing: auto; font-style: normal; font-variation-settings: normal; line-height: 1; width: 1em; height: 1em; display: flex; align-items: center; justify-content: center; flex-shrink: 0; user-select: none; font-size: 20px; font-weight: 433.3;'></span></span><div class="flex min-w-0 flex-wrap items-start gap-y-sm gap-x-md flex-1"><div class="max-w-full min-w-0 flex-auto">Claude’s response was interrupted.</div><span class="-ml-[2px] -mr-[calc(var(--cds-pad-md)-4px)] flex h-[1lh] shrink-0 items-center"><div class="flex items-center gap-2"><div data-trigger-disabled="" id="_r_gj_"><button class="cds-reset group/btn relative isolate inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none cursor-[var(--cds-cursor-interactive)] aria-disabled:cursor-default data-[disabled]:cursor-default border-0 outline-none focus-visible:outline-hidden rounded h-control font-sans text-body [&amp;:disabled:not([aria-busy])]:opacity-50 disabled:pointer-events-none transition-shadow duration-fast focus-visible:shadow-focus text-primary font-normal aria-pressed:text-accent px-md" data-cds="Button" data-size="sm" type="button"><span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] transition-colors duration-fast group-focus-visible/btn:shadow-[inset_0_0_0_1px_var(--cds-page-bg)] bg-fill-secondary group-hover/btn:bg-fill-secondary-hover group-[[aria-haspopup][aria-expanded=true]]/btn:bg-fill-secondary-hover inset-0 group-aria-pressed/btn:bg-accent group-hover/btn:group-aria-pressed/btn:bg-accent cds-btn-squish shadow-field"></span><span class="inline-flex min-w-0 items-center gap-1">Edit prompt</span></button></div><div data-trigger-disabled="" id="_r_gm_"><button class="cds-reset group/btn relative isolate inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none cursor-[var(--cds-cursor-interactive)] aria-disabled:cursor-default data-[disabled]:cursor-default border-0 outline-none focus-visible:outline-hidden rounded h-control font-sans text-body [&amp;:disabled:not([aria-busy])]:opacity-50 disabled:pointer-events-none transition-shadow duration-fast focus-visible:shadow-focus text-primary font-normal aria-pressed:text-accent px-md" data-cds="Button" data-size="sm" type="button"><span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] transition-colors duration-fast group-focus-visible/btn:shadow-[inset_0_0_0_1px_var(--cds-page-bg)] bg-fill-secondary group-hover/btn:bg-fill-secondary-hover group-[[aria-haspopup][aria-expanded=true]]/btn:bg-fill-secondary-hover inset-0 group-aria-pressed/btn:bg-accent group-hover/btn:group-aria-pressed/btn:bg-accent cds-btn-squish shadow-field"></span><span class="inline-flex min-w-0 items-center gap-1">Try again</span></button></div></div></span></div></div></div></div>`;
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="10">${lastUserHtml}</div>
      <div data-index="11">${lastAssistantHtml}</div>
    </div>
    <textarea></textarea>
  `;
  const result = await runExtraction(html, { scrollList: { scrollHeight: 2000, clientHeight: 400 } });
  const assistant = result.turns.find(t => t.role === 'assistant');

  assert.ok(assistant.html.includes('[Response was interrupted]'), 'must get a clean, readable marker');
  assert.ok(!assistant.html.includes('data-cds="Banner"'), 'the raw Banner widget must not survive into the export');
  assert.ok(!assistant.html.includes('\ue08f'), 'the raw private-use-area icon codepoint must never leak into captured text');
  assert.ok(!assistant.html.includes('Edit prompt'), 'the banner\'s own action buttons must not leak in as text');
  assert.ok(!assistant.html.includes('Try again'), 'the banner\'s own action buttons must not leak in as text');
  // The real bug this session found: real generated text existed in the DOM
  // well past the visible cutoff point - must still be captured in full.
  assert.ok(assistant.html.includes('standard vocabulary for talking about networking'));
  assert.ok(assistant.html.includes("Here's the layer stack for reference before"));
});

test('waits for an actively-streaming response to settle before exporting (real timing repro)', async () => {
  // Confirmed via a real repro against an actual exported chat: exporting
  // right as/after clicking Stop can race the UI's own re-render, capturing
  // a stale, truncated DOM snapshot even though content.js's own scrape and
  // markdown conversion are both correct - the DOM read itself happened too
  // early. Each assistant turn's wrapper carries a real
  // data-is-streaming="true"/"false" attribute (confirmed via live DevTools
  // inspection) that flips to false once a response finishes OR is
  // interrupted, so extraction now polls on it before reading anything.
  const html = `
    <div id="scrollList" style="overflow-y:auto;height:400px">
      <div data-index="0" data-testid="user-message">A user question.</div>
      <div data-index="1" data-is-streaming="true">
        <div class="font-claude-response">partial text so far</div>
      </div>
    </div>
    <textarea></textarea>
  `;

  const settleDelayMs = 900;
  const result = await runExtraction(
    html,
    { scrollList: { scrollHeight: 2000, clientHeight: 400 } },
    (window) => {
      window.setTimeout(() => {
        window.document.querySelector('[data-is-streaming]').setAttribute('data-is-streaming', 'false');
        window.document.querySelector('.font-claude-response').textContent = 'partial text so far, now complete.';
      }, settleDelayMs);
    }
  );

  const assistant = result.turns.find(t => t.role === 'assistant');
  assert.ok(assistant.html.includes('now complete'), 'must capture the settled text, not the stale mid-stream snapshot');
  assert.ok(!assistant.html.includes('partial text so far</div>'), 'must not still be the raw pre-settle snapshot');
});
