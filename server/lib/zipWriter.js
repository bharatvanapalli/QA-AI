'use strict';

/**
 * Zero-dependency ZIP writer.
 *
 * QAAI used to lazy-load `archiver` for the Output Files download, but that
 * dependency was never installed — so the endpoint returned 501 and the ZIP
 * download silently never worked. The generated workspaces are small text-file
 * projects, so we don't need a streaming archive library: Node's built-in
 * `zlib` gives us DEFLATE, and the ZIP container format is a handful of binary
 * records. This module builds a correct, standards-compliant .zip entirely
 * in-process with no external dependency.
 *
 * Supported: STORE (level 0) + DEFLATE (raw) compression, files and explicit
 * directory entries, UTF-8 names. NOT supported: zip64 (we cap at <4 GB, which
 * a generated Playwright project never approaches), encryption, multi-disk.
 *
 * Usage:
 *   const zip = new ZipWriter();
 *   zip.addFile('package.json', Buffer.from(json));
 *   zip.addFile('tests/auth/login.spec.ts', Buffer.from(code));
 *   const buf = zip.toBuffer();   // a complete .zip
 */

const zlib = require('zlib');

// ── CRC-32 (ISO 3309 / ITU-T V.42 — the polynomial ZIP uses) ──────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// ── DOS date/time packing for the archive timestamp ───────────────────────
function dosDateTime(date) {
  const d = date || new Date();
  // DOS epoch starts 1980. Years before that clamp to 1980.
  const year = Math.max(1980, d.getFullYear());
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

class ZipWriter {
  constructor() {
    this.entries = [];
  }

  /**
   * Add a file to the archive.
   * @param {string} name  POSIX-style relative path (forward slashes).
   * @param {Buffer|string} content
   * @param {object} [opts] { store?: boolean (no compression), date?: Date }
   */
  addFile(name, content, opts = {}) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const normName = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    this.entries.push({ name: normName, data, isDir: false, store: !!opts.store, date: opts.date });
    return this;
  }

  /** Add an explicit empty-directory entry (trailing slash enforced). */
  addDir(name, opts = {}) {
    const normName = String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/?$/, '/');
    this.entries.push({ name: normName, data: Buffer.alloc(0), isDir: true, store: true, date: opts.date });
    return this;
  }

  /** Build the complete .zip as a single Buffer. */
  toBuffer() {
    const localParts = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const { dosTime, dosDate } = dosDateTime(entry.date);
      const crc = entry.isDir ? 0 : crc32(entry.data);

      // Compression: DEFLATE unless STORE requested or the deflated output
      // would be larger than the raw bytes (tiny files compress poorly).
      let method = 0; // store
      let outData = entry.data;
      if (!entry.isDir && !entry.store && entry.data.length > 0) {
        const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
        if (deflated.length < entry.data.length) {
          method = 8; // deflate
          outData = deflated;
        }
      }

      const compSize = outData.length;
      const uncompSize = entry.data.length;

      // ── Local file header (signature 0x04034b50) ──
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);            // version needed
      local.writeUInt16LE(0x0800, 6);        // flags: bit 11 = UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compSize, 18);
      local.writeUInt32LE(uncompSize, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);            // extra field length
      localParts.push(local, nameBuf, outData);

      // ── Central directory record (signature 0x02014b50) ──
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);               // version made by
      cd.writeUInt16LE(20, 6);               // version needed
      cd.writeUInt16LE(0x0800, 8);           // flags: UTF-8
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(dosTime, 12);
      cd.writeUInt16LE(dosDate, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compSize, 20);
      cd.writeUInt32LE(uncompSize, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);               // extra length
      cd.writeUInt16LE(0, 32);               // comment length
      cd.writeUInt16LE(0, 34);               // disk number start
      cd.writeUInt16LE(0, 36);               // internal attrs
      // External attrs: dir bit (0x10) or regular file (0x20), shifted into the
      // unix-permission high word so extraction tools set sane modes.
      const unixMode = entry.isDir ? 0o040755 : 0o100644;
      const externalAttrs = (((unixMode << 16) >>> 0) | (entry.isDir ? 0x10 : 0)) >>> 0;
      cd.writeUInt32LE(externalAttrs, 38);
      cd.writeUInt32LE(offset, 42);          // local header offset
      central.push(cd, nameBuf);

      offset += local.length + nameBuf.length + outData.length;
    }

    const centralBuf = Buffer.concat(central);
    const localBuf = Buffer.concat(localParts);

    // ── End of central directory record (signature 0x06054b50) ──
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);                          // disk number
    eocd.writeUInt16LE(0, 6);                          // central dir start disk
    eocd.writeUInt16LE(this.entries.length, 8);        // entries on this disk
    eocd.writeUInt16LE(this.entries.length, 10);       // total entries
    eocd.writeUInt32LE(centralBuf.length, 12);         // central dir size
    eocd.writeUInt32LE(localBuf.length, 16);           // central dir offset
    eocd.writeUInt16LE(0, 20);                         // comment length

    return Buffer.concat([localBuf, centralBuf, eocd]);
  }
}

module.exports = { ZipWriter, crc32 };
