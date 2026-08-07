'use strict';

const crypto = require('node:crypto');

function appendDesignSlug(value) {
  const text = String(value || '').trim();
  return `sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function appendDesignTitle(value) {
  const text = String(value || '').trim();
  if (!text) return 'User requested scenario';
  const lineValue = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'im');
    const match = text.match(re);
    return match ? String(match[1] || '').trim() : '';
  };
  const explicit = lineValue('Suite') || lineValue('New test case') || lineValue('Test case');
  if (explicit) return explicit.replace(/^TC-\d+\s*-\s*/i, '').trim().slice(0, 120) || 'User requested scenario';
  const firstFlowLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^(test steps|inline test data|dependency and session contract|starting state)\s*:?$/i.test(line));
  return (firstFlowLine || 'User requested scenario').slice(0, 120);
}

function buildAppendDesignRequirement(project, appendDesignText) {
  const text = String(appendDesignText || '').trim();
  if (!text) return null;
  const projectId = project && project.id ? String(project.id) : 'project';
  const id = `append-design:${projectId}:${appendDesignSlug(text)}`;
  const title = appendDesignTitle(text);
  return {
    id,
    projectId,
    title,
    name: title,
    content: text,
    body: text,
    text,
    category: 'user-stories',
    source: 'add_scenario',
    sourceType: 'USER_STORY',
  };
}

function buildAppendRequirementClause(appendRequirement) {
  if (!appendRequirement) return null;
  const text = String(appendRequirement.content || appendRequirement.text || '').trim();
  if (!text) return null;
  return {
    id: `${appendRequirement.id}:clause-1`,
    requirementId: appendRequirement.id,
    storyId: appendRequirement.id,
    title: appendRequirement.title || 'User requested scenario',
    behaviourText: text,
    text,
    description: text,
    excerpt: text.slice(0, 1200),
    moduleHint: null,
    sourceType: 'USER_STORY',
    source: 'add_scenario',
    testable: true,
    verified: true,
  };
}

/**
 * Pure request boundary shared by the HTTP route and integration tests.
 * `appendToCurrent` is intentionally strict: only JSON boolean true selects
 * Add Scenario semantics, matching the public route contract.
 */
function buildAppendScenarioRequest(project, payload = {}) {
  const appendToCurrent = payload && payload.appendToCurrent === true;
  const sessionGuidance = String(payload && payload.sessionGuidance || '').trim();
  const requirement = appendToCurrent
    ? buildAppendDesignRequirement(project, sessionGuidance)
    : null;
  return {
    appendToCurrent,
    sessionGuidance,
    requirement,
    requirementClause: buildAppendRequirementClause(requirement),
  };
}

module.exports = {
  buildAppendDesignRequirement,
  buildAppendRequirementClause,
  buildAppendScenarioRequest,
};
