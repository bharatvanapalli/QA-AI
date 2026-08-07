'use strict';

/**
 * Launch the locally-installed VS Code at a folder, for the "Open in VS Code"
 * feature. This only makes sense when the QAAI server runs on the same machine
 * as the user's VS Code (the current single-tenant / localhost deployment).
 *
 * Security: the target path originates from a per-project setting the operator
 * typed. It is validated in the route (no shell metacharacters) and again here.
 * We launch detached so closing the request doesn't kill the editor.
 */

const { spawn, execFileSync } = require('child_process');

// Locate the `code` CLI. On Windows it's `code.cmd` resolved via PATHEXT; on
// macOS/Linux it's `code` on PATH. Returns the resolved path or null.
function findCodeCommand() {
  const isWin = process.platform === 'win32';
  const finder = isWin ? 'where' : 'which';
  const names = isWin ? ['code.cmd', 'code'] : ['code'];
  for (const name of names) {
    try {
      const out = execFileSync(finder, [name], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
        .toString()
        .trim();
      if (out) return out.split(/\r?\n/)[0].trim();
    } catch {
      /* not found via this name — try the next */
    }
  }
  return null;
}

// Reject anything that could break out of the quoted command we build below.
function pathIsSafe(p) {
  return typeof p === 'string' && p.length > 0 && !/["'`;&|$\n\r]/.test(p);
}

/**
 * Open `targetDir` in VS Code.
 * @returns {{ ok: true, launcher: string } | { ok: false, code: string, message?: string }}
 */
function openInVsCode(targetDir) {
  if (!pathIsSafe(targetDir)) return { ok: false, code: 'BAD_PATH' };
  const code = findCodeCommand();
  if (!code) return { ok: false, code: 'NO_CODE_CLI' };
  try {
    // shell:true so Windows resolves the .cmd shim; we pass a single,
    // fully-quoted command string and have already rejected shell metachars
    // in both the path and (via where/which output) the launcher.
    // --reuse-window: if VS Code already has this folder open, reload it
    // (instead of silently focusing the existing stale session).
    const command = `"${code}" --reuse-window "${targetDir}"`;
    const child = spawn(command, {
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    });
    child.unref();
    return { ok: true, launcher: code };
  } catch (e) {
    return { ok: false, code: 'LAUNCH_FAILED', message: e.message };
  }
}

module.exports = { findCodeCommand, openInVsCode, pathIsSafe };
