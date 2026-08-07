'use strict';
const path=require('path'); require('dotenv').config({path:path.join(__dirname,'..','.env')});
const { PrismaClient }=require('@prisma/client'); const prisma=new PrismaClient();
const PID='465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse=(v)=>{if(!v)return null;if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
const LOGIN_URL_RE=/(\/auth\b|\/login\b|sign[-_ ]?in|logon)/i;
const PWD_RE=/password|pwd|\{\{\s*password\s*\}\}/i;
const navAct=(s)=>/nav|goto|go\s*to|open|visit/i.test(String(s&&(s.action||s.type)||''));
const navUrl=(s)=>{const v=s&&(s.value||s.url||s.target||s.element||'');const m=String(v||'').match(/https?:\/\/[^\s"']+|\/[A-Za-z0-9_\-.\/]+/);return m?m[0]:'';};
const blob=(s)=>{try{return JSON.stringify(s).toLowerCase();}catch{return'';}};
(async()=>{
  const gen=await prisma.scenarioGeneration.findFirst({where:{projectId:PID,isCurrent:true},orderBy:{version:'desc'}});
  const scns=await prisma.testScenario.findMany({where:{projectId:PID,generationId:gen.id},orderBy:{createdAt:'asc'}});
  const cases=await prisma.testCase.findMany({where:{projectId:PID,generationId:gen.id},orderBy:{createdAt:'asc'}});
  console.log(`v${gen.version}: ${scns.length} scn / ${cases.length} cases\n`);
  let violations=0, withLoginPrologue=0, authFlowCases=0;
  for(const s of scns){
    const mine=cases.filter(c=>c.scenarioId===s.id);
    const isLogoutish=/logout|session termination|sign.?out/i.test(s.name||'');
    for(const c of mine){
      const steps=parse(c.steps)||[];
      if(!steps.length) continue;
      const firstNav=steps.find(navAct);
      const entersAuthUrl = firstNav && navUrl(firstNav) && !LOGIN_URL_RE.test(navUrl(firstNav));
      const wholeBlob=steps.map(blob).join(' ');
      const establishesLogin = LOGIN_URL_RE.test(wholeBlob) && PWD_RE.test(wholeBlob);
      const deps=parse(c.dependsOnNames)||c.dependsOnNames||[];
      const hasDep=Array.isArray(deps)&&deps.length>0;
      // a case is an "authenticated flow" if it enters a non-login url
      if(entersAuthUrl){
        authFlowCases++;
        if(establishesLogin) withLoginPrologue++;
        else if(!hasDep){ violations++; 
          console.log(`  [VIOLATION] "${s.name}" › "${c.name}" enters auth URL ${navUrl(firstNav)} w/o login & no dep`);
        }
      }
      if(isLogoutish){
        console.log(`LOGOUT-ISH SCENARIO "${s.name}" › "${c.name}" (${steps.length} steps, establishesLogin=${establishesLogin}, deps=${hasDep}):`);
        steps.slice(0,6).forEach((st,i)=>console.log(`   ${i+1}. ${String(st.action||st.type||'?')} | ${String((st.value||st.element||st.target||'')).slice(0,70)}`));
        console.log('');
      }
    }
  }
  console.log(`\nauthFlowCases=${authFlowCases} withLoginPrologue=${withLoginPrologue} VIOLATIONS(enters-auth-no-login-no-dep)=${violations}`);
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message);prisma.$disconnect();process.exit(1);});
