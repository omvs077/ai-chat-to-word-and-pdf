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
