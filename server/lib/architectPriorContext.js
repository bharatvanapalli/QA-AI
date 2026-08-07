'use strict';

/**
 * P0-8 — Architect quarantine awareness helper.
 *
 * Reads the project's KnowledgeBaseLocator rows where healthScore is below
 * the quarantine threshold and renders a prompt block the Architect can
 * inject as priorContext. Symmetric to the Conductor's per-case "Known
 * locators on this site" block — closes the one-way KB loop.
 *
 * Generic rule: Architect reads from the KB. Quarantined locators are
 * surfaced as "avoid these elements" in the prompt. Same pattern the
 * Conductor uses.
 */

async function buildQuarantineContextBlock(prisma, projectId) {
  if (!prisma || !projectId) return null;
  const threshold = Number(process.env.QAAI_QUARANTINE_HEALTH) || 30;
  try {
    const quarantined = await prisma.knowledgeBaseLocator.findMany({
      where: { projectId, healthScore: { lt: threshold } },
      orderBy: [{ healthScore: 'asc' }, { failureCount: 'desc' }],
      take: 25,
      select: {
        element: true,
        accessibleName: true,
        role: true,
        pageUrl: true,
        healthScore: true,
        failureCount: true,
      },
    });
    if (quarantined.length === 0) return null;
    const lines = quarantined.map((q) => {
      const id = q.accessibleName || q.element;
      const where = q.pageUrl ? ` @ ${q.pageUrl}` : '';
      const meta = `health=${q.healthScore}, failures=${q.failureCount || 0}`;
      return `  - "${id}"${q.role ? ` (role=${q.role})` : ''}${where} — ${meta}`;
    }).join('\n');
    return (
      `## Quarantined elements on this project\n` +
      `The following elements have failed too many times in prior runs and the Conductor will refuse to interact with them this run:\n${lines}\n\n` +
      `Avoid steps that target these elements. If a scenario logically requires them, mark the case as automatability="manual" with a stated reason instead of emitting an automatable case the Conductor will block.`
    );
  } catch (err) {
    console.warn('[architect-prior-context] quarantine lookup failed:', err.code || err.name, err.message);
    return null;
  }
}

module.exports = { buildQuarantineContextBlock };
