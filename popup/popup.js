(function () {
  const badge = document.getElementById('platformBadge');
  const exportBtn = document.getElementById('exportBtn');
  const statusLine = document.getElementById('statusLine');
  const pipeline = document.getElementById('pipeline');
  const segmentedOptions = Array.from(document.querySelectorAll('.segmented__option'));

  let format = 'docx';
  let activeTabId = null;

  segmentedOptions.forEach(btn => {
    btn.addEventListener('click', () => {
      segmentedOptions.forEach(b => { b.classList.remove('is-selected'); b.setAttribute('aria-checked', 'false'); });
      btn.classList.add('is-selected'); btn.setAttribute('aria-checked', 'true');
      format = btn.dataset.format;
    });
  });

  function setStatus(text, kind) {
    statusLine.textContent = text;
    statusLine.className = 'status' + (kind ? ` status--${kind}` : '');
  }

  function setStep(name, state) {
    const step = pipeline.querySelector(`.pipeline__step[data-step="${name}"]`);
    step.classList.remove('is-active', 'is-done');
    if (state) step.classList.add(state);
  }

  function fillRailsUpTo(stepName) {
    const order = ['extract', 'compile', 'save', 'done'];
    const rails = pipeline.querySelectorAll('.pipeline__fill');
    const idx = order.indexOf(stepName);
    rails.forEach((rail, i) => { rail.style.width = i < idx ? '100%' : '0%'; });
  }

  async function detectPlatform() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    activeTabId = tab.id;
    let hostname = '';
    try { hostname = new URL(tab.url).hostname; } catch (_) { /* non-http tab */ }

    if (hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) {
      badge.textContent = 'claude.ai detected';
      badge.className = 'badge badge--on';
      exportBtn.disabled = false;
      setStatus('Ready. Click Export to save this conversation.');
    } else {
      badge.textContent = 'not on claude.ai';
      badge.className = 'badge badge--off';
      exportBtn.disabled = true;
      setStatus('Open a Claude chat, then click Export.');
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function timestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  async function runExport() {
    exportBtn.disabled = true;
    pipeline.hidden = false;
    ['extract', 'compile', 'save'].forEach(s => setStep(s, null));
    fillRailsUpTo('extract');

    try {
      setStep('extract', 'is-active');
      setStatus('Extracting conversation from the page…');

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['content/content.js']
      });

      if (!result || result.error === 'NO_MESSAGES_FOUND') {
        if (result && result.diagnostics) console.warn('[Ai chat to word & pdf] detection failed, tried:', result.diagnostics);
        throw new Error('Could not find any messages on this page. Open DevTools console for details, or open a conversation with at least one exchange and try again.');
      }

      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      result.turns.forEach(t => {
        let md = turndown.turndown(t.html || '');
        if (t.toolUses && t.toolUses.length) {
          // Real captured text, not a generic placeholder - each disclosure
          // widget ("Ran 7 commands", "Connecting to visualize...") reads
          // above the response text in the actual UI, so it's prepended
          // here in the same order, each as its own italic line.
          const toolLines = t.toolUses.map(u => `*${u}*`).join('\n\n');
          md = `${toolLines}\n\n${md}`;
        }
        if (t.artifacts && t.artifacts.length) {
          md += t.artifacts.map(a => `\n\n📎 **Artifact:** ${a.title} — open this conversation in Claude to view/edit it.`).join('');
        }
        t.markdown = md;
      });

      setStep('extract', 'is-done');
      fillRailsUpTo('compile');
      setStep('compile', 'is-active');
      setStatus('Compiling document…');

      const blob = format === 'docx' ? await window.generateDocx(result) : await window.generatePdf(result);

      setStep('compile', 'is-done');
      fillRailsUpTo('save');
      setStep('save', 'is-active');
      setStatus('Saving file…');

      downloadBlob(blob, `claude-chat-export-${timestamp()}.${format}`);

      setStep('save', 'is-done');
      fillRailsUpTo('done');
      setStatus('Download complete — check your downloads folder.', 'success');
    } catch (err) {
      setStatus(err.message || 'Something went wrong during export.', 'error');
    } finally {
      exportBtn.disabled = false;
    }
  }

  exportBtn.addEventListener('click', runExport);
  detectPlatform();
})();

