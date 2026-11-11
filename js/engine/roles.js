// =============================================================
// 챔피언의 역할 판단: 핵심 캐리 / 메인 탱커 / 상징 어울림
// 통계(data.unitStats, data.emblemStats)가 있으면 우선 사용하고,
// 없으면 챔피언 역할·사거리·코스트로 추정한다.
// =============================================================

const isFront = c => c.role === 'TANK' || c.role === 'FIGHTER';
const isRanged = c => (c.range ?? (isFront(c) ? 1 : 4)) >= 3;
const key = id => String(id).toLowerCase();

export function unitStat(data, c) {
  const s = data.unitStats?.[key(c.id)];
  return s && s.games >= 10 ? s : null;
}

/** 캐리 점수: 비싸고, 후방 딜러이고, 실제 경기에서 아이템 3개를 자주 든 챔피언일수록 높음 */
export function carryScore(c, data) {
  let s = c.cost + (isFront(c) ? -3 : 2);
  const st = unitStat(data, c);
  if (st) s += 8 * st.carryRate + 0.5 * (4.5 - st.avgPlace);
  return s;
}

function tankScore(c, data) {
  let s = c.cost + (c.role === 'TANK' ? 3 : c.role === 'FIGHTER' ? 1 : -6);
  const st = unitStat(data, c);
  if (st) s += 0.5 * (4.5 - st.avgPlace);
  return s;
}

/** 팀의 핵심 캐리와 메인 탱커 */
export function coreUnits(team, data, carryIds = []) {
  const forced = carryIds.length ? team.find(c => c.id === carryIds[0]) : null;
  const backs = team.filter(c => !isFront(c));
  const carry = forced || [...(backs.length ? backs : team)].sort((a, b) => carryScore(b, data) - carryScore(a, data))[0];
  const tank = team.filter(c => c !== carry && isFront(c)).sort((a, b) => tankScore(b, data) - tankScore(a, data))[0];
  return { carry: carry?.id || null, tank: tank?.id || null };
}

// 시너지 구성원들의 성향 (탱커 비율, 원거리 비율, 마법/물리 비율)
function profile(data, traitId) {
  const cache = (data._traitProfile ||= {});
  if (cache[traitId]) return cache[traitId];
  const m = data.champions.filter(c => c.traits.includes(traitId));
  const share = f => (m.length ? m.filter(f).length / m.length : 0.5);
  return (cache[traitId] = {
    front: share(isFront), ranged: share(isRanged),
    ap: share(c => c.role === 'AP'), ad: share(c => c.role === 'AD'),
  });
}

/**
 * 이 챔피언이 이 상징과 얼마나 어울리는지 (0~1 정도)
 * 1순위: 실제 상위권 경기에서 이 상징을 이 챔피언에게 낀 비율
 * 2순위: 시너지 구성원과 역할·사거리가 비슷한지 + 코스트(가치)
 */
export function emblemFit(c, traitId, data) {
  const p = profile(data, traitId);
  // 1) 전방/후방: 탱커 시너지면 탱커가, 딜러 시너지면 딜러가 어울림
  const frontMatch = isFront(c) ? p.front : 1 - p.front;
  // 2) 피해 유형: 후방 딜러끼리는 물리(AD)·마법(AP)이 맞아야 함 — 마법사에게 활을 쥐여주지 않도록
  const dmg = isFront(c) ? p.front
    : (c.role === 'AP' ? p.ap : p.ad) / Math.max(0.01, p.ap + p.ad);
  // 3) 사거리
  const rangeMatch = isRanged(c) ? p.ranged : 1 - p.ranged;
  let heuristic = 0.3 * frontMatch + 0.35 * dmg + 0.2 * rangeMatch + 0.15 * (c.cost / 5);
  // 후방 딜러인데 피해 유형이 시너지와 반대면(예: 마법사 + 공격속도 상징) 다른 조건이 좋아도 부적합으로
  if (!isFront(c) && dmg < 0.35) heuristic *= 0.6;

  const st = data.emblemStats?.[traitId];
  if (st && st.total >= 8) {
    const share = (st.holders[key(c.id)] || 0) / st.total;
    return {
      fit: share + 0.15 * heuristic, heuristic, share,
      why: share > 0 ? `상위권 경기에서 이 상징의 ${(share * 100).toFixed(0)}%가 이 챔피언에게 장착됨`
                     : '상위권 경기에서 거의 쓰이지 않은 조합 (역할 기준으로 배정)',
    };
  }
  return { fit: heuristic, heuristic, share: null, why: '시너지 구성원과 역할·사거리가 비슷하고 가치가 높은 챔피언' };
}
