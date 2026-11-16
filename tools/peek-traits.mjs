// 임시 점검: 경기 데이터의 시너지 인원(num_units)이 챔피언·상징으로 설명되지 않는 판 예시 출력
import fs from 'fs';
const dir = 'tools/cache', TR = process.argv[2] || 'DA_18_Elderwood';
const ko = JSON.parse(fs.readFileSync('ko.json', 'utf8'));
const set = ko.setData?.find(s => s.mutator === 'TFTSet18') || ko.setData?.at(-1) || ko.sets?.['18'];
const champs = new Map((set?.champions || []).map(c => [String(c.apiName).toLowerCase(), c]));
const trName = new Map((set?.traits || []).map(t => [t.apiName, t.name]));
let shown = 0, checked = 0, extra = 0;
const unitFreq = {}, itemFreq = {};
for (const f of fs.readdirSync(dir)) {
  const m = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  for (const p of m?.info?.participants || []) {
    const t = (p.traits || []).find(x => x.name === TR); if (!t) continue;
    checked++;
    const names = new Set(); let have = 0;
    for (const u of p.units || []) {
      const c = champs.get(String(u.character_id).toLowerCase());
      const tn = (c?.traits || []);
      if (!names.has(u.character_id) && tn.includes(trName.get(TR))) have++;
      names.add(u.character_id);
      for (const it of u.itemNames || []) if (/Emblem/i.test(it) && it.toLowerCase().includes(TR.replace('DA_18_', '').toLowerCase())) have++;
    }
    if (t.num_units > have) {
      extra++;
      for (const u of p.units || []) unitFreq[u.character_id] = (unitFreq[u.character_id] || 0) + 1;
      if (shown < 4) { shown++; console.log(`num_units ${t.num_units} / 계산 ${have} :: ` + (p.units || []).map(u => `${u.character_id}*${u.tier}[${(u.itemNames || []).join(',')}]`).join(' ')); console.log('   traits', (p.traits || []).map(x => `${x.name}:${x.num_units}`).join(' '), ' keys', Object.keys(p).join(',')); }
    }
  }
}
console.log('checked', checked, 'extra', extra);
console.log('설명 안 되는 판에 자주 있는 유닛', Object.entries(unitFreq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}:${v}`).join(' '));
