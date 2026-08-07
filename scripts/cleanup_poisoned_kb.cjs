'use strict';
require('dotenv').config();
/**
 * One-time cleanup: null out KnowledgeBaseLocator.selector values that are
 * getByText("agent narration...") — poisoned by the old recordSuccessfulLocator
 * fallback that stored the element description rather than a real DOM locator.
 *
 * Safe to run multiple times. Only touches rows where the stored selector is
 * provably a descriptor, not real DOM evidence.
 *
 * Usage:
 *   node scripts/cleanup_poisoned_kb.cjs [--dry-run]
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');

// Same heuristic as _locators.js looksLikeDescription.
function looksLikeDescriptor(selector) {
  if (!selector || typeof selector !== 'string') return false;
  if (!/^getByText\s*\(/.test(selector)) return false;
  // Extract the text argument from getByText("...") or getByText('...')
  const m = selector.match(/^getByText\s*\(\s*(['"`])([\s\S]*?)\1/);
  if (!m) return false;
  const arg = m[2];
  // Flag if: length > 40, or contains descriptor keywords, or has parenthetical context
  if (arg.length > 40) return true;
  if (/\([^)]+\)/.test(arg)) return true;
  return /\b(?:button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\s+(?:for|in|of)\b/i.test(arg);
}

async function main() {
  console.log(`[cleanup_poisoned_kb] ${DRY_RUN ? 'DRY RUN — ' : ''}scanning KnowledgeBaseLocator rows…`);

  const rows = await prisma.knowledgeBaseLocator.findMany({
    select: { id: true, projectId: true, element: true, selector: true },
  });

  const poisoned = rows.filter((r) => looksLikeDescriptor(r.selector));
  console.log(`Found ${poisoned.length} poisoned rows out of ${rows.length} total.`);

  if (poisoned.length === 0) {
    console.log('Nothing to clean.');
    return;
  }

  for (const row of poisoned) {
    console.log(`  [${row.id.slice(0, 8)}] element="${row.element.slice(0, 60)}" selector="${row.selector.slice(0, 80)}"`);
    if (!DRY_RUN) {
      await prisma.knowledgeBaseLocator.update({
        where: { id: row.id },
        data: { selector: '(unknown)', strategy: 'text' },
      });
    }
  }

  if (DRY_RUN) {
    console.log(`DRY RUN complete — ${poisoned.length} rows would be nulled. Re-run without --dry-run to apply.`);
  } else {
    console.log(`Cleaned ${poisoned.length} poisoned rows.`);
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
