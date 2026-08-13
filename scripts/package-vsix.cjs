'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Simple pure-node zip generator for VSIX packaging
// A .vsix file is a standard ZIP containing extension/package.json and extension/extension.js
// We can use PowerShell Compress-Archive to build qaai-copilot-bridge-1.0.0.vsix natively on Windows!

const rootDir = path.resolve(__dirname, '..');
const extDir = path.join(rootDir, 'vscode-copilot-bridge');
const tempStagingDir = path.join(rootDir, 'vscode-copilot-bridge-staging');
const extensionSubDir = path.join(tempStagingDir, 'extension');
const outputFile = path.join(rootDir, 'qaai-copilot-bridge-1.0.0.vsix');

if (fs.existsSync(tempStagingDir)) {
  fs.rmSync(tempStagingDir, { recursive: true, force: true });
}
fs.mkdirSync(extensionSubDir, { recursive: true });

// Copy package.json and extension.js to extensionSubDir
fs.copyFileSync(path.join(extDir, 'package.json'), path.join(extensionSubDir, 'package.json'));
fs.copyFileSync(path.join(extDir, 'extension.js'), path.join(extensionSubDir, 'extension.js'));

// Create [Content_Types].xml
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>`;
fs.writeFileSync(path.join(tempStagingDir, '[Content_Types].xml'), contentTypesXml, 'utf8');

// Compress staging dir into .vsix using PowerShell Compress-Archive
const tempZip = path.join(rootDir, 'qaai-copilot-bridge-1.0.0.zip');
if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

const psCommand = `Compress-Archive -Path "${tempStagingDir}\\*" -DestinationPath "${tempZip}" -Force`;
execSync(`powershell -NoProfile -Command "${psCommand}"`, { stdio: 'inherit' });

fs.renameSync(tempZip, outputFile);

// Cleanup temp staging
fs.rmSync(tempStagingDir, { recursive: true, force: true });

console.log(`\nSuccessfully created VSIX package: ${outputFile} (${fs.statSync(outputFile).size} bytes)`);
