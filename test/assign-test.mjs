// 아이템 자동 배분 테스트 (샘플 세트, 통계 없음 → 역할 기준)
// 실행: node test/assign-test.mjs
import fs from 'fs';
import assert from 'assert';
import { normalize, listSets } from '../js/adapters/cdragon.js';
import { assignItems } from '../js/engine/search.js';

const raw = JSON.parse(fs.readFileSync(new URL('../data/sample-cdragon.json', import.meta.url)));
const d = normalize(raw, listSets(raw)[0].key);
const ch = n => d.champions.find(c => c.name === n);
const C = n => `TFT_Item_${n}`;
const board = [
  { idx: 0, id: ch('검은표범').id, star: 2, items: [C('IE')] },   // 물리 캐리 (무한의 대검 보유)
  { idx: 1, id: ch('곰').id, star: 2, items: [] },                // 탱커
  { idx: 2, id: ch('대마법요정').id, star: 2, items: [] },         // 마법 캐리
  { idx: 3, id: ch('솔방울').id, star: 1, items: [] },
];
const r = assignItems(d, { board, inventory: [C('LW'), C('WM'), C('Rab'), C('BFSword'), C('SparringGloves'), C('Spatula')] });
const to = id => r.assignments.find(a => a.item.id === id)?.champ.name;
assert.equal(to(C('LW')), '검은표범', '물리 아이템은 이미 무한을 든 물리 캐리에게');
assert.equal(to(C('WM')), '곰', '탱커 아이템은 탱커에게');
assert.equal(to(C('Rab')), '대마법요정', '마법 아이템은 마법 캐리에게');
const crafted = r.assignments.find(a => a.from);
assert.ok(crafted, '재료(대검+장갑)로 완성 아이템을 만들어 배분');
assert.deepEqual([...crafted.from].sort(), [C('BFSword'), C('SparringGloves')].sort());
assert.deepEqual(r.leftComponents, [C('Spatula')], '짝 없는 뒤집개는 보관');
for (const a of r.assignments) {
  const held = board.find(b => b.idx === a.idx).items.length;
  assert.ok(held + r.assignments.filter(x => x.idx === a.idx).length <= 3, '한 챔피언 최대 3칸');
}
console.log(r.assignments.map(a => `${a.item.name}${a.from ? '(조합)' : ''} → ${a.champ.name}`).join(', '), '| 보관', r.leftComponents);
console.log('아이템 자동 배분 테스트 통과');
