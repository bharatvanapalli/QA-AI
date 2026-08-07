# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: replayir\e3183ae3-b4fe-43ae-a796-7354e20745f6.spec.ts >> QAAI ReplayIR e3183ae3-b4fe-43ae-a796-7354e20745f6 >> default
- Location: tests\replayir\e3183ae3-b4fe-43ae-a796-7354e20745f6.spec.ts:89:9

# Error details

```
Error: Assertion ASN-ed4b5020 expected exactly one visible text match for "Dashboard", found 2. The oracle is ambiguous and must be scoped by MCP evidence.
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic:
    - complementary [ref=e4]:
      - navigation "Sidepanel" [ref=e5]:
        - generic [ref=e6]:
          - link "client brand banner" [ref=e7] [cursor=pointer]:
            - /url: https://www.orangehrm.com/
            - img "client brand banner" [ref=e9]
          - text: 
        - generic [ref=e10]:
          - generic [ref=e11]:
            - generic [ref=e12]:
              - textbox "Search" [ref=e15]
              - button "" [ref=e16] [cursor=pointer]:
                - generic [ref=e17]: 
            - separator [ref=e18]
          - list [ref=e19]:
            - listitem [ref=e20]:
              - link "Admin" [ref=e21] [cursor=pointer]:
                - /url: /web/index.php/admin/viewAdminModule
                - generic [ref=e24]: Admin
            - listitem [ref=e25]:
              - link "PIM" [ref=e26] [cursor=pointer]:
                - /url: /web/index.php/pim/viewPimModule
                - generic [ref=e40]: PIM
            - listitem [ref=e41]:
              - link "Leave" [ref=e42] [cursor=pointer]:
                - /url: /web/index.php/leave/viewLeaveModule
                - generic [ref=e45]: Leave
            - listitem [ref=e46]:
              - link "Time" [ref=e47] [cursor=pointer]:
                - /url: /web/index.php/time/viewTimeModule
                - generic [ref=e53]: Time
            - listitem [ref=e54]:
              - link "Recruitment" [ref=e55] [cursor=pointer]:
                - /url: /web/index.php/recruitment/viewRecruitmentModule
                - generic [ref=e61]: Recruitment
            - listitem [ref=e62]:
              - link "My Info" [ref=e63] [cursor=pointer]:
                - /url: /web/index.php/pim/viewMyDetails
                - generic [ref=e69]: My Info
            - listitem [ref=e70]:
              - link "Performance" [ref=e71] [cursor=pointer]:
                - /url: /web/index.php/performance/viewPerformanceModule
                - generic [ref=e79]: Performance
            - listitem [ref=e80]:
              - link "Dashboard" [ref=e81] [cursor=pointer]:
                - /url: /web/index.php/dashboard/index
                - generic [ref=e84]: Dashboard
            - listitem [ref=e85]:
              - link "Directory" [ref=e86] [cursor=pointer]:
                - /url: /web/index.php/directory/viewDirectory
                - generic [ref=e89]: Directory
            - listitem [ref=e90]:
              - link "Maintenance" [ref=e91] [cursor=pointer]:
                - /url: /web/index.php/maintenance/viewMaintenanceModule
                - generic [ref=e95]: Maintenance
            - listitem [ref=e96]:
              - link "Claim" [ref=e97] [cursor=pointer]:
                - /url: /web/index.php/claim/viewClaimModule
                - img [ref=e100]
                - generic [ref=e104]: Claim
            - listitem [ref=e105]:
              - link "Buzz" [ref=e106] [cursor=pointer]:
                - /url: /web/index.php/buzz/viewBuzz
                - generic [ref=e109]: Buzz
    - banner [ref=e110]:
      - generic [ref=e111]:
        - generic [ref=e112]:
          - text: 
          - heading "Dashboard" [level=6] [ref=e114]
        - link "Upgrade" [ref=e116]:
          - /url: https://orangehrm.com/open-source/upgrade-to-advanced
          - button "Upgrade" [ref=e117] [cursor=pointer]: Upgrade
        - list [ref=e123]:
          - listitem [ref=e124]:
            - generic [ref=e125] [cursor=pointer]:
              - img "profile picture" [ref=e126]
              - paragraph [ref=e127]: HLhgacahyt roLvgXDxMv
              - generic [ref=e128]: 
      - navigation "Topbar Menu" [ref=e130]:
        - list [ref=e131]:
          - button "" [ref=e133] [cursor=pointer]:
            - generic [ref=e134]: 
  - generic [ref=e135]:
    - generic [ref=e137]:
      - generic [ref=e139]:
        - generic [ref=e141]:
          - generic [ref=e142]: 
          - paragraph [ref=e143]: Time at Work
        - separator [ref=e144]
        - generic [ref=e146]:
          - generic [ref=e147]:
            - img "profile picture" [ref=e149]
            - generic [ref=e150]:
              - paragraph [ref=e151]: Punched In
              - paragraph [ref=e152]: "Punched In: Today at 03:00 PM (GMT 7)"
          - generic [ref=e153]:
            - generic [ref=e154]: 0h 31m Today
            - button "" [ref=e155] [cursor=pointer]:
              - generic [ref=e156]: 
          - separator [ref=e157]
          - generic [ref=e158]:
            - generic [ref=e159]:
              - paragraph [ref=e160]: This Week
              - paragraph [ref=e161]: Jun 01 - Jun 07
            - generic [ref=e162]:
              - generic [ref=e163]: 
              - paragraph [ref=e164]: 0h 0m
      - generic [ref=e168]:
        - generic [ref=e170]:
          - generic [ref=e171]: 
          - paragraph [ref=e172]: My Actions
        - separator [ref=e173]
        - generic [ref=e175]:
          - generic [ref=e176]:
            - button [ref=e177] [cursor=pointer]
            - paragraph [ref=e183] [cursor=pointer]: (1) Pending Self Review
          - generic [ref=e184]:
            - button [ref=e185] [cursor=pointer]
            - paragraph [ref=e194] [cursor=pointer]: (1) Candidate to Interview
      - generic [ref=e196]:
        - generic [ref=e198]:
          - generic [ref=e199]: 
          - paragraph [ref=e200]: Quick Launch
        - separator [ref=e201]
        - generic [ref=e203]:
          - generic [ref=e204]:
            - button "Assign Leave" [ref=e205] [cursor=pointer]
            - generic "Assign Leave" [ref=e208]:
              - paragraph [ref=e209]: Assign Leave
          - generic [ref=e210]:
            - button "Leave List" [ref=e211] [cursor=pointer]
            - generic "Leave List" [ref=e218]:
              - paragraph [ref=e219]: Leave List
          - generic [ref=e220]:
            - button "Timesheets" [ref=e221] [cursor=pointer]
            - generic "Timesheets" [ref=e227]:
              - paragraph [ref=e228]: Timesheets
          - generic [ref=e229]:
            - button "Apply Leave" [ref=e230] [cursor=pointer]
            - generic "Apply Leave" [ref=e233]:
              - paragraph [ref=e234]: Apply Leave
          - generic [ref=e235]:
            - button "My Leave" [ref=e236] [cursor=pointer]
            - generic "My Leave" [ref=e241]:
              - paragraph [ref=e242]: My Leave
          - generic [ref=e243]:
            - button "My Timesheet" [ref=e244] [cursor=pointer]
            - generic "My Timesheet" [ref=e247]:
              - paragraph [ref=e248]: My Timesheet
      - generic [ref=e250]:
        - generic [ref=e252]:
          - generic [ref=e253]: 
          - paragraph [ref=e254]: Buzz Latest Posts
        - separator [ref=e255]
        - generic [ref=e257]:
          - generic [ref=e258]:
            - generic [ref=e259] [cursor=pointer]:
              - img "profile picture" [ref=e261]
              - generic [ref=e262]:
                - paragraph [ref=e263]: HLhgacahyt wiYPJAmK roLvgXDxMv
                - paragraph [ref=e264]: 2026-05-06 01:52 PM
            - separator [ref=e265]
            - paragraph [ref=e266]: WO AI NI - 520
            - img [ref=e267]
          - generic [ref=e268]:
            - generic [ref=e269] [cursor=pointer]:
              - img "profile picture" [ref=e271]
              - generic [ref=e272]:
                - paragraph [ref=e273]: HLhgacahyt wiYPJAmK roLvgXDxMv
                - paragraph [ref=e274]: 2026-05-06 01:51 PM
            - separator [ref=e275]
            - paragraph [ref=e276]: WO AI NI - 520
            - img [ref=e277]
          - generic [ref=e278]:
            - generic [ref=e279] [cursor=pointer]:
              - img "profile picture" [ref=e281]
              - generic [ref=e282]:
                - paragraph [ref=e283]: HLhgacahyt wiYPJAmK roLvgXDxMv
                - paragraph [ref=e284]: 2026-05-06 01:49 PM
            - separator [ref=e285]
            - paragraph [ref=e286]: inu posutu
            - img [ref=e287]
          - generic [ref=e288]:
            - generic [ref=e289] [cursor=pointer]:
              - img "profile picture" [ref=e291]
              - generic [ref=e292]:
                - paragraph [ref=e293]: HLhgacahyt wiYPJAmK roLvgXDxMv
                - paragraph [ref=e294]: 2026-05-06 01:46 PM
            - separator [ref=e295]
            - paragraph [ref=e296]: WO AI NI - 520
            - img [ref=e297]
          - generic [ref=e298]:
            - generic [ref=e299] [cursor=pointer]:
              - img "profile picture" [ref=e301]
              - generic [ref=e302]:
                - paragraph [ref=e303]: HLhgacahyt wiYPJAmK roLvgXDxMv
                - paragraph [ref=e304]: 2026-05-06 01:44 PM
            - separator [ref=e305]
            - paragraph [ref=e306]: WO AI NI - 520
            - img [ref=e307]
      - generic [ref=e309]:
        - generic [ref=e310]:
          - paragraph [ref=e315]: Employees on Leave Today
          - generic [ref=e316] [cursor=pointer]: 
        - separator [ref=e317]
        - generic [ref=e319]:
          - img "profile picture" [ref=e321]
          - generic [ref=e322]:
            - paragraph [ref=e323]: HLhgacahyt roLvgXDxMv
            - paragraph [ref=e324]: CAN - FMLA
          - paragraph [ref=e325]: "1971"
      - generic [ref=e327]:
        - generic [ref=e329]:
          - generic [ref=e330]: 
          - paragraph [ref=e331]: Employee Distribution by Sub Unit
        - separator [ref=e332]
        - list [ref=e337]:
          - listitem [ref=e338] [cursor=pointer]:
            - generic "Administration" [ref=e340]
          - listitem [ref=e341] [cursor=pointer]:
            - generic "Human Resources" [ref=e343]
          - listitem [ref=e344] [cursor=pointer]:
            - generic "Unassigned" [ref=e346]
      - generic [ref=e348]:
        - generic [ref=e350]:
          - generic [ref=e351]: 
          - paragraph [ref=e352]: Employee Distribution by Location
        - separator [ref=e353]
        - list [ref=e358]:
          - listitem [ref=e359] [cursor=pointer]:
            - generic "Texas R&D" [ref=e361]
          - listitem [ref=e362] [cursor=pointer]:
            - generic "Unassigned" [ref=e364]
    - generic [ref=e365]:
      - paragraph [ref=e366]: OrangeHRM OS 5.8
      - paragraph [ref=e367]:
        - text: © 2005 - 2026
        - link "OrangeHRM, Inc" [ref=e368] [cursor=pointer]:
          - /url: http://www.orangehrm.com
        - text: . All rights reserved.
```

# Test source

```ts
  1   | import { test, expect, type Locator, type Page } from '@playwright/test';
  2   | 
  3   | type LocatorCandidate = {
  4   |   strategy: 'role' | 'css' | 'testId' | 'text' | 'placeholder' | 'label';
  5   |   role?: Parameters<Page['getByRole']>[0];
  6   |   name?: string;
  7   |   selector?: string;
  8   |   testId?: string;
  9   |   text?: string;
  10  | };
  11  | 
  12  | type DataRow = { index: number; label: string; fields?: Record<string, string> };
  13  | 
  14  | function readEnv(name: string): string {
  15  |   const value = process.env[name];
  16  |   if (!value) throw new Error(`Missing required environment variable ${name}`);
  17  |   return value;
  18  | }
  19  | 
  20  | function readData(row: DataRow, key: string): string {
  21  |   const value = row.fields?.[key];
  22  |   if (value == null || value === '') throw new Error(`Missing data field ${key} for ${row.label}`);
  23  |   return String(value);
  24  | }
  25  | 
  26  | async function resolveLocator(page: Page, candidates: LocatorCandidate[], label: string): Promise<Locator> {
  27  |   const errors: string[] = [];
  28  |   for (const c of candidates) {
  29  |     let locator: Locator | null = null;
  30  |     if (c.strategy === 'role' && c.role) locator = c.name ? page.getByRole(c.role, { name: c.name }) : page.getByRole(c.role);
  31  |     if (c.strategy === 'css' && c.selector) locator = page.locator(c.selector);
  32  |     if (c.strategy === 'testId' && c.testId) locator = page.getByTestId(c.testId);
  33  |     if (c.strategy === 'text' && c.text) locator = page.getByText(c.text);
  34  |     if (c.strategy === 'placeholder' && c.text) locator = page.getByPlaceholder(c.text);
  35  |     if (c.strategy === 'label' && c.text) locator = page.getByLabel(c.text);
  36  |     if (!locator) {
  37  |       errors.push(`unsupported candidate ${JSON.stringify(c)}`);
  38  |       continue;
  39  |     }
  40  |     await locator.first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
  41  |     const count = await locator.count().catch(() => 0);
  42  |     if (count === 1) {
  43  |       const only = locator.first();
  44  |       if (await only.isVisible({ timeout: 750 }).catch(() => false)) return only;
  45  |       errors.push(`candidate matched one non-visible element: ${JSON.stringify(c)}`);
  46  |       continue;
  47  |     }
  48  |     if (count > 1) {
  49  |       errors.push(`candidate ambiguous: matched ${count} elements for ${JSON.stringify(c)}`);
  50  |       continue;
  51  |     }
  52  |     errors.push(`candidate matched ${count}: ${JSON.stringify(c)}`);
  53  |   }
  54  |   throw new Error(`Unable to resolve ${label}: ${errors.join('; ')}`);
  55  | }
  56  | 
  57  | async function assertUniqueVisibleText(page: Page, text: string, contractRef: string, timeoutMs: number): Promise<void> {
  58  |   const locator = page.getByText(text, { exact: false });
  59  |   await locator.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  60  |   const count = await locator.count().catch(() => 0);
  61  |   if (count !== 1) {
> 62  |     throw new Error(`Assertion ${contractRef || 'unknown'} expected exactly one visible text match for "${text}", found ${count}. The oracle is ambiguous and must be scoped by MCP evidence.`);
      |           ^ Error: Assertion ASN-ed4b5020 expected exactly one visible text match for "Dashboard", found 2. The oracle is ambiguous and must be scoped by MCP evidence.
  63  |   }
  64  |   await expect(locator.first()).toBeVisible({ timeout: timeoutMs });
  65  | }
  66  | 
  67  | async function dismissKnownPopups(page: Page, candidates: LocatorCandidate[]): Promise<void> {
  68  |   for (const c of candidates) {
  69  |     const locator = await resolveLocator(page, [c], 'known popup').catch(() => null);
  70  |     if (locator && await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
  71  |       await locator.click();
  72  |     }
  73  |   }
  74  | }
  75  | 
  76  | test.describe("QAAI ReplayIR e3183ae3-b4fe-43ae-a796-7354e20745f6", () => {
  77  | 
  78  |   test.describe.configure({ mode: 'serial', retries: 1 });
  79  | 
  80  |   const dataRows: DataRow[] = [
  81  |     {
  82  |       "index": 0,
  83  |       "label": "default",
  84  |       "fields": {}
  85  |     }
  86  |   ];
  87  | 
  88  |   for (const row of dataRows) {
  89  |     test(row.label, async ({ page }) => {
  90  | 
  91  |   // Auth profile default: auth strategy none must be wired by the package shell.
  92  | 
  93  |       await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
  94  | 
  95  |       const el1 = await resolveLocator(page, [
  96  |     {
  97  |       "strategy": "role",
  98  |       "role": "textbox",
  99  |       "name": "Username"
  100 |     },
  101 |     {
  102 |       "strategy": "placeholder",
  103 |       "text": "Username"
  104 |     },
  105 |     {
  106 |       "strategy": "label",
  107 |       "text": "Username"
  108 |     },
  109 |     {
  110 |       "strategy": "text",
  111 |       "text": "Username"
  112 |     }
  113 |   ], "el1");
  114 | 
  115 |       await el1.fill(readEnv("QAAI_USERNAME"));
  116 | 
  117 |       const el2 = await resolveLocator(page, [
  118 |     {
  119 |       "strategy": "placeholder",
  120 |       "text": "Password"
  121 |     },
  122 |     {
  123 |       "strategy": "label",
  124 |       "text": "Password"
  125 |     },
  126 |     {
  127 |       "strategy": "role",
  128 |       "role": "textbox",
  129 |       "name": "Password"
  130 |     },
  131 |     {
  132 |       "strategy": "text",
  133 |       "text": "Password"
  134 |     }
  135 |   ], "el2");
  136 | 
  137 |       await el2.fill(readEnv("QAAI_PASSWORD"));
  138 | 
  139 |       const el3 = await resolveLocator(page, [
  140 |     {
  141 |       "strategy": "text",
  142 |       "text": "Login button"
  143 |     },
  144 |     {
  145 |       "strategy": "role",
  146 |       "role": "button",
  147 |       "name": "Login"
  148 |     },
  149 |     {
  150 |       "strategy": "text",
  151 |       "text": "Login"
  152 |     }
  153 |   ], "el3");
  154 | 
  155 |       await el3.click();
  156 | 
  157 |       await assertUniqueVisibleText(page, "Dashboard", "ASN-ed4b5020", 10000);
  158 | 
  159 |       await assertUniqueVisibleText(page, "PIM", "ASN-fc9e9304", 10000);
  160 | 
  161 |       await page.screenshot({ path: "test-results/e3183ae3-b4fe-43ae-a796-7354e20745f6.png", fullPage: true });
  162 |     });
```