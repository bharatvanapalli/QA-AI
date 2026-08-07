const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
// List all models by checking prisma client keys
const models = Object.keys(p).filter(k => !k.startsWith('$') && !k.startsWith('_'));
console.log('Models:', models.join(', '));
p.$disconnect();
