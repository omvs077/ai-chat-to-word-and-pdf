// Injected on-demand (via chrome.scripting.executeScript) only when the user
// clicks "Export chat" in the popup. Never runs passively or on page load.
// Returns the same JSON Intermediate Representation shape as content/content.js
// (Claude's adapter) and content/chatgpt-content.js - popup.js's markdown
// assembly is already platform-agnostic and needs no changes to consume this.
//
// v1 SCOPE, confirmed only against a real, live-captured 14-turn gemini.google.com
// conversation (an .mhtml snapshot decoded and inspected directly - not guessed,
// not hand-typed from memory of how Angular Material apps "usually" look):
//   - text, headings (h1-h3 confirmed), lists (incl. nested), bold/italic, inline
//     code, blockquotes, tables (see normalizeTables - Turndown has NO table
//     support at all in this project's vendored build, confirmed empirically;
//     without this every cell would collapse into its own paragraph, losing the
//     grid entirely)
//   - fenced code blocks (<code-block> wrapping a real <pre><code>, with actual
//     newline characters already present in the text - NOT ChatGPT's per-line-div
//     CodeMirror shape, so no join('\n') reconstruction is needed here, just a
//     language-label fix, see normalizeCodeBlocks)
//   - math (KaTeX-rendered, but the raw LaTeX source sits right on a data-math
//     attribute on both inline and block wrappers - confirmed via real DevTools
//     capture - so this converts to $..$/$$..$$ plain text instead of ever
//     trying to parse the KaTeX HTML soup itself)
//   - real model-authored links (<link-block><a href>, e.g. a "Source:" line the
//     model writes itself) - Turndown converts these natively, same as Claude/GPT
//   - generated images and user-uploaded file previews (both real <img
//     src="blob:https://gemini.google.com/...">, same-origin and fetchable
//     exactly like Claude's approach - see embedImages)
//   - the "You stopped this response" interrupted-response notice
//     (<response-info-line>, confirmed real, plain readable text with no
//     icon-font/glyph issue the way Claude's own interrupted banner has)
//
// CONFIRMED NOT extractable (architectural limitation, not a bug to chase):
//   inline footnote citations (superscript number -> <source-inline-chip>) are
//   real <button> elements with NO href anywhere - the actual source URL only
//   loads into a dialog on click, asynchronously. A passive DOM scrape can never
//   see it. These are stripped rather than rendered as fake/broken links - see
//   STRIP_SELECTORS. (Contrast with the model-authored <link-block><a href> case
//   above, which IS a real, static, extractable link - confirmed on the same
//   real conversation, both forms exist side by side.)
//
// KNOWN OPEN RISK, stated plainly rather than guessed away: no per-turn index
// attribute (like ChatGPT's data-testid="conversation-turn-N" or Claude's
// data-index) was found anywhere in the real capture. Turn ordering here relies
// entirely on live DOM position (via turnIndexFor's querySelectorAll-index
// lookup and the _seq capture-order fallback), same as both other adapters'
// fallback path. This was captured from a 14-turn conversation with no
// cdk-virtual-scroll markers present anywhere in the DOM - i.e. NOT virtualized
// at that length. Whether gemini.google.com virtualizes/unmounts old turns on a
// much longer real thread (the requirement doc's 50+ turn case) is unconfirmed;
// if it does, a position-based index could shift under a scroll-and-collect
// walk. The same scroll-and-collect loop pattern as the other two adapters is
// used defensively anyway (harmless no-op on a short thread), but this is a real
// gap to revisit with a genuinely long real conversation, not a solved problem.
//
// Deliberately DEFERRED, not guessed at:
//   - artifacts/toolUses arrays always return empty - no real DOM confirmation
//     for any Gemini equivalent (e.g. Canvas-style widgets, tool-call status
//     lines) was captured this session.
//   - regenerate/edit-in-place turn states - not captured.

(async function extractGeminiChat() {
  // Real, confirmed markers Gemini itself uses to tag UI-only chrome (action
  // bars, table export/overflow buttons, generated-image hover controls, the
  // follow-up suggestion chip) - seen 15x (hide-from-message-actions) and 19x
  // (hide-on-print) across the real capture, on otherwise-unrelated elements.
  // A single attribute/class-based net instead of hunting individual leaks one
  // at a time the way ChatGPT's h4.sr-only and Edit-button selectors had to be
  // found - but still verified against real bytes, not assumed to be exhaustive.
  const STRIP_SELECTORS = [
    '[hide-from-message-actions]',
    '.hide-on-print',
    // Visually-hidden a11y-only duplicates of text already rendered elsewhere
    // (confirmed real: h5.screen-reader-user-query-label duplicates the user's
    // own prompt text; h6.screen-reader-model-response-label is a hidden
    // "Gemini said" heading with no visible on-page equivalent - same leaked-
    // sr-only-heading bug class ChatGPT had with "ChatGPT said:"). Angular
    // CDK's own sr-only utility class backs up both real instances found.
    '.cdk-visually-hidden',
    // Inline citation footnote UI - confirmed to carry no extractable href (see
    // file header). Left in place, this would leak raw <button>/jslog markup
    // and a source title with no working link into the export.
    'source-inline-chip',
    'source-footnote',
    'sources-carousel-inline',
    'sources-list',
    // A third-party extension's own UI was found injected into the real
    // captured page (a competing chat-export tool). Not part of Gemini's own
    // DOM at all - stripped defensively so our own export never accidentally
    // includes another extension's injected chrome.
    'saveai-chat-export-btn'
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = []; // diagnostic trail for when everything fails

  // --- Tier 1: the only tier confirmed against real DOM this session. Both
  // roles use their own dedicated custom element tag, unlike ChatGPT's shared
  // data-message-author-role attribute - so no filtering-by-value step is
  // needed the way ChatGPT's detectTurnNodes() requires. ---
  const TIER1_USER = 'user-query';
  const TIER1_ASSISTANT = 'model-response';

  // --- Tier 2: generic attribute-pattern fallback, mirroring the same
  // defensive layering the other two adapters use - none of these are
  // confirmed to currently exist on gemini.google.com, kept only as a safety
  // net in case Gemini renames its custom elements in a future redesign. ---
  const TIER2_USER = ['[data-role="user"]', '[data-testid*="user-turn" i]', '[data-testid*="user-message" i]'];
  const TIER2_ASSISTANT = ['[data-role="assistant"]', '[data-testid*="assistant-turn" i]', '[data-testid*="model-response" i]'];

  function uniqueMatches(selectors) {
    for (const sel of selectors) {
      try {
        const found = Array.from(document.querySelectorAll(sel));
        tried.push(`${sel} -> ${found.length}`);
        if (found.length) return found;
      } catch (_) { /* invalid selector on this page, skip */ }
    }
    return [];
  }

  function dropAncestors(nodes) {
    return nodes.filter((n, i) => !nodes.some((m, j) => i !== j && n.contains(m)));
  }

  function detectTurnNodes() {
    const userNodes = Array.from(document.querySelectorAll(TIER1_USER));
    const assistantNodes = Array.from(document.querySelectorAll(TIER1_ASSISTANT));
    tried.push(`${TIER1_USER} -> ${userNodes.length}`, `${TIER1_ASSISTANT} -> ${assistantNodes.length}`);
    if (userNodes.length && assistantNodes.length) return { userNodes, assistantNodes, method: 'tier1-custom-elements' };

    const u2 = dropAncestors(uniqueMatches(TIER2_USER));
    const a2 = dropAncestors(uniqueMatches(TIER2_ASSISTANT));
    if (u2.length && a2.length) return { userNodes: u2, assistantNodes: a2, method: 'tier2-common-attributes' };
    if (userNodes.length) return { userNodes, assistantNodes: a2, method: 'tier1-user+tier2-assistant' };
    if (u2.length) return { userNodes: u2, assistantNodes, method: 'tier2-user+tier1-assistant' };
    return null;
  }

  // Real, confirmed ancestor chain from a live capture: user-query ->
  // div.conversation-container -> infinite-scroller.chat-history ->
  // div.chat-history-scroll-container (the real overflow:auto surface) ->
  // chat-window-content. Walking up from the real anchor element (not a blind
  // document.querySelector) so this can never latch onto an unrelated
  // same-named element elsewhere on the page - the same false-positive class
  // of bug ChatGPT's findScrollContainer had to be fixed for.
  function findScrollContainer(fromEl) {
    let classMatch = null;
    let el = fromEl;
    while (el && el !== document.body) {
      if (!classMatch && /chat-history-scroll-container/.test(el.className || '') && el.scrollHeight >= el.clientHeight) {
        classMatch = el;
      }
      const style = getComputedStyle(el);
      const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (scrollable && el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return classMatch || document.scrollingElement || document.documentElement;
  }

  // See file header re: no confirmed per-turn index attribute. This derives a
  // real, DOM-order-based index from the confirmed div.conversation-container
  // wrapper (each pairs exactly one user-query with one model-response) rather
  // than inventing or guessing any data attribute.
  function turnIndexFor(el) {
    const wrapper = el.closest('div.conversation-container');
    if (!wrapper) return null;
    const all = Array.from(document.querySelectorAll('div.conversation-container'));
    const idx = all.indexOf(wrapper);
    return idx === -1 ? null : idx;
  }

  function turnKey(role, el) {
    const idx = turnIndexFor(el);
    return idx === null ? `text:${role}:${el.textContent.trim().slice(0, 80)}` : `idx:${idx}:${role}`;
  }

  // Confirmed real structure: <code-block> wraps a real <pre><code
  // data-test-id="code-content">, with actual newline characters already
  // present between the hljs syntax-highlight spans (NOT one <div> per line the
  // way ChatGPT's CodeMirror shape is) - so .textContent alone reconstructs the
  // original source exactly, no line-join reconstruction needed. The only real
  // gap: the language name (plain text, e.g. "Python") sits in a sibling
  // decoration bar and would otherwise leak as a stray line directly above the
  // fenced block - confirmed via a real generated export probe. Rebuilding a
  // plain <pre><code class="language-x"> here lets Turndown's own
  // fencedCodeBlock rule (which reads that class) put the language into the
  // fence info-string correctly, and dropping the decoration bar removes the
  // leak at the source instead of trying to strip it back out downstream.
  function normalizeCodeBlocks(clone) {
    clone.querySelectorAll('code-block').forEach(cb => {
      const codeEl = cb.querySelector('code[data-test-id="code-content"]');
      if (!codeEl) return;
      const labelEl = cb.querySelector('.code-block-decoration span');
      const label = labelEl ? labelEl.textContent.trim() : '';
      const codeText = codeEl.textContent.replace(/\n$/, '');
      const newPre = document.createElement('pre');
      const newCode = document.createElement('code');
      if (label) newCode.className = `language-${label.toLowerCase().replace(/\s+/g, '-')}`;
      newCode.textContent = codeText;
      newPre.appendChild(newCode);
      cb.replaceWith(newPre);
    });
  }

  // Confirmed empirically (real captured table, run through the real vendored
  // Turndown, before any fix): every <td>/<th> collapses into its own separate
  // paragraph with zero grid structure - this project's vendored Turndown build
  // has no table/GFM plugin at all.
  //
  // IMPORTANT, real, and bigger than this file: lib/markdown-blocks.js's
  // parseMarkdownBlocks() - shared by both docx-generator.js and
  // pdf-generator.js - has no 'table' block type at all (confirmed by reading
  // it directly). It only recognizes blank lines, fenced code, headings, lists,
  // and paragraphs - and its paragraph branch JOINS all contiguous non-blank
  // lines with a single space. So even a perfectly-formed multi-line GFM table
  // string would still get flattened onto one line by that shared parser,
  // regardless of what this file hands it. Rendering an actual gridded table
  // in the Word/PDF output would require a real 'table' block type there plus
  // real table-rendering code in both generators - a cross-cutting change to
  // 3 shared files well beyond this adapter's scope, not something to add
  // silently. Flagged to the user rather than half-built.
  //
  // What THIS function does instead, honestly: keeps real GFM pipe-row syntax
  // (so a human reader still sees clear column separation, and upgrading to a
  // real table later is a straightforward follow-up), but emits each row as
  // its OWN real <p> element rather than one shared text node - Turndown's
  // paragraph rule guarantees a real blank line around each <p> regardless of
  // its own internal whitespace handling, and a blank-line-separated single
  // line is exactly what parseMarkdownBlocks's paragraph branch stops at - so
  // each row survives as its own separate line instead of being joined into
  // one run-on paragraph with every other row.
  //
  // Bold and other inline formatting inside a cell is flattened to plain
  // text via cellMarkdown() below - a documented, deliberate limitation (see
  // cellMarkdown's own comment for why), not something guessed at.
  // Cell text is flattened to plain textContent - deliberately, not a guess
  // gap. A real cell in the capture nests bold as <td><span><b>...</b></span>
  // </td>; threading that through correctly means emitting literal **markers**
  // inside an already-escaped text node, which interacts with the shared
  // inline-run regex in lib/markdown-blocks.js (parseInlineRuns) in ways that
  // need careful, isolated verification of their own before touching that
  // shared, already-tested file - out of scope for this adapter alone. Plain
  // text keeps this change fully contained to gemini-content.js; losing a
  // bold marker inside a table cell is a minor, documented limitation, not
  // silently-guessed behavior.
  function cellMarkdown(cell) {
    return cell.textContent.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  }

  function normalizeTables(clone) {
    clone.querySelectorAll('table').forEach(table => {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (!rows.length) return;
      const frag = document.createDocumentFragment();
      rows.forEach((tr, i) => {
        const cells = Array.from(tr.children).map(cellMarkdown);
        const rowP = document.createElement('p');
        rowP.textContent = `| ${cells.join(' | ')} |`;
        frag.appendChild(rowP);
        if (i === 0) {
          const sepP = document.createElement('p');
          sepP.textContent = `| ${cells.map(() => '---').join(' | ')} |`;
          frag.appendChild(sepP);
        }
      });
      table.replaceWith(frag);
    });
  }

  // Confirmed real: KaTeX renders both inline and block math into deep,
  // unreadable span/SVG soup - but the ORIGINAL raw LaTeX source sits right on
  // a data-math attribute on the wrapping element either way
  // (span.math-inline / div.math-block), directly confirmed via live DevTools.
  // No KaTeX HTML is ever parsed here - just read the attribute and emit plain
  // $..$/$$..$$ text. This is display-only scope, same honest boundary as the
  // rest of the project: the exported Word/PDF document shows readable LaTeX
  // source text, not a typeset equation - there is no math-rendering engine in
  // either generator and none is being added here.
  // Turndown's text-node escaping (confirmed via the real vendored source) will
  // backslash-double every literal '\' in this text (e.g. \frac -> \\frac) and
  // escape every '_' - this is the exact same escape class already fixed once
  // for ChatGPT's bracket-leak bug. No extra handling is needed here: the
  // shared unescapeMarkdown() in lib/markdown-blocks.js already reverses '\\_',
  // '\\*', and '\\\\' -> '\' for every non-code inline run at document-
  // generation time, downstream of this file - confirmed by running this exact
  // normalization against the real math fixture through the real Turndown and
  // real unescapeMarkdown together before writing this comment.
  function normalizeMath(clone) {
    clone.querySelectorAll('.math-block[data-math]').forEach(el => {
      const tex = el.getAttribute('data-math') || '';
      el.replaceWith(document.createTextNode(`\n\n$$${tex}$$\n\n`));
    });
    clone.querySelectorAll('.math-inline[data-math]').forEach(el => {
      const tex = el.getAttribute('data-math') || '';
      el.replaceWith(document.createTextNode(`$${tex}$`));
    });
  }

  // Confirmed real on both a generated-image assistant turn and a user file
  // upload turn: the actual <img> sits directly inside the turn's own node
  // (user-query / model-response), not in some separate sibling scope the way
  // Claude's uploaded-file thumbnails do - so no wider findTurnScope() lookup
  // is needed here, el's own subtree already has it. src is always a real
  // same-origin blob: URL (confirmed on both turns), fetchable via the page's
  // own context exactly like Claude's embedImages() already does.
  function extractImages(el) {
    return Array.from(el.querySelectorAll('img')).filter(img => {
      const src = img.currentSrc || img.src || '';
      return src.startsWith('blob:') || src.startsWith('http');
    }).map(img => ({
      src: img.currentSrc || img.src,
      alt: (img.getAttribute('alt') || '').trim() || 'image',
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0
    }));
  }

  // Leaving the real <img> in place would let Turndown convert it into a
  // broken ![alt](blob:...) reference - the blob URL is only valid inside the
  // live tab, and extractImages()/embedImages() already handle real embedding
  // separately (appended to the markdown by popup.js, same as Claude's
  // t.images). Removing it here avoids a duplicate/dead second image
  // reference in the final export.
  function normalizeImages(clone) {
    clone.querySelectorAll('img').forEach(img => img.remove());
  }

  function captureVisible(collected, seq, container) {
    const detected = detectTurnNodes();
    if (!detected) return;
    const found = dropAncestors(detected.userNodes).map(el => ({ role: 'user', el }))
      .concat(dropAncestors(detected.assistantNodes).map(el => ({ role: 'assistant', el })))
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
      normalizeTables(clone);
      normalizeCodeBlocks(clone);
      normalizeMath(clone);
      const images = extractImages(el);
      normalizeImages(clone);
      const idx = turnIndexFor(el);
      collected.set(key, {
        role,
        html: clone.innerHTML,
        images,
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

  // Same real same-origin blob: fetch approach as content.js's embedImages -
  // confirmed viable here since both real image samples captured use blob:
  // src, not signed cross-origin URLs.
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  async function embedImages(turns) {
    for (const t of turns) {
      if (!t.images || !t.images.length) continue;
      for (const img of t.images) {
        if (!img.src) { img.error = 'could not be loaded'; continue; }
        try {
          const resp = await fetch(img.src);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          if (blob.size > MAX_IMAGE_BYTES) {
            img.error = `too large to embed, ${(blob.size / (1024 * 1024)).toFixed(1)} MB`;
            continue;
          }
          img.dataUrl = await blobToDataURL(blob);
        } catch (_) {
          img.error = 'could not be loaded';
        }
      }
    }
  }

  const collected = await collectAllTurns();

  if (!collected.size) {
    return { error: 'NO_MESSAGES_FOUND', diagnostics: tried };
  }

  const ordered = Array.from(collected.values())
    .sort((a, b) => a._seq - b._seq)
    .sort((a, b) => (a._sortIndex === null || b._sortIndex === null) ? 0 : a._sortIndex - b._sortIndex)
    .map(({ _sortIndex, _seq, _method, ...rest }) => rest);

  const methodsUsed = Array.from(new Set(Array.from(collected.values()).map(t => t._method)));

  await embedImages(ordered);

  // Real captured <title> confirmed: "test chat## - Google Gemini" - suffix
  // stripped the same way ChatGPT's " - ChatGPT" is.
  const result = {
    title: document.title.replace(/\s*[-|]\s*Google Gemini\s*$/i, '').trim() || 'Gemini Conversation',
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: ordered,
    assistantName: 'Gemini',
    _detectionMethods: methodsUsed
  };

  return result;
})();
