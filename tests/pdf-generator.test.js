const test = require('node:test');
const assert = require('node:assert/strict');
const pdfParse = require('pdf-parse');
const { generateFor } = require('./helpers/pdf-harness');

// jsPDF's built-in fonts only support WinAnsi encoding. Before the fix, any
// character outside that corrupted the ENTIRE paragraph it was in - not
// just the one character - producing mojibake like "Ø=Ü" or interleaved
// null bytes in extracted text. This is the corruption signature we check
// for; it should never appear again for any of these real-world characters.
function assertClean(text) {
  assert.equal(text.includes('Ø=Ü'), false, 'must not contain the WinAnsi-corruption mojibake signature');
  assert.equal(text.includes('\u0000'), false, 'must not contain interleaved null bytes (corrupted 2-byte encoding)');
}

test('arrow (U+2192) does not corrupt the paragraph', async () => {
  const buf = await generateFor('Header \u2192 Subheader \u2192 Title.');
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('Header'), 'surrounding text must survive');
});

test('checkmark (U+2705) does not corrupt the paragraph', async () => {
  const buf = await generateFor('Progress: \u2705 Color system done.');
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('Color system done'));
});

test('Indian rupee sign (U+20B9) does not corrupt the paragraph', async () => {
  const buf = await generateFor('Cost is \u20B912,34,567 for this item.');
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('12,34,567'));
});

test('Devanagari text does not corrupt the paragraph (glyphs render, shaping is a known jsPDF limitation)', async () => {
  const buf = await generateFor('Poppins pairs Latin with \u0928\u092e\u0938\u094d\u0924\u0947 cleanly.');
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('Poppins'));
});

test('paperclip emoji (surrogate pair, U+1F4CE) does not corrupt the paragraph', async () => {
  const buf = await generateFor('\uD83D\uDCCE Artifact: tokens.json \u2014 open to view.');
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('Artifact'));
});

test('real-world regression: rupee sign inside a code block (the exact line that broke a real export)', async () => {
  const code = '```kotlin\n' +
    'private val amountRegex = Regex("""(?i)(?:rs\\\\.?|inr| \u20B9)\\\\s*([0-9,]+)""")\n' +
    '```';
  const buf = await generateFor(code);
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('amountRegex'), 'surrounding code must survive');
  assert.ok(text.includes('0-9'), 'code after the rupee sign must survive, not just before it');
});

test('plain ASCII and common WinAnsi punctuation still render normally (no regression)', async () => {
  const buf = await generateFor('Plain text with an em-dash \u2014 and a bullet \u2022 here.');
  const { text } = await pdfParse(buf);
  assertClean(text);
  assert.ok(text.includes('Plain text'));
});

test('long code block still spans a page break correctly (no regression from the font changes)', async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `console.log("line ${i} of a long script");`);
  const code = '```js\n' + lines.join('\n') + '\n```';
  const buf = await generateFor(code);
  const { text, numpages } = await pdfParse(buf);
  assert.ok(numpages >= 2, 'a long enough code block must actually span multiple pages');
  assertClean(text);
  assert.ok(text.includes('line 0 of'), 'first line must survive');
  assert.ok(text.includes('line 79 of'), 'last line (after the page break) must survive unclipped');
});
