// 임시 점검: 경기 데이터의 시너지 인원(num_units)이 챔피언·상징(사이트 데이터 기준)으로 설명되지 않는 판
import fs from 'fs';
const d = JSON.parse(fs.readFileSync('data/set-snapshot.json', 'utf8')).data;
const champs = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
const embTrait = new Map((d.emblems || []).map(e => [e.id, e.trait]));
const TR = process.argv[2];
let checked = 0, extra = 0, shown = 0; const diffs = {}, withUnit = {}, base = {};
for (const f of fs.readdirSync('tools/cache')) {
  const m = JSON.parse(fs.readFileSync(`tools/cache/${f}`, 'utf8'));
  if (m?.info?.tft_set_number !== 18) continue;
  for (const p of m.info.participants || []) {
    const t = (p.traits || []).find(x => x.name === TR); if (!t) continue;
    checked++;
    const seen = new Set(); let have = 0, luxBase = false;
    for (const u of p.units || []) {
      const id = String(u.character_id).toLowerCase(); if (seen.has(id)) continue; seen.add(id);
      const c = champs.get(id); if (/lux18_base/.test(id)) luxBase = true;
      const hasT = c?.traits.includes(TR);
      if (hasT) have++;
      for (const it of u.itemNames || []) if (embTrait.get(it) === TR && !hasT) have++;
    }
    const diff = t.num_units - have;
    diffs[diff] = (diffs[diff] || 0) + 1;
    for (const id of seen) { base[id] = (base[id] || 0) + 1; if (diff > 0) withUnit[id] = (withUnit[id] || 0) + 1; }
    if (diff > 0) { extra++; if (shown < 3 && !luxBase) { shown++; console.log(`  ${TR} ${t.num_units} / 계산 ${have}: ${(p.units || []).map(u => `${u.character_id}*${u.tier}[${(u.itemNames || []).filter(n => /Emblem/.test(n)).join(',')}]`).join(' ')}`); } }
  }
}
console.log(TR, 'checked', checked, 'extra', extra, 'diff 분포', JSON.stringify(diffs));
console.log('  추가 인원 판 비율이 높은 유닛', Object.entries(withUnit).filter(([k]) => base[k] >= 50).map(([k, v]) => [k, v / base[k], base[k]]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, r, n]) => `${k} ${(r * 100).toFixed(0)}%(${n})`).join(' '));
