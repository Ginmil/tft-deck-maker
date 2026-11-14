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

const pw = patchWeights(matches, { target: 600 });
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
const pw2 = patchWeights(matches, { target: 600 });
assert.equal(pw2.prevWeight, 0);
const full = run({ queueId: 1100, weightOf: pw2.weightOf, isCurrent: pw2.isCurrent });
assert.ok(Math.abs(deck(full, 'Set99_A').avgPlace - 6) < 0.1);
console.log('이번 패치 1600판: 이전 패치 가중치 0, A 평균', deck(full, 'Set99_A').avgPlace, '등');
console.log('패치 테스트 통과');

// Set 18 처럼 경기 데이터에 패치 번호가 없을 때: 경기 시각 + 일정표로 패치 판단
const schedule = [{ patch: '18.6', date: '2026-11-04' }, { patch: '18.6B', date: '2026-11-11' }];
const at = (iso, decks) => ({ metadata: { match_id: `KR_${++id}` },
  info: { queue_id: 1100, tft_set_number: 99, game_version: 'TFT Unreal Version ?.?.?.?', game_datetime: Date.parse(iso),
    participants: decks.map((d, i) => player(d, i + 1)) } });
assert.equal(patchOf(at('2026-11-11T12:00:00Z', [])), null, '일정표 없으면 모름');
assert.equal(patchOf(at('2026-11-11T12:00:00Z', []), schedule), '18.6', '18.6B 한국 적용(11/12 06시 KST) 전');
assert.equal(patchOf(at('2026-11-11T22:00:00Z', []), schedule), '18.6B');
assert.equal(patchOf(at('2026-11-01T00:00:00Z', []), schedule), null, '일정표보다 이전');
const byDate = [];
for (let i = 0; i < 800; i++) byDate.push(at('2026-11-08T10:00:00Z', ['A', 'X', 'X', 'X', 'X', 'X', 'X', 'C']));
for (let i = 0; i < 200; i++) byDate.push(at('2026-11-13T10:00:00Z', ['C', 'X', 'X', 'X', 'X', 'A', 'X', 'X']));
const pw3 = patchWeights(byDate, { schedule });
assert.equal(pw3.current, '18.6B');
assert.equal(pw3.prev, '18.6');
const w3 = toWeights(aggregate(byDate, { weightOf: pw3.weightOf, isCurrent: pw3.isCurrent }));
assert.ok(deck(w3, 'Set99_C').avgPlace < deck(w3, 'Set99_A').avgPlace);
console.log('날짜로 패치 판단:', JSON.stringify(pw3.counts), '이전 패치 가중치', pw3.prevWeight, '| C', deck(w3, 'Set99_C').avgPlace, '등 A', deck(w3, 'Set99_A').avgPlace, '등');
console.log('날짜 기반 패치 테스트 통과');

// balance: false 패치(버그 수정만)는 직전 패치와 합침 + 덱별 패치별 성적(byPatch)
const sched2 = [{ patch: '18.6', date: '2026-11-04' }, { patch: '18.7', date: '2026-11-11', balance: false }];
assert.equal(patchOf(at('2026-11-13T00:00:00Z', []), sched2), '18.6', '밸런스 변경 없는 18.7 은 18.6 으로');
const pw4 = patchWeights(byDate, { schedule: sched2 });
assert.equal(pw4.current, '18.6');
assert.equal(pw4.prev, null);
const w4 = toWeights(aggregate(byDate, { weightOf: pw3.weightOf, isCurrent: pw3.isCurrent, patchLabel: m => patchOf(m, schedule) }));
const A4 = deck(w4, 'Set99_A');
assert.equal(A4.byPatch['18.6'].games, 800);
assert.equal(A4.byPatch['18.6B'].games, 200);
console.log('덱별 패치별 성적:', JSON.stringify(A4.byPatch));
console.log('밸런스 병합·byPatch 테스트 통과');

// 패치 노트 → 메타 덱 영향 예측
const { patchImpact, patchReport, prevBalancePatch } = await import('../js/engine/patch.js');
const comp = { trait: 'DA_18_Elderwood', mainCarry: 'da_18_kennen', mainTank: 'da_sentinel18',
  core: [{ id: 'da_18_kennen', rate: 1 }, { id: 'da_sentinel18', rate: 0.9 }, { id: 'da_18_kobuko', rate: 0.7 }, { id: 'da_nidalee18_ap', rate: 0.2 }, { id: 'da_nidalee18_ad', rate: 0.1 }],
  byPatch: { '18.5': { games: 40, avgPlace: 4.0 }, '18.6': { games: 30, avgPlace: 3.6 } } };
const changes = [
  { kind: 'champion', match: 'Sentinel', dir: 'buff' }, { kind: 'champion', match: 'Kobuko', dir: 'buff' },
  { kind: 'champion', match: 'Nidalee', dir: 'buff' }, { kind: 'trait', match: 'DA_18_Elderwood', dir: 'nerf', scale: 0.3 },
  { kind: 'augment', name: 'Embiggen', dir: 'nerf' },
];
const imp = patchImpact(comp, changes);
assert.deepEqual(imp.hits.map(h => h.where), ['tank', 'core', 'flex', 'trait'], '니달리 두 형태는 한 번만');
assert.ok(imp.score > 0, '버프가 더 큼');
const rep = patchReport([comp], { patch: '18.6', changes }, '18.5');
assert.equal(rep.rows[0].verdict, 'flat', '덱이 하나뿐이면 상대 영향 0 → 예측 없음');
{ const other = { trait: 'X', mainCarry: 'x', core: [{ id: 'x', rate: 1 }], byPatch: { '18.5': { games: 400, avgPlace: 4.5 }, '18.6': { games: 400, avgPlace: 4.6 } } }; const big = { ...comp, byPatch: { '18.5': { games: 400, avgPlace: 4.0 }, '18.6': { games: 400, avgPlace: 3.6 } } }; const r2 = patchReport([big, other], { patch: '18.6', changes }, '18.5'); assert.ok(r2.rows[0].predAvg < 4.0, '안 바뀐 덱보다 더 좋아질 것'); assert.equal(r2.rows[0].verdict, 'hit', '400판씩이면 0.4등 변화는 오차보다 큼'); }
assert.equal(prevBalancePatch([{ patch: '18.5' }, { patch: '18.6' }, { patch: '18.7', balance: false }, { patch: '19.1' }], '19.1'), '18.6');
console.log('영향 예측:', imp.score.toFixed(2), '점 → 예측', rep.rows[0].predAvg, '등 / 실제', comp.byPatch['18.6'].avgPlace, '등 →', rep.rows[0].verdict);
console.log('패치 영향 예측 테스트 통과');
