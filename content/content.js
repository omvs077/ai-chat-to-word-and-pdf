// Injected on-demand (via chrome.scripting.executeScript) only when the user
// clicks "Export chat" in the popup. Never runs passively or on page load.
// Returns a JSON Intermediate Representation of the conversation; the last
// expression's value (a Promise, since this is async) becomes the
// executeScript() result — chrome.scripting awaits it automatically.
//
// RESILIENCE DESIGN: no selector list can survive every future redesign, so
// detection runs in tiers, each one less precise but less fragile than the
// last. If a tier finds nothing, we fall through automatically — no error,
// no re-injection needed. If ALL tiers fail, we report exactly what was
// tried (see NO_MESSAGES_FOUND diagnostics below) so a fix takes one
// screenshot instead of a guessing back-and-forth.
//
// Tier 1 — exact, site-specific selectors (fastest, most precise; breaks
//          when Claude renames a class/testid).
// Tier 2 — attribute *patterns* seen across multiple chat products (survives
//          Claude renaming things, as long as the naming convention itself
//          — data-testid, data-role, etc. — doesn't disappear).
// Tier 3 — pure structural inference anchored on the message compose box,
//          which essentially every chat UI has. No class names at all —
//          the most durable tier, but the least precise about roles.

(async function extractClaudeChat() {
  const STRIP_SELECTORS = ['[data-message-action-bar]', '[data-find-omitted]'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = []; // diagnostic trail for when everything fails

  function uniqueMatches(selectors) {
    const nodes = [];
    for (const sel of selectors) {
      try {
        const found = Array.from(document.querySelectorAll(sel));
        tried.push(`${sel} -> ${found.length}`);
        if (found.length) return found;
      } catch (_) { /* invalid selector on this page, skip */ }
    }
    return nodes;
  }

  function dropAncestors(nodes) {
    return nodes.filter((n, i) => !nodes.some((m, j) => i !== j && n.contains(m)));
  }

  // --- Tier 1: known-good selectors for the current claude.ai markup. ---
  const TIER1_USER = ['[data-testid="user-message"]'];
  const TIER1_ASSISTANT = ['.font-claude-response'];

  // --- Tier 2: attribute conventions common across chat products (ChatGPT's
  // data-message-author-role, and generic testid/data-role variants). ---
  const TIER2_USER = [
    '[data-message-author-role="user"]',
    '[data-role="user"]',
    '[data-testid*="user-turn" i]',
    '[data-testid*="user-message" i]'
  ];
  const TIER2_ASSISTANT = [
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-testid*="assistant-turn" i]',
    '[data-testid*="assistant-message" i]',
    '[data-testid*="model-response" i]'
  ];

  function detectByAttributes() {
    const userNodes = dropAncestors(uniqueMatches(TIER1_USER));
    const assistantNodes = dropAncestors(uniqueMatches(TIER1_ASSISTANT));
    if (userNodes.length && assistantNodes.length) return { userNodes, assistantNodes, method: 'tier1-known-selectors' };

    const u2 = dropAncestors(uniqueMatches(TIER2_USER));
    const a2 = dropAncestors(uniqueMatches(TIER2_ASSISTANT));
    if (u2.length && a2.length) return { userNodes: u2, assistantNodes: a2, method: 'tier2-common-attributes' };

    // Partial matches are still useful (e.g. Claude renames assistant class
    // but user-message testid still works) — prefer whichever tier found
    // the user side, since that selector has proven the most stable so far.
    if (userNodes.length) return { userNodes, assistantNodes: a2, method: 'tier1-user+tier2-assistant' };
    if (u2.length) return { userNodes: u2, assistantNodes, method: 'tier2-user+tier1-assistant' };
    return null;
  }

  // --- Tier 3: pure structural inference. Anchor on the compose box (every
  // chat UI has one), climb to find the repeating turn-list container, then
  // classify each turn by alternation (chat threads strictly alternate
  // user/assistant, starting with user) rather than any class name at all. ---
  function findComposeBox() {
    return document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
  }

  function detectStructurally() {
    try {
      const compose = findComposeBox();
      if (!compose) { tried.push('tier3: no compose box found'); return null; }

      // Find the scrollable ancestor of the compose box's page — the
      // conversation list is usually the largest scrollable region on the
      // page, so search broadly rather than strictly from the compose box.
      const candidates = Array.from(document.querySelectorAll('body *')).filter(el => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 100;
      });
      if (!candidates.length) { tried.push('tier3: no scrollable container found'); return null; }
      // Prefer the largest one (most likely the message list, not a sidebar).
      candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const list = candidates[0];

      // Direct children with substantial text are treated as turns.
      const turnEls = Array.from(list.children).filter(c => c.textContent && c.textContent.trim().length > 10);
      if (turnEls.length < 2) { tried.push(`tier3: only ${turnEls.length} candidate turn elements`); return null; }

      const userNodes = [], assistantNodes = [];
      turnEls.forEach((el, i) => (i % 2 === 0 ? userNodes : assistantNodes).push(el));
      tried.push(`tier3: structural, ${turnEls.length} alternating turns`);
      return { userNodes, assistantNodes, method: 'tier3-structural-alternating' };
    } catch (e) {
      tried.push(`tier3: threw ${e.message}`);
      return null;
    }
  }

  function detectTurnNodes() {
    return detectByAttributes() || detectStructurally();
  }

  function findScrollContainer(fromEl) {
    let el = fromEl;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function extractCodeBlocks(el) {
    return Array.from(el.querySelectorAll('pre')).map(pre => {
      const codeEl = pre.querySelector('code');
      const langMatch = codeEl && codeEl.className.match(/language-(\S+)/);
      const labelEl = pre.previousElementSibling;
      const label = langMatch ? langMatch[1] : (labelEl && labelEl.textContent.trim().length < 20 ? labelEl.textContent.trim() : '');
      return { language: label || 'text', code: (codeEl || pre).innerText.replace(/\n$/, '') };
    });
  }

  function extractImages(el) {
    return Array.from(el.querySelectorAll('img')).filter(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return (w === 0 && h === 0) || (w > 48 && h > 48);
    }).map(img => ({ src: img.currentSrc || img.src, alt: img.alt || 'image' }));
  }

  function extractArtifacts(el) {
    return Array.from(el.querySelectorAll('[data-testid*="artifact" i]'))
      .filter(node => !node.querySelector('[data-testid*="artifact" i]'))
      .map(node => ({ title: node.textContent.trim().slice(0, 120) || 'Untitled artifact' }));
  }

  // Message lists are commonly virtualized — only rows near the current
  // scroll position exist in the DOM at any moment, with a spacer div faking
  // the scrollbar height. Reading the DOM once, even after scrolling to the
  // top, only ever captures the head and tail. So we walk the scroll
  // container top-to-bottom in small overlapping steps, capturing whatever
  // is mounted at each stop before it gets unmounted again.
  function turnKey(role, el) {
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      if (n.dataset && n.dataset.index !== undefined) return `idx:${n.dataset.index}:${role}`;
      n = n.parentElement;
    }
    return `text:${role}:${el.textContent.trim().slice(0, 80)}`;
  }

  function sortIndexFor(el) {
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      if (n.dataset && n.dataset.index !== undefined) return Number(n.dataset.index);
      n = n.parentElement;
    }
    return null;
  }

  function captureVisible(collected, seq) {
    const detected = detectTurnNodes();
    if (!detected) return;
    const found = dropAncestors(detected.userNodes).map(el => ({ role: 'user', el }))
      .concat(dropAncestors(detected.assistantNodes).map(el => ({ role: 'assistant', el })));
    for (const { role, el } of found) {
      const key = turnKey(role, el);
      if (collected.has(key)) continue;
      const clone = el.cloneNode(true);
      STRIP_SELECTORS.concat('[data-testid*="artifact" i]').forEach(sel => {
        clone.querySelectorAll(sel).forEach(n => n.remove());
      });
      const idx = sortIndexFor(el);
      collected.set(key, {
        role,
        html: clone.innerHTML,
        codeBlocks: extractCodeBlocks(el),
        images: extractImages(el),
        artifacts: extractArtifacts(el),
        _sortIndex: idx === null ? null : idx * 2 + (role === 'user' ? 0 : 1),
        _seq: seq.n++,
        _method: detected.method
      });
    }
  }

  async function collectAllTurns() {
    const collected = new Map();
    const seq = { n: 0 };
    const firstPass = detectTurnNodes();
    if (!firstPass) return collected;

    const anchorEl = firstPass.userNodes[0] || firstPass.assistantNodes[0];
    const container = findScrollContainer(anchorEl);

    let lastHeight = -1, stable = 0, iterations = 0;
    while (stable < 3 && iterations < 60) {
      container.scrollTop = 0;
      await sleep(300);
      const h = container.scrollHeight;
      stable = h === lastHeight ? stable + 1 : 0;
      lastHeight = h;
      iterations++;
    }

    container.scrollTop = 0;
    await sleep(200);
    let guard = 0;
    while (guard < 500) {
      captureVisible(collected, seq);
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
      if (atBottom) break;
      container.scrollTop += Math.max(120, container.clientHeight * 0.4);
      await sleep(150);
      guard++;
    }
    captureVisible(collected, seq);

    return collected;
  }

  const collected = await collectAllTurns();

  if (!collected.size) {
    return { error: 'NO_MESSAGES_FOUND', diagnostics: tried };
  }

  const ordered = Array.from(collected.values()).sort((a, b) => {
    if (a._sortIndex !== null && b._sortIndex !== null) return a._sortIndex - b._sortIndex;
    return a._seq - b._seq;
  }).map(({ _sortIndex, _seq, _method, ...rest }) => rest);

  const methodsUsed = Array.from(new Set(Array.from(collected.values()).map(t => t._method)));

  const result = {
    title: document.title.replace(/\s*[-|]\s*Claude\s*$/i, '').trim() || 'Claude Conversation',
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: ordered,
    _detectionMethods: methodsUsed
  };

  return result;
})();
