// Builds a .pdf Blob from the normalized conversation IR.
// Uses the locally bundled jsPDF library (lib/vendor/jspdf.umd.min.js) — no network calls.

(function () {
  const { parseMarkdownBlocks } = window.MarkdownBlocks;

  const MARGIN = 48;
  const PAGE_W = 595.28; // A4 pt
  const PAGE_H = 841.89;
  const MAX_W = PAGE_W - MARGIN * 2;
  const LINE_H = 14;

  function stripInline(text) {
    return text
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => `${alt || 'image'} (${url})`)
      .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (m, label, url) => (label && label !== url ? `${label} (${url})` : url))
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
  }

  async function generatePdf(ir) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    let y = MARGIN;

    function ensureSpace(height) {
      if (y + height > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
    }

    function paragraph(text, { size = 10.5, font = 'helvetica', style = 'normal', color = [30, 30, 30], gapAfter = 8 } = {}) {
      doc.setFont(font, style); doc.setFontSize(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(text, MAX_W);
      for (const line of lines) {
        ensureSpace(LINE_H);
        doc.text(line, MARGIN, y);
        y += LINE_H;
      }
      y += gapAfter;
    }

    function codeBlock(code, language) {
      const ROW = 12;
      const wrapped = [];
      code.split('\n').forEach(l => wrapped.push(...doc.splitTextToSize(l || ' ', MAX_W - 16)));

      // Precompute how lines split across pages so each page's background
      // rect can be drawn before its text (jsPDF has no z-order control).
      const segments = [];
      let idx = 0;
      let cursorY = y;
      let newPage = false;
      while (idx < wrapped.length) {
        if (cursorY + ROW > PAGE_H - MARGIN) { cursorY = MARGIN; newPage = true; }
        const segStartY = cursorY;
        const segLines = [];
        while (idx < wrapped.length && cursorY + ROW <= PAGE_H - MARGIN) {
          segLines.push(wrapped[idx]); idx++; cursorY += ROW;
        }
        segments.push({ startY: segStartY, lines: segLines, newPage });
        newPage = false;
      }

      segments.forEach((seg) => {
        if (seg.newPage) { doc.addPage(); }
        y = seg.startY;
        doc.setFillColor(243, 243, 243);
        doc.rect(MARGIN, y - 9, MAX_W, seg.lines.length * ROW + 8, 'F');
        doc.setFont('courier', 'normal'); doc.setFontSize(9); doc.setTextColor(40, 40, 40);
        seg.lines.forEach(line => { doc.text(line, MARGIN + 8, y); y += ROW; });
      });
      y += 10;
    }

    function heading(text, level) {
      paragraph(text, { size: level === 1 ? 15 : 12.5, style: 'bold', gapAfter: 6 });
    }

    function list(items, ordered) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(30, 30, 30);
      items.forEach((item, idx) => {
        const prefix = ordered ? `${idx + 1}. ` : '\u2022  ';
        const lines = doc.splitTextToSize(item, MAX_W - 16);
        lines.forEach((line, li) => {
          ensureSpace(LINE_H);
          doc.text((li === 0 ? prefix : '   ') + line, MARGIN + 4, y);
          y += LINE_H;
        });
      });
      y += 6;
    }

    // Title
    paragraph(ir.title, { size: 18, style: 'bold', gapAfter: 4 });
    paragraph(`Exported ${new Date(ir.exportedAt).toLocaleString()} from ${ir.url}`, { size: 8.5, style: 'italic', color: [120, 120, 120], gapAfter: 14 });

    for (const turn of ir.turns) {
      ensureSpace(20);
      doc.setDrawColor(220, 220, 220);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 14;
      paragraph(turn.role === 'user' ? 'You' : 'Claude', {
        size: 11, style: 'bold',
        color: turn.role === 'user' ? [42, 93, 176] : [179, 124, 41],
        gapAfter: 6
      });

      for (const block of parseMarkdownBlocks(turn.markdown)) {
        if (block.type === 'heading') heading(block.text, block.level);
        else if (block.type === 'code') codeBlock(block.code, block.language);
        else if (block.type === 'list') list(block.items, block.ordered);
        else paragraph(stripInline(block.text));
      }
    }

    return doc.output('blob');
  }

  window.generatePdf = generatePdf;
})();
