// Builds a .pdf Blob from the normalized conversation IR.
// Uses the locally bundled jsPDF library (lib/vendor/jspdf.umd.min.js) — no network calls.
//
// jsPDF's built-in fonts (helvetica/times/courier) only support WinAnsi
// encoding. Any character outside that (arrows, checkmarks, emoji, Indian
// rupee, Devanagari, etc.) corrupted the ENTIRE paragraph it was in. Real
// TTF fonts are embedded (see lib/vendor/fonts-base64.js) to fix this.
//
// Known limitation: jsPDF has no OpenType text-shaping engine (no HarfBuzz
// equivalent). Devanagari glyphs render individually and correctly, but
// WITHOUT proper conjunct-formation/vowel-reordering shaping — this is a
// real limitation of jsPDF itself, not something fixable at this layer.
// Latin text, symbols, arrows, and emoji-as-glyphs (no complex shaping
// needed) render correctly.

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

  // Font selection by REAL glyph coverage (window.PDF_FONT_COVERAGE, built
  // from each vendored font's actual cmap - see lib/vendor/fonts-base64.js).
  // Earlier hand-picked Unicode-block guesses turned out wrong in practice
  // (Noto Sans, as a typeface, doesn't actually contain arrows or
  // checkmarks - those live in separate "Noto Sans Symbols" companion
  // fonts) - so this looks up real coverage instead of assuming block
  // boundaries. Devanagari is still special-cased since a run of Devanagari
  // text should stay in that font even where a stray codepoint (e.g. ZWJ)
  // might also technically appear in another font's coverage table.
  const DEVANAGARI_RANGES = [[0x0900, 0x097F], [0xA8E0, 0xA8FF], [0x200C, 0x200D]];
  function inRanges(cp, ranges) {
    for (const [lo, hi] of ranges) { if (cp >= lo && cp <= hi) return true; }
    return false;
  }

  function fontEntryFor(codePoint, preferBold, preferItalic) {
    if (inRanges(codePoint, DEVANAGARI_RANGES)) {
      const entry = (window.PDF_FONT_COVERAGE || []).find(e => e.key === 'notoSansDevanagari');
      if (entry) return entry;
    }
    const coverage = window.PDF_FONT_COVERAGE || [];
    // Prefer the requested weight/style's own font first if it covers the
    // character (keeps bold headings looking bold), then fall back through
    // the rest of the priority list.
    if (preferBold) {
      const bold = coverage.find(e => e.key === 'notoSansBold');
      if (bold && inRanges(codePoint, bold.ranges)) return bold;
    }
    if (preferItalic) {
      const italic = coverage.find(e => e.key === 'notoSansItalic');
      if (italic && inRanges(codePoint, italic.ranges)) return italic;
    }
    for (const entry of coverage) {
      if (inRanges(codePoint, entry.ranges)) return entry;
    }
    return null; // truly no glyph anywhere in our vendored fonts
  }

  // Splits a string into runs of consecutive characters that resolve to the
  // same font entry. Array.from() (not a plain for-loop) so surrogate-pair
  // codepoints like emoji outside the BMP are iterated as single characters.
  function splitRuns(text, style) {
    const runs = [];
    let current = null;
    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0);
      const entry = fontEntryFor(cp, style === 'bold', style === 'italic');
      const key = entry ? entry.key : 'notoSansRegular'; // .notdef box rather than dropping the char
      if (current && current.key === key) current.text += ch;
      else { if (current) runs.push(current); current = { key, entry, text: ch }; }
    }
    if (current) runs.push(current);
    return runs;
  }


  async function generatePdf(ir) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    let y = MARGIN;

    const FONTS = window.PDF_FONTS;
    const COVERAGE = window.PDF_FONT_COVERAGE;
    const HAS_UNICODE_FONTS = !!(FONTS && COVERAGE);
    if (HAS_UNICODE_FONTS) {
      for (const entry of COVERAGE) {
        doc.addFileToVFS(`${entry.key}.ttf`, FONTS[entry.key]);
        doc.addFont(`${entry.key}.ttf`, entry.family, entry.style);
      }
    }
    // If fonts failed to load for any reason, fall back to the old
    // WinAnsi-only helvetica behavior rather than throwing.
    function setRunFont(run, style) {
      if (!HAS_UNICODE_FONTS || !run.entry) {
        doc.setFont('helvetica', style === 'bold' ? 'bold' : (style === 'italic' ? 'italic' : 'normal'));
      } else {
        doc.setFont(run.entry.family, run.entry.style);
      }
    }

    function ensureSpace(height) {
      if (y + height > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
    }

    // Mixed-font word-wrap: wraps at word boundaries (never mid-word) while
    // measuring and drawing each run (from splitRuns, already resolved to
    // its real font) within a word in its own font. Replaces jsPDF's
    // splitTextToSize()+text(), which only ever measured a single font.
    function layoutText(text, style, fontSize, maxWidth) {
      doc.setFontSize(fontSize);
      const measure = (run) => { setRunFont(run, style); return doc.getTextWidth(run.text); };
      const words = text.split(/(\s+)/).filter(w => w.length);
      const lines = [];
      let line = [];
      let lineWidth = 0;
      for (const word of words) {
        const isSpace = /^\s+$/.test(word);
        const runs = splitRuns(word, style).map(r => ({ ...r, width: measure(r) }));
        const wordWidth = runs.reduce((s, r) => s + r.width, 0);
        if (!isSpace && lineWidth + wordWidth > maxWidth && line.length > 0) {
          lines.push(line);
          line = [];
          lineWidth = 0;
        }
        if (isSpace && line.length === 0) continue; // no leading space on a wrapped line
        line.push(...runs);
        lineWidth += wordWidth;
      }
      if (line.length) lines.push(line);
      return lines;
    }

    function drawLines(lines, style, fontSize, color, xStart) {
      doc.setFontSize(fontSize);
      doc.setTextColor(...color);
      for (const line of lines) {
        ensureSpace(LINE_H);
        let x = xStart;
        for (const run of line) {
          setRunFont(run, style);
          doc.text(run.text, x, y);
          x += run.width;
        }
        y += LINE_H;
      }
    }

    function paragraph(text, { size = 10.5, style = 'normal', color = [30, 30, 30], gapAfter = 8 } = {}) {
      const lines = layoutText(text, style, size, MAX_W);
      drawLines(lines, style, size, color, MARGIN);
      y += gapAfter;
    }

    function codeBlock(code, language) {
      const ROW = 12;
      doc.setFont('courier', 'normal'); doc.setFontSize(9);
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
      items.forEach((item, idx) => {
        const prefix = ordered ? `${idx + 1}. ` : '\u2022  ';
        const lines = layoutText(item, 'normal', 10.5, MAX_W - 16);
        lines.forEach((line, li) => {
          ensureSpace(LINE_H);
          let x = MARGIN + 4;
          if (li === 0) {
            doc.setFont(HAS_UNICODE_FONTS ? 'NotoSans' : 'helvetica', 'normal');
            doc.setFontSize(10.5);
            doc.text(prefix, x, y);
            x += doc.getTextWidth(prefix);
          }
          doc.setFontSize(10.5); doc.setTextColor(30, 30, 30);
          for (const run of line) {
            setRunFont(run, 'normal');
            doc.text(run.text, x, y);
            x += run.width;
          }
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
