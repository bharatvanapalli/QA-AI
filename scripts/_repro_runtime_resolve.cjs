'use strict';
const path=require('path'); require('dotenv').config({path:path.join(__dirname,'..','.env')});
const { PrismaClient }=require('@prisma/client'); const prisma=new PrismaClient();
const tdm=require('../server/services/testDataMatrix');
const { loadTestDataContext }=require('../server/services/testDataContext');
const PID='465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse=(v)=>{if(!v)return null;if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
(async()=>{
  const nSets=await prisma.testDataSet.count({where:{projectId:PID}});
  console.log('testDataSet count:', nSets);
  const ctx=await loadTestDataContext(PID, null); // EXACT conductor call
  const sheets=(ctx&&ctx.sheets)||[];
  console.log('ctx sheets:', sheets.map(s=>s.name).join(', '));
  console.log('ctx AuthProfiles count:', sheets.filter(s=>/authprofiles/i.test(s.name)).length);
  const ap=sheets.find(s=>/authprofiles/i.test(s.name));
  console.log('ctx AuthProfiles row0 keys:', ap&&ap.rows&&ap.rows[0]?Object.keys(ap.rows[0]).join(','):'NO ROWS');
  console.log('ctx mapping bindings count:', (ctx&&ctx.mapping&&ctx.mapping.bindings||[]).length);
  const gen=await prisma.scenarioGeneration.findFirst({where:{projectId:PID,isCurrent:true},orderBy:{version:'desc'}});
  const cases=await prisma.testCase.findMany({where:{projectId:PID,generationId:gen.id}});
  const scns=await prisma.testScenario.findMany({where:{projectId:PID,generationId:gen.id}});
  const lc=cases.find(c=>/Admin login redirects to dashboard/i.test(c.name))||cases[0];
  const scn=scns.find(s=>s.id===lc.scenarioId);
  const rows=tdm.resolveCaseRows(lc, scn, ctx, {});
  console.log('\nCASE:', lc.name, '→ rows:', rows.length);
  if(rows.length){
    console.log('inputs:', JSON.stringify(rows[0].inputs));
    const sub=tdm.substituteCase(lc, rows[0]);
    const unresolved=tdm.findUnresolvedTokens(sub);
    console.log('findUnresolvedTokens →', JSON.stringify(unresolved));
  }
  await prisma.$disconnect();
})().catch(e=>{console.error('ERR',e.message);prisma.$disconnect();process.exit(1);});
