// Shared test harness for docx-generator.js.
//
// Deliberately does NOT use jsdom (unlike pdf-harness.js). Investigation
// confirmed docx.umd.js is a real UMD module - its own top branch is
// `typeof exports === "object" && typeof module !== "undefined"`, and even
// on the fallback `global2.docx = {}` branch it only needs a plain object
// with `window`/`Blob`/`setTimeout`/`clearTimeout`/`process` on it. The
// previous jsdom + vm.runInContext harness hung indefinitely on
// docx.Packer.toBuffer()/toBlob() even for a trivial zero-image document;
// root cause was jsdom's own fake event loop failing to relay JSZip's async
// generation scheduling - NOT vm.runInContext itself, and NOT anything in
// this project's own code. A plain vm.createContext sandbox (no jsdom)
// avoids the whole problem and was confirmed, by generating and unzipping a
// real .docx from it, to produce byte-identical, valid output.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const LIB_DIR = path.join(__dirname, '..', '..', 'lib');

function loadWindow() {
  // atob is needed by docx.umd.js's own convertDataURIToBinary (real image
  // embedding) - without it, it falls through to a require('buffer')-based
  // Node path that doesn't work inside an isolated vm context (no `require`
  // global here, same as the browser extension itself has none). Node's
  // global atob (available since Node 16) sidesteps that entirely, and is
  // the same base64-decode a browser's own atob does.
  const sandbox = { window: {}, console, Blob: globalThis.Blob, atob: globalThis.atob, setTimeout, clearTimeout, process };
  const ctx = vm.createContext(sandbox);

  // docx.umd.js's fallback branch does `global2.docx = {}` where global2 is
  // this context's own globalThis - i.e. it lands on `sandbox`, not
  // `sandbox.window`. Re-point window.docx at it so docx-generator.js's
  // bare `docx.X` references resolve the same way they do in the real
  // extension (loaded as a sibling <script> tag, where `docx` is a bare
  // global too).
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'vendor', 'docx.umd.js'), 'utf8'), ctx);
  vm.runInContext('window.docx = docx;', ctx);

  // markdown-blocks.js sets window.MarkdownBlocks itself (parseMarkdownBlocks
  // + parseInlineRuns) - nothing extra needed here.
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'markdown-blocks.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'docx-generator.js'), 'utf8'), ctx);

  return sandbox.window;
}

/** Generates a real .docx Buffer for a single assistant turn with the given markdown. */
async function generateFor(markdown) {
  const window = loadWindow();
  const ir = {
    title: 'Test',
    url: 'https://x',
    exportedAt: new Date().toISOString(),
    turns: [{ role: 'assistant', markdown }],
  };
  const blob = await window.generateDocx(ir);
  const ab = await blob.arrayBuffer();
  return Buffer.from(ab);
}

// --- Minimal, dependency-free ZIP reader --------------------------------
// A .docx is a ZIP archive. Only what's needed to verify real generator
// output: list entry names, and read one entry's decompressed bytes.
// Reads the End Of Central Directory record from the tail of the buffer,
// walks the central directory for offsets/sizes/compression method, then
// reads each entry's local file header to find where its data actually
// starts (its extra-field length can differ from the central directory's).

function findEOCD(buf) {
  const SIG = 0x06054b50;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  throw new Error('Not a valid ZIP (.docx) file - End Of Central Directory not found');
}

function readEntries(buf) {
  const eocd = findEOCD(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Malformed central directory entry');
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('Malformed local file header for ' + entry.name);
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return raw; // stored
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`);
}

/** Lists file entry names inside a real .docx Buffer. */
function listDocxEntries(buf) {
  return readEntries(buf).map(e => e.name);
}

function findEntry(buf, name) {
  const entry = readEntries(buf).find(e => e.name === name);
  if (!entry) throw new Error(`Entry not found in .docx: ${name}`);
  return entry;
}

/** Reads one entry's content from a real .docx Buffer as a UTF-8 string (XML parts). */
function readDocxEntry(buf, name) {
  return readEntryData(buf, findEntry(buf, name)).toString('utf8');
}

/** Reads one entry's raw bytes from a real .docx Buffer (binary parts, e.g. word/media/*). */
function readDocxEntryBuffer(buf, name) {
  return readEntryData(buf, findEntry(buf, name));
}

module.exports = { loadWindow, generateFor, listDocxEntries, readDocxEntry, readDocxEntryBuffer };
