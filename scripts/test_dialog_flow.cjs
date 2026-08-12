"use strict";
const path = require("path");
const root = path.resolve(__dirname, "..");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const http = require("http");

async function main() {
  const project = await prisma.project.findFirst();
  const tc = await prisma.testCase.findFirst({
    where: { name: { contains: "Dialog" } }
  });
  console.log("Found project:", project.id);
  console.log("Found test case:", tc.id, tc.name);

  // Trigger run via API
  const postData = JSON.stringify({ testCaseIds: [tc.id] });
  const req = http.request(`http://localhost:5000/api/projects/${project.id}/agents/run-smoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
      "x-csrf-token": "disabled"
    }
  }, (res) => {
    let body = "";
    res.on("data", (chunk) => body += chunk);
    res.on("end", () => {
      console.log("Run trigger response:", res.statusCode, body);
    });
  });
  req.on("error", console.error);
  req.write(postData);
  req.end();
}
main().catch(console.error).finally(() => prisma.$disconnect());
