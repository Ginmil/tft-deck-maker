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
export const ADAPTER_VERSION = 10;

export const DEFAULT_URL = 'https://raw.communitydragon.org/latest/cdragon/tft/ko_kr.json';
const ASSET_BASE = 'https://raw.communitydragon.org/latest/game/';

export async function fetchRaw(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`데이터를 받지 못했어요 (HTTP ${res.status})`);
  return res.json();
}

/** 원본 JSON 안에 들어 있는 세트 목록 (최신 세트가 맨 앞) */
export function listSets(raw) {
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

export function iconUrl(path) {
  if (!path) return null;
  return ASSET_BASE + path.toLowerCase().replace(/\.(tex|dds)$/, '.png');
}

/** 원본 JSON → 공통 형식 */
export function normalize(raw, setKey) {
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
  const componentIds = [...new Set([...items, ...emblems].flatMap(i => i.recipe || []))].filter(id => rawById.get(id)?.name);
  const order = id => { const k = COMPONENT_ORDER.findIndex(n => id.includes(n)); return k < 0 ? 99 : k; };
  const components = componentIds.sort((a, b) => order(a) - order(b) || a.localeCompare(b))
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
