import fs from 'fs';
const set = JSON.parse(fs.readFileSync('data/set-snapshot.json', 'utf8')).data;
const ct = {}; for (const c of Object.values(set.champions)) { const k = c.id.toLowerCase(); (ct[k] ||= new Set()); c.traits.forEach(t => ct[k].add(t)); }
const embTrait = {}; for (const e of set.emblems) for (const id of e.ids || [e.id]) embTrait[id] = e.trait;
const ms = []; for (const f of fs.readdirSync('tools/cache')) if (f.endsWith('.json')) { try { ms.push(JSON.parse(fs.readFileSync('tools/cache/' + f, 'utf8'))); } catch {} }
// 럭스 없는 판만: 시너지별 (기록 - 챔피언·상징 계산) 분포, 아이번 있음/없음
const T = ['DA_18_Elderwood', 'DA_18_Brawler', 'DA_18_Vanguard', 'DA_Juggernaut18', 'DA_18_Riftbeast', 'DA_18_Lunar', 'DA_18_Fae', 'DA_18_Inferno'];
const res = {};
for (const m of ms) { if (m?.info?.queue_id !== 1100) continue;
  for (const p of m.info.participants || []) {
    const ids = new Set((p.units || []).map(u => String(u.character_id).toLowerCase()));
    if ([...ids].some(i => /lux/.test(i))) continue;
    const iv = ids.has('da_18_ivern') ? 'ivern' : 'noIvern';
    for (const t of T) {
      const tr = (p.traits || []).find(x => x.name === t); if (!tr || !tr.num_units) continue;
      let cnt = 0; for (const id of ids) if (ct[id]?.has(t)) cnt++;
      for (const u of p.units || []) { const id = String(u.character_id).toLowerCase(); for (const it of u.itemNames || []) if (embTrait[it] === t && !ct[id]?.has(t)) cnt++; }
      const d = tr.num_units - cnt; const k = t.replace(/DA_(18_)?/, '') + ' ' + iv;
      (res[k] ||= {})[d] = (res[k][d] || 0) + 1;
    }
  }
}
for (const [k, v] of Object.entries(res).sort()) console.log(k, JSON.stringify(v));
