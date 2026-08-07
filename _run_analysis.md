# Run analysis — 5f7d4e52-2a5f-443e-99b1-e99b56f4b144 (status: cancelled)

## Stored-locator reuse vs fresh resolution
- Project-memory REUSED: 0 interactions → 
- Live-ref dispatch (no gold, ref in snapshot): 0
- Codegen locator excavated at dispatch: 0
- Locators quarantined (forced recovery): 0

## Checkpoint flips (marked fail/blocked AT step → recovered → pass)
- step 2: pass → fail → fail → pass → fail → pass → pass → pass → pass
- step 3: pass → blocked → pass → pass → pass → pass → pass
- step 4: fail → blocked → pass → pass → pass
- step 5: blocked → blocked → pass

## Per-case IR locator sources
- result f52f9ac6-8b26-4a1d-a9f8-634e41f062d9 status=blocked complete=false | resolves=4 gold=4 exportSafe=0 none=0 | gaps=2 [assertion_contract_defect,locator_gap]
    · Username → gold :: getByRole("textbox", { name: "Username" })
    · Password → gold :: getByRole("textbox", { name: "Password" })
    · Login button → gold :: getByRole("button", { name: "Login" })
    · Logout menu item → gold :: getByRole("menuitem", { name: "Logout" })
- result 325a89e3-05d4-418a-9705-4b473bcde80c status=blocked complete=false | resolves=0 gold=0 exportSafe=0 none=0 | gaps=1 [assertion_contract_defect]
- result 183e4ccb-e947-4687-a22a-fa9a3987c3d7 status=pass complete=true | resolves=0 gold=0 exportSafe=0 none=0 | gaps=0 []
- result 890ab97f-adaf-441c-8a33-dbf953538061 status=pass complete=true | resolves=3 gold=2 exportSafe=1 none=0 | gaps=0 []
    · Username field → gold :: getByRole("textbox", { name: "Username" })
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → gold :: getByRole("button", { name: "Login" })
- result 3cd7339d-7055-4000-b5c0-10427d03bba7 status=pass complete=true | resolves=3 gold=0 exportSafe=3 none=0 | gaps=0 []
    · Username field → exportSafeUnverified :: (no expr)
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → exportSafeUnverified :: (no expr)
- result 2247150c-5cda-4e17-809b-8b8fa520b005 status=pass complete=true | resolves=3 gold=0 exportSafe=3 none=0 | gaps=0 []
    · Username field → exportSafeUnverified :: (no expr)
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → exportSafeUnverified :: (no expr)
- result d64dba2b-e629-4da6-a4bb-eb32335c85fa status=pass complete=true | resolves=3 gold=0 exportSafe=3 none=0 | gaps=0 []
    · Username field → exportSafeUnverified :: (no expr)
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → exportSafeUnverified :: (no expr)
- result 87e776f3-147b-474f-b94a-d8e4b1247cdd status=pass complete=true | resolves=3 gold=0 exportSafe=3 none=0 | gaps=0 []
    · Username field → exportSafeUnverified :: (no expr)
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → exportSafeUnverified :: (no expr)
- result 5086625c-6f26-409f-8548-84c3cdd3c2a2 status=pass complete=true | resolves=3 gold=0 exportSafe=3 none=0 | gaps=0 []
    · Username field → exportSafeUnverified :: (no expr)
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → exportSafeUnverified :: (no expr)
- result 92ff1e51-a334-4b6a-9501-e7640d8e59c7 status=pass complete=true | resolves=3 gold=0 exportSafe=3 none=0 | gaps=0 []
    · Username field → exportSafeUnverified :: (no expr)
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → exportSafeUnverified :: (no expr)
- result ea63081b-2e74-4cd0-b20c-0b1d9e43a75d status=pass complete=true | resolves=3 gold=2 exportSafe=1 none=0 | gaps=0 []
    · Username field → gold :: getByRole("textbox", { name: "Username" })
    · Password field → exportSafeUnverified :: (no expr)
    · Login button → gold :: getByRole("button", { name: "Login" })

## Output files
{
  "ok": true,
  "fileCount": 38,
  "allBlocked": false,
  "files": [
    "package.json",
    "playwright.config.ts",
    "tests/support/replayir.js",
    "utils/test-helpers.js",
    "qaai.preflight.cjs",
    ".env",
    ".env.example",
    "README.md",
    "tests/authentication/logout-redirect-and-session-termination.spec.js",
    "tests/data/admin-logout-redirects-to-auth-login-page.json",
    "tests/data/post-logout-direct-navigation-to-dashboard-redirects-to-login.json",
    "locators/generated/dashboardPage.generated.locators.js",
    "locators/dashboardPage.locators.js",
    "pages/DashboardPage.js",
    "locators/generated/loginPage.generated.locators.js",
    "locators/loginPage.locators.js",
    "pages/LoginPage.js",
    "evidence/locator-manifest.json",
    "evidence/dom-atlas.json",
    "evidence/pom-architect-report.json",
    "evidence/certification-report.json",
    "tests/data/orangehrm-authentication-testdata-xlsx-authprofiles.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx-formvalidation.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx-negativeauth.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx-securityauth.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx-roleaccesscontrol.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx-expectedresults.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx-readme.csv",
    "tests/data/orangehrm-authentication-testdata-xlsx.xlsx",
    "evidence/step-parity-report.json",
    "evidence/contract-certification-report.json",
    "evidence/action-authoring-ledger.json",
    "evidence/value-binding-map.json",
    "evidence/artifact-graph.json",
    "evidence/target-parity-report.json",
    "evidence/traceability-matrix.json",
    "evidence/runtime-result-firewall.json",
    "EXPORT_MANIFEST.json"
  ],
  "specFiles": [
    "tests/authentication/logout-redirect-and-session-termination.spec.js"
  ],
  "pageFiles": [
    "pages/DashboardPage.js",
    "pages/LoginPage.js"
  ]
}