// Builds a .docx Blob from the normalized conversation IR.
// Uses the locally bundled `docx` library (lib/vendor/docx.umd.js) — no network calls.

(function () {
  const { parseMarkdownBlocks, parseInlineRuns } = window.MarkdownBlocks;

  function runsFromText(text, extra) {
    return parseInlineRuns(text).map(r => new docx.TextRun(Object.assign({
      text: r.text,
      bold: !!r.bold,
      italics: !!r.italic,
      font: r.code ? 'Consolas' : undefined,
      shading: r.code ? { fill: 'EFEFEF' } : undefined
    }, extra)));
  }

  function paragraphsFromBlocks(blocks) {
    const out = [];
    for (const block of blocks) {
      if (block.type === 'heading') {
        out.push(new docx.Paragraph({
          children: runsFromText(block.text),
          heading: block.level === 1 ? docx.HeadingLevel.HEADING_2 : docx.HeadingLevel.HEADING_3,
          spacing: { before: 160, after: 80 }
        }));
      } else if (block.type === 'code') {
        for (const line of block.code.split('\n')) {
          out.push(new docx.Paragraph({
            children: [new docx.TextRun({ text: line.length ? line : ' ', font: 'Consolas', size: 19 })],
            shading: { fill: 'F3F3F3' },
            spacing: { after: 0 }
          }));
        }
        out.push(new docx.Paragraph({ text: '', spacing: { after: 120 } }));
      } else if (block.type === 'list') {
        block.items.forEach((item, idx) => {
          const prefix = block.ordered ? `${idx + 1}. ` : undefined;
          const children = prefix ? [new docx.TextRun({ text: prefix })].concat(runsFromText(item)) : runsFromText(item);
          out.push(new docx.Paragraph({
            children,
            bullet: block.ordered ? undefined : { level: 0 },
            indent: { left: 360 },
            spacing: { after: 60 }
          }));
        });
        out.push(new docx.Paragraph({ text: '', spacing: { after: 60 } }));
      } else {
        out.push(new docx.Paragraph({
          children: runsFromText(block.text),
          spacing: { after: 120 }
        }));
      }
    }
    return out;
  }

  async function generateDocx(ir) {
    const children = [
      new docx.Paragraph({
        text: ir.title,
        heading: docx.HeadingLevel.HEADING_1,
        spacing: { after: 200 }
      }),
      new docx.Paragraph({
        children: [new docx.TextRun({ text: `Exported ${new Date(ir.exportedAt).toLocaleString()} from ${ir.url}`, italics: true, color: '888888', size: 18 })],
        spacing: { after: 300 }
      })
    ];

    for (const turn of ir.turns) {
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({ text: turn.role === 'user' ? 'You' : 'Claude', bold: true, color: turn.role === 'user' ? '2A5DB0' : 'B37C29' })],
        spacing: { before: 240, after: 100 },
        border: { bottom: { color: 'DDDDDD', space: 4, style: docx.BorderStyle.SINGLE, size: 4 } }
      }));
      children.push(...paragraphsFromBlocks(parseMarkdownBlocks(turn.markdown)));
    }

    const doc = new docx.Document({ sections: [{ children }] });
    return docx.Packer.toBlob(doc);
  }

  window.generateDocx = generateDocx;
})();
