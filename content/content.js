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

  function byDomOrder(a, b) {
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  // --- Step 1: scroll the conversation to the top to force-load older,
  // virtualized/unloaded messages before we read the DOM. ---
  function findScrollContainer(fromEl) {
    let el = fromEl;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function loadFullHistory() {
    const anchor = document.querySelector(USER_SELECTORS[0]);
    if (!anchor) return; // nothing rendered yet — extraction below will report NO_MESSAGES_FOUND
    const container = findScrollContainer(anchor);
    let lastHeight = -1, stable = 0, iterations = 0;
    while (stable < 3 && iterations < 60) {
      container.scrollTop = 0;
      await sleep(350);
      const h = container.scrollHeight;
      stable = h === lastHeight ? stable + 1 : 0;
      lastHeight = h;
      iterations++;
    }
  }

  await loadFullHistory();

  // --- Step 2: locate turns. Primary path uses the confirmed selectors for
  // each role. If Claude ever renames the assistant class again, fall back
  // to inferring turns from DOM structure around the (more stable) user
  // message testid, rather than failing outright. ---
  const userNodes = dropAncestors(firstMatching(USER_SELECTORS));
  const assistantNodes = dropAncestors(firstMatching(ASSISTANT_SELECTORS));

  function turnsFromStructure(userNodes) {
    if (!userNodes.length) return [];
    let el = userNodes[0];
    while (el.parentElement && el.parentElement.children.length === 1) el = el.parentElement;
    const list = el.parentElement;
    if (!list) return userNodes.map(u => ({ role: 'user', el: u }));

    const turnEls = Array.from(list.children).filter(c => c.textContent && c.textContent.trim().length > 0);
    const containsAllUsers = userNodes.every(u => turnEls.some(t => t.contains(u)));
    if (turnEls.length <= userNodes.length || !containsAllUsers) {
      return userNodes.map(u => ({ role: 'user', el: u }));
    }
    return turnEls.map(t => ({ role: userNodes.some(u => t.contains(u)) ? 'user' : 'assistant', el: t }));
  }

  const turns = assistantNodes.length
    ? userNodes.map(el => ({ role: 'user', el })).concat(assistantNodes.map(el => ({ role: 'assistant', el }))).sort(byDomOrder)
    : turnsFromStructure(userNodes);

  if (!turns.length) {
    return { error: 'NO_MESSAGES_FOUND' };
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

  // Best-effort: inline images (excluding small icons/avatars).
  function extractImages(el) {
    return Array.from(el.querySelectorAll('img')).filter(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return (w === 0 && h === 0) || (w > 48 && h > 48); // unresolved lazy imgs pass through too
    }).map(img => ({ src: img.currentSrc || img.src, alt: img.alt || 'image' }));
  }

  // Best-effort: Claude "artifact" preview cards. These usually open a side
  // panel via JS rather than a real link, so we can only capture a label —
  // if this misses real artifacts on your account, tell me what
  // `document.querySelector('[data-testid*="artifact"]')` looks like and
  // I'll refine the selector.
  function extractArtifacts(el) {
    return Array.from(el.querySelectorAll('[data-testid*="artifact" i]'))
      .filter(node => !node.querySelector('[data-testid*="artifact" i]')) // innermost only
      .map(node => ({ title: node.textContent.trim().slice(0, 120) || 'Untitled artifact' }));
  }

  const result = {
    title: document.title.replace(/\s*[-|]\s*Claude\s*$/i, '').trim() || 'Claude Conversation',
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: turns.map(({ role, el }) => {
      const clone = el.cloneNode(true);
      STRIP_SELECTORS.concat('[data-testid*="artifact" i]').forEach(sel => {
        clone.querySelectorAll(sel).forEach(n => n.remove());
      });
      return {
        role,
        html: clone.innerHTML,
        codeBlocks: extractCodeBlocks(el),
        images: extractImages(el),
        artifacts: extractArtifacts(el)
      };
    })
  };

  return result;
})();
