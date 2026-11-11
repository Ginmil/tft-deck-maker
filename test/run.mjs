import fs from 'fs';
import { listSets, normalize } from '../js/adapters/cdragon.js';
import { decksForTraits, decksForItems, emblemTeamMaker } from '../js/engine/search.js';
const raw = JSON.parse(fs.readFileSync(new URL('../data/sample-cdragon.json', import.meta.url)));
const sets = listSets(raw); console.log('sets', sets);
const d = normalize(raw, sets[0].key);
console.log('champs', d.champions.length, 'traits', Object.keys(d.traits).length, 'items', d.items.map(i=>i.name+':'+i.role).join(', '));
console.log('emblems', d.emblems.map(e=>e.name+'→'+e.trait).join(', '));
const show = (label, decks) => { console.log('\n==', label); for (const x of decks) console.log(
  x.score.toFixed(1), x.desiredMet?'OK':'--', x.team.map(c=>c.name).join(','), '|',
  x.traits.filter(t=>t.tier).map(t=>`${t.name}${t.count}${t.emblemOnly?'*':''}`).join(' '),
  '| 상징:', (x.assignment||[]).map(a=>`${d.traits[a.trait].name}→${d.champions.find(c=>c.id===a.holder)?.name||'X'}`).join(' ')); };
let t=Date.now();
show('결투가 4', decksForTraits(d, { desired:{TFT99_Duelist:4}, size:8, maxCost:5 }));
show('아이템 무대+라바돈+워모그', decksForItems(d, { itemIds:['TFT_Item_IE','TFT_Item_LW','TFT_Item_WM'], size:8, maxCost:5 }).map(x=>(console.log('carry',x.carry.name),x)));
show('상징: 결투가x2, 저격수', emblemTeamMaker(d, { emblems:['TFT99_Duelist','TFT99_Duelist','TFT99_Sniper'], size:8, maxCost:5 }));
console.log('\nms', Date.now()-t);
