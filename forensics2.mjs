import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Get the second run (d694d1af...) which had 10 failed cases
const runId = 'd694d1af-2b6b-4ef0-a7e3-0ff65c68a750';
const projectId = '2ccb038c-22a0-46f5-a46a-47da40075822';

console.log('\n=== DETAILED ANALYSIS OF RUN d694d1af ===');
const run = await prisma.run.findUnique({
  where: { id: runId },
  select: { id: true, projectId: true, status: true, passed: true, failed: true, blocked: true, skipped: true, startedAt: true, completedAt: true }
});
console.log('Run:', JSON.stringify(run, null, 2));

// 2. AgentRun rows with full details
console.log('\n=== AgentRun breakdown ===');
const agentRuns = await prisma.agentRun.findMany({
  where: { projectId },
  orderBy: { startedAt: 'asc' },
  select: { id: true, phase: true, status: true, startedAt: true, completedAt: true }
});

console.log(`Total AgentRun records: ${agentRuns.length}`);
const phaseCounts = {};
const phaseTimings = {};
agentRuns.forEach(ar => {
  const phase = ar.phase;
  phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
  const duration = ar.completedAt ? (new Date(ar.completedAt).getTime() - new Date(ar.startedAt).getTime()) : null;
  if (duration) {
    if (!phaseTimings[phase]) phaseTimings[phase] = [];
    phaseTimings[phase].push(duration);
  }
});

console.log('Phase distribution:', phaseCounts);
console.log('\nAverage duration per phase (ms):');
Object.entries(phaseTimings).forEach(([phase, timings]) => {
  const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
  console.log(`  ${phase}: ${avg}ms (${timings.length} calls)`);
});

// Check for conductor retries - are there conductor.1, conductor.2, conductor.3?
const conductorPhases = agentRuns.filter(ar => ar.phase && ar.phase.startsWith('conductor'));
console.log(`\nConductor phases detail: ${conductorPhases.length}`);
const conductorPhaseNames = new Set(conductorPhases.map(ar => ar.phase));
console.log('Conductor attempts:', Array.from(conductorPhaseNames).sort());

// 3. RunResult details
console.log('\n=== RunResult details ===');
const results = await prisma.runResult.findMany({
  where: { runId },
  select: { 
    id: true,
    testCaseId: true, 
    status: true, 
    durationMs: true,
    domSnapshots: true,
    error: true
  }
});

console.log(`Total results: ${results.length}`);
console.log('Results by status:');
const statusCounts = {};
results.forEach(r => {
  statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
});
console.log(statusCounts);

// Analyze loops via domSnapshots
console.log('\nLoop analysis (domSnapshots):');
let maxSnapshots = 0;
let avgSnapshots = 0;
let totalSnapshots = 0;
results.forEach(r => {
  try {
    const snaps = r.domSnapshots ? JSON.parse(r.domSnapshots) : [];
    totalSnapshots += snaps.length;
    maxSnapshots = Math.max(maxSnapshots, snaps.length);
  } catch (e) {}
});
avgSnapshots = results.length > 0 ? (totalSnapshots / results.length).toFixed(1) : 0;
console.log(`  Total snapshots: ${totalSnapshots}`);
console.log(`  Max per case: ${maxSnapshots}`);
console.log(`  Avg per case: ${avgSnapshots}`);
console.log(`  (Each snapshot ~1 turn estimate)`);

// 4. BlockedItem details for this run
console.log('\n=== BlockedItem reasons ===');
const blockedItems = await prisma.blockedItem.findMany({
  where: { runId },
  select: { reason: true, message: true, severity: true }
});

console.log(`Total blocked: ${blockedItems.length}`);
const reasonCounts = {};
blockedItems.forEach(item => {
  const reason = item.reason || 'unknown';
  reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
});
console.log('Reasons:', reasonCounts);

// 5. Architect + Planner count
console.log('\n=== Architect + Planner activity ===');
const architect = agentRuns.filter(ar => ar.phase === 'architect');
const planner = agentRuns.filter(ar => ar.phase === 'planner');
console.log(`Architect calls: ${architect.length}`);
console.log(`Planner calls: ${planner.length}`);

// 6. Supervisor detail
console.log('\n=== Supervisor detail ===');
const supervisors = agentRuns.filter(ar => ar.phase === 'supervisor');
console.log(`Supervisor calls: ${supervisors.length}`);
supervisors.forEach((s, i) => {
  const dur = s.completedAt ? (new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()) : null;
  console.log(`  ${i+1}. ${s.status} (${dur}ms)`);
});

// 7. Daily token usage check - check if there are any records
console.log('\n=== User daily token usage ===');
const allUsage = await prisma.userDailyUsage.findMany({
  orderBy: { date: 'desc' },
  take: 5
});
console.log(`Recent usage records: ${allUsage.length}`);
if (allUsage.length > 0) {
  console.log(JSON.stringify(allUsage, null, 2));
  allUsage.forEach(u => {
    const total = u.inputTokens + u.outputTokens;
    console.log(`  ${u.date} (${u.provider}): ${u.inputTokens} input + ${u.outputTokens} output = ${total} total`);
  });
}

// 8. KB locators
console.log('\n=== Knowledge Base Locator stats ===');
const kbLocators = await prisma.knowledgeBaseLocator.findMany({
  where: { projectId },
  select: { element: true, selector: true, healthScore: true }
});
console.log(`Total locators: ${kbLocators.length}`);
const selectorLengths = kbLocators.map(k => k.selector.length);
const avgLen = kbLocators.length > 0 ? Math.round(selectorLengths.reduce((a, b) => a + b, 0) / kbLocators.length) : 0;
const maxLen = Math.max(...selectorLengths, 0);
console.log(`Avg selector length: ${avgLen} chars`);
console.log(`Max selector length: ${maxLen} chars`);

// Check healer activity around run time
console.log('\n=== Healer activity ===');
const healers = await prisma.agentRun.findMany({
  where: {
    projectId,
    phase: 'healer',
    startedAt: { 
      gte: new Date(new Date(run.startedAt).getTime() - 30 * 60 * 1000)
    }
  },
  select: { id: true, status: true, startedAt: true, completedAt: true }
});
console.log(`Healer calls within 30min before run: ${healers.length}`);
if (healers.length > 0) {
  healers.slice(0, 5).forEach((h, i) => {
    const dur = h.completedAt ? (new Date(h.completedAt).getTime() - new Date(h.startedAt).getTime()) : null;
    console.log(`  ${i+1}. ${h.status} (${dur}ms)`);
  });
}

await prisma.$disconnect();
