// 자동 생성 파일 — 직접 고치지 말고 js/ 폴더의 원본을 고친 뒤 node build.mjs
(() => {

// ===== js/adapters/cdragon.js =====
// =============================================================
// Community Dragon 어댑터
// -------------------------------------------------------------
// 시즌이 바뀌면 이 파일만 고치면 됩니다.
// 원본 JSON(Community Dragon) → 앱 내부 공통 형식(normalized)으로 변환.
//
// 내부 공통 형식:
// {
//   source, set: { key, number, name },
//   traits:    { [traitId]: { id, name, breakpoints:[2,4,6], desc } },
//   champions: [ { id, name, cost, traits:[traitId], role, icon } ],
//   items:     [ { id, name, role, icon } ],          // 완성 아이템
//   emblems:   [ { id, name, trait, icon } ]          // 상징
// }
// role: 'AD' | 'AP' | 'TANK' | 'FIGHTER' | 'FLEX'
// =============================================================

// 변환 규칙을 바꾸면 이 숫자를 올리세요. 브라우저에 저장된 예전 변환 결과를 자동으로 버리고 새로 받습니다.
const ADAPTER_VERSION = 11;

const DEFAULT_URL = 'https://raw.communitydragon.org/latest/cdragon/tft/ko_kr.json';
const ASSET_BASE = 'https://raw.communitydragon.org/latest/game/';

async function fetchRaw(url, timeoutMs = 45000) {
  // 서버가 응답 없이 붙잡고 있으면 끝없이 기다리지 않도록 시간 제한
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`데이터를 받지 못했어요 (HTTP ${res.status})`);
  return res.json();
}

/** 원본 JSON 안에 들어 있는 세트 목록 (최신 세트가 맨 앞) */
function listSets(raw) {
  let sets = [];
  if (Array.isArray(raw.setData)) {
    sets = raw.setData.map(s => ({ ...s, key: s.mutator || `TFTSet${s.number}` }));
  } else if (raw.sets) {
    sets = Object.entries(raw.sets).map(([k, s]) => ({ ...s, number: Number(k), key: `TFTSet${k}` }));
  }
  return sets
    .filter(s => Array.isArray(s.champions) && s.champions.length > 0)
    .sort((a, b) => {
      if ((b.number || 0) !== (a.number || 0)) return (b.number || 0) - (a.number || 0);
      // 같은 번호면 "TFTSet18" 같은 기본 모드를 우선
      const exact = s => (s.key === `TFTSet${s.number}` ? 0 : 1);
      return exact(a) - exact(b);
    })
    .map(s => ({ key: s.key, number: s.number, name: setName(s) }));
}

function iconUrl(path) {
  if (!path) return null;
  return ASSET_BASE + path.toLowerCase().replace(/\.(tex|dds)$/, '.png');
}

/** 원본 JSON → 공통 형식 */
function normalize(raw, setKey) {
  const sets = Array.isArray(raw.setData)
    ? raw.setData.map(s => ({ ...s, key: s.mutator || `TFTSet${s.number}` }))
    : Object.entries(raw.sets || {}).map(([k, s]) => ({ ...s, number: Number(k), key: `TFTSet${k}` }));
  const set = sets.find(s => s.key === setKey) || sets.find(s => s.key === listSets(raw)[0]?.key);
  if (!set) throw new Error('세트 데이터를 찾지 못했어요. 데이터 형식이 바뀌었을 수 있어요.');

  // ---- 시너지 ----
  const traits = {};
  const traitIdByName = {};
  for (const t of set.traits || []) {
    const bps = [...new Set((t.effects || []).map(e => e.minUnits).filter(n => n > 0 && n < 30))].sort((a, b) => a - b);
    if (!bps.length) continue;
    traits[t.apiName] = { id: t.apiName, name: t.name, breakpoints: bps, desc: stripTags(t.desc) };
    traitIdByName[t.name] = t.apiName;
    traitIdByName[t.apiName] = t.apiName;
  }

  // ---- 챔피언 ----
  const seen = new Set();
  const champions = [];
  for (const c of set.champions || []) {
    const traitIds = (c.traits || []).map(n => traitIdByName[n]).filter(Boolean);
    if (!traitIds.length || !(c.cost >= 1 && c.cost <= 5)) continue; // 소환수·특수 유닛 제외
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    champions.push({
      id: c.apiName, name: c.name, cost: c.cost, traits: traitIds, base: c.name.replace(/\s*[(（].*[)）]\s*$/, ''), // "럭스 (요정)" → "럭스"
      role: championRole(c), range: c.stats?.range ?? null, icon: iconUrl(c.squareIcon || c.tileIcon || c.icon),
    });
  }

  applySpecialRules(set.traits || [], traitIdByName, champions);

  // ---- 아이템 / 상징 ----
  // 시즌마다 이름 규칙이 달라서(예: Set 17까지 TFT_Item_*, Set 18부터 DA_*) 챔피언 이름 앞부분으로 판단
  const champPrefix = mostCommon((set.champions || []).filter(c => (c.traits || []).length).map(c => c.apiName.split('_')[0]));
  const itemFamily = /^TFT\d*$/.test(champPrefix) ? 'TFT_Item_' : `${champPrefix}_`;
  const traitIdByLabel = {};
  for (const t of Object.values(traits)) traitIdByLabel[normLabel(t.name)] = t.id;

  const items = [];
  const artifacts = []; // 유물 (예: DA_Artifact_*, TFT_Item_Artifact_*)
  const radiants = [];  // 찬란한 아이템 (이름 끝 Radiant)
  const itemInfo = {}; // 통계에 나오는 아이템 이름 표시용 (찬란한 아이템 등 포함)
  const recipes = {};  // 아이템 조합식: { 아이템id(소문자): [재료1, 재료2] }
  const emblemByTrait = {};
  const seenItem = new Set();
  for (const it of raw.items || []) {
    if (!it.apiName || !it.name) continue;
    if ((it.composition || []).length === 2 && (it.apiName.startsWith(itemFamily) || it.apiName.startsWith('TFT_Item_') || it.apiName.startsWith(`TFT${set.number}_`))) {
      recipes[it.apiName.toLowerCase()] = it.composition;
    }
    if (it.apiName.startsWith(itemFamily) || it.apiName.startsWith('TFT_Item_')) {
      itemInfo[it.apiName.toLowerCase()] = { name: stripTags(it.name), icon: iconUrl(it.icon) };
      const entry = { id: it.apiName, name: stripTags(it.name), icon: iconUrl(it.icon) };
      if (/_Artifact_/i.test(it.apiName) && !seenItem.has('A:' + entry.name)) { seenItem.add('A:' + entry.name); artifacts.push(entry); }
      else if (/Radiant$/i.test(it.apiName) && !seenItem.has('R:' + entry.name)) { seenItem.add('R:' + entry.name); radiants.push(entry); }
    }
    const isEmblem = /emblem/i.test(it.apiName) || /상징$|emblem$/i.test(it.name.trim());
    if (isEmblem) {
      // 상징 → 시너지 연결: 연결 정보가 있으면 사용, 없으면 이름("선봉대 상징" → "선봉대")으로 찾기
      const trait = [...(it.associatedTraits || []), ...(it.incompatibleTraits || [])].find(t => traits[t])
        || traitIdByLabel[normLabel(it.name.replace(/상징|emblem/ig, ''))];
      if (!trait) continue;
      // 같은 시너지 상징이 여러 개면 이번 세트 이름 규칙 + 조합 가능한 것 우선
      const pref = (it.apiName.startsWith(itemFamily) || it.apiName.startsWith(`TFT${set.number}_`) ? 2 : 0)
        + ((it.composition || []).length === 2 ? 1 : 0);
      const prev = emblemByTrait[trait];
      const ids = [...(prev?.ids || []), it.apiName]; // 같은 시너지의 상징 아이템 전부 (통계 매칭용)
      const recipe = (it.composition || []).length === 2 ? it.composition : prev?.recipe; // 뒤집개 + 재료
      if (!prev || prev.pref < pref) emblemByTrait[trait] = { id: it.apiName, name: it.name, trait, icon: iconUrl(it.icon), pref, ids, recipe };
      else prev.ids = ids;
    } else if (it.apiName.startsWith(itemFamily) && (it.composition || []).length === 2 && !seenItem.has(it.name)) {
      seenItem.add(it.name);
      const known = Object.keys(ITEM_ROLES).find(k => it.apiName.endsWith(k));
      const eff = Object.values(it.effects || {}).some(v => Number(v) > 0) ? it.effects : effectsFromComponents(it.composition);
      items.push({ id: it.apiName, name: it.name, role: known ? ITEM_ROLES[known] : itemRole(eff), icon: iconUrl(it.icon), recipe: it.composition });
    }
  }
  const emblems = Object.values(emblemByTrait).map(({ pref, ...e }) => e);
  // 재료 아이템: 완성 아이템·상징 조합식에 나오는 것 (대검, 활, 지팡이 … 뒤집개, 프라이팬)
  const rawById = new Map((raw.items || []).map(it => [it.apiName, it]));
  // 같은 이름의 재료가 id 두 개로 나오는 경우(Set 18: DA_Component_ChainVest / 옛 TFT_Item_ChainVest)
  // → 조합식에 더 많이 쓰인 id 하나로 합치고, 조합식도 그 id로 바꿈
  const crafted = [...items, ...emblems];
  const uses = {};
  for (const i of crafted) for (const id of i.recipe || []) uses[id] = (uses[id] || 0) + 1;
  const byName = {};
  for (const id of Object.keys(uses)) {
    const name = rawById.get(id)?.name && stripTags(rawById.get(id).name);
    if (!name) continue;
    if (!byName[name] || uses[id] > uses[byName[name]]) byName[name] = id;
  }
  const canon = id => byName[rawById.get(id)?.name && stripTags(rawById.get(id).name)] || id;
  for (const i of crafted) if (i.recipe) i.recipe = i.recipe.map(canon);
  const order = id => { const k = COMPONENT_ORDER.findIndex(n => id.includes(n)); return k < 0 ? 99 : k; };
  const components = Object.values(byName).sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map(id => ({ id, name: stripTags(rawById.get(id).name), icon: iconUrl(rawById.get(id).icon) }));

  return {
    source: 'communitydragon',
    set: { key: set.key, number: set.number, name: setName(set) },
    traits, champions, itemInfo, recipes, components,
    artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    radiants: radiants.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    items: items.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    emblems: emblems.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
  };
}

// ---- 시즌 특수 규칙 ----
// 시너지 설명 문장에서 "중첩 2개로 간주", "팀 슬롯 2개 차지" 같은 규칙을 찾아 챔피언에 반영.
//   champion.weights = { traitId: 2 }  → 그 시너지를 2명분으로 셈 (예: Set 18 화신 럭스)
//   champion.slots   = 2               → 팀 자리를 2칸 차지 (예: Set 18 장로 드래곤)
// 새 시즌에 비슷한 규칙이 나왔는데 문장이 달라 못 잡으면 아래 정규식에 표현을 추가하면 됨.
function applySpecialRules(rawTraits, traitIdByName, champions) {
  for (const t of rawTraits) {
    const desc = stripTags(t.desc);
    const owners = champions.filter(c => c.traits.includes(traitIdByName[t.name]));
    if (!owners.length) continue;

    // 이 시너지를 가진 챔피언의 "다른" 시너지가 2배로 계산됨
    if (/중첩이\s*2개로\s*간주|counts?\s+as\s+2|count(ed)?\s+twice/i.test(desc)) {
      for (const c of owners) {
        c.special = true; // 형태가 여러 개라 원하는 걸 뽑기 어려운 기물 (예: 럭스)
        for (const id of c.traits) if (id !== traitIdByName[t.name]) (c.weights ||= {})[id] = 2;
      }
    }
    // 팀 슬롯을 여러 칸 차지
    const slot = desc.match(/(\d+)\s*개의\s*팀\s*슬롯|takes?\s+up\s+(\d+|two)\s+team\s+slots/i);
    if (slot) {
      const n = Number(slot[1] || (slot[2] === 'two' ? 2 : slot[2]));
      for (const c of owners) c.slots = n;
    }
    // "OO 특성을 +N" → OO 시너지를 N명분으로 셈
    const bonus = desc.match(/(\S+)\s*특성을\s*\+(\d+)/);
    if (bonus && traitIdByName[bonus[1]]) {
      for (const c of owners) (c.weights ||= {})[traitIdByName[bonus[1]]] = Number(bonus[2]);
    }
  }
  // 특수 기물과 같은 챔피언의 다른 형태(예: 기본 럭스)도 함께 표시
  const specialBases = new Set(champions.filter(c => c.special).map(c => c.base));
  for (const c of champions) if (specialBases.has(c.base)) c.special = true;
}

// ---- 보조 함수 ----
function mostCommon(arr) {
  const m = {}; let best = null;
  for (const x of arr) { m[x] = (m[x] || 0) + 1; if (!best || m[x] > m[best]) best = x; }
  return best || 'TFT';
}
function normLabel(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
// 데이터의 세트 이름이 틀린 경우가 있어(Set 18이 "Set10"으로 표기) "SetN" 형태면 키를 사용
function setName(set) {
  const n = set.name || '';
  return !n || /^set\d+$/i.test(n) ? set.key : n;
}

// 기본 아이템의 성격 (시즌이 바뀌어도 거의 그대로라 표로 관리). 새 아이템은 아래 추정 로직이 처리.
const ITEM_ROLES = {
  InfinityEdge: 'AD', LastWhisper: 'AD', Deathblade: 'AD', GiantSlayer: 'AD', Bloodthirster: 'AD', RedBuff: 'AD',
  SteraksGage: 'AD', StrikersFlail: 'AD', HandOfJustice: 'AD', Quicksilver: 'AD', KrakensFury: 'AD', EdgeOfNight: 'AD',
  RunaansHurricane: 'AD',
  RabadonsDeathcap: 'AP', JeweledGauntlet: 'AP', BlueBuff: 'AP', ArchangelsStaff: 'AP', Morellonomicon: 'AP',
  SpearOfShojin: 'AP', NashorsTooth: 'AP', VoidStaff: 'AP', HextechGunblade: 'AP', StatikkShiv: 'AP',
  WarmogsArmor: 'TANK', GargoyleStoneplate: 'TANK', DragonsClaw: 'TANK', BrambleVest: 'TANK', SunfireCape: 'TANK',
  SpiritVisage: 'TANK', Redemption: 'TANK', ProtectorsVow: 'TANK', Evenshroud: 'TANK', SteadfastHeart: 'TANK',
  IonicSpark: 'TANK', AdaptiveHelm: 'TANK', TitansResolve: 'TANK',
  GuinsoosRageblade: 'FLEX', Crownguard: 'FLEX', ThiefsGloves: 'FLEX',
  TacticiansCrown: 'FLEX', TacticiansCape: 'FLEX', TacticiansShield: 'FLEX',
};

// 완성 아이템 스탯이 비어 있을 때(Set 18~) 재료 아이템으로 성격을 추정
const COMPONENT_STATS = {
  BFSword: { AD: 1 }, RecurveBow: { AS: 1 }, NeedlesslyLargeRod: { AP: 1 }, TearOfTheGoddess: { Mana: 1 },
  ChainVest: { Armor: 1 }, NegatronCloak: { MagicResist: 1 }, GiantsBelt: { Health: 1 }, SparringGloves: { CritChance: 1 },
};
const COMPONENT_ORDER = ['BFSword', 'RecurveBow', 'NeedlesslyLargeRod', 'TearOfTheGoddess', 'ChainVest', 'NegatronCloak', 'GiantsBelt', 'SparringGloves', 'Spatula', 'FryingPan'];
function effectsFromComponents(comp) {
  const eff = {};
  for (const c of comp || []) {
    const key = Object.keys(COMPONENT_STATS).find(k => c.includes(k));
    if (key) for (const [k, v] of Object.entries(COMPONENT_STATS[key])) eff[k] = (eff[k] || 0) + v;
  }
  return eff;
}

// ---- 역할 추정 ----
function championRole(c) {
  if (/_AP$/i.test(c.apiName)) return 'AP';
  if (/_AD$/i.test(c.apiName)) return 'AD';
  const r = String(c.role || '');
  if (/tank/i.test(r)) return 'TANK';
  if (/fighter|bruiser/i.test(r)) return 'FIGHTER';
  if (/^AP/i.test(r) || /caster|mage/i.test(r)) return 'AP';
  if (/^AD/i.test(r) || /marksman|carry|assassin|specialist|reaper/i.test(r)) return 'AD';
  // role 필드가 없을 때(Set 18~): 스킬 설명의 피해 유형 표시 + 스탯으로 판단
  //  - 원거리(사거리 3 이상): 물리/마법 중 많은 쪽 딜러
  //  - 근접: 마나 소모가 적고(50 이하) 방어 계수가 없으면 근접 딜러(암살자 등),
  //          마나가 많거나(80 이상) 방어력·마저·체력 계수/피해 감소가 있으면 탱커, 그 외 전사
  //  ※ 보호막은 주문력 계수인 경우가 많아(예: 케넨) 탱커 판단에 쓰지 않음
  const s = c.stats || {};
  const desc = String(c.ability?.desc || '');
  const cnt = re => (desc.match(re) || []).length;
  const ad = cnt(/scaleAD|PhysicalDamage|물리 피해|physical damage/gi);
  const ap = cnt(/scaleAP|MagicDamage|마법 피해|magic damage/gi);
  const tankScale = cnt(/scaleArmor|scaleMR|scaleHealth/gi) + cnt(/내구력|피해 감소|Durability|DamageReduction|damage reduction/gi);
  const dmgType = ap > ad ? 'AP' : 'AD';
  if ((s.range || 0) >= 3) return dmgType;
  const mana = s.mana ?? 70;
  if (tankScale === 0 && (mana <= 50 || ad + ap >= 6)) return dmgType; // 근접 딜러
  if (mana >= 80 || tankScale > 0) return 'TANK';
  return 'FIGHTER';
}

function itemRole(effects) {
  const score = { AD: 0, AP: 0, TANK: 0 };
  const has = k => Number(effects[k]) > 0;
  if (has('AD')) score.AD += 1;
  if (has('CritChance')) score.AD += 1;
  if (has('AS')) { score.AD += 0.5; score.AP += 0.3; }
  if (has('AP')) score.AP += 1;
  if (has('Mana')) score.AP += 0.7;
  if (has('Health')) score.TANK += 0.8;
  if (has('Armor')) score.TANK += 1;
  if (has('MagicResist')) score.TANK += 1;
  const sorted = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] === 0 || sorted[0][1] === sorted[1][1]) return 'FLEX';
  return sorted[0][0];
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/@[^@]+@/g, '?').replace(/\s+/g, ' ').trim();
}


// ===== js/engine/roles.js =====
// =============================================================
// 챔피언의 역할 판단: 핵심 캐리 / 메인 탱커 / 상징 어울림
// 통계(data.unitStats, data.emblemStats)가 있으면 우선 사용하고,
// 없으면 챔피언 역할·사거리·코스트로 추정한다.
// =============================================================

const isFront = c => c.role === 'TANK' || c.role === 'FIGHTER';
const isRanged = c => (c.range ?? (isFront(c) ? 1 : 4)) >= 3;
const key = id => String(id).toLowerCase();

function unitStat(data, c) {
  const s = data.unitStats?.[key(c.id)];
  return s && s.games >= 10 ? s : null;
}

/** 캐리 점수: 비싸고, 후방 딜러이고, 실제 경기에서 아이템 3개를 자주 든 챔피언일수록 높음 */
function carryScore(c, data) {
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
function coreUnits(team, data, carryIds = []) {
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
function emblemFit(c, traitId, data) {
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


// ===== js/engine/scorer.js =====
// =============================================================
// 팀 평가기: 팀(챔피언 목록) + 상징 → 시너지 집계와 점수
// 세트 데이터와 무관하게 동작합니다 (공통 형식만 사용).
// =============================================================


const MAX_EMBLEMS_PER_UNIT = 2; // 한 챔피언에 상징은 2개까지 (아이템 칸 확보)

/**
 * 상징을 누구에게 줄지 배정한다.
 * 규칙: 그 시너지를 "이미 가진" 챔피언은 상징 효과를 못 받음, 같은 상징 중복 불가,
 *       챔피언당 상징 2개까지, 핵심 캐리는 아이템 자리 때문에 1개까지.
 * 1순위: 적용되는 상징 수 최대화
 * 2순위(fit 모드): 상징과 어울리는 챔피언에게 (emblemFit 합 최대화)
 * 탐색 중에는 빠른 모드(1순위만), 최종 결과에서만 fit 모드로 계산한다.
 * @returns {Array<{trait, holder|null, why?}>}
 */
function assignEmblems(team, emblemTraits, { data = null, coreId = null } = {}) {
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
function evaluateTeam(team, data, opts = {}) {
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


// ===== js/engine/search.js =====
// =============================================================
// 덱 탐색기 (빔 서치) + 기능 1·2·3
// 챔피언 60명 중 8명 = 수십억 가지 → 전부 볼 수 없으므로
// 한 명씩 추가하며 "점수 상위 K개 조합"만 남기는 빔 서치를 사용.
// =============================================================

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
function searchTeams(data, opts) {
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
function decksForTraits(data, { desired, size, maxCost, emblems = [], ...filters }) {
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

function itemFit(champ, item) {
  return FIT[item.role]?.[champ.role] ?? 0;
}

// -------------------------------------------------------------
// 랭커 통계 기반 챔피언-아이템 궁합 (통계가 있으면 역할 추정보다 우선)
// -------------------------------------------------------------
const STAT_MIN_GAMES = 30; // 이보다 적게 나온 챔피언은 통계를 믿지 않음
const unitStatOf = (data, champ) => {
  const u = data.unitStats?.[champ.id.toLowerCase()];
  return u && u.games >= STAT_MIN_GAMES ? u : null;
};
/**
 * 챔피언이 이 아이템을 얼마나 잘 쓰는지 0~1.
 * 통계: 랭커 경기에서 이 챔피언이 이 아이템을 낀 비율(판당) × 3 (33% 이상이면 1)
 * 통계 없음: 역할 기반 itemFit (통계 파일은 있는데 표본이 적은 챔피언은 낮춰서)
 */
function itemAffinity(data, champ, item) {
  const u = unitStatOf(data, champ);
  if (!u) return itemFit(champ, item) * (data.unitStats ? 0.3 : 1);
  return Math.min(1, ((u.items?.[item.id] || 0) / u.games) * 3);
}

/**
 * 고른 아이템을 랭커들이 실제로 준 챔피언 순위 (통계 필요)
 * rate = 이 챔피언이 그 아이템을 낀 판 비율, share = 그 아이템 전체 중 이 챔피언에게 간 비율
 * build = 고른 아이템을 가장 많이 포함하는 실제 3신기 중 성적이 좋은 것 (= 다음에 만들 아이템)
 */
function carriesForItems(data, { itemIds, maxCost = 5, exclude = [], max5 = Infinity, top = 5 }) {
  if (!data.unitStats) return [];
  const items = itemIds.map(id => data.items.find(i => i.id === id) || { id }).filter(Boolean);
  const total = {};
  for (const u of Object.values(data.unitStats)) for (const [id, n] of Object.entries(u.items || {})) total[id] = (total[id] || 0) + n;
  const want = itemIds.reduce((m, id) => (m[id] = (m[id] || 0) + 1, m), {});
  const rows = [];
  for (const champ of data.champions) {
    if (champ.cost > maxCost || exclude.includes(champ.id) || (champ.cost === 5 && max5 < 1)) continue;
    const u = unitStatOf(data, champ);
    if (!u) continue;
    let score = 0;
    const rates = Object.entries(want).map(([id, k]) => {
      const n = u.items?.[id] || 0;
      const rate = n / u.games, aff = Math.min(1, rate * 1.5); // 67% 이상 끼면 만점 (순위 구분용으로 넓게)
      score += aff * (k > 1 ? 1 + 0.5 * (k - 1) : 1); // 같은 아이템 2개째는 절반
      return { item: items.find(i => i.id === id), rate, share: total[id] ? n / total[id] : 0 };
    });
    if (!rates.some(r => r.rate >= 0.05)) continue;
    // 실제 3신기 중 고른 아이템과 가장 많이 겹치는 것 → 성적순
    const build = (u.builds || []).map(b => {
      const rest = [...itemIds];
      let overlap = 0;
      for (const it of b.items) { const i = rest.indexOf(it); if (i >= 0) { overlap++; rest.splice(i, 1); } }
      return { ...b, overlap, shrunk: (b.avgPlace * b.games + 4.5 * 5) / (b.games + 5) };
    }).filter(b => b.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.shrunk - b.shrunk)[0] || null;
    rows.push({ champ, score, rates, games: u.games, avgPlace: u.avgPlace, carryRate: u.carryRate, build });
  }
  return rows.sort((a, b) => b.score - a.score || a.avgPlace - b.avgPlace).slice(0, top);
}

function decksForItems(data, { itemIds, size, maxCost, emblems = [], top = 3, carryId = null, ...filters }) {
  const { exclude = [], max5 = Infinity } = filters;
  const items = itemIds.map(id => data.items.find(i => i.id === id)).filter(Boolean);
  if (!items.length) return [];
  // 아이템을 가장 잘 쓰는 챔피언 순위 (고코스트 캐리 우대)
  const ranked = data.champions
    .filter(c => carryId ? c.id === carryId : c.cost <= maxCost && !exclude.includes(c.id) && !(c.cost === 5 && max5 < 1))
    .map(c => {
      const fit = items.reduce((s, it) => s + itemAffinity(data, c, it), 0);
      return { champ: c, fit, rank: fit * (1 + (data.unitStats ? 0.05 : 0.15) * c.cost) }; // 통계가 있으면 코스트 가산은 작게
    })
    .filter(r => r.fit > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, top);

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
    return deck ? { carry: champ, fit, items: distributeItems(data, deck.team, items, champ.id), ...deck } : null;
  }).filter(Boolean);
}

/** 아이템을 덱 안에서 가장 잘 맞는 챔피언에게 배분 (최대 3칸) */
function distributeItems(data, team, items, carryId) {
  const slots = Object.fromEntries(team.map(c => [c.id, []]));
  const sorted = [...items].sort((a, b) => (a.role === 'FLEX') - (b.role === 'FLEX'));
  for (const it of sorted) {
    const best = team
      .filter(c => slots[c.id].length < 3)
      .map(c => { const fit = itemAffinity(data, c, it); return { c, f: fit + (c.id === carryId && it.role !== 'TANK' && fit > 0 ? 0.5 : 0) + c.cost * 0.05 }; })
      .sort((a, b) => b.f - a.f)[0];
    if (best) slots[best.c.id].push(it);
  }
  return slots;
}

// -------------------------------------------------------------
// 기능 5. 재료 아이템 → 조합 추천
// 가진 재료를 짝짓는 모든 방법(최대 매칭)을 따져 보고, 캐리 1명 + 탱커 1명이 가장 잘 쓰는 조합을 고른 뒤
// 그 완성 아이템으로 덱을 추천. 짝이 없는 재료는 남겨 둠(다음 라운드용).
// -------------------------------------------------------------
/** 재료 두 개 → 완성 아이템/상징 조합표 */
function recipeBook(data) {
  const book = new Map();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const e of data.emblems || []) if (e.recipe?.length === 2) book.set(key(...e.recipe), { kind: 'emblem', ...e });
  for (const it of data.items || []) if (it.recipe?.length === 2) book.set(key(...it.recipe), { kind: 'item', ...it });
  return { get: (a, b) => book.get(key(a, b)) };
}

/**
 * 재료 목록 → 짝짓는 방법들.
 * 재료가 홀수면 하나는 남는데, "어느 것을 남길지"도 선택지 (예: 눈물 4·허리띠 2… → 허리띠를 남기고 눈물로 블루를 만들기).
 * 그래서 짝이 있어도 홀수 개수만큼은 남겨 둘 수 있게 함. 그 이상 남기는 건(만들 수 있는데 안 만듦) 제외.
 */
function pairings(components, book, limit = 20000) {
  // 재료를 종류별 개수로 세고, "첫 번째 남은 종류"를 짝지을 상대 종류를 오름차순으로만 골라
  // 같은 결과(완성 아이템 묶음)를 한 번씩만 만듦 (예전엔 순서만 다른 같은 결과를 수천 번 만들어 2,000개 제한에 걸렸음)
  const types = [...new Set(components)].sort();
  const count0 = types.map(t => components.filter(c => c === t).length);
  const maxSkip = components.length % 2;
  const out = [];
  const rec = (count, made, left, minPartner) => {
    if (out.length >= limit) return;
    const i = count.findIndex(n => n > 0);
    if (i < 0) { out.push({ made, left }); return; }
    let paired = false;
    for (let j = Math.max(i, minPartner[i] ?? i); j < types.length; j++) {
      if (count[j] - (j === i ? 1 : 0) <= 0) continue;
      const r = book.get(types[i], types[j]);
      if (!r) continue;
      paired = true;
      const next = [...count]; next[i]--; next[j]--;
      // 같은 종류 i 를 또 짝지을 때는 j 이상인 상대만 (중복 방지)
      rec(next, [...made, { result: r, from: [types[i], types[j]] }], left, { ...minPartner, [i]: j });
    }
    // 짝이 없으면 남기고, 짝이 있어도 홀수라 하나는 남는 경우 이 종류를 남기는 선택지도
    if (!paired || left.length < maxSkip) {
      const next = [...count]; next[i]--;
      rec(next, made, [...left, types[i]], minPartner);
    }
  };
  rec(count0, [], [], {});
  return out;
}

/** 아이템 묶음 점수: 캐리 1명(딜템 3칸) + 탱커 1명(탱템 3칸) + 나머지 */
function planScore(data, items, emblems, champs) {
  const best = (pool, filter, costW) => {
    let top = { score: 0, champ: null, used: [] };
    for (const c of champs) {
      if (!filter(c)) continue;
      const seen = {};
      const fits = pool.map((it, k) => {
        const dup = seen[it.id] = (seen[it.id] || 0) + 1;
        return { k, f: itemAffinity(data, c, it) * (dup > 1 ? 0.6 : 1) }; // 같은 아이템 중복은 효율이 떨어짐
      }).filter(x => x.f > 0).sort((a, b) => b.f - a.f).slice(0, 3);
      const sc = fits.reduce((s, x) => s + x.f, 0) * (1 + costW * c.cost);
      if (sc > top.score) top = { score: sc, champ: c, used: fits.map(x => x.k) };
    }
    return top;
  };
  const dmg = items.filter(it => it.role !== 'TANK');
  const carry = best(dmg, c => c.role !== 'TANK', 0.15);
  const restDmg = dmg.filter((_, k) => !carry.used.includes(k));
  const tank = best(items.filter(it => it.role === 'TANK').concat(restDmg.filter(it => it.role === 'FLEX')), c => c.role === 'TANK' || c.role === 'FIGHTER', 0.05);
  const others = items.length - carry.used.length - tank.used.length;
  return { score: carry.score + tank.score * 0.8 + others * 0.3 + emblems.length * 0.8, carry: carry.champ, tank: tank.champ };
}

function craftPlans(data, { components, plans = 3, size, maxCost, ...filters }) {
  const { exclude = [], max5 = Infinity } = filters;
  const book = recipeBook(data);
  const champs = data.champions.filter(c => c.cost <= maxCost && !exclude.includes(c.id) && !(c.cost === 5 && max5 < 1));
  const seen = new Set();
  const scored = [];
  for (const p of pairings(components, book)) {
    const k = p.made.map(m => m.result.id).sort().join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    const items = p.made.filter(m => m.result.kind === 'item').map(m => m.result);
    const emblems = p.made.filter(m => m.result.kind === 'emblem').map(m => m.result.trait);
    if (!items.length) continue;
    scored.push({ ...p, items, emblems, ...planScore(data, items, emblems, champs) });
  }
  scored.sort((a, b) => b.score - a.score);
  // 비슷한 조합만 나오지 않게: 먼저 캐리 유형(물리/마법/전사형)별 최고 조합, 남는 자리는 아이템이 2개 이상 다른 조합
  const picked = [];
  const ids = p => p.made.map(m => m.result.id);
  for (const p of scored) {
    if (picked.length >= plans) break;
    if (p.carry && !picked.some(q => q.carry?.role === p.carry.role)) picked.push(p);
  }
  for (const p of scored) {
    if (picked.length >= plans) break;
    if (!picked.includes(p) && picked.every(q => diffCount(ids(p), ids(q)) >= 2)) picked.push(p);
  }
  picked.sort((a, b) => b.score - a.score);
  return picked.map(p => {
    const [deck] = decksForItems(data, { ...filters, itemIds: p.items.map(i => i.id), emblems: p.emblems, size, maxCost, top: 1, carryId: p.carry?.id });
    return deck ? { ...deck, craft: { made: p.made, left: p.left, score: p.score } } : null;
  }).filter(Boolean);
}

/** 두 아이템 목록에서 서로 다른 개수 (중복 고려) */
function diffCount(a, b) {
  const rest = [...b];
  let diff = 0;
  for (const x of a) { const i = rest.indexOf(x); if (i < 0) diff++; else rest.splice(i, 1); }
  return diff;
}

// -------------------------------------------------------------
// 기능 4. 내 보드 → 다음 수 추천
// 배치툴 보드의 챔피언을 유지한 채 남은 자리를 채워 완성 덱을 추천.
// - 보드에 낀 상징은 상징으로 계산, 딜 아이템을 가장 많이 든 챔피언을 핵심 캐리로 고정
// - keepAll=false 면 아이템·3성·캐리가 아닌 챔피언은 "되도록 유지"(가산점)만 하고 바꿀 수 있음
// -------------------------------------------------------------
/** 보드 칸 목록 → 챔피언·상징·캐리 정보 */
function readBoard(data, board) {
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

function decksFromBoard(data, { board, size, keepAll = true, ...filters }) {
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
function emblemTeamMaker(data, { emblems, size, maxCost, desired = {}, ...filters }) {
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

// -------------------------------------------------------------
// 기능 6. 내 보드 + 남은 아이템 → 누구에게 무슨 아이템을 줄지 (자동 배분)
// - 이미 낀 아이템은 고정, 남은 칸(최대 3칸)에만
// - 재료가 있으면 어떤 완성 아이템을 만들지까지 (짝짓는 모든 방법 중 가장 좋은 것)
// - 점수: 랭커 통계 궁합(itemAffinity) + 이미 캐리 아이템을 든 챔피언에게 몰아주기 + 랭커 3신기와 일치하면 가산
// - 상징: 그 시너지가 없는 챔피언에게, 시너지 단계가 실제로 올라가면 높게
// -------------------------------------------------------------
function assignItems(data, { board, inventory, carryIdx = null }) {
  const byId = new Map(data.champions.map(c => [c.id, c]));
  const emblemOf = id => data.emblems.find(e => e.id === id || (e.ids || []).includes(id));
  const componentIds = new Set((data.components || []).map(c => c.id));
  const lookup = id => {
    const em = emblemOf(id);
    if (em) return { ...em, id, kind: 'emblem' };
    const it = data.items.find(i => i.id === id);
    if (it) return { ...it, kind: 'item' };
    const rad = (data.radiants || []).find(i => i.id === id);
    if (rad) { // 찬란한 아이템: 원래 아이템 기준으로 궁합 판단
      const base = data.items.find(i => i.id === id.replace(/_?Radiant$/i, ''));
      return { ...rad, kind: 'item', role: base?.role || 'FLEX', statId: base?.id };
    }
    const art = (data.artifacts || []).find(i => i.id === id);
    if (art) return { ...art, kind: 'item', role: 'FLEX' };
    return { id, name: id, kind: 'item', role: 'FLEX' };
  };
  const units = board.map(b => {
    const champ = byId.get(b.id);
    if (!champ) return null;
    const held = (b.items || []).map(lookup);
    return { idx: b.idx, champ, star: b.star || 2, held, free: Math.max(0, 3 - held.length) };
  }).filter(Boolean);

  const aff = (u, it) => itemAffinity(data, u.champ, it.statId ? { ...it, id: it.statId } : it);
  // 이미 아이템(딜템 등)을 든 챔피언 = 그 덱의 아이템 홀더 → 같은 계열 아이템을 몰아줌
  // (게임에서 이미 아이템을 준 챔피언 = 키우기로 정한 캐리. 다른 챔피언이 통계상 조금 더 잘 써도 몰아주는 게 보통 더 셈 — 사용자 피드백 11/15 로 +100%/개)
  // 사용자가 "몰아줄 캐리"로 고른 챔피언은 캐리템 2개를 든 것과 같은 대우
  const holderBonus = u => 1 + 1.0 * (u.idx === carryIdx ? 2 : Math.min(2, u.held.filter(h => h.kind === 'item' && aff(u, h) >= 0.3).length));
  // 적응가(공격력·주문력 중 높은 쪽을 씀): 물리 아이템과 마법 아이템을 섞으면 한쪽은 버리는 셈
  const isAdaptor = u => u.champ.traits.some(t => /Adaptor/i.test(t) || /공격력과 주문력 중 어느 쪽이 높은지/.test(data.traits[t]?.desc || ''));
  const buildsOf = u => data.unitStats?.[u.champ.id.toLowerCase()]?.builds || [];
  // 아이템 홀더 가중치: 랭커 경기에서 이 챔피언이 아이템 3개를 든 비율(carryRate).
  // 롤체는 나눠 주기보다 한 챔피언에 몰아줘야 함 → 홀더가 아닌 챔피언(요릭 0.08 등)에게 준 아이템은 가치가 작음
  const unitWeight = u => {
    const st = data.unitStats?.[u.champ.id.toLowerCase()];
    const w = st && st.games >= 30 ? Math.max(0.3, Math.min(1.4, 0.3 + 1.4 * (st.carryRate || 0))) : 1;
    return u.idx === carryIdx ? Math.max(w, 1.3) : w;
  };
  const unitValue = (u, added) => {
    let v = 0;
    const seen = {};
    const w = unitWeight(u);
    for (const it of added) {
      const dup = (seen[it.id] = (seen[it.id] || 0) + 1) + u.held.filter(h => h.id === it.id).length;
      v += aff(u, it) * holderBonus(u) * (dup > 1 ? 0.4 : 1) * w; // 같은 아이템 두 개는 효율이 크게 떨어짐(랭커 3신기에도 거의 없음)
    }
    const nItems = u.held.filter(h => h.kind === 'item').length + added.filter(x => x.kind === 'item').length;
    // 홀더의 3칸을 채우면 가산 (캐리는 3번째 아이템이 좀 덜 맞아도 채우는 게 보통 더 셈 — 자이라 블루 7%)
    // 단, 그 챔피언이 전혀 안 쓰는 아이템(이온 충격기 0% 등)으로 채우는 건 가산 없음
    if (added.length && nItems === 3) {
      const minAff = Math.min(...added.map(it => aff(u, it)));
      v += 0.5 * w * Math.min(1, minAff / 0.2);
    }
    // 적응가: 물리(AD)와 마법(AP) 아이템을 섞으면 적은 쪽만큼 감점
    if (isAdaptor(u)) {
      const all = [...u.held, ...added].filter(x => x.kind === 'item');
      const ad = all.filter(x => x.role === 'AD').length, ap = all.filter(x => x.role === 'AP').length;
      if (ad && ap) v -= 0.8 * Math.min(ad, ap) * w;
    }
    // 아이템이 없던 챔피언에게 하나만 덜렁 주는 건 비효율
    if (!u.held.length && added.length === 1) v -= 0.15;
    // 랭커 3신기와 일치하면 가산 (3개 완성 일치 0.5, 2개 이상이 한 3신기 안에 0.2)
    const final = [...u.held, ...added].filter(x => x.kind === 'item').map(x => x.statId || x.id).sort();
    if (added.length && final.length >= 2) {
      const builds = buildsOf(u).filter(b => b.games >= 5);
      const contains = b => { const rest = [...b.items]; return final.every(id => { const i = rest.indexOf(id); if (i < 0) return false; rest.splice(i, 1); return true; }); };
      if (final.length === 3 && builds.some(b => [...b.items].sort().join() === final.join())) v += 0.5;
      else if (builds.some(contains)) v += 0.2;
    }
    return v;
  };

  // 일반 아이템 배분: 큰 것부터 욕심껏 → 옮기기·바꾸기로 다듬기
  function place(items) {
    const slots = new Map(units.map(u => [u, []]));
    const total = () => units.reduce((s, u) => s + unitValue(u, slots.get(u)), 0);
    const order = [...items].sort((a, b) => Math.max(...units.map(u => aff(u, b))) - Math.max(...units.map(u => aff(u, a))));
    const unplaced = [];
    for (const it of order) {
      let best = null;
      for (const u of units) {
        const list = slots.get(u);
        if (list.length >= u.free) continue;
        const gain = unitValue(u, [...list, it]) - unitValue(u, list);
        if (!best || gain > best.gain) best = { u, gain };
      }
      // 어울리는 챔피언이 없으면 억지로 주지 않고 보관 (예: 물리 딜러가 없는데 무한의 대검)
      if (best && best.gain >= 0.1) slots.get(best.u).push(it); else unplaced.push({ ...it, why: best ? 'nofit' : 'noslot' });
    }
    for (let iter = 0, improved = true; improved && iter < 30; iter++) {
      improved = false;
      const base = total();
      outer: for (const u of units) {
        for (const [k, it] of slots.get(u).entries()) {
          for (const v of units) {
            if (v === u) continue;
            const lu = slots.get(u), lv = slots.get(v);
            if (lv.length < v.free) { // 옮기기
              lu.splice(k, 1); lv.push(it);
              if (total() > base + 1e-9) { improved = true; break outer; }
              lv.pop(); lu.splice(k, 0, it);
            }
            for (const [j, other] of lv.entries()) { // 바꾸기
              lu[k] = other; lv[j] = it;
              if (total() > base + 1e-9) { improved = true; break outer; }
              lu[k] = it; lv[j] = other;
            }
          }
        }
      }
    }
    return { slots, unplaced, value: total() };
  }

  // 상징: 남은 칸 중, 그 시너지가 없는 챔피언에게 → 시너지 단계가 오르면 높은 점수
  function placeEmblems(emblems, slots) {
    const out = [], unplaced = [];
    const count = t => units.filter(u => u.champ.traits.includes(t)).length
      + units.filter(u => !u.champ.traits.includes(t) && u.held.some(h => h.kind === 'emblem' && h.trait === t)).length;
    const extra = {};
    let value = 0;
    for (const em of emblems) {
      const t = em.trait, bps = data.traits[t]?.breakpoints || [];
      const n = count(t) + (extra[t] || 0);
      const next = bps.find(b => b > n);
      const gain = next === n + 1 ? 1 + 0.2 * bps.indexOf(next) : next ? 0.25 : 0.05;
      // 남은 칸이 있고 시너지가 없는 챔피언 중, 일반 아이템을 덜 받은(캐리가 아닌) 쪽
      const cand = units.filter(u => !u.champ.traits.includes(t) && slots.get(u).length < u.free)
        .sort((a, b) => unitValue(a, slots.get(a)) - unitValue(b, slots.get(b)) || a.champ.cost - b.champ.cost)[0];
      if (!cand) { unplaced.push({ ...em, why: units.every(u => u.champ.traits.includes(t)) ? 'nofit' : 'noslot' }); continue; }
      slots.get(cand).push(em);
      extra[t] = (extra[t] || 0) + 1;
      value += gain;
      out.push({ em, u: cand, n, next, gain });
    }
    return { placed: out, unplaced, value };
  }

  // 재료: 짝짓는 방법마다 배분해 보고 가장 좋은 것
  const comps = inventory.filter(id => componentIds.has(id));
  const ready = inventory.filter(id => !componentIds.has(id)).map(lookup);
  const book = recipeBook(data);
  const allPlans = comps.length ? pairings(comps, book, 100000) : [{ made: [], left: [] }];
  // 재료가 많으면 짝짓는 방법이 수만 가지(15개 ≈ 3만) → 빠른 어림 점수로 추린 뒤 상위만 제대로 배분
  // 어림 점수 = 아이템마다 "가장 잘 쓰는 챔피언 한 명"의 가치, 남은 칸 수만큼 큰 것부터 합
  const totalFree = units.reduce((s, u) => s + u.free, 0);
  const bestVal = new Map();
  const quickOf = id => {
    if (!bestVal.has(id)) {
      const it = lookup(id);
      bestVal.set(id, it.kind === 'emblem' ? 0.6 : Math.max(0, ...units.filter(u => u.free).map(u => aff(u, it) * holderBonus(u) * unitWeight(u))));
    }
    return bestVal.get(id);
  };
  const plans = allPlans.length <= 300 ? allPlans : allPlans
    .map(p => {
      // 같은 아이템이 여러 개면 두 번째부터 0.4 (본 배분과 같은 중복 감점)
      const seen = {};
      const vals = [...ready.map(it => it.id), ...p.made.map(m => m.result.id)]
        .map(id => quickOf(id) * ((seen[id] = (seen[id] || 0) + 1) > 1 ? 0.4 : 1));
      return { p, q: vals.sort((a, b) => b - a).slice(0, totalFree).reduce((s, x) => s + x, 0) };
    })
    .sort((a, b) => b.q - a.q).slice(0, 300).map(x => x.p);
  let best = null;
  const seenPlan = new Set();
  for (const p of plans) {
    const key = p.made.map(m => m.result.id).sort().join();
    if (seenPlan.has(key)) continue;
    seenPlan.add(key);
    const crafted = p.made.map(m => ({ ...lookup(m.result.id), from: m.from }));
    const all = [...ready, ...crafted];
    const placed = place(all.filter(x => x.kind === 'item'));
    const ems = placeEmblems(all.filter(x => x.kind === 'emblem'), placed.slots);
    const score = placed.value + ems.value;
    if (!best || score > best.score) best = { score, placed, ems, left: p.left };
  }
  const reasonOf = (u, it) => {
    const st = data.unitStats?.[u.champ.id.toLowerCase()];
    const rate = st && st.games >= 30 ? (st.items?.[it.statId || it.id] || 0) / st.games : null;
    return { rate };
  };
  const assignments = [];
  for (const u of units) {
    for (const it of best.placed.slots.get(u)) {
      if (it.kind === 'emblem') continue;
      assignments.push({ item: it, idx: u.idx, champ: u.champ, from: it.from || null, ...reasonOf(u, it) });
    }
  }
  for (const e of best.ems.placed) assignments.push({ item: e.em, idx: e.u.idx, champ: e.u.champ, from: e.em.from || null, emblem: { trait: e.em.trait, from: e.n, to: e.n + 1, reaches: e.next === e.n + 1 } });
  // 최종 아이템 3개가 랭커 3신기와 똑같으면 그 기록 (화면에 "랭커 3신기 · N판 M등")
  const buildMatch = {};
  for (const u of units) {
    const final = [...u.held, ...best.placed.slots.get(u)].filter(x => x.kind === 'item').map(x => x.statId || x.id).sort();
    if (final.length !== 3 || !best.placed.slots.get(u).length) continue;
    const b = buildsOf(u).find(b => b.games >= 5 && [...b.items].sort().join() === final.join());
    if (b) buildMatch[u.idx] = { games: b.games, avgPlace: b.avgPlace };
  }
  // 같은 챔피언끼리 모아서 보여주기 좋게 (아이템을 많이 받는 챔피언 먼저)
  const per = assignments.reduce((m, a) => (m[a.idx] = (m[a.idx] || 0) + 1, m), {});
  assignments.sort((a, b) => per[b.idx] - per[a.idx] || a.idx - b.idx);
  return {
    assignments,
    unplaced: [...best.placed.unplaced, ...best.ems.unplaced],
    leftComponents: best.left,
    crafted: assignments.filter(a => a.from).length,
    score: best.score,
    buildMatch,
  };
}


// ===== js/engine/patch.js =====
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
function patchImpact(comp, changes) {
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
function patchReport(comps, patch, prevPatch) {
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
function prevBalancePatch(schedule, name) {
  const i = schedule.findIndex(p => p.patch === name);
  for (let j = i - 1; j >= 0; j--) if (schedule[j].balance !== false) return schedule[j].patch;
  return null;
}

function pRound(x, d) { return Math.round(x * 10 ** d) / 10 ** d; }


// ===== js/builder.js =====
// =============================================================
// 배치툴: 4×7 육각형 보드에 챔피언·아이템·상징·별을 배치하고 시너지를 실시간 계산
// - 덱 카드의 "배치툴로 보기" → deckToBoard() 로 자동 배치
// - 저장(브라우저) / 배치 코드 복사·붙여넣기
// 앱(app.js)에서 initBuilder(ctx) 로 연결. ctx = { getData, esc, traitName, roleKo, buildsFor, openTab }
// =============================================================

const BD_ROWS = 4, BD_COLS = 7;            // 0행 = 맨 앞줄(적과 가까운 줄), 3행 = 맨 뒷줄
const BD_SAVE_KEY = 'tft-deck-maker:boards';
let bd = null;                              // ctx
const bdState = { cells: {}, selected: null, costFilter: 0, itemGroup: 'normal', inv: [], invMode: false }; // cells[idx] = { id, star, items: [] }, inv = 남은 아이템

const bdIdx = (r, c) => r * BD_COLS + c;
const bdData = () => bd.getData();
const bdChamp = id => bdData()?.champions.find(c => c.id === id);
const bdIsFront = c => c.role === 'TANK' || c.role === 'FIGHTER' || (c.range ?? 4) < 3;

function initBuilder(ctx) {
  bd = ctx;
  const $ = id => document.getElementById(id);
  $('bdFilter').oninput = bdRenderPool;
  $('bdItemFilter').oninput = bdRenderItems;
  $('bdCosts').onclick = e => {
    const b = e.target.closest('[data-cost]'); if (!b) return;
    bdState.costFilter = Number(b.dataset.cost) === bdState.costFilter ? 0 : Number(b.dataset.cost);
    bdRenderPool();
  };
  $('bdClear').onclick = () => { bdState.cells = {}; bdState.selected = null; bdRender(); };
  $('bdUndo').onclick = () => {
    const code = bdState.undo; bdState.undo = null;
    if (bdState.undoInv) { bdState.inv = bdState.undoInv; bdState.undoInv = null; bdRenderInv(); }
    if (code) bdDecode(code);
  };
  $('bdAuto').onclick = () => {
    const units = Object.values(bdState.cells).map(u => ({ ...u, champ: bdChamp(u.id) })).filter(u => u.champ);
    bdState.cells = bdAutoPlace(units);
    bdRender();
  };
  $('bdSave').onclick = () => {
    const name = $('bdName').value.trim() || `덱 ${new Date().toLocaleString('ko-KR')}`;
    const list = bdLoadList().filter(x => x.name !== name);
    list.unshift({ name, code: bdEncode() });
    try { localStorage.setItem(BD_SAVE_KEY, JSON.stringify(list.slice(0, 50))); } catch { /* 저장 공간 문제 무시 */ }
    bdRenderSaved(); bdToast(`"${name}" 저장했어요`);
  };
  $('bdLoad').onchange = e => {
    const x = bdLoadList().find(x => x.name === e.target.value);
    if (x) { bdDecode(x.code); $('bdName').value = x.name; }
    e.target.value = '';
  };
  $('bdCopy').onclick = async () => {
    const code = bdEncode();
    try { await navigator.clipboard.writeText(code); bdToast('배치 코드를 복사했어요'); }
    catch { prompt('아래 코드를 복사하세요', code); }
  };
  $('bdPaste').onclick = () => {
    const code = prompt('배치 코드를 붙여넣으세요');
    if (code && !bdDecode(code.trim())) bdToast('코드를 읽지 못했어요');
  };

  // 보드: 드롭 / 클릭
  const board = $('bdBoard');
  board.addEventListener('dragover', e => { if (e.target.closest('.hex')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
  board.addEventListener('drop', e => {
    const hex = e.target.closest('.hex'); if (!hex) return;
    e.preventDefault();
    bdHandleDrop(JSON.parse(e.dataTransfer.getData('text/plain') || '{}'), Number(hex.dataset.idx));
  });
  board.addEventListener('dragstart', e => {
    const hex = e.target.closest('.hex[data-has]'); if (!hex) return;
    const item = e.target.closest('.bdItem');
    const payload = item
      ? { kind: 'unitItem', from: Number(hex.dataset.idx), i: Number(item.dataset.i) } // 낀 아이템 끌기
      : { kind: 'move', from: Number(hex.dataset.idx) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    bdState.dragging = payload;
  });
  // 보드(칸) 밖에 놓으면 빼기: 챔피언이면 챔피언을, 아이템이면 그 아이템을
  board.addEventListener('dragend', e => {
    const p = bdState.dragging; bdState.dragging = null;
    if (!p || e.dataTransfer.dropEffect !== 'none') return;
    if (p.kind === 'move') delete bdState.cells[p.from];
    if (p.kind === 'unitItem') bdState.cells[p.from]?.items.splice(p.i, 1);
    bdState.selected = null; bdRender();
  });
  board.addEventListener('click', e => {
    const idx = Number(e.target.closest('.hex')?.dataset.idx);
    if (Number.isNaN(idx)) return;
    if (e.target.closest('.bdStar')) { const u = bdState.cells[idx]; u.star = u.star % 3 + 1; bdRender(); return; }
    if (e.target.closest('.bdItem')) { const u = bdState.cells[idx]; u.items.splice(Number(e.target.closest('.bdItem').dataset.i), 1); bdRender(); return; }
    const sel = bdState.selected;
    if (sel?.kind === 'champ') { bdPlaceChamp(sel.id, idx); bdState.selected = null; }
    else if (sel?.kind === 'item') { bdAddItem(idx, sel.id); }
    else if (sel?.kind === 'cell' && sel.idx !== idx) { bdMove(sel.idx, idx); bdState.selected = null; }
    else if (bdState.cells[idx]) bdState.selected = sel?.kind === 'cell' && sel.idx === idx ? null : { kind: 'cell', idx };
    bdRender();
  });
  board.addEventListener('contextmenu', e => {
    const hex = e.target.closest('.hex[data-has]'); if (!hex) return;
    e.preventDefault();
    delete bdState.cells[Number(hex.dataset.idx)];
    bdState.selected = null; bdRender();
  });
  // 보드 밖으로 끌어내면 빼기
  $('bdTrash').addEventListener('dragover', e => e.preventDefault());
  $('bdTrash').addEventListener('drop', e => {
    e.preventDefault();
    const p = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
    if (p.kind === 'move') delete bdState.cells[p.from];
    if (p.kind === 'unitItem') bdState.cells[p.from]?.items.splice(p.i, 1);
    bdState.dragging = null; bdRender();
  });
  $('bdTrash').addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });

  // 선택한 챔피언 상세: 별 / 아이템 빼기 / 챔피언 빼기
  $('bdDetail').addEventListener('click', e => {
    const s = bdState.selected; if (s?.kind !== 'cell') return;
    const u = bdState.cells[s.idx]; if (!u) return;
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'star') u.star = Number(b.dataset.v);
    if (b.dataset.act === 'rmItem') u.items.splice(Number(b.dataset.i), 1);
    if (b.dataset.act === 'rmUnit') { delete bdState.cells[s.idx]; bdState.selected = null; }
    if (b.dataset.act === 'close') bdState.selected = null;
    bdRender();
  });
  // 남은 아이템 (자동 배분용)
  $('bdInvMode').onchange = e => { bdState.invMode = e.target.checked; if (bdState.invMode) bdState.selected = null; bdRender(); };
  $('bdInvClear').onclick = () => { bdState.inv = []; bdRenderInv(); };
  $('bdInv').onclick = e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    bdState.inv.splice(Number(b.dataset.i), 1); bdRenderInv();
  };
  // 남은 아이템 칸에 끌어다 놓기
  $('bdInv').addEventListener('dragover', e => e.preventDefault());
  $('bdInv').addEventListener('drop', e => {
    e.preventDefault();
    const p = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
    if (p.kind === 'item') { bdState.inv.push(p.id); bdRenderInv(); }
  });

  // 아이템 분류 탭
  $('bdItemTabs').onclick = e => {
    const b = e.target.closest('[data-g]'); if (!b) return;
    bdState.itemGroup = b.dataset.g; bdRenderItems();
  };

  // 챔피언·아이템 풀: 끌기 / 클릭 선택
  for (const [id, kind] of [['bdPool', 'champ'], ['bdItems', 'item']]) {
    $(id).addEventListener('dragstart', e => {
      const el = e.target.closest('[data-id]'); if (!el) return;
      e.dataTransfer.setData('text/plain', JSON.stringify({ kind, id: el.dataset.id }));
    });
    $(id).addEventListener('click', e => {
      const el = e.target.closest('[data-id]'); if (!el) return;
      const s = bdState.selected;
      if (kind === 'item' && bdState.invMode) { bdState.inv.push(el.dataset.id); bdRenderInv(); return; } // 남은 아이템 칸에 담기
      if (kind === 'item' && s?.kind === 'cell') { bdAddItem(s.idx, el.dataset.id); bdRender(); return; }
      bdState.selected = s?.kind === kind && s.id === el.dataset.id ? null : { kind, id: el.dataset.id };
      // 챔피언은 클릭하면 바로 빈 자리에 (앞/뒷줄 자동)
      if (kind === 'champ') { bdPlaceChamp(el.dataset.id, null); bdState.selected = null; }
      bdRender();
    });
  }

}

/** 데이터가 준비되면 호출: 주소에 #b=코드 가 있으면 그 배치를 불러옴 */
function bdOnData() {
  const m = location.hash.match(/#b=([^&]+)/);
  if (m && !Object.keys(bdState.cells).length) bdDecode(decodeURIComponent(m[1]));
  else if (!document.getElementById('panel-builder').hidden) bdRender();
}

// ---------------- 배치 조작 ----------------
function bdHandleDrop(p, idx) {
  if (p.kind === 'champ') bdPlaceChamp(p.id, idx);
  else if (p.kind === 'item') bdAddItem(idx, p.id);
  else if (p.kind === 'move') bdMove(p.from, idx);
  else if (p.kind === 'unitItem' && p.from !== idx) {
    const src = bdState.cells[p.from], it = src?.items[p.i];
    if (it && bdState.cells[idx]?.items.length < 3) { src.items.splice(p.i, 1); bdAddItem(idx, it); }
    else if (it && !bdState.cells[idx]) bdToast('아이템은 챔피언에게 옮겨주세요');
  }
  bdRender();
}
function bdPlaceChamp(id, idx) {
  const c = bdChamp(id); if (!c) return;
  if (idx == null) idx = bdFreeCell(bdIsFront(c));
  if (idx == null) return bdToast('빈 자리가 없어요');
  bdState.cells[idx] = { id, star: 2, items: [] };
}
function bdFreeCell(front) {
  const rows = front ? [0, 1, 2, 3] : [3, 2, 1, 0];
  const cols = [3, 2, 4, 1, 5, 0, 6];
  for (const r of rows) for (const c of cols) if (!bdState.cells[bdIdx(r, c)]) return bdIdx(r, c);
  return null;
}
function bdMove(from, to) {
  const a = bdState.cells[from], b = bdState.cells[to];
  if (!a) return;
  bdState.cells[to] = a;
  if (b) bdState.cells[from] = b; else delete bdState.cells[from];
}
function bdAddItem(idx, itemId) {
  const u = bdState.cells[idx];
  if (!u) return bdToast('아이템은 챔피언에게 끼워주세요');
  if (u.items.length >= 3) return bdToast('아이템은 3개까지예요');
  u.items.push(itemId);
}

// ---------------- 덱 → 보드 (자동 배치) ----------------
// units: [{ champ, star, items }]
// 앞줄: 탱커(메인 탱커는 가운데) → 전사·근접 딜러, 뒷줄: 핵심 캐리는 구석, 나머지 원거리
function bdAutoPlace(units, { carryId = null, tankId = null } = {}) {
  const cells = {};
  const put = (u, r, c) => { cells[bdIdx(r, c)] = { id: u.champ.id, star: u.star || 2, items: u.items || [] }; };
  const front = units.filter(u => bdIsFront(u.champ) && u.champ.id !== carryId);
  const back = units.filter(u => !front.includes(u));
  const tankOrder = u => (u.champ.id === tankId ? -10 : 0) + ({ TANK: 0, FIGHTER: 1 }[u.champ.role] ?? 2) - u.champ.cost * 0.1;
  front.sort((a, b) => tankOrder(a) - tankOrder(b));
  const frontSlots = [[0, 3], [0, 2], [0, 4], [0, 1], [0, 5], [0, 0], [0, 6], [1, 3], [1, 2], [1, 4], [1, 1], [1, 5]];
  front.forEach((u, i) => { const s = frontSlots[i] || [1, i % 7]; put(u, ...s); });
  back.sort((a, b) => (b.champ.id === carryId) - (a.champ.id === carryId) || b.champ.cost - a.champ.cost);
  const backSlots = [[3, 0], [3, 6], [3, 1], [3, 5], [3, 2], [3, 4], [3, 3], [2, 0], [2, 6], [2, 3]];
  let bi = 0;
  for (const u of back) {
    while (backSlots[bi] && cells[bdIdx(...backSlots[bi])]) bi++;
    const s = backSlots[bi++] || [2, bi % 7];
    put(u, ...s);
  }
  return cells;
}

/** 덱 카드 객체(d) → 보드에 올리고 배치툴 탭 열기 */
function bdOpenDeck(d) {
  const data = bdData();
  const carryId = d.carry?.id || d.core?.carry;
  const tankId = d.core?.tank;
  const emblemItem = t => data.emblems.find(e => e.trait === t)?.id;
  const units = d.team.map(c => {
    const items = [];
    for (const a of d.assignment || []) if (a.holder === c.id && emblemItem(a.trait)) items.push(emblemItem(a.trait));
    const build = d.builds?.[c.id] || ((c.id === carryId || c.id === tankId) ? bd.buildsFor(c)[0] : null);
    for (const it of build?.items || []) if (items.length < 3) items.push(it);
    for (const it of d.items?.[c.id] || []) if (items.length < 3) items.push(it.id); // 아이템 탭 결과
    const star3 = (d.unitInfo?.[c.id]?.star3 || 0) >= 0.4;
    return { champ: c, star: star3 ? 3 : 2, items };
  });
  if (d.board) {
    // 내 보드 기반 추천: 지금 배치·아이템은 그대로 두고, 판매할 챔피언만 빼고 새 챔피언을 빈 칸에
    bdState.undo = bdEncode();
    const removed = new Set(d.board.removed), added = new Set(d.board.added);
    for (const [i, u] of Object.entries(bdState.cells)) if (removed.has(u.id)) delete bdState.cells[i];
    for (const u of units) {
      if (!added.has(u.champ.id)) continue;
      const idx = bdFreeCell(bdIsFront(u.champ));
      if (idx != null) bdState.cells[idx] = { id: u.champ.id, star: u.star, items: u.items };
    }
    bdToast('추천 덱을 보드에 적용했어요 — 되돌리려면 "되돌리기"');
  } else {
    bdState.undo = null;
    bdState.cells = bdAutoPlace(units, { carryId, tankId });
    document.getElementById('bdName').value = (d.title || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  bdState.selected = null;
  bd.openTab('builder');
  bdRender();
}

function bdRenderInv() {
  const box = document.getElementById('bdInv'); if (!box) return;
  // "몰아줄 캐리" 목록 = 보드 위 챔피언 (고른 값 유지)
  const sel = document.getElementById('bdAssignCarry');
  if (sel) {
    const cur = sel.value;
    const units = Object.entries(bdState.cells).map(([idx, u]) => ({ idx, c: bdChamp(u.id) })).filter(x => x.c)
      .sort((a, b) => b.c.cost - a.c.cost || a.c.name.localeCompare(b.c.name, 'ko'));
    sel.innerHTML = '<option value="">자동 (이미 템을 든 챔피언·랭커 통계)</option>'
      + units.map(x => `<option value="${x.idx}">${bd.esc(x.c.name)} (${x.c.cost}코)</option>`).join('');
    sel.value = units.some(x => x.idx === cur) ? cur : '';
  }
  box.innerHTML = bdState.inv.map((id, i) => {
    const it = bdItemInfo(id);
    return `<span class="chip">${it.icon ? `<img src="${bd.esc(it.icon)}" alt="" class="chipIcon" onerror="this.remove()">` : ''}${bd.esc(it.name)}<button data-i="${i}" aria-label="빼기">✕</button></span>`;
  }).join('');
}
/** 남은 아이템 목록 (자동 배분용) */
function bdInventory() { return [...bdState.inv]; }
/** 자동 배분 결과를 보드에 넣기: [{ idx, itemId }] + 남길 아이템 목록 (되돌리기 가능) */
function bdApplyItems(list, keep) {
  bdState.undo = bdEncode();
  bdState.undoInv = [...bdState.inv];
  for (const { idx, itemId } of list) {
    const u = bdState.cells[idx];
    if (u && u.items.length < 3) u.items.push(itemId);
  }
  bdState.inv = [...keep];
  bdRender();
  bdRenderInv();
  bdToast('아이템을 보드에 넣었어요 — 되돌리려면 "되돌리기"');
}

/** 지금 보드의 챔피언 목록 (다음 수 추천용) */
function bdBoardUnits() {
  return Object.entries(bdState.cells).map(([idx, u]) => ({ idx: Number(idx), id: u.id, star: u.star, items: [...u.items] }));
}

// ---------------- 시너지 계산 (보드 기준) ----------------
function bdTraits() {
  const data = bdData();
  const counts = {}, base = {};
  for (const u of Object.values(bdState.cells)) {
    const c = bdChamp(u.id); if (!c) continue;
    for (const t of c.traits) { const w = c.weights?.[t] ?? 1; counts[t] = (counts[t] || 0) + w; base[t] = (base[t] || 0) + w; }
    for (const it of u.items) {
      const e = data.emblems.find(e => e.id === it);
      if (e && !c.traits.includes(e.trait)) counts[e.trait] = (counts[e.trait] || 0) + 1;
    }
  }
  return Object.entries(counts).map(([id, n]) => {
    const t = data.traits[id]; if (!t) return null;
    const reached = t.breakpoints.filter(b => n >= b);
    return { id, name: t.name, count: n, bps: t.breakpoints, tier: reached.length, top: reached.at(-1) || 0, emblem: (base[id] || 0) < (reached.at(-1) || 0) };
  }).filter(Boolean).sort((a, b) => (b.tier > 0) - (a.tier > 0) || b.top - a.top || b.count - a.count);
}

// ---------------- 그리기 ----------------
function bdItemInfo(id) {
  const data = bdData();
  const e = [...data.emblems, ...(data.artifacts || []), ...(data.radiants || []), ...(data.components || [])].find(x => x.id === id);
  if (e) return { name: e.name, icon: e.icon };
  return data.itemInfo?.[id.toLowerCase()] || data.items.find(i => i.id === id) || { name: id, icon: null };
}

function bdRender() {
  bdRenderInv();
  if (!bdData()) return;
  const { esc } = bd;
  const sel = bdState.selected;
  let html = '';
  for (let r = 0; r < BD_ROWS; r++) {
    html += `<div class="hexRow ${r % 2 ? 'odd' : ''}">`;
    for (let c = 0; c < BD_COLS; c++) {
      const idx = bdIdx(r, c), u = bdState.cells[idx], ch = u && bdChamp(u.id);
      const isSel = sel?.kind === 'cell' && sel.idx === idx;
      html += ch
        ? `<div class="hex has ${isSel ? 'sel' : ''}" data-idx="${idx}" data-has="1" data-cost="${ch.cost}" draggable="true" title="${esc(ch.name)} — 클릭: 선택(아이템/이동) · 우클릭: 빼기">
            <div class="hexIn">${ch.icon ? `<img src="${esc(ch.icon)}" alt="" draggable="false" onerror="this.style.visibility='hidden'">` : ''}</div>
            <span class="bdStar s${u.star}" title="클릭해서 별 바꾸기">${'★'.repeat(u.star)}</span>
            <span class="bdName">${esc(ch.name)}</span>
            <div class="bdItems">${u.items.map((it, i) => { const inf = bdItemInfo(it); return `<span class="bdItem" data-i="${i}" data-item="${esc(it)}" draggable="true">${inf.icon ? `<img src="${esc(inf.icon)}" alt="" draggable="false" onerror="this.remove()">` : esc(inf.name.slice(0, 2))}</span>`; }).join('')}</div>
          </div>`
        : `<div class="hex ${sel && sel.kind !== 'item' ? 'target' : ''}" data-idx="${idx}"><div class="hexIn"></div></div>`;
    }
    html += '</div>';
  }
  document.getElementById('bdBoard').innerHTML = html;

  const traits = bdTraits();
  document.getElementById('bdTraits').innerHTML = traits.length
    ? traits.filter(t => t.tier > 0 || t.count >= 1).map(t => {
        const lvl = t.tier === 0 ? 'off' : t.top === t.bps.at(-1) ? 't3' : t.tier >= 2 ? 't2' : 't1';
        return `<span class="tp ${lvl} ${t.emblem ? 'emb' : ''}"><b>${t.count}</b> ${esc(t.name)}<span class="bps">${t.bps.join('/')}</span></span>`;
      }).join('')
    : '<span class="muted small">챔피언을 보드에 놓으면 시너지가 계산돼요</span>';
  const n = Object.keys(bdState.cells).length;
  const gold = Object.values(bdState.cells).reduce((s, u) => s + (bdChamp(u.id)?.cost || 0), 0);
  document.getElementById('bdCount').textContent = `${n}명 · ${gold}골드`;
  document.getElementById('bdUndo').hidden = !bdState.undo;
  document.getElementById('bdHint').textContent =
    bdState.invMode ? '아이템을 누르면 아래 "남은 아이템" 칸에 담겨요 (체크를 풀면 다시 챔피언에게 끼우기)'
    : sel?.kind === 'item' ? `"${bdItemInfo(sel.id).name}" 선택됨 — 끼울 챔피언을 클릭하세요`
    : sel?.kind === 'cell' ? '선택됨 — 다른 칸을 클릭하면 이동, 아이템을 클릭하면 장착'
    : '챔피언을 끌어다 놓거나 클릭 · 챔피언을 클릭하면 아이템/별 편집 · 보드 밖으로 끌어내면 빼기';
  try { history.replaceState(null, '', n ? `#b=${encodeURIComponent(bdEncode())}` : location.pathname + location.search); } catch { /* file:// 등에서 실패해도 무시 */ }
  bdRenderDetail();
  bdRenderPool(); bdRenderItems(); bdRenderSaved();
}

function bdRenderDetail() {
  const { esc, traitName, roleKo } = bd;
  const box = document.getElementById('bdDetail');
  const s = bdState.selected, u = s?.kind === 'cell' && bdState.cells[s.idx], c = u && bdChamp(u.id);
  if (!c) { box.hidden = true; return; }
  box.hidden = false;
  const slots = [0, 1, 2].map(i => {
    const it = u.items[i];
    if (!it) return '<div class="bdSlot empty">빈 칸</div>';
    const inf = bdItemInfo(it);
    return `<div class="bdSlot" data-item="${esc(it)}">${inf.icon ? `<img src="${esc(inf.icon)}" alt="" onerror="this.remove()">` : ''}<span>${esc(inf.name)}</span>
      <button class="x" data-act="rmItem" data-i="${i}" title="이 아이템 빼기">✕</button></div>`;
  }).join('');
  box.innerHTML = `
    <div class="bdDHead">
      ${c.icon ? `<img src="${esc(c.icon)}" alt="" onerror="this.style.visibility='hidden'">` : ''}
      <div><b>${esc(c.name)}</b> <span class="muted small">${c.cost}코 · ${roleKo[c.role]}</span>
        <div class="muted small">${c.traits.map(traitName).map(esc).join(' · ')}</div></div>
      <div class="bdStars">${[1, 2, 3].map(n => `<button class="bp ${u.star === n ? 'on' : ''}" data-act="star" data-v="${n}">${'★'.repeat(n)}</button>`).join('')}</div>
      <button class="btn ghost" data-act="rmUnit">챔피언 빼기</button>
      <button class="btn ghost" data-act="close">닫기</button>
    </div>
    <div class="bdSlots">${slots}</div>
    <p class="muted small">오른쪽 아이템을 클릭하면 이 챔피언에게 끼워져요 · 아이템을 보드 밖으로 끌어내도 빠져요</p>`;
}

function bdRenderPool() {
  const data = bdData(); if (!data) return;
  const { esc, traitName } = bd;
  const q = document.getElementById('bdFilter').value.trim();
  const onBoard = new Set(Object.values(bdState.cells).map(u => u.id));
  document.querySelectorAll('#bdCosts [data-cost]').forEach(b => b.classList.toggle('on', Number(b.dataset.cost) === bdState.costFilter));
  document.getElementById('bdPool').innerHTML = data.champions
    .filter(c => (!bdState.costFilter || c.cost === bdState.costFilter) && (!q || c.name.includes(q) || c.traits.some(t => traitName(t).includes(q))))
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'ko'))
    .map(c => `<div class="bdChamp ${onBoard.has(c.id) ? 'used' : ''}" data-id="${esc(c.id)}" data-cost="${c.cost}" draggable="true" title="${esc(c.name)} · ${c.traits.map(traitName).map(esc).join(', ')}">
        ${c.icon ? `<img src="${esc(c.icon)}" alt="" draggable="false" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}<span>${esc(c.name)}</span></div>`).join('');
}

// 아이템 분류: 일반(조합) / 찬란한 / 유물 / 상징
function bdItemGroups() {
  const data = bdData();
  return {
    normal: { label: '일반', list: data.items },
    component: { label: '재료', list: data.components || [] },
    radiant: { label: '찬란한', list: data.radiants || [] },
    artifact: { label: '유물', list: data.artifacts || [] },
    emblem: { label: '상징', list: data.emblems },
  };
}

function bdRenderItems() {
  const data = bdData(); if (!data) return;
  const { esc } = bd;
  const q = document.getElementById('bdItemFilter').value.trim();
  const sel = bdState.selected;
  const groups = bdItemGroups();
  // 검색어가 있으면 전체에서 찾기
  const all = q
    ? Object.entries(groups).flatMap(([g, x]) => x.list.map(i => ({ ...i, g }))).filter(i => i.name.includes(q))
    : groups[bdState.itemGroup].list.map(i => ({ ...i, g: bdState.itemGroup }));
  document.getElementById('bdItemTabs').innerHTML = Object.entries(groups).filter(([, x]) => x.list.length)
    .map(([g, x]) => `<button class="bp ${!q && g === bdState.itemGroup ? 'on' : ''}" data-g="${g}">${x.label} ${x.list.length}</button>`).join('');
  document.getElementById('bdItems').innerHTML = all.map(i =>
    `<div class="bdIt ${sel?.kind === 'item' && sel.id === i.id ? 'on' : ''} g-${i.g}" data-id="${esc(i.id)}" data-item="${esc(i.id)}" draggable="true">
      ${i.icon ? `<img src="${esc(i.icon)}" alt="" draggable="false" loading="lazy" onerror="this.remove()">` : ''}<span>${esc(i.name)}</span></div>`).join('')
    || '<span class="muted small">없어요</span>';
}

function bdRenderSaved() {
  const list = bdLoadList();
  document.getElementById('bdLoad').innerHTML = `<option value="">저장한 배치 (${list.length})</option>` +
    list.map(x => `<option>${bd.esc(x.name)}</option>`).join('');
}

// ---------------- 저장·코드 ----------------
function bdLoadList() { try { return JSON.parse(localStorage.getItem(BD_SAVE_KEY) || '[]'); } catch { return []; } }

// 코드 형식: [[칸번호, 챔피언id, 별, [아이템...]], ...] 을 JSON → base64 (한글 안전)
function bdEncode() {
  const arr = Object.entries(bdState.cells).map(([i, u]) => [Number(i), u.id, u.star, u.items]);
  return btoa(unescape(encodeURIComponent(JSON.stringify(arr))));
}
function bdDecode(code) {
  try {
    const arr = JSON.parse(decodeURIComponent(escape(atob(code))));
    const cells = {};
    for (const [i, id, star, items] of arr) if (bdChamp(id)) cells[i] = { id, star: star || 2, items: items || [] };
    bdState.cells = cells; bdState.selected = null;
    bd.openTab('builder'); bdRender();
    return true;
  } catch { return false; }
}

function bdToast(msg) {
  const t = document.getElementById('bdToast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(bdToast.timer); bdToast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}


// ===== js/app.js =====
// =============================================================
// 화면 로직
// 데이터 → 어댑터(normalize) → 엔진(search) → 화면
// =============================================================





const $ = id => document.getElementById(id);
const CACHE_KEY = `tft-deck-maker:data:v${ADAPTER_VERSION}`; // 어댑터를 고치면 버전을 올려 옛 캐시를 무시
const URL_KEY = 'tft-deck-maker:url';

const state = {
  raw: null,          // 원본 JSON (세트 전환용, 메모리에만 보관)
  data: null,         // 공통 형식 데이터
  emblems: [],        // 고른 상징 (시너지 id, 중복 가능)
  items: [],          // 고른 아이템 id (중복 가능)
  comps: [],          // 고른 재료 아이템 id (중복 가능)
  itemMode: 'full',   // 아이템 탭: full = 완성 아이템, comp = 재료 아이템
  desired: {},        // 시너지 탭 목표 { traitId: bp }
  emblemDesired: {},  // 상징 탭 추가 목표
  weights: null,      // 통계 가중치 (tools/collect-stats.mjs 결과)
};

// ---------------- 저장소 (실패해도 앱은 동작) ----------------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 용량 초과 등 무시 */ } },
};

// ---------------- 데이터 불러오기 ----------------
function setStatus(msg, error = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', error);
}

async function loadFromUrl(url) {
  setStatus('데이터를 받는 중이에요… (파일이 커서 몇 초 걸릴 수 있어요)');
  $('btnFetch').disabled = true;
  try {
    const raw = await fetchRaw(url);
    store.set(URL_KEY, url);
    useRaw(raw, `불러옴: ${url}`);
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? '데이터 서버가 응답하지 않아요'
      : e instanceof TypeError ? '데이터 서버에 연결하지 못했어요' : e.message;
    // Community Dragon 장애 대비: 저장소에 둔 사본으로 대신
    if (!state.data && await loadSnapshot(`${msg} — 저장해 둔 사본을 쓰고 있어요`)) return;
    setStatus(`${msg}. 인터넷 연결을 확인하거나, JSON 파일을 내려받아 "JSON 파일 열기"로 불러오세요.`, true);
  } finally {
    $('btnFetch').disabled = false;
  }
}

/** data/set-snapshot.json (매일 GitHub Actions 가 만드는 세트 데이터 사본) 사용. 성공하면 true */
async function loadSnapshot(note = '저장해 둔 세트 데이터') {
  try {
    const snap = await (await fetch('data/set-snapshot.json', { cache: 'no-cache', signal: AbortSignal.timeout(15000) })).json();
    if (snap.adapterVersion !== ADAPTER_VERSION || !snap.data?.champions?.length) return false; // 변환 규칙이 바뀐 직후 등
    const data = snap.data;
    setData(data);
    store.set(CACHE_KEY, JSON.stringify(data));
    const day = (snap.fetchedAt || '').slice(0, 10);
    setStatus(`${note} (${day} 기준) · 챔피언 ${data.champions.length} · 시너지 ${Object.keys(data.traits).length} · 아이템 ${data.items.length} · 상징 ${data.emblems.length} · 새 패치 직후라면 "불러오기"로 최신 데이터를 받으세요.`);
    $('databar').open = false;
    return true;
  } catch { return false; }
}

function useRaw(raw, note) {
  const sets = listSets(raw);
  if (!sets.length) { setStatus('이 파일에서 세트 데이터를 찾지 못했어요.', true); return; }
  state.raw = raw;
  const sel = $('setSelect');
  sel.innerHTML = sets.map(s => `<option value="${esc(s.key)}">${esc(s.name)} (${esc(s.key)})</option>`).join('');
  sel.hidden = sets.length < 2;
  applySet(sets[0].key, note);
}

function applySet(key, note = '') {
  try {
    const data = normalize(state.raw, key);
    setData(data);
    store.set(CACHE_KEY, JSON.stringify(data));
    setStatus(`${note ? note + ' · ' : ''}챔피언 ${data.champions.length} · 시너지 ${Object.keys(data.traits).length} · 아이템 ${data.items.length} · 상징 ${data.emblems.length}`);
    $('databar').open = false;
  } catch (e) {
    setStatus(e.message, true);
  }
}

// 통계 가중치를 현재 세트 데이터에 연결 (세트 번호가 같을 때만)
function applyWeights() {
  const d = state.data, w = state.weights;
  const on = $('useWeights').checked;
  if (!d) return;
  delete d._traitProfile;
  for (const c of d.champions) { c.baseRole ??= c.role; c.role = c.baseRole; delete c.roleFromStats; }
  if (w && on && w.setNumber === d.set.number) {
    // 실제 경기에서 끼는 아이템으로 역할 보정 (예: 탱커 아이템을 주로 들면 탱커)
    const itemRole = new Map(d.items.map(i => [i.id.toLowerCase(), i.role]));
    for (const c of d.champions) {
      const st = w.units?.[c.id.toLowerCase()];
      if (!st?.items || st.games < 15) continue;
      const tally = { AD: 0, AP: 0, TANK: 0 };
      for (const [it, n] of Object.entries(st.items)) {
        const r = itemRole.get(it.toLowerCase());
        if (r in tally) tally[r] += n;
      }
      const total = tally.AD + tally.AP + tally.TANK;
      const [top, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (total >= 10 && n / total >= 0.5) {
        c.role = top;
        c.roleFromStats = `상위권 경기 아이템 기준: 물리 ${Math.round(tally.AD / total * 100)}% · 마법 ${Math.round(tally.AP / total * 100)}% · 탱커 ${Math.round(tally.TANK / total * 100)}%`;
      }
    }
    d.weights = w.traits;
    d.unitStats = w.units || null;
    // 상징 통계를 시너지 기준으로 묶기 (같은 시너지의 상징 아이템이 여러 종류일 수 있음)
    const byItem = {};
    for (const [k, v] of Object.entries(w.emblems || {})) byItem[k.toLowerCase()] = v;
    d.emblemStats = {};
    for (const e of d.emblems) {
      const agg = { total: 0, holders: {} };
      for (const id of e.ids || [e.id]) {
        const st = byItem[id.toLowerCase()];
        if (!st) continue;
        agg.total += st.total;
        for (const [h, n] of Object.entries(st.holders)) agg.holders[h] = (agg.holders[h] || 0) + n;
      }
      if (agg.total) d.emblemStats[e.trait] = agg;
    }
    $('weightLabel').textContent = `통계 가중치 사용 중 · 세트 ${w.setNumber}${w.patch?.current ? ` · ${w.patch.current} 패치` : ''} · ${w.games.toLocaleString()}명 기록 · ${w.generatedAt.slice(0, 10)}`;
  } else {
    delete d.weights; delete d.unitStats; delete d.emblemStats;
    $('weightLabel').textContent = !w ? '통계 가중치 없음 (기본 점수)'
      : w.setNumber !== d.set.number ? `가중치 파일이 세트 ${w.setNumber}용이라 사용 안 함`
      : '통계 가중치 꺼짐';
  }
}

// 아이콘을 Community Dragon 대신 저장소 사본(data/icons)에서 받도록 주소 바꾸기 (snapshot 워크플로가 만듦)
let iconMap = {};
const iconMapReady = fetch('data/icons/map.json', { signal: AbortSignal.timeout(5000) })
  .then(r => (r.ok ? r.json() : {})).then(m => { iconMap = m || {}; }).catch(() => {});
function localizeIcons(data) {
  const fix = o => { if (o?.icon && iconMap[o.icon]) o.icon = iconMap[o.icon]; };
  for (const list of [data.champions, Object.values(data.traits || {}), data.items, data.emblems, data.components, data.artifacts, data.radiants, Object.values(data.itemInfo || {})]) {
    (list || []).forEach(fix);
  }
}

function setData(data) {
  localizeIcons(data);
  state.data = data;
  applyWeights();
  // 이벤트 핸들러가 같은 객체를 참조하므로 새로 만들지 않고 비운다
  state.emblems.length = 0; state.items.length = 0; state.comps.length = 0;
  for (const k in state.desired) delete state.desired[k];
  for (const k in state.emblemDesired) delete state.emblemDesired[k];
  $('setLabel').textContent = `세트 ${data.set.number ?? ''} · ${data.set.name}`;
  $('specialWrap').hidden = !specialIds().length;
  $('specialName').textContent = specialName();
  renderAllPickers();
  $('results').innerHTML = '';
  bdOnData();
  renderMeta(); // 첫 화면(메타 덱 탭)이 비어 보이지 않도록 데이터가 오면 바로 그림
}

// ---------------- 선택 UI ----------------
const traitName = id => state.data?.traits[id]?.name || id;
const roleKo = { AD: '물리', AP: '마법', TANK: '탱커', FIGHTER: '전사', FLEX: '범용' };

function renderAllPickers() {
  renderEmblems(); renderItems();
  renderTraitList('emblemTraitList', state.emblemDesired, '');
}

function renderEmblems() {
  const q = $('emblemFilter').value.trim();
  const list = (state.data?.emblems || []).filter(e => !q || e.name.includes(q) || traitName(e.trait).includes(q));
  $('emblemGrid').innerHTML = list.map(e =>
    `<button class="pick" data-trait="${esc(e.trait)}" data-item="${esc(e.id)}">${img(e.icon)}<span>${esc(e.name)}</span></button>`).join('')
    || '<p class="muted">상징이 없어요</p>';
  const counts = countBy(state.emblems);
  $('emblemPicked').innerHTML = Object.entries(counts).map(([t, n]) =>
    `<span class="chip gold">${esc(traitName(t))} 상징 ×${n}<button data-trait="${esc(t)}" aria-label="빼기">✕</button></span>`).join('');
}

const ITEM_HELP = {
  full: '가지고 있는 완성 아이템을 고르세요. <b>랭커들이 이 아이템을 실제로 준 챔피언</b>, 그 챔피언의 3신기(다음에 만들 아이템), 이 아이템으로 갈 수 있는 메타 덱을 보여줘요.',
  comp: '가지고 있는 <b>재료 아이템</b>을 모두 담으세요(같은 재료는 여러 번). 어떻게 짝지어 만들지 3가지 방법과 각 방법에 맞는 덱을 추천해요.',
};
function renderItems() {
  for (const b of $('itemMode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === state.itemMode);
  $('itemHelp').innerHTML = ITEM_HELP[state.itemMode];
  $('runItems').textContent = state.itemMode === 'comp' ? '조합 & 덱 추천' : '캐리 & 덱 찾기';
  $('craftable').hidden = state.itemMode !== 'comp';
  if (state.itemMode === 'comp') return renderComps();
  const q = $('itemFilter').value.trim();
  const list = (state.data?.items || []).filter(i => !q || i.name.includes(q));
  $('itemGrid').innerHTML = list.map(i =>
    `<button class="pick" data-item="${esc(i.id)}">${img(i.icon)}<span>${esc(i.name)}</span><span class="role">${roleKo[i.role]}</span></button>`).join('');
  const byId = Object.fromEntries((state.data?.items || []).map(i => [i.id, i]));
  const counts = countBy(state.items);
  $('itemPicked').innerHTML = Object.entries(counts).map(([id, n]) =>
    `<span class="chip">${esc(byId[id]?.name)}${n > 1 ? ' ×' + n : ''}<button data-item="${esc(id)}" aria-label="빼기">✕</button></span>`).join('');
}

function renderComps() {
  const comps = state.data?.components || [];
  const q = $('itemFilter').value.trim();
  $('itemGrid').innerHTML = comps.filter(c => !q || c.name.includes(q)).map(c =>
    `<button class="pick" data-item="${esc(c.id)}">${img(c.icon)}<span>${esc(c.name)}</span></button>`).join('')
    || '<p class="muted">이 세트 데이터에는 재료 아이템 정보가 없어요</p>';
  const byId = Object.fromEntries(comps.map(c => [c.id, c]));
  const counts = countBy(state.comps);
  $('itemPicked').innerHTML = Object.entries(counts).map(([id, n]) =>
    `<span class="chip">${esc(byId[id]?.name)}${n > 1 ? ' ×' + n : ''}<button data-item="${esc(id)}" aria-label="빼기">✕</button></span>`).join('');
  // 지금 가진 재료로 바로 만들 수 있는 아이템 (재료 두 개씩)
  const book = recipeBook(state.data || { items: [], emblems: [] });
  const ids = Object.keys(counts), made = new Map();
  ids.forEach((a, i) => ids.slice(i).forEach(b => {
    if (a === b && counts[a] < 2) return;
    const r = book.get(a, b);
    if (r && !made.has(r.id)) made.set(r.id, r);
  }));
  $('craftable').innerHTML = state.comps.length < 2 ? ''
    : made.size ? `<span class="muted small">지금 만들 수 있는 아이템</span>${[...made.values()].map(r => itemLabel(r.id)).join('')}`
    : '<span class="muted small">이 재료들로는 만들 수 있는 아이템이 없어요</span>';
}

/** 재료 조합 추천 카드 위에 붙는 "무엇을 만들지" 줄 */
function craftNote(c) {
  const nm = id => state.data.components.find(x => x.id === id)?.name || id;
  return `<div class="craftNote"><span class="muted small">만들 것</span>${c.made.map(m =>
    `<span class="craftOne">${itemLabel(m.result.id)}<span class="muted small">${esc(m.from.map(nm).join(' + '))}</span></span>`).join('')}`
    + (c.left.length ? `<span class="muted small">남겨 둘 재료: ${esc(c.left.map(nm).join(', '))}</span>` : '') + '</div>';
}

function renderTraitList(elId, target, q) {
  const traits = Object.values(state.data?.traits || {})
    .filter(t => t.breakpoints.some(b => b >= 2))
    .filter(t => !q || t.name.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  $(elId).innerHTML = traits.map(t => `
    <div class="traitRow ${target[t.id] ? 'on' : ''}" title="${esc(t.desc)}">
      <span class="nm">${esc(t.name)}</span>
      ${t.breakpoints.filter(b => b >= 2).map(b =>
        `<button class="bp ${target[t.id] === b ? 'on' : ''}" data-trait="${esc(t.id)}" data-bp="${b}">${b}</button>`).join('')}
    </div>`).join('');
}

// ---------------- 실행 ----------------
function opts() {
  return { size: Number($('size').value), maxCost: Number($('maxCost').value), max5: Number($('max5').value) };
}

const specialIds = () => (state.data?.champions || []).filter(c => c.special).map(c => c.id);
const specialName = () => [...new Set((state.data?.champions || []).filter(c => c.special).map(c => c.base))].join('·');

// 특수 기물(럭스 등) 설정에 따라 탐색: 포함 / 제외 / 둘 다 (결과를 번갈아 섞음)
function runSearch(fn) {
  const base = opts();
  const special = specialIds();
  const mode = $('specialMode').value;
  if (!special.length || mode === 'with') return fn(base);
  if (mode === 'without') return fn({ ...base, exclude: special });
  const withS = fn(base);
  const withoutS = fn({ ...base, exclude: special });
  const out = [], seen = new Set();
  for (let i = 0; i < Math.max(withS.length, withoutS.length); i++) {
    for (const d of [withS[i], withoutS[i]]) {
      const k = d && d.team.map(c => c.id).sort().join('|') + (d.craft ? '#' + d.craft.made.map(m => m.result.id).sort().join(',') : '');
      if (d && !seen.has(k)) { seen.add(k); out.push(d); }
    }
  }
  return out.slice(0, 8);
}

function run(btn, title, fn) {
  if (!state.data) { setStatus('먼저 데이터를 불러와 주세요.', true); $('databar').open = true; return; }
  btn.disabled = true;
  $('results').innerHTML = `<div class="empty">조합을 계산하고 있어요…</div>`;
  setTimeout(() => {           // 로딩 문구가 먼저 그려지도록
    const t0 = performance.now();
    try {
      const decks = runSearch(fn);
      renderResults(title, decks, performance.now() - t0);
    } catch (e) {
      console.error(e);
      $('results').innerHTML = `<div class="empty">계산 중 오류가 났어요: ${esc(e.message)}</div>`;
    } finally { btn.disabled = false; }
  }, 30);
}

function renderResults(title, decks, ms) {
  if (!decks.length) {
    $('results').innerHTML = `<div class="empty">조건에 맞는 덱을 찾지 못했어요. 목표 단계를 낮추거나 레벨을 올려 보세요.</div>`;
    return;
  }
  const byId = new Map(state.data.champions.map(c => [c.id, c]));
  $('results').innerHTML = `
    <div class="resultHead"><h2>${esc(title)}</h2><span class="legend">${(ms / 1000).toFixed(1)}초 · 점선 테두리 = 상징 덕분에 열린 단계</span></div>
    ${decks.map((d, i) => deckCard(d, i, byId)).join('')}`;
}

// 덱 카드의 "배치툴로 보기" 버튼이 참조할 덱 목록
const deckRegistry = [];
function deckCard(d, i, byId) {
  const reg = deckRegistry.push(d) - 1;
  const emb = {};
  for (const a of d.assignment || []) if (a.holder) (emb[a.holder] ||= []).push(a);
  const carryId = d.carry?.id || d.core?.carry;
  const tankId = d.core?.tank;
  const nameOf = id => byId.get(id)?.name;
  const unused = (d.assignment || []).filter(a => !a.holder).length;
  const goal = d.title ? d.title : d.goal?.trait
    ? `${traitName(d.goal.trait)} ${d.goal.bp}${d.goal.emblemOnly ? ' <span class="tag">상징 전용</span>' : ''}`
    : d.carry ? `캐리: ${esc(d.carry.name)}` : '';

  const units = d.team.map(c => {
    const gear = [
      ...(emb[c.id] || []).map(a => `<span class="emb ${a.misfit ? 'misfit' : ''}" title="${esc(a.misfit ? '어울리는 챔피언이 없어 임시로 배정 — ' : '')}${esc(a.why || '')}">${esc(traitName(a.trait))} 상징</span>`),
      ...((d.items?.[c.id]) || []).map(it => `<span>${esc(it.name)}</span>`),
    ].join('');
    const badge = c.id === carryId ? '<span class="badge carry">핵심</span>' : c.id === tankId ? '<span class="badge tank">탱커</span>' : '';
    const added = d.board?.added.includes(c.id);
    const ui = d.unitInfo?.[c.id];
    const extra = ui ? `${ui.star3 >= 0.4 ? `<span class="star3" title="이 덱에서 ${Math.round(ui.star3 * 100)}%가 3성">★★★</span>` : ''}${ui.rate < 0.5 ? `<span class="flex" title="이 덱을 쓴 판 중 ${Math.round(ui.rate * 100)}%에 포함">선택 ${Math.round(ui.rate * 100)}%</span>` : ''}` : '';
    return `<div class="unit ${c.id === carryId ? 'carry' : ''} ${c.id === tankId ? 'tank' : ''} ${ui && ui.rate < 0.5 ? 'flexunit' : ''} ${added ? 'added' : ''}" data-cost="${c.cost}">${badge}${added ? '<span class="addTag">+ 추가</span>' : ''}${extra}
      ${c.icon ? `<img src="${esc(c.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<img alt="">'}
      <span class="nm">${esc(c.name)}</span><span class="cost" title="${esc(c.roleFromStats || '스킬 설명·스탯으로 추정한 역할')}">${c.cost}코 · ${(c.role === 'AD' || c.role === 'AP') && (c.range ?? 4) < 3 ? '근접 ' : ''}${roleKo[c.role]}${c.roleFromStats ? '✓' : ''}${c.slots > 1 ? ` · ${c.slots}칸` : ''}</span>
      ${c.weights ? `<span class="cost" style="color:var(--gold)">${Object.entries(c.weights).map(([t, n]) => `${esc(traitName(t))} ×${n}`).join(', ')}</span>` : ''}
      ${gear ? `<div class="gear">${gear}</div>` : ''}
    </div>`;
  }).join('');

  const traits = d.traits.filter(t => t.tier > 0 || t.count >= 2).map(t => {
    const lvl = t.tier === 0 ? 'off' : t.top === t.breakpoints.at(-1) ? 't3' : t.tier >= 2 ? 't2' : 't1';
    const tip = t.stat ? ` title="실제 경기: 평균 ${t.stat.avgPlace}등 · 순방 ${(t.stat.top4 * 100).toFixed(0)}% · ${t.stat.games}판 · 가중치 ×${t.stat.weight}"` : '';
    return `<span class="tp ${lvl} ${t.emblemOnly ? 'emb' : ''}"${tip}><b>${t.count}</b> ${esc(t.name)}<span class="bps">${t.breakpoints.join('/')}</span>${t.stat ? `<span class="avg">${t.stat.avgPlace}등</span>` : ''}</span>`;
  }).join('');

  return `<article class="deck ${d.desiredMet === false ? 'warn' : ''}">
    <div class="deckTop">
      <span class="rank">#${i + 1}</span>
      <button class="btn ghost toBuilder" data-reg="${reg}" title="이 덱을 배치툴에 자동으로 세우기">배치툴로 보기</button>
      ${goal ? `<span class="goal">${goal}</span>` : ''}
      ${specialIds().length && !d.team.some(c => c.special) ? `<span class="tag soft">${esc(specialName())} 없음</span>` : ''}
      ${carryId && !d.carry ? `<span class="core">핵심 <b>${esc(nameOf(carryId))}</b>${tankId ? ` · 탱커 <b>${esc(nameOf(tankId))}</b>` : ''}</span>` : ''}
      ${d.metaInfo ? `<span class="meta">${d.metaInfo}</span>` : `<span class="meta">점수 ${d.score.toFixed(1)} · 총 ${d.gold}골드${d.usedEmblems ? ` · 상징 ${d.usedEmblems}개 사용` : ''}${d.wastedEmblems ? ` · <span style="color:var(--danger)">상징 ${d.wastedEmblems}개는 단계를 못 올림</span>` : ''}${unused ? ` · <span style="color:var(--danger)">상징 ${unused}개 못 씀</span>` : ''}${d.desiredMet === false ? ' · 목표 미달성' : ''}</span>`}
    </div>
    ${d.craft ? craftNote(d.craft) : ''}
    <div class="units">${units}</div>
    ${d.board?.removed.length ? `<div class="boardDiff">빼는 챔피언: ${d.board.removed.map(id => `<b>${esc(nameOf(id))}</b>`).join(', ')}</div>` : ''}
    ${[carryId, tankId].filter(Boolean).map(id => {
      const c = byId.get(id); const b = c && (d.builds?.[id] || buildsFor(c)[0]);
      return b ? `<div class="deckBuild"><span class="who">${id === carryId ? '핵심' : '탱커'} ${esc(c.name)}</span>${buildRow(b)}</div>` : '';
    }).join('')}
    <div class="traitsOut">${traits}</div>
  </article>`;
}

// ---------------- 이벤트 ----------------
function bind() {
  $('srcUrl').value = store.get(URL_KEY) || DEFAULT_URL;
  $('btnFetch').onclick = () => loadFromUrl($('srcUrl').value.trim());
  $('setSelect').onchange = e => applySet(e.target.value);
  $('fileInput').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { useRaw(JSON.parse(await f.text()), `파일: ${f.name}`); }
    catch { setStatus('JSON 파일을 읽지 못했어요.', true); }
  };
  $('weightInput').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const w = JSON.parse(await f.text());
      if (!w.traits || !w.setNumber) throw new Error();
      state.weights = w; applyWeights(); $('results').innerHTML = '';
    } catch { setStatus('가중치 파일 형식이 아니에요. tools/collect-stats.mjs 로 만든 weights.json 을 열어주세요.', true); }
  };
  $('useWeights').onchange = () => { applyWeights(); $('results').innerHTML = ''; renderBuilds(); renderMeta(); };
  $('buildFilter').oninput = renderBuilds;
  document.addEventListener('click', e => {
    const b = e.target.closest('.toBuilder'); if (!b) return;
    const d = deckRegistry[Number(b.dataset.reg)];
    if (d) bdOpenDeck(d);
  });
  bindItemTips();
  initBuilder({
    getData: () => state.data, esc, traitName, roleKo, buildsFor,
    openTab: name => document.querySelector(`.tab[data-tab="${name}"]`)?.click(),
  });
  $('bdRecommend').onclick = e => runBoard(e.currentTarget);
  $('bdAssign').onclick = () => runAssign();
  $('bdAssignOut').onclick = e => {
    if (!e.target.closest('#bdAssignApply') || !lastAssign) return;
    const r = lastAssign;
    bdApplyItems(r.assignments.map(a => ({ idx: a.idx, itemId: a.item.id })), [...r.unplaced.map(x => x.id), ...r.leftComponents]);
    $('bdAssignOut').innerHTML = '<p class="muted small">보드에 넣었어요. 보관한 아이템은 "남은 아이템" 칸에 남아 있어요.</p>';
    lastAssign = null;
  };
  $('patchSel').onchange = () => renderPatch($('patchSel').value);
  $('metaSort').onchange = renderMeta;
  $('metaMin').onchange = renderMeta;
  $('btnSample').onclick = async () => {
    const raw = window.TFT_SAMPLE || await (await fetch('data/sample-cdragon.json')).json();
    useRaw(raw, '샘플 데이터 (가상 세트, 실제 게임과 다름)');
  };

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== `panel-${t.dataset.tab}`);
    if (t.dataset.tab === 'builds') renderBuilds();
    if (t.dataset.tab === 'meta') renderMeta();
    if (t.dataset.tab === 'patch') renderPatch();
    if (t.dataset.tab === 'builder') bdRender();
    $('results').hidden = ['meta', 'patch', 'builds', 'builder'].includes(t.dataset.tab);
    $('results').innerHTML = '';
  });

  // 상징
  $('emblemFilter').oninput = renderEmblems;
  $('emblemGrid').onclick = e => { const b = e.target.closest('[data-trait]'); if (!b) return; state.emblems.push(b.dataset.trait); renderEmblems(); };
  $('emblemPicked').onclick = e => { const b = e.target.closest('button[data-trait]'); if (!b) return; removeOne(state.emblems, b.dataset.trait); renderEmblems(); };
  $('runEmblem').onclick = e => {
    if (!state.emblems.length) { $('results').innerHTML = '<div class="empty">상징을 하나 이상 골라 주세요.</div>'; return; }
    run(e.currentTarget, '상징 활용 추천 팀', o => emblemTeamMaker(state.data, { ...o, emblems: state.emblems, desired: state.emblemDesired }));
  };

  // 시너지
  const toggleBp = (target, listId, q) => e => {
    const b = e.target.closest('.bp'); if (!b) return;
    const t = b.dataset.trait, bp = Number(b.dataset.bp);
    if (target[t] === bp) delete target[t]; else target[t] = bp;
    renderTraitList(listId, target, q());
  };
  $('emblemTraitList').onclick = toggleBp(state.emblemDesired, 'emblemTraitList', () => '');

  // 아이템
  $('itemFilter').oninput = renderItems;
  const itemList = () => state.itemMode === 'comp' ? state.comps : state.items;
  $('itemMode').onclick = e => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    state.itemMode = b.dataset.mode; $('itemFilter').value = ''; renderItems();
  };
  $('itemGrid').onclick = e => { const b = e.target.closest('[data-item]'); if (!b) return; itemList().push(b.dataset.item); renderItems(); };
  $('itemPicked').onclick = e => { const b = e.target.closest('button[data-item]'); if (!b) return; removeOne(itemList(), b.dataset.item); renderItems(); };
  $('runItems').onclick = e => {
    if (state.itemMode === 'comp') {
      if (state.comps.length < 2) { $('results').innerHTML = '<div class="empty">재료 아이템을 두 개 이상 담아 주세요.</div>'; return; }
      run(e.currentTarget, '재료로 만드는 조합 & 덱', o => craftPlans(state.data, { ...o, components: state.comps }));
      return;
    }
    if (!state.items.length) { $('results').innerHTML = '<div class="empty">아이템을 하나 이상 골라 주세요.</div>'; return; }
    if (state.data?.unitStats) { renderItemStats(e.currentTarget); return; } // 랭커 통계가 있으면 통계 기반 화면
    run(e.currentTarget, '아이템에 맞는 캐리 & 덱', o => decksForItems(state.data, { ...o, itemIds: state.items }));
  };
}

// ---------------- 3신기 ----------------
// 많이 쓰인 조합 중(전체의 5% 또는 5판 이상) 평균 등수가 좋은 순.
// 판수가 적으면 평균(4.5등) 쪽으로 강하게 보정 → 몇 판 우연히 잘 나온 조합이 1등으로 오지 않게
const BUILD_MIN_GAMES = 5;
const BUILD_PRIOR = 15;
function buildsFor(c) {
  const st = state.data?.unitStats?.[c.id.toLowerCase()];
  const list = (st?.builds || []).filter(b => !b.items.some(i => /ThiefsGloves|Tacticians/i.test(i))); // 예전 통계 파일 대비
  if (!list.length) return [];
  const total = list.reduce((s, b) => s + b.games, 0);
  const min = Math.max(BUILD_MIN_GAMES, total * 0.05);
  const shrunk = b => (b.avgPlace * b.games + 4.5 * BUILD_PRIOR) / (b.games + BUILD_PRIOR);
  return list.filter(b => b.games >= min).sort((a, b) => shrunk(a) - shrunk(b)).slice(0, 3);
}
function itemLabel(id) {
  const info = state.data?.itemInfo?.[id.toLowerCase()];
  const name = info?.name || id.replace(/^(DA_|TFT\d*_Item_|TFT_Item_)/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return `<span class="bi" data-item="${esc(id)}">${info?.icon ? `<img src="${esc(info.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${esc(name)}</span>`;
}
function buildRow(b) {
  const low = b.games < 15 ? ' <span class="lowconf" title="판수가 적어 참고용">표본 적음</span>' : '';
  return `<div class="build">${b.items.map(itemLabel).join('')}<span class="bmeta">평균 ${b.avgPlace}등 · ${b.games}판${low}</span></div>`;
}
function renderBuilds() {
  const d = state.data;
  if (!d) { $('buildList').innerHTML = ''; return; }
  if (!d.unitStats) { $('buildList').innerHTML = '<div class="empty">통계 가중치가 없어요. collect-stats.bat 으로 경기 데이터를 모은 뒤 새로고침하면 표시돼요.</div>'; return; }
  const q = $('buildFilter').value.trim();
  const champs = d.champions
    .filter(c => !q || c.name.includes(q) || c.traits.some(t => traitName(t).includes(q)))
    .sort((a, b) => (buildsFor(b).length > 0) - (buildsFor(a).length > 0) || b.cost - a.cost || a.name.localeCompare(b.name, 'ko'));
  $('buildList').innerHTML = champs.map(c => {
    const bs = buildsFor(c);
    return `<div class="bcard">
      <div class="bhead">${c.icon ? `<img src="${esc(c.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
        <div><b>${esc(c.name)}</b><span class="muted"> ${c.cost}코 · ${roleKo[c.role]}</span><div class="muted small">${c.traits.map(traitName).map(esc).join(' · ')}</div></div></div>
      ${bs.length ? bs.map((b, i) => (i ? '<div class="alt">' : '<div class="best">') + buildRow(b) + '</div>').join('') : '<div class="muted small">아이템 3개 조합 기록이 부족해요 (5판 이상인 조합 없음)</div>'}
    </div>`;
  }).join('');
}

// ---------------- 메타 덱 ----------------
// 랭커들의 실제 최종 덱을 "주력 시너지 + 핵심 캐리"로 묶은 통계 (tools/stats-lib.mjs → comps)
function metaTier(avg, games) {
  const shrunk = (avg * games + 4.5 * 10) / (games + 10); // 판수가 적으면 평균 쪽으로 보정
  return shrunk <= 3.7 ? 'S' : shrunk <= 4.0 ? 'A' : shrunk <= 4.3 ? 'B' : 'C';
}
const metaAvailable = () => {
  const d = state.data, w = state.weights;
  return !!(d && w?.comps?.length && w.setNumber === d.set.number && $('useWeights').checked);
};
const metaShrunk = m => (m.avgPlace * m.games + 45) / (m.games + 10); // 판수가 적으면 평균(4.5등) 쪽으로

/** 통계의 메타 덱(comps) → 덱 카드 객체 목록 */
// 같은 덱인데 판마다 주력 시너지가 다르게 잡혀(예: 처형자/소환사) 둘로 나뉜 메타 덱 합치기.
// 같은 핵심 캐리 + 레벨만큼 채운 구성이 완전히 같으면 → 한 덱. 서로 다른 판들이라 판수 가중 평균으로 합쳐도 정확함.
// (한 명만 달라도 합치면 안 됨: 처형자 유나라 2.97등 vs 개화 유나라 4.54등처럼 성적이 크게 다름)
function mergedComps() {
  const d = state.data, w = state.weights;
  const byLower = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
  const teamOf = m => {
    const bases = new Set();
    let slots = 0;
    for (const u of m.core) {
      const c = byLower.get(u.id);
      if (!c || bases.has(c.base || c.id) || slots + (c.slots || 1) > m.level) continue;
      bases.add(c.base || c.id); slots += c.slots || 1;
      if (slots >= m.level) break;
    }
    return bases;
  };
  const groups = [];
  for (const m of [...w.comps].sort((a, b) => b.games - a.games)) {
    const carry = m.mainCarry || m.carry, team = teamOf(m);
    const g = groups.find(x => x.carry === carry && x.team.size === team.size && [...team].every(b => x.team.has(b)));
    if (g) g.list.push(m); else groups.push({ carry, team, list: [m] });
  }
  const avg = (list, f, wf = x => x.games) => {
    const tw = list.reduce((s, x) => s + (f(x) != null ? wf(x) : 0), 0);
    return tw ? list.reduce((s, x) => s + (f(x) != null ? f(x) * wf(x) : 0), 0) / tw : null;
  };
  const side = list => {
    const xs = list.filter(Boolean);
    if (!xs.length) return null;
    const games = xs.reduce((s, x) => s + x.games, 0);
    return { games, avgPlace: Math.round(avg(xs, x => x.avgPlace) * 100) / 100, top4: Math.round(avg(xs, x => x.top4) * 1000) / 1000 };
  };
  return groups.map(({ list }) => {
    if (list.length === 1) return list[0];
    const [main] = list;
    const byPatch = {};
    for (const p of new Set(list.flatMap(m => Object.keys(m.byPatch || {})))) byPatch[p] = side(list.map(m => m.byPatch?.[p]));
    return {
      ...main,
      games: list.reduce((s, m) => s + m.games, 0),
      avgPlace: Math.round(avg(list, m => m.avgPlace) * 100) / 100,
      top4: Math.round(avg(list, m => m.top4) * 1000) / 1000,
      win: Math.round(avg(list, m => m.win) * 1000) / 1000,
      playRate: list.reduce((s, m) => s + (m.playRate || 0), 0),
      patchGames: main.patchGames == null ? undefined : list.reduce((s, m) => s + (m.patchGames || 0), 0),
      now: side(list.map(m => m.now)), before: side(list.map(m => m.before)), byPatch,
      mergedTraits: [...new Set(list.slice(1).map(m => m.trait).filter(t => t !== main.trait))],
    };
  });
}

function metaDecks(minGames) {
  const d = state.data;
  if (!metaAvailable()) return [];
  const byLower = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
  return mergedComps().filter(m => m.games >= minGames).map(m => {
    const carry = byLower.get(m.mainCarry || m.carry);
    if (!carry) return null;
    // 레벨만큼 자리 채우기: 자주 쓰인 순, 같은 챔피언의 다른 형태(럭스 등)는 하나만, 2칸 챔피언 고려
    const info = {}, team = [], bases = new Set();
    let slots = 0;
    for (const u of m.core) {
      const c = byLower.get(u.id);
      if (!c || bases.has(c.base || c.id) || slots + (c.slots || 1) > m.level) continue;
      team.push(c); bases.add(c.base || c.id); slots += c.slots || 1;
      info[c.id] = u;
      if (slots >= m.level) break;
    }
    if (!team.includes(carry)) team.push(carry);
    if (team.length < 4) return null;
    const ev = evaluateTeam(team, d, { carryIds: [carry.id] });
    const tank = m.mainTank ? byLower.get(m.mainTank) : null;
    if (tank && team.includes(tank)) ev.core = { carry: carry.id, tank: tank.id };
    const tier = metaTier(m.avgPlace, m.games);
    // 3성작: 3코스트 이하 챔피언이 그 덱에서 절반 이상 3성으로 완성됨
    const reroll = team.some(c => c.cost <= 3 && (info[c.id]?.star3 || 0) >= 0.5);
    const builds = {};
    for (const [id, b] of Object.entries(m.builds || {})) { const c = byLower.get(id); if (c && b) builds[c.id] = b; }
    return {
      ...ev, team: [...team].sort((a, b) => a.cost - b.cost), m, tier, unitInfo: info, builds,
      title: `<span class="tier t${tier}">${tier}</span> ${esc(traitName(m.trait))} · ${esc(carry.name)}${reroll ? ' <span class="tag reroll">3성작</span>' : ''}${m.mergedTraits?.length ? ` <span class="tag soft" title="같은 구성인데 랭커 경기에서 주력 시너지가 ${esc(m.mergedTraits.map(traitName).join(', '))}(으)로 잡힌 판도 합쳤어요">${esc(m.mergedTraits.map(traitName).join('·'))} 포함</span>` : ''}`,
      metaInfo: `평균 <b>${m.avgPlace}등</b>${patchDelta(m)} · 순방 ${(m.top4 * 100).toFixed(0)}% · 1등 ${(m.win * 100).toFixed(0)}% · 픽률 ${(m.playRate * 100).toFixed(1)}% · ${m.games}판${patchNote(m)} · 레벨 ${m.level}`,
    };
  }).filter(Boolean);
}

// ---- 패치별 메타 (통계에 patch 정보가 있을 때) ----
const curPatch = () => state.weights?.patch?.current;
/** 이전 패치 대비 평균 등수 변화: ▲ 좋아짐 / ▼ 나빠짐 (양쪽 다 8판 이상일 때만) */
function patchDelta(m) {
  if (!m.now || !m.before || m.now.games < 8 || m.before.games < 8) return '';
  const d = m.before.avgPlace - m.now.avgPlace; // +면 등수가 좋아짐
  if (Math.abs(d) < 0.1) return ' <span class="pdelta same" title="이전 패치와 비슷해요">–</span>';
  return ` <span class="pdelta ${d > 0 ? 'up' : 'down'}" title="이전 패치 ${m.before.avgPlace}등 → 이번 패치 ${m.now.avgPlace}등">${d > 0 ? '▲' : '▼'}${Math.abs(d).toFixed(2)}</span>`;
}
function patchNote(m) {
  if (!curPatch() || m.patchGames == null) return '';
  if (m.patchGames === 0) return ' <span class="tag soft" title="이번 패치에서 아직 8판이 안 돼서 이전 패치 기록으로 보여줘요">이전 패치 기록</span>';
  if (m.before?.games && m.patchGames < 30) return ` <span class="tag soft" title="이번 패치 판수가 적어서 이전 패치 성적을 조금(최대 20판어치) 참고했어요">이번 패치 ${m.patchGames}판</span>`;
  return '';
}
function renderPatchInfo() {
  const p = state.weights?.patch, box = $('metaPatch');
  if (!p?.current || !metaAvailable()) { box.hidden = true; return; }
  const cur = p.matches?.[p.current] || 0, prev = p.prev ? p.matches?.[p.prev] || 0 : 0;
  box.hidden = false;
  box.innerHTML = `<b>${esc(p.current)} 패치</b> 기준 · 이번 패치 ${cur.toLocaleString()}경기`
    + (p.prev ? ` · 이전 패치(${esc(p.prev)}) ${prev.toLocaleString()}경기는 ${p.prevWeight > 0 ? '이번 패치 표본이 적어 일부만 반영' : '이번 패치 표본이 충분해 ▲▼ 비교에만 사용'}` : '')
    + ` · <span class="pdelta up">▲</span><span class="pdelta down">▼</span> = 이전 패치 대비 평균 등수 변화`;
}

// ---- 아이템으로 찾기: 랭커 통계 기반 ----
function renderItemStats(btn) {
  const d = state.data, o = opts();
  const carriers = carriesForItems(d, { ...o, exclude: $('specialMode').value === 'without' ? specialIds() : [], itemIds: state.items });
  const byId = new Map(d.champions.map(c => [c.id, c]));
  const chosen = state.items;
  const pct = x => `${Math.round(x * 100)}%`;
  // 1) 랭커가 이 아이템을 준 챔피언
  const carryHtml = carriers.length ? carriers.map((r, i) => `
    <div class="icarry">
      <span class="rank">#${i + 1}</span>
      <div class="icChamp" data-cost="${r.champ.cost}">${img(r.champ.icon)}<div><b>${esc(r.champ.name)}</b><div class="muted small">${r.champ.cost}코 · 평균 ${r.avgPlace}등 · ${r.games.toLocaleString()}판</div></div></div>
      <div class="icRates">${r.rates.map(q => `<span class="icRate" title="${esc(r.champ.name)}가 나온 판 중 ${pct(q.rate)}에서 이 아이템을 꼈고, 랭커 경기의 이 아이템 중 ${pct(q.share)}가 ${esc(r.champ.name)}에게 갔어요">${itemLabel(q.item.id)}<b>${pct(q.rate)}</b><span class="muted small">판</span></span>`).join('')}</div>
      <div class="icBuild">${r.build ? `<span class="muted small">추천 3신기</span>${r.build.items.map(id => `<span class="${chosen.includes(id) ? '' : 'icNext'}">${itemLabel(id)}</span>`).join('')}<span class="bmeta">평균 ${r.build.avgPlace}등 · ${r.build.games}판${r.build.games < 15 ? ' <span class="lowconf">표본 적음</span>' : ''}</span>` : '<span class="muted small">고른 아이템이 들어간 3신기 기록 없음</span>'}</div>
    </div>`).join('') : '<div class="empty">랭커 경기에서 이 아이템을 자주 낀 챔피언이 없어요.</div>';
  // 2) 이 아이템으로 갈 수 있는 메타 덱: 위 챔피언이 핵심 캐리이거나, 핵심 캐리 3신기와 겹치는 덱
  const carrierRank = new Map(carriers.map((r, i) => [r.champ.id.toLowerCase(), i]));
  const metas = metaDecks(8).map(dk => {
    const carryId = dk.m.mainCarry || dk.m.carry;
    const build = dk.m.builds?.[carryId]?.items || [];
    const rest = [...chosen];
    let overlap = 0;
    for (const it of build) { const k = rest.indexOf(it); if (k >= 0) { overlap++; rest.splice(k, 1); } }
    const rank = carrierRank.has(carryId) ? carrierRank.get(carryId) : 99;
    return { ...dk, overlap, rank, metaInfo: `${rank < 99 ? `<b>${rank + 1}위 캐리 덱</b> · ` : ''}${overlap ? `3신기와 아이템 ${overlap}개 일치 · ` : ''}${dk.metaInfo}` };
  }).filter(x => x.rank < 99 || x.overlap > 0)
    .sort((a, b) => (a.rank - b.rank) || (b.overlap - a.overlap) || (metaShrunk(a.m) - metaShrunk(b.m)))
    .filter((x, i, arr) => arr.findIndex(y => y.rank === x.rank && x.rank < 99) === i || x.rank === 99) // 캐리마다 가장 좋은 덱 하나
    .slice(0, 4);
  $('results').innerHTML = `
    <div class="resultHead"><h2>랭커들이 이 아이템을 준 챔피언</h2><span class="legend">${esc(curPatch() ? curPatch() + ' 패치 · ' : '')}랭커 경기 기준 · "판" = 그 챔피언이 나온 판 중 이 아이템을 낀 비율 · 노란 테두리 = 다음에 만들 아이템</span></div>
    <div class="icList">${carryHtml}</div>
    <div class="resultHead"><h2>이 아이템으로 가는 메타 덱</h2></div>
    ${metas.length ? metas.map((dk, i) => deckCard(dk, i, byId)).join('') : '<div class="empty">이 아이템을 쓰는 메타 덱이 없어요 (최소 8판).</div>'}`;
  btn?.blur();
}

// ---- 패치 노트 탭 ----
// data/patches.json : 패치 일정 + 변경 목록 (수집기도 같은 파일로 경기의 패치를 정함)
let patchDoc = null;
const patchDocReady = fetch('data/patches.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) })
  .then(r => (r.ok ? r.json() : null)).then(j => { patchDoc = j; }).catch(() => {});
const DIR_KO = { buff: ['▲', '버프', 'up'], nerf: ['▼', '너프', 'down'], adjust: ['◆', '조정', 'same'] };
const WHERE_KO = { carry: '핵심 캐리', tank: '메인 탱커', core: '구성원', flex: '가끔 쓰는', trait: '주력 시너지' };

function renderPatch(selected) {
  const box = $('patchView'), sel = $('patchSel');
  if (!patchDoc?.patches) { box.innerHTML = '<div class="empty">패치 정보(data/patches.json)를 불러오지 못했어요.</div>'; return; }
  const list = patchDoc.patches.filter(p => p.summary || p.changes);
  if (!list.length) { box.innerHTML = '<div class="empty">등록된 패치 노트가 없어요.</div>'; return; }
  const latest = [...list].reverse();
  if (!sel.options.length) sel.innerHTML = latest.map(p => `<option value="${esc(p.patch)}">${esc(p.patch)} (${esc(p.date)})</option>`).join('');
  // 기본: 변경 목록이 있는 가장 최근 패치 (사용자가 고른 게 있으면 그것)
  if (selected) sel.dataset.chosen = selected;
  const name = sel.dataset.chosen || (latest.find(x => x.changes?.length) || latest[0]).patch;
  sel.value = name;
  const p = list.find(x => x.patch === name);
  const prev = prevBalancePatch(patchDoc.patches, name);
  const d = state.data, byLower = new Map((d?.champions || []).map(c => [c.id.toLowerCase(), c]));
  const champsOf = m => (d?.champions || []).filter(c => c.id.toLowerCase().includes(String(m).toLowerCase()));
  const traitOf = m => Object.entries(d?.traits || {}).find(([k]) => k.toLowerCase() === String(m).toLowerCase());

  // 1) 바뀐 것
  const groups = { champion: '챔피언', trait: '시너지', item: '아이템', augment: '증강', wisp: '수호령' };
  const changeHtml = Object.entries(groups).map(([kind, label]) => {
    const items = (p.changes || []).filter(c => c.kind === kind);
    if (!items.length) return '';
    return `<div class="pnGroup"><h4>${label}</h4>${items.map(c => {
      const [arrow, word, cls] = DIR_KO[c.dir] || DIR_KO.adjust;
      let icon = '', nm = c.name || c.match;
      if (kind === 'champion') { const ch = champsOf(c.match)[0]; if (ch) { icon = img(ch.icon); nm = ch.name; } }
      if (kind === 'trait') { const t = traitOf(c.match); if (t) { icon = img(t[1].icon); nm = t[1].name; } }
      return `<div class="pnChange"><span class="pnIcon">${icon}</span><b>${esc(nm)}</b> <span class="pdelta ${cls}">${arrow} ${word}</span> <span class="muted small">${c.note && c.note !== word ? esc(c.note) : ''}</span></div>`;
    }).join('')}</div>`;
  }).join('');

  // 2) 메타 덱 영향 예측 vs 실측
  const comps = metaAvailable() ? state.weights.comps : [];
  const rep = p.changes?.length && prev ? patchReport(comps, p, prev) : null;
  const hasByPatch = comps.some(c => c.byPatch);
  let predHtml = '';
  if (!p.changes?.length) predHtml = '<div class="empty">이 패치는 변경 내용이 등록되지 않았어요.</div>';
  else if (!comps.length) predHtml = '<div class="empty">메타 덱 통계가 없어서 영향 예측을 할 수 없어요.</div>';
  else if (!hasByPatch) predHtml = '<div class="empty">통계 파일에 패치별 기록이 아직 없어요. 다음 수집 후 표시돼요.</div>';
  else if (!rep.rows.length) predHtml = '<div class="empty">바뀐 챔피언·시너지를 쓰는 메타 덱이 없어요.</div>';
  else {
    const fmt = (s, avg) => s ? `<span class="tier t${metaTier(avg ?? s.avgPlace, s.games)}">${metaTier(avg ?? s.avgPlace, s.games)}</span> ${(avg ?? s.avgPlace).toFixed(2)}등` : '<span class="muted">—</span>';
    const verdict = { hit: '<span class="pnVerdict hit">✓ 예측 적중</span>', miss: '<span class="pnVerdict miss">✗ 빗나감</span>', flat: '<span class="pnVerdict flat">– 구분 어려움</span>' };
    // 비교할 수 있는 덱(이전 패치 표본 있음) 먼저, 그중 실측 판정이 난 덱 먼저
    const rank = r => (r.verdict === 'hit' || r.verdict === 'miss' ? 0 : r.verdict ? 1 : r.base ? 2 : 3);
    const rows = rep.rows.filter(r => r.base || r.now).sort((a, b) => rank(a) - rank(b) || Math.abs(b.rel) - Math.abs(a.rel)).slice(0, 20).map(r => {
      const c = r.comp, carry = byLower.get(c.mainCarry || c.carry);
      const why = r.hits.map(h => {
        const nm = h.where === 'trait' ? traitName(c.trait) : byLower.get(h.id)?.name || h.id;
        const [arrow, , cls] = DIR_KO[h.change.dir];
        return `<span class="pnWhy">${WHERE_KO[h.where]} ${esc(nm)} <span class="pdelta ${cls}">${arrow}</span></span>`;
      }).join('');
      const dir = r.predDelta < -0.05 ? '<span class="pdelta up">▲ 오를 것</span>' : r.predDelta > 0.05 ? '<span class="pdelta down">▼ 내릴 것</span>' : '<span class="pdelta same">– 비슷</span>';
      return `<tr><td><b>${esc(traitName(c.trait))}</b> · ${esc(carry?.name || '')}<div class="pnWhys">${why}</div></td>
        <td>${fmt(r.base)}<div class="muted small">${r.base ? r.base.games + '판' : '이전 패치 표본 부족'}</div></td>
        <td>${r.base ? fmt({ ...r.base }, r.predAvg) : '—'}<div>${dir}</div></td>
        <td>${fmt(r.now)}<div class="muted small">${r.now ? r.now.games + '판' : '이번 패치 표본 부족'}</div></td>
        <td>${r.verdict ? `<span title="실제 변화 ${r.actualDelta > 0 ? '+' : ''}${r.actualDelta}등, 판수로 인한 오차 ±${r.noise}등">${verdict[r.verdict]}</span><div class="muted small">${r.actualDelta > 0 ? '+' : ''}${r.actualDelta}등 (±${r.noise})</div>` : `<span class="muted small">${r.base ? '이번 패치 판 쌓이는 중' : '비교 불가'}</span>`}</td></tr>`;
    }).join('');
    predHtml = `<p class="muted small">이전 패치(${esc(prev)}) 성적에서 출발해, 바뀐 챔피언이 핵심 캐리면 크게·탱커면 중간·구성원이면 작게, 주력 시너지 변경도 반영해 평균 등수 변화를 예측해요. 평균 등수는 8명이 나눠 갖는 값이라, 메타 전체가 받은 평균 영향보다 <b>더</b> 받은 만큼만 오르내린다고 봐요.${rep.judged ? ` 실제 변화가 판수 오차보다 큰 덱 중 <b>${rep.hits}/${rep.judged}</b>개에서 예측 방향이 맞았어요 (나머지 ${rep.flat}개는 판수가 적거나 변화가 작아 구분 어려움).` : ''}</p>
      <div class="tableWrap"><table class="pnTable"><thead><tr><th>메타 덱 · 영향 원인</th><th>${esc(prev)} 실제</th><th>${esc(p.patch)} 예측</th><th>${esc(p.patch)} 실제</th><th>결과</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  box.innerHTML = `<div class="pnHead"><h3>${esc(p.patch)} 패치</h3><span class="muted small">${esc(p.date)} (태평양 시간) · 한국 서버는 보통 다음 날 아침 적용${p.source ? ` · <a href="${esc(p.source)}" target="_blank" rel="noopener">공식 패치노트</a>` : ''}</span></div>
    ${p.summary ? `<p class="pnSummary">${esc(p.summary)}</p>` : ''}
    ${changeHtml ? `<div class="pnChanges">${changeHtml}</div>` : ''}
    <h3 class="recSub">메타 덱 영향 예측</h3>${predHtml}`;
}

function renderMeta() {
  renderPatchInfo();
  const d = state.data, w = state.weights;
  const box = $('metaList');
  if (!d) { box.innerHTML = ''; return; }
  if (!metaAvailable()) {
    box.innerHTML = '<div class="empty">메타 덱 통계가 없어요. collect-stats.bat 으로 경기 데이터를 모은 뒤 새로고침하면 표시돼요.</div>';
    return;
  }
  const byId = new Map(d.champions.map(c => [c.id, c]));
  const sortKey = $('metaSort').value;
  const list = metaDecks(Number($('metaMin').value));
  const sorters = {
    avg: (a, b) => metaShrunk(a.m) - metaShrunk(b.m),
    pick: (a, b) => b.m.playRate - a.m.playRate,
    win: (a, b) => b.m.win - a.m.win,
  };
  list.sort(sorters[sortKey]);
  box.innerHTML = list.length
    ? `<p class="legend">${w.games.toLocaleString()}명 기록 기준 · 자주 쓰인 순으로 레벨만큼 채움 · "선택 %" = 판마다 바뀌는 자리 · ★★★ = 3성 완성 비율 높음 · 핵심/탱커 = 랭커들이 딜템/탱템을 가장 많이 준 챔피언</p>` + list.slice(0, 30).map((x, i) => deckCard(x, i, byId)).join('')
    : '<div class="empty">조건에 맞는 메타 덱이 없어요. 최소 판수를 낮춰 보세요.</div>';
}

// ---------------- 내 보드 → 다음 수 추천 (배치툴) ----------------
/** 내 보드와 챔피언이 많이 겹치는 메타 덱 (같은 챔피언의 다른 형태도 겹침으로 셈) */
function metaNearBoard(board, carryId) {
  const byId = new Map(state.data.champions.map(c => [c.id, c]));
  const mine = board.map(u => byId.get(u.id)).filter(Boolean);
  const bases = new Set(mine.map(c => c.base || c.id));
  const need = Math.max(2, Math.ceil(mine.length / 2));
  return metaDecks(8).map(d => {
    const overlap = d.team.filter(c => bases.has(c.base || c.id)).length;
    const carryMatch = carryId && d.core?.carry === carryId;
    const ids = new Set(d.team.map(c => c.id));
    return {
      ...d, overlap, rank: overlap + (carryMatch ? 1.5 : 0) - metaShrunk(d.m) * 0.3,
      board: { added: d.team.filter(c => !bases.has(c.base || c.id)).map(c => c.id), removed: mine.filter(c => !ids.has(c.id)).map(c => c.id) },
      metaInfo: `<b>내 보드와 ${overlap}명 겹침</b>${carryMatch ? ' · 같은 핵심 캐리' : ''} · ${d.metaInfo}`,
    };
  }).filter(d => d.overlap >= need).sort((a, b) => b.rank - a.rank)
    // 보드에 적용했을 때 결과 구성이 같은 덱은 하나만 (예: 처형자·소라카 / 소환사·소라카 → 둘 다 같은 8명)
    .filter((d, i, arr) => arr.findIndex(x => x.team.map(c => c.base || c.id).sort().join() === d.team.map(c => c.base || c.id).sort().join()) === i)
    .slice(0, 3);
}

function runBoard(btn) {
  const box = $('bdRecs');
  if (!state.data) { setStatus('먼저 데이터를 불러와 주세요.', true); $('databar').open = true; return; }
  const board = bdBoardUnits();
  if (!board.length) { box.innerHTML = '<div class="empty">보드에 챔피언을 먼저 올려 주세요.</div>'; return; }
  btn.disabled = true;
  box.innerHTML = '<div class="empty">내 보드에서 이어갈 덱을 계산하고 있어요…</div>';
  setTimeout(() => {
    const t0 = performance.now();
    try {
      const size = Number($('bdRecSize').value), keepAll = !$('bdRecFlex').checked;
      let res = null;
      const decks = runSearch(o => { res = decksFromBoard(state.data, { ...o, board, size, keepAll }); return res.decks; });
      const { info } = res;
      const byId = new Map(state.data.champions.map(c => [c.id, c]));
      const near = metaNearBoard(board, info.carry?.id);
      for (const d of decks) {
        const names = d.board.added.map(id => byId.get(id)?.name).filter(Boolean);
        d.title = `레벨 ${res.size} · <b>+ ${esc(names.join(', '))}</b>`;
      }
      const head = `<div class="resultHead"><h2>다음 수 추천</h2><span class="legend">${((performance.now() - t0) / 1000).toFixed(1)}초 · 지금 ${board.length}명`
        + `${info.carry ? ` · 핵심 캐리 <b>${esc(info.carry.name)}</b>` : ''}`
        + `${info.emblems.length ? ` · 상징 ${info.emblems.map(traitName).map(esc).join(', ')}` : ''}`
        + ` · 점선 = 새로 넣을 챔피언</span></div>`;
      const metaHtml = near.length
        ? `<h3 class="recSub">내 보드와 가까운 메타 덱</h3>${near.map((d, i) => deckCard(d, i, byId)).join('')}`
        : metaAvailable() ? '<p class="muted small">내 보드와 절반 이상 겹치는 메타 덱이 없어요.</p>' : '';
      const searchHtml = decks.length
        ? `<h3 class="recSub">보드를 이어서 완성하는 덱</h3>${decks.map((d, i) => deckCard(d, i, byId)).join('')}`
        : `<div class="empty">${keepAll && info.slots >= 10 ? '보드가 이미 꽉 찼어요 (최대 10레벨).' : '이어갈 덱을 찾지 못했어요. 목표 레벨을 바꾸거나 "바꿔도 돼요"를 켜 보세요.'}</div>`;
      box.innerHTML = head + metaHtml + searchHtml;
    } catch (e) {
      console.error(e);
      box.innerHTML = `<div class="empty">계산 중 오류가 났어요: ${esc(e.message)}</div>`;
    } finally { btn.disabled = false; }
  }, 30);
}

// ---------------- 내 보드 + 남은 아이템 → 자동 배분 (배치툴) ----------------
let lastAssign = null;
function runAssign() {
  const box = $('bdAssignOut');
  if (!state.data) { setStatus('먼저 데이터를 불러와 주세요.', true); $('databar').open = true; return; }
  const board = bdBoardUnits(), inventory = bdInventory();
  if (!board.length) { box.innerHTML = '<div class="empty">보드에 지금 덱을 먼저 올려 주세요.</div>'; return; }
  if (!inventory.length) { box.innerHTML = '<div class="empty">"오른쪽 아이템을 누르면 여기에 담기"를 체크하고 남은 아이템을 담아 주세요.</div>'; return; }
  const carrySel = $('bdAssignCarry').value;
  const carryIdx = carrySel === '' ? null : Number(carrySel);
  const r = assignItems(state.data, { board, inventory, carryIdx });
  lastAssign = r;
  const compName = id => state.data.components.find(c => c.id === id)?.name || id;
  // 챔피언별로 묶어서
  const groups = [];
  for (const a of r.assignments) {
    let g = groups.find(x => x.idx === a.idx);
    if (!g) groups.push(g = { idx: a.idx, champ: a.champ, list: [] });
    g.list.push(a);
  }
  const why = a => a.emblem
    ? `${esc(traitName(a.emblem.trait))} ${a.emblem.from} → ${a.emblem.to}${a.emblem.reaches ? ' <b class="good">단계 달성</b>' : ''}`
    : a.rate != null ? `랭커 ${Math.round(a.rate * 100)}%가 이 챔피언에게` : '역할 기준';
  const rows = groups.map(g => `<div class="asgRow"><div class="asgChamp" data-cost="${g.champ.cost}">${img(g.champ.icon)}<div><b>${esc(g.champ.name)}</b>${r.buildMatch?.[g.idx] ? `<div class="small good" title="최종 아이템 3개가 랭커들이 실제로 쓴 조합과 같아요">랭커 3신기 · ${r.buildMatch[g.idx].games}판 ${r.buildMatch[g.idx].avgPlace}등</div>` : ''}</div></div>
    <div class="asgItems">${g.list.map(a => `<div class="asgItem">${itemLabel(a.item.id)}${a.from ? `<span class="muted small">${esc(a.from.map(compName).join(' + '))} 조합</span>` : ''}<span class="small">${why(a)}</span></div>`).join('')}</div></div>`).join('');
  const kept = [
    ...r.unplaced.map(x => `${itemLabel(x.id)}<span class="muted small">${x.why === 'nofit' ? (x.kind === 'emblem' ? '시너지가 없는 챔피언이 없음' : '어울리는 챔피언 없음') : '넣을 칸 없음'}</span>`),
    ...r.leftComponents.map(id => `${itemLabel(id)}<span class="muted small">짝이 없는 재료</span>`),
  ];
  box.innerHTML = `
    <div class="resultHead"><h3>아이템 배분 추천</h3><span class="legend">${curPatch() ? esc(curPatch()) + ' 패치 · ' : ''}랭커 경기에서 그 챔피언이 그 아이템을 낀 비율 기준 · ${carryIdx != null ? `<b>${esc(board.find(b => b.idx === carryIdx) ? state.data.champions.find(c => c.id === board.find(b => b.idx === carryIdx).id)?.name : '')}</b>에게 몰아줌` : '이미 아이템을 든 챔피언에게 몰아줌'} · 적응가는 물리/마법 아이템을 섞지 않음</span></div>
    ${rows || '<div class="empty">줄 수 있는 아이템이 없어요.</div>'}
    ${kept.length ? `<div class="asgKeep"><b>보관</b>${kept.map(k => `<span class="asgItem">${k}</span>`).join('')}</div>` : ''}
    ${r.assignments.length ? '<button class="btn primary" id="bdAssignApply">보드에 적용</button>' : ''}`;
}

// ---------------- 아이템 조합식 툴팁 ----------------
// data-item="아이템id" 가 붙은 요소에 마우스를 올리면 이름 + 조합 재료를 보여줌
function itemMeta(id) {
  const d = state.data, k = String(id).toLowerCase();
  const pool = [...d.items, ...d.emblems, ...(d.artifacts || []), ...(d.radiants || [])];
  const found = pool.find(x => x.id.toLowerCase() === k);
  const info = d.itemInfo?.[k] || found || { name: id };
  const kind = d.emblems.some(e => e.id.toLowerCase() === k) ? 'emblem'
    : (d.artifacts || []).some(a => a.id.toLowerCase() === k) || /_Artifact_/i.test(id) ? 'artifact'
    : /Radiant$/i.test(id) ? 'radiant' : 'item';
  return { name: info.name, icon: info.icon, kind, recipe: d.recipes?.[k] };
}
function itemTipHtml(id) {
  const m = itemMeta(id);
  const part = pid => { const p = itemMeta(pid); return `<span class="tipPart">${p.icon ? `<img src="${esc(p.icon)}" alt="">` : ''}${esc(p.name)}</span>`; };
  const how = m.recipe ? `<div class="tipRecipe">${part(m.recipe[0])}<b>+</b>${part(m.recipe[1])}</div>`
    : m.kind === 'emblem' ? '<div class="tipNote">조합으로 만들 수 없어요 (증강·보상으로만 획득)</div>'
    : m.kind === 'artifact' ? '<div class="tipNote">유물 — 조합 불가 (보상으로 획득)</div>'
    : m.kind === 'radiant' ? '<div class="tipNote">찬란한 아이템 — 일반 아이템을 강화해서 획득</div>'
    : '<div class="tipNote">조합 재료 아이템이거나 조합식 정보가 없어요</div>';
  return `<div class="tipHead">${m.icon ? `<img src="${esc(m.icon)}" alt="">` : ''}<b>${esc(m.name)}</b></div>${how}`;
}
function bindItemTips() {
  const tip = document.createElement('div');
  tip.id = 'itemTip'; tip.hidden = true;
  document.body.appendChild(tip);
  let cur = null;
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-item]');
    if (!el || !state.data) { tip.hidden = true; cur = null; return; }
    if (el !== cur) { cur = el; tip.innerHTML = itemTipHtml(el.dataset.item); }
    tip.hidden = false;
  });
  document.addEventListener('mousemove', e => {
    if (tip.hidden) return;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px';
    tip.style.top = (e.clientY + 16 + h > innerHeight ? e.clientY - h - 10 : e.clientY + 16) + 'px';
  });
  document.addEventListener('dragstart', () => { tip.hidden = true; });
}

// ---------------- 유틸 ----------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function img(src) { return src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''; }
function countBy(arr) { return arr.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {}); }
function removeOne(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }

// ---------------- 시작 ----------------
bind();
if (window.TFT_WEIGHTS) state.weights = window.TFT_WEIGHTS; // data/weights.js 가 있으면 자동 사용
const cached = store.get(CACHE_KEY);
iconMapReady.then(start);
function start() {
if (cached) {
  try {
    setData(JSON.parse(cached));
    setStatus('지난번에 불러온 데이터를 쓰고 있어요. 새 패치가 나오면 "불러오기"를 다시 누르세요.');
    $('databar').open = false;
  } catch { /* 캐시 손상 시 무시 */ }
} else {
  // 처음 방문: 큰 원본(수십 MB) 대신 저장소의 사본(수백 KB)으로 빠르게 시작, 사본이 없으면 원본
  setStatus('데이터를 받는 중이에요…');
  loadSnapshot().then(ok => { if (!ok) loadFromUrl($('srcUrl').value); });
}
}


})();
