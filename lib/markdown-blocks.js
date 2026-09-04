// Minimal line-based markdown -> block parser.
// Deliberately narrow: headings, fenced code blocks, bullet/numbered lists,
// and paragraphs — the subset Turndown produces from Claude's rendered HTML.
// Kept dependency-free (Rung 2/3 of the ladder) rather than pulling in a full
// markdown AST library, since this is the only consumer of the output.

function parseMarkdownBlocks(markdown) {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // Fenced code block
    const fence = line.match(/^```(\S*)/);
    if (fence) {
      const language = fence[1] || 'text';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    // List (bullet or numbered) — consume contiguous list lines
    const listItem = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (listItem) {
      const ordered = /\d+\./.test(listItem[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(m[2].trim());
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph — consume contiguous non-blank, non-special lines
    const paraLines = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

// Turndown (lib/vendor/turndown.umd.js, the real vendored `escapes` array)
// backslash-escapes literal Markdown-special characters in plain text nodes
// so they don't get misread as syntax when this file re-parses the
// Markdown - e.g. a literal "[" in prose (an attached filename shown as
// "[photo.jpg]", or a raw pasted URL ChatGPT wraps in brackets) becomes
// "\[" in the Markdown text. Confirmed via a real generated export: those
// backslashes were never removed again, so they leaked into the final
// DOCX/PDF as literal visible backslash characters. This reverses exactly
// the non-positional escapes from that same real array (the ones that can
// appear anywhere in a text node, not just at its start, since inline runs
// here are already mid-text fragments) - applied only to plain run text,
// never to `code` runs (Turndown never escapes text inside a code node in
// the first place) or to link URLs (never escaped either).
function unescapeMarkdown(text) {
  return text
    .replace(/\\_/g, '_')
    .replace(/\\\]/g, ']')
    .replace(/\\\[/g, '[')
    .replace(/\\`/g, '`')
    .replace(/\\\*/g, '*')
    .replace(/\\\\/g, '\\');
}

// Splits inline text into runs of { text, bold, italic, code, link }.
function parseInlineRuns(text) {
  const runs = [];
  const re = /(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]*)\]\(([^)]+)\))|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  // A bold/italic match's inner text is captured as a raw string, not
  // recursively re-parsed - "**[text](url)**" (an entire bold/italic span
  // that's just a link, e.g. a cited source rendered bold) previously came
  // through as literal bracket/paren text inside the bold run, silently
  // dropping the link entirely. Confirmed via a real generated ChatGPT
  // export: three real links (each an entire **bold** span wrapping
  // nothing but a link) were completely absent from the output - the <a
  // href> itself is correctly extracted upstream and Turndown converts it
  // to "**[text](url)**" correctly, but this function then lost the link
  // going from markdown text to runs. This only handles the case actually
  // observed - the ENTIRE bold/italic span being a single link, not
  // arbitrary nesting - which is deliberately narrower than full recursive
  // inline parsing (this file's own stated design principle at the top).
  const linkOnly = /^\[([^\]]*)\]\(([^)]+)\)$/;
  let last = 0, match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: (match[2] || 'image').split('\u241F')[0], link: match[3] });
    else if (match[4] !== undefined) runs.push({ text: match[5] || match[6], link: match[6] });
    else if (match[8] !== undefined) {
      const inner = linkOnly.exec(match[8]);
      runs.push(inner ? { text: inner[1] || inner[2], link: inner[2], bold: true, italic: true } : { text: match[8], bold: true, italic: true });
    }
    else if (match[10] !== undefined) {
      const inner = linkOnly.exec(match[10]);
      runs.push(inner ? { text: inner[1] || inner[2], link: inner[2], bold: true } : { text: match[10], bold: true });
    }
    else if (match[12] !== undefined) {
      const inner = linkOnly.exec(match[12]);
      runs.push(inner ? { text: inner[1] || inner[2], link: inner[2], italic: true } : { text: match[12], italic: true });
    }
    else if (match[14] !== undefined) runs.push({ text: match[14], code: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  runs.forEach(r => { if (!r.code) r.text = unescapeMarkdown(r.text); });
  return runs.length ? runs : [{ text }];
}

// Exposed as a global (no bundler in this extension — plain <script> tags).
window.MarkdownBlocks = { parseMarkdownBlocks, parseInlineRuns };
