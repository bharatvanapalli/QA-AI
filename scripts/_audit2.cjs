"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require(path.join(__dirname, "..", "server", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();
const PROJECT_ID = "4cc6772c-ea93-4c26-b478-48d779d1fccb";
const RUN_ID = "30637d3e-e147-452f-b94f-3bc3c306043e";
const USER_ID = "a5d916cd-4178-4bcc-b409-c885a389e843";
const USER_EMAIL = "bharatvanapalli8@gmail.com";

async function main() {
  const results = await prisma.runResult.findMany({
    where: { runId: RUN_ID, replayIrJson: { not: null } },
    select: {
      id: true, status: true, replayIrJson: true,
      testCase: { select: { id: true, name: true, module: true, type: true, declaredAssertions: true, scenario: { select: { id: true, name: true } } } }
    }
  });
  const project = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { framework: true, targetUrl: true, testCredentials: true } });
  console.log("Results with IR:", results.length, "| framework:", project.framework);

  const replayExport = require(path.join(__dirname, "..", "server", "services", "codegen", "replayExport"));
  const outDir = path.join(__dirname, "..", "playwright", "runs", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const built = [];
  for (const r of results) {
    try {
      const ir = JSON.parse(r.replayIrJson);
      const result = await replayExport.buildRunnerForResult({
        r: { envelope: { ir }, caseName: r.testCase?.name || r.id, runResultId: r.id, testCaseId: r.testCase?.id || r.id, scenarioId: r.testCase?.scenario?.id || "s" },
        framework: project.framework || "playwright-js",
        baseUrl: project.targetUrl,
        credentials: {},
        loginPrecondition: null,
        logoutUrl: null,
      });
      if (result && result.spec) {
        const fname = (r.testCase?.name || r.id).replace(/[^a-z0-9]+/gi, "_").slice(0, 70) + ".spec.js";
        fs.writeFileSync(path.join(outDir, fname), result.spec);
        built.push({ fname, status: r.status, content: result.spec });
        console.log("  wrote:", fname, "(", result.spec.split("\n").length, "lines )");
      } else {
        console.log("  SKIP (no spec):", r.testCase?.name, "- result keys:", result ? Object.keys(result).join(",") : "null");
      }
    } catch(e) { console.log("  ERR:", r.testCase?.name, e.message.slice(0,100)); }
  }

  console.log("\nBuilt:", built.length, "spec files\n");

  // Audit each
  let cleanCount = 0;
  for (const { fname, status, content } of built) {
    const roleLocators = (content.match(/getByRole\(/g)||[]).length;
    const textLocators = (content.match(/getByText\(/g)||[]).length;
    const labelLocators = (content.match(/getByLabel\(/g)||[]).length;
    const cssLocators = (content.match(/\.locator\(["'][\.#]/g)||[]).length;
    const hasTest = /(test|it)\s*\(/.test(content);
    const hasExpect = content.includes("expect(");
    const hasAwait = content.includes("await ");
    const hasImport = content.includes("require(") || content.includes("from '@playwright");
    const syntaxOk = !/(SYNTAX ERROR|Duplicate declaration|Missing semicolon)/.test(content);
    const clean = hasTest && hasExpect && hasAwait && hasImport && syntaxOk;
    if (clean) cleanCount++;
    console.log("[" + status.toUpperCase().padEnd(4) + "] " + fname);
    console.log("   " + (clean ? "CLEAN" : "ISSUES") + " | " + (roleLocators+textLocators+labelLocators) + " semantic locators, " + cssLocators + " CSS-class");
    // Print first 40 lines
    content.split("\n").slice(0, 40).forEach((l,i) => console.log("   " + String(i+1).padStart(3) + " | " + l));
    console.log("");
  }
  console.log("=== AUDIT: " + cleanCount + "/" + built.length + " clean ===");
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); console.error(e.stack?.split("\n").slice(0,5).join("\n")); await prisma.$disconnect(); process.exit(1); });
