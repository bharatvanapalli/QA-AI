# Replay harness — corpus + checks

Phase H Stage 2 is the scaffolding under this directory:
`corpus/capture.cjs` snapshots Run + RunResult identity rows from the live
SQLite DB into `corpus/baseline.json`; `runner/index.cjs` iterates the
captured runIds (or `--runIds=` ad-hoc) and runs each registered check.

Until Stage 2 (audit-sweep 2026-05-29) this was a parking lot for ad-hoc,
telemetry-driven verifications that paid for themselves during Phase H
stages 0.5 / 1.2 / 1.3.

## How to use

```
# 1. Snapshot the current DB into corpus/baseline.json
node scripts/replay/corpus/capture.cjs

# 2. Run all checks against the corpus
node scripts/replay/runner/index.cjs

# 3. Run one check, filter by classification
node scripts/replay/runner/index.cjs --check=step-verdict-emissions --filter=mixed-pass-fail

# 4. Ad-hoc runIds (skip corpus)
node scripts/replay/runner/index.cjs --runIds=ID1,ID2

# 5. Machine-readable
node scripts/replay/runner/index.cjs --json
```

Exit code is 0 when every check passed against every targeted run, 1 when
any failed, 2 when the harness itself couldn't start (missing corpus,
unregistered check name, etc.).

## Why this exists

Phase H operates on the principle that **cost claims and correctness
claims require evidence**, and the cheapest evidence is replaying recorded
agent runs against candidate code paths. Live runs against real SUTs are
slow, lossy, and burn tokens; recorded runs are deterministic, fast, and
free. The "rich trace" telemetry shipped in Stage 0.5
(`RunResult.richTraceFile`) is the substrate.

The first concrete payoff: `checks/f32-dedupe-still-needed.cjs`, written
in 20 minutes during Stage 1.2 to verify a deletion was safe BEFORE
shipping it. The verifier found the deletion would have regressed all 3
known-passing fixtures, the deletion was reverted, and the discovery
itself became evidence that this directory should be a first-class part
of the project's engineering practice — not a scripts/ scratch space.

## Layout (forward-looking)

```
scripts/replay/
  README.md          ← this file
  checks/            ← individual replay-based verifications
                       Each file: standalone CommonJS, runs against a
                       runId (or a corpus of them), exits 0 = pass /
                       non-0 = regression.
  corpus/            ← (Stage 2) pinned fixture runIds + their classification
                       (known-failure / known-pass / edge-case)
  runner/            ← (Stage 2) batch-execute all checks against the
                       corpus and emit a CI-friendly report
```

For now only `checks/` is populated. The runner + structured corpus
metadata land when Stage 2 ships.

## Conventions for new checks

1. **Self-contained.** One file per check; no shared library yet.
2. **Read-only.** Never write to `RunResult`, `Run`, or any DB row. Telemetry
   files on disk are read-only too. A check that needs to mutate state
   is not a replay check — it's a migration or a test.
3. **Cheap.** A replay check that takes > 30 s isn't paying for itself.
   The harness should answer hundreds of questions in seconds, not handfuls
   in minutes.
4. **Deterministic.** Same input run → same verdict every time. If a check
   depends on wall-clock or random state, that's a bug.
5. **Exit code.** 0 = all targets in the run pass the check, non-zero =
   at least one target fails. `process.exit(allSafe ? 0 : 1)` is the
   minimum interface every check must honour.
6. **One question per file.** Don't bundle "does deletion X regress" with
   "does feature Y land cleanly" into one script. Stage 2's runner will
   parallelise per-check; bundling kills the parallelism.

## Existing checks

| File | Question | Discovered |
|---|---|---|
| `checks/f32-dedupe-still-needed.cjs` | Would deleting the F.3.2 dedupe-by-latest patch regress any case in the given run? | 3/3 fixtures depend on it (Stage 1.2, 2026-05-28) |
| `checks/step-verdict-emissions.cjs` | How many STEP_VERDICT markers did the agent emit, and is the strict parser dropping any of them silently? | 23 strict-format markers across 3 fixtures, 0 parser gap pre-Stage-1.4 (2026-05-28) |
| `checks/assertion-gate-would-reject-rate.cjs` | At what rate would the assertion-gate's case-level hard-reject fire if flipped today? | 17 historical passes all default to false (pre-Stage-1.5 schema baseline); gather n=20+ in soft-fail before flip decision (2026-05-28) |
