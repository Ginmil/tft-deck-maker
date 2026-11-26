// =============================================================
// 패치 노트 → 메타 덱 영향 예측
// 패치에서 바뀐 챔피언·시너지가 덱의 어느 자리에 있는지(핵심 캐리/탱커/주력 시너지/구성원)로
// 영향 점수를 매기고, 이전 패치 평균 등수에서 얼마나 움직일지 예측.
// 이번 패치 판이 쌓이면 실제 변화와 비교 (예측 vs 실측).
// =============================================================

const DIR = { buff: 1, nerf: -1, adjust: 0 };
export const PRED_PER_POINT = 0.35; // 영향 점수 1 = 평균 등수 0.35등 변화로 봄 (핵심 캐리 버프 1건 ≈ 0.35등 좋아짐)
const PRED_MAX = 1.0;
const MIN_BASE_GAMES = 8;    // 이전 패치 판수가 이보다 적으면 예측 안 함
const MIN_ACTUAL_GAMES = 10; // 이번 패치 판수가 이보다 적으면 실측 비교 안 함
const PLACE_SD = 2.29;       // 등수(1~8 고르게)의 표준편차 → 판수가 적을 때 평균 등수의 오차 계산용

const has = (id, match) => String(id).toLowerCase().includes(String(match).toLowerCase());

/** 한 덱이 패치 변경 목록에서 받는 영향: [{ change, where, weight }] 과 합계 점수 */
export function patchImpact(comp, changes) {
  const hits = [];
  for (const ch of changes || []) {
    const dir = DIR[ch.dir] ?? 0;
    if (!dir || !ch.match) continue;
    const scale = ch.scale ?? 1;
    if (ch.kind === 'champion') {
      // 같은 챔피언의 여러 형태(니달리 AP/AD 등)는 가장 큰 자리 하나만
      let best = null;
      for (const u of comp.core || []) {
        if (!has(u.id, ch.match)) continue;
        // 4판 중 1판도 안 쓰는 챔피언은 덱 성적에 영향이 거의 없음 (11/17 사용자: "가끔 쓰는 파수꾼"은 배치툴 추천에도 거의 안 나옴)
        if (u.id !== comp.mainCarry && u.id !== comp.mainTank && (u.rate ?? 1) < FLEX_MIN) continue;
        const where = u.id === comp.mainCarry ? 'carry' : u.id === comp.mainTank ? 'tank' : u.rate >= 0.6 ? 'core' : 'flex';
        const weight = { carry: 1, tank: 0.6, core: 0.35, flex: 0.15 * Math.max(0.3, u.rate || 0) }[where];
        if (!best || weight > Math.abs(best.weight)) best = { change: ch, where, weight: weight * scale * dir, id: u.id, rate: u.rate };
      }
      if (best) hits.push(best);
    } else if (ch.kind === 'trait' && has(comp.trait, ch.match) && String(comp.trait).length <= String(ch.match).length + 2) {
      // 특정 단계만 바뀐 변경(나무정령 9단계 등, minCount): 그 인원까지 간 판 비율만큼만 (11/17 사용자: 7나무정령 덱은 9단계 너프와 무관)
      const reach = ch.minCount && comp.mainCount ? Object.entries(comp.mainCount).reduce((s, [n, r]) => s + (Number(n) >= ch.minCount ? r : 0), 0) : 1;
      if (reach > 0) hits.push({ change: ch, where: 'trait', weight: 0.8 * scale * dir * reach, reach: ch.minCount ? reach : undefined });
    }
  }
  return { hits, score: hits.reduce((s, h) => s + h.weight, 0) };
}

/**
 * 패치 하나에 대한 메타 덱 영향 보고서
 * @param comps   weights.comps (byPatch 포함)
 * @param patch   패치 일정 항목 { patch, changes }
 * @param prevPatch 바로 이전 (밸런스) 패치 이름 — 예측의 기준 성적
 */
// 예측 변화가 이보다 작거나, 덱 자체가 받는 영향(다른 덱과 비교하기 전)이 이보다 작으면 "비슷"으로 보고 채점하지 않음 (11/17: 덱 자체 영향은 거의 없고 다른 덱이 버프받아서 상대적으로 조금 내려갈 것이라는 예측은 의미가 약함)
export const PRED_MIN = 0.1;
export const FLEX_MIN = 0.25; // 이보다 적게 쓰는 챔피언의 변경은 덱 영향에서 뺌
export function patchReport(comps, patch, prevPatch) {
  // 평균 등수는 제로섬(8명이 1~8등을 나눔): 여러 덱이 함께 버프되면 서로 상쇄됨.
  // → 메타 전체의 평균 영향(이전 패치 판수 가중)을 빼서 "다른 덱보다 얼마나 더" 영향받는지로 예측
  // c.impact 가 있으면 그대로(앱이 묶은 덱의 버전별 영향을 판수 가중으로 미리 계산해 넘김)
  const all = (comps || []).map(c => ({ c, ...(c.impact || patchImpact(c, patch.changes)), base: c.byPatch?.[prevPatch], now: c.byPatch?.[patch.patch] }));
  const weighted = all.filter(x => x.base?.games);
  const totalGames = weighted.reduce((s, x) => s + x.base.games, 0);
  const meanScore = totalGames ? weighted.reduce((s, x) => s + x.score * x.base.games, 0) / totalGames : 0;
  const rows = [];
  for (const { c, hits, score, base, now } of all) {
    if (!hits.length) continue;
    const rel = score - meanScore;
    // 덱 자체가 받는 영향이 작으면 예측도 "이전 패치 그대로" (11/17 사용자: 너프 없이 작은 버프만 받았는데 예측이 내려가면 이상함 —
    // 다른 덱들이 더 크게 버프받아 상대적으로 밀린다는 계산이지만, 이 정도 차이는 근거가 약함)
    const own = -PRED_PER_POINT * score;
    const predDelta = Math.abs(own) < PRED_MIN ? 0 : Math.max(-PRED_MAX, Math.min(PRED_MAX, -PRED_PER_POINT * rel)); // 음수 = 등수가 좋아짐
    const row = { comp: c, hits, score, rel, base: base && base.games >= MIN_BASE_GAMES ? base : null, now: now && now.games >= MIN_ACTUAL_GAMES ? now : null, predDelta };
    if (row.base) row.predAvg = pRound(row.base.avgPlace + predDelta, 2);
    if (row.base && row.now) {
      row.actualDelta = pRound(row.now.avgPlace - row.base.avgPlace, 2);
      // 판수가 적으면 평균 등수 자체가 흔들림: 변화가 오차(표준오차)보다 작으면 "구분 어려움"
      row.noise = pRound(PLACE_SD * Math.sqrt(1 / row.base.games + 1 / row.now.games), 2);
      // 11/27 사용자: "구분 어려움"이 너무 많음 → 방향만 봄. 오를 것 → 실제로 올랐으면 적중, 내릴 것 → 내렸으면 적중, 반대면 빗나감.
      //  예측이 "비슷"(덱 자체 영향 0.1등 미만)인 덱만 채점하지 않음('flat' = 예측 비슷). 판수 오차(noise)는 화면 참고용으로만 남김
      row.verdict = Math.abs(predDelta) < PRED_MIN || Math.abs(PRED_PER_POINT * score) < PRED_MIN ? 'flat'
        : Math.sign(row.actualDelta) === Math.sign(predDelta) ? 'hit' : 'miss';
    }
    rows.push(row);
  }
  // 영향이 큰 덱, 같으면 이전 패치 판수가 많은 덱부터
  rows.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || (b.base?.games || 0) - (a.base?.games || 0));
  const judged = rows.filter(r => r.verdict === 'hit' || r.verdict === 'miss');
  return { rows, meanScore, hits: judged.filter(r => r.verdict === 'hit').length, judged: judged.length, flat: rows.filter(r => r.verdict === 'flat').length };
}

/** 일정표에서 이 패치 바로 전의 밸런스 패치 */
export function prevBalancePatch(schedule, name) {
  const i = schedule.findIndex(p => p.patch === name);
  for (let j = i - 1; j >= 0; j--) if (schedule[j].balance !== false) return schedule[j].patch;
  return null;
}

function pRound(x, d) { return Math.round(x * 10 ** d) / 10 ** d; }

// ---------------- 자동 티어표 ----------------
// 이번 패치 성적으로 메타 덱을 S/A/B/C 로 나눔.
// 평균 등수는 판수가 적으면 운이 크게 작용하므로, 전체 평균(4.5등)짜리 가상의 10판을 섞어서 보정한 값으로 판단.
// 판수 = 이번 패치 판수(patchGames). 이번 패치 기록이 아직 없으면(0) 티어에 넣지 않음.
export const TIER_CUTS = { S: 3.7, A: 4.0, B: 4.3 }; // 고정 기준(덱 목록 카드·지켜볼 덱 판단용)
export const TIER_SHARES = { S: 0.1, A: 0.2, B: 0.3 }; // 티어표: 상대 순위 비율
export const shrinkAvg = (avg, games) => (avg * games + 4.5 * 10) / (games + 10);
export function tierOf(avg, games) {
  const s = shrinkAvg(avg, games);
  return s <= TIER_CUTS.S ? 'S' : s <= TIER_CUTS.A ? 'A' : s <= TIER_CUTS.B ? 'B' : 'C';
}
/** 덱의 티어 판단에 쓸 판수: 패치 정보가 있으면 이번 패치 판수, 없으면 전체 */
export const tierGames = m => (m.patchGames != null ? m.patchGames : m.games);

/**
 * decks: [{ m: { avgPlace, games, patchGames?, playRate } , ... }]
 * min: 티어에 넣을 이번 패치 최소 판수
 * → { tiers: { S:[], A:[], B:[], C:[] }, watch: [] }
 *   watch = 이번 패치 판수가 min 에 못 미치지만 지금까지 성적이 좋은(보정 4.0등 이하) 덱, 최대 6개 — "지켜볼 덱"
 */
export function tierList(decks, { min = 15, watchMin = 5, shares = TIER_SHARES } = {}) {
  // 상대 순위 (11/15): 덱을 묶을수록 평균 등수가 4.5등 쪽으로 모여서 고정 기준(S ≤3.7등)으론 S 3개·A 1개만 남음
  //  → 판수로 보정한 점수 순으로 상위 10% S, 다음 20% A, 다음 30% B, 나머지 C
  const tiers = { S: [], A: [], B: [], C: [] }, watch = [];
  const ranked = [];
  for (const d of decks) {
    const g = tierGames(d.m);
    const score = shrinkAvg(d.m.avgPlace, g);
    const row = { ...d, tierScore: score, tierGames: g };
    if (g >= min) ranked.push(row);
    else if (g >= watchMin && score <= TIER_CUTS.A) watch.push(row);
  }
  ranked.sort((a, b) => a.tierScore - b.tierScore);
  const n = ranked.length;
  const cut = { S: Math.max(1, Math.round(n * shares.S)), A: Math.round(n * (shares.S + shares.A)), B: Math.round(n * (shares.S + shares.A + shares.B)) };
  ranked.forEach((row, i) => {
    row.tier = i < cut.S ? 'S' : i < cut.A ? 'A' : i < cut.B ? 'B' : 'C';
    tiers[row.tier].push(row);
  });
  // 같은 티어 안에서는 화면에 보이는 실제 평균 등수 순
  for (const k in tiers) tiers[k].sort((a, b) => a.m.avgPlace - b.m.avgPlace);
  watch.sort((a, b) => a.tierScore - b.tierScore);
  // 지켜볼 덱도 같은 기준선으로 티어 글자
  const line = t => ranked[Math.min(n, cut[t]) - 1]?.tierScore ?? -Infinity;
  for (const w of watch) w.tier = w.tierScore <= line('S') ? 'S' : w.tierScore <= line('A') ? 'A' : 'B';
  return { tiers, watch: watch.slice(0, 6), cuts: { S: line('S'), A: line('A'), B: line('B') } };
}

// ---------------- 티어표용 덱 묶기 ----------------
// 메타 덱은 "주력 시너지 + 아이템을 가장 많이 든 챔피언"으로 나뉘어서, 같은 보드인데 후반에 5코 케넨·럭스로 아이템을 옮긴 판이
// 따로 잡힘(협곡야수·케넨 20판 2.88등 = 협곡야수·장로 드래곤과 구성 100% 같음 → 이미 이긴 판이라 등수가 좋아 보임).
// 티어표는 "덱 단위"로 보여야 하므로(사용자 피드백 11/15) 보드 구성으로 묶음:
//  - 작은 덱 A 를 더 큰 덱 B 에 넣는 조건:
//    ① A 의 캐리가 5코스트(후반 캐리 전환)이고 구성이 75% 이상 같음 (B 도 5코 캐리면 B 가 3배 이상 클 때만)
//    ② 캐리가 같고 구성이 85% 이상 같음 (주력 시너지 이름만 다르게 잡힘)
//    ③ 둘 다 밸류덱(value)이고 캐리가 같으면 구성 50% 이상 (드레이븐 밸류의 협곡야수·나무정령·전쟁기계… 버전)
//    ④ 주력 시너지가 같고 구성 75% 이상 (캐리 여러 명이 아이템을 나눠 드는 덱: 개화 아리·자이라)
//  - 그 밖에 캐리가 다른 덱은 따로 (요정 애쉬 3.38등 vs 요정 시비르 5.25등처럼 성적이 크게 다름)
// decks: [{ team: [{ id, base?, cost }], carryChamp: { id, base?, cost }, games }] → [{ main, variants: [...] }] (main 은 가장 큰 덱)
export function groupDecks(decks) {
  const key = c => c.base || c.id;
  const sim = (a, b) => {
    const tb = new Set(b.team.map(key));
    return a.team.filter(c => tb.has(key(c))).length / Math.max(a.team.length, b.team.length);
  };
  const sorted = [...decks].sort((a, b) => b.games - a.games);
  const parent = new Map();
  for (const a of [...sorted].reverse()) { // 작은 덱부터 들어갈 곳을 찾음
    let best = null;
    for (const b of sorted) {
      if (b === a || b.games <= a.games || parent.has(b)) continue;
      const s = sim(a, b);
      const late5 = a.carryChamp.cost >= 5 && (b.carryChamp.cost < 5 || b.games >= 3 * a.games);
      const same = key(a.carryChamp) === key(b.carryChamp);
      // ③ 같은 캐리의 밸류덱끼리(드레이븐 밸류: 우연히 켜진 작은 시너지만 다름, 구성 50~89% 겹침)
      // 밸류덱끼리는 레벨이 같을 때만 (11/22 사용자: 앞 버전 덱이 뒷 버전으로 완성해서 이긴 게 아니라 그 레벨에서 따로 이긴 덱이면 따로 —
      //  8레벨 3나무정령 드레이븐 밸류 vs 9레벨 장로 드래곤 드레이븐 밸류)
      const sameLv = !a.level || !b.level || a.level === b.level;
      const value = same && a.value && b.value && sameLv && s >= 0.5;
      // ④ 주력 시너지가 같고 보드가 75% 이상 같으면 캐리가 달라도 한 덱 (11/15 사용자 피드백: 지옥불 럭스인데 애쉬도 자주 씀 —
      //    아이템을 누가 들었는지로만 갈림. 개화 아리=자이라, 햇빛 유나라=르블랑=카르마처럼 보드 100% 같은 덱이 많았음)
      const sameTrait = a.trait && a.trait === b.trait && !a.value && !b.value && s >= 0.75;
      // ⑤ 밸류덱끼리 보드가 75% 이상 같으면 캐리가 달라도 한 덱 (11/20 사용자: 장로 드래곤 밸류와 드레이븐 밸류가 같은 9명 —
      //    5코 캐리끼리라 ①도 안 걸렸음. 누구에게 아이템을 줬는지는 버전표에서 비교)
      const valueBoard = a.value && b.value && sameLv && s >= 0.75;
      // 캐리가 같은 덱 → 시너지가 같은 덱 순으로 우선 (전쟁기계 드레이븐이 장로 드래곤 밸류보다 드레이븐 밸류로)
      const pr = s + (same ? 1 : 0) + (a.trait && a.trait === b.trait ? 0.5 : 0);
      // 11/27 사용자: 전쟁기계 애쉬에 "케이틀린에게 아이템을 몰아준 판"(보드에 애쉬가 아예 없음)이 묶임 — 캐리가 다른 버전은
      //  큰 덱의 캐리가 작은 덱 보드에도 있을 때만 (아이템만 옮긴 판). 캐리를 갈아 끼운 보드는 다른 덱
      const keepsCarry = same || a.team.some(c => key(c) === key(b.carryChamp));
      if (((late5 && s >= 0.75 && keepsCarry) || (same && s >= 0.85) || value || (sameTrait && keepsCarry) || valueBoard) && (!best || pr > best.pr)) best = { b, s, pr };
    }
    if (best) parent.set(a, best.b);
  }
  const root = x => { while (parent.has(x)) x = parent.get(x); return x; };
  const groups = new Map();
  for (const d of sorted) {
    const r = root(d);
    if (!groups.has(r)) groups.set(r, { main: r, variants: [] });
    if (d !== r) groups.get(r).variants.push(d);
  }
  return [...groups.values()];
}
