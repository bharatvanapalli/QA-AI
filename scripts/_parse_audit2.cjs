'use strict';
const fs=require('fs');
const J='C:/Users/2461898/.claude/projects/c--Users-2461898-Downloads-qaai-fixed-qaai-fixed/35964558-8433-4e0f-a5db-fb5ca84240a9/subagents/workflows/wf_e369a669-622/journal.jsonl';
const lines=fs.readFileSync(J,'utf8').split(/\r?\n/).filter(Boolean);
const finderGaps=[]; const verdicts=[];
for(const ln of lines){ let e; try{e=JSON.parse(ln);}catch{continue;} if(e.type!=='result'||!e.result)continue; const r=e.result;
  if(r.subsystem&&Array.isArray(r.gaps)) for(const g of r.gaps) finderGaps.push({...g, subsystem:r.subsystem});
  else if(typeof r.isRealGap==='boolean'&&r.title) verdicts.push(r);
}
const key=(s)=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(w=>w.length>3).slice(0,6).join(' ');
const findFor=(v)=>{ const vk=key(v.title); let best=null,bs=0; for(const g of finderGaps){ const gk=key(g.title); const gw=new Set(gk.split(' ')); const hit=vk.split(' ').filter(w=>gw.has(w)).length; if(hit>bs){bs=hit;best=g;} } return bs>=2?best:null; };
const confirmed=verdicts.filter(v=>v.isRealGap&&v.correctedSeverity!=='not-a-gap');
const refuted=verdicts.filter(v=>!v.isRealGap||v.correctedSeverity==='not-a-gap');
const so={blocker:0,high:1,medium:2,low:3};
confirmed.sort((a,b)=>(so[a.correctedSeverity]??9)-(so[b.correctedSeverity]??9));
const bySev=(arr)=>['blocker','high','medium','low'].map(s=>`${s}:${arr.filter(r=>r.correctedSeverity===s).length}`).join('  ');
console.log(`FINDER_GAPS=${finderGaps.length}  VERDICTS=${verdicts.length}  (4 verifiers were stopped before finishing)`);
console.log(`CONFIRMED=${confirmed.length}  REFUTED/downgraded=${refuted.length}`);
console.log(`CONFIRMED severity → ${bySev(confirmed)}`);
console.log('\n==== CONFIRMED GAPS (verified real, ranked) ====');
let i=0; for(const v of confirmed){ i++; const g=findFor(v);
  console.log(`\n${i}. [${v.correctedSeverity.toUpperCase()}/${v.confidence}] ${v.title}`);
  if(g) console.log(`   subsystem: ${g.subsystem.split('(')[0].trim()} | breaks-on: ${(g.universalRisk||'').slice(0,150)}`);
  console.log(`   verifier: ${(v.reasoning||'').replace(/\s+/g,' ').slice(0,300)}`);
}
console.log('\n==== REFUTED / DOWNGRADED (false or non-gaps) ====');
for(const v of refuted){ console.log(`  - [${v.correctedSeverity}] ${v.title}\n      ${(v.reasoning||'').replace(/\s+/g,' ').slice(0,220)}`); }
