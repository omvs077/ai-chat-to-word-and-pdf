// Injected on-demand (via chrome.scripting.executeScript) only when the user
// clicks "Export chat" in the popup. Never runs passively or on page load.
// Returns a JSON Intermediate Representation of the conversation; the last
// expression's value becomes the executeScript() result.

(function extractClaudeChat() {
  const USER_SELECTORS = ['[data-testid="user-message"]'];
  const ASSISTANT_SELECTORS = [
    '[data-testid="assistant-message"]',
    '.font-claude-message',
    '[data-testid="chat-message"] .prose'
  ];

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

  const userNodes = dropAncestors(firstMatching(USER_SELECTORS)).map(el => ({ role: 'user', el }));
  const assistantNodes = dropAncestors(firstMatching(ASSISTANT_SELECTORS)).map(el => ({ role: 'assistant', el }));

  const turns = userNodes.concat(assistantNodes).sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  if (!turns.length) {
    return { error: 'NO_MESSAGES_FOUND' };
  }

  function extractCodeBlocks(el) {
    return Array.from(el.querySelectorAll('pre')).map(pre => {
      const codeEl = pre.querySelector('code');
      const langMatch = codeEl && codeEl.className.match(/language-(\S+)/);
      // Claude's UI often shows a small language label above the code block.
      const labelEl = pre.previousElementSibling;
      const label = langMatch ? langMatch[1] : (labelEl && labelEl.textContent.trim().length < 20 ? labelEl.textContent.trim() : '');
      return { language: label || 'text', code: (codeEl || pre).innerText.replace(/\n$/, '') };
    });
  }

  const result = {
    title: document.title.replace(/\s*[-|]\s*Claude\s*$/i, '').trim() || 'Claude Conversation',
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: turns.map(({ role, el }) => ({
      role,
      codeBlocks: extractCodeBlocks(el)
    }))
  };

  // Markdown conversion happens in the popup (Turndown is loaded there), so we
  // hand back innerHTML per turn instead of raw text — preserves lists/headers/code.
  result.turns.forEach((t, i) => { t.html = turns[i].el.innerHTML; });

  return result;
})();
