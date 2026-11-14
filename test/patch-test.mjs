// 패치별 가중치 테스트: 이전 패치에서 판수가 많던 덱이 이번 패치의 강한 덱을 덮지 않는지
// 실행: node test/patch-test.mjs
import assert from 'assert';
import { aggregate, toWeights, patchWeights, patchOf } from '../tools/stats-lib.mjs';

let id = 0;
// 한 경기 = 8명. deckA(시너지 A + 캐리 a), deckC(시너지 C + 캐리 c), 나머지는 잡덱
const unit = (cid, items = []) => ({ character_id: cid, tier: 2, rarity: 3, itemNames: items });
const player = (deck, place) => {
  const dmg = ['TFT_Item_InfinityEdge', 'TFT_Item_LastWhisper', 'TFT_Item_GuinsoosRageblade'];
  const [t, carry] = deck === 'A' ? ['Set99_A', 'set99_a'] : deck === 'C' ? ['Set99_C', 'set99_c'] : [`Set99_X${place}`, `set99_x${place}`];
  return { placement: place, level: 8, units: [unit(carry, dmg), unit('set99_f1'), unit('set99_f2'), unit('set99_f3')],
    traits: [{ name: t, num_units: 4, tier_current: 1, tier_total: 3, style: 1 }] };
};
const match = (patch, decks) => ({
  metadata: { match_id: `KR_${++id}` },
  info: { queue_id: 1100, tft_set_number: 99, game_datetime: Date.now(), game_version: `Linux Version ${patch}.123.4567 (Nov 05 2026) [PUBLIC] <Releases/${patch}>`,
    participants: decks.map((d, i) => player(d, i + 1)) },
});

assert.equal(patchOf(match('16.22', [])), '16.22');
assert.equal(patchOf({ info: { game_version: 'Version 16.3.1' } }), '16.3');

// 이전 패치 16.21: A가 1000판 동안 강함(1~2등), C는 약함(7~8등)
// 이번 패치 16.22: 300판 — A 너프(6~7등), C 버프(1~2등)
const matches = [];
for (let i = 0; i < 1000; i++) matches.push(match('16.21', ['A', i % 2 ? 'C' : 'X', 'X', 'X', 'X', 'X', 'X', 'C'].map((d, k) => k === 0 ? 'A' : d)));
for (let i = 0; i < 300; i++) matches.push(match('16.22', ['C', 'X', 'X', 'X', 'X', 'A', 'X', 'X']));

const run = opts => toWeights(aggregate(matches, opts));
const deck = (w, t) => w.comps.find(c => c.trait === t);

// 가중치 없이(예전 방식): A 판수가 훨씬 많고 평균 등수도 A가 좋아 보임
const old = run({ queueId: 1100 });
console.log('예전 방식  A', deck(old, 'Set99_A').games, '판', deck(old, 'Set99_A').avgPlace, '등 | C', deck(old, 'Set99_C').games, '판', deck(old, 'Set99_C').avgPlace, '등');

const pw = patchWeights(matches);
assert.equal(pw.current, '16.22');
assert.equal(pw.prev, '16.21');
assert.ok(pw.prevWeight > 0 && pw.prevWeight <= 0.3, `이번 패치 300판이면 이전 패치는 300판어치만: ${pw.prevWeight}`);
const now = run({ queueId: 1100, weightOf: pw.weightOf, isCurrent: pw.isCurrent });
const A = deck(now, 'Set99_A'), C = deck(now, 'Set99_C');
console.log('패치 가중치 A', A.games, '판', A.avgPlace, '등 | C', C.games, '판', C.avgPlace, '등 | 이전 패치 가중치', pw.prevWeight);
console.log('            A 이번 패치', JSON.stringify(A.now), '이전', JSON.stringify(A.before));
assert.ok(C.avgPlace < A.avgPlace, '이번 패치에서 강해진 C가 A보다 평균 등수가 좋아야 함');
assert.equal(A.now.games, 300);
assert.equal(A.before.games, 1000);

// 이번 패치 경기가 충분하면 이전 패치는 완전히 빠짐
for (let i = 0; i < 1300; i++) matches.push(match('16.22', ['C', 'X', 'X', 'X', 'X', 'A', 'X', 'X']));
const pw2 = patchWeights(matches);
assert.equal(pw2.prevWeight, 0);
const full = run({ queueId: 1100, weightOf: pw2.weightOf, isCurrent: pw2.isCurrent });
assert.ok(Math.abs(deck(full, 'Set99_A').avgPlace - 6) < 0.1);
console.log('이번 패치 1600판: 이전 패치 가중치 0, A 평균', deck(full, 'Set99_A').avgPlace, '등');
console.log('패치 테스트 통과');
