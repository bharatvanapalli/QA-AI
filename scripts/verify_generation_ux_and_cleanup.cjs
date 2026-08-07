const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`[OK] ${message}`);
  }
}

const runSuite = read('src/pages/RunSuite.jsx');
const testCases = read('src/pages/TestCases.jsx');
const scenariosRoute = read('server/routes/scenarios.js');

assert(
  testCases.includes('export function GenerateConfigCard'),
  'Tests generation chooser is exported for shared use',
);

assert(
  runSuite.includes("import { GenerateConfigCard } from './TestCases';"),
  'Run Suite imports the shared generation chooser',
);

assert(
  runSuite.includes('const [showGenerationConfig, setShowGenerationConfig] = useState(false);'),
  'Run Suite tracks whether the chooser is open',
);

assert(
  runSuite.includes('onClick={handleOpenGenerationConfig}'),
  'Run Suite header regenerate button opens the chooser',
);

assert(
  runSuite.includes('<GenerateConfigCard') && runSuite.includes('onGenerate={handleGenerate}'),
  'Run Suite renders the chooser and routes confirmed selections into generation',
);

assert(
  !runSuite.includes('[GENERATION MODE — Complete]: Rebuild test cases from the current Run Suite source queue.'),
  'Run Suite no longer hardcodes immediate Complete rebuild guidance',
);

assert(
  scenariosRoute.includes('isCurrent: false'),
  'Fresh generation is created as a non-current draft',
);

assert(
  scenariosRoute.includes('Generation produced no persistable test cases; previous generation was left unchanged.'),
  'Persist path rejects empty generated suites',
);

assert(
  scenariosRoute.includes('where: { generationId: generation.id, projectId: project.id }'),
  'Failed fresh generation cleans up all draft scenarios by generation id',
);

const createIndex = scenariosRoute.indexOf('generation = await prisma.scenarioGeneration.create');
const coverageIndex = scenariosRoute.indexOf('await writeGenerationCoverage(prisma, generation.id');
const promoteIndex = scenariosRoute.indexOf('await prisma.scenarioGeneration.updateMany', coverageIndex);

assert(
  createIndex !== -1 && coverageIndex !== -1 && promoteIndex > coverageIndex && promoteIndex > createIndex,
  'Fresh generation is promoted only after persisted counts and coverage write',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('[OK] generation UX and cleanup trigger checks passed');
