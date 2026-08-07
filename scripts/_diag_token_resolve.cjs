'use strict';
const path=require('path'); require('dotenv').config({path:path.join(__dirname,'..','.env')});
const { PrismaClient }=require('@prisma/client'); const prisma=new PrismaClient();
const tdm=require('../server/services/testDataMatrix');
const PID='465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse=(v)=>{if(!v)return null;if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
(async()=>{
  const gen=await prisma.scenarioGeneration.findFirst({where:{projectId:PID,isCurrent:true},orderBy:{version:'desc'}});
  const tds=await prisma.testDataSet.findFirst({where:{projectId:PID},orderBy:{uploadedAt:'desc'}});
  const testData={ sheets: parse(tds.sheetsJson)?.sheets || parse(tds.sheetsJson), mapping: parse(tds.mappingJson) };
  const scns=await prisma.testScenario.findMany({where:{projectId:PID,generationId:gen.id}});
  const cases=await prisma.testCase.findMany({where:{projectId:PID,generationId:gen.id},orderBy:{createdAt:'asc'}});
  const loginCase=cases.find(c=>/Admin login redirects to dashboard/i.test(c.name))||cases[0];
  const scn=scns.find(s=>s.id===loginCase.scenarioId);
  console.log(`CASE: "${loginCase.name}"`);
  const db=parse(loginCase.dataBindingJson);
  console.log('dataBindingJson:', JSON.stringify(db));
  // mapping binding for the sheet
  const mp=testData.mapping; const b=(mp.bindings||[]).find(x=>db&&x.sheet===db.sheet);
  console.log('mapping binding columnToField:', JSON.stringify(b&&b.columnToField));
  console.log('sheet exists:', !!(testData.sheets||[]).find(s=>s.name===(db&&db.sheet)));
  // run resolveCaseRows
  const rows=tdm.resolveCaseRows(loginCase, scn, testData, {});
  console.log('resolveCaseRows → rows:', rows.length);
  if(rows.length){ console.log('row[0].inputs:', JSON.stringify(rows[0].inputs)); console.log('row[0].raw keys:', Object.keys(rows[0].raw||{}).join(',')); 
    const sub=tdm.substituteCase(loginCase, rows[0]);
    const steps=parse(sub.steps)||[];
    const loginSteps=steps.filter(s=>/\{\{|username|password|fill|type/i.test(JSON.stringify(s))).slice(0,4);
    console.log('substituted login-ish steps:'); loginSteps.forEach(s=>console.log('   ',JSON.stringify(s).slice(0,160)));
  } else {
    console.log('>>> resolveCaseRows returned [] → NO substitution → tokens stay literal. parseExplicitBinding:', JSON.stringify(tdm.hydrateBinding? 'hydrate-exists':'?'));
  }
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message,e.stack);prisma.$disconnect();process.exit(1);});
