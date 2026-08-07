'use strict';
const fs=require('fs');
const J='C:/Users/2461898/.claude/projects/c--Users-2461898-Downloads-qaai-fixed-qaai-fixed/35964558-8433-4e0f-a5db-fb5ca84240a9/subagents/workflows/wf_e369a669-622/journal.jsonl';
const lines=fs.readFileSync(J,'utf8').split(/\r?\n/).filter(Boolean);
const finders=[]; const verdicts=new Map();
for(const ln of lines){
  let e; try{e=JSON.parse(ln);}catch{continue;}
  if(e.type!=='result'||!e.result) continue;
  const r=e.result;
  if(r.subsystem && Array.isArray(r.gaps)) finders.push(r);
  else if(typeof r.isRealGap==='boolean' && r.title) verdicts.set(r.title.trim(), r);
}
const norm=(s)=>String(s||'').trim();
let totalGaps=0, confirmed=[], refuted=[], unverified=[];
for(const f of finders){
  for(const g of f.gaps){
    totalGaps++;
    const v=verdicts.get(norm(g.title));
    const rec={subsystem:f.subsystem, title:g.title, claimedSev:g.severity, mechanism:g.mechanism, evidence:g.evidence, universalRisk:g.universalRisk, fix:g.fixDirection, verdict:v};
    if(!v) unverified.push(rec);
    else if(v.isRealGap && v.correctedSeverity!=='not-a-gap') confirmed.push(rec);
    else refuted.push(rec);
  }
}
const sevOrder={blocker:0,high:1,medium:2,low:3};
const sevOf=(r)=> r.verdict ? r.verdict.correctedSeverity : r.claimedSev;
confirmed.sort((a,b)=>(sevOrder[sevOf(a)]??9)-(sevOrder[sevOf(b)]??9));
console.log(`FINDERS=${finders.length}/8  GAPS_CLAIMED=${totalGaps}  VERDICTS=${verdicts.size}`);
console.log(`CONFIRMED=${confirmed.length}  REFUTED=${refuted.length}  UNVERIFIED=${unverified.length}`);
const bySev=(arr)=>['blocker','high','medium','low'].map(s=>`${s}:${arr.filter(r=>sevOf(r)===s).length}`).join('  ');
console.log(`CONFIRMED by severity → ${bySev(confirmed)}`);
console.log('\n================ CONFIRMED GAPS (ranked) ================');
for(const r of confirmed){
  console.log(`\n[${(r.verdict?r.verdict.correctedSeverity:r.claimedSev).toUpperCase()}] (${r.verdict?r.verdict.confidence:'?'} conf) ${r.title}`);
  console.log(`  subsystem: ${r.subsystem.split('(')[0].trim()}`);
  console.log(`  why it breaks: ${(r.universalRisk||'').slice(0,240)}`);
  console.log(`  evidence: ${(r.evidence||'').slice(0,200)}`);
  if(r.verdict) console.log(`  verifier: ${(r.verdict.reasoning||'').slice(0,260)}`);
}
console.log('\n================ REFUTED (false alarms) ================');
for(const r of refuted) console.log(`  [${r.claimedSev}→not-a-gap] ${r.title}\n     verifier: ${(r.verdict.reasoning||'').slice(0,200)}`);
if(unverified.length){console.log('\n================ UNVERIFIED (verifier not finished) ================');
for(const r of unverified) console.log(`  [${r.claimedSev}?] ${r.title}`);}
