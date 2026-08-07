// QAAI preflight — verifies the target environment is reachable before tests run.
// A failure HERE means the site under test is down/blocked, NOT that the script is broken.
module.exports = async function globalSetup() {
  const url = process.env.QAAI_TARGET_URL;
  if (!url) {
    throw new Error('QAAI preflight: QAAI_TARGET_URL is not set. Copy .env.example to .env and set QAAI_TARGET_URL (see EXPORT_MANIFEST.json for the source run).');
  }
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (res.status >= 500) {
      throw new Error('QAAI preflight: target ' + url + ' returned HTTP ' + res.status + ' — the environment under test is DOWN, not the script.');
    }
  } catch (err) {
    if (err && /HTTP \d/.test(err.message)) throw err;
    throw new Error('QAAI preflight: target ' + url + ' is UNREACHABLE (' + (err && err.message) + '). The environment under test is down or blocked from this machine — this is NOT a script defect.');
  }
};
