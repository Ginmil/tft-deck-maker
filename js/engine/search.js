// =============================================================
// 덱 탐색기 (빔 서치) + 기능 1·2·3
// 챔피언 60명 중 8명 = 수십억 가지 → 전부 볼 수 없으므로
// 한 명씩 추가하며 "점수 상위 K개 조합"만 남기는 빔 서치를 사용.
// =============================================================
import { evaluateTeam } from './scorer.js';

const keyOf = team => team.map(c => c.id).sort().join('|');
const slotsUsed = team => team.reduce((s, c) => s + (c.slots || 1), 0);

/**
 * 공통 탐색
 * @param opts.size       팀 인원(레벨)
 * @param opts.required   반드시 넣을 챔피언 id 배열
 * @param opts.desired    { traitId: 목표 단계 }
 * @param opts.emblems    상징 시너지 id 배열
 * @param opts.maxCost    사용할 최대 코스트
 * @param opts.beamWidth  빔 폭 (클수록 정확, 느림)
 * @param opts.results    돌려줄 덱 수
 * @param opts.exclude    제외할 챔피언 id 배열 (예: 뽑기 어려운 럭스)
 * @param opts.max5       5코스트 챔피언 최대 수
 * @param opts.prefer     되도록 남기고 싶은 챔피언 id 배열 (필수는 아님, 남기면 가산점)
 * @param opts.preferBonus 남긴 챔피언 1명당 가산점
 */
export function searchTeams(data, opts) {
  const {
    size = 8, required = [], desired = {}, emblems = [], carryIds = [],
    maxCost = 5, beamWidth = 200, results = 5, exclude = [], max5 = Infinity,
    prefer = [], preferBonus = 2, minDiff = 2,
  } = opts;
  const byId = new Map(data.champions.map(c => [c.id, c]));
  const start = required.map(id => byId.get(id)).filter(Boolean);
  const preferSet = new Set(prefer);
  // 이미 가진 챔피언은 코스트 제한과 상관없이 후보에 둠 (예: 3코 이하 설정인데 보드에 4코가 있음)
  const pool = data.champions.filter(c => (c.cost <= maxCost || preferSet.has(c.id)) && !required.includes(c.id) && !exclude.includes(c.id));
  const evalOpts = { emblems, desired, carryIds, size };
  const bonus = team => preferSet.size ? preferBonus * team.filter(c => preferSet.has(c.id)).length : 0;

  // 팀 자리 기준으로 채움 (장로 드래곤처럼 2칸 차지하는 챔피언 고려)
  let beam = [{ team: start, score: 0 }];
  while (beam.some(b => slotsUsed(b.team) < size)) {
    const next = new Map();
    for (const b of beam) {
      const { team } = b;
      const used = slotsUsed(team);
      if (used >= size) { next.set(keyOf(team), b); continue; } // 이미 꽉 찬 팀은 그대로 유지
      const inTeam = new Set(team.map(c => c.id));
      const bases = new Set(team.map(c => c.base || c.id)); // 같은 챔피언의 다른 형태(예: 럭스 여러 버전)는 한 명만
      const fives = team.filter(c => c.cost === 5).length;
      for (const c of pool) {
        if (inTeam.has(c.id) || bases.has(c.base || c.id)) continue;
        if (c.cost === 5 && fives >= max5) continue; // 5코스트 개수 제한
        if (used + (c.slots || 1) > size) continue;
        const t = [...team, c];
        const k = keyOf(t);
        if (next.has(k)) continue;
        const ev = evaluateTeam(t, data, { ...evalOpts, partial: true });
        next.set(k, { team: t, score: ev.score + bonus(t) });
      }
    }
    if (!next.size) break;
    beam = [...next.values()].sort((a, b) => b.score - a.score).slice(0, beamWidth);
  }

  const finals = beam.map(({ team }) => {
    const ev = evaluateTeam(team, data, { ...evalOpts, partial: false });
    return { team: [...team].sort((a, b) => a.cost - b.cost), ...ev, score: ev.score + bonus(team) };
  }).sort((a, b) => (b.desiredMet - a.desiredMet) || b.score - a.score);

  return diversify(finals, results, minDiff);
}

/** 서로 2명 이상 다른 덱만 골라서 비슷한 결과가 반복되지 않게 함 */
function diversify(list, n, minDiff = 2) {
  const out = [];
  for (const d of list) {
    const ids = new Set(d.team.map(c => c.id));
    const tooClose = out.some(o => o.team.filter(c => !ids.has(c.id)).length < minDiff);
    if (!tooClose) out.push(d);
    if (out.length >= n) break;
  }
  return out;
}

// -------------------------------------------------------------
// 기능 1. 원하는 시너지 → 덱
// -------------------------------------------------------------
export function decksForTraits(data, { desired, size, maxCost, emblems = [], ...filters }) {
  return searchTeams(data, { size, maxCost, desired, emblems, results: 5, ...filters });
}

// -------------------------------------------------------------
// 기능 2. 가진 아이템 → 어울리는 캐리 + 덱
// -------------------------------------------------------------
const FIT = {
  AD:   { AD: 1, FIGHTER: 0.5, AP: 0, TANK: 0 },
  AP:   { AP: 1, FIGHTER: 0.1, AD: 0, TANK: 0 },
  TANK: { TANK: 1, FIGHTER: 0.7, AD: 0, AP: 0 },
  FLEX: { AD: 0.4, AP: 0.4, TANK: 0.4, FIGHTER: 0.4 },
};

export function itemFit(champ, item) {
  return FIT[item.role]?.[champ.role] ?? 0;
}

export function decksForItems(data, { itemIds, size, maxCost, emblems = [], ...filters }) {
  const { exclude = [], max5 = Infinity } = filters;
  const items = itemIds.map(id => data.items.find(i => i.id === id)).filter(Boolean);
  if (!items.length) return [];
  // 아이템을 가장 잘 쓰는 챔피언 순위 (고코스트 캐리 우대)
  const ranked = data.champions
    .filter(c => c.cost <= maxCost && !exclude.includes(c.id) && !(c.cost === 5 && max5 < 1))
    .map(c => {
      const fit = items.reduce((s, it) => s + itemFit(c, it), 0);
      return { champ: c, fit, rank: fit * (1 + 0.15 * c.cost) };
    })
    .filter(r => r.fit > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3);

  return ranked.map(({ champ, fit }) => {
    // 캐리의 시너지 중 덱 중심 시너지를 목표로 (첫 단계)
    const desired = {};
    for (const t of champ.traits) {
      const bps = data.traits[t]?.breakpoints || [];
      const target = bps.find(b => b >= 2);
      if (target && target <= size / 2) desired[t] = target;
    }
    const [deck] = searchTeams(data, {
      size, maxCost, desired, emblems, required: [champ.id], carryIds: [champ.id], results: 1, ...filters,
    });
    return deck ? { carry: champ, fit, items: distributeItems(deck.team, items, champ.id), ...deck } : null;
  }).filter(Boolean);
}

/** 아이템을 덱 안에서 가장 잘 맞는 챔피언에게 배분 (최대 3칸) */
function distributeItems(team, items, carryId) {
  const slots = Object.fromEntries(team.map(c => [c.id, []]));
  const sorted = [...items].sort((a, b) => (a.role === 'FLEX') - (b.role === 'FLEX'));
  for (const it of sorted) {
    const best = team
      .filter(c => slots[c.id].length < 3)
      .map(c => ({ c, f: itemFit(c, it) + (c.id === carryId && it.role !== 'TANK' ? 0.5 : 0) + c.cost * 0.05 }))
      .sort((a, b) => b.f - a.f)[0];
    if (best) slots[best.c.id].push(it);
  }
  return slots;
}

// -------------------------------------------------------------
// 기능 4. 내 보드 → 다음 수 추천
// 배치툴 보드의 챔피언을 유지한 채 남은 자리를 채워 완성 덱을 추천.
// - 보드에 낀 상징은 상징으로 계산, 딜 아이템을 가장 많이 든 챔피언을 핵심 캐리로 고정
// - keepAll=false 면 아이템·3성·캐리가 아닌 챔피언은 "되도록 유지"(가산점)만 하고 바꿀 수 있음
// -------------------------------------------------------------
/** 보드 칸 목록 → 챔피언·상징·캐리 정보 */
export function readBoard(data, board) {
  const byId = new Map(data.champions.map(c => [c.id, c]));
  const emblemTrait = id => data.emblems.find(e => e.id === id || (e.ids || []).includes(id))?.trait;
  const itemRole = id => data.items.find(i => i.id === id)?.role;
  const units = [];
  const emblems = [];
  for (const u of board) {
    const champ = byId.get(u.id);
    if (!champ) continue;
    let dmg = 0, tank = 0, real = 0;
    for (const it of u.items || []) {
      const t = emblemTrait(it);
      if (t) { if (!champ.traits.includes(t)) emblems.push(t); continue; } // 이미 가진 시너지 상징은 효과 없음
      real++;
      const r = itemRole(it);
      if (r === 'AD' || r === 'AP') dmg++;
      if (r === 'TANK') tank++;
    }
    units.push({ champ, star: u.star || 2, items: u.items || [], dmg, tank, real });
  }
  // 핵심 캐리: 딜 아이템 수 → 아이템 수 → 별 → 코스트
  const carry = [...units].filter(u => u.dmg > 0 || (u.real > 0 && u.tank === 0))
    .sort((a, b) => b.dmg - a.dmg || b.real - a.real || b.star - a.star || b.champ.cost - a.champ.cost)[0]?.champ || null;
  const slots = units.reduce((s, u) => s + (u.champ.slots || 1), 0);
  return { units, emblems, carry, slots };
}

export function decksFromBoard(data, { board, size, keepAll = true, ...filters }) {
  const info = readBoard(data, board);
  if (!info.units.length) return { decks: [], info, size };
  const isCore = u => keepAll || u.real > 0 || u.star >= 3 || u.champ.id === info.carry?.id;
  const required = info.units.filter(isCore).map(u => u.champ.id);
  const prefer = info.units.filter(u => !isCore(u)).map(u => u.champ.id);
  const requiredSlots = info.units.filter(isCore).reduce((s, u) => s + (u.champ.slots || 1), 0);
  // 목표 레벨: 지정 안 하면(0) 지금 보드 + 1. 모두 유지인데 보드보다 작으면 다음 레벨로 (최대 10)
  let target = Math.min(10, size || info.slots + 1);
  if (keepAll && target <= info.slots) target = Math.min(10, info.slots + 1);
  if (requiredSlots >= target) return { decks: [], info, size: target };
  const decks = searchTeams(data, {
    ...filters, size: target, required, prefer, emblems: info.emblems,
    carryIds: info.carry ? [info.carry.id] : [], results: 5,
    minDiff: Math.min(2, target - requiredSlots), // 한 명만 추가할 때는 한 명만 달라도 다른 추천
  });
  const boardIds = new Set(info.units.map(u => u.champ.id));
  for (const d of decks) {
    const ids = new Set(d.team.map(c => c.id));
    d.board = {
      added: d.team.filter(c => !boardIds.has(c.id)).map(c => c.id),
      removed: info.units.filter(u => !ids.has(u.champ.id)).map(u => u.champ.id),
    };
  }
  return { decks, info, size: target };
}

// -------------------------------------------------------------
// 기능 3. 상징 팀 메이커 (핵심)
// 가진 상징으로 "닿을 수 있는" 시너지 단계를 모두 후보로 만들고
// 각각 탐색한 뒤 점수순으로 합친다.
// -------------------------------------------------------------
export function emblemTeamMaker(data, { emblems, size, maxCost, desired = {}, ...filters }) {
  const { exclude = [] } = filters;
  if (!emblems.length) return [];
  const emblemCount = {};
  for (const t of emblems) emblemCount[t] = (emblemCount[t] || 0) + 1;

  // 후보 목표: 상징 시너지별로 도달 가능한 단계
  const goals = [];
  for (const [t, e] of Object.entries(emblemCount)) {
    const trait = data.traits[t];
    if (!trait) continue;
    const owners = data.champions.filter(c => c.cost <= maxCost && c.traits.includes(t) && !exclude.includes(c.id))
      .reduce((s, c) => s + (c.weights?.[t] ?? 1), 0); // 2명분 챔피언 반영
    for (const bp of trait.breakpoints) {
      const needUnits = bp - e;
      if (bp < 2 || needUnits < 0 || needUnits > owners || needUnits > size - e) continue;
      goals.push({ trait: t, bp, emblemOnly: owners < bp });
    }
  }
  // 높은 단계부터, 너무 많으면 상위 일부만
  goals.sort((a, b) => b.bp - a.bp);
  const picked = goals.slice(0, 8);
  if (!picked.length) picked.push({ trait: null, bp: 0 });

  const all = [];
  for (const g of picked) {
    const want = { ...desired };
    if (g.trait) want[g.trait] = Math.max(want[g.trait] || 0, g.bp);
    const decks = searchTeams(data, { size, maxCost, desired: want, emblems, beamWidth: 150, results: 2, ...filters });
    for (const d of decks) all.push({ ...d, goal: g });
  }
  const useful = d => d.usedEmblems - d.wastedEmblems;
  all.sort((a, b) => (b.desiredMet - a.desiredMet) || (useful(b) - useful(a)) || b.score - a.score);
  return diversify(all, 6, 2);
}
