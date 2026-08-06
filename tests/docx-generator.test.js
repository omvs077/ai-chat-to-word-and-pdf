const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateFor, listDocxEntries, readDocxEntry, readDocxEntryBuffer } = require('./helpers/docx-harness');

// A 1x1 red-pixel PNG, the same minimal fixture used elsewhere in this
// project for image tests - real bytes, not a stub.
const RED_PIXEL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('generates a real, valid .docx zip with the expected core parts', async () => {
  const buf = await generateFor('Hello world.');
  const entries = listDocxEntries(buf);
  assert.ok(entries.includes('word/document.xml'), 'must contain the main document part');
  assert.ok(entries.includes('[Content_Types].xml'), 'must contain the content-types manifest');
  assert.ok(entries.includes('_rels/.rels'), 'must contain the package relationships part');
});

test('plain paragraph text round-trips into document.xml', async () => {
  const buf = await generateFor('This exact sentence must appear in the output.');
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('This exact sentence must appear in the output.'));
});

test('heading text round-trips with a real heading style applied', async () => {
  const buf = await generateFor('## A Real Heading');
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('A Real Heading'));
  assert.ok(/Heading[23]/.test(xml), 'must use a real Word heading style, not plain bold text');
});

test('bullet and ordered list items round-trip with real list formatting', async () => {
  const buf = await generateFor('- First bullet\n- Second bullet\n\n1. First numbered\n2. Second numbered');
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('First bullet') && xml.includes('Second bullet'));
  assert.ok(xml.includes('First numbered') && xml.includes('Second numbered'));
  assert.ok(xml.includes('numbering.xml'.split('.')[0]) || listDocxEntries(buf).includes('word/numbering.xml'),
    'bullet lists must reference the numbering part, not render as plain paragraphs');
});

test('a fenced code block round-trips with monospace styling', async () => {
  const buf = await generateFor('```js\nconsole.log("real code block");\n```');
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('console.log(&quot;real code block&quot;)') || xml.includes('console.log("real code block")'),
    'code content must survive (XML-escaped quotes are fine)');
  assert.ok(xml.includes('Consolas'), 'code blocks must use a monospace font');
});

test('a markdown link becomes a real ExternalHyperlink relationship, not flattened text', async () => {
  const buf = await generateFor('Check out [Anthropic](https://www.anthropic.com/) for more.');
  const xml = readDocxEntry(buf, 'word/document.xml');
  const rels = readDocxEntry(buf, 'word/_rels/document.xml.rels');
  assert.ok(xml.includes('Anthropic'), 'the visible link label must render');
  assert.ok(!xml.includes('(https://www.anthropic.com/)'), 'must NOT flatten to plain "label (url)" text');
  assert.ok(xml.includes('hyperlink'), 'document.xml must reference a real hyperlink relationship');
  assert.ok(rels.includes('anthropic.com'), 'the relationships part must contain the real target URL');
});

test('an embedded image produces a real, byte-identical media file', async () => {
  const dataUrl = `data:image/png;base64,${RED_PIXEL_PNG_B64}`;
  const alt = 'a red pixel\u241F50x50'; // \u241F-delimited dims, matches content.js's real encoding
  const buf = await generateFor(`![${alt}](${dataUrl})`);
  const entries = listDocxEntries(buf);
  const mediaName = entries.find(e => e.startsWith('word/media/') && e.endsWith('.png'));
  assert.ok(mediaName, 'must contain a real PNG under word/media/');

  const extracted = readDocxEntryBuffer(buf, mediaName);
  const original = Buffer.from(RED_PIXEL_PNG_B64, 'base64');
  assert.equal(
    crypto.createHash('md5').update(extracted).digest('hex'),
    crypto.createHash('md5').update(original).digest('hex'),
    'embedded image bytes must be byte-identical to the source image, not re-encoded or corrupted'
  );

  const rels = readDocxEntry(buf, 'word/_rels/document.xml.rels');
  assert.ok(rels.includes(mediaName.replace('word/', '')), 'the media file must be referenced by a real relationship');
});

test('an image with unparseable dimensions falls back to a text placeholder instead of throwing', async () => {
  const dataUrl = `data:image/png;base64,${RED_PIXEL_PNG_B64}`;
  const buf = await generateFor(`![missing dims](${dataUrl})`); // no \u241F WxH marker
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('could not be rendered'), 'must fall back to a visible placeholder, not crash or silently drop it');
  const entries = listDocxEntries(buf);
  assert.ok(!entries.some(e => e.startsWith('word/media/')), 'must not attempt to embed an image it could not size');
});

test('the real conversation title and export line round-trip correctly', async () => {
  const window = require('./helpers/docx-harness').loadWindow();
  const ir = {
    title: 'My Real Chat Title',
    url: 'https://claude.ai/chat/abc123',
    exportedAt: new Date('2026-01-15T10:30:00Z').toISOString(),
    turns: [{ role: 'user', markdown: 'A question.' }, { role: 'assistant', markdown: 'An answer.' }],
  };
  const blob = await window.generateDocx(ir);
  const buf = Buffer.from(await blob.arrayBuffer());
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('My Real Chat Title'));
  assert.ok(xml.includes('claude.ai/chat/abc123'));
  assert.ok(xml.includes('You') && xml.includes('Claude'), 'both role labels must appear for a real two-turn conversation');
});
