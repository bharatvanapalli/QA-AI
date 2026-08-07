'use strict';
const prisma = require('../server/prisma');
const caseContractV1 = require('../server/services/caseContractV1');
const { encodeJson } = require('../server/services/jsonField');

const SCENARIO_URL_MAP = {
  'Edit Fields': 'https://letcode.in/edit',
  'Click Actions': 'https://letcode.in/buttons',
  'Drop-Down': 'https://letcode.in/dropdowns',
  'Dialog Box': 'https://letcode.in/alert',
  'Nested Frames': 'https://letcode.in/frame',
  'Toggle States': 'https://letcode.in/radio',
  'Tabs Handler': 'https://letcode.in/windows',
  'Find Elements': 'https://letcode.in/elements',
  'AUI - Drag': 'https://letcode.in/draggable',
  'AUI - Drop': 'https://letcode.in/dropable',
  'AUI - Sort': 'https://letcode.in/sortable',
  'AUI - Selectable': 'https://letcode.in/selectable',
  'AUI - Slider': 'https://letcode.in/slider',
  'Timeouts': 'https://letcode.in/waits',
  'WebTable': 'https://letcode.in/table',
  'Advanced Table': 'https://letcode.in/advancedtable',
  'Date Pickers': 'https://letcode.in/calendar',
  'Form Inputs': 'https://letcode.in/forms',
  'File Operations': 'https://letcode.in/file',
  'DOM Elements': 'https://letcode.in/shadow',
};

function extractTargetAndValue(cleanText, lastStepTarget = null) {
  const matches = [...cleanText.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  let value = null;
  let rawTargetLabel = null;
  let isQuotedTarget = false;

  if (/\bappend\b/i.test(cleanText)) {
    value = matches[0] || ' and I enjoy automation';
    rawTargetLabel = 'Append a text';
    isQuotedTarget = true;
  } else if (matches.length >= 2) {
    value = matches[0];
    rawTargetLabel = matches[1];
    isQuotedTarget = true;
  } else if (matches.length === 1) {
    if (/\b(enter|type|input|fill|select|choose)\b/i.test(cleanText)) {
      value = matches[0];
      const prepMatch = cleanText.match(/\b(?:in|on|for|at|into|to)\b\s+(?:the\s+)?([^".]+)/i);
      if (prepMatch) {
        rawTargetLabel = prepMatch[1].trim();
        isQuotedTarget = false;
      } else {
        rawTargetLabel = matches[0];
        isQuotedTarget = true;
      }
    } else {
      rawTargetLabel = matches[0];
      isQuotedTarget = true;
    }
  } else {
    // No quotes found in sentence
    rawTargetLabel = lastStepTarget || cleanText;
    isQuotedTarget = Boolean(lastStepTarget);
  }

  let targetLabel = String(rawTargetLabel || '').replace(/"/g, '').replace(/\s+/g, ' ').trim();

  if (!isQuotedTarget) {
    targetLabel = targetLabel
      .replace(/^\s*(click|enter|select|choose|check|type|input|press|hover|drag|drop|confirm|verify|assert)\s+(the|a|an)?\s*/i, '')
      .replace(/\b(confirm|verify|assert|should|expect|validate|check|alert|is|was|are|were|the|field|value|text|contains|moves|away|from|edited|empty|disabled|readonly|cannot|be)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!targetLabel || targetLabel.length < 3 || targetLabel === 'Target Element') {
    targetLabel = lastStepTarget || 'Target Element';
  }

  targetLabel = targetLabel.slice(0, 60).trim() || 'Target Element';

  return { value, targetLabel };
}

function compileScenarioIntoSingleTestCase(scenarioLines, targetUrl) {
  const steps = [];
  const assertions = [];

  let stepIdx = 1;
  let assertIdx = 1;

  // Single initial Navigate step for the entire scenario
  steps.push({
    id: `step-0`,
    type: 'Navigate',
    targetIdentity: null,
    value: targetUrl,
    action: `Navigate to ${targetUrl}`,
  });

  for (const rawLine of scenarioLines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip section structural headers & metadata lines
    if (/^\s*(Scenario \d+|Test Data|Precondition|Steps|Expected Results|Path)\s*:/i.test(line)) continue;
    if (/^\s*Test Case \d+\.\d+/i.test(line)) continue;
    if (/^\s*[-*•]\s+\w+\s*:\s+/.test(line)) continue;

    const lineContent = line.replace(/^\s*(\d+\.|[-*•])\s*/, '').trim();

    // Is Assertion / Expected Result / Inspection?
    if (/^(verify|assert|should|expect|confirm|validate|check|inspect|read)\b/i.test(lineContent)) {
      const cleanText = lineContent.replace(/^(verify|assert|should|expect|confirm|validate|check|inspect|read)\s*/i, '').trim();
      const lastStepTarget = steps.length ? (steps[steps.length - 1].targetIdentity?.label || null) : null;
      const matches = [...cleanText.matchAll(/"([^"]+)"/g)].map(m => m[1]);

      let type = 'AssertVisible';
      let value = null;
      let targetLabel = lastStepTarget || 'Target Element';

      if (/\b(disabled|readonly|not editable)\b/i.test(lineContent)) {
        type = 'AssertDisabled';
        if (matches.length === 1 && !/\b(its value|value is)\b/i.test(lineContent)) targetLabel = matches[0];
        else if (matches.length >= 2) targetLabel = matches[1];
        else {
          const { targetLabel: extracted } = extractTargetAndValue(cleanText, lastStepTarget);
          targetLabel = extracted;
        }
      } else if (/\b(value|contains|is|equals)\b/i.test(lineContent) && matches.length >= 1) {
        type = 'AssertValue';
        value = matches[0];
        if (matches.length >= 2) {
          targetLabel = matches[1];
        } else {
          targetLabel = lastStepTarget || 'Target Element';
        }
      } else {
        const { targetLabel: extracted } = extractTargetAndValue(cleanText, lastStepTarget);
        targetLabel = extracted;
      }

      assertions.push({
        id: `assert-${assertIdx++}`,
        type,
        targetIdentity: { label: targetLabel, accessibleName: targetLabel },
        value,
        text: cleanText,
        criticality: 'must',
        verify: {
          kind: type === 'AssertValue' ? 'value' : (type === 'AssertDisabled' ? 'state' : 'visible'),
          state: type === 'AssertDisabled' ? 'disabled' : undefined,
          value: value || undefined,
          element: { name: targetLabel },
        },
      });
    }
    // Is Step?
    else {
      const cleanText = lineContent;
      const { value: extractedVal, targetLabel } = extractTargetAndValue(cleanText);

      let type = 'Click';
      let value = extractedVal;
      let selection = null;
      let targetIdentity = { label: targetLabel, accessibleName: targetLabel };

      if (/\b(enter|type|input|append|fill)\b/i.test(cleanText)) {
        type = 'Type';
      } else if (/\b(clear)\b/i.test(cleanText)) {
        type = 'Clear';
        value = null;
      } else if (/\b(select|choose)\b/i.test(cleanText)) {
        type = 'Select';
        value = value || 'Selected Option';
        selection = { kind: 'exact_text', value };
      } else if (/\b(drag|drop|sort|move)\b/i.test(cleanText)) {
        type = 'DragAndDrop';
      } else if (/\b(press|tab|key)\b/i.test(cleanText)) {
        type = 'PressKey';
        value = 'Tab';
        targetIdentity = null;
      } else if (/\b(hover|inspect|read|check)\b/i.test(cleanText)) {
        type = 'Hover';
      }

      const stepObj = {
        id: `step-${stepIdx++}`,
        type,
        targetIdentity,
        action: cleanText,
      };
      if (value != null) stepObj.value = value;
      if (selection) {
        stepObj.selection = selection;
        stepObj.selectionCriteria = selection;
      }

      steps.push(stepObj);
    }
  }

  if (assertions.length === 0 && steps.length > 0) {
    const lastStepTarget = steps[steps.length - 1].targetIdentity?.label || 'Target Element';
    assertions.push({
      id: `assert-${assertIdx++}`,
      type: 'AssertVisible',
      targetIdentity: { label: lastStepTarget, accessibleName: lastStepTarget },
      value: null,
      text: `Verify result of: ${steps[steps.length - 1].action}`,
      criticality: 'must',
      verify: { kind: 'visible', element: { name: lastStepTarget } },
    });
  }

  return { steps, assertions };
}

(async () => {
  try {
    const project = await prisma.project.findFirst({
      where: { name: { contains: 'letcode' } },
      include: { requirements: true },
    });

    if (!project) {
      console.error('Project letcode not found!');
      process.exit(1);
    }

    const requirement = project.requirements[0];
    const reqContent = requirement.content;
    const lines = reqContent.split(/\r?\n/);

    const scenarioRanges = caseContractV1._private.findScenarioRanges(lines);

    console.log(`Building 20 scenarios, each containing 1 comprehensive end-to-end Test Case...`);

    // Delete any old cases/scenarios/generations for letcode
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.testScenario.deleteMany({ where: { projectId: project.id } });
    await prisma.scenarioGeneration.deleteMany({ where: { projectId: project.id } });

    // Create current ScenarioGeneration record
    const generation = await prisma.scenarioGeneration.create({
      data: {
        projectId: project.id,
        version: 1,
        isCurrent: true,
        scenarioCount: scenarioRanges.length,
        caseCount: scenarioRanges.length,
        label: `LetCode User Flow v1`,
      },
    });

    let scnCounter = 0;
    let caseCounter = 0;

    for (let sIdx = 0; sIdx < scenarioRanges.length; sIdx += 1) {
      const sRange = scenarioRanges[sIdx];
      const targetUrl = SCENARIO_URL_MAP[sRange.name] || 'https://letcode.in/test';
      const scenarioLines = lines.slice(sRange.start, sRange.end);

      const scenarioRow = await prisma.testScenario.create({
        data: {
          projectId: project.id,
          generationId: generation.id,
          name: sRange.name || `Scenario ${sIdx + 1}`,
          module: sRange.name || 'General',
          priority: 'high',
          category: 'e2e',
          rationale: `Authored user-flow scenario for ${sRange.name}`,
          dependencyOn: encodeJson([]),
        },
      });
      scnCounter += 1;

      const compiled = compileScenarioIntoSingleTestCase(scenarioLines, targetUrl);
      const requirementRefs = [requirement.id, sRange.name];

      await prisma.testCase.create({
        data: {
          projectId: project.id,
          scenarioId: scenarioRow.id,
          generationId: generation.id,
          name: `${sRange.name} End-to-End Flow`,
          type: 'functional',
          confidence: 100,
          module: sRange.name || 'General',
          status: 'approved',
          automatability: 'automatable',
          readinessStatus: 'ready',
          approvalEligibility: 'eligible',
          runEligibility: 'eligible',
          requirementRefs: encodeJson(requirementRefs),
          steps: encodeJson(compiled.steps),
          assertions: encodeJson(compiled.assertions),
          declaredAssertions: encodeJson(compiled.assertions.map(a => a.text)),
        },
      });
      caseCounter += 1;
    }

    console.log(`\nSUCCESS: Persisted ${scnCounter} scenarios and ${caseCounter} end-to-end test cases under Generation ID: ${generation.id}`);

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error during generation persistence:', err);
    process.exit(1);
  }
})();
