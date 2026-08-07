import { test } from '@playwright/test';
test('BLOCKED: AST parse gate failed', async () => {
  throw new Error('QAAI export blocked — generated file had a syntax error: Unexpected token, expected "," (15:20). Re-run the case in QAAI and re-export.');
});
