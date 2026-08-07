const env = require('../server/services/codegen/_env');
const login = require('../server/services/codegen/_login');

// testCredentials null → observed creds from trail
const prof = env.buildCredentialProfile({ testCredentials: null, observed: { username: 'Admin', password: 'admin123', name: 'Admin user' } });
console.log('=== profile ==='); console.log(JSON.stringify(prof, null, 2));
console.log('\n=== utils/env.ts ==='); console.log(env.renderEnvAccessorTs(prof, { baseUrl: 'https://opensource-demo.orangehrmlive.com' }));
console.log('\n=== .env ==='); console.log(env.renderDotenv(prof, { targetUrl: 'https://opensource-demo.orangehrmlive.com' }));
console.log('=== promptBlock(ts) ==='); console.log(env.promptBlock(prof, { lang: 'ts' }));

const ctx = login.extractLoginContext({ actions: [
  { tool:'browser_navigate', args:{ url:'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login' } },
  { tool:'browser_type', args:{ element:'Username textbox', text:'Admin' } },
  { tool:'browser_type', args:{ element:'Password textbox', text:'admin123' } },
  { tool:'browser_click', args:{ element:'Login button' } },
  { tool:'browser_navigate', args:{ url:'https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index' } },
] }, 'https://opensource-demo.orangehrmlive.com');
console.log('\n=== extracted login context ==='); console.log(JSON.stringify(ctx, null, 2));
console.log('\n=== fallback utils/auth.ts ==='); console.log(login.fallbackHelperTs(ctx, prof));
