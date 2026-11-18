import fs from 'fs';
const dir = 'tools/cache';
const ms = [];
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) { try { ms.push(JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'))); } catch {} }
const P18_7 = Date.UTC(2026, 10, 17, 21);
const EXE = ['da_18_yunara', 'da_18_ezreal', 'da_18_azir', 'da_18_kennen', 'da_18_soraka'];
const S = {}; const emb = {}; const embNo = {};
let n = 0;
for (const m of ms) {
  if (m?.info?.queue_id !== 1100) continue;
  if ((m.info.game_datetime || 0) >= P18_7) continue; // 18.6 만
  n++;
  for (const p of m.info.participants || []) {
    const ex = (p.traits || []).find(t => /Executioner/i.test(t.name));
    const tier = ex?.tier_current || 0, cnt = ex?.num_units || 0;
    for (const u of p.units || []) {
      const id = String(u.character_id).toLowerCase();
      const items = (u.itemNames || []).filter(x => typeof x === 'string');
      for (const it of items) if (/Executioner.*Emblem|Emblem.*Executioner/i.test(it)) {
        const k = id + (tier ? ' on' + cnt : ' off'); emb[k] = (emb[k] || 0) + 1;
      }
      if (!EXE.includes(id)) continue;
      const nonEmb = items.filter(x => !/emblem/i.test(x) && !/Thief/i.test(x));
      if (nonEmb.length < 3) continue;
      const key = id + '|' + (tier ? 'on' : 'off');
      const r = S[key] ||= { g: 0, sp: 0, ie: 0, ieSp: 0, jg: 0, jgSp: 0, items: {}, builds: {}, cnt: {} };
      r.g++; r.sp += p.placement; r.cnt[cnt] = (r.cnt[cnt] || 0) + 1;
      const hasIE = nonEmb.some(x => /InfinityEdge/i.test(x)), hasJG = nonEmb.some(x => /JeweledGauntlet/i.test(x));
      if (hasIE) { r.ie++; r.ieSp += p.placement; }
      if (hasJG) { r.jg++; r.jgSp += p.placement; }
      for (const it of new Set(nonEmb)) r.items[it] = (r.items[it] || 0) + 1;
      const b = [...nonEmb].sort().join('+'); const bb = r.builds[b] ||= [0, 0]; bb[0]++; bb[1] += p.placement;
    }
  }
}
console.log('18.6 경기', n);
const sh = s => s.replace(/^(DA_Item_|DA_|TFT\d*_Item_|TFT_Item_)/, '');
for (const [k, r] of Object.entries(S).sort()) {
  console.log(`\n== ${k} 3템 ${r.g}판 평균 ${(r.sp / r.g).toFixed(2)} 처형자인원 ${JSON.stringify(r.cnt)}`);
  console.log(`  IE ${(100 * r.ie / r.g).toFixed(0)}% (${r.ie}판 ${r.ie ? (r.ieSp / r.ie).toFixed(2) : '-'}) / IE없음 ${r.g - r.ie}판 ${r.g - r.ie ? ((r.sp - r.ieSp) / (r.g - r.ie)).toFixed(2) : '-'}  JG ${(100 * r.jg / r.g).toFixed(0)}% (${r.jg}판 ${r.jg ? (r.jgSp / r.jg).toFixed(2) : '-'})`);
  console.log('  아이템', Object.entries(r.items).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i, c]) => sh(i) + ' ' + (100 * c / r.g).toFixed(0) + '%').join(', '));
  console.log('  3신기', Object.entries(r.builds).sort((a, b) => b[1][0] - a[1][0]).slice(0, 5).map(([b, [c, sp]]) => b.split('+').map(sh).join('+') + ` ${c}판 ${(sp / c).toFixed(2)}`).join(' | '));
}
console.log('\n처형자 상징 받은 챔피언 (처형자 on/off + 인원):');
console.log(Object.entries(emb).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, c]) => k + ' ' + c).join('\n'));
