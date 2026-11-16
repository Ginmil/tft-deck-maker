// 임시 점검: 렝가 + 요정/날렵이 (지울 것)
import fs from 'fs'; import path from 'path';
import { patchOf } from './stats-lib.mjs';
const sched = JSON.parse(fs.readFileSync('data/patches.json','utf8')).patches || JSON.parse(fs.readFileSync('data/patches.json','utf8'));
const dir = 'tools/cache'; const groups = {}; const boards = {};
let n=0;
for (const f of fs.readdirSync(dir)) { let m; try { m = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')); } catch { continue; }
  if (m?.info?.queue_id !== 1100) continue; n++;
  const pt = patchOf(m, Array.isArray(sched)?sched:null) || '?';
  for (const p of m.info.participants) {
    const r = p.units.find(u => /rengar/i.test(u.character_id)); if (!r) continue;
    const tr = Object.fromEntries(p.traits.filter(t=>t.tier_current>0).map(t=>[t.name,t.num_units]));
    const fae = tr.DA_18_Fae||0, spr = tr.DA_18_Sprykin||0;
    const em = r.itemNames.filter(i=>/Emblem/.test(i)).map(i=>i.replace('DA_18_Emblem',''));
    const key = `${pt} | 요정${fae?fae:'-'} 날렵이${spr?spr:'-'}`;
    const g = groups[key] ||= { n:0, sum:0, emb:{} }; g.n++; g.sum += p.placement;
    const ek = em.sort().join('+')||'없음'; g.emb[ek]=(g.emb[ek]||0)+1;
    if (fae>=2 && spr>=3) { const b = p.units.map(u=>u.character_id.replace(/da_?18_?|18/gi,'')).sort().join(',');
      const bb = boards[b] ||= {n:0,sum:0}; bb.n++; bb.sum+=p.placement; }
  }
}
console.log('경기', n);
for (const [k,g] of Object.entries(groups).sort()) if (g.n>=3) console.log(k, g.n+'판', (g.sum/g.n).toFixed(2)+'등', JSON.stringify(Object.entries(g.emb).sort((a,b)=>b[1]-a[1]).slice(0,4)));
console.log('--- 요정2+ 날렵이3+ 보드 상위');
for (const [b,x] of Object.entries(boards).sort((a,b)=>b[1].n-a[1].n).slice(0,12)) console.log(x.n+'판', (x.sum/x.n).toFixed(2), b);
