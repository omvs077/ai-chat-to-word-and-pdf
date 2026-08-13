// Injected on-demand (via chrome.scripting.executeScript) only when the user
// clicks "Export chat" in the popup. Never runs passively or on page load.
// Returns the same JSON Intermediate Representation shape as
// content/content.js (Claude's adapter) - popup.js's markdown assembly is
// already platform-agnostic and needs no changes to consume this.
//
// v1 SCOPE, confirmed only against what real, live DevTools inspection of an
// actual ChatGPT conversation actually showed (not guessed):
//   - text, headings, lists, real links (chatgpt.com renders these as plain
//     <a href> tags - Turndown converts them natively, no special handling
//     needed the way Claude's markdown-link flattening required)
//   - fenced code blocks (CodeMirror-based <pre class="cm-content">, but
//     structurally still a real pre>code pair)
//   - scroll-and-collect for virtualized turns (same challenge as Claude)
//
// Deliberately DEFERRED, not silently guessed at:
//   - image embedding (uploaded/generated images are same-origin
//     chatgpt.com/backend-api/... URLs, which is promising, but untested;
//     web-search result images are cross-origin images.openai.com, likely
//     unfetchable the same way Claude's web-search thumbnails are)
//   - Canvas (the real trigger mechanism for ChatGPT's native Canvas is
//     still unconfirmed - a test prompt asking for it returned a plain-text
//     "I can't open Canvas from here" response instead; what we captured
//     under that name during scoping was actually a third-party Canva app
//     invocation, not ChatGPT's own feature, so there is zero real DOM
//     evidence for native Canvas yet)
//   - interrupted-response handling (no real DOM sample of a genuinely
//     stopped ChatGPT response was captured during scoping - the one
//     interrupt attempt was resent fresh rather than left stopped, so
//     unlike Claude's data-is-streaming attribute, nothing here is
//     confirmed - no streaming-wait logic is implemented for this reason,
//     not because the risk doesn't exist)
//   - artifacts/toolUses arrays are always returned empty for the same
//     reason: no real DOM confirmation yet for ChatGPT's own tool-use
//     status widgets (e.g. "Searched 3 sites").

(async function extractChatGPTChat() {
  const STRIP_SELECTORS = [
    // Favicon + short-name chip ChatGPT appends after a cited link (confirmed
    // via live DevTools: data-testid="webpage-citation-pill", wraps a
    // tracking-decorated ?utm_source=chatgpt.com URL). Left unstripped, its
    // favicon <img> and label text leak into the markdown as extra noise
    // immediately after the real link Turndown already converts correctly.
    '[data-testid="webpage-citation-pill"]'
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = []; // diagnostic trail for when everything fails

  // --- Tier 1: known-good selector, confirmed via live DevTools inspection
  // of a real conversation (both roles share one attribute, unlike Claude's
  // separate user/assistant selectors). ---
  const TIER1_MESSAGE = '[data-message-author-role]';

  // --- Tier 2: fallback attribute patterns, in case ChatGPT renames this -
  // mirrors the same defensive layering content.js uses for Claude, though
  // none of these are confirmed to currently exist on chatgpt.com. ---
  const TIER2_USER = ['[data-role="user"]', '[data-testid*="user-turn" i]', '[data-testid*="user-message" i]'];
  const TIER2_ASSISTANT = ['[data-role="assistant"]', '[data-testid*="assistant-turn" i]', '[data-testid*="assistant-message" i]'];

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

  function detectTurnNodes() {
    const all = Array.from(document.querySelectorAll(TIER1_MESSAGE));
    tried.push(`${TIER1_MESSAGE} -> ${all.length}`);
    const userNodes = all.filter(el => el.getAttribute('data-message-author-role') === 'user');
    const assistantNodes = all.filter(el => el.getAttribute('data-message-author-role') === 'assistant');
    if (userNodes.length && assistantNodes.length) return { userNodes, assistantNodes, method: 'tier1-author-role' };

    const u2 = dropAncestors(uniqueMatches(TIER2_USER));
    const a2 = dropAncestors(uniqueMatches(TIER2_ASSISTANT));
    if (u2.length && a2.length) return { userNodes: u2, assistantNodes: a2, method: 'tier2-common-attributes' };
    if (userNodes.length) return { userNodes, assistantNodes: a2, method: 'tier1-user+tier2-assistant' };
    if (u2.length) return { userNodes: u2, assistantNodes, method: 'tier2-user+tier1-assistant' };
    return null;
  }

  // Generic "walk up until something actually scrolls" - not ChatGPT-
  // specific at all, and deliberately reused verbatim from content.js's own
  // findScrollContainer rather than hardcoding the "scrollport" class
  // fragment confirmed via live inspection - that class only matters for
  // recognizing the real container by coincidence; this structural check
  // finds the same element without depending on any class name surviving a
  // future redesign.
  function findScrollContainer(fromEl) {
    let el = fromEl;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // ChatGPT's code blocks are CodeMirror-rendered but still a real pre>code
  // pair (confirmed via live DevTools: <pre class="cm-content ..."><code>
  // <span>...</span>...</code></pre>) - real newlines exist inside the
  // token spans, so .innerText reconstructs correctly the same way it does
  // for Claude's plain <pre><code> blocks. No language-xxx class was
  // observed on the <code> element itself; falls back to the preceding-
  // sibling label heuristic already proven for Claude, unverified here
  // pending a real generated-export check.
  function extractCodeBlocks(el) {
    return Array.from(el.querySelectorAll('pre')).map(pre => {
      const codeEl = pre.querySelector('code');
      const langMatch = codeEl && codeEl.className.match(/language-(\S+)/);
      const labelEl = pre.previousElementSibling;
      const label = langMatch ? langMatch[1] : (labelEl && labelEl.textContent.trim().length < 20 ? labelEl.textContent.trim() : '');
      return { language: label || 'text', code: (codeEl || pre).innerText.replace(/\n$/, '') };
    });
  }

  // conversation-turn-N carries the real turn index directly in the
  // attribute value (confirmed via live inspection: turns 10, 11, 14,
  // 18-22 mounted at once during virtualization) - unlike Claude's
  // data-index, which required an ancestor-walk since no such attribute
  // exists on the message node's own line. closest() finds this in one
  // step; no fixed hop-count/depth guess needed here at all.
  function turnIndexFor(el) {
    const wrapper = el.closest('[data-testid^="conversation-turn-"]');
    if (!wrapper) return null;
    const m = wrapper.getAttribute('data-testid').match(/conversation-turn-(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function turnKey(role, el) {
    const idx = turnIndexFor(el);
    return idx === null ? `text:${role}:${el.textContent.trim().slice(0, 80)}` : `idx:${idx}:${role}`;
  }

  function captureVisible(collected, seq, container) {
    const detected = detectTurnNodes();
    if (!detected) return;
    const found = dropAncestors(detected.userNodes).map(el => ({ role: 'user', el }))
      .concat(dropAncestors(detected.assistantNodes).map(el => ({ role: 'assistant', el })))
      // Same sidebar/nav-contamination safety net content.js uses for
      // Claude: a matched node only counts if it's actually inside the
      // message-list container we're scrolling.
      .filter(({ el }) => container.contains(el))
      .sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    for (const { role, el } of found) {
      const key = turnKey(role, el);
      if (collected.has(key)) continue;
      const clone = el.cloneNode(true);
      STRIP_SELECTORS.forEach(sel => {
        clone.querySelectorAll(sel).forEach(n => n.remove());
      });
      const idx = turnIndexFor(el);
      collected.set(key, {
        role,
        html: clone.innerHTML,
        codeBlocks: extractCodeBlocks(el),
        images: [], // deferred - see file header
        artifacts: [], // deferred - see file header
        toolUses: [], // deferred - see file header
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
      captureVisible(collected, seq, container);
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
      if (atBottom) break;
      container.scrollTop += Math.max(120, container.clientHeight * 0.4);
      await sleep(150);
      guard++;
    }
    captureVisible(collected, seq, container);

    return collected;
  }

  const collected = await collectAllTurns();

  if (!collected.size) {
    return { error: 'NO_MESSAGES_FOUND', diagnostics: tried };
  }

  // Same two-pass stable-sort rationale as content.js: establish a correct
  // baseline via capture order first, then stable-resort by the real turn
  // index where one's resolvable, leaving unresolvable turns at their
  // baseline position rather than comparing across incompatible scales.
  const ordered = Array.from(collected.values())
    .sort((a, b) => a._seq - b._seq)
    .sort((a, b) => (a._sortIndex === null || b._sortIndex === null) ? 0 : a._sortIndex - b._sortIndex)
    .map(({ _sortIndex, _seq, _method, ...rest }) => rest);

  const methodsUsed = Array.from(new Set(Array.from(collected.values()).map(t => t._method)));

  // Real saved-page title showed no " - ChatGPT" suffix (confirmed:
  // <title>test chat</title>, verbatim, nothing to strip) - stripped
  // defensively anyway in case some UI state does add one; costs nothing
  // when absent.
  const result = {
    title: document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT Conversation',
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: ordered,
    _detectionMethods: methodsUsed
  };

  return result;
})();
