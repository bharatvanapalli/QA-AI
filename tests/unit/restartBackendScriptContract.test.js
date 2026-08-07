import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'scripts/restart-backend.ps1');

function restartScriptSource() {
  return fs.readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n');
}

describe('restart-backend process ownership contract', () => {
  it('stops only the verified QAAI owner and accepts health only from the new child PID', () => {
    const source = restartScriptSource();
    const stopIndex = source.indexOf('Stop-Process');
    const launch = source.match(/(\$[A-Za-z_][A-Za-z0-9_]*)\s*=\s*Start-Process\b([\s\S]{0,800}?)-PassThru\b/i);

    expect(stopIndex).toBeGreaterThan(-1);
    expect(launch, 'Start-Process must be captured and use -PassThru').not.toBeNull();

    const launchIndex = launch.index;
    const preStop = source.slice(0, stopIndex);
    const releaseGate = source.slice(stopIndex, launchIndex);

    expect(launchIndex).toBeGreaterThan(stopIndex);
    expect(source).toMatch(/function\s+Get-PortOwnerPids\b/i);
    expect(source).toMatch(/(?:Get-NetTCPConnection|netstat(?:\.exe)?)\b/i);
    expect(source).toMatch(/(?:OwningProcess|LISTENING|Listen)\b/i);
    expect(preStop).toMatch(/Get-(?:CimInstance\s+Win32_Process|Process)\b/i);
    expect(preStop).toMatch(/\bnode(?:\.exe)?\b/i);
    expect(preStop).toMatch(/server[\\/]index\.js/i);

    expect(releaseGate).toMatch(/\b(?:do|while)\b/i);
    expect(releaseGate).toMatch(/Get-PortOwnerPids\b/i);
    expect(releaseGate).toMatch(/(?:deadline|timeout|release)/i);

    const childVariable = launch[1];
    const childIdPattern = new RegExp(`${childVariable.replace('$', '\\$')}\\.Id\\b`, 'i');
    const successIndex = source.indexOf('Backend healthy', launchIndex);
    const ownershipBeforeSuccess = source.slice(launchIndex, successIndex);

    expect(successIndex).toBeGreaterThan(launchIndex);
    expect(ownershipBeforeSuccess).toMatch(/Get-PortOwnerPids\b/i);
    expect(ownershipBeforeSuccess).toMatch(childIdPattern);
    expect(ownershipBeforeSuccess).toMatch(/(?:-eq|-ne|-contains)\b/i);
  });
});
