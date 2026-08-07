'use strict';
const path=require('path'); require('dotenv').config({path:path.join(__dirname,'..','.env')});
const { PrismaClient }=require('@prisma/client'); const prisma=new PrismaClient();
const PID='465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse=(v)=>{if(!v)return null;if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
(async()=>{
  // discover clause model name
  const models=Object.keys(prisma).filter(k=>/clause|requirement/i.test(k)&&!k.startsWith('_')&&!k.startsWith('$'));
  let clauses=[];
  try { clauses = await prisma.requirementClause.findMany({ where:{ projectId: PID } }); } catch(e){ console.log('clause model err:', e.message); }
  console.log('clause models:', models.join(', '), '| clause rows:', clauses.length);
  const gen=await prisma.scenarioGeneration.findFirst({where:{projectId:PID,isCurrent:true},orderBy:{version:'desc'}});
  const cases=await prisma.testCase.findMany({where:{projectId:PID,generationId:gen.id}});
  const covered=new Set();
  for(const c of cases){ let r=c.requirementRefs; if(typeof r==='string')r=parse(r); if(Array.isArray(r))r.forEach(x=>covered.add(x)); }
  const uncovered = clauses.filter(c=>!covered.has(c.id));
  console.log(`covered=${covered.size} uncovered=${uncovered.length}\n=== UNCOVERED CLAUSES ===`);
  for(const u of uncovered){
    const txt=(u.behaviourText||u.behaviorText||u.text||u.excerpt||'').replace(/\s+/g,' ').slice(0,120);
    console.log(`  [${u.sourceType||'?'}] ${u.id}: ${txt}`);
  }
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message);prisma.$disconnect();process.exit(1);});
