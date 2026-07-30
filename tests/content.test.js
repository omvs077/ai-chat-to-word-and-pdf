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
