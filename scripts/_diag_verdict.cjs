'use strict';
const path=require('path'); require('dotenv').config({path:path.join(__dirname,'..','.env')});
const { PrismaClient }=require('@prisma/client'); const prisma=new PrismaClient();
const PID='465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse=(v)=>{if(!v)return null;if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
(async()=>{
  const run=await prisma.run.findFirst({where:{projectId:PID},orderBy:{startedAt:'desc'}});
  console.log('RUN',run.id.slice(0,8),'status='+run.status,'started='+run.startedAt.toISOString().slice(11,19));
  const tc=await prisma.testCase.findFirst({where:{projectId:PID,name:{contains:'Admin login redirects to dashboard'}},orderBy:{createdAt:'desc'}});
  const rr=await prisma.runResult.findFirst({where:{runId:run.id,testCaseId:tc.id}});
  if(!rr){console.log('no RunResult for TC-1 in latest run; trying any recent run');}
  const r=rr||await prisma.runResult.findFirst({where:{testCaseId:tc.id},orderBy:{id:'desc'}});
  console.log('\n=== RunResult fields ===');
  console.log('status:', r.status);
  for(const k of ['mechanicalVerdictReason','verdict','verdictReason','error','aiVerdict','aiVerdictReason','heldReason','reviewReason']){ if(r[k]!=null) console.log(k+':', String(r[k]).slice(0,200)); }
  const allKeys=Object.keys(r);
  console.log('\nALL RunResult keys:', allKeys.join(', '));
  // assertion check results
  for(const k of allKeys){ if(/assertion|verdict|check|evidence|trail/i.test(k)){ const v=parse(r[k]); if(v){ console.log('\n--- '+k+' ---'); console.log(JSON.stringify(v).slice(0,900)); } } }
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message,e.stack);prisma.$disconnect();process.exit(1);});
