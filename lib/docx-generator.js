// Builds a .docx Blob from the normalized conversation IR.
// Uses the locally bundled `docx` library (lib/vendor/docx.umd.js) — no network calls.

(function () {
  const { parseMarkdownBlocks, parseInlineRuns } = window.MarkdownBlocks;

  function runsFromText(text, extra) {
    return parseInlineRuns(text).map(r => {
      const run = new docx.TextRun(Object.assign({
        text: r.text,
        bold: !!r.bold,
        italics: !!r.italic,
        font: r.code ? 'Consolas' : undefined,
        shading: r.code ? { fill: 'EFEFEF' } : undefined,
        style: r.link ? 'Hyperlink' : undefined
      }, extra));
      return r.link ? new docx.ExternalHyperlink({ children: [run], link: r.link }) : run;
    });
  }

  const MAX_IMAGE_W_PX = 600; // ~6.25in at 96dpi, fits within a standard docx page's content width
  const DIM_MARKER = '\u241F'; // matches content.js embedImages() - separates alt text from "WxH"

  // Dimensions are encoded into the alt text by content.js (captured from
  // the live DOM's naturalWidth/naturalHeight before this ever runs), not
  // decoded here. Decoding the image again in this generator would need a
  // real <img> load-and-wait round trip, which is slow, and - critically -
  // doesn't work in jsdom at all without the native `canvas` package
  // (verified: onload/onerror never fire for a data URI there), making it
  // untestable. Reusing the already-known real dimensions avoids both problems.
  // ImageRun hard-codes every embedded image's media filename as
  // <randomId>.png (confirmed in lib/vendor/docx.umd.js's ImageRun
  // constructor - there's no extension/type option at all), regardless of
  // the image's real format. A mismatched extension mislabels the OOXML
  // content-type Word uses to decide how to decode the bytes (e.g. real
  // JPEG or WEBP bytes declared as image/png in [Content_Types].xml) -
  // confirmed via a real exported .docx to actually break rendering, not
  // just look wrong. WEBP needed a matching one-line addition to the
  // vendored ContentTypes class (image/png's sibling Default entries)
  // since Word also refuses to open a part whose extension has no
  // declared content-type at all. AVIF has no realistic Word support
  // regardless of correct labeling, so it - and anything else unknown -
  // falls back to the same text placeholder unparseable-dimensions already
  // uses, rather than embedding bytes Word can't decode either way.
  const SUPPORTED_IMAGE_EXTENSIONS = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp', gif: 'gif' };

  function imageParagraph(dataUrl, altWithDims) {
    const parts = altWithDims.split(DIM_MARKER);
    const alt = parts[0];
    const dimMatch = parts[1] && parts[1].match(/^(\d+)x(\d+)$/);
    const mimeMatch = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
    const extension = mimeMatch && SUPPORTED_IMAGE_EXTENSIONS[mimeMatch[1].toLowerCase()];
    if (!dimMatch || !extension) {
      const reason = !dimMatch
        ? 'could not be rendered'
        : `format not supported in Word (${mimeMatch ? mimeMatch[1] : 'unknown'})`;
      return new docx.Paragraph({
        children: [new docx.TextRun({ text: `[Image: ${alt || 'image'} \u2014 ${reason}]`, italics: true, color: '888888' })],
        spacing: { after: 120 }
      });
    }
    let w = Number(dimMatch[1]), h = Number(dimMatch[2]);
    if (w > MAX_IMAGE_W_PX) { h = Math.round(h * (MAX_IMAGE_W_PX / w)); w = MAX_IMAGE_W_PX; }
    // extension is now passed directly into the constructor - see the
    // vendored ImageRun's own comment for why a post-construction .key
    // mutation (an earlier version of this fix) silently broke every
    // image's relationship reference, not just non-PNG ones.
    const run = new docx.ImageRun({
      data: dataUrl,
      transformation: { width: w, height: h },
      extension
    });
    return new docx.Paragraph({
      children: [run],
      spacing: { after: 120 }
    });
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
        // A block that's entirely a single image (from an embedded chat
        // screenshot/upload, see content.js embedImages()) gets a real
        // docx ImageRun instead of the usual link-text run - that fallback
        // is still correct for real links and images that failed to embed.
        const imgOnly = block.text.trim().match(/^!\[([^\]]*)\]\((data:[^)]+)\)$/);
        if (imgOnly) {
          out.push(imageParagraph(imgOnly[2], imgOnly[1]));
        } else {
          out.push(new docx.Paragraph({
            children: runsFromText(block.text),
            spacing: { after: 120 }
          }));
        }
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
        children: [new docx.TextRun({ text: turn.role === 'user' ? 'You' : (ir.assistantName || 'Claude'), bold: true, color: turn.role === 'user' ? '2A5DB0' : 'B37C29' })],
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