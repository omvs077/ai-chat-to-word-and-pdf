// Injected on-demand (via chrome.scripting.executeScript) only when the user
// clicks "Export chat" in the popup. Never runs passively or on page load.
// Returns a JSON Intermediate Representation of the conversation; the last
// expression's value (a Promise, since this is async) becomes the
// executeScript() result — chrome.scripting awaits it automatically.

(async function extractClaudeChat() {
  const USER_SELECTORS = ['[data-testid="user-message"]'];
  const ASSISTANT_SELECTORS = ['.font-claude-response'];
  const STRIP_SELECTORS = ['[data-message-action-bar]', '[data-find-omitted]'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function firstMatching(selectors) {
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.length) return nodes;
    }
    return [];
  }

  // Drop nodes that are ancestors of another matched node (keeps innermost match).
  function dropAncestors(nodes) {
    return nodes.filter((n, i) => !nodes.some((m, j) => i !== j && n.contains(m)));
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

  // Claude's message list is virtualized — only messages near the current
  // scroll position exist in the DOM at any given moment; the rest are
  // unmounted with a spacer div faking the scrollbar height. Reading the DOM
  // once (even after scrolling to the top) only ever captures the head and
  // tail, never the middle. So instead we walk the scroll container from top
  // to bottom in small steps, capturing (cloning) whatever is mounted at each
  // step before it gets unmounted again, and dedupe by a stable per-turn key.
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
    const userNodes = dropAncestors(firstMatching(USER_SELECTORS));
    const assistantNodes = dropAncestors(firstMatching(ASSISTANT_SELECTORS));
    const found = userNodes.map(el => ({ role: 'user', el })).concat(assistantNodes.map(el => ({ role: 'assistant', el })));
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
        _sortIndex: idx === null ? null : idx * 2 + (role === 'user' ? 0 : 1), // user before assistant at same index
        _seq: seq.n++
      });
    }
  }

  async function collectAllTurns() {
    const collected = new Map(); // insertion order == top-to-bottom order (fallback only)
    const seq = { n: 0 };
    const anchor = document.querySelector(USER_SELECTORS[0]);
    if (!anchor) return collected;
    const container = findScrollContainer(anchor);

    // Phase 1: scroll to the very top, forcing earliest history to load.
    let lastHeight = -1, stable = 0, iterations = 0;
    while (stable < 3 && iterations < 60) {
      container.scrollTop = 0;
      await sleep(300);
      const h = container.scrollHeight;
      stable = h === lastHeight ? stable + 1 : 0;
      lastHeight = h;
      iterations++;
    }

    // Phase 2: walk down from the top in small, overlapping steps (40% of
    // viewport height) so no virtualized row is ever skipped between stops,
    // capturing newly-visible turns at each stop until we reach the bottom.
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
    return { error: 'NO_MESSAGES_FOUND' };
  }

  const ordered = Array.from(collected.values()).sort((a, b) => {
    if (a._sortIndex !== null && b._sortIndex !== null) return a._sortIndex - b._sortIndex;
    return a._seq - b._seq;
  }).map(({ _sortIndex, _seq, ...rest }) => rest);

  const result = {
    title: document.title.replace(/\s*[-|]\s*Claude\s*$/i, '').trim() || 'Claude Conversation',
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: ordered
  };

  return result;
})();
