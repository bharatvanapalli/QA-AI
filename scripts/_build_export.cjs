"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const { PrismaClient } = require(path.join(__dirname, "..", "server", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();
const PROJECT_ID = "4cc6772c-ea93-4c26-b478-48d779d1fccb";
const RUN_ID = "30637d3e-e147-452f-b94f-3bc3c306043e";

async function main() {
  const { buildReplayExport } = require(path.join(__dirname, "..", "server", "services", "codegen", "replayExport"));

  console.log("Building export for run", RUN_ID, "...");
  const result = await buildReplayExport({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    framework: "playwright-reference-js",
    validate: false
  });

  console.log("Export result keys:", Object.keys(result || {}));
  if (result && result.files) {
    console.log("Files generated:", Object.keys(result.files).length);
    Object.keys(result.files).slice(0, 5).forEach(k => {
      const content = result.files[k];
      console.log("  " + k, "(", typeof content === "string" ? content.split("\n").length + " lines)" : typeof content + ")");
    });

    // Write files to disk
    const outDir = path.join(__dirname, "..", "playwright", "runs", RUN_ID);
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(result.files)) {
      if (typeof content === "string") {
        const fpath = path.join(outDir, name);
        fs.mkdirSync(path.dirname(fpath), { recursive: true });
        fs.writeFileSync(fpath, content, "utf8");
      }
    }
    console.log("Files written to", outDir);
  } else {
    console.log("No files in result:", JSON.stringify(result, null, 2).slice(0, 500));
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); console.error(e.stack?.split("\n").slice(0,6).join("\n")); await prisma.$disconnect(); process.exit(1); });
