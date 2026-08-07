const path=require('path');process.chdir(path.join(__dirname,'..'));
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{const r=await p.run.updateMany({where:{projectId:'465f2d08-c8b5-469a-af41-9c0ba2a2ce93',status:'running'},data:{status:'cancelled',completedAt:new Date()}});console.log('orphaned runs cancelled:',r.count);await p.$disconnect();})();
