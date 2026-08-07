"use strict";

function parseJson(value, fallback = null) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch (_) {
    return fallback;
  }
}

function clean(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase();
}

function locatorEntryIsExplicitGuess(entry) {
  if (!entry || typeof entry !== "object") return false;
  const provenance = entry.locatorProvenance || entry.provenance || {};
  const confidence = clean(entry.locatorConfidence || entry.confidence);
  const status = clean(entry.verificationStatus || entry.status);
  const source = clean(
    entry.source ||
      entry.verificationSource ||
      provenance.kind ||
      provenance.source,
  );
  return !!(
    entry.guessedLocator === true ||
    entry.guessed === true ||
    status === "guessed" ||
    status === "unverified" ||
    /guess|unverified/.test(confidence) ||
    /guess|unverified/.test(source)
  );
}

function locatorEntryIsContractBacked(entry) {
  if (!entry || typeof entry !== "object") return false;
  const provenance = entry.locatorProvenance || entry.provenance || {};
  const source = clean(
    entry.source ||
      entry.verificationSource ||
      provenance.kind ||
      provenance.source,
  );
  return source === "authoredassertioncontract" || source === "authored_assertion_contract";
}

function locatorEntryIsUnverified(entry) {
  if (!entry || typeof entry !== "object") return false;
  const proof = entry.proof || entry.verificationProof || {};
  if (locatorEntryIsExplicitGuess(entry) || entry.verified === false) return true;
  return !(proof.sameElement === true && Number(proof.count) === 1);
}

function locatorEntryIsVerified(entry) {
  if (!entry || typeof entry !== "object" || locatorEntryIsUnverified(entry))
    return false;
  const proof = entry.proof || entry.verificationProof || {};
  return proof.sameElement === true && Number(proof.count) === 1;
}

function normalizeLocatorPath(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

function locatorRepositoryFile(value) {
  const normalized = normalizeLocatorPath(value);
  if (!normalized) return "";
  const generated = normalized.match(
    /^locators\/generated\/(.+)\.generated\.locators\.(?:cjs|js|mjs|ts)$/i,
  );
  if (generated) return generated[1];
  const publicFile = normalized.match(
    /^locators\/(.+)\.locators\.(?:cjs|js|mjs|ts)$/i,
  );
  if (publicFile) return publicFile[1];
  return normalized.replace(/\.(?:cjs|js|mjs|ts)$/i, "");
}

function emittedLocatorEntries(files = {}) {
  const generated = Object.entries(files || {}).filter(
    ([rel, content]) =>
      /^locators\/generated\/.+\.generated\.locators\.(?:cjs|js|mjs|ts)$/i.test(rel) &&
      typeof content === "string",
  );
  const candidates = generated.length
    ? generated
    : Object.entries(files || {}).filter(
        ([rel, content]) =>
          /^locators\/.+\.locators\.(?:cjs|js|mjs|ts)$/i.test(rel) &&
          typeof content === "string",
      );
  const entries = [];
  for (const [rel, content] of candidates) {
    const file = locatorRepositoryFile(rel);
    const pattern =
      /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:\s*\(\s*page\s*\)\s*=>/gm;
    let match;
    while ((match = pattern.exec(String(content))) !== null) {
      entries.push({
        file,
        name: match[1] || match[2],
        emittedFile: normalizeLocatorPath(rel),
      });
    }
  }
  return entries;
}

function manifestLocatorIdentity(entry) {
  if (!entry || typeof entry !== "object") return null;
  const file = locatorRepositoryFile(entry.file || entry.locatorFile);
  const name = String(entry.name || entry.locatorName || "").trim();
  return file && name ? { file, name } : null;
}

function locatorIdentityKey(identity) {
  return identity ? `${identity.file}\u0000${identity.name}` : "";
}

function summarizeLocatorReadiness(files = {}) {
  const hasManifest = Object.prototype.hasOwnProperty.call(
    files,
    "evidence/locator-manifest.json",
  );
  const hasReport = Object.prototype.hasOwnProperty.call(
    files,
    "evidence/locator-certification-report.json",
  );
  const locatorFiles = Object.entries(files || {}).filter(
    ([rel, content]) => /^locators\//i.test(rel) && typeof content === "string",
  );
  const hasLocatorFiles = locatorFiles.length > 0;
  const rawManifest = parseJson(files["evidence/locator-manifest.json"], null);
  const manifestEntries = Array.isArray(rawManifest)
    ? rawManifest
    : Array.isArray(rawManifest && rawManifest.entries)
      ? rawManifest.entries
      : [];
  const report = parseJson(
    files["evidence/locator-certification-report.json"],
    null,
  );
  const reportSteps = Array.isArray(report && report.steps) ? report.steps : [];
  const entries = hasManifest ? manifestEntries : reportSteps;
  const emittedEntries = emittedLocatorEntries(files);
  const manifestByKey = new Map();
  const invalidIdentityEntries = [];
  for (const entry of entries) {
    const identity = manifestLocatorIdentity(entry);
    if (!identity) {
      invalidIdentityEntries.push(entry);
      continue;
    }
    const key = locatorIdentityKey(identity);
    const bucket = manifestByKey.get(key) || [];
    bucket.push(entry);
    manifestByKey.set(key, bucket);
  }
  const contractBacked = [...manifestByKey.values()].filter(
    (bucket) => bucket.length > 0 && bucket.every(locatorEntryIsContractBacked),
  ).length + invalidIdentityEntries.filter(locatorEntryIsContractBacked).length;
  const actionManifestByKey = new Map(
    [...manifestByKey.entries()]
      .map(([key, bucket]) => [key, bucket.filter((entry) => !locatorEntryIsContractBacked(entry))])
      .filter(([, bucket]) => bucket.length > 0),
  );
  const actionInvalidIdentityEntries = invalidIdentityEntries.filter(
    (entry) => !locatorEntryIsContractBacked(entry),
  );
  const requiredEntries = emittedEntries.filter((entry) => {
    const bucket = manifestByKey.get(locatorIdentityKey(entry));
    return !bucket || !bucket.every(locatorEntryIsContractBacked);
  });
  const requiredCount = requiredEntries.length;
  const expectedByKey = new Map(
    requiredEntries.map((entry) => [locatorIdentityKey(entry), entry]),
  );
  const missingIdentities = [...expectedByKey.entries()]
    .filter(([key]) => !actionManifestByKey.has(key))
    .map(([, identity]) => ({ file: identity.file, name: identity.name }));
  const unexpectedIdentities = [...actionManifestByKey.entries()]
    .filter(([key]) => !expectedByKey.has(key))
    .map(([key, bucket]) => {
      const identity = manifestLocatorIdentity(bucket[0]);
      return { key, file: identity.file, name: identity.name };
    });
  const duplicateIdentities = [...manifestByKey.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([key, bucket]) => {
      const identity = manifestLocatorIdentity(bucket[0]);
      return { key, file: identity.file, name: identity.name, references: bucket.length };
    });
  const matchedBuckets = [...expectedByKey.keys()]
    .map((key) => actionManifestByKey.get(key))
    .filter(Boolean);
  // A repeated authored action may legitimately reuse the same POM locator.
  // Group those references so they cannot inflate coverage, and require every
  // reference to carry verified action-time proof before the locator is trusted.
  const verified = matchedBuckets.filter(
    (bucket) => bucket.length > 0 && bucket.every(locatorEntryIsVerified),
  ).length;
  const guessed = [...actionManifestByKey.values()].filter((bucket) =>
    bucket.some(locatorEntryIsExplicitGuess),
  ).length + actionInvalidIdentityEntries.filter(locatorEntryIsExplicitGuess).length;
  const total = Math.max(
    requiredCount + contractBacked,
    manifestByKey.size + invalidIdentityEntries.length,
  );
  const unverified = Math.max(requiredCount - verified, guessed);
  const evidencePresent =
    (!hasLocatorFiles && entries.length === 0) ||
    ((hasManifest ? rawManifest !== null : hasReport && report !== null) &&
      entries.length > 0);
  const coverageComplete =
    (!hasLocatorFiles && entries.length === 0) ||
    (hasLocatorFiles &&
      (requiredCount > 0 || contractBacked > 0) &&
      missingIdentities.length === 0 &&
      unexpectedIdentities.length === 0 &&
      actionInvalidIdentityEntries.length === 0);
  return {
    total,
    required: requiredCount,
    identityMatched: requiredCount - missingIdentities.length,
    verified,
    contractBacked,
    unverified,
    guessed,
    duplicateReferences: duplicateIdentities.reduce(
      (count, identity) => count + identity.references - 1,
      0,
    ),
    duplicateIdentities,
    missingIdentities,
    unexpectedIdentities,
    invalidIdentityCount: actionInvalidIdentityEntries.length,
    evidencePresent,
    coverageComplete,
    allVerified:
      evidencePresent &&
      coverageComplete &&
      (requiredCount === 0 || (verified === requiredCount && unverified === 0)),
  };
}

function summarizeScriptReadiness(report, { currentBundleId = null, currentPackageHash = null } = {}) {
  const status = clean(report && report.status);
  const summary = (report && report.summary) || {};
  const total = Number(summary.total) || 0;
  const failed = Number(summary.failed) || 0;
  const runPassed = !!(
    report &&
    ["certified", "healed"].includes(status) &&
    report.certification &&
    report.certification.certified === true &&
    total > 0 &&
    failed === 0
  );
  const bundleMatches = !!(
    report &&
    currentBundleId &&
    String(report.bundleId || "") === String(currentBundleId)
  );
  const packageHashMatches = !!(
    report &&
    currentPackageHash &&
    String(report.packageHash || "") === String(currentPackageHash)
  );
  const current = bundleMatches && packageHashMatches;
  const passed = runPassed && current;
  return {
    status: report ? status || "unknown" : "not_run",
    total,
    failed,
    ran: !!report && !["queued", "running", "preview_only"].includes(status),
    runPassed,
    passed,
    certified: passed,
    bundleMatches,
    packageHashMatches,
    current,
    qualityPassed: !!report && report.outputQuality?.ok === true,
  };
}

function evaluateOutputReadiness({
  outputAvailable,
  preparing = 0,
  failedSafety = 0,
  exportValid,
  packagePassed,
  contractCertification = null,
  contractFindings = [],
  errorFindings = [],
  files = {},
  scriptValidation = null,
  currentBundleId = null,
  currentPackageHash = null,
} = {}) {
  const locator = summarizeLocatorReadiness(files);
  const script = summarizeScriptReadiness(scriptValidation, {
    currentBundleId,
    currentPackageHash,
  });
  const contractErrors = [
    ...(Array.isArray(contractFindings) ? contractFindings : []),
    ...(Array.isArray(errorFindings) ? errorFindings : []),
  ].filter(
    (finding) => finding && clean(finding.severity || "error") === "error",
  );
  const contractPassed =
    !!contractCertification &&
    contractCertification.packagePassed === true &&
    contractErrors.length === 0;
  const downloadable = !!outputAvailable;
  const generated = !!outputAvailable && Number(preparing) === 0;
  const verified =
    exportValid === true &&
    packagePassed === true &&
    contractPassed &&
    locator.allVerified &&
    script.qualityPassed;
  const runnable = downloadable && generated && verified && script.passed;
  const certified = downloadable && generated && verified && runnable;
  const gaps = [];
  if (exportValid !== true) gaps.push("export_not_validated");
  if (packagePassed !== true) gaps.push("package_not_passed");
  if (!contractCertification || contractCertification.packagePassed !== true)
    gaps.push("contract_not_certified");
  if (contractErrors.length > 0) gaps.push("contract_errors");
  if (!locator.allVerified) gaps.push("locator_evidence_unverified");
  if (!scriptValidation) gaps.push("script_not_run");
  else if (!script.current) gaps.push("script_validation_stale");
  else if (!script.runPassed)
    gaps.push(
      script.status === "preview_only"
        ? "script_not_run"
        : "script_validation_failed",
    );
  if (scriptValidation && script.qualityPassed === false)
    gaps.push("generated_output_quality_failed");
  if (Number(failedSafety) > 0) gaps.push("safety_findings_redacted");
  return {
    available: !!outputAvailable,
    downloadable,
    generated,
    verified,
    runnable,
    certified,
    locator,
    script,
    gaps: [...new Set(gaps)],
  };
}

module.exports = {
  evaluateOutputReadiness,
  locatorEntryIsUnverified,
  locatorEntryIsVerified,
  emittedLocatorEntries,
  summarizeLocatorReadiness,
  summarizeScriptReadiness,
};
