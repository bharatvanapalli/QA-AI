import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const projectId = '2ccb038c-22a0-46f5-a46a-47da40075822';

// Examine planner phase in detail
console.log('\n=== Planner phase detail (11 calls) ===');
const planners = await prisma.agentRun.findMany({
  where: { projectId, phase: 'planner' },
  orderBy: { startedAt: 'asc' },
  select: {
    id: true,
    status: true,
    startedAt: true,
    completedAt: true,
    input: true,
    output: true
  }
});

console.log(`Planner runs: ${planners.length}`);

// Check if inputs are populated
const plannerInputSizes = planners.map(p => {
  let size = 0;
  try {
    if (p.input) {
      const inp = JSON.parse(p.input);
      size = JSON.stringify(inp).length;
    }
  } catch (e) {}
  return size;
});

const totalPlannerInputBytes = plannerInputSizes.reduce((a, b) => a + b, 0);
console.log(`Total planner input bytes: ${totalPlannerInputBytes}`);
console.log(`Avg planner input: ${Math.round(totalPlannerInputBytes / planners.length)} bytes`);
console.log(`Max planner input: ${Math.max(...plannerInputSizes)} bytes`);

// Estimate token cost: 1 token ~ 4 chars
const plannerEstimatedTokens = Math.round(totalPlannerInputBytes / 4);
console.log(`Estimated tokens in planner inputs: ~${plannerEstimatedTokens}`);

// Now check conductor inputs
console.log('\n=== Conductor phase detail (13 calls across conductor.1-4) ===');
const conductors = await prisma.agentRun.findMany({
  where: { projectId, phase: { startsWith: 'conductor' } },
  orderBy: { startedAt: 'asc' },
  select: {
    phase: true,
    status: true,
    startedAt: true,
    completedAt: true,
    input: true,
    output: true
  }
});

console.log(`Conductor runs: ${conductors.length}`);

const conductorInputSizes = conductors.map(c => {
  let size = 0;
  try {
    if (c.input) {
      const inp = JSON.parse(c.input);
      size = JSON.stringify(inp).length;
    }
  } catch (e) {}
  return size;
});

const totalConductorInputBytes = conductorInputSizes.reduce((a, b) => a + b, 0);
const avgConductorInput = Math.round(totalConductorInputBytes / conductors.length);
const maxConductorInput = Math.max(...conductorInputSizes);

console.log(`Total conductor input bytes: ${totalConductorInputBytes}`);
console.log(`Avg conductor input: ${avgConductorInput} bytes`);
console.log(`Max conductor input: ${maxConductorInput} bytes`);

// Estimate token cost
const conductorEstimatedTokens = Math.round(totalConductorInputBytes / 4);
console.log(`Estimated tokens in conductor inputs: ~${conductorEstimatedTokens}`);

// Check supervisor + critic
console.log('\n=== Supervisor + Critic phases ===');
const supervisors = await prisma.agentRun.findMany({
  where: { projectId, phase: 'supervisor' },
  select: {
    phase: true,
    input: true,
    startedAt: true,
    completedAt: true
  }
});

const superInputSizes = supervisors.map(s => {
  let size = 0;
  try {
    if (s.input) {
      const inp = JSON.parse(s.input);
      size = JSON.stringify(inp).length;
    }
  } catch (e) {}
  return size;
});
const totalSuperInputBytes = superInputSizes.reduce((a, b) => a + b, 0);
console.log(`Supervisor (${supervisors.length} runs): ${totalSuperInputBytes} bytes input (~${Math.round(totalSuperInputBytes / 4)} tokens)`);

// Critics
const critics = await prisma.agentRun.findMany({
  where: { projectId, phase: { startsWith: 'critic' } },
  select: {
    phase: true,
    input: true
  }
});

const criticInputSizes = critics.map(c => {
  let size = 0;
  try {
    if (c.input) {
      const inp = JSON.parse(c.input);
      size = JSON.stringify(inp).length;
    }
  } catch (e) {}
  return size;
});
const totalCriticInputBytes = criticInputSizes.reduce((a, b) => a + b, 0);
console.log(`Critic (${critics.length} runs): ${totalCriticInputBytes} bytes input (~${Math.round(totalCriticInputBytes / 4)} tokens)`);

// Summary
console.log('\n=== ESTIMATED INPUT TOKEN BREAKDOWN ===');
const allInputBytes = totalPlannerInputBytes + totalConductorInputBytes + totalSuperInputBytes + totalCriticInputBytes;
const allInputTokens = Math.round(allInputBytes / 4);
console.log(`Planner:    ${Math.round(totalPlannerInputBytes/4).toLocaleString()} tokens (${plannerEstimatedTokens.toLocaleString()} est)`);
console.log(`Conductor:  ${Math.round(totalConductorInputBytes/4).toLocaleString()} tokens`);
console.log(`Supervisor: ${Math.round(totalSuperInputBytes/4).toLocaleString()} tokens`);
console.log(`Critic:     ${Math.round(totalCriticInputBytes/4).toLocaleString()} tokens`);
console.log(`─────────────────────`);
console.log(`Total:      ${Math.round(allInputBytes / 4).toLocaleString()} tokens (actual daily usage was 3,625,750)`);

// The discrepancy: let's check if planner is being called per test case
console.log('\n=== Planner call hypothesis ===');
const testCases = await prisma.testCase.findMany({
  where: { projectId },
  select: { id: true, name: true }
});
console.log(`Test cases in project: ${testCases.length}`);
console.log(`Planner calls: ${planners.length}`);
console.log(`Planner/TC ratio: ${planners.length / testCases.length} (higher = per-case planning)`);

// If planner is re-planning per case, the prompt includes all test cases
// Let's check the planner output to see what it's generating
console.log('\n=== Planner output analysis ===');
const plannerOutputSizes = planners.map((p, i) => {
  let size = 0;
  try {
    if (p.output) {
      const outp = JSON.parse(p.output);
      size = JSON.stringify(outp).length;
    }
  } catch (e) {}
  return size;
});
const totalPlannerOutputBytes = plannerOutputSizes.reduce((a, b) => a + b, 0);
console.log(`Total planner output bytes: ${totalPlannerOutputBytes}`);
console.log(`Estimated output tokens: ~${Math.round(totalPlannerOutputBytes / 4).toLocaleString()}`);

await prisma.$disconnect();
