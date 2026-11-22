import fs from 'fs';
const set = JSON.parse(fs.readFileSync('data/set-snapshot.json', 'utf8')).data;
const ct = {}; for (const c of Object.values(set.champions)) { const k = c.id.toLowerCase(); (ct[k] ||= new Set()); c.traits.forEach(t => ct[k].add(t)); }
const EW = Object.values(set.traits).find(t => t.name === '나무정령').id;
const embTrait = {}; for (const e of set.emblems) for (const id of e.ids || [e.id]) embTrait[id] = e.trait;
const nm = id => (Object.values(set.champions).find(c => c.id.toLowerCase() === id)?.name) || id;
const ms = []; for (const f of fs.readdirSync('tools/cache')) if (f.endsWith('.json')) { try { ms.push(JSON.parse(fs.readFileSync('tools/cache/' + f, 'utf8'))); } catch {} }
const P187 = Date.UTC(2026, 10, 17, 21);
console.log('EW', EW, 'matches', ms.length);
// A: 나무정령 인원 기록 vs 계산
const diffBy = {}, tot = {}; const ex = [];
let n6 = 0, n6lil = 0;
for (const m of ms) { if (m?.info?.queue_id !== 1100) continue;
  for (const p of m.info.participants || []) {
    const tr = (p.traits || []).find(t => t.name === EW); if (!tr || !tr.num_units) continue;
    const seen = new Set(); let cnt = 0; let emb = 0;
    for (const u of p.units || []) { const id = String(u.character_id).toLowerCase(); if (!seen.has(id)) { seen.add(id); if (ct[id]?.has(EW)) cnt++; }
      for (const it of u.itemNames || []) if (embTrait[it] === EW && !ct[id]?.has(EW)) emb++; }
    const d = tr.num_units - cnt - emb;
    const key = 'diff' + d; tot[key] = (tot[key] || 0) + 1;
    for (const id of seen) { (diffBy[id] ||= {}); diffBy[id][key] = (diffBy[id][key] || 0) + 1; }
    if (tr.num_units === 6) { n6++; if (seen.has('da_18_lillia')) n6lil++; }
    if (d !== 0 && ex.length < 6) ex.push({ rec: tr.num_units, champs: cnt, emb, units: [...seen].map(nm).join(',') });
  }
}
console.log('기록-계산 차이 분포', tot, '| 6나무정령 판', n6, '그중 릴리아', n6lil);
const rows = Object.entries(diffBy).map(([id, o]) => { const all = Object.values(o).reduce((a, b) => a + b, 0); const plus = all - (o.diff0 || 0); return [nm(id), all, plus, (plus / all * 100).toFixed(0) + '%']; }).filter(r => r[1] >= 30).sort((a, b) => b[2] / b[1] - a[2] / a[1]).slice(0, 12);
console.log('챔피언별 (나무정령 켜진 판, 차이 있는 판, 비율):'); for (const r of rows) console.log('  ', r.join(' | '));
console.log('예시', JSON.stringify(ex, null, 0));
// B: 드레이븐 캐리 + 나무정령 6+ , 18.7
const players = {}; let g = 0, sp = 0; const boards = {};
for (const m of ms) { if (m?.info?.queue_id !== 1100 || (m.info.game_datetime || 0) < P187) continue;
  for (const p of m.info.participants || []) {
    const tr = (p.traits || []).find(t => t.name === EW); if (!tr || tr.num_units < 6) continue;
    const dr = (p.units || []).find(u => /draven/i.test(u.character_id)); if (!dr || (dr.itemNames || []).length < 2) continue;
    g++; sp += p.placement; players[p.puuid] = (players[p.puuid] || 0) + 1;
    const k = (p.units || []).map(u => nm(String(u.character_id).toLowerCase())).sort().join(','); (boards[k] ||= []).push(p.placement);
  }
}
console.log('\n18.7 드레이븐(템2+) + 나무정령 6이상:', g, '판 평균', (sp / g).toFixed(2), '서로 다른 플레이어', Object.keys(players).length, '| 한 사람 최다', Math.max(...Object.values(players)));
console.log('플레이어별 판수', Object.values(players).sort((a, b) => b - a).join(','));
for (const [k, v] of Object.entries(boards).sort((a, b) => b[1].length - a[1].length).slice(0, 5)) console.log('  ', v.length + '판', v.join('/'), k);
// 레벨
