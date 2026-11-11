// =============================================================
// 경기 데이터 → 시너지 단계별 통계 → 가중치
// (라이엇 API 호출과 분리된 순수 계산 부분. 테스트하기 쉽도록 따로 둠)
// =============================================================

/**
 * 경기 목록에서 (시너지, 단계)별 통계를 집계
 * @param matches 라이엇 TFT-MATCH-V1 경기 상세 응답 배열
 * @returns { setNumber, games, traits: { [traitId]: { [tier]: { games, sumPlace, top4, wins } } } }
 */
export function aggregate(matches, { queueId = 1100, setNumber = null } = {}) {
  const usable = matches.filter(m => m?.info && (!queueId || m.info.queue_id === queueId));
  // 세트 번호가 정해지지 않았으면 가장 최신 세트만 사용
  const latest = setNumber ?? Math.max(...usable.map(m => m.info.tft_set_number || 0));
  const traits = {};
  const units = {};   // 챔피언별: 판수, 등수 합, 완성 아이템 3개 장착 횟수
  const emblems = {}; // 상징 아이템별 → 장착한 챔피언별 판수
  const comps = {};   // 메타 덱: "주력 시너지 + 핵심 캐리" 별 판수·등수·대표 구성
  let games = 0;
  for (const m of usable) {
    if (m.info.tft_set_number !== latest) continue;
    for (const p of m.info.participants || []) {
      games++;
      const place = p.placement;
      for (const u of p.units || []) {
        const id = String(u.character_id || '').toLowerCase();
        if (!id) continue;
        const items = u.itemNames || u.items || [];
        const names = items.filter(x => typeof x === 'string');
        const ur = (units[id] ||= { games: 0, sumPlace: 0, full: 0, items: {}, builds: {} });
        ur.games++;
        ur.sumPlace += place;
        // 도적의 장갑: 끼면 나머지 아이템이 랜덤 → 이 챔피언의 아이템 기록은 3신기·역할 통계에서 제외
        // 전략가의 왕관/망토/방패: 인원 +1용이라 캐리 아이템 조합이 아님 → 3신기에서 제외
        const random = names.some(n => /ThiefsGloves/i.test(n));
        const tactician = names.some(n => /Tacticians/i.test(n));
        const done = names.filter(n => !/emblem/i.test(n));
        if (!random && done.length >= 3) ur.full++;
        if (!random) for (const n of done) ur.items[n] = (ur.items[n] || 0) + 1; // 어떤 아이템을 끼는지 → 역할 판단
        // 아이템 3개 조합(3신기): 순서 무관하게 묶어서 판수·등수 집계
        if (!random && !tactician && done.length >= 3) {
          const k = done.slice(0, 3).sort().join('|');
          const b = (ur.builds[k] ||= { games: 0, sumPlace: 0 });
          b.games++;
          b.sumPlace += place;
        }
        for (const it of names) {
          if (!/emblem/i.test(it)) continue;
          const er = ((emblems[it] ||= {})[id] ||= { games: 0, sumPlace: 0 });
          er.games++;
          er.sumPlace += place;
        }
      }
      addComp(comps, p, place);
      for (const t of p.traits || []) {
        if (!(t.tier_current > 0)) continue; // 발동 안 된 시너지는 제외
        const row = ((traits[t.name] ||= {})[t.tier_current] ||= { games: 0, sumPlace: 0, top4: 0, wins: 0 });
        row.games++;
        row.sumPlace += place;
        if (place <= 4) row.top4++;
        if (place === 1) row.wins++;
      }
    }
  }
  return { setNumber: latest, games, traits, units, emblems, comps };
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
function addComp(comps, p, place) {
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
  const c = (comps[key] ||= { trait: main.name, carry: carryId, games: 0, sumPlace: 0, top4: 0, wins: 0, sumLevel: 0, units: {}, traits: {}, builds: {} });
  c.games++;
  c.sumPlace += place;
  if (place <= 4) c.top4++;
  if (place === 1) c.wins++;
  c.sumLevel += p.level || 8;
  const seen = new Set();
  for (const u of units) {
    const id = String(u.character_id).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const r = (c.units[id] ||= { n: 0, off: 0, tank: 0, star3: 0 });
    r.n++;
    if ((u.tier || 0) >= 3) r.star3++;
    if (!itemsOf(u).some(n => /ThiefsGloves/i.test(n))) { r.off += offensive(u); r.tank += tanky(u); }
  }
  for (const t of traits) c.traits[t.name] = (c.traits[t.name] || 0) + 1;
  // 이 덱 안에서 각 챔피언의 3신기 (핵심 캐리·메인 탱커 표시에 사용)
  for (const u of units) {
    const items = itemsOf(u);
    if (items.length < 3 || items.some(n => /Tacticians|ThiefsGloves/i.test(n))) continue;
    const id = String(u.character_id).toLowerCase();
    const k = items.slice(0, 3).sort().join('|');
    const b = ((c.builds[id] ||= {})[k] ||= { games: 0, sumPlace: 0 });
    b.games++;
    b.sumPlace += place;
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
        games: r.games,
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
      .map(([k, b]) => ({ items: k.split('|'), games: b.games, avgPlace: round(b.sumPlace / b.games, 2) }));
    units[id] = { games: r.games, avgPlace: round(r.sumPlace / r.games, 2), carryRate: round(r.full / r.games, 3), items, builds };
  }
  // 상징: 어떤 챔피언에게 몇 번 장착됐는지
  const emblems = {};
  for (const [item, holders] of Object.entries(stats.emblems || {})) {
    const h = {};
    let total = 0;
    for (const [id, r] of Object.entries(holders)) { h[id] = r.games; total += r.games; }
    if (total >= 3) emblems[item] = { total, holders: h };
  }
  // 메타 덱: 8판 이상인 덱 종류만
  const comps = Object.values(stats.comps || {}).filter(c => c.games >= 8).map(c => {
    const level = Math.round(c.sumLevel / c.games);
    // 구성: 자주 쓰인 순으로 넉넉히 (자리 채우기는 앱에서 레벨·2칸 챔피언을 고려해서)
    const units = Object.entries(c.units).sort((a, b) => b[1].n - a[1].n).slice(0, 14);
    const core = units.map(([id, r]) => ({ id, rate: round(r.n / c.games, 2), star3: round(r.star3 / r.n, 2), off: r.off, tank: r.tank }));
    // 덱 전체에서 딜 아이템/탱커 아이템이 가장 많이 들어간 챔피언 = 핵심 캐리 / 메인 탱커
    const mainCarry = [...units].sort((a, b) => b[1].off - a[1].off)[0]?.[0] || c.carry;
    const mainTank = [...units].filter(([id]) => id !== mainCarry).sort((a, b) => b[1].tank - a[1].tank)[0];
    const topBuild = id => Object.entries(c.builds[id] || {}).sort((a, b) => b[1].games - a[1].games).slice(0, 1)
      .map(([k, b]) => ({ items: k.split('|'), games: b.games, avgPlace: round(b.sumPlace / b.games, 2) }))[0] || null;
    const tankId = mainTank && mainTank[1].tank > 0 ? mainTank[0] : null;
    const builds = { [mainCarry]: topBuild(mainCarry), ...(tankId ? { [tankId]: topBuild(tankId) } : {}) };
    return {
      trait: c.trait, carry: c.carry, mainCarry, mainTank: tankId,
      games: c.games,
      avgPlace: round(c.sumPlace / c.games, 2), top4: round(c.top4 / c.games, 3), win: round(c.wins / c.games, 3),
      playRate: round(c.games / Math.max(1, stats.games), 4), level, core, builds,
    };
  }).sort((a, b) => a.avgPlace - b.avgPlace);
  return {
    setNumber: stats.setNumber,
    games: stats.games,
    generatedAt: new Date().toISOString(),
    method: { prior, strength, min, max },
    traits: out,
    units,
    emblems,
    comps,
  };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
