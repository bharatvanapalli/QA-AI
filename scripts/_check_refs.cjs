'use strict';
const path=require('path'); require('dotenv').config({path:path.join(__dirname,'..','.env')});
const { PrismaClient }=require('@prisma/client'); const prisma=new PrismaClient();
const PID='465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse=(v)=>{if(!v)return null;if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
(async()=>{
  const gen=await prisma.scenarioGeneration.findFirst({where:{projectId:PID,isCurrent:true},orderBy:{version:'desc'}});
  const cases=await prisma.testCase.findMany({where:{projectId:PID,generationId:gen.id},orderBy:{createdAt:'asc'}});
  // probe the actual column name for requirement refs
  const sample=cases[0];
  const keys=Object.keys(sample).filter(k=>/req|ref|trace/i.test(k));
  console.log('candidate ref columns:', keys.join(', ')||'(none)');
  let withRefs=0, total=0;
  for(const c of cases){
    let refs = c.requirementRefs;
    if (typeof refs==='string') refs=parse(refs);
    if (!Array.isArray(refs)) refs = parse(c.requirementRefsJson);
    const n = Array.isArray(refs)?refs.length:0;
    total+=n; if(n>0) withRefs++;
  }
  console.log(`cases=${cases.length} withRefs=${withRefs} totalRefs=${total}`);
  // out-of-scope check
  const scns=await prisma.testScenario.findMany({where:{projectId:PID,generationId:gen.id}});
  const oos=scns.filter(s=>/^\s*\[OUT OF SCOPE\]/i.test(s.rationale||''));
  console.log(`scenarios=${scns.length} outOfScope=${oos.length}`);
  // zero-step cases
  const zero=cases.filter(c=>{const s=parse(c.steps)||[];return s.length===0;});
  console.log(`zero-step cases=${zero.length}${zero.length?': '+zero.map(c=>c.name).join(' | '):''}`);
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message);prisma.$disconnect();process.exit(1);});
