// =============================================================
// 팀 평가기: 팀(챔피언 목록) + 상징 → 시너지 집계와 점수
// 세트 데이터와 무관하게 동작합니다 (공통 형식만 사용).
// =============================================================

import { coreUnits, emblemFit } from './roles.js';

export const MAX_EMBLEMS_PER_UNIT = 2; // 한 챔피언에 상징은 2개까지 (아이템 칸 확보)

/**
 * 상징을 누구에게 줄지 배정한다.
 * 규칙: 그 시너지를 "이미 가진" 챔피언은 상징 효과를 못 받음, 같은 상징 중복 불가,
 *       챔피언당 상징 2개까지, 핵심 캐리는 아이템 자리 때문에 1개까지.
 * 1순위: 적용되는 상징 수 최대화
 * 2순위(fit 모드): 상징과 어울리는 챔피언에게 (emblemFit 합 최대화)
 * 탐색 중에는 빠른 모드(1순위만), 최종 결과에서만 fit 모드로 계산한다.
 * @returns {Array<{trait, holder|null, why?}>}
 */
export function assignEmblems(team, emblemTraits, { data = null, coreId = null } = {}) {
  const n = emblemTraits.length;
  if (!n) return [];
  const useFit = !!data;
  const fitOf = new Map();
  const fit = (c, t) => {
    const k = c.id + '|' + t;
    if (!fitOf.has(k)) fitOf.set(k, emblemFit(c, t, data));
    return fitOf.get(k).fit;
  };
  const cap = c => (c.id === coreId ? 1 : MAX_EMBLEMS_PER_UNIT);
  const used = new Map(team.map(c => [c.id, 0]));
  const order = [...team].sort((a, b) => a.cost - b.cost);
  // 후보가 적은 상징부터
  const idx = [...emblemTraits.keys()].sort((a, b) =>
    order.filter(c => !c.traits.includes(emblemTraits[a])).length -
    order.filter(c => !c.traits.includes(emblemTraits[b])).length);
  const exhaustive = useFit && n <= 4;
  const best = { count: -1, fit: -1, plan: null };
  const plan = new Array(n).fill(null);

  (function go(k, applied, fitSum) {
    if (applied + (n - k) < best.count || (!useFit && applied + (n - k) <= best.count)) return; // 가지치기
    if (!exhaustive && best.count === n) return;
    if (k === n) {
      if (applied > best.count || (applied === best.count && fitSum > best.fit)) {
        best.count = applied; best.fit = fitSum; best.plan = [...plan];
      }
      return;
    }
    const e = idx[k];
    const trait = emblemTraits[e];
    let cands = order.filter(c => !c.traits.includes(trait) && used.get(c.id) < cap(c)
      && !plan.some((h, j) => h === c.id && emblemTraits[j] === trait));
    // 빠른/탐욕 모드에서는 어울리는 순으로 먼저 시도
    if (useFit) cands = cands.sort((a, b) => fit(b, trait) - fit(a, trait));
    if (!exhaustive && useFit) cands = cands.slice(0, 3);
    for (const c of cands) {
      used.set(c.id, used.get(c.id) + 1); plan[e] = c.id;
      go(k + 1, applied + 1, fitSum + (useFit ? fit(c, trait) : 0));
      used.set(c.id, used.get(c.id) - 1); plan[e] = null;
      if (!useFit && best.count === n) return;
    }
    go(k + 1, applied, fitSum); // 이 상징은 못 씀
  })(0, 0, 0);

  return emblemTraits.map((trait, i) => {
    const holder = best.plan[i];
    const c = holder && team.find(x => x.id === holder);
    const f = c && useFit ? emblemFit(c, trait, data) : null;
    return { trait, holder, why: f?.why, fit: f };
  });
}

/**
 * 팀 평가
 * @param team        챔피언 객체 배열
 * @param data        공통 형식 데이터
 * @param opts.emblems   상징 시너지 id 배열 (중복 가능)
 * @param opts.desired   { traitId: 목표 단계 } — 꼭 맞추고 싶은 시너지
 * @param opts.carryIds  핵심 캐리로 고정할 챔피언 (아이템 탭에서 사용)
 * @param opts.partial   탐색 중간 단계 평가 여부 (목표에 다가가는 것도 점수)
 * @param opts.size      최종 인원 (partial 휴리스틱용)
 */
export function evaluateTeam(team, data, opts = {}) {
  const { emblems = [], desired = {}, carryIds = [], partial = false, size = team.length } = opts;
  const counts = {};
  for (const c of team) for (const t of c.traits) counts[t] = (counts[t] || 0) + (c.weights?.[t] ?? 1); // 2명분 챔피언 반영
  const base = { ...counts };

  // 최종 평가에서만 핵심 캐릭터를 정하고 상징을 어울리는 챔피언에게 배정 (탐색 중에는 빠른 계산)
  const core = partial ? null : coreUnits(team, data, carryIds);
  const assignment = assignEmblems(team, emblems, partial ? {} : { data, coreId: core?.carry });
  const applied = {};
  for (const a of assignment) if (a.holder) {
    counts[a.trait] = (counts[a.trait] || 0) + 1;
    applied[a.trait] = (applied[a.trait] || 0) + 1;
  }
  // 낭비된 상징: 상징을 빼도 같은 단계라면 그 상징은 쓸모가 없음 (예: 이미 6인데 상징으로 7 → 7단계 없음)
  const topOf = (bps, n) => bps.filter(b => n >= b).at(-1) || 0;
  let wastedEmblems = 0;
  for (const [t, k] of Object.entries(applied)) {
    const bps = data.traits[t]?.breakpoints || [];
    for (let i = 1; i <= k; i++) {
      if (topOf(bps, counts[t] - i) === topOf(bps, counts[t] - i + 1)) wastedEmblems++;
      else break;
    }
  }

  let score = 0;
  const traitRows = [];
  for (const [id, count] of Object.entries(counts)) {
    const t = data.traits[id];
    if (!t) continue;
    const bps = t.breakpoints;
    const reached = bps.filter(b => count >= b);
    const top = reached.at(-1) || 0;
    const next = bps.find(b => b > count) || null;
    let s;
    if (!reached.length) {
      s = -0.3 * (base[id] || 0); // 발동 못 한 시너지 = 낭비
    } else if (bps.length === 1 && bps[0] === 1) {
      s = 0.8; // 고유 시너지
    } else {
      const tierRatio = (reached.length - 1) / Math.max(1, bps.length - 1);
      s = top * (1 + 0.6 * tierRatio) - 0.25 * (count - top);
    }
    // 통계 가중치: 실제 경기에서 이 시너지 단계의 평균 등수가 좋으면 점수를 키우고, 나쁘면 줄임
    const stat = reached.length ? data.weights?.[id]?.[reached.length] : null;
    if (stat && s > 0) s *= stat.weight;
    traitRows.push({
      stat,
      id, name: t.name, count, base: base[id] || 0, breakpoints: bps,
      top, tier: reached.length, next,
      emblemOnly: top > 0 && (base[id] || 0) < top, // 상징이 있어야만 발동되는 단계
    });
    score += s;
  }

  // 목표 시너지
  let desiredMet = true;
  for (const [id, target] of Object.entries(desired)) {
    const c = counts[id] || 0;
    if (c >= target) score += 8 + target * 1.5;
    else {
      desiredMet = false;
      if (partial) score += 6 * (c / target);       // 목표에 가까워지면 가산
      else score -= 10;
    }
  }

  // 중간 단계: 다음 단계까지 1~2명 남은 시너지에 소량 가산 (빔이 근시안적이지 않도록)
  const used = team.reduce((s, c) => s + (c.slots || 1), 0);
  if (partial && used < size) {
    const remain = size - used;
    for (const r of traitRows) {
      if (r.next && r.next - r.count <= Math.min(2, remain)) score += 0.6 * r.count / r.next;
    }
  }

  // 전투력 대용: 코스트 합
  const gold = team.reduce((s, c) => s + c.cost, 0);
  score += 0.08 * gold; // 비중을 낮춰 5코스트만 고집하지 않도록

  score -= 4 * wastedEmblems;
  // 상징 어울림: 상징을 낄 만한 챔피언이 없는 덱(예: 속사포 상징을 탱커에게)은 감점, 잘 어울리면 가산
  let misfits = 0;
  for (const a of assignment) {
    if (!a.fit) continue;
    const good = a.fit.share != null && a.fit.share >= 0.1 ? 0.9 : a.fit.heuristic; // 상위권이 실제로 많이 쓴 조합이면 좋은 배정
    score += 6 * (good - 0.55);
    if (good < 0.45) { misfits++; a.misfit = true; }
  }
  const usedEmblems = assignment.filter(a => a.holder).length;
  traitRows.sort((a, b) => (b.tier > 0) - (a.tier > 0) || b.top - a.top || b.count - a.count);

  return { score, traits: traitRows, assignment, desiredMet, gold, usedEmblems, wastedEmblems, misfits, core };
}
