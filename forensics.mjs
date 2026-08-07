import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 1. Most recent Run
console.log('\n=== QUERY 1: Most recent 5 Runs ===');
const runs = await prisma.run.findMany({
  take: 5,
  orderBy: { startedAt: 'desc' },
  select: { id: true, projectId: true, status: true, passed: true, failed: true, blocked: true, skipped: true, startedAt: true, completedAt: true }
});
console.log(JSON.stringify(runs, null, 2));

if (!runs.length) {
  console.log('No runs found');
  await prisma.$disconnect();
  process.exit(0);
}

const latestRun = runs[0];
console.log(`\nLatest run: ${latestRun.id}`);
console.log(`Project: ${latestRun.projectId}`);
console.log(`Status: ${latestRun.status}`);
console.log(`Cases: ${latestRun.passed} passed, ${latestRun.failed} failed, ${latestRun.blocked} blocked, ${latestRun.skipped} skipped`);
console.log(`Started: ${latestRun.startedAt}`);
console.log(`Completed: ${latestRun.completedAt}`);

// 2. AgentRun rows for that run (in ±2 hr window)
console.log('\n=== QUERY 2: AgentRun rows ===');
const oneHourAgo = new Date(new Date(latestRun.startedAt).getTime() - 60 * 60 * 1000);
const agentRuns = await prisma.agentRun.findMany({
  where: {
    projectId: latestRun.projectId,
    startedAt: { gte: oneHourAgo }
  },
  orderBy: { startedAt: 'asc' },
  select: { id: true, phase: true, status: true, startedAt: true, completedAt: true }
});

console.log(`Total AgentRun records: ${agentRuns.length}`);
const phaseCounts = {};
agentRuns.forEach(ar => {
  const phase = ar.phase;
  phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
});
console.log('Phase distribution:', phaseCounts);

const conductorPhases = agentRuns.filter(ar => ar.phase && ar.phase.startsWith('conductor'));
console.log(`Conductor.N phases found: ${conductorPhases.length}`);
if (conductorPhases.length > 0) {
  const phaseNames = new Set(conductorPhases.map(ar => ar.phase));
  console.log('Unique conductor phases:', Array.from(phaseNames).sort());
}

// 3. UserDailyUsage for today
console.log('\n=== QUERY 3: UserDailyUsage (today UTC) ===');
const todayDate = new Date().toISOString().split('T')[0];
const usage = await prisma.userDailyUsage.findMany({
  where: { date: todayDate },
  orderBy: { inputTokens: 'desc' }
});

console.log(`Records for ${todayDate}: ${usage.length}`);
if (usage.length > 0) {
  console.log(JSON.stringify(usage, null, 2));
  let totalInput = 0, totalOutput = 0;
  usage.forEach(u => {
    totalInput += u.inputTokens;
    totalOutput += u.outputTokens;
  });
  console.log(`\nDaily totals: ${totalInput} input + ${totalOutput} output = ${totalInput + totalOutput} total tokens`);
}

// 4. Healer activity
console.log('\n=== QUERY 4: Healer activity ===');
const twoHoursAgo = new Date(new Date(latestRun.startedAt).getTime() - 2 * 60 * 60 * 1000);
const healerCount = await prisma.agentRun.count({
  where: {
    projectId: latestRun.projectId,
    phase: 'healer',
    startedAt: { gte: twoHoursAgo }
  }
});
console.log(`Healer calls in 2-hour window: ${healerCount}`);
if (healerCount > 0) {
  const healers = await prisma.agentRun.findMany({
    where: {
      projectId: latestRun.projectId,
      phase: 'healer',
      startedAt: { gte: twoHoursAgo }
    },
    take: 10,
    select: { id: true, startedAt: true, completedAt: true, status: true }
  });
  console.log('Sample healer runs:', healers.length);
  healers.forEach((h, i) => {
    const ms = h.completedAt ? new Date(h.completedAt).getTime() - new Date(h.startedAt).getTime() : -1;
    console.log(`  ${i+1}. ${h.status} (${ms}ms)`);
  });
}

// 5. KnowledgeBaseLocator growth
console.log('\n=== QUERY 5: KnowledgeBaseLocator stats ===');
const kbLocators = await prisma.knowledgeBaseLocator.findMany({
  where: { projectId: latestRun.projectId },
  select: { selector: true, intent: true, element: true }
});

const count = kbLocators.length;
const avgSelectorLen = kbLocators.length > 0 
  ? Math.round(kbLocators.reduce((sum, loc) => sum + loc.selector.length, 0) / kbLocators.length) 
  : 0;
const maxSelectorLen = kbLocators.length > 0 
  ? Math.max(...kbLocators.map(loc => loc.selector.length))
  : 0;
const longSelectors = kbLocators.filter(loc => loc.selector.length > 100).length;

console.log(`Total locators: ${count}`);
console.log(`Average selector length: ${avgSelectorLen} chars`);
console.log(`Max selector length: ${maxSelectorLen} chars`);
console.log(`Selectors > 100 chars: ${longSelectors}`);

// 6. BlockedItem reasons
console.log('\n=== QUERY 6: BlockedItem reasons ===');
const blockedItems = await prisma.blockedItem.findMany({
  where: { runId: latestRun.id },
  select: { reason: true }
});

const reasonCounts = {};
blockedItems.forEach(item => {
  const reason = item.reason || 'unknown';
  reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
});
console.log('Blocked reasons:', reasonCounts);
console.log(`Total blocked: ${blockedItems.length}`);

// 7. RunResult turn/loop indicator
console.log('\n=== QUERY 7: RunResult analysis ===');
const results = await prisma.runResult.findMany({
  where: { runId: latestRun.id },
  select: { testCaseId: true, status: true, domSnapshots: true, durationMs: true }
});

console.log(`RunResult rows for this run: ${results.length}`);

// Analyze domSnapshots (stored as JSON array string) to estimate loop depth
let maxSnapshotCount = 0;
let totalSnapshots = 0;
results.forEach(r => {
  try {
    const snapshots = r.domSnapshots ? JSON.parse(r.domSnapshots) : [];
    totalSnapshots += snapshots.length;
    maxSnapshotCount = Math.max(maxSnapshotCount, snapshots.length);
  } catch (e) {
    // ignore parse errors
  }
});

console.log(`Total domSnapshots across all results: ${totalSnapshots}`);
console.log(`Max snapshots on a single result: ${maxSnapshotCount}`);
console.log(`Average snapshots per case: ${(totalSnapshots / results.length).toFixed(1)}`);

// 8. Summary hypothesis
console.log('\n=== FORENSIC SUMMARY ===');
console.log(`Hypothesis check for 3.5M token burn:`);
console.log(`  (a) Supervisor retries × multiple cases:`);
console.log(`      - Supervisor calls in run: ${phaseCounts['supervisor'] || 0}`);
console.log(`      - Test cases executed: ${results.length}`);
console.log(`  (b) Single case looping 30 turns with locator drift:`);
console.log(`      - Max snapshots per case: ${maxSnapshotCount}`);
console.log(`      - Healer calls: ${healerCount}`);
console.log(`  (c) Huge KB block injected per turn:`);
console.log(`      - KB locators in project: ${count}`);
console.log(`      - Long selectors (>100 chars): ${longSelectors}`);
console.log(`      - Max selector length: ${maxSelectorLen} chars`);

await prisma.$disconnect();
