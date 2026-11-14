// =============================================================
// 경기 데이터 → 시너지 단계별 통계 → 가중치
// (라이엇 API 호출과 분리된 순수 계산 부분. 테스트하기 쉽도록 따로 둠)
// =============================================================

// ---- 패치 버전 ----
// 패치 시작 시각: 일정표 날짜(태평양 시간) 다음 날 06:00 KST = 그 날짜 21:00 UTC (한국 서버 적용 시각 근사)
const patchStart = p => Date.parse(`${p.date}T21:00:00Z`);
/**
 * 경기의 패치 "18.6B".
 * 1) game_version 에 번호가 있으면 그대로 ("<Releases/16.22>")
 * 2) 없으면(Set 18: "TFT Unreal Version ?.?.?.?") 경기 시각(game_datetime)과 패치 일정표(data/patches.json)로 정함
 */
export function patchOf(m, schedule = null) {
  const v = String(m?.info?.game_version || '');
  const r = v.match(/Releases\/(\d+)\.(\d+)/) || v.match(/Version (\d+)\.(\d+)/);
  if (r) return `${Number(r[1])}.${Number(r[2])}`;
  const t = m?.info?.game_datetime;
  if (!schedule?.length || !t) return null;
  // balance: false 인 패치(버그 수정만)는 직전 밸런스 패치와 같은 메타로 봄
  let found = null;
  for (const p of schedule) if (patchStart(p) <= t && (p.balance !== false || !found)) found = p.patch;
  return found;
}
// 패치 순서: 일정표 순서, 없으면 숫자("18.6" < "18.6B" < "18.7")
const patchOrder = (p, schedule) => {
  const i = (schedule || []).findIndex(x => x.patch === p);
  if (i >= 0) return i;
  const r = String(p).match(/(\d+)\.(\d+)([A-Z]?)/);
  return r ? 1e6 + Number(r[1]) * 1000 + Number(r[2]) + (r[3] ? 0.5 : 0) : -1;
};

/**
 * 패치별 가중치 (시너지·챔피언·아이템 통계용): 최신 패치 1, 바로 이전 패치는 "부족한 만큼만" 채움.
 * 최신 패치 경기가 target 판보다 적으면 이전 패치를 (target - 최신 판수) 판어치만 섞고, target 이상이면 0.
 * 그보다 옛 패치는 0. → 패치 직후에도 통계가 비지 않으면서, 옛 패치의 많은 판수가 새 메타를 덮지 않게.
 * (메타 덱은 따로 toWeights 에서 이전 패치를 "덱마다 최대 20판어치 사전 정보"로만 씀)
 */
export function patchWeights(matches, { queueId = 1100, setNumber = null, target = 1500, schedule = null } = {}) {
  const usable = matches.filter(m => m?.info && (!queueId || m.info.queue_id === queueId));
  const set = setNumber ?? Math.max(0, ...usable.map(m => m.info.tft_set_number || 0));
  const counts = {};
  for (const m of usable) {
    if (m.info.tft_set_number !== set) continue;
    const p = patchOf(m, schedule) || '?';
    counts[p] = (counts[p] || 0) + 1;
  }
  const known = Object.keys(counts).filter(p => p !== '?').sort((a, b) => patchOrder(b, schedule) - patchOrder(a, schedule));
  const current = known[0] || null, prev = known[1] || null;
  const cur = current ? counts[current] : 0;
  const prevWeight = prev ? round(Math.min(1, Math.max(0, target - cur) / counts[prev]), 4) : 0;
  const weightOf = m => {
    const p = patchOf(m, schedule);
    if (!current || p === current || p === null) return 1; // 버전 정보가 없으면 그대로
    return p === prev ? prevWeight : 0;
  };
  return { setNumber: set, current, prev, prevWeight, counts, mature: cur >= target, weightOf, isCurrent: m => !current || patchOf(m, schedule) === current };
}

/**
 * 경기 목록에서 (시너지, 단계)별 통계를 집계
 * @param matches 라이엇 TFT-MATCH-V1 경기 상세 응답 배열
 * @param weightOf 경기별 가중치 (패치별 가중치, 기본 1). 판수·등수 합에 곱해짐
 * @param isCurrent 최신 패치 경기인지 (메타 덱의 "이번 패치만" 기록용)
 * @returns { setNumber, games, traits: { [traitId]: { [tier]: { games, sumPlace, top4, wins } } } }
 */
export function aggregate(matches, { queueId = 1100, setNumber = null, weightOf = () => 1, isCurrent = () => true, patchLabel = () => null } = {}) {
  const usable = matches.filter(m => m?.info && (!queueId || m.info.queue_id === queueId));
  // 세트 번호가 정해지지 않았으면 가장 최신 세트만 사용
  const latest = setNumber ?? Math.max(...usable.map(m => m.info.tft_set_number || 0));
  const traits = {};
  const units = {};   // 챔피언별: 판수, 등수 합, 완성 아이템 3개 장착 횟수
  const emblems = {}; // 상징 아이템별 → 장착한 챔피언별 판수
  const comps = {};   // 메타 덱: "주력 시너지 + 핵심 캐리" 별 판수·등수·대표 구성
  let games = 0, curGames = 0;
  for (const m of usable) {
    if (m.info.tft_set_number !== latest) continue;
    const w = weightOf(m);
    const cur = isCurrent(m);
    const label = patchLabel(m);
    // 가중치 0인 이전 패치 경기도 메타 덱의 "패치별 성적" 기록에는 넣음 (패치 전후 비교·티어 예측용)
    if (!(w > 0)) { for (const p of m.info.participants || []) addComp(comps, p, p.placement, 0, false, label); continue; }
    for (const p of m.info.participants || []) {
      games += w;
      if (cur) curGames++;
      const place = p.placement;
      for (const u of p.units || []) {
        const id = String(u.character_id || '').toLowerCase();
        if (!id) continue;
        const items = u.itemNames || u.items || [];
        const names = items.filter(x => typeof x === 'string');
        const ur = (units[id] ||= { games: 0, sumPlace: 0, full: 0, items: {}, builds: {} });
        ur.games += w;
        ur.sumPlace += w * place;
        // 도적의 장갑: 끼면 나머지 아이템이 랜덤 → 이 챔피언의 아이템 기록은 3신기·역할 통계에서 제외
        // 전략가의 왕관/망토/방패: 인원 +1용이라 캐리 아이템 조합이 아님 → 3신기에서 제외
        const random = names.some(n => /ThiefsGloves/i.test(n));
        const tactician = names.some(n => /Tacticians/i.test(n));
        const done = names.filter(n => !/emblem/i.test(n));
        if (!random && done.length >= 3) ur.full += w;
        if (!random) for (const n of done) ur.items[n] = (ur.items[n] || 0) + w; // 어떤 아이템을 끼는지 → 역할 판단
        // 아이템 3개 조합(3신기): 순서 무관하게 묶어서 판수·등수 집계
        if (!random && !tactician && done.length >= 3) {
          const k = done.slice(0, 3).sort().join('|');
          const b = (ur.builds[k] ||= { games: 0, sumPlace: 0 });
          b.games += w;
          b.sumPlace += w * place;
        }
        for (const it of names) {
          if (!/emblem/i.test(it)) continue;
          const er = ((emblems[it] ||= {})[id] ||= { games: 0, sumPlace: 0 });
          er.games += w;
          er.sumPlace += w * place;
        }
      }
      addComp(comps, p, place, w, cur, label);
      for (const t of p.traits || []) {
        if (!(t.tier_current > 0)) continue; // 발동 안 된 시너지는 제외
        const row = ((traits[t.name] ||= {})[t.tier_current] ||= { games: 0, sumPlace: 0, top4: 0, wins: 0 });
        row.games += w;
        row.sumPlace += w * place;
        if (place <= 4) row.top4 += w;
        if (place === 1) row.wins += w;
      }
    }
  }
  return { setNumber: latest, games, curGames, traits, units, emblems, comps };
}

// ---- 메타 덱 분류 ----
// 탱커 아이템 (이름 규칙이 시즌마다 바뀌어도 아이템 이름은 거의 그대로라 이름으로 판별)
const TANK_ITEM = /Warmog|Gargoyle|DragonsClaw|BrambleVest|Sunfire|SpiritVisage|Redemption|ProtectorsVow|Evenshroud|SteadfastHeart|IonicSpark|AdaptiveHelm|TitansResolve|Crownguard|Bulwark/i;
const itemsOf = u => (u.itemNames || []).filter(n => typeof n === 'string' && !/emblem/i.test(n));
const offensive = u => itemsOf(u).filter(n => !TANK_ITEM.test(n) && !/Tacticians|ThiefsGloves/i.test(n)).length;
const tanky = u => itemsOf(u).filter(n => TANK_ITEM.test(n)).length;

// 주력 시너지: 발동된 시너지 중(1명짜리 고유 시너지 제외) 유닛 수가 가장 많은 것
// 핵심 캐리: 딜 아이템(탱커 아이템 제외)을 가장 많이 든 챔피언 → 같으면 별(3성) → 같으면 코스트
//   (도적의 장갑 보유자는 아이템이 랜덤이라 제외)
function addComp(comps, p, place, w = 1, cur = true, label = null) {
  const traits = (p.traits || []).filter(t => t.tier_current > 0 && (t.tier_total || 2) > 1);
  const main = [...traits].sort((a, b) => (b.num_units - a.num_units) || ((b.style || 0) - (a.style || 0)))[0];
  if (!main) return;
  const units = p.units || [];
  const carry = units
    .filter(u => !itemsOf(u).some(n => /ThiefsGloves/i.test(n)))
    .sort((a, b) => (offensive(b) - offensive(a)) || ((b.tier || 0) - (a.tier || 0)) || ((b.rarity || 0) - (a.rarity || 0)))[0];
  if (!carry || offensive(carry) < 2) return;
  const carryId = String(carry.character_id).toLowerCase();
  const key = `${main.name}|${carryId}`;
  const c = (comps[key] ||= { trait: main.name, carry: carryId, games: 0, sumPlace: 0, top4: 0, wins: 0, sumLevel: 0, units: {}, traits: {}, builds: {},
    now: { games: 0, sumPlace: 0, top4: 0, wins: 0 }, before: { games: 0, sumPlace: 0, top4: 0, wins: 0 }, byPatch: {} });
  c.games += w;
  c.sumPlace += w * place;
  if (place <= 4) c.top4 += w;
  if (place === 1) c.wins += w;
  c.sumLevel += w * (p.level || 8);
  // 패치 비교용: 이번 패치 / 이전 패치 실제 판수 (가중치 없이)
  for (const side of [cur ? c.now : c.before, label ? (c.byPatch[label] ||= { games: 0, sumPlace: 0, top4: 0, wins: 0 }) : null]) {
    if (!side) continue;
    side.games++;
    side.sumPlace += place;
    if (place <= 4) side.top4++;
    if (place === 1) side.wins++;
  }
  if (!(w > 0)) return; // 이전 패치(가중치 0)는 비교 기록만
  const seen = new Set();
  for (const u of units) {
    const id = String(u.character_id).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const r = (c.units[id] ||= { n: 0, off: 0, tank: 0, star3: 0 });
    r.n += w;
    if ((u.tier || 0) >= 3) r.star3 += w;
    if (!itemsOf(u).some(n => /ThiefsGloves/i.test(n))) { r.off += w * offensive(u); r.tank += w * tanky(u); }
  }
  for (const t of traits) c.traits[t.name] = (c.traits[t.name] || 0) + w;
  // 이 덱 안에서 각 챔피언의 3신기 (핵심 캐리·메인 탱커 표시에 사용)
  for (const u of units) {
    const items = itemsOf(u);
    if (items.length < 3 || items.some(n => /Tacticians|ThiefsGloves/i.test(n))) continue;
    const id = String(u.character_id).toLowerCase();
    const k = items.slice(0, 3).sort().join('|');
    const b = ((c.builds[id] ||= {})[k] ||= { games: 0, sumPlace: 0 });
    b.games += w;
    b.sumPlace += w * place;
  }
}

/**
 * 통계 → 가중치
 * - 평균 등수 4.5를 기준으로 잘하면 1보다 크게, 못하면 작게
 * - 표본이 적으면 기준값(4.5) 쪽으로 당김 (prior 판수만큼 "평균적인 판"이 있다고 가정)
 */
export function toWeights(stats, { prior = 30, strength = 0.35, min = 0.5, max = 1.6 } = {}) {
  const out = {};
  for (const [trait, tiers] of Object.entries(stats.traits)) {
    for (const [tier, r] of Object.entries(tiers)) {
      const avg = r.sumPlace / r.games;
      const shrunk = (r.sumPlace + prior * 4.5) / (r.games + prior);
      const weight = Math.min(max, Math.max(min, 1 + (4.5 - shrunk) * strength));
      (out[trait] ||= {})[tier] = {
        games: Math.round(r.games),
        avgPlace: round(avg, 2),
        top4: round(r.top4 / r.games, 3),
        win: round(r.wins / r.games, 3),
        weight: round(weight, 3),
      };
    }
  }
  // 챔피언: 평균 등수, 캐리율(완성 아이템 3개를 든 비율)
  const units = {};
  for (const [id, r] of Object.entries(stats.units || {})) {
    if (r.games < 5) continue;
    const items = Object.fromEntries(Object.entries(r.items || {}).sort((a, b) => b[1] - a[1]).slice(0, 12));
    // 3신기 후보: 많이 쓰인 조합 상위 8개
    const builds = Object.entries(r.builds || {})
      .sort((a, b) => b[1].games - a[1].games).slice(0, 10)
      .map(([k, b]) => ({ items: k.split('|'), games: Math.round(b.games), avgPlace: round(b.sumPlace / b.games, 2) }));
    units[id] = { games: Math.round(r.games), avgPlace: round(r.sumPlace / r.games, 2), carryRate: round(r.full / r.games, 3), items, builds };
  }
  // 상징: 어떤 챔피언에게 몇 번 장착됐는지
  const emblems = {};
  for (const [item, holders] of Object.entries(stats.emblems || {})) {
    const h = {};
    let total = 0;
    for (const [id, r] of Object.entries(holders)) { h[id] = Math.round(r.games); total += r.games; }
    if (total >= 3) emblems[item] = { total, holders: h };
  }
  // 메타 덱: 이번 패치 8판 이상 (이번 패치 표본이 아직 적으면 이전 패치 8판 이상도)
  // 성적 = 이번 패치 성적 + 이전 패치 성적을 "최대 prevPrior 판어치"만 섞은 값
  //   → 패치 첫날엔 이전 패치 순위가 보이고, 이번 패치 판이 쌓이면 금방 이번 패치 성적으로 바뀜
  const mature = stats.patch ? stats.patch.mature : true;
  const curPlayers = stats.curGames || stats.games;
  const prevPrior = 20;
  const comps = Object.values(stats.comps || {}).filter(c => c.games > 0 && (c.now.games >= 8 || (!mature && c.before.games >= 8))).map(c => {
    const level = Math.round(c.sumLevel / c.games);
    // 구성: 자주 쓰인 순으로 넉넉히 (자리 채우기는 앱에서 레벨·2칸 챔피언을 고려해서)
    const units = Object.entries(c.units).sort((a, b) => b[1].n - a[1].n).slice(0, 14);
    const core = units.map(([id, r]) => ({ id, rate: round(r.n / c.games, 2), star3: round(r.star3 / r.n, 2), off: round(r.off, 1), tank: round(r.tank, 1) }));
    // 덱 전체에서 딜 아이템/탱커 아이템이 가장 많이 들어간 챔피언 = 핵심 캐리 / 메인 탱커
    const mainCarry = [...units].sort((a, b) => b[1].off - a[1].off)[0]?.[0] || c.carry;
    const mainTank = [...units].filter(([id]) => id !== mainCarry).sort((a, b) => b[1].tank - a[1].tank)[0];
    const topBuild = id => Object.entries(c.builds[id] || {}).sort((a, b) => b[1].games - a[1].games).slice(0, 1)
      .map(([k, b]) => ({ items: k.split('|'), games: Math.round(b.games), avgPlace: round(b.sumPlace / b.games, 2) }))[0] || null;
    const tankId = mainTank && mainTank[1].tank > 0 ? mainTank[0] : null;
    const builds = { [mainCarry]: topBuild(mainCarry), ...(tankId ? { [tankId]: topBuild(tankId) } : {}) };
    return {
      trait: c.trait, carry: c.carry, mainCarry, mainTank: tankId,
      ...blend(c.now, c.before, prevPrior),
      playRate: round((c.now.games || c.games) / Math.max(1, c.now.games ? curPlayers : stats.games), 4), level, core, builds,
      // 패치 비교: 이번 패치만 / 이전 패치만 (가중치 없는 실제 판수)
      now: side(c.now), before: side(c.before),
      // 패치별 실제 성적 (패치 노트 화면의 "예측 vs 실측")
      byPatch: Object.fromEntries(Object.entries(c.byPatch || {}).map(([p, s]) => [p, side(s)])),
    };
  }).sort((a, b) => a.avgPlace - b.avgPlace);
  return {
    setNumber: stats.setNumber,
    games: Math.round(stats.games),
    ...(stats.patch ? { patch: stats.patch } : {}),
    generatedAt: new Date().toISOString(),
    method: { prior, strength, min, max },
    traits: out,
    units,
    emblems,
    comps,
  };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
// 이번 패치 성적에 이전 패치 성적을 최대 k 판어치 사전 정보로 섞기
function blend(n, b, k) {
  const prior = Math.min(b.games, k);
  const bAvg = b.games ? b.sumPlace / b.games : 4.5, bTop4 = b.games ? b.top4 / b.games : 0.5, bWin = b.games ? b.wins / b.games : 0.125;
  const g = n.games + prior;
  return {
    games: n.games || b.games, // 표시용 판수: 이번 패치 판수 (아직 없으면 이전 패치 판수)
    avgPlace: round((n.sumPlace + prior * bAvg) / g, 2),
    top4: round((n.top4 + prior * bTop4) / g, 3),
    win: round((n.wins + prior * bWin) / g, 3),
    patchGames: n.games, // 이번 패치 실제 판수 (0 이면 이전 패치 기록만 있는 덱 = 예측)
  };
}
const side = s => (s && s.games ? { games: s.games, avgPlace: round(s.sumPlace / s.games, 2), top4: round(s.top4 / s.games, 3) } : null);
