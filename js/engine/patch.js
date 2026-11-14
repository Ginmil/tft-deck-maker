// =============================================================
// 패치 노트 → 메타 덱 영향 예측
// 패치에서 바뀐 챔피언·시너지가 덱의 어느 자리에 있는지(핵심 캐리/탱커/주력 시너지/구성원)로
// 영향 점수를 매기고, 이전 패치 평균 등수에서 얼마나 움직일지 예측.
// 이번 패치 판이 쌓이면 실제 변화와 비교 (예측 vs 실측).
// =============================================================

const DIR = { buff: 1, nerf: -1, adjust: 0 };
const PRED_PER_POINT = 0.35; // 영향 점수 1 = 평균 등수 0.35등 변화로 봄 (핵심 캐리 버프 1건 ≈ 0.35등 좋아짐)
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
        const where = u.id === comp.mainCarry ? 'carry' : u.id === comp.mainTank ? 'tank' : u.rate >= 0.6 ? 'core' : 'flex';
        const weight = { carry: 1, tank: 0.6, core: 0.35, flex: 0.15 * Math.max(0.3, u.rate || 0) }[where];
        if (!best || weight > best.weight) best = { change: ch, where, weight: weight * scale * dir, id: u.id };
      }
      if (best) hits.push(best);
    } else if (ch.kind === 'trait' && has(comp.trait, ch.match) && String(comp.trait).length <= String(ch.match).length + 2) {
      hits.push({ change: ch, where: 'trait', weight: 0.8 * scale * dir });
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
export function patchReport(comps, patch, prevPatch) {
  // 평균 등수는 제로섬(8명이 1~8등을 나눔): 여러 덱이 함께 버프되면 서로 상쇄됨.
  // → 메타 전체의 평균 영향(이전 패치 판수 가중)을 빼서 "다른 덱보다 얼마나 더" 영향받는지로 예측
  const all = (comps || []).map(c => ({ c, ...patchImpact(c, patch.changes), base: c.byPatch?.[prevPatch], now: c.byPatch?.[patch.patch] }));
  const weighted = all.filter(x => x.base?.games);
  const totalGames = weighted.reduce((s, x) => s + x.base.games, 0);
  const meanScore = totalGames ? weighted.reduce((s, x) => s + x.score * x.base.games, 0) / totalGames : 0;
  const rows = [];
  for (const { c, hits, score, base, now } of all) {
    if (!hits.length) continue;
    const rel = score - meanScore;
    const predDelta = Math.max(-PRED_MAX, Math.min(PRED_MAX, -PRED_PER_POINT * rel)); // 음수 = 등수가 좋아짐
    const row = { comp: c, hits, score, rel, base: base && base.games >= MIN_BASE_GAMES ? base : null, now: now && now.games >= MIN_ACTUAL_GAMES ? now : null, predDelta };
    if (row.base) row.predAvg = pRound(row.base.avgPlace + predDelta, 2);
    if (row.base && row.now) {
      row.actualDelta = pRound(row.now.avgPlace - row.base.avgPlace, 2);
      // 판수가 적으면 평균 등수 자체가 흔들림: 변화가 오차(표준오차)보다 작으면 "구분 어려움"
      row.noise = pRound(PLACE_SD * Math.sqrt(1 / row.base.games + 1 / row.now.games), 2);
      row.verdict = Math.abs(row.actualDelta) < row.noise || Math.abs(predDelta) < 0.05 ? 'flat'
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
export const TIER_CUTS = { S: 3.7, A: 4.0, B: 4.3 };
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
export function tierList(decks, { min = 15, watchMin = 5 } = {}) {
  const tiers = { S: [], A: [], B: [], C: [] }, watch = [];
  for (const d of decks) {
    const g = tierGames(d.m);
    const score = shrinkAvg(d.m.avgPlace, g);
    const row = { ...d, tierScore: score, tierGames: g };
    if (g >= min) tiers[tierOf(d.m.avgPlace, g)].push(row);
    else if (g >= watchMin && score <= TIER_CUTS.A) watch.push(row);
  }
  // 티어는 보정값으로 정하고, 같은 티어 안에서는 화면에 보이는 실제 평균 등수 순
  for (const k in tiers) tiers[k].sort((a, b) => a.m.avgPlace - b.m.avgPlace);
  watch.sort((a, b) => a.tierScore - b.tierScore);
  return { tiers, watch: watch.slice(0, 6) };
}
