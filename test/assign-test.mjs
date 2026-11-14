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

// 실제 Set 18 데이터 + 랭커 통계로 사용자 정답 시나리오 (11/15 사용자 피드백)
// 자이라에게 공허 + 모렐로 + 블루(눈물 2개) — 블루가 자이라에게 최고는 아니지만 캐리 3칸을 채우는 게 맞음.
// 아무무에게 워모그를 나눠 주면 안 됨. 홀수 재료 중 허리띠를 남기는 것도 선택지여야 함.
const snapPath = new URL('../data/set-snapshot.json', import.meta.url), wPath = new URL('../data/weights.json', import.meta.url);
if (fs.existsSync(snapPath) && fs.existsSync(wPath)) {
  const rd = JSON.parse(fs.readFileSync(snapPath)).data;
  const w = JSON.parse(fs.readFileSync(wPath));
  if (w.setNumber === rd.set.number) {
    rd.unitStats = w.units;
    const rc = n => rd.champions.find(c => c.name === n)?.id, ri = n => rd.items.find(i => i.name === n)?.id, rp = n => rd.components.find(c => c.name === n)?.id;
    const held = { 말파이트: ['가고일 돌갑옷', '워모그의 갑옷'], 소라카: ['대천사의 지팡이', '라바돈의 죽음모자'] };
    const names = ['말파이트', '피들스틱', '쉔', '요릭', '아무무', '자이라', '아지르', '소라카'];
    if (names.every(rc)) {
      const rboard = names.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: (held[n] || []).map(ri) }));
      const inv = ['B.F. 대검', '여신의 눈물', '곡궁', '여신의 눈물', '거인의 허리띠', '쓸데없이 큰 지팡이', '여신의 눈물', '여신의 눈물', '쓸데없이 큰 지팡이', '쇠사슬 조끼', '거인의 허리띠'].map(rp);
      const rr = assignItems(rd, { board: rboard, inventory: inv });
      const gave = n => rr.assignments.filter(a => a.champ.name === n).map(a => a.item.name).sort();
      assert.deepEqual(gave('자이라'), ['공허의 지팡이', '모렐로노미콘', '푸른 파수꾼'].sort(), `자이라: ${gave('자이라')}`);
      assert.deepEqual(gave('말파이트'), ['크라운가드']);
      assert.deepEqual(gave('소라카'), ['쇼진의 창']);
      assert.deepEqual(gave('아무무'), [], '아무무에게 나눠 주지 않음');
      assert.deepEqual(rr.leftComponents, [rp('거인의 허리띠')]);
      console.log('실데이터 사용자 정답 시나리오 통과 (자이라 공허·모렐로·블루)');
    }
  }
}
