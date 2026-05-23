import React from 'react';

/**
 * Minimal markdown renderer tuned for Claude's Conductor narration.
 *
 * Supports the subset that actually shows up in the wild: `**bold**`,
 * `*italic*`, `` `code` ``, headings (#..######), `---`/`***` horizontal
 * rules, `|pipe|tables|` (with optional separator row), unordered lists
 * (`- ` or `* `), ordered lists (`1. `), inline links (`[text](url)`), and
 * blockquotes (`> `). Everything else falls through as plain text.
 *
 * This is intentionally NOT a full CommonMark implementation — keeping it
 * inline avoids pulling in a dependency on a box where `npm install` is
 * unreliable. Output is React nodes, not HTML strings, so there's no XSS
 * surface beyond what JSX gives us for free.
 */

// Quick heuristic so callers can fast-path plain log lines without going
// through the parser at all.
export function looksLikeMarkdown(s) {
  if (!s || typeof s !== 'string') return false;
  return (
    /\*\*[^*\n]+\*\*/.test(s) ||
    /(^|\n)#{1,6}\s/.test(s) ||
    /(^|\n)\s*[-*]\s+\S/.test(s) ||
    /(^|\n)\s*\d+\.\s+\S/.test(s) ||
    /(^|\n)\s*---+\s*(\n|$)/.test(s) ||
    /(^|\n)\s*\|.+\|\s*(\n|$)/.test(s) ||
    /`[^`\n]+`/.test(s)
  );
}

function parseBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let para = [];
  let list = null;       // { type:'ul'|'ol', items: [] }
  let table = null;      // { headers, rows, headerSeen }
  let quote = null;      // { lines: [] }

  const flushPara = () => { if (para.length) { blocks.push({ type: 'para', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  const flushTable = () => { if (table) { blocks.push(table); table = null; } };
  const flushQuote = () => { if (quote) { blocks.push(quote); quote = null; } };
  const flushAll = () => { flushPara(); flushList(); flushTable(); flushQuote(); };

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushAll();
      blocks.push({ type: 'hr' });
      continue;
    }

    // Heading
    const h = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushAll();
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      continue;
    }

    // Table row
    if (/^\|.+\|$/.test(trimmed)) {
      flushPara(); flushList(); flushQuote();
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      // separator row (|---|---|)
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        if (table && !table.headerSeen) {
          table.headerSeen = true;
          table.headers = table.rows.length ? table.rows[table.rows.length - 1] : table.headers;
          table.rows.pop();
        }
        continue;
      }
      if (!table) table = { type: 'table', headers: cells, rows: [], headerSeen: false };
      else if (!table.headerSeen) {
        // The first row is the header until we see a separator; if no
        // separator ever arrives, treat all rows as body and keep the original
        // first cells as headers.
        table.rows.push(cells);
      } else {
        table.rows.push(cells);
      }
      continue;
    } else if (table) flushTable();

    // List item
    const ul = raw.match(/^\s*[-*]\s+(.+)$/);
    const ol = raw.match(/^\s*\d+\.\s+(.+)$/);
    if (ul || ol) {
      flushPara(); flushQuote();
      const kind = ol ? 'ol' : 'ul';
      const text = (ul || ol)[1];
      if (!list || list.type !== kind) { flushList(); list = { type: kind, items: [] }; }
      list.items.push(text);
      continue;
    } else if (list && trimmed) flushList();

    // Blockquote
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) {
      flushPara(); flushList();
      if (!quote) quote = { type: 'quote', lines: [] };
      quote.lines.push(bq[1]);
      continue;
    } else if (quote && trimmed) flushQuote();

    // Blank line → paragraph break
    if (!trimmed) {
      flushAll();
      continue;
    }

    para.push(trimmed);
  }
  flushAll();
  return blocks;
}

// Inline tokenizer for **bold**, *italic*, `code`, [text](url). Operates on a
// string and returns an array of React nodes interspersed with plain strings.
function renderInline(text, keyBase = 'i') {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };

  while (i < text.length) {
    // **bold**
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push(<strong key={`${keyBase}-b-${out.length}`} className="font-semibold text-white">{renderInline(text.slice(i + 2, end), `${keyBase}-bb`)}</strong>);
        i = end + 2;
        continue;
      }
    }
    // *italic* (only when not adjacent to letters — avoids consuming arithmetic asterisks)
    if (text[i] === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1 && text[end - 1] !== ' ') {
        flush();
        out.push(<em key={`${keyBase}-i-${out.length}`} className="italic">{renderInline(text.slice(i + 1, end), `${keyBase}-ii`)}</em>);
        i = end + 1;
        continue;
      }
    }
    // `code`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={`${keyBase}-c-${out.length}`} className="font-mono text-[0.85em] bg-ink-800 text-ink-100 px-1.5 py-0.5 rounded">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    // [link](url)
    if (text[i] === '[') {
      const linkEnd = text.indexOf('](', i + 1);
      if (linkEnd > i + 1) {
        const urlEnd = text.indexOf(')', linkEnd + 2);
        if (urlEnd > linkEnd + 2) {
          const linkText = text.slice(i + 1, linkEnd);
          const url = text.slice(linkEnd + 2, urlEnd);
          flush();
          out.push(
            <a key={`${keyBase}-l-${out.length}`} href={url} target="_blank" rel="noreferrer" className="text-info-300 hover:text-info-200 underline">
              {linkText}
            </a>
          );
          i = urlEnd + 1;
          continue;
        }
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

function renderBlock(b, key) {
  switch (b.type) {
    case 'hr':
      return <hr key={key} className="my-3 border-ink-700/70" />;
    case 'heading': {
      const sizes = ['', 'text-base font-bold', 'text-sm font-bold', 'text-sm font-semibold uppercase tracking-wider', 'text-xs font-semibold uppercase tracking-wider', 'text-xs font-semibold', 'text-xs font-semibold'];
      const cls = `${sizes[b.level] || sizes[3]} text-white mt-3 mb-1.5 first:mt-0`;
      const Tag = `h${Math.min(b.level + 2, 6)}`;
      return React.createElement(Tag, { key, className: cls }, renderInline(b.text, `${key}-h`));
    }
    case 'para':
      return (
        <p key={key} className="text-[13px] leading-relaxed text-ink-100 my-1.5 first:mt-0 last:mb-0">
          {renderInline(b.text, `${key}-p`)}
        </p>
      );
    case 'ul':
      return (
        <ul key={key} className="list-disc pl-5 space-y-1 my-2 marker:text-ink-500 text-[13px] leading-relaxed text-ink-100">
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `${key}-li-${i}`)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} className="list-decimal pl-5 space-y-1 my-2 marker:text-ink-500 text-[13px] leading-relaxed text-ink-100">
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `${key}-li-${i}`)}</li>)}
        </ol>
      );
    case 'quote':
      return (
        <blockquote key={key} className="border-l-2 border-info-400/60 bg-ink-800/50 pl-3 pr-2 py-1 my-2 text-[13px] leading-relaxed text-ink-200 italic">
          {b.lines.map((ln, i) => <div key={i}>{renderInline(ln, `${key}-q-${i}`)}</div>)}
        </blockquote>
      );
    case 'table':
      return (
        <div key={key} className="my-2 overflow-x-auto rounded border border-ink-700">
          <table className="text-[12px] border-collapse w-full">
            <thead>
              <tr className="bg-ink-800/80">
                {b.headers.map((c, i) => (
                  <th key={i} className="text-left text-2xs uppercase tracking-wider font-bold text-ink-200 px-2.5 py-1.5 border-b border-ink-700 whitespace-nowrap">
                    {renderInline(c, `${key}-th-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri} className="even:bg-ink-800/30">
                  {row.map((c, ci) => (
                    <td key={ci} className="text-ink-100 px-2.5 py-1.5 border-b border-ink-800/70 align-top">
                      {renderInline(c, `${key}-td-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export default function Markdown({ text, className }) {
  const blocks = parseBlocks(text);
  return <div className={className}>{blocks.map((b, i) => renderBlock(b, `b${i}`))}</div>;
}
