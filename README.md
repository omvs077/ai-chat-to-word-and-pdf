# Ai chat to word & pdf

A Chrome/Edge/Brave (Manifest V3) extension that exports your Claude.ai conversations to **Word (.docx)** or **PDF**, entirely on your own device.

No accounts, no API keys, no servers. The extraction only runs when you click **Export**, and the document is built locally in the popup — nothing about your conversation is ever sent anywhere.

---

## Features

- **One-click export** of the current Claude.ai conversation to `.docx` or `.pdf`
- Preserves headings, bullet/numbered lists, and multi-line code blocks
- Distinct styling for your messages vs. Claude's replies
- Works entirely offline after install — no network calls, no telemetry
- Minimal permissions: only reads the active tab, and only when you click Export

## Install (unpacked / developer mode)

1. Download or clone this repo.
2. Open `chrome://extensions` (or the equivalent in Edge/Brave/Opera/Vivaldi).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open a conversation on [claude.ai](https://claude.ai), click the extension icon, choose a format, and click **Export chat**.

## How it works

```
Popup (popup.js)
  → chrome.scripting.executeScript(content/content.js)   [only on click]
  → content.js scrapes the DOM into a JSON conversation IR
  → Turndown converts each turn's HTML to Markdown
  → docx-generator.js / pdf-generator.js build the file locally
  → a Blob download is triggered from the popup
```

- `content/content.js` — platform adapter for claude.ai. Injected on demand, never runs passively.
- `lib/markdown-blocks.js` — tiny dependency-free Markdown → block parser shared by both generators.
- `lib/docx-generator.js` — builds the `.docx` using the bundled [`docx`](https://www.npmjs.com/package/docx) library.
- `lib/pdf-generator.js` — builds the `.pdf` using the bundled [`jsPDF`](https://www.npmjs.com/package/jspdf) library.
- `lib/vendor/` — locally bundled third-party libraries (`docx`, `jsPDF`, `turndown`). No CDN or runtime fetches; required by the extension's Content Security Policy and by design.

## Privacy & permissions

- **Permissions requested:** `activeTab`, `scripting`. No `host_permissions`, no background service worker, no `downloads` permission (files are saved via a plain in-popup anchor download).
- **Data collection:** none. Extraction only happens when you click Export, only on the page you're currently viewing, and the resulting file never leaves your browser.

## Known limitations

- Currently supports **claude.ai only**.
- DOM selectors are based on Claude's current UI (`data-testid` attributes) and may need updating if Claude changes its markup — see `content/content.js`.
- PDF output uses plain text styling (no inline bold/italic) to keep layout simple and reliable; the `.docx` output preserves inline formatting.

## Development

No build step — all files are plain JS/HTML/CSS loaded directly by the browser. To update a vendored library, download its UMD/browser build and replace the corresponding file in `lib/vendor/`.

## License

Add a license of your choice before publishing (e.g. MIT).
