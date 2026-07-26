// Cross-platform test runner. `node --test tests/` (directory form) proved
// unreliable, and relying on shell glob expansion (tests/*.test.js) would
// behave differently between bash and PowerShell. This resolves the file
// list via fs directly instead, so `npm test` works the same everywhere.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(dir, f));

if (files.length === 0) {
  console.error('No *.test.js files found in', dir);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
