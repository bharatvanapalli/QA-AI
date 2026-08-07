const Database = require('better-sqlite3');
const db = new Database('C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/qaai_fixed/prisma/dev.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables.map(t=>t.name).join('\n'));
