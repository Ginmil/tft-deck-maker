// 상징 어울림 감점이 동작하는지: 같은 시너지 수라면 어울리는 챔피언이 상징을 드는 팀이 더 높은 점수
import fs from 'fs';
import { normalize, listSets } from '../js/adapters/cdragon.js';
import { evaluateTeam } from '../js/engine/scorer.js';
import { emblemTeamMaker } from '../js/engine/search.js';
const raw = JSON.parse(fs.readFileSync(new URL('../data/sample-cdragon.json', import.meta.url)));
const d = normalize(raw, listSets(raw)[0].key);
const by = n => d.champions.find(c => c.name === n);
// 저격수 상징: 원거리 물리 딜러(검은표범)가 받을 수 있는 팀 vs 탱커만 받을 수 있는 팀
const good = ['솔방울','까마귀','올빼미','검은표범','곰','고목','사슴','참나무'].map(by);
const bad  = ['솔방울','까마귀','올빼미','매','곰','고목','사슴','참나무'].map(by);
const g = evaluateTeam(good, d, { emblems: ['TFT99_Sniper'] });
const b = evaluateTeam(bad, d, { emblems: ['TFT99_Sniper'] });
const who = r => r.assignment.map(a => d.champions.find(c => c.id === a.holder)?.name + (a.misfit ? '(부적합)' : '')).join();
console.log('good:', who(g), 'misfits', g.misfits);
console.log('bad :', who(b), 'misfits', b.misfits);
console.log('good 저격수 단계 =', g.traits.find(t => t.id === 'TFT99_Sniper').count, ' bad =', b.traits.find(t => t.id === 'TFT99_Sniper').count);
const r = emblemTeamMaker(d, { emblems: ['TFT99_Sniper', 'TFT99_Sniper'], size: 8, maxCost: 5, max5: 2 });
console.log('추천 덱 부적합 상징 수:', r.map(x => x.misfits).join(','), ' 5코 수:', r.map(x => x.team.filter(c => c.cost === 5).length).join(','));
