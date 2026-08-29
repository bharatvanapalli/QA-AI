# QAAI Portal — Autonomous Quality Intelligence

> **Read this first if you're deploying to a Client VM or air-gapped environment.**
>
> 1. **100% Pre-Bundled & Offline Ready**: All `node_modules`, Prisma database clients, and extensions are **pre-bundled in this repository**. **NO `npm install` required inside the Client VM!**
> 2. **Zero API Key Deployment via GitHub Copilot (VS Code Bridge)**: You do NOT need external Claude/Gemini API keys! See [GitHub Copilot Setup Guide](#github-copilot-vs-code-bridge-setup-zero-api-keys) below.
> 3. **Client VM Quickstart**: Clone repository $\rightarrow$ Copy extension folder to `.vscode/extensions/` $\rightarrow$ Run `npm run dev:full`!

---

## GITHUB COPILOT (VS CODE BRIDGE) SETUP (ZERO INSTALLS & ZERO API KEYS)

QAAI Portal supports **GitHub Copilot (VS Code Bridge)** mode. This allows the system to run in air-gapped corporate Client VMs with **zero `npm install` commands and zero external Anthropic/Claude API keys** by routing 100% of LLM reasoning tasks through your active VS Code Copilot session.

```
QAAI Portal Agents ──► http://127.0.0.1:5005 ──► VS Code Copilot Extension ──► GitHub Copilot
```

### 1. Step-by-Step Extension Setup (Client VM)

You can install the **QAAI Copilot Bridge Extension** using either of the following two methods:

#### Method A: Direct Folder Copy (Recommended for offline/restricted VMs)
Copy the included `vscode-copilot-bridge/` folder directly into VS Code's extensions directory:
- **Windows**: Copy `vscode-copilot-bridge` folder to `%USERPROFILE%\.vscode\extensions\qaai.qaai-copilot-bridge-1.0.0`
- **Mac / Linux**: Copy `vscode-copilot-bridge` folder to `~/.vscode/extensions/qaai.qaai-copilot-bridge-1.0.0`

> *Why Method A?* Direct folder copying bypasses VSIX signature verification prompts and auto-activates every time VS Code launches!

#### Method B: Install via `.vsix` file (`qaai-copilot-bridge-1.0.0.vsix`)
The pre-packaged extension package file `qaai-copilot-bridge-1.0.0.vsix` is provided directly in the root of the repository.

- **Option 1 (VS Code GUI)**:
  1. Open VS Code.
  2. Click the **Extensions** icon on the left sidebar (`Ctrl+Shift+X`).
  3. Click the `...` (**Views and More Actions**) menu at the top-right of the Extensions panel.
  4. Click **Install from VSIX...**
  5. Select the file `qaai-copilot-bridge-1.0.0.vsix` from the repository root directory.

- **Option 2 (Terminal Command)**:
  ```bash
  code --install-extension qaai-copilot-bridge-1.0.0.vsix
  ```

### 2. Verify Extension Activation inside VS Code
1. Open VS Code.
2. Open the **Output** panel (*View $\rightarrow$ Output*).
3. Select **QAAI Copilot Bridge** from the dropdown menu on the top right.
4. You will see:
   ```text
   Activating QAAI Copilot Bridge extension...
   QAAI Copilot Bridge listening on http://127.0.0.1:5005
   ```

### 3. Client VM Startup Commands (NO npm install needed!)

Run these exact commands in your terminal:

```bash
# 1. Initialize local SQLite Database schema
npx prisma db push

# 2. Seed Default User, Organization, and "New_Odyssey" Project Test Suite
npm run db:seed

# 3. Start Backend API & Frontend UI together
# Backend API: http://localhost:5000 | Frontend UI: http://localhost:5173
npm run dev:full
```

### 4. Enable Copilot Provider in Settings
1. Open http://localhost:5173 in your browser and sign up / log in.
2. Go to **Settings** $\rightarrow$ **GitHub Copilot**.
3. Set **Active AI Provider** to `GitHub Copilot (VS Code Bridge)`.
4. Click **Save provider**.

All scenario generation, self-healing locators, conductor test runs, and post-mortem failure reports will now execute cleanly via GitHub Copilot!

---

## STATE OF THE PROJECT (current)

**Last update:** 2026-05-19
**Status:** Functional end-to-end on SQLite. Smoke-tested: auth round-trip works.

### Database
- **Active:** SQLite at `prisma/dev.db` (file-based, zero install). Picked because the dev laptop is a corporate Cognizant device with strict admin/install policy.
- **Migration applied:** `prisma/migrations/<timestamp>_init/`
- **15 models** in `prisma/schema.prisma` — see Schema section.
- **Future swap to Postgres**: change provider to `"postgresql"`, set `DATABASE_URL`, delete `prisma/migrations/`, re-run `npx prisma migrate dev --name init`. The `String` (JSON-encoded) workaround fields would ideally become native `Json`/`String[]` — see "SQLite vs Postgres tradeoffs" section.

### What is REAL (not mocked)
1. **Auth** — bcrypt hashing, JWT + refresh in DB-persisted `Session` table, CSRF (double-submit cookie), rate limits.
2. **Vault** — AES-256-GCM encrypted secrets in `Secret` table. Only `lastFour` is ever returned to the frontend.
3. **Claude API integration** — `POST /api/settings/claude/validate` calls `api.anthropic.com/v1/models` with the real key.
4. **Azure DevOps integration** — `POST /api/settings/ado/test-connection` calls `_apis/projects` + `_apis/connectionData`. Pull endpoint runs real WIQL.
5. **Jira integration** — `POST /api/settings/jira/test-connection` calls `/rest/api/3/myself` + `/project/search`. Pull endpoint runs real JQL.
6. **CI/CD Webhooks** — HMAC-SHA256 signed delivery, real endpoint validation, secret rotation, deliveries panel persists every attempt.
7. **Notifications** — real email (nodemailer / MailHog in dev), real Slack incoming-webhook posts, real generic HTTP webhooks, per-event routing matrix.
8. **PDF parsing** — `pdf-parse`. DOCX via `mammoth`. HTML / JSON / text natively.
9. **Project zip download** — `archiver` streams real `.zip` with `playwright.config.js`, `tests/*.spec.ts`, generated `package.json`, README, `.gitignore`.
10. **Lint gates** — 12 AST-free rules (banned APIs, credential leaks, locator hygiene, missing imports/expects, anti-patterns). Blocks merge if errors found.
11. **Playwright runner** — real `npx playwright test` spawn, JSON report parsing, real screenshots/video served at `/artifacts/*`.
12. **WebSocket streaming** — JWT-gated, per-user channels (no global broadcast).
13. **Audit log** — every auth + settings event written to `AuditLog`.

### What is NOT done (deliberate, not faked)
- **No Git provider PR push** — Governance "Merge" is a DB state machine only. Wire to GitHub/GitLab/ADO Repos when ready.
- **No production deployment artefacts** — no Dockerfile for the app itself, no CI workflow, no IaC.
- **No Playwright browser bundled** — Chromium downloads on demand (see "Installing Playwright Chromium" below).
- **No SSO/OIDC** — local email+password only.
- **No object storage** — Playwright artifacts stay on local disk under `playwright/test-results/`.

---

## How to run (Cognizant laptop, no admin needed)

Prerequisites that are **already installed** on this machine (verified):
- Node.js 24.11.1 ✅
- npm 11.6.2 ✅
- Git Bash ✅
- PowerShell ✅

Nothing else needs to be installed (no Docker, no Postgres) thanks to SQLite.

### Boot the app

```powershell
# In PowerShell at the repo root:
cd C:\Users\2462021\Downloads\qaai_fixed\qaai_fixed

# Install deps (only first time)
npm install
cd server ; npm install ; cd ..

# Generate Prisma client + run migration (first time, or when schema changes)
npx prisma generate
npx prisma migrate dev --name init

# Start backend + frontend together
npm run dev:full
```

Open http://localhost:5173 in a browser.

### Stopping

`Ctrl + C` in the terminal running `dev:full`.

### Useful endpoints while running

| URL | What |
|---|---|
| http://localhost:5173 | The app |
| http://localhost:5000/api/health | Backend health (returns `{db: "up"}`) |
| http://localhost:5000/report/index.html | Playwright HTML report (after a run) |
| `npx prisma studio` → http://localhost:5555 | Visual database browser |

---

## Installing Playwright Chromium

You only need this if you'll actually run real tests (i.e. click "Run" on approved test cases). The UI flow works without it.

The download often fails on corporate proxies. Try these commands **in order** until one works:

```powershell
# 1. The normal command (will work behind some proxies)
cd server
npx playwright install chromium

# 2. If you get "Failed to download" — force re-install:
npx playwright install chromium --force

# 3. If TLS / cert errors (corporate MITM proxy):
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"
npx playwright install chromium

# 4. If npx itself fails — install the package locally then run directly:
npm i -D @playwright/test
.\node_modules\.bin\playwright install chromium

# 5. As a last resort: use --with-deps (downloads system libs too; may need admin):
npx playwright install chromium --with-deps

# 6. If still blocked: point at internal mirror (ask your IT for the URL):
$env:PLAYWRIGHT_DOWNLOAD_HOST="https://internal-mirror.cognizant.com"
npx playwright install chromium
```

After install, verify:

```powershell
npx playwright --version
# Then list browsers:
Get-ChildItem "$env:USERPROFILE\AppData\Local\ms-playwright"
```

You should see a `chromium-1140/` or similar folder. If you do, you're done.

---

## End-to-end happy path (manual smoke test)

1. Open http://localhost:5173 → **Sign up** (real bcrypt user goes into DB).
2. Settings → **Claude API** → paste a real `sk-ant-...` key → **Validate** → **Save**.
3. (Optional) Settings → **Azure DevOps** or **Jira** → enter PAT/token + URL → **Test Connection** → pick project → **Save**.
4. (Optional) Settings → **Webhooks** → add URL → **Generate secret** → **Validate endpoint** → save.
5. (Optional) Settings → **Notifications** → add email/Slack/webhook channel → **Send test** (real delivery).
6. **Project Setup** → **New project** → enter name + target URL → Create.
7. **Run Suite** → drag in a PDF/MD/HTML doc OR pull from ADO/Jira → **Generate test cases** (real Claude call).
8. **Test Cases** → review → **Approve all** → **Run N approved**.
9. **Execution Log** → watch live WebSocket stream of real `npx playwright test`.
10. **Reports** → real screenshots, real video, real error stacks.
11. **Blocked Items** → resolve a failed locator → auto-stored in **Knowledge Base**.
12. **Governance** → review generated PRs with real lint findings → Approve → Merge.
13. **Output Files** → preview specs or click **Download project.zip** for the real archive.

---

## Architecture

```
qaai_fixed/
├── .env                           # Local secrets (gitignored). DATABASE_URL=file:./dev.db
├── .env.example                   # Template
├── docker-compose.yml             # Optional: Postgres + MailHog. Unused while on SQLite.
├── package.json                   # Frontend deps + run scripts
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── README.md                      # ← this file
├── prisma/
│   ├── schema.prisma              # 15 models. Currently provider=sqlite.
│   ├── dev.db                     # SQLite database (gitignored)
│   └── migrations/                # Auto-generated by prisma migrate dev
├── server/
│   ├── index.js                   # Express entry. Mounts all routes + WS.
│   ├── prisma.js                  # Prisma singleton
│   ├── package.json
│   ├── playwright-worker.js       # Spawns npx playwright test, parses JSON report
│   ├── test-generator.js          # Generates .spec.ts files (Claude or fallback)
│   ├── middleware/
│   │   ├── auth.js                # requireAuth, requireRole
│   │   ├── csrf.js                # Double-submit CSRF
│   │   ├── rateLimit.js           # In-memory per-route limiter
│   │   └── error.js
│   ├── routes/
│   │   ├── auth.js                # signup, login, refresh, logout, me, csrf-token
│   │   ├── projects.js
│   │   ├── requirements.js        # upload, ADO/Jira pull, list, delete
│   │   ├── testCases.js           # generate (Claude), edit, approve-all, delete
│   │   ├── runs.js                # start (returns immediately), list, get
│   │   ├── knowledgeBase.js
│   │   ├── governance.js          # list, approve, merge, reject, re-lint
│   │   ├── blocked.js             # list, resolve (+ auto KB upsert)
│   │   ├── outputFiles.js         # list, read, download.zip (archiver)
│   │   ├── dashboard.js           # Aggregated metrics for Overview
│   │   ├── settings.claude.js
│   │   ├── settings.ado.js
│   │   ├── settings.jira.js
│   │   ├── settings.webhook.js
│   │   └── settings.notifications.js
│   └── services/
│       ├── vault.js               # AES-256-GCM, Prisma Secret table
│       ├── audit.js               # AuditLog writer (auto-encodes metadata to JSON string)
│       ├── integrations.js        # Wrapper over Integration table that inflates/encodes `config`
│       ├── jsonField.js           # encodeArray/decodeArray/encodeJson/decodeJson helpers (SQLite quirk)
│       ├── claude.js              # Anthropic /v1/models validator
│       ├── ado.js                 # ADO REST: projects, work items
│       ├── jira.js                # Jira REST: myself, projects, search issues
│       ├── webhook.js             # HMAC sign, validate, deliver, fanout
│       ├── notifications.js       # email/Slack/HTTP delivery + per-event dispatch
│       ├── docs.js                # pdf-parse / mammoth / HTML strip / JSON pretty
│       ├── testGenerator.js       # Real Claude call → JSON test cases → normalised
│       ├── lintGates.js           # 12 AST-free rules
│       └── runs.js                # Run engine: persists Run/RunResult/BlockedItem/GovernancePR
└── src/                           # Frontend (Vite + React 19 + Tailwind)
    ├── main.jsx
    ├── App.jsx                    # BrowserRouter, providers, route map
    ├── index.css
    ├── lib/
    │   ├── apiClient.js           # fetch wrapper: cookies + CSRF auto-attach + 401 refresh retry
    │   ├── useDirtyForm.js        # Hook tracking baseline vs current values
    │   └── useToast.jsx           # Toast provider + hook
    ├── store/
    │   ├── auth.jsx               # AuthProvider, useAuth
    │   ├── project.jsx            # ProjectProvider, useProject (current project, switcher)
    │   └── runStream.jsx          # WebSocket client, log buffer, event bus
    ├── components/
    │   ├── Sidebar.jsx
    │   ├── PageHeader.jsx         # Includes ProjectPicker in header
    │   ├── ProjectPicker.jsx
    │   ├── ErrorBoundary.jsx
    │   ├── EmptyState.jsx
    │   └── ui/
    │       ├── Button.jsx
    │       ├── Input.jsx
    │       ├── SecretInput.jsx    # Password-style + show/hide toggle
    │       ├── Select.jsx
    │       ├── Checkbox.jsx
    │       └── StatusBadge.jsx
    └── pages/
        ├── LoginScreen.jsx        # Real signup + login
        ├── Profile.jsx
        ├── Overview.jsx           # Real dashboard: GO/NO-GO, module health, recent runs
        ├── ProjectSetup.jsx       # CRUD on Project
        ├── RunSuite.jsx           # Doc upload + ADO/Jira pull + generate
        ├── TestCases.jsx          # List, approve, run
        ├── ExecutionLog.jsx       # Live WS stream + run history
        ├── Reports.jsx            # Triple-pane: runs → tests → artifacts
        ├── BlockedItems.jsx       # Triage + KB upsert
        ├── Governance.jsx         # Generated PRs + lint findings
        ├── KnowledgeBase.jsx      # Locator table
        ├── OutputFiles.jsx        # Specs viewer + zip download
        └── settings/
            ├── Settings.jsx       # Tab shell
            ├── ClaudeSettings.jsx
            ├── AdoSettings.jsx
            ├── JiraSettings.jsx
            ├── WebhookSettings.jsx
            └── NotificationsSettings.jsx
```

---

## Schema

The 15 Prisma models:

| Model | Purpose |
|---|---|
| `User` | Account + bcrypt hash |
| `Session` | Refresh token (hashed), UA, IP, expiry |
| `Secret` | AES-256-GCM encrypted secret per (userId, name) |
| `Integration` | Per-user integration config (claude/ado/jira); `config` is JSON-encoded string |
| `WebhookConfig` | Outbound HMAC webhook target; `events` is JSON-encoded string array |
| `WebhookDelivery` | Each delivery attempt with status/latency; `payload` is JSON-encoded string |
| `NotificationChannel` | Email/Slack/webhook destination with verification state |
| `NotificationRoute` | Many-to-many: event ↔ channel |
| `Project` | Test project (env, framework, target URL) |
| `Document` | Uploaded source doc, extracted text |
| `Requirement` | Requirement extracted from upload or ADO/Jira |
| `TestCase` | Claude-generated test case with confidence, status, persisted specCode |
| `Run` | A test-suite execution. `config` is JSON-encoded string |
| `RunResult` | Per-test outcome. `screenshots` is JSON-encoded string array |
| `KnowledgeBaseLocator` | Healed selector registry per project |
| `GovernancePR` | Generated PR awaiting human review. `lintFindings` is JSON-encoded string |
| `BlockedItem` | Auto-created from failed `RunResult` for triage |
| `AuditLog` | Every auth + settings + governance action. `metadata` is JSON-encoded string |

---

## SQLite vs Postgres tradeoffs (in this codebase)

Five fields are stored as JSON-encoded `String` instead of native types because Prisma 5.22 + SQLite doesn't support `Json` columns and SQLite doesn't have arrays at all:

| Model.Field | SQLite type now | Postgres type if you switch |
|---|---|---|
| `Integration.config` | `String @default("{}")` | `Json` |
| `WebhookConfig.events` | `String` (JSON array) | `String[]` |
| `WebhookDelivery.payload` | `String @default("{}")` | `Json` |
| `Run.config` | `String?` | `Json?` |
| `GovernancePR.lintFindings` | `String?` | `Json?` |
| `AuditLog.metadata` | `String?` | `Json?` |
| `RunResult.screenshots` | `String @default("[]")` (JSON array) | `String[]` |

All encode/decode goes through `server/services/jsonField.js`. To swap to Postgres later, change the schema types AND remove the `encodeJson/encodeArray` wrappers at the call sites (grep for them — they're all in `server/services/*` and a few `server/routes/*`).

---

## Security model

- Secrets never leave the backend. Only `lastFour` ever appears in API responses.
- JWT cookie (15m TTL) + refresh cookie (7d, hashed in DB). Sessions are revocable.
- CSRF: double-submit cookie pattern; the frontend `apiClient` attaches `X-XSRF-TOKEN` automatically.
- Rate limits on `/validate` and `/test` endpoints.
- WebSocket auth gated on JWT cookie; broadcasts are scoped per-user.
- Every settings change + auth event writes to `AuditLog` (with IP + UA).
- `VAULT_MASTER_KEY` in `.env` should be rotated for production — secrets cannot be decrypted without it.

---

## Common npm scripts

| Command | What |
|---|---|
| `npm run dev:full` | Start backend + frontend together (most common) |
| `npm run dev` | Frontend only (Vite on :5173) |
| `npm run server` | Backend only (Express on :5000) |
| `npm run server:dev` | Backend with nodemon auto-restart |
| `npm run build` | Production frontend build into `dist/` |
| `npm run prisma:generate` | Regenerate Prisma client after schema change |
| `npm run prisma:migrate` | Create + apply new migration |
| `npm run prisma:studio` | Visual DB browser at :5555 |
| `npm run db:up` | Start Docker Postgres+MailHog (unused on SQLite; kept for future Postgres swap) |

---

## Handoff notes for a future Claude session

If you're a new session reading this:

1. **The schema is currently SQLite-flavored.** Look at `server/services/jsonField.js` to see why several fields are stored as JSON-encoded strings. Don't "fix" them unless the user is migrating to Postgres.
2. **`server/node_modules/.prisma/client` must be in sync** with `prisma/schema.prisma`. If you change the schema and the server crashes with weird Prisma errors, delete `server/node_modules/.prisma` and `server/node_modules/@prisma/client`, then run `npx prisma generate` from the repo root — the server resolves Prisma from the root `node_modules`. This was a real footgun on the SQLite migration.
3. **Auth is JWT-cookie based, NOT bearer-token.** All API calls must include `credentials: 'include'`. The `apiClient.js` already does this. CSRF token is in a non-httpOnly cookie called `XSRF-TOKEN`; mutating requests must send it back in the `X-XSRF-TOKEN` header.
4. **WebSocket is auth-gated.** The handshake reads the `token` cookie. If you add new WS message types, keep the broadcast user-scoped (use `app.locals.broadcastToUser(userId, msg)`) — never global.
5. **No mock data anywhere.** If you find yourself wanting to add fake data to make a screen "look populated", stop. The screen should show an EmptyState that tells the user what's missing and what to do next. See `src/components/EmptyState.jsx`.
6. **PageHeader includes a ProjectPicker.** Pages that need a current project should pull it from `useProject()` and gracefully empty-state when it's null.
7. **Claude integration uses model id `claude-sonnet-4-6` by default.** Don't downgrade to `claude-sonnet-4-5` unless asked. New models: Opus 4.7, Sonnet 4.6, Haiku 4.5.
8. **The user is on a Cognizant corporate laptop.** No Docker, no admin install. Don't propose solutions that require infrastructure they can't get approved.
9. **Lint engine** is in `server/services/lintGates.js`. It runs automatically on PR creation in `runs.js`. Adding a new rule: append to `RULES` array; either `line: (lines) => findLine(...)` for single-line detection or `customScan: (lines) => [...]` for multi-line.
10. **The decision log:** SQLite chosen over Postgres for corporate-laptop expediency (2026-05-19). All-or-nothing approach to authoring; no half-built screens. Hard rule: no fake data, ever.

---

## Verified state (as of last update)

- ✅ `npx prisma validate` — schema is valid
- ✅ `npx prisma migrate dev` — migration applied to `prisma/dev.db`
- ✅ `npm run server` boots on :5000
- ✅ `GET /api/health` returns `{ok: true, db: "up"}`
- ✅ `POST /api/auth/signup` creates a real user with bcrypt hash
- ✅ `GET /api/auth/me` returns the persisted profile with cookie auth
- ✅ `npx vite build` — 1616 modules transformed, no errors
- ✅ All 22+ server JS files pass `node --check`
- ✅ Lint engine catches 6 errors + 4 warnings on a deliberately-bad spec; clean on a good one
