const j = await (await fetch('https://raw.communitydragon.org/latest/cdragon/tft/ko_kr.json')).json();
const sets = j.setData || j.sets; const all = Array.isArray(sets) ? sets : Object.values(sets);
const s18 = all.filter(s => String(s.number) === '18' || /DA_/.test(JSON.stringify((s.champions || []).slice(0, 1))));
console.log('sets', all.map(s => s.number + ':' + s.mutator).join(' '));
for (const s of s18.slice(0, 2)) {
  const t = (s.traits || []).find(t => /Riftbeast/i.test(t.apiName));
  if (t) console.log('TRAIT', s.mutator, JSON.stringify(t.effects).slice(0, 1500));
  for (const c of (s.champions || []).filter(c => /Krug18|Murkwolf18|Brambleback18|Pebble|Raptor|Sentry|Scuttle/i.test(c.apiName))) console.log('CHAMP', c.apiName, JSON.stringify(c.ability?.variables || []).slice(0, 600));
}
for (const id of ['da_krug18', 'da_murkwolf18', 'da_brambleback18']) {
  try {
    const t = await (await fetch(`https://raw.communitydragon.org/latest/game/characters/${id}.cdtb.bin.json`)).text();
    for (const k of ['TraitShieldHealth', 'TraitBaseCrit', 'TraitMaxHealthHeal', 'TraitBonusCrit']) {
      const i = t.indexOf(k); if (i >= 0) console.log(id, k, t.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, ' '));
    }
  } catch (e) { console.log(id, 'ERR', e.message); }
}
