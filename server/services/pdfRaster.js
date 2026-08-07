'use strict';

/**
 * Pure-WASM PDF rasteriser (Phase M2 — multimodal ingestion).
 *
 * Renders the IMAGE-BEARING pages of a PDF to PNG so the vision extractor can
 * read embedded screenshots (in text PDFs) and whole scanned pages. One rule
 * covers every case and gates cost cleanly: a page is processed only when its
 * structured text contains >=1 image block —
 *   - scanned/image-only PDF → every page qualifies (capped),
 *   - text PDF with a screenshot → only that page,
 *   - pure-text PDF → none (zero vision cost).
 *
 * mupdf is an ESM module with top-level await, so it MUST be loaded via dynamic
 * import() from this CommonJS module. Lazy + cached so the server still boots if
 * the dependency is missing (renderImageBearingPages then returns available:false
 * and the caller falls back to its prior behaviour — no crash).
 */

let _mupdfPromise = null;
async function loadMupdf() {
  if (_mupdfPromise === null) {
    _mupdfPromise = import('mupdf')
      .then((ns) => (ns && ns.Document ? ns : (ns && ns.default) || ns))
      .catch(() => false);
  }
  return _mupdfPromise;
}

const SCAN_PAGE_CAP = 40;        // never inspect more than this many pages
const DEFAULT_RENDER_SCALE = 2;  // 2x → legible text inside screenshots

/**
 * @param {Buffer} buffer  PDF bytes
 * @param {object} [opts]
 * @param {number} [opts.maxPages=6]  cap on rendered (image-bearing) pages — bounds vision cost
 * @param {number} [opts.scale=2]     render scale
 * @returns {Promise<{available:boolean, pageCount:number, pages:Array<{pageIndex:number, base64:string, mediaType:string, textChars:number}>}>}
 */
async function renderImageBearingPages(buffer, { maxPages = 6, scale = DEFAULT_RENDER_SCALE } = {}) {
  const mupdf = await loadMupdf();
  if (!mupdf || !mupdf.Document || typeof mupdf.Document.openDocument !== 'function') {
    return { available: false, pageCount: 0, pages: [] };
  }
  let doc;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(buffer), 'application/pdf');
  } catch (_) {
    return { available: true, pageCount: 0, pages: [] };
  }
  let pageCount = 0;
  try { pageCount = doc.countPages(); } catch (_) { pageCount = 0; }
  const scanLimit = Math.min(pageCount, SCAN_PAGE_CAP);
  const pages = [];
  for (let i = 0; i < scanLimit && pages.length < maxPages; i += 1) {
    try {
      const page = doc.loadPage(i);
      const sText = page.toStructuredText('preserve-images');
      let hasImage = false;
      let textChars = 0;
      sText.walk({ onImageBlock() { hasImage = true; }, onChar() { textChars += 1; } });
      if (!hasImage) continue;
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      const png = pix.asPNG();
      pages.push({
        pageIndex: i,
        base64: Buffer.from(png).toString('base64'),
        mediaType: 'image/png',
        textChars,
      });
    } catch (_) { /* skip an unreadable page; never abort the whole doc */ }
  }
  return { available: true, pageCount, pages };
}

module.exports = { renderImageBearingPages, loadMupdf };
