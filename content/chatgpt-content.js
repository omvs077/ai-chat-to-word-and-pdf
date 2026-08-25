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

  // Confirmed via live DevTools inspection: a generic "walk up until tall
  // enough" check (content.js's approach, reused verbatim in an earlier
  // version of this function) produces a false positive on chatgpt.com -
  // it finds <main> (scrollHeight 6725 vs clientHeight 858) before ever
  // reaching the real scrolling element, because <main> is naturally tall
  // from normal page layout without itself being the overflow:auto surface
  // that actually scrolls. Setting scrollTop on it does nothing, so the
  // stability-wait loop spins for its full ceiling waiting for a
  // scrollHeight that can never change - confirmed as the exact cause of a
  // real "stuck at Extracting..., no visible scrolling" hang.
  //
  // Fixed two ways: (1) prefers an ancestor whose class matches the real,
  // live-confirmed fragment ("group/scrollport ... overflow-y-auto",
  // scrollHeight 1343 vs clientHeight 844 when checked directly); (2)
  // otherwise requires genuine overflow-y:auto|scroll on the computed
  // style, not just a height difference, so it can no longer false-
  // positive on a merely-tall non-scrolling wrapper like <main> the way
  // the original height-only check did.
  //
  // Both checks walk UP FROM fromEl (the real message element) rather than
  // doing a blind document.querySelector - a first attempt at fix (1) used
  // a global query for the class fragment, which could (and on a real
  // export, did) match a same-named but unrelated element elsewhere on the
  // page - e.g. a sidebar region that happens to share the class fragment
  // but doesn't contain the conversation at all. That produced a
  // *different* real bug: detection correctly found all 7 messages
  // (confirmed via the popup's own diagnostics), but the container.
  // contains(el) filter silently dropped every one of them, since the
  // "container" found wasn't actually an ancestor of any message. Walking
  // up from fromEl makes it structurally impossible to return an unrelated
  // element - whatever's found is guaranteed to actually contain fromEl.
  function findScrollContainer(fromEl) {
    let scrollportMatch = null;
    let el = fromEl;
    while (el && el !== document.body) {
      if (!scrollportMatch && /scrollport/i.test(el.className || '') && el.scrollHeight > el.clientHeight) {
        scrollportMatch = el;
      }
      const style = getComputedStyle(el);
      const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (scrollable && el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return scrollportMatch || document.scrollingElement || document.documentElement;
  }

  // ChatGPT's code blocks are CodeMirror-rendered. Two distinct real
  // structures have been directly confirmed via live DevTools at different
  // points on the same live page - both handled here, neither guessed:
  //   (a) <div class="cm-content" data-language="python"><div class="cm-line">
  //       ...</div>...</div> - one div per source line; a blank line is
  //       <div class="cm-line"><br></div>. This is the structure actually
  //       causing the real corruption confirmed in a generated export
  //       ("def binary\_search" as literal escaped text, one line per
  //       separate paragraph, indentation lost) - a first fix attempt only
  //       handled shape (b) below, which doesn't match this at all, so it
  //       silently matched nothing on the real page and did nothing.
  //   (b) <pre class="cm-content"><code><span>...per-token spans...</span>
  //       </code></pre> - seen in an earlier live inspection this session.
  //       Possibly a different rendering mode/state, or the structure
  //       changed between sessions - kept as a fallback since it's equally
  //       real, not speculative.
  // .textContent is used throughout, not .innerText - the original sample's
  // newlines are literal \n text characters already present in the DOM
  // (not CSS-rendered line breaks), so .textContent reconstructs them
  // identically with no layout/attachment dependency - this can operate
  // purely on the clone, no live element needed.
  //
  // NOT yet handled: a language-label header ("Python") and a "Run" button
  // that sit as siblings near the code block still leak into the captured
  // HTML as plain text (visible in a real export as literal "Python" /
  // "Run" lines before the code). Their real wrapper markup hasn't been
  // confirmed via live inspection yet, so no strip selector is guessed
  // here - this is a known, deliberate gap, not an oversight.
  function normalizeCodeBlocks(clone) {
    clone.querySelectorAll('.cm-content').forEach(cm => {
      const lineEls = cm.querySelectorAll(':scope > .cm-line');
      if (!lineEls.length) return; // not this shape - e.g. a <pre class="cm-content"> from the other real structure, handled below
      const lines = Array.from(lineEls).map(line => line.textContent);
      const codeText = lines.join('\n');
      const label = cm.getAttribute('data-language') || '';
      const newPre = document.createElement('pre');
      const newCode = document.createElement('code');
      if (label) newCode.className = `language-${label}`;
      newCode.textContent = codeText;
      newPre.appendChild(newCode);
      cm.replaceWith(newPre);
    });

    clone.querySelectorAll('pre').forEach(pre => {
      const codeEl = pre.querySelector('code');
      if (!codeEl || !codeEl.querySelector('span')) return; // already plain (or already normalized above), nothing to do
      const langMatch = codeEl.className.match(/language-(\S+)/);
      const label = langMatch ? langMatch[1] : '';
      const codeText = codeEl.textContent.replace(/\n$/, '');
      const newPre = document.createElement('pre');
      const newCode = document.createElement('code');
      if (label) newCode.className = `language-${label}`;
      newCode.textContent = codeText;
      newPre.appendChild(newCode);
      pre.replaceWith(newPre);
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
      normalizeCodeBlocks(clone);
      const idx = turnIndexFor(el);
      collected.set(key, {
        role,
        html: clone.innerHTML,
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
    assistantName: 'ChatGPT',
    _detectionMethods: methodsUsed
  };

  return result;
})();
