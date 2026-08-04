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

// Splits inline text into runs of { text, bold, italic, code, link }.
function parseInlineRuns(text) {
  const runs = [];
  const re = /(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]*)\]\(([^)]+)\))|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let last = 0, match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: (match[2] || 'image').split('\u241F')[0], link: match[3] });
    else if (match[4] !== undefined) runs.push({ text: match[5] || match[6], link: match[6] });
    else if (match[8] !== undefined) runs.push({ text: match[8], bold: true, italic: true });
    else if (match[10] !== undefined) runs.push({ text: match[10], bold: true });
    else if (match[12] !== undefined) runs.push({ text: match[12], italic: true });
    else if (match[14] !== undefined) runs.push({ text: match[14], code: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

// Exposed as a global (no bundler in this extension — plain <script> tags).
window.MarkdownBlocks = { parseMarkdownBlocks, parseInlineRuns };
