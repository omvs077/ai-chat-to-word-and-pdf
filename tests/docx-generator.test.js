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

test('assistant role label uses ir.assistantName, not a hard-coded "Claude" (regression)', async () => {
  // Real bug found on the first real ChatGPT export: the assistant role
  // label was hard-coded as literally "Claude" regardless of which
  // adapter produced the IR, so a genuine ChatGPT conversation still
  // showed "Claude" as the label for every assistant turn.
  const window = require('./helpers/docx-harness').loadWindow();
  const ir = {
    title: 'A ChatGPT Chat',
    url: 'https://chatgpt.com/c/abc123',
    exportedAt: new Date('2026-01-15T10:30:00Z').toISOString(),
    assistantName: 'ChatGPT',
    turns: [{ role: 'user', markdown: 'A question.' }, { role: 'assistant', markdown: 'An answer.' }],
  };
  const blob = await window.generateDocx(ir);
  const buf = Buffer.from(await blob.arrayBuffer());
  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('ChatGPT'), 'the real assistant name must appear');
  assert.ok(!xml.includes('>Claude<'), 'the hard-coded Claude label must not leak into a ChatGPT export');
});

// Real bugs found by generating and inspecting an actual export (a chat
// with real web-search-sourced images): ImageRun hard-codes every embedded
// image's media filename as <id>.png regardless of real format, which
// mislabels the OOXML content-type Word uses to decode the bytes - real
// JPEG/WEBP bytes declared as image/png broke rendering, not just cosmetics.
// Fixtures below are small but genuinely valid WEBP/JPEG files (real magic
// bytes, real decodable structure), not fabricated garbage.
const REAL_TINY_WEBP_B64 = 'UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoCAAIAAUAmJaACdLoABDAAAP7vUS/xbSOhTIf/cHH/YOP+wcfumAAA';
const REAL_TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnqKKK8k/Qz//Z';

test('a real WEBP image gets the correct .webp filename and a matching Content-Type entry', async () => {
  const dataUrl = `data:image/webp;base64,${REAL_TINY_WEBP_B64}`;
  const buf = await generateFor(`![a webp image\u241F50x50](${dataUrl})`);
  const entries = listDocxEntries(buf);
  const mediaName = entries.find(e => e.startsWith('word/media/') && e.endsWith('.webp'));
  assert.ok(mediaName, 'must be saved with a real .webp extension, not the library default .png');

  const extracted = readDocxEntryBuffer(buf, mediaName);
  const original = Buffer.from(REAL_TINY_WEBP_B64, 'base64');
  assert.equal(
    crypto.createHash('md5').update(extracted).digest('hex'),
    crypto.createHash('md5').update(original).digest('hex'),
    'embedded WEBP bytes must be byte-identical to the source, not re-encoded'
  );

  const contentTypes = readDocxEntry(buf, '[Content_Types].xml');
  assert.ok(contentTypes.includes('image/webp'),
    'Content_Types.xml must declare image/webp - otherwise Word has no way to know how to decode the part');

  const xml = readDocxEntry(buf, 'word/document.xml');
  const rels = readDocxEntry(buf, 'word/_rels/document.xml.rels');
  const blipRef = xml.match(/r:embed="([^"]+)"/)[1];
  assert.ok(/^rId\d+$/.test(blipRef), 'must be a real relationship ID, not an unresolved placeholder');
  assert.ok(rels.includes(`Id="${blipRef}"`), 'the reference must resolve to an actually-declared relationship');
});

test('a real JPEG image gets a correct .jpg filename (already-supported content-type, rename-only fix)', async () => {
  const dataUrl = `data:image/jpeg;base64,${REAL_TINY_JPEG_B64}`;
  const buf = await generateFor(`![a jpeg image\u241F50x50](${dataUrl})`);
  const entries = listDocxEntries(buf);
  const mediaName = entries.find(e => e.startsWith('word/media/') && (e.endsWith('.jpg') || e.endsWith('.jpeg')));
  assert.ok(mediaName, 'must be saved with a real .jpg/.jpeg extension, not the library default .png');

  const extracted = readDocxEntryBuffer(buf, mediaName);
  const original = Buffer.from(REAL_TINY_JPEG_B64, 'base64');
  assert.equal(
    crypto.createHash('md5').update(extracted).digest('hex'),
    crypto.createHash('md5').update(original).digest('hex'),
    'embedded JPEG bytes must be byte-identical to the source'
  );

  const xml = readDocxEntry(buf, 'word/document.xml');
  const rels = readDocxEntry(buf, 'word/_rels/document.xml.rels');
  const blipRef = xml.match(/r:embed="([^"]+)"/)[1];
  assert.ok(/^rId\d+$/.test(blipRef), 'must be a real relationship ID, not an unresolved placeholder');
  assert.ok(rels.includes(`Id="${blipRef}"`), 'the reference must resolve to an actually-declared relationship');
});

test('an AVIF image (no realistic Word support) falls back to a text placeholder instead of a broken embed', async () => {
  // Word cannot render AVIF regardless of correct labeling - the correct
  // behavior is the same readable placeholder unparseable-dimensions
  // already uses, not an embed that will never actually decode.
  const dataUrl = 'data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZg==';
  const buf = await generateFor(`![an avif image\u241F50x50](${dataUrl})`);
  const entries = listDocxEntries(buf);
  assert.ok(!entries.some(e => e.startsWith('word/media/')), 'must not attempt to embed a format Word cannot decode');

  const xml = readDocxEntry(buf, 'word/document.xml');
  assert.ok(xml.includes('format not supported in Word'), 'must fall back to a visible, informative placeholder');
});

// Real regression: a real multi-image export from an actual conversation
// (2 WEBP + 7 JPEG) had every single image reference broken in Word, not
// just non-PNG ones - confirmed via direct byte inspection of that real
// .docx. Root cause: ImageRun's Drawing/Graphic tree bakes a placeholder
// "rId{<filename>}" into the XML at CONSTRUCTION time using
// this.imageData.fileName as it exists right then; a later find-and-replace
// pass resolves that placeholder by matching against whatever key
// Media.addImage() registers the file under in prepForXml(). An earlier fix
// attempt mutated .key/.imageData.fileName AFTER construction (to correct
// the extension) - which desynced those two reads and left the raw,
// unresolved "rId{name.png}" placeholder sitting in the final XML for every
// image. The single-image tests above never caught this because they never
// checked that r:embed references actually RESOLVE to a declared
// relationship - only that files existed with the right name/content-type.
// This test specifically closes that gap: multi-image, mixed formats, and
// an explicit resolution check.
test('every image reference in a multi-image, mixed-format document resolves to a real relationship (regression)', async () => {
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const markdown = [
    'A paragraph before any images.',
    `![a webp image\u241F50x50](data:image/webp;base64,${REAL_TINY_WEBP_B64})`,
    'Text between the first and second image.',
    `![a jpeg image\u241F50x50](data:image/jpeg;base64,${REAL_TINY_JPEG_B64})`,
    'Text between the second and third image.',
    `![a png image\u241F50x50](data:image/png;base64,${pngB64})`,
  ].join('\n\n');

  const buf = await generateFor(markdown);
  const xml = readDocxEntry(buf, 'word/document.xml');
  const rels = readDocxEntry(buf, 'word/_rels/document.xml.rels');

  assert.ok(!/rId\{/.test(xml), 'no raw unresolved "rId{...}" placeholder text may survive into the final document.xml');

  const blipRefs = [...xml.matchAll(/r:embed="([^"]+)"/g)].map(m => m[1]);
  assert.equal(blipRefs.length, 3, 'all three image references must be present');
  assert.ok(blipRefs.every(r => /^rId\d+$/.test(r)), 'every reference must be a real sequential rId, not a leftover placeholder');

  const relIds = [...rels.matchAll(/Id="([^"]+)"/g)].map(m => m[1]);
  assert.ok(blipRefs.every(r => relIds.includes(r)), 'every image reference must resolve to an actually-declared relationship');

  // Also confirm each rId maps to a real, existing media file - not just
  // any declared relationship (a subtly weaker check than the one above).
  const relMap = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]));
  const entries = listDocxEntries(buf);
  for (const rid of blipRefs) {
    const target = relMap.get(rid);
    assert.ok(target, `${rid} must map to a real target`);
    assert.ok(entries.includes('word/' + target), `${rid}'s target (${target}) must actually exist in the zip`);
  }
});
