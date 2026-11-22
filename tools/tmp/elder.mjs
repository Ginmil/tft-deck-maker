import fs from 'fs';
const set = JSON.parse(fs.readFileSync('data/set-snapshot.json', 'utf8')).data;
const ct = {}; for (const c of Object.values(set.champions)) { const k = c.id.toLowerCase(); (ct[k] ||= new Set()); c.traits.forEach(t => ct[k].add(t)); }
const embTrait = {}; for (const e of set.emblems) for (const id of e.ids || [e.id]) embTrait[id] = e.trait;
const tid = n => Object.values(set.traits).find(t => t.name === n)?.id;
const ms = []; for (const f of fs.readdirSync('tools/cache')) if (f.endsWith('.json')) { try { ms.push(JSON.parse(fs.readFileSync('tools/cache/' + f, 'utf8'))); } catch {} }
const P187 = Date.UTC(2026, 10, 17, 21);
const checks = [['돌거북', 'da_krug18', '협곡야수'], ['케넨', 'da_18_kennen', '지옥불'], ['케넨', 'da_18_kennen', '처형자']];
const gn = new Set(); for (const m of ms) for (const p of m.info?.participants || []) for (const u of p.units || []) if (/gnar|krug/i.test(u.character_id)) gn.add(u.character_id); console.log('기록 id', [...gn].join(','));
const kid = Object.keys(ct).filter(k => /krug|kennen|ivern|gnar/.test(k)); console.log('ids', kid.join(','));
for (const [nm, id0, tn] of checks) {
  const t = tid(tn); const id = Object.keys(ct).find(k => k === id0) || Object.keys(ct).find(k => k.includes(id0.replace(/da_(18_)?/, '').replace('18', '')));
  for (const patch of ['18.6', '18.7']) {
    const res = { with: {}, without: {} };
    for (const m of ms) { if (m?.info?.queue_id !== 1100) continue; const p7 = (m.info.game_datetime || 0) >= P187; if ((patch === '18.7') !== p7) continue;
      for (const p of m.info.participants || []) {
        const ids = new Set((p.units || []).map(u => String(u.character_id).toLowerCase()));
        if ([...ids].some(i => /lux/.test(i))) continue;
        const tr = (p.traits || []).find(x => x.name === t); const rec = tr?.num_units || 0;
        let cnt = 0; for (const i of ids) if (ct[i]?.has(t)) cnt++;
        for (const u of p.units || []) { const i = String(u.character_id).toLowerCase(); for (const it of u.itemNames || []) if (embTrait[it] === t && !ct[i]?.has(t)) cnt++; }
        if (!rec && !cnt) continue;
        const k = ids.has(id) ? 'with' : 'without'; const d = rec - cnt; res[k][d] = (res[k][d] || 0) + 1;
      }
    }
    console.log(patch, nm, '→', tn, t, 'id', id, '| 있을 때', JSON.stringify(res.with), '| 없을 때', JSON.stringify(res.without));
  }
}
