'use strict';
/**
 * Syncs the root Prisma client to the server's isolated node_modules after
 * `prisma generate`. The server package has its own node_modules, so the root
 * generate doesn't update it. This script copies index.js and patches the two
 * baked relative paths that differ because the server client sits one directory
 * deeper than the root client.
 *
 * Run via: npm run prisma:generate  (chains automatically)
 * Or manually: node scripts/sync-server-prisma.cjs
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'node_modules', '.prisma', 'client', 'index.js');
const DST  = path.join(ROOT, 'server', 'node_modules', '.prisma', 'client', 'index.js');

if (!fs.existsSync(SRC)) {
  console.error('[sync-server-prisma] Root client not found at', SRC);
  process.exit(1);
}

const dstDir = path.dirname(DST);
if (!fs.existsSync(dstDir)) {
  console.error('[sync-server-prisma] Server client directory missing:', dstDir);
  console.error('  Run: npm install inside server/ first.');
  process.exit(1);
}

let content = fs.readFileSync(SRC, 'utf8');

// The root client is 3 levels above the project root; the server client is 4
// levels deep, so every "../../../" path must become "../../../../".
content = content
  .replace('"schemaEnvPath": "../../../.env"',  '"schemaEnvPath": "../../../../.env"')
  .replace('"relativePath": "../../../prisma"', '"relativePath": "../../../../prisma"');

// Safety: if either pattern is still present the replace silently did nothing
// (e.g. Prisma changed its generated format). Abort rather than ship a broken client.
if (content.includes('"../../../.env"') || content.includes('"../../../prisma"')) {
  console.error(
    '[sync-server-prisma] Path patch failed — one or both patterns were not found in index.js.\n' +
    '  The Prisma-generated format may have changed. Update the replacements in this script.'
  );
  process.exit(1);
}

fs.writeFileSync(DST, content, 'utf8');

const bytes = Buffer.byteLength(content);
console.log(`[sync-server-prisma] OK — server Prisma client synced (${(bytes / 1024).toFixed(0)} KB).`);
