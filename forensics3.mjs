import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const projectId = '2ccb038c-22a0-46f5-a46a-47da40075822';

// Find ALL AgentRuns for this project to spot architect
console.log('\n=== Complete AgentRun history for project ===');
const allAgentRuns = await prisma.agentRun.findMany({
  where: { projectId },
  orderBy: { startedAt: 'asc' },
  select: { phase: true, startedAt: true, completedAt: true }
});

console.log(`Total AgentRuns in project: ${allAgentRuns.length}`);
const phaseHisto = {};
allAgentRuns.forEach(ar => {
  const phase = ar.phase;
  phaseHisto[phase] = (phaseHisto[phase] || 0) + 1;
});
console.log('All-time phase histogram:', phaseHisto);

// Find test cases - did architect generate a ton?
console.log('\n=== TestCase generation ===');
const testCases = await prisma.testCase.findMany({
  where: { projectId },
  select: { id: true, name: true, module: true, status: true, createdAt: true }
});

console.log(`Total test cases in project: ${testCases.length}`);
const casesByStatus = {};
testCases.forEach(tc => {
  casesByStatus[tc.status] = (casesByStatus[tc.status] || 0) + 1;
});
console.log('Cases by status:', casesByStatus);

// When were they created?
if (testCases.length > 0) {
  const sorted = testCases.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const first = new Date(sorted[0].createdAt);
  const last = new Date(sorted[sorted.length - 1].createdAt);
  console.log(`Created between: ${first.toISOString()} and ${last.toISOString()}`);
  console.log(`Sample cases (first 3): ${sorted.slice(0, 3).map(tc => tc.name).join(', ')}`);
}

// Look for architect phase
console.log('\n=== Architect runs ===');
const architects = await prisma.agentRun.findMany({
  where: { projectId, phase: 'architect' },
  select: { 
    id: true,
    status: true,
    startedAt: true,
    completedAt: true,
    input: true,
    output: true
  }
});

console.log(`Architect runs: ${architects.length}`);
architects.forEach((ar, i) => {
  const dur = ar.completedAt ? (new Date(ar.completedAt).getTime() - new Date(ar.startedAt).getTime()) : null;
  let inputSize = 0, outputSize = 0;
  try {
    if (ar.input) inputSize = JSON.parse(ar.input).toString().length;
    if (ar.output) outputSize = JSON.parse(ar.output).toString().length;
  } catch (e) {}
  console.log(`  ${i+1}. ${ar.status} (${dur}ms, input ~${inputSize} bytes, output ~${outputSize} bytes)`);
});

// Check Projects + Requirements/Documents (what architect ingests)
console.log('\n=== Project inputs ===');
const proj = await prisma.project.findUnique({
  where: { id: projectId },
  select: { 
    name: true,
    aiGuidance: true,
    testCredentials: true,
    createdAt: true,
    requirements: {
      select: { content: true }
    },
    documents: {
      select: { content: true, name: true }
    }
  }
});

if (proj) {
  console.log(`Project: ${proj.name}`);
  console.log(`AI Guidance: ${proj.aiGuidance ? proj.aiGuidance.length + ' chars' : 'none'}`);
  console.log(`Test credentials: ${proj.testCredentials ? proj.testCredentials.length + ' bytes' : 'none'}`);
  console.log(`Requirements: ${proj.requirements.length} rows, total size: ${proj.requirements.reduce((s, r) => s + r.content.length, 0)} chars`);
  console.log(`Documents: ${proj.documents.length} rows, total size: ${proj.documents.reduce((s, d) => s + d.content.length, 0)} chars`);
  if (proj.documents.length > 0) {
    console.log(`  Doc names: ${proj.documents.map(d => d.name).join(', ')}`);
  }
}

// The KB locators - injected into conductor prompt
console.log('\n=== KB Locator injection ===');
const kbLocs = await prisma.knowledgeBaseLocator.findMany({
  where: { projectId },
  select: { element: true, selector: true }
});
console.log(`Locators in KB: ${kbLocs.length}`);
const locatorText = kbLocs.map(k => `${k.element}: ${k.selector}`).join('\n');
console.log(`KB block size in prompt: ~${locatorText.length} chars (injected per conductor turn)`);

// Conductor input analysis - are we re-injecting massive context?
console.log('\n=== Conductor input analysis ===');
const conductors = await prisma.agentRun.findMany({
  where: { projectId, phase: { startsWith: 'conductor' } },
  select: {
    phase: true,
    input: true,
    startedAt: true
  },
  take: 3
});

console.log(`Sample conductor.1 inputs (first 3):`);
conductors.filter(c => c.phase === 'conductor.1').slice(0, 3).forEach((c, i) => {
  let inputSize = 0;
  try {
    if (c.input) {
      const inp = JSON.parse(c.input);
      inputSize = JSON.stringify(inp).length;
    }
  } catch (e) {}
  console.log(`  ${i+1}. ${inputSize} bytes`);
});

await prisma.$disconnect();
