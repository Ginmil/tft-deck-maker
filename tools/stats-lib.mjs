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
        const ur = (units[id] ||= { games: 0, sumPlace: 0, top4: 0, win: 0, full: 0, items: {}, builds: {}, stars: {} });
        ur.games += w;
        ur.sumPlace += w * place;
        ur.top4 = (ur.top4 || 0) + (place <= 4 ? w : 0);
        ur.win = (ur.win || 0) + (place === 1 ? w : 0);
        // 별(성)별 성적: 배치툴 칸마다 "2성 / 3성일 때" 성적 표시용
        const st = ((ur.stars ||= {})[u.tier || 1] ||= { games: 0, sumPlace: 0, top4: 0, win: 0 });
        st.games += w; st.sumPlace += w * place; st.top4 += place <= 4 ? w : 0; st.win += place === 1 ? w : 0;
        // 도적의 장갑: 끼면 나머지 아이템이 랜덤 → 이 챔피언의 아이템 기록은 3신기·역할 통계에서 제외
        // 전략가의 왕관/망토/방패: 인원 +1용이라 캐리 아이템 조합이 아님 → 3신기에서 제외
        const random = names.some(n => /ThiefsGloves/i.test(n));
        const tactician = names.some(n => /Tacticians/i.test(n));
        const done = names.filter(n => !/emblem/i.test(n));
        if (!random && done.length >= 3) ur.full += w;
        // 도적의 장갑을 낀 판 (11/17 사용자: 케넨·나르처럼 템을 잘 안 드는 챔피언이 도적을 끼는지) + 낀 완성 아이템 개수 분포
        if (random) { ur.thief = (ur.thief || 0) + w; ur.thiefPlace = (ur.thiefPlace || 0) + w * place; }
        else { (ur.held ||= [0, 0, 0, 0])[Math.min(3, done.length)] += w; }
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

// 주력 시너지: 발동된 시너지 중(1명짜리 고유 시너지 제외) 유닛 수가 가장 많은 것.
//   단, 단계가 하나뿐인데 3명 이상 필요한 시너지(햇빛 3)가 켜져 있으면 그게 주력 — 덱 전체를 그 시너지에 맞춰 짬 (사용자 피드백 11/15)
//   (예전엔 tier_total > 1 로 고유 시너지를 걸러서 단계가 하나뿐인 햇빛이 아예 후보에서 빠졌음)
export function mainTraitOf(p) {
  const traits = (p.traits || []).filter(t => t.tier_current > 0 && (t.num_units || 0) >= 2);
  const signature = t => ((t.tier_total || 2) === 1 && (t.num_units || 0) >= 3 ? 1 : 0);
  return [...traits].sort((a, b) => (signature(b) - signature(a)) || (b.num_units - a.num_units) || ((b.style || 0) - (a.style || 0)))[0];
}
// 핵심 캐리: 딜 아이템(탱커 아이템 제외)을 가장 많이 든 챔피언 → 같으면 별(3성) → 같으면 코스트
//   (도적의 장갑 보유자는 아이템이 랜덤이라 제외)
function addComp(comps, p, place, w = 1, cur = true, label = null) {
  const main = mainTraitOf(p);
  if (!main) return;
  const traits = (p.traits || []).filter(t => t.tier_current > 0 && (t.num_units || 0) >= 2);
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
  // 주력 시너지가 실제로 몇 명이었는지(라이엇 num_units, 상징·럭스 2명분 포함) + 이 덱에서 상징을 쓴 판 (11/15: 6개화 낭비 문제 확인용)
  const mc = (c.mainCount ||= {});
  mc[main.num_units] = (mc[main.num_units] || 0) + w;
  const embs = new Set(units.flatMap(u => (u.itemNames || []).filter(n => typeof n === 'string' && /emblem/i.test(n))));
  for (const e of embs) (c.emblemGames ||= {})[e] = ((c.emblemGames ||= {})[e] || 0) + w;
  // 실제 최종 보드(같은 챔피언 조합)별 기록 + 가장 잘한 판의 보드 그대로(별·아이템·시너지 인원) — 대표 보드용
  // (11/15 사용자 피드백: 자주 나온 챔피언을 모아 채우면 "N% 선택"만 6명인 아무도 안 쓴 보드가 됨)
  const ids = [...seen].sort();
  const bk = ids.join(',');
  const bd = ((c.boards ||= {})[bk] ||= { games: 0, sumPlace: 0, best: null });
  bd.games += w;
  bd.sumPlace += w * place;
  // 이 보드에서 주력 시너지 상징을 낀 개수 (럭스 없이 상징 + 다른 챔피언으로 채우는지 확인용)
  const mainEmb = units.reduce((n, u) => n + (u.itemNames || []).filter(it => typeof it === 'string' && /emblem/i.test(it) && it.toLowerCase().includes(String(main.name).replace(/^(DA_18_|DA_)|18$/g, '').toLowerCase())).length, 0);
  bd.embSum = (bd.embSum || 0) + w * mainEmb;
  if (!bd.best || place < bd.best.place) bd.best = {
    place,
    units: units.map(u => ({ id: String(u.character_id).toLowerCase(), star: u.tier || 1, items: (u.itemNames || []).filter(n => typeof n === 'string') })), // 상징 포함
    traits: Object.fromEntries((p.traits || []).filter(t => t.tier_current > 0).map(t => [t.name, t.num_units])),
  };
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
    const stars = Object.fromEntries(Object.entries(r.stars || {}).filter(([, s]) => s.games >= 5)
      .map(([k, s]) => [k, { games: Math.round(s.games), avgPlace: round(s.sumPlace / s.games, 2), top4: round(s.top4 / s.games, 3), win: round(s.win / s.games, 3) }]));
    units[id] = { games: Math.round(r.games), avgPlace: round(r.sumPlace / r.games, 2), top4: round((r.top4 || 0) / r.games, 3), win: round((r.win || 0) / r.games, 3), carryRate: round(r.full / r.games, 3), items, builds, stars,
      ...(r.thief ? { thief: { rate: round(r.thief / r.games, 3), games: Math.round(r.thief), avgPlace: round(r.thiefPlace / r.thief, 2) } } : {}),
      ...(r.held ? { held: r.held.map(x => round(x / r.games, 3)) } : {}) };
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
    // 대표 보드: 랭커가 실제로 쓴 보드 중 "자주 쓰인 챔피언을 가장 많이 담은" 것 (가장 흔한 인원 수 보드 중에서, 같으면 판수)
    const rate = id => (c.units[id]?.n || 0) / c.games;
    const boards = Object.entries(c.boards || {}).map(([k, b]) => ({ ids: k.split(','), ...b }));
    const sizeGames = {};
    for (const b of boards) sizeGames[b.ids.length] = (sizeGames[b.ids.length] || 0) + b.games;
    const size = Number(Object.entries(sizeGames).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
    // 여러 판에서 똑같이 나온 보드를 우선 (11/15: 지옥불 럭스가 상징 6개 낀 1판짜리 특이한 보드로 잡힘)
    const rep = boards.filter(b => b.ids.length === size)
      // 이 덱에서 잘 안 쓰는 상징(30% 미만)을 낀 보드는 감점 — 상징 증강으로 상징을 여러 개 받은 특이한 판(지옥불 럭스 1판짜리 상징 6개)을 피함
      .map(b => {
        const odd = (b.best?.units || []).flatMap(u => u.items || []).filter(it => /emblem/i.test(it) && (c.emblemGames?.[it] || 0) / c.games < 0.3).length;
        return { b, score: b.ids.reduce((s, id) => s + rate(id), 0) + 0.6 * Math.min(4, b.games - 1) - 0.5 * odd };
      })
      .sort((x, y) => (y.score - x.score) || (y.b.games - x.b.games))[0]?.b;
    const board = rep ? { units: rep.best.units, traits: rep.best.traits, same: Math.round(rep.games), avgPlace: round(rep.sumPlace / rep.games, 2), distinct: boards.length } : null;
    // 자주 나온 실제 보드 (다른 구성 보기·상징 쓰는 방식 확인용): 판수 순 6개, 주력 상징 평균 개수
    const alts = [...boards].sort((a, b) => b.games - a.games).slice(0, 6)
      .map(b => ({ ids: b.ids, games: Math.round(b.games), avgPlace: round(b.sumPlace / b.games, 2), mainEmb: round((b.embSum || 0) / b.games, 2), traits: b.best.traits }));
    return {
      trait: c.trait, carry: c.carry, mainCarry, mainTank: tankId, board, alts,
      ...blend(c.now, c.before, prevPrior),
      playRate: round((c.now.games || c.games) / Math.max(1, c.now.games ? curPlayers : stats.games), 4), level, core, builds,
      // 패치 비교: 이번 패치만 / 이전 패치만 (가중치 없는 실제 판수)
      now: side(c.now), before: side(c.before),
      // 패치별 실제 성적 (패치 노트 화면의 "예측 vs 실측")
      byPatch: Object.fromEntries(Object.entries(c.byPatch || {}).map(([p, s]) => [p, side(s)])),
      // 주력 시너지 인원 분포 { 5: 0.6, 7: 0.3, ... } (판 비율), 상징을 쓴 판 비율 { 상징 아이템: 0.4 } (5% 이상)
      mainCount: Object.fromEntries(Object.entries(c.mainCount || {}).map(([n, g]) => [n, round(g / c.games, 2)]).filter(([, r]) => r >= 0.03)),
      emblems: Object.fromEntries(Object.entries(c.emblemGames || {}).map(([e, g]) => [e, round(g / c.games, 2)]).filter(([, r]) => r >= 0.05).sort((a, b) => b[1] - a[1])),
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
