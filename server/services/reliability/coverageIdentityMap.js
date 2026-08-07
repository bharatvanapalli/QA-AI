'use strict';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(arr(values).map(clean).filter(Boolean)));
}

function coverageRefOf(item = {}) {
  return clean(item.coverageRef || item.manifestItemId || item.id || item.coverageItemId);
}

function storyIdOf(item = {}) {
  return clean(item.storyId || item.requirementId || (item.storyRef && item.storyRef.id));
}

function moduleOf(item = {}) {
  return clean(item.module || (item.storyRef && item.storyRef.moduleHint));
}

function titleOf(item = {}) {
  return clean(item.title || (item.storyRef && item.storyRef.title) || item.name);
}

function aliasCandidatesForItem(item = {}) {
  const title = titleOf(item);
  const moduleName = moduleOf(item);
  const fields = arr(item.requiredFields).map(slug).filter(Boolean);
  const titleSlug = slug(title);
  const moduleSlug = slug(moduleName);
  const candidates = [
    item.friendlyAlias,
    item.alias,
    ...(arr(item.benchmarkAliases)),
    coverageRefOf(item),
    storyIdOf(item),
    titleSlug,
    moduleSlug && titleSlug ? `${moduleSlug}-${titleSlug}` : null,
  ];

  const text = `${title} ${moduleName}`.toLowerCase();
  if (/\badmin\b/.test(text) && /\bsystem\s+user\b|\buser\s+search\b|\bsearch\b/.test(text)) {
    candidates.push('admin-system-user-search');
  }
  if (/\bclaim\b/.test(text) && /\bvalidat/.test(text)) {
    candidates.push('claim-validation');
  }
  if (/\bpim\b|\bemployee\b/.test(text) && /\blifecycle\b|\badd\b|\bpersonal\s+details\b/.test(text)) {
    candidates.push('pim-employee-lifecycle');
  }
  if (/\blogin\b|\bauth\b|\bsign\s*in\b/.test(text)) {
    candidates.push('login-dashboard');
  }
  if (/\bleave\b/.test(text) && /\bassign\b/.test(text)) {
    candidates.push('assign-leave-validation');
  }
  if (/\bleave\b/.test(text) && /\blist\b|\bfilter\b/.test(text)) {
    candidates.push('leave-list-filters');
  }
  if (fields.length && moduleSlug) {
    candidates.push(`${moduleSlug}-${fields.slice(0, 3).join('-')}`);
  }

  return unique(candidates);
}

function identityForItem(item = {}) {
  const coverageRef = coverageRefOf(item);
  if (!coverageRef) return null;
  const aliases = aliasCandidatesForItem(item).filter((value) => norm(value) !== norm(coverageRef));
  return {
    coverageRef,
    requirementId: clean(item.requirementId || item.reqId || undefined) || undefined,
    storyId: storyIdOf(item) || undefined,
    friendlyAlias: clean(item.friendlyAlias || aliases[0] || undefined) || undefined,
    module: moduleOf(item) || undefined,
    title: titleOf(item) || undefined,
    benchmarkAliases: unique(aliases),
  };
}

function entriesFromManifest(manifest = {}) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest.items)) return manifest.items;
  if (Array.isArray(manifest.requiredCoverage)) return manifest.requiredCoverage;
  if (manifest.coverageManifest && Array.isArray(manifest.coverageManifest.items)) return manifest.coverageManifest.items;
  return [];
}

function buildCoverageIdentityMap(manifest = {}) {
  const byRef = new Map();
  const byAlias = new Map();
  for (const item of entriesFromManifest(manifest)) {
    const identity = identityForItem(item);
    if (!identity) continue;
    const prior = byRef.get(identity.coverageRef) || {};
    const merged = {
      ...prior,
      ...identity,
      benchmarkAliases: unique([...(prior.benchmarkAliases || []), ...(identity.benchmarkAliases || [])]),
    };
    byRef.set(merged.coverageRef, merged);
    const refs = [
      merged.coverageRef,
      merged.requirementId,
      merged.storyId,
      merged.friendlyAlias,
      merged.title,
      ...(merged.benchmarkAliases || []),
    ];
    for (const ref of refs) {
      const key = norm(ref);
      if (key) byAlias.set(key, merged.coverageRef);
    }
  }
  return {
    byRef,
    byAlias,
    identities: Array.from(byRef.values()),
  };
}

function ensureMap(identityMapOrManifest) {
  if (identityMapOrManifest && identityMapOrManifest.byRef && identityMapOrManifest.byAlias) return identityMapOrManifest;
  return buildCoverageIdentityMap(identityMapOrManifest || {});
}

function resolveCoverageRef(inputRef, identityMapOrManifest) {
  const value = clean(inputRef);
  if (!value) return '';
  const identityMap = ensureMap(identityMapOrManifest);
  if (identityMap.byRef.has(value)) return value;
  return identityMap.byAlias.get(norm(value)) || value;
}

function coverageAliasesFor(inputRef, identityMapOrManifest) {
  const identityMap = ensureMap(identityMapOrManifest);
  const resolved = resolveCoverageRef(inputRef, identityMap);
  const identity = identityMap.byRef.get(resolved);
  if (!identity) return unique([inputRef]);
  return unique([
    identity.coverageRef,
    identity.requirementId,
    identity.storyId,
    identity.friendlyAlias,
    identity.title,
    ...(identity.benchmarkAliases || []),
  ]);
}

function normalizeCoverageRefs(refs, identityMapOrManifest) {
  const identityMap = ensureMap(identityMapOrManifest);
  return unique(arr(refs).map((ref) => resolveCoverageRef(ref, identityMap)));
}

function textOfCase(caseObj = {}) {
  const quality = caseObj.qualityContract && typeof caseObj.qualityContract === 'object' ? caseObj.qualityContract : {};
  const phase = quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : {};
  return [
    caseObj.name,
    caseObj.title,
    caseObj.caseIntent,
    caseObj.module,
    phase.title,
    phase.coverageTitle,
    ...(arr(caseObj.coverageRefs)),
    ...(arr(caseObj.requirementRefs)),
    ...(arr(phase.coverageRefs)),
    ...(arr(phase.coverageAliases)),
  ].map(clean).join(' ');
}

function refsOfCase(caseObj = {}) {
  const quality = caseObj.qualityContract && typeof caseObj.qualityContract === 'object' ? caseObj.qualityContract : {};
  const phase = quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : {};
  return unique([
    ...(arr(caseObj.coverageRefs)),
    ...(arr(caseObj.requirementRefs)),
    ...(arr(phase.coverageRefs)),
    ...(arr(phase.coverageAliases)),
  ]);
}

function caseMatchesCoverage(caseObj = {}, expectedRef, identityMapOrManifest) {
  const identityMap = ensureMap(identityMapOrManifest);
  const expectedResolved = resolveCoverageRef(expectedRef, identityMap);
  const expectedAliases = new Set(coverageAliasesFor(expectedRef, identityMap).map(norm));
  for (const ref of refsOfCase(caseObj)) {
    const resolved = resolveCoverageRef(ref, identityMap);
    if (resolved === expectedResolved || expectedAliases.has(norm(ref)) || expectedAliases.has(norm(resolved))) return true;
  }
  return false;
}

module.exports = {
  buildCoverageIdentityMap,
  resolveCoverageRef,
  coverageAliasesFor,
  caseMatchesCoverage,
  normalizeCoverageRefs,
};
