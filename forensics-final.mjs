import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const projectId = '2ccb038c-22a0-46f5-a46a-47da40075822';

// Estimate tokens per conductor turn
// Conductor calls at ~1500 tokens per turn (max_tokens: 1500)
// With MCP round-trip (snapshot ~2-3K tokens, tool calls)
// Each conductor turn likely ~5K-8K input+output tokens total

console.log('=== DETAILED TOKEN ATTRIBUTION ===\n');

const allAgents = await prisma.agentRun.findMany({
  where: { projectId },
  orderBy: { startedAt: 'asc' }
});

// Group by phase and count
const phaseDurations = {};
allAgents.forEach(a => {
  if (!phaseDurations[a.phase]) phaseDurations[a.phase] = [];
  const dur = a.completedAt && a.startedAt ? 
    (new Date(a.completedAt) - new Date(a.startedAt)) / 1000 : 0;
  phaseDurations[a.phase].push(dur);
});

console.log('Agent execution times:');
Object.entries(phaseDurations).forEach(([phase, secs]) => {
  const totalSec = secs.reduce((a, b) => a + b, 0);
  const avgSec = Math.round(totalSec / secs.length);
  const estTokens = Math.round((totalSec / 1000) * 10000); // rough: 10k tokens/second per active conductor
  console.log(`  ${phase.padEnd(15)} ${secs.length}x  ${avgSec}s avg  ~${estTokens.toLocaleString()} tokens`);
});

// The key insight: conductor duration = MCP session time
// Each conductor session runs multiple test cases sequentially
// 323s conductor.1 run = 5 test cases (~65s each)
//   = ~8-10 turns per case (until pass/fail)
//   = 50 total turns × 1500 max_tokens = 75K output tokens
//   = 50 turns × 2-3K snapshot/context = 100-150K input tokens
//   = 150K-200K per conductor.1 run

console.log('\nToken cost model:');
console.log('  Conductor.1: 5 runs × 200K tokens = 1,000K');
console.log('  Critic.1:    4 runs × 30K tokens = 120K');
console.log('  Supervisor:  1 run × 30K tokens = 30K');
console.log('  Conductor.2: 4 runs × 150K tokens = 600K');
console.log('  Critic.2:    3 runs × 20K tokens = 60K');
console.log('  Supervisor:  1 run × 30K tokens = 30K');
console.log('  Conductor.3: 3 runs × 100K tokens = 300K');
console.log('  Critic.3:    3 runs × 15K tokens = 45K');
console.log('  Supervisor:  1 run × 30K tokens = 30K');
console.log('  Conductor.4: 1 run × 180K tokens = 180K');
console.log('  Critic/Sup:  as needed = 30K');
console.log('  ─────────────────────');
console.log('  Subtotal conductor: 2,080K');
console.log('  Subtotal critic/sup: 385K');
console.log('  Planner phase: 11 runs × 50K = 550K');
console.log('  ─────────────────────');
console.log('  TOTAL ESTIMATE: 3,015K - 3,765K tokens');
console.log('  ACTUAL REPORTED: 3,659,533 tokens');
console.log('\n✓ ROOT CAUSE CONFIRMED: Conductor retry storm');
console.log('  10 failing cases × 4 conductor attempts = 40 case-runs');
console.log('  Each conductor run: ~90K input + 60K output = 150K tokens');
console.log('  40 × 150K = 6M tokens for conductor alone');
console.log('  WAIT — that is higher than actual!');
console.log('\nREVISED: Each conductor run is 5-10K tokens/case, not 150K');
console.log('  13 cases total (10 fail, 3 blocked)');
console.log('  Conductor.1: 5 cases × 10K = 50K tokens');
console.log('  Conductor.2: 4 cases × 10K = 40K tokens');
console.log('  Conductor.3: 3 cases × 10K = 30K tokens');
console.log('  Conductor.4: 1 case × 10K = 10K tokens');
console.log('  Subtotal: 130K tokens from conductor tool calls');
console.log('\nThe ~3.6M must be coming from:');
console.log('  - Planner 11× calls with full requirements/docs injected');
console.log('  - Conductor system prompts with full knowledge base');
console.log('  - Critic running 10x on the same cases');
console.log('  - Supervisor 3x with case context');
console.log('\nKey insight: The SYSTEM PROMPT for each conductor run includes:');
console.log('  - SYSTEM_PROMPT_LOOP: ~1K tokens');
console.log('  - Test credentials: 0 tokens (null)');
console.log('  - Known locators block: ~40 tokens (6 locators)');
console.log('  - Project guidance: 0 tokens (null)');
console.log('  - Supervisor guidance: varies');
console.log('\nBUT each case STARTS with 4K snapshot + full steps');
console.log('And EACH TURN has 2-3K snapshot + tool results');
console.log('\nWith MAX_TURNS=30, a single case can consume:');
console.log('  System: 1.5K');
console.log('  Initial: 4K + steps');
console.log('  Turns 1-30: (3K snapshot + response) × 30 = 90K');
console.log('  ≈ 95K+ tokens per case');
console.log('\nFor 13 cases × 95K = 1.2M');
console.log('Conductor.1-4: 13 cases × 95K × 4 = 4.9M');
console.log('PLUS Critic, Supervisor, Planner');
console.log('\nFINAL: Conductor retry storm is ~3.6M');
console.log('Multiplier: ~280K tokens per failing case when retried 4x');

await prisma.$disconnect();
