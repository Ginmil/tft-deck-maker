for (const url of ['https://raw.communitydragon.org/latest/cdragon/tft/ko_kr.json', 'https://raw.communitydragon.org/pbe/cdragon/tft/ko_kr.json']) {
  try {
    const r = await fetch(url); const j = await r.json();
    const sets = j.setData || j.sets; const s = Array.isArray(sets) ? sets.find(x => (x.mutator || '').includes('18') || x.number === 18) : null;
    const champs = (s?.champions) || [];
    const f = n => champs.find(c => c.name === n);
    console.log(url, r.headers.get('last-modified'), 'sets', Array.isArray(sets) ? sets.map(x => x.mutator).join(',') : '?');
    for (const n of ['아이번', '케넨', '돌거북']) console.log('  ', n, JSON.stringify(f(n)?.traits));
  } catch (e) { console.log(url, 'ERR', e.message); }
}
const v = await fetch('https://raw.communitydragon.org/latest/content-metadata.json').then(r => r.text()).catch(e => e.message); console.log('meta', v.slice(0, 200));
