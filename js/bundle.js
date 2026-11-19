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
//   traits:    { [traitId]: { id, name, breakpoints:[2,4,6], desc, icon } },
//   champions: [ { id, name, cost, traits:[traitId], role, icon } ],
//   items:     [ { id, name, role, icon } ],          // 완성 아이템
//   emblems:   [ { id, name, trait, icon } ]          // 상징
// }
// role: 'AD' | 'AP' | 'TANK' | 'FIGHTER' | 'FLEX'
// =============================================================

// 변환 규칙을 바꾸면 이 숫자를 올리세요. 브라우저에 저장된 예전 변환 결과를 자동으로 버리고 새로 받습니다.
/** 스킬 설명 정리: {Augment...} 같은 내부 표식 제거, 줄바꿈 정리 */
function cleanAbility(s) {
  return String(s || '').replace(/\{[^}]*\}/g, '').replace(/\\r|\r/g, '').replace(/\\n|\n/g, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
const ADAPTER_VERSION = 15; // 12: 시너지 아이콘, 13: 챔피언 스킬·기본 능력치(툴팁), 14: 시너지 단계별 수치(descFilled, 15: 대소문자·아이콘 묶음)

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
    traits[t.apiName] = { id: t.apiName, name: t.name, breakpoints: bps, desc: stripTags(t.desc), descFilled: fillTraitDesc(t), icon: t.icon ? iconUrl(t.icon) : null };
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
      // 툴팁용: 스킬 이름·설명(수치 변수 @X@ 는 그대로 — Set 18 은 데이터에 수치가 없음), 기본 능력치
      ability: c.ability ? { name: c.ability.name || '', desc: cleanAbility(c.ability.desc) } : null,
      stats: c.stats ? { hp: c.stats.hp, ad: c.stats.damage, armor: c.stats.armor, mr: c.stats.magicResist, as: Math.round((c.stats.attackSpeed || 0) * 100) / 100, mana: c.stats.mana, startMana: c.stats.initialMana } : null,
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

// 시너지 설명의 @변수@ 를 단계별 실제 수치로 (11/17: Set 18 도 시너지 effects.variables 에는 값이 있음).
// 변수 이름이 해시({641254b6})로만 남은 경우가 있어 Community Dragon 방식(소문자 FNV-1a 32비트)으로 맞춤.
// <row> 는 단계 순서대로 effects[i], 바깥 문장은 effects[0]. 못 찾으면 '?'. 줄은 '\n' 으로 구분.
const fnv1a = s => { let h = 0x811c9dc5; for (const ch of s.toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const STAT_ICON = { scalead: '공격력', scaleap: '주문력', scaleadap: '공격력·주문력', scalehealth: '체력', scalearmor: '방어력', scalemr: '마법 저항력', scaleas: '공격 속도', scalemana: '마나', scaledamageamp: '피해 증폭', scaledr: '피해 감소', scalesv: '모든 피해 흡혈' };
function fillTraitDesc(t) {
  const effects = (t.effects || []).filter(e => e.minUnits > 0 && e.minUnits < 30);
  if (!t.desc || !effects.length) return null;
  const num = v => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : String(r); };
  const fill = (text, e) => text.replace(/@([^@]+)@/g, (_, tok) => {
    const m = tok.trim().match(/^([A-Za-z0-9_]+)(?:\s*\*\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return '?';
    const vars = e?.variables || {};
    // 이름 → 대소문자 무시(설명 ASPerAttack / 수치 ASperAttack) → 해시
    const ci = Object.keys(vars).find(k => k.toLowerCase() === m[1].toLowerCase());
    let v = /^minunits$/i.test(m[1]) ? e?.minUnits : ci != null ? vars[ci] : vars[`{${fnv1a(m[1])}}`];
    if (typeof v !== 'number') return '?';
    if (m[2]) v *= Number(m[2]);
    return num(v);
  });
  let i = 0;
  const raw = String(t.desc)
    .replace(/<row>([\s\S]*?)<\/row>/gi, (_, row) => `\n${fill(row, effects[Math.min(i++, effects.length - 1)])}\n`);
  const out = fill(raw, effects[0])
    .replace(/(?:%i:[A-Za-z]+%)+/g, g => [...g.matchAll(/%i:([A-Za-z]+)%/g)].map(([, k]) => STAT_ICON[k.toLowerCase()]).filter(Boolean).join('·'))
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return out.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
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
  // bonus: 챔피언·상징으로 설명 안 되는 시너지 인원 (랭커 실제 보드에서 증강 등으로 얻은 것, { 시너지: +N })
  const { emblems = [], desired = {}, carryIds = [], partial = false, size = team.length, bonus = {} } = opts;
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
  for (const [t, k] of Object.entries(bonus)) if (k > 0) counts[t] = (counts[t] || 0) + k;
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
      bonus: bonus[id] || 0,
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
// 시너지 켜짐/꺼짐에 따른 아이템 몫 보정: 전체 몫 대비 그 상황의 몫 (여러 시너지면 가장 크게 달라지는 것 하나)
// 집계 traitItems[t].items[아이템] = [켜진 판 몫, 안 켜진 판 몫]
function traitItemRatio(u, itemId, traitsOn) {
  if (!traitsOn || !u?.traitItems) return 1;
  const all = Object.values(u.items || {}).reduce((a, b) => a + b, 0);
  const base = all ? (u.items[itemId] || 0) / all : 0;
  if (!base) return 1;
  let best = 1;
  for (const [t, ti] of Object.entries(u.traitItems)) {
    const sh = ti.items?.[itemId];
    if (!sh) continue;
    const ratio = Math.max(0.2, Math.min(2.5, (traitsOn.includes(t) ? sh[0] : sh[1]) / base));
    if (Math.abs(Math.log(ratio)) > Math.abs(Math.log(best))) best = ratio;
  }
  return best;
}
function itemAffinity(data, champ, item, traitsOn = null) {
  // 적응가 형태를 사용자가 정했으면(배치툴) 반대 형태 아이템은 0 — 경기 데이터는 형태를 구분 못 해서 통계엔 둘 다 섞여 있음
  if (champ.form) {
    const role = item.role || data.items.find(i => i.id === item.id)?.role;
    if (role === (champ.form === 'AD' ? 'AP' : 'AD')) return 0;
  }
  const u = unitStatOf(data, champ);
  if (!u) return itemFit(champ, item) * (data.unitStats ? 0.3 : 1);
  // 낀 판 비율 × 3 (33% 이상이면 1) — 다만 77%(밤끝)와 59%(수은)가 똑같이 1이 되지 않게 비율을 조금 더함 (11/17)
  let r = (u.items?.[item.id] || 0) / u.games;
  // 내 시너지가 켜졌는지에 따라 랭커가 끼는 아이템이 달라지면 그 비율로 (처형자 켜짐 → 무한의 대검 덜 낌, 11/18)
  // traitsOn = 이 챔피언에게 적용되는 켜진 시너지 목록 (모르면 null → 섞인 전체 비율)
  r *= traitItemRatio(u, item.id, traitsOn);
  return Math.min(1, r * 3) * 0.85 + Math.min(1, r) * 0.15;
}

// ---- 적응가(공격력·주문력 중 높은 쪽을 쓰는 챔피언: 니달리·심술두꺼비·아칼리·코그모·마스터 이) ----
function adaptorChamp(data, c) {
  return !!c && c.traits.some(t => /Adaptor/i.test(t) || /공격력과 주문력 중 어느 쪽이 높은지/.test(data.traits[t]?.desc || ''));
}
/**
 * 배치툴에서 적응가 형태(AD/AP)를 정한 챔피언을 반영한 데이터.
 * board: [{ id, form }] → 그 챔피언의 역할을 형태로 바꾸고 form 표시 (itemAffinity 가 반대 형태 아이템을 0으로)
 */
function withForms(data, board) {
  const forms = {};
  for (const b of board || []) if (b.form === 'AD' || b.form === 'AP') forms[b.id] = b.form;
  if (!Object.keys(forms).length) return data;
  return { ...data, champions: data.champions.map(c => (forms[c.id] && adaptorChamp(data, c) ? { ...c, role: forms[c.id], form: forms[c.id] } : c)) };
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
      if (r === 'AD' || r === 'AP' || (r === 'FLEX' && !/Thief|Tactician|Crownguard/i.test(it))) dmg++; // FLEX(구인수 등 공용 딜템)도 딜템 (11/20: 드레이븐 구인수가 안 세져 이즈리얼이 캐리로 잡힘)
      if (r === 'TANK') tank++;
    }
    units.push({ champ, star: u.star || 2, items: u.items || [], dmg, tank, real });
  }
  // 핵심 캐리: 딜 아이템 수 × 랭커 기록상 아이템을 몰아 받는 챔피언인지(carryRate, 30판 이상) → 아이템 수 → 별 → 코스트
  // (11/20 사용자: 드레이븐·케넨 둘 다 딜템 3개인 보드에서 케넨이 캐리로 잡힘 — 케넨은 3개 든 판 14%, 드레이븐 71%)
  const holdW = c => {
    const st = data.unitStats?.[c.id.toLowerCase()];
    return st && st.games >= 30 && st.carryRate != null ? Math.max(0.3, Math.min(1.4, 0.3 + st.carryRate * 1.5)) : 1;
  };
  const carry = [...units].filter(u => u.dmg > 0 || (u.real > 0 && u.tank === 0))
    .sort((a, b) => b.dmg * holdW(b.champ) - a.dmg * holdW(a.champ) || b.real - a.real || b.star - a.star || b.champ.cost - a.champ.cost)[0]?.champ || null;
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
function assignItems(data, { board, inventory, carryIdx = null, carries = null }) {
  // 사용자가 고른 "아이템 줄 챔피언"(여러 명 가능). 고르면 일반 아이템은 이 챔피언들에게만 줌.
  const carrySet = new Set((carries ?? (carryIdx != null ? [carryIdx] : [])).map(Number));
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

  // 고른 챔피언인데 랭커 통계상 아이템 홀더가 아닌 경우(5코 나르: 375판, 아이템 3개 든 판 4%)는 통계로 판단할 수 없으니
  // 역할 기준 궁합을 함께 봄. 통계가 충분한 홀더(니달리·아펠리오스)는 통계만 — 역할로 보면 적응가 니달리가 AP 로 잡힘
  const statOf = c => data.unitStats?.[c.id.toLowerCase()];
  const thinStats = u => { const st = statOf(u.champ); return !st || st.games < 30 || (st.carryRate || 0) < 0.15; };
  const isThinPick = u => carrySet.has(u.idx) && thinStats(u) && !isAdaptorChamp(u.champ);
  // 데이터가 적은 챔피언을 골랐을 때, 끝까지 데이터로 판단하는 단계:
  //  1) 그 챔피언의 적은 기록: 랭커가 그 챔피언에게 준 아이템 중 이 아이템의 비율 (기록이 많을수록 비중 ↑)
  //  2) 비슷한 챔피언(같은 역할 + 시너지 공유 또는 코스트 ±1, 홀더 통계 충분)의 궁합 평균
  //  3) 둘 다 없으면 역할 기준
  const ownItemsTotal = u => Object.values(statOf(u.champ)?.items || {}).reduce((a, b) => a + b, 0);
  const similarMemo = new Map();
  const similarOf = u => {
    if (!similarMemo.has(u.champ.id)) {
      const me = u.champ;
      similarMemo.set(me.id, data.champions
        .filter(c => c.id !== me.id && c.role === me.role && (c.base || c.id) !== (me.base || me.id))
        .map(c => ({ c, st: statOf(c), shared: c.traits.filter(t => me.traits.includes(t)).length, dc: Math.abs(c.cost - me.cost),
          sameRange: (c.range <= 2) === (me.range <= 2) })) // 근접/원거리가 같은 쪽 우선 (나르는 근접 → 원거리 원딜보다 근접 딜러)
        .filter(x => x.st && x.st.games >= 30 && (x.st.carryRate || 0) >= 0.15 && (x.shared > 0 || x.dc <= 1))
        .sort((a, b) => b.sameRange - a.sameRange || b.shared - a.shared || a.dc - b.dc || b.st.games - a.st.games)
        .slice(0, 4).map(x => x.c));
    }
    return similarMemo.get(u.champ.id);
  };
  const thinAff = (u, x) => {
    const st = statOf(u.champ), total = ownItemsTotal(u);
    const own = total ? Math.min(1, ((st.items?.[x.id] || 0) / total) * 3) : 0;
    const conf = Math.min(1, total / 60); // 아이템 기록 60개면 자기 기록만
    const sims = similarOf(u);
    const sim = sims.length ? sims.reduce((s, c) => s + itemAffinity(data, c, x), 0) / sims.length : itemFit(u.champ, x) * 0.7;
    return conf * own + (1 - conf) * sim;
  };
  // 보드에서 켜진 시너지 (챔피언 + 낀 상징 + 남은 아이템의 상징) → 챔피언마다 자기에게 적용되는 켜진 시너지
  const traitCount = {};
  const seenChamp = new Set();
  for (const u of units) {
    const key = u.champ.id;
    if (!seenChamp.has(key)) { seenChamp.add(key); for (const t of u.champ.traits) traitCount[t] = (traitCount[t] || 0) + 1; }
    for (const h of u.held) if (h.kind === 'emblem' && !u.champ.traits.includes(h.trait)) traitCount[h.trait] = (traitCount[h.trait] || 0) + 1;
  }
  for (const id of inventory) { const em = emblemOf(id); if (em) traitCount[em.trait] = (traitCount[em.trait] || 0) + 1; }
  const traitActive = t => (traitCount[t] || 0) >= (data.traits[t]?.breakpoints?.[0] || Infinity);
  // planEm = 이번 배분에서 이 챔피언에게 주기로 비워 둔 상징의 시너지 (카르마 + 처형자 상징 → 보석 건틀릿 덜 필요)
  const traitsOnOf = u => [...u.champ.traits, ...u.held.filter(h => h.kind === 'emblem').map(h => h.trait), ...(u.planEm || [])].filter(traitActive);
  const aff = (u, it) => {
    const x = it.statId ? { ...it, id: it.statId } : it;
    return isThinPick(u) ? thinAff(u, x) : itemAffinity(data, u.champ, x, traitsOnOf(u));
  };
  const canHold = u => !carrySet.size || carrySet.has(u.idx);
  function isAdaptorChamp(c) { return c.traits.some(t => /Adaptor/i.test(t) || /공격력과 주문력 중 어느 쪽이 높은지/.test(data.traits[t]?.desc || '')); }
  // 이미 아이템(딜템 등)을 든 챔피언 = 그 덱의 아이템 홀더 → 같은 계열 아이템을 몰아줌
  // (게임에서 이미 아이템을 준 챔피언 = 키우기로 정한 캐리. 다른 챔피언이 통계상 조금 더 잘 써도 몰아주는 게 보통 더 셈 — 사용자 피드백 11/15 로 +100%/개)
  // 사용자가 "몰아줄 캐리"로 고른 챔피언은 캐리템 2개를 든 것과 같은 대우
  const holderBonus = u => 1 + 1.0 * (carrySet.has(u.idx) ? 2 : Math.min(2, u.held.filter(h => h.kind === 'item' && aff(u, h) >= 0.3).length));
  // 적응가(공격력·주문력 중 높은 쪽을 씀): 물리 아이템과 마법 아이템을 섞으면 한쪽은 버리는 셈
  const isAdaptor = u => isAdaptorChamp(u.champ);
  // 랭커 3신기: 내 시너지가 켜진 판의 3신기가 따로 있으면 그것 (처형자 켜진 유나라 → 죽음의 검·최후의 속삭임·쇼진)
  const buildsOf = u => {
    const st = data.unitStats?.[u.champ.id.toLowerCase()];
    const on = traitsOnOf(u);
    // 켜진 시너지가 여럿이면 아이템이 가장 크게 달라지는 시너지 기준
    const dev = ti => Math.max(...Object.values(ti.items || {}).map(([a, b]) => Math.abs(Math.log(Math.max(a, 0.01) / Math.max(b, 0.01)))));
    const pick = Object.entries(st?.traitItems || {}).filter(([t, ti]) => on.includes(t) && ti.builds?.length).sort((a, b) => dev(b[1]) - dev(a[1]))[0];
    return pick ? pick[1].builds : st?.builds || [];
  };
  // 아이템 홀더 가중치: 랭커 경기에서 이 챔피언이 아이템 3개를 든 비율(carryRate).
  // 롤체는 나눠 주기보다 한 챔피언에 몰아줘야 함 → 홀더가 아닌 챔피언(요릭 0.08 등)에게 준 아이템은 가치가 작음
  const unitWeight = u => {
    const st = data.unitStats?.[u.champ.id.toLowerCase()];
    const w = st && st.games >= 30 ? Math.max(0.3, Math.min(1.4, 0.3 + 1.4 * (st.carryRate || 0))) : 1;
    return carrySet.has(u.idx) ? Math.max(w, 1.3) : w;
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
      // 데이터가 적은 챔피언은 2판짜리 3신기도 힌트로 (판수에 비례해 가산)
      const minG = isThinPick(u) ? 2 : 5;
      const builds = buildsOf(u).filter(b => b.games >= minG);
      const contains = b => { const rest = [...b.items]; return final.every(id => { const i = rest.indexOf(id); if (i < 0) return false; rest.splice(i, 1); return true; }); };
      const exact = final.length === 3 && builds.find(b => [...b.items].sort().join() === final.join());
      // 같은 아이템을 든 상태에서 랭커들이 어떤 아이템으로 마무리했는지 (11/17 사용자: 밤끝 vs 수은 — 남은 템까지 본 기댓값)
      // 예: 덩굴정령이 구인수+정의의 손길을 들었으면 밤끝으로 마무리 179판, 수은 25판 → 밤끝 쪽 가산이 큼
      const heldIds = u.held.filter(x => x.kind === 'item').map(x => x.statId || x.id);
      const has = (b, ids) => { const rest = [...b.items]; return ids.every(id => { const i = rest.indexOf(id); if (i < 0) return false; rest.splice(i, 1); return true; }); };
      const base = builds.filter(b => has(b, heldIds)), sumG = arr => arr.reduce((s, b) => s + b.games, 0);
      const top = Math.max(0, ...base.map(b => b.games));
      if (exact) v += 0.5 * Math.min(1, exact.games / 5) * (top ? 0.4 + 0.6 * exact.games / top : 1);
      else if (builds.some(contains)) { const r = sumG(base) ? sumG(base.filter(contains)) / sumG(base) : 1; v += 0.2 * (0.4 + 0.6 * Math.min(1, r * 2)); }
    }
    return v;
  };

  // 일반 아이템 배분: 큰 것부터 욕심껏 → 옮기기·바꾸기로 다듬기
  function place(items) {
    const slots = new Map(units.map(u => [u, []]));
    // 고른 챔피언("아이템 줄 챔피언")이 있으면 그 밖의 챔피언 가치는 절반 — 고른 챔피언이 먼저, 남는 아이템만 다른 챔피언에게
    const share = u => carrySet.size && !carrySet.has(u.idx) ? 0.5 : 1;
    const total = () => units.reduce((s, u) => s + unitValue(u, slots.get(u)) * share(u), 0);
    const order = [...items].sort((a, b) => Math.max(...units.map(u => aff(u, b))) - Math.max(...units.map(u => aff(u, a))));
    const unplaced = [];
    for (const it of order) {
      let best = null;
      for (const u of units) {
        const list = slots.get(u);
        if (list.length >= u.free || !canHold(u)) continue;
        const gain = unitValue(u, [...list, it]) - unitValue(u, list);
        if (!best || gain > best.gain) best = { u, gain };
      }
      // 어울리는 챔피언이 없으면 억지로 주지 않고 보관 (예: 물리 딜러가 없는데 무한의 대검).
      // 궁합 자체(가산 전)가 너무 낮으면 캐리 가산으로 점수가 넘어도 주지 않음 (나르에게 저녁갑주)
      if (best && best.gain >= 0.1 && aff(best.u, it) >= 0.05) slots.get(best.u).push(it); else unplaced.push({ ...it, why: best ? 'nofit' : 'noslot' });
    }
    // 고른 챔피언에게 못 준 아이템은 다른 챔피언 중 잘 쓰는 쪽에게 (11/16 사용자 피드백: 남는 아이템도 최대한 누구에게 줄지 알려 주기)
    if (carrySet.size) {
      for (const it of [...unplaced]) {
        let best = null;
        for (const u of units) {
          const list = slots.get(u);
          if (carrySet.has(u.idx) || list.length >= u.free) continue;
          const gain = unitValue(u, [...list, it]) - unitValue(u, list);
          if (aff(u, it) >= 0.05 && (!best || gain > best.gain)) best = { u, gain };
        }
        if (best && best.gain >= 0.1) { slots.get(best.u).push(it); unplaced.splice(unplaced.indexOf(it), 1); }
      }
    }
    for (let iter = 0, improved = true; improved && iter < 30; iter++) {
      improved = false;
      const base = total();
      outer: for (const u of units) {
        for (const [k, it] of slots.get(u).entries()) {
          for (const v of units) {
            if (v === u || !canHold(v)) continue;
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
      // 남은 칸이 있고 시너지가 없는 챔피언 중:
      //  ① 랭커가 이 상징을 준 챔피언(받은 비율 5% 이상, 많은 순) — 처형자 상징은 카르마·자이라(스킬 치명타라 딜러에게), 요릭 X (11/18)
      //  ② 그런 챔피언이 없으면 일반 아이템을 덜 받은(캐리가 아닌) 쪽 — 인원만 채우는 상징
      const es = data.emblemStats?.[t];
      const shareOf = u => {
        if (!es || es.total < 30) return 0;
        const k = /lux/i.test(u.champ.id) ? 'da_lux18_base' : u.champ.id.toLowerCase();
        const r = (es.holders[k] || 0) / es.total;
        return r >= 0.05 ? r : 0;
      };
      const cand = units.filter(u => !u.champ.traits.includes(t) && slots.get(u).length < u.free)
        .sort((a, b) => shareOf(b) - shareOf(a) || unitValue(a, slots.get(a)) - unitValue(b, slots.get(b)) || a.champ.cost - b.champ.cost)[0];
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
  const totalFree = units.filter(canHold).reduce((s, u) => s + u.free, 0);
  const bestVal = new Map();
  const quickOf = id => {
    if (!bestVal.has(id)) {
      const it = lookup(id);
      bestVal.set(id, it.kind === 'emblem' ? 0.6 : Math.max(0, ...units.filter(u => u.free && canHold(u)).map(u => aff(u, it) * holderBonus(u) * unitWeight(u))));
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
    // 랭커가 이 상징을 주로 준 챔피언(15% 이상)이 보드에 있으면 그 칸을 상징용으로 먼저 비워 둠 (처형자 상징 → 카르마)
    const reserved = new Map();
    for (const em of all.filter(x => x.kind === 'emblem')) {
      const es = data.emblemStats?.[em.trait];
      if (!es || es.total < 30) continue;
      const h = units.filter(u => !u.champ.traits.includes(em.trait) && u.free - (reserved.get(u) || 0) > 0)
        .map(u => ({ u, r: (es.holders[/lux/i.test(u.champ.id) ? 'da_lux18_base' : u.champ.id.toLowerCase()] || 0) / es.total }))
        .sort((a, b) => b.r - a.r)[0];
      if (h && h.r >= 0.15) { reserved.set(h.u, (reserved.get(h.u) || 0) + 1); (h.u.planEm ||= []).push(em.trait); }
    }
    for (const [u, n] of reserved) u.free -= n;
    const placed = place(all.filter(x => x.kind === 'item'));
    for (const [u, n] of reserved) u.free += n;
    for (const u of reserved.keys()) delete u.planEm;
    const ems = placeEmblems(all.filter(x => x.kind === 'emblem'), placed.slots);
    const score = placed.value + ems.value;
    if (!best || score > best.score) best = { score, placed, ems, left: p.left };
  }
  if (best) for (const e of best.ems.placed) (e.u.planEm ||= []).push(e.em.trait); // 근거 표시도 받은 상징 기준
  const reasonOf = (u, it) => {
    const st = data.unitStats?.[u.champ.id.toLowerCase()];
    let rate = st && st.games >= 30 ? (st.items?.[it.statId || it.id] || 0) / st.games : null;
    if (rate != null) rate = Math.min(1, rate * traitItemRatio(st, it.statId || it.id, traitsOnOf(u))); // 시너지 켜짐 여부 반영 (itemAffinity 와 같은 기준)
    if (!isThinPick(u)) return { rate };
    const total = ownItemsTotal(u), sims = similarOf(u);
    const own = total ? (st?.items?.[it.statId || it.id] || 0) / total : 0;
    return {
      rate: null,
      basis: total >= 30 ? { kind: 'sparse', total, share: own } // 자기 기록 위주
        : sims.length ? { kind: 'similar', names: sims.map(c => c.name), total } // 비슷한 챔피언 기록
        : { kind: 'role' },
    };
  };
  const assignments = [];
  for (const u of units) {
    for (const it of best.placed.slots.get(u)) {
      if (it.kind === 'emblem') continue;
      assignments.push({ item: it, idx: u.idx, champ: u.champ, from: it.from || null, ...(carrySet.size && !carrySet.has(u.idx) ? { other: true } : {}), ...reasonOf(u, it) });
    }
  }
  for (const e of best.ems.placed) assignments.push({ item: e.em, idx: e.u.idx, champ: e.u.champ, from: e.em.from || null, emblem: { trait: e.em.trait, from: e.n, to: e.n + 1, reaches: e.next === e.n + 1 } });
  // 최종 아이템 3개가 랭커 3신기와 똑같으면 그 기록 (화면에 "랭커 3신기 · N판 M등")
  const buildMatch = {};
  for (const u of units) {
    const final = [...u.held, ...best.placed.slots.get(u)].filter(x => x.kind === 'item').map(x => x.statId || x.id).sort();
    if (final.length !== 3 || !best.placed.slots.get(u).length) continue;
    const b = buildsOf(u).find(b => b.games >= (isThinPick(u) ? 2 : 5) && [...b.items].sort().join() === final.join());
    if (b) buildMatch[u.idx] = { games: b.games, avgPlace: b.avgPlace, few: b.games < 15 };
  }
  // 같은 챔피언끼리 모아서 보여주기 좋게 (아이템을 많이 받는 챔피언 먼저)
  const per = assignments.reduce((m, a) => (m[a.idx] = (m[a.idx] || 0) + 1, m), {});
  assignments.sort((a, b) => (a.other ? 1 : 0) - (b.other ? 1 : 0) || per[b.idx] - per[a.idx] || a.idx - b.idx); // 고른 챔피언 먼저
  // 재료로 만들었는데 줄 곳이 없는 아이템은 만들지 말고 재료 그대로 보관 (11/16 사용자 피드백: 남는 건 안 합치는 게 나음)
  const unplacedAll = [...best.placed.unplaced, ...best.ems.unplaced];
  const keepComps = unplacedAll.filter(x => x.from).flatMap(x => x.from);
  return {
    assignments,
    unplaced: unplacedAll.filter(x => !x.from),
    leftComponents: [...best.left, ...keepComps],
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
const PRED_MIN = 0.1;
const FLEX_MIN = 0.25; // 이보다 적게 쓰는 챔피언의 변경은 덱 영향에서 뺌
function patchReport(comps, patch, prevPatch) {
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
      row.verdict = Math.abs(row.actualDelta) < row.noise || Math.abs(predDelta) < PRED_MIN || Math.abs(PRED_PER_POINT * score) < PRED_MIN ? 'flat'
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

// ---------------- 자동 티어표 ----------------
// 이번 패치 성적으로 메타 덱을 S/A/B/C 로 나눔.
// 평균 등수는 판수가 적으면 운이 크게 작용하므로, 전체 평균(4.5등)짜리 가상의 10판을 섞어서 보정한 값으로 판단.
// 판수 = 이번 패치 판수(patchGames). 이번 패치 기록이 아직 없으면(0) 티어에 넣지 않음.
const TIER_CUTS = { S: 3.7, A: 4.0, B: 4.3 }; // 고정 기준(덱 목록 카드·지켜볼 덱 판단용)
const TIER_SHARES = { S: 0.1, A: 0.2, B: 0.3 }; // 티어표: 상대 순위 비율
const shrinkAvg = (avg, games) => (avg * games + 4.5 * 10) / (games + 10);
function tierOf(avg, games) {
  const s = shrinkAvg(avg, games);
  return s <= TIER_CUTS.S ? 'S' : s <= TIER_CUTS.A ? 'A' : s <= TIER_CUTS.B ? 'B' : 'C';
}
/** 덱의 티어 판단에 쓸 판수: 패치 정보가 있으면 이번 패치 판수, 없으면 전체 */
const tierGames = m => (m.patchGames != null ? m.patchGames : m.games);

/**
 * decks: [{ m: { avgPlace, games, patchGames?, playRate } , ... }]
 * min: 티어에 넣을 이번 패치 최소 판수
 * → { tiers: { S:[], A:[], B:[], C:[] }, watch: [] }
 *   watch = 이번 패치 판수가 min 에 못 미치지만 지금까지 성적이 좋은(보정 4.0등 이하) 덱, 최대 6개 — "지켜볼 덱"
 */
function tierList(decks, { min = 15, watchMin = 5, shares = TIER_SHARES } = {}) {
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
function groupDecks(decks) {
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
      const value = same && a.value && b.value && s >= 0.5;
      // ④ 주력 시너지가 같고 보드가 75% 이상 같으면 캐리가 달라도 한 덱 (11/15 사용자 피드백: 지옥불 럭스인데 애쉬도 자주 씀 —
      //    아이템을 누가 들었는지로만 갈림. 개화 아리=자이라, 햇빛 유나라=르블랑=카르마처럼 보드 100% 같은 덱이 많았음)
      const sameTrait = a.trait && a.trait === b.trait && !a.value && !b.value && s >= 0.75;
      // ⑤ 밸류덱끼리 보드가 75% 이상 같으면 캐리가 달라도 한 덱 (11/20 사용자: 장로 드래곤 밸류와 드레이븐 밸류가 같은 9명 —
      //    5코 캐리끼리라 ①도 안 걸렸음. 누구에게 아이템을 줬는지는 버전표에서 비교)
      const valueBoard = a.value && b.value && s >= 0.75;
      // 캐리가 같은 덱 → 시너지가 같은 덱 순으로 우선 (전쟁기계 드레이븐이 장로 드래곤 밸류보다 드레이븐 밸류로)
      const pr = s + (same ? 1 : 0) + (a.trait && a.trait === b.trait ? 0.5 : 0);
      if (((late5 && s >= 0.75) || (same && s >= 0.85) || value || sameTrait || valueBoard) && (!best || pr > best.pr)) best = { b, s, pr };
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


// ===== js/builder.js =====
// =============================================================
// 배치툴 (11/16 새 디자인): 4×7 육각형 보드에 챔피언·아이템·상징·별을 배치하고 시너지를 실시간 계산
// - 여러 단계 되돌리기/다시 실행 (Ctrl+Z / Ctrl+Shift+Z), 보드 밖으로 끌어내 빼기
// - 챔피언 목록: 비용별 / 계열별 / 직업별, 왼쪽 시너지를 누르면 그 시너지로 이동
// - 나무정령 식물(3·5·7) 자동 배치, 달빛 2 이상이면 달빛 챔피언 주변 칸 표시
// - 챔피언 툴팁(스킬 이름·마나·시너지·능력치·랭커 평균·3신기)
// - 덱 카드의 "배치툴에서 열기" → bdOpenDeck(), 저장(브라우저) / 배치 코드 복사·붙여넣기
// 앱(app.js)에서 initBuilder(ctx) 로 연결. ctx = { getData, esc, traitName, roleKo, buildsFor, openTab }
// =============================================================


const BD_ROWS = 4, BD_COLS = 7;            // 0행 = 맨 앞줄(적과 가까운 줄), 3행 = 맨 뒷줄
const BD_SAVE_KEY = 'tft-deck-maker:boards';
let bd = null;                              // ctx
// cells[idx] = { id, star, items: [], form?: 'AD'|'AP' }, plants[idx] = 'bark'|'flower'|'guardian', inv = 남은 아이템
const bdState = {
  bonus: {}, // 증강으로 얻은 시너지 인원 { 시너지 id: n }
  cells: {}, plants: {}, sel: null, inv: [], carries: new Set(),
  past: [], future: [], pgroup: 'cost', costF: 0, igroup: 'normal', pane: 'champ', drag: null,
};

const bdIdx = (r, c) => r * BD_COLS + c;
const bdData = () => bd.getData();
const bdChamp = id => bdData()?.champions.find(c => c.id === id);
const bdIsFront = c => c.role === 'TANK' || c.role === 'FIGHTER' || (c.range ?? 4) < 3;
const bd$ = id => document.getElementById(id);
const bdEul = w => { const k = w.charCodeAt(w.length - 1) - 0xAC00; return w + (k >= 0 && k < 11172 && k % 28 ? '을' : '를'); };
const cleanName = c => (c?.weights && c.base && c.base !== c.name ? c.base : c?.name || '');

// 같은 base 를 가진 챔피언이 여럿이면 형태 챔피언(화신 럭스) — 보드엔 하나만, 목록엔 하나로
function formGroup(c) {
  if (!c?.base) return null;
  const list = bdData().champions.filter(x => x.base === c.base);
  return list.length > 1 ? list : null;
}
const isForm = c => !!formGroup(c);
const champKey = c => (isForm(c) ? 'F:' + c.base : c.id);

// ---------------- 되돌리기 기록 ----------------
const snap = () => JSON.stringify({ cells: bdState.cells, inv: bdState.inv, carries: [...bdState.carries], plants: bdState.plants, alphaAug: bdState.alphaAug, bonus: bdState.bonus || {} });
function save() {
  bdState.past.push(snap());
  if (bdState.past.length > 50) bdState.past.shift();
  bdState.future = [];
}
function restore(s) {
  const o = JSON.parse(s);
  bdState.cells = o.cells; bdState.inv = o.inv || []; bdState.carries = new Set(o.carries || []); bdState.plants = o.plants || {}; bdState.alphaAug = !!o.alphaAug; bdState.bonus = o.bonus || {};
  bdState.sel = null; bdRender();
}
function undoStep() { if (!bdState.past.length) return; bdState.future.push(snap()); restore(bdState.past.pop()); bdToast('되돌렸어요'); }
function redoStep() { if (!bdState.future.length) return; bdState.past.push(snap()); restore(bdState.future.pop()); bdToast('다시 실행했어요'); }

// ---------------- 시너지 (보드 기준) ----------------
function bdTraitCounts() {
  const data = bdData(), n = {}, seen = new Set();
  for (const u of Object.values(bdState.cells)) {
    const c = bdChamp(u.id); if (!c) continue;
    const k = champKey(c); if (seen.has(k)) continue; seen.add(k);
    for (const t of c.traits) n[t] = (n[t] || 0) + (c.weights?.[t] ?? 1);
    for (const it of u.items) {
      const e = data.emblems.find(e => e.id === it);
      if (e && !c.traits.includes(e.trait)) n[e.trait] = (n[e.trait] || 0) + 1;
    }
  }
  // 증강으로 얻은 인원 (랭커 실제 보드를 열 때 따라옴 — 나무정령 럭스 9나무정령 = 챔피언·상징 8 + 증강 1)
  for (const [t, k] of Object.entries(bdState.bonus || {})) if (k > 0) n[t] = (n[t] || 0) + k;
  return n;
}
const bdTraitStyle = (tier, max) => !tier ? '' : max === 1 ? 'gold' : tier >= max ? (max >= 4 ? 'prism' : 'gold') : ['bronze', 'silver', 'gold'][Math.min(tier, 3) - 1];
function tbadge(id, style = '', sm = false) {
  const ic = bdData()?.traits?.[id]?.icon;
  return `<span class="tb ${style}${sm ? ' sm' : ''}">${ic ? `<img src="${bd.esc(ic)}" alt="">` : ''}</span>`;
}
// 계열(앞쪽에 적힌 시너지) / 직업(뒤쪽) / 고유(단계 1 하나) — 게임 데이터에 구분이 없어 챔피언 시너지 순서로 판단 (Set 18 35개 모두 맞음)
let ttypeCache = null;
function traitType(id) {
  const data = bdData();
  if (!ttypeCache || ttypeCache.data !== data) {
    const pos = {};
    for (const c of data.champions) c.traits.forEach((t, i) => { const p = (pos[t] ||= [0, 0]); if (i === 0) p[0]++; else if (i === c.traits.length - 1) p[1]++; });
    const map = {};
    for (const [t, tr] of Object.entries(data.traits)) map[t] = tr.breakpoints.length === 1 && tr.breakpoints[0] === 1 ? 'unique' : (pos[t]?.[0] || 0) >= (pos[t]?.[1] || 0) ? 'origin' : 'class';
    ttypeCache = { data, map };
  }
  return ttypeCache.map[id] || 'origin';
}

// ---------------- 나무정령 식물 · 달빛 칸 ----------------
// 시너지 설명 기준: 3 → 돌껍질 나무 + 생명꽃, 5 → 돌껍질 나무 하나 더, 7 → 깊은숲 수호자, 9/11 → 식물 2/3성
// 식물은 시너지·인원에 안 셈, 끌어서 옮길 수 있고 단계가 내려가면 사라짐. 그림은 게임 화면 캡처(data/icons/plant_*.webp)
const PLANT = { bark: { name: '돌껍질 나무', rows: [0, 1] }, flower: { name: '생명꽃', rows: [3, 2] }, guardian: { name: '깊은숲 수호자', rows: [1, 0] } };
const traitIdBy = re => Object.keys(bdData()?.traits || {}).find(k => re.test(k));
function freePlantCell(type) {
  for (const r of PLANT[type].rows.concat([0, 1, 2, 3])) for (const c of [6, 5, 0, 4, 1, 3, 2]) { const i = bdIdx(r, c); if (!bdState.cells[i] && !bdState.plants[i]) return i; }
  return null;
}
function elderLevel(n = bdTraitCounts()) { const id = traitIdBy(/Elderwood/i), t = id && bdData().traits[id]; return t ? t.breakpoints.filter(b => b <= (n[id] || 0)).length : 0; }
function syncPlants() {
  const lvl = elderLevel();
  const want = lvl >= 1 ? ['bark', 'flower', ...(lvl >= 2 ? ['bark'] : []), ...(lvl >= 3 ? ['guardian'] : [])] : [];
  const need = {}; for (const w of want) need[w] = (need[w] || 0) + 1;
  for (const [i, p] of Object.entries(bdState.plants).reverse()) { if (need[p] > 0) need[p]--; else delete bdState.plants[i]; }
  for (const [p, k] of Object.entries(need)) for (let n = 0; n < k; n++) { const j = freePlantCell(p); if (j != null) bdState.plants[j] = p; }
}
const plantStar = () => { const l = elderLevel(); return l >= 5 ? 3 : l >= 4 ? 2 : 1; };
function neighbors(i) { // 홀수 줄이 오른쪽으로 반 칸
  const r = Math.floor(i / BD_COLS), c = i % BD_COLS, out = [];
  const add = (rr, cc) => { if (rr >= 0 && rr < BD_ROWS && cc >= 0 && cc < BD_COLS) out.push(bdIdx(rr, cc)); };
  add(r, c - 1); add(r, c + 1);
  for (const rr of [r - 1, r + 1]) for (const k of (r % 2 ? [0, 1] : [-1, 0])) add(rr, c + k);
  return out;
}
function lunarCells() {
  const id = traitIdBy(/Lunar/i), n = bdTraitCounts();
  if (!id || (n[id] || 0) < 2) return { src: new Set(), area: new Set(), id };
  const data = bdData();
  const src = new Set(Object.entries(bdState.cells).filter(([, u]) => { const c = bdChamp(u.id); return c && (c.traits.includes(id) || u.items.some(it => data.emblems.find(e => e.id === it)?.trait === id)); }).map(([i]) => Number(i)));
  const area = new Set(); for (const i of src) for (const j of neighbors(i)) if (!src.has(j)) area.add(j);
  return { src, area, id };
}

// 협곡야수 우두머리 표식 (11/17 사용자): 협곡야수 3단계부터 1개, 증강이 있으면 2명에게 (단계와 무관)
// cells[i].alpha = 준 순서(숫자). 시너지 인원에는 영향 없음, 표식 받은 챔피언의 "OO 버프" 효과가 켜짐
const riftId = () => traitIdBy(/Riftbeast/i);
function alphaSlots(n = bdTraitCounts()) {
  const id = riftId(), t = id && bdData().traits[id];
  return t && (n[id] || 0) >= t.breakpoints[0] ? (bdState.alphaAug ? 2 : 1) : 0;
}
const isRift = u => { const c = u && bdChamp(u.id); return !!c && c.traits.includes(riftId()); };
const alphaList = () => Object.entries(bdState.cells).filter(([, u]) => u.alpha).map(([i, u]) => ({ i: Number(i), u })).sort((a, b) => a.u.alpha - b.u.alpha);
function syncAlpha() {
  const k = alphaSlots();
  alphaList().filter(x => isRift(x.u)).forEach((x, n) => { if (n >= k) delete x.u.alpha; });
  for (const x of alphaList()) if (!isRift(x.u)) delete x.u.alpha;
}
function setAlpha(i) { // 자리가 1개면 옮기고, 2개가 다 찼으면 안내
  const u = bdState.cells[i], k = alphaSlots();
  if (!isRift(u)) return bdToast('우두머리 표식은 협곡야수 챔피언에게만 줄 수 있어요');
  if (!k) return bdToast('협곡야수 3명부터 우두머리 표식을 써요');
  if (u.alpha) return;
  const cur = alphaList();
  if (cur.length >= k && k > 1) return bdToast('우두머리 표식은 2개까지예요 · 하나를 빼고 주세요');
  save();
  if (cur.length >= k) delete cur[0].u.alpha;
  u.alpha = (cur.at(-1)?.u.alpha || 0) + 1; bdRender();
}
const alphaBuff = c => { const m = c?.ability?.desc?.match(/(?:^|\n)([^\n]*버프:[^\n]*)/); return m ? m[1].replace(/@[^@]*@/g, '?').replace(/%i:[a-zA-Z]+%/g, '').replace(/\s+/g, ' ').trim() : ''; };

// ---------------- 배치 조작 ----------------
function bdFreeCell(front) {
  const rows = front ? [0, 1, 2, 3] : [3, 2, 1, 0];
  for (const r of rows) for (const c of [3, 2, 4, 1, 5, 0, 6]) { const i = bdIdx(r, c); if (!bdState.cells[i] && !bdState.plants[i]) return i; }
  return null;
}
/** 형태 챔피언(럭스): 단계가 오르는 시너지 > 아이템을 가장 많이 든 캐리의 시너지 > 지금 인원 */
function bestForm(c) {
  const forms = formGroup(c) || [c], n = bdTraitCounts(), data = bdData();
  const lv = (t, k) => (data.traits[t]?.breakpoints || []).filter(b => b <= k).length;
  const carry = Object.values(bdState.cells).filter(u => !isForm(bdChamp(u.id))).sort((a, b) => b.items.length - a.items.length || (bdChamp(a.id)?.role === 'TANK') - (bdChamp(b.id)?.role === 'TANK'))[0];
  const ct = carry ? bdChamp(carry.id)?.traits || [] : [];
  const score = f => { const t = Object.keys(f.weights || {})[0], k = n[t] || 0; return t ? (lv(t, k + 2) > lv(t, k) ? 10 : 0) + (ct.includes(t) ? 5 : 0) + k * 0.1 : -1; };
  return [...forms].sort((a, b) => score(b) - score(a))[0];
}
function addChamp(id, at = null, exact = false) {
  let c = bdChamp(id); if (!c) return;
  if (isForm(c) && !exact) c = bestForm(c);
  const key = champKey(c);
  if (Object.entries(bdState.cells).some(([k, u]) => Number(k) !== at && champKey(bdChamp(u.id)) === key)) return bdToast(`${cleanName(c)}는 이미 보드에 있어요`);
  const i = at ?? bdFreeCell(bdIsFront(c));
  if (i == null) return bdToast('보드가 가득 찼어요');
  save();
  if (bdState.plants[i]) { const p = bdState.plants[i]; delete bdState.plants[i]; const j = freePlantCell(p); if (j != null) bdState.plants[j] = p; }
  bdState.cells[i] = { id: c.id, star: 2, items: [] };
  bdState.sel = i; bdRender();
}
function addItem(id) {
  const u = bdState.sel != null && bdState.cells[bdState.sel];
  save();
  if (u && u.items.length < 3) { u.items.push(id); bdToast(`${cleanName(bdChamp(u.id))}에게 ${bdItemInfo(id).name}`); }
  else if (u) { bdState.past.pop(); return bdToast('아이템은 3개까지예요'); }
  else bdState.inv.push(id);
  bdRender();
}
function removeUnit(i) {
  const u = bdState.cells[i]; if (!u) return;
  save(); delete bdState.cells[i]; // 낀 아이템도 같이 사라짐 (남은 아이템 칸은 분배할 아이템만 — 11/16 사용자)
  if (bdState.sel === i) bdState.sel = null;
  bdRender();
  bdToast(`${bdEul(cleanName(bdChamp(u.id)))} 뺐어요 · Ctrl+Z 로 되돌리기`);
}

// ---------------- 덱 → 보드 (자동 배치) ----------------
// units: [{ champ, star, items }]
// 앞줄: 탱커(메인 탱커는 가운데) → 전사·근접 딜러, 뒷줄: 핵심 캐리는 구석, 나머지 원거리
function bdAutoPlace(units, { carryId = null, tankId = null } = {}) {
  const cells = {};
  const put = (u, r, c) => { cells[bdIdx(r, c)] = { id: u.champ.id, star: u.star || 2, items: u.items || [], ...(u.form ? { form: u.form } : {}) }; };
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

/** 덱 카드 객체(d) → 보드에 올리고 배치툴 탭 열기 (되돌리기 가능) */
function bdOpenDeck(d) {
  const data = bdData();
  const carryId = d.carry?.id || d.core?.carry;
  const tankId = d.core?.tank;
  const emblemItem = t => data.emblems.find(e => e.trait === t)?.id;
  const units = d.team.map(c => {
    const items = [];
    for (const a of d.assignment || []) if (a.holder === c.id && emblemItem(a.trait)) items.push(emblemItem(a.trait));
    // 핵심 캐리·탱커 + 이 덱에서 아이템을 평균 1.5개 이상 드는 챔피언(11/17 사용자: 햇빛 르블랑의 유나라·카르마)
    const holds = c.id === carryId || c.id === tankId || (d.unitInfo?.[c.id]?.held || 0) >= 1.5;
    const build = d.builds?.[c.id] || (holds ? bd.buildsFor(c)[0] : null);
    for (const it of build?.items || []) if (items.length < 3) items.push(it);
    for (const it of d.items?.[c.id] || []) if (items.length < 3) items.push(it.id); // 아이템 탭 결과
    const star3 = (d.unitInfo?.[c.id]?.star3 || 0) >= 0.4;
    return { champ: c, star: star3 ? 3 : 2, items };
  });
  const before = snap();
  save();
  if (d.board) {
    // 직접 고친 보드면(추천 적용 상태가 아니면) 지금 보드 기준
    if (bdState.recBase && before !== bdState.recBase && before !== bdState.recLast) bdState.recBase = null;
    // 추천은 "추천을 받던 때의 보드" 기준 → 그 보드에서 새로 여는 것처럼 (11/16 사용자: 1번 적용 후 2번을 누르면 둘 다 쌓였음)
    if (bdState.recBase) { const b = JSON.parse(bdState.recBase); bdState.cells = b.cells; bdState.inv = b.inv; bdState.plants = b.plants || {}; bdState.carries = new Set(b.carries || []); }
    // 내 보드 기반 추천: 지금 배치·아이템은 그대로 두고, 판매할 챔피언만 빼고 새 챔피언을 빈 칸에
    // 이미 보드에 있는 챔피언은 다시 넣지 않음 (11/16 사용자: "배치툴로 보기"를 두 번 누르면 같은 챔피언이 또 추가됨)
    // 형태만 다른 럭스(햇빛 → 달빛)는 빼고 넣는 대신 그 자리에서 형태만 바꿈 (아이템·별 유지)
    const removed = new Set(d.board.removed), added = new Set(d.board.added);
    const keyAt = () => new Map(Object.entries(bdState.cells).map(([i, u]) => [champKey(bdChamp(u.id)), Number(i)]));
    const addKeys = new Set(units.filter(u => added.has(u.champ.id)).map(u => champKey(u.champ)));
    for (const [i, u] of Object.entries(bdState.cells)) if (removed.has(u.id) && !addKeys.has(champKey(bdChamp(u.id)))) { bdState.inv.push(...u.items); delete bdState.cells[i]; }
    for (const u of units) {
      if (!added.has(u.champ.id)) continue;
      const at = keyAt().get(champKey(u.champ));
      if (at != null) { bdState.cells[at].id = u.champ.id; continue; } // 이미 있음 (형태만 맞춤)
      const idx = bdFreeCell(bdIsFront(u.champ));
      if (idx != null) bdState.cells[idx] = { id: u.champ.id, star: u.star, items: u.items };
    }
    if (snap() === bdState.past.at(-1)) { bdState.past.pop(); bd.openTab('builder'); bdRender(); return bdToast('이미 이 덱이 보드에 있어요'); }
    bdState.recLast = snap();
    bdToast('추천 덱으로 바꿨어요 · Ctrl+Z 로 되돌리기');
  } else {
    bdState.cells = bdAutoPlace(units, { carryId, tankId });
    bdState.plants = {}; bdState.carries = new Set();
    // 랭커 실제 보드에서 챔피언·상징으로 설명 안 되는 인원 (덱 카드의 "기타 +1")도 함께
    bdState.bonus = Object.fromEntries((d.traits || []).filter(t => t.bonus > 0).map(t => [t.id, t.bonus]));
    bd$('bdName').value = d.bdName || (d.title || '').replace(/<span class="tag[^]*$/, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  bdState.sel = null;
  bd.openTab('builder');
  bdRender();
}
let bdResizeT = 0;
addEventListener('resize', () => { clearTimeout(bdResizeT); bdResizeT = setTimeout(() => { if (bdData() && !bd$('panel-builder').hidden) bdRenderBoard(); }, 120); });

/** 다음 수 추천을 계산하는 순간의 보드를 기억 (추천 덱은 이 보드 기준으로 적용) */
function bdMarkRecBase() { bdState.recBase = snap(); }
/** 남은 아이템 목록 (자동 배분용) */
function bdInventory() { return [...bdState.inv]; }
/** 사용자가 고른 "아이템 줄 챔피언" 칸 번호들 */
function bdCarries() { return [...bdState.carries].map(Number); }
/** 자동 배분 결과를 보드에 넣기: [{ idx, itemId }] + 남길 아이템 목록 (되돌리기 가능) */
function bdApplyItems(list, keep) {
  save();
  for (const { idx, itemId } of list) {
    const u = bdState.cells[idx];
    if (u && u.items.length < 3) u.items.push(itemId);
  }
  bdState.inv = [...keep];
  bdRender();
  bdToast('아이템을 보드에 넣었어요 · Ctrl+Z 로 되돌리기');
}
/** 지금 보드의 챔피언 목록 (다음 수 추천·자동 배분용) */
function bdBoardUnits() {
  return Object.entries(bdState.cells).map(([idx, u]) => ({ idx: Number(idx), id: u.id, star: u.star, items: [...u.items], ...(u.form ? { form: u.form } : {}) }));
}

// ---------------- 게임 팀 코드 (11/17) ----------------
// 형식: "02" + 챔피언마다 16진수 3자리 × 10칸(빈칸 000) + 세트 키("TFTSet18"). 번호 = 맵 데이터 TftShopData {4d4e5cf5}
// (data/planner-codes.json). 예: 롤체지지 0241f4394103eb… = 오른(41f)·알리스타(439)·헤카림(410)… 보드 순서대로.
function bdPlannerNum(pc, c) {
  if (pc.codes[c.id] != null) return pc.codes[c.id];
  // 형태 챔피언(럭스)은 형태마다 번호가 없으면 같은 base 의 번호로
  const alt = bdData().champions.find(x => (x.base || x.id) === (c.base || c.id) && pc.codes[x.id] != null);
  return alt ? pc.codes[alt.id] : null;
}
function bdTeamCode() {
  const pc = bd.plannerCodes?.(); if (!pc?.codes) return null;
  const nums = [], missing = [], seen = new Set();
  for (const [, u] of Object.entries(bdState.cells).sort((a, b) => a[0] - b[0])) {
    const c = bdData().champions.find(x => x.id === u.id); if (!c) continue;
    const n = bdPlannerNum(pc, c);
    if (n == null) { missing.push(c.name); continue; }
    if (seen.has(n)) continue; seen.add(n); nums.push(n);
  }
  const over = Math.max(0, nums.length - 10), use = nums.slice(0, 10);
  const code = '02' + use.map(n => n.toString(16).padStart(3, '0')).join('') + '000'.repeat(10 - use.length) + pc.set;
  return { code, n: use.length, missing, over };
}
/** 게임 팀 코드 → 보드 (챔피언만, 앞줄부터 빈 칸에). 읽으면 true */
function bdTeamDecode(code) {
  const m = /^(0[12])([0-9a-f]+)(TFTSet\d+)$/i.exec(code.replace(/\s+/g, ''));
  const pc = bd.plannerCodes?.();
  if (!m || !pc?.codes) return false;
  const w = m[1] === '01' ? 2 : 3, body = m[2];
  const byNum = new Map();
  for (const c of bdData().champions) { const n = pc.codes[c.id]; if (n != null && !byNum.has(n)) byNum.set(n, c); }
  const champs = [];
  for (let i = 0; i + w <= body.length; i += w) { const n = parseInt(body.slice(i, i + w), 16); if (n && byNum.has(n)) champs.push(byNum.get(n)); }
  if (!champs.length) return false;
  bdState.cells = bdAutoPlace(champs.slice(0, 10).map(c => ({ champ: c, star: 2, items: [] })));
  bdState.plants = {}; bdState.carries = new Set();
  bdRender();
  bdToast(`게임 팀 코드에서 챔피언 ${champs.length}명을 불러왔어요 (별·아이템·자리는 코드에 없어요)`);
  return true;
}

// ---------------- 이벤트 ----------------
function initBuilder(ctx) {
  bd = ctx;
  bd$('bdClear').onclick = () => { save(); bdState.cells = {}; bdState.inv = []; bdState.plants = {}; bdState.carries = new Set(); bdState.bonus = {}; bdState.sel = null; bdRender(); };
  bd$('bdUndo').onclick = undoStep;
  bd$('bdRedo').onclick = redoStep;
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || bd$('panel-builder').hidden || e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoStep(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoStep(); }
  });
  bd$('bdSave').onclick = () => {
    const name = bd$('bdName').value.trim() || `덱 ${new Date().toLocaleString('ko-KR')}`;
    const list = bdLoadList().filter(x => x.name !== name);
    list.unshift({ name, code: bdEncode() });
    try { localStorage.setItem(BD_SAVE_KEY, JSON.stringify(list.slice(0, 50))); } catch { /* 저장 공간 문제 무시 */ }
    bdRenderSaved(); bdToast(`"${name}" 저장했어요`);
  };
  bd$('bdLoad').onchange = e => {
    const x = bdLoadList().find(x => x.name === e.target.value);
    if (x) { save(); bdDecode(x.code); bd$('bdName').value = x.name; }
    e.target.value = '';
  };
  bd$('bdCopy').onclick = async () => {
    const code = bdEncode();
    try { await navigator.clipboard.writeText(code); bdToast('배치 코드를 복사했어요'); }
    catch { prompt('아래 코드를 복사하세요', code); }
  };
  bd$('bdGameCode').onclick = async () => {
    const r = bdTeamCode();
    if (!r) return bdToast('게임 팀 코드 정보를 아직 못 불러왔어요. 잠시 뒤 다시 눌러 주세요.');
    if (!r.n) return bdToast('보드에 챔피언을 먼저 올려 주세요');
    const note = (r.missing.length ? ` · 번호 없는 챔피언 제외: ${r.missing.join(', ')}` : '') + (r.over ? ` · 10명까지만 (${r.over}명 제외)` : '');
    try { await navigator.clipboard.writeText(r.code); bdToast(`게임 팀 코드를 복사했어요 — 팀 플래너에서 "팀 코드 붙여넣기"${note}`); }
    catch { prompt('아래 코드를 복사하세요', r.code); }
  };
  bd$('bdPaste').onclick = () => {
    const code = prompt('배치 코드 또는 게임 팀 코드를 붙여넣으세요');
    if (!code) return;
    save();
    const ok = bdTeamDecode(code.trim()) || bdDecode(code.trim());
    if (!ok) { bdState.past.pop(); bdToast('코드를 읽지 못했어요'); }
  };

  // 보드: 클릭 (선택·별·빼기)
  bd$('bdBoard').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]'); if (rm) return removeUnit(Number(rm.dataset.rm));
    const st = e.target.closest('[data-star]');
    if (st) { const i = Number(st.dataset.star), u = bdState.cells[i]; save(); u.star = u.star === 3 ? 2 : 3; bdState.sel = i; bdRender(); return; }
    const h = e.target.closest('.b2hex'); if (!h) return;
    const i = Number(h.dataset.i);
    bdState.sel = bdState.cells[i] ? (bdState.sel === i ? null : i) : null;
    bdRender();
  });
  bd$('bdBoard').addEventListener('contextmenu', e => { // 우클릭으로도 빼기
    const h = e.target.closest('.b2hex'); if (!h || !bdState.cells[h.dataset.i]) return;
    e.preventDefault(); removeUnit(Number(h.dataset.i));
  });

  // 끌어다 놓기: 목록 → 보드/남은 아이템, 보드 칸끼리, 보드 밖으로 끌어내면 빼기
  document.addEventListener('dragstart', e => {
    if (bd$('panel-builder').hidden) return;
    const h = e.target.closest('#bdBoard .b2hex'), pc = e.target.closest('#bdPal .pc'), ic = e.target.closest('#bdItems .ic');
    const pl = h && e.target.closest('.plant'), it = h && e.target.closest('.its [data-k]'), al = e.target.closest('#bdAlpha .aslot');
    bdState.drag = al ? (al.dataset.alphaFrom != null ? { alphaFrom: Number(al.dataset.alphaFrom) } : { alpha: true }) : it ? { itemFrom: Number(h.dataset.i), k: Number(it.dataset.k) } : pl ? { plantFrom: Number(h.dataset.i) } : h ? { from: Number(h.dataset.i) } : pc ? { champ: pc.dataset.id, exact: !!pc.dataset.exact } : ic ? { item: ic.dataset.id } : null;
    if (bdState.drag) { e.dataTransfer.setData('text/plain', 'tft'); e.dataTransfer.effectAllowed = 'move'; hideTip(); }
  });
  document.addEventListener('dragover', e => {
    if (!bdState.drag) return;
    const t = e.target.closest('#bdBoard .b2hex, #bdInv');
    if (t) { e.preventDefault(); t.classList.add('drop'); }
  });
  document.addEventListener('dragleave', e => { const t = e.target.closest('#bdBoard .b2hex, #bdInv'); if (t) t.classList.remove('drop'); });
  document.addEventListener('drop', e => {
    const d = bdState.drag; if (!d) return;
    document.querySelectorAll('#panel-builder .drop').forEach(x => x.classList.remove('drop'));
    const h = e.target.closest('#bdBoard .b2hex'), inv = e.target.closest('#bdInv');
    if (!h && !inv) return; // 보드·남은 아이템 칸 밖 = 빼기 (dragend 에서)
    e.preventDefault(); d.done = true; bdState.inDrop = true;
    if (inv && d.item) { save(); bdState.inv.push(d.item); bdRender(); return; }
    if (!h) return;
    const i = Number(h.dataset.i), S = bdState;
    if (d.alpha || d.alphaFrom != null) { // 우두머리 표식 주기·옮기기
      const dst = S.cells[i]; S.sel = dst ? i : S.sel;
      if (!isRift(dst)) { bdRender(); return bdToast('우두머리 표식은 협곡야수 챔피언에게만 줄 수 있어요'); }
      if (d.alpha) return setAlpha(i);
      const src = S.cells[d.alphaFrom]; if (!src?.alpha || d.alphaFrom === i || dst.alpha) return bdRender();
      save(); dst.alpha = src.alpha; delete src.alpha; bdRender(); return;
    }
    if (d.itemFrom != null) { // 낀 아이템을 다른 챔피언에게
      const src = S.cells[d.itemFrom], dst = S.cells[i];
      if (i === d.itemFrom || !src) return;
      if (!dst) return bdToast('아이템은 챔피언에게 옮겨 주세요');
      if (dst.items.length >= 3) return bdToast('아이템은 3개까지예요');
      save(); dst.items.push(...src.items.splice(d.k, 1)); S.sel = i; bdRender();
    } else if (d.plantFrom != null && d.plantFrom !== i) { // 식물 옮기기: 자리를 서로 바꿈
      save(); const f = d.plantFrom, p = S.plants[f], bp = S.plants[i], bc = S.cells[i];
      delete S.plants[f]; if (bp) S.plants[f] = bp; if (bc) { S.cells[f] = bc; delete S.cells[i]; } S.plants[i] = p; bdRender();
    } else if (d.from != null && d.from !== i) {
      save(); const a = S.cells[d.from], b = S.cells[i], bp = S.plants[i];
      if (b) S.cells[d.from] = b; else delete S.cells[d.from];
      if (bp) { delete S.plants[i]; S.plants[d.from] = bp; }
      S.cells[i] = a;
      if (S.carries.has(d.from) !== S.carries.has(i)) { const cf = S.carries.has(d.from); S.carries.delete(d.from); S.carries.delete(i); if (cf) S.carries.add(i); if (b && !cf) S.carries.add(d.from); }
      S.sel = i; bdRender();
    } else if (d.champ) addChamp(d.champ, i, d.exact);
    else if (d.item && S.cells[i]) { S.sel = i; addItem(d.item); }
  });
  document.addEventListener('pointerdown', () => { bdState.drag = null; });
  document.addEventListener('dragend', e => {
    const d = bdState.drag; bdState.drag = null;
    if (!d || d.done) return;
    const at = document.elementFromPoint(e.clientX, e.clientY);
    if (at && at.closest('#bdBoard, #bdAlpha')) return;
    if (d.from != null && bdState.cells[d.from]) removeUnit(d.from);
    else if (d.alphaFrom != null && bdState.cells[d.alphaFrom]?.alpha) { save(); delete bdState.cells[d.alphaFrom].alpha; bdRender(); bdToast('우두머리 표식을 뺐어요'); }
    else if (d.itemFrom != null && bdState.cells[d.itemFrom]?.items[d.k]) { // 낀 아이템을 보드 밖으로 = 버리기
      save(); const [gone] = bdState.cells[d.itemFrom].items.splice(d.k, 1); bdRender(); bdToast(`${bdItemInfo(gone).name} 뺐어요`);
    }
  });

  // 선택한 챔피언: 별 / 적응가 형태 / 럭스 형태 / 아이템 빼기
  bd$('bdUnit').addEventListener('click', e => {
    const i = bdState.sel, u = i != null && bdState.cells[i]; if (!u) return;
    const f = e.target.closest('[data-f]'), s = e.target.closest('[data-setstar]'), r = e.target.closest('[data-rmit]'), fm = e.target.closest('[data-form]'), al = e.target.closest('[data-alpha]');
    if (al) { if (!u.alpha) return setAlpha(i); save(); delete u.alpha; }
    else if (f) { save(); u.id = f.dataset.f; }
    else if (s) { save(); u.star = Number(s.dataset.setstar); }
    else if (fm) { save(); if (fm.dataset.form && u.form !== fm.dataset.form) u.form = fm.dataset.form; else delete u.form; }
    else if (r) { save(); u.items.splice(Number(r.dataset.rmit), 1); }
    else return;
    bdRender();
  });

  // 남은 아이템 · 아이템 줄 챔피언
  bd$('bdInv').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; save(); bdState.inv.splice(Number(b.dataset.k), 1); bdRender(); };
  bd$('bdInvClear').onclick = () => { if (!bdState.inv.length) return; save(); bdState.inv = []; bdRender(); };
  bd$('bdCarries').onclick = e => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const i = Number(b.dataset.c); save();
    if (bdState.carries.has(i)) bdState.carries.delete(i); else bdState.carries.add(i);
    bdRender();
  };

  // 협곡야수 우두머리 칸
  bd$('bdAlpha').addEventListener('click', e => {
    const rm = e.target.closest('[data-alpha-rm]'), nw = e.target.closest('[data-alpha-new]');
    if (rm) { const u = bdState.cells[rm.dataset.alphaRm]; if (u?.alpha) { save(); delete u.alpha; bdRender(); } }
    else if (nw) { if (bdState.sel != null && isRift(bdState.cells[bdState.sel])) setAlpha(bdState.sel); else bdToast('협곡야수 챔피언에게 끌어다 놓거나, 보드에서 챔피언을 고른 뒤 누르세요'); }
  });
  bd$('bdAlpha').addEventListener('change', e => { if (e.target.id !== 'bdAlphaAug') return; save(); bdState.alphaAug = e.target.checked; bdRender(); });

  // 오른쪽: 챔피언 / 아이템
  bd$('bdSeg').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; bdState.pane = b.dataset.v; bdRenderPalette(); };
  bd$('bdPtabs').onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; bdState.pgroup = b.dataset.p; bdRenderPalette(); bd$('bdPal').scrollTop = 0; };
  bd$('bdCosts').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; bdState.costF = Number(b.dataset.k); bdRenderPalette(); };
  bd$('bdFilter').oninput = bdRenderPalette;
  bd$('bdItabs').onclick = e => { const b = e.target.closest('[data-g]'); if (!b) return; bdState.igroup = b.dataset.g; bdRenderPalette(); };
  bd$('bdItemFilter').oninput = bdRenderPalette;
  bd$('bdPal').onclick = e => { const b = e.target.closest('.pc'); if (b) addChamp(b.dataset.id, null, !!b.dataset.exact); };
  bd$('bdItems').onclick = e => { const b = e.target.closest('.ic'); if (b) addItem(b.dataset.id); };

  // 왼쪽 시너지를 누르면 오른쪽 목록이 그 시너지로 (계열 → 계열별, 직업 → 직업별, 고유 → 계열별의 고유 시너지)
  const jump = tr => {
    const type = traitType(tr);
    bdState.pane = 'champ'; bdState.pgroup = type === 'class' ? 'class' : 'origin'; bdState.costF = 0; bd$('bdFilter').value = '';
    bdRenderPalette();
    const g = bd$('bdPal').querySelector(`.pgrp[data-g="${type === 'unique' ? 'unique' : tr}"]`); if (!g) return;
    bd$('bdPal').scrollTo({ top: g.offsetTop, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    g.classList.add('flash'); setTimeout(() => g.classList.remove('flash'), 1300);
    if (innerWidth <= 900) bd$('bdPal').scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  bd$('bdTraits').addEventListener('click', e => {
    const b = e.target.closest('[data-rmbonus]');
    if (b) { e.stopPropagation(); save(); delete bdState.bonus[b.dataset.rmbonus]; bdRender(); return bdToast('추가 인원을 뺐어요 · Ctrl+Z 로 되돌리기'); }
    const r = e.target.closest('[data-tr]'); if (r) jump(r.dataset.tr);
  });
  bd$('bdTraits').addEventListener('keydown', e => { const r = e.target.closest('[data-tr]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jump(r.dataset.tr); } });

  // 챔피언 툴팁
  const tip = document.createElement('div'); tip.className = 'ctip'; tip.id = 'bdTip'; tip.hidden = true; document.body.appendChild(tip);
  let tipFor = null, tipAt = 0;
  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch' || bdState.drag || bd$('panel-builder').hidden) return;
    const el = e.target.closest('#bdPal .pc, #bdBoard .bu:not(.plant), #bdCarries .cchip');
    if (!el) { if (tipFor) hideTip(); return; }
    if (tipFor === el) return; tipFor = el;
    const id = el.dataset.id || (el.closest('.b2hex') ? bdState.cells[el.closest('.b2hex').dataset.i]?.id : null) || (el.dataset.c != null ? bdState.cells[el.dataset.c]?.id : null);
    let c = bdChamp(id); if (!c) return;
    if (isForm(c) && el.classList.contains('pc') && !el.dataset.exact) c = bestForm(c);
    tip.innerHTML = tipHtml(c); tip.hidden = false; tipAt = Date.now();
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = r.left - w - 12; if (x < 8) x = r.right + 12; if (x + w > innerWidth - 8) x = Math.max(8, innerWidth - w - 8);
    tip.style.left = x + 'px'; tip.style.top = Math.min(innerHeight - h - 8, Math.max(8, r.top + r.height / 2 - h / 2)) + 'px';
  });
  addEventListener('scroll', () => { if (Date.now() - tipAt > 300) hideTip(); }, true);
  function hideTip() { tip.hidden = true; tipFor = null; }
  initBuilder.hideTip = hideTip;
}
function hideTip() { initBuilder.hideTip?.(); }

/** 데이터가 준비되면 호출: 주소에 #b=코드 가 있으면 그 배치를 불러옴 */
function bdOnData() {
  ttypeCache = null;
  const m = location.hash.match(/#b=([^&]+)/);
  if (m && !Object.keys(bdState.cells).length) bdDecode(decodeURIComponent(m[1]));
  else if (!bd$('panel-builder').hidden) bdRender();
}

// ---------------- 그리기 ----------------
function bdItemInfo(id) {
  const data = bdData();
  const e = [...data.emblems, ...(data.artifacts || []), ...(data.radiants || []), ...(data.components || [])].find(x => x.id === id);
  if (e) return { name: e.name, icon: e.icon };
  return data.itemInfo?.[id.toLowerCase()] || data.items.find(i => i.id === id) || { name: id, icon: null };
}
const itemImg = (id, cls = '') => { const it = bdItemInfo(id); return it.icon ? `<img${cls ? ` class="${cls}"` : ''} src="${bd.esc(it.icon)}" alt="${bd.esc(it.name)}" title="${bd.esc(it.name)}" data-item="${bd.esc(id)}" onerror="this.style.visibility='hidden'">` : `<span class="noimg" title="${bd.esc(it.name)}">${bd.esc(it.name.slice(0, 2))}</span>`; };
const porImg = c => `<span class="por" data-cost="${c.cost}">${c.icon ? `<img src="${bd.esc(c.icon)}" alt="" draggable="false" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}</span>`;

function bdRender() {
  // 끌어다 놓는 중에 다시 그리면 끌던 요소가 사라져 dragend 가 안 옴 → 끝난 뒤에 그림
  if (bdState.inDrop) { clearTimeout(bdState.rt); bdState.rt = setTimeout(() => { bdState.inDrop = false; bdRender(); }, 40); return; }
  const data = bdData();
  if (!data) return;
  for (const k of [...bdState.carries]) if (!bdState.cells[k]) bdState.carries.delete(k);
  syncPlants(); syncAlpha();
  bdRenderBoard(); bdRenderTraits(); bdRenderUnit(); bdRenderAlpha(); bdRenderInv(); bdRenderPalette(); bdRenderSaved();
  bd$('bdUndo').disabled = !bdState.past.length; bd$('bdRedo').disabled = !bdState.future.length;
  bd$('bdUndo').title = bdState.past.length ? `되돌리기 (Ctrl+Z) · ${bdState.past.length}단계` : '되돌릴 것이 없어요';
  const n = Object.keys(bdState.cells).length;
  try { history.replaceState(null, '', n ? `#b=${encodeURIComponent(bdEncode())}` : location.pathname + location.search); } catch { /* file:// 등 */ }
}

function bdRenderBoard() {
  const { esc } = bd, S = bdState;
  const board = bd$('bdBoard'), gap = 4;
  // 칸 크기 = 보드 칸 폭에 맞춰 (최대 74px) — 7칸 + 홀수 줄 반 칸
  const avail = board.parentElement.clientWidth - 36; // 안쪽 여백 빼고
  const W = Math.max(36, Math.min(74, Math.floor((avail - gap * BD_COLS) / (BD_COLS + 0.5)))), H = W * 1.15;
  board.style.setProperty('--cell', W + 'px');
  board.classList.toggle('small', W < 60);
  board.style.width = (BD_COLS * (W + gap) + W / 2) + 'px';
  board.style.height = (BD_ROWS * H * 0.78 + H * 0.3 + 10) + 'px';
  const moon = lunarCells(), pStar = plantStar(), moonIcon = moon.id ? bdData().traits[moon.id]?.icon : null, riftIcon = bdData().traits[riftId()]?.icon;
  let html = '';
  for (let r = 0; r < BD_ROWS; r++) for (let c = 0; c < BD_COLS; c++) {
    const i = bdIdx(r, c), u = S.cells[i], ch = u && bdChamp(u.id), pl = S.plants[i];
    const x = c * (W + gap) + (r % 2 ? (W + gap) / 2 : 0), y = r * H * 0.78;
    const mz = moon.area.has(i), ms = moon.src.has(i);
    html += `<div class="b2hex${r < 2 ? ' front' : ''}${S.sel === i ? ' sel' : ''}${mz ? ' moon' : ''}${ms ? ' moonSrc' : ''}" data-i="${i}" style="left:${x}px;top:${y}px"><div class="bg"></div>`
      + (mz && !ch && !pl && moonIcon ? `<img class="moonMark" src="${esc(moonIcon)}" alt="" title="달빛 강화 칸">` : '')
      + ((mz || ms) && ch && moonIcon ? `<span class="moonTag" title="${ms ? '달빛 챔피언 (더 크게 강화)' : '달빛 강화 칸'}"><img src="${esc(moonIcon)}" alt=""></span>` : '')
      + (pl ? `<div class="bu plant ${pl}" draggable="true" title="${PLANT[pl].name} (나무정령) — 끌어서 옮기기"><img class="face" src="data/icons/plant_${pl}.webp" alt="${PLANT[pl].name}" draggable="false"></div><div class="stars pst">${'★'.repeat(pStar)}</div><div class="nm">${PLANT[pl].name}</div>` : '')
      + (ch ? `<div class="bu" draggable="true" data-cost="${ch.cost}">${ch.icon ? `<img class="face" src="${esc(ch.icon)}" alt="${esc(ch.name)}" draggable="false" onerror="this.style.visibility='hidden'">` : ''}</div>
        <button class="stars" data-star="${i}" title="눌러서 ${u.star === 3 ? 2 : 3}성으로">${'★'.repeat(u.star)}</button><div class="nm">${esc(cleanName(ch))}</div>
        ${S.carries.has(i) ? '<span class="carryTag" title="아이템 줄 챔피언">템</span>' : ''}${u.alpha ? `<span class="alphaTag" title="협곡야수 우두머리 · ${esc(alphaBuff(ch))}">${riftIcon ? `<img src="${esc(riftIcon)}" alt="">` : ''}</span>` : ''}${u.form ? `<span class="formTag ${u.form}" title="적응가 ${u.form === 'AD' ? '물리' : '마법'} 형태">${u.form}</span>` : ''}
        <div class="its">${u.items.map((id, k) => `<span data-k="${k}" data-item="${esc(id)}" draggable="true" title="끌어서 다른 챔피언에게 · 보드 밖으로 끌어내면 빼기">${itemImg(id)}</span>`).join('')}</div>
        <button class="x" data-rm="${i}" aria-label="${esc(cleanName(ch))} 빼기">×</button>` : '')
      + '</div>';
  }
  board.innerHTML = html;
  const units = Object.values(S.cells).map(u => ({ u, c: bdChamp(u.id) })).filter(x => x.c);
  const n = units.reduce((s, x) => s + (x.c.slots || 1), 0);
  bd$('bdCount').textContent = `${n}명`;
  bd$('bdGold').textContent = `${units.reduce((s, x) => s + x.c.cost * (x.u.star === 3 ? 9 : x.u.star === 2 ? 3 : 1), 0)}골드어치`;
}

function bdRenderTraits() {
  const { esc } = bd, data = bdData(), n = bdTraitCounts();
  const rows = Object.entries(n).map(([id, k]) => {
    const t = data.traits[id]; if (!t) return null;
    const lvl = t.breakpoints.filter(b => b <= k).length;
    return { id, t, k, lvl, uniq: t.breakpoints.length === 1 && t.breakpoints[0] === 1 };
  }).filter(Boolean).sort((a, b) => (b.lvl > 0) - (a.lvl > 0) || a.uniq - b.uniq || b.lvl / b.t.breakpoints.length - a.lvl / a.t.breakpoints.length || b.k - a.k);
  bd$('bdTraits').innerHTML = rows.length ? rows.map(r => `<div class="trow${r.lvl ? '' : ' off'}" data-tr="${r.id}" role="button" tabindex="0" title="${esc(r.t.name)} 챔피언 보기">${tbadge(r.id, r.lvl ? bdTraitStyle(r.lvl, r.t.breakpoints.length) : '')}<span><span class="tnm">${r.k} ${esc(r.t.name)}${bdState.bonus?.[r.id] ? (() => { const b = bdState.bonus[r.id], low = r.t.breakpoints[0], ph = r.k - b < low && r.k === low;
      return `<span class="aug" data-rmbonus="${r.id}" role="button" title="${ph ? "증강 '환영 조합': 전투 시작 시 비활성 특성을 가장 낮은 단계로 켜 줘요 (랭커 실제 판 기준)" : '랭커 실제 판의 시너지 인원이 챔피언·상징으로 계산한 것보다 많았어요 (원인은 경기 데이터에 안 남음)'}. 누르면 빼요">${ph ? '환영 조합' : `기타 +${b}`} ×</span>`; })() : ''}</span>${r.uniq ? '' : `<span class="tbp">${r.t.breakpoints.map((b, i) => i === r.lvl - 1 ? `<b>${b}</b>` : b).join(' · ')}</span>`}</span></div>`).join('')
    : '<p class="muted small">챔피언을 올리면 여기에 시너지가 나와요.</p>';
}

function bdRenderUnit() {
  const { esc } = bd, i = bdState.sel, u = i != null && bdState.cells[i], c = u && bdChamp(u.id), box = bd$('bdUnit');
  if (!c) { box.hidden = true; return; }
  box.hidden = false;
  const forms = formGroup(c);
  const star = k => `<button data-setstar="${k}" aria-pressed="${u.star === k}"><span class="st">${'★'.repeat(k)}</span>${k}성</button>`;
  box.innerHTML = `<div class="uh"><b>${esc(cleanName(c))}</b><span class="muted small">${c.cost}코스트 · ${c.traits.map(bd.traitName).map(esc).join(', ')}</span>
      <span class="uits">${u.items.map((id, k) => `<button data-rmit="${k}" title="${esc(bdItemInfo(id).name)} 빼기">${itemImg(id)}</button>`).join('') || '<span class="muted small">아이템 없음 · 오른쪽 아이템을 누르면 끼워져요</span>'}</span></div>
    <div class="urow"><div class="seg2">${star(2)}${star(3)}</div>
      ${adaptorChamp(bdData(), c) ? `<div class="seg2" title="적응가: 공격력·주문력 중 높은 쪽을 써요. 형태를 정하면 자동 배분·다음 수 추천이 그 형태 아이템만 줘요"><span class="lbl">형태</span>${[['', '자동'], ['AD', 'AD 물리'], ['AP', 'AP 마법']].map(([v, l]) => `<button data-form="${v}" aria-pressed="${(u.form || '') === v}">${l}</button>`).join('')}</div>` : ''}</div>
    ${isRift(u) && alphaSlots() ? `<div class="formRow"><span class="lbl">협곡야수</span><button data-alpha aria-pressed="${!!u.alpha}">${tbadge(riftId(), u.alpha ? 'gold' : '', true)}${u.alpha ? '우두머리 표식 빼기' : '우두머리로 지정'}</button><span class="muted small">${esc(alphaBuff(c))}</span></div>` : ''}
    ${forms ? `<div class="formRow"><span class="lbl">${esc(c.base)} 형태</span>${forms.map(f => { const t = Object.keys(f.weights || {})[0]; return `<button data-f="${esc(f.id)}" aria-pressed="${f.id === u.id}">${tbadge(t, f.id === u.id ? 'gold' : '', true)}${esc(bd.traitName(t))}</button>`; }).join('')}</div>` : ''}`;
}

function bdRenderAlpha() {
  const { esc } = bd, box = bd$('bdAlpha'), k = alphaSlots();
  if (!k) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const icon = bdData().traits[riftId()]?.icon, list = alphaList(), slots = [];
  for (let n = 0; n < k; n++) {
    const x = list[n], c = x && bdChamp(x.u.id);
    slots.push(c
      ? `<div class="aslot on" data-alpha-from="${x.i}" draggable="true" title="끌어서 다른 협곡야수에게 · 밖으로 끌어내거나 × 로 빼기">${porImg(c)}<span class="atx"><b>${esc(cleanName(c))}</b><small>${esc(alphaBuff(c))}</small></span><button class="x" data-alpha-rm="${x.i}" aria-label="${esc(cleanName(c))} 우두머리 표식 빼기">×</button></div>`
      : `<div class="aslot" data-alpha-new draggable="true" role="button" tabindex="0" title="협곡야수 챔피언에게 끌어다 놓거나, 보드에서 챔피언을 고른 뒤 누르세요"><span class="atok">${icon ? `<img src="${esc(icon)}" alt="" draggable="false">` : ''}</span><span class="atx"><b>우두머리 표식</b><small>협곡야수 챔피언에게 끌어다 놓으세요</small></span></div>`);
  }
  box.innerHTML = `<div class="ahead"><b>협곡야수 우두머리</b><span class="muted small">표식을 받은 협곡야수는 고유 버프가 켜져요</span><label class="small"><input type="checkbox" id="bdAlphaAug"${bdState.alphaAug ? ' checked' : ''}> 증강으로 2명에게</label></div><div class="aslots">${slots.join('')}</div>`;
}

function bdRenderInv() {
  const { esc } = bd, S = bdState;
  bd$('bdInv').innerHTML = S.inv.length ? S.inv.map((id, k) => `<button data-k="${k}" title="${esc(bdItemInfo(id).name)} — 눌러서 빼기">${itemImg(id)}</button>`).join('')
    : '<span class="muted small">가진 아이템을 담아 두면 누구에게 줄지 나눠 줘요 · 재료나 어쩌다 생긴 완성 아이템을 담아 두세요 (챔피언을 고르지 않은 채 오른쪽 아이템을 누르거나 이 칸으로 끌어오기)</span>';
  const list = Object.entries(S.cells).map(([i, u]) => ({ i: Number(i), u, c: bdChamp(u.id) })).filter(x => x.c)
    .sort((a, b) => b.u.items.length - a.u.items.length || b.c.cost - a.c.cost);
  bd$('bdCarries').innerHTML = list.map(x => `<span class="cwrap${S.carries.has(x.i) ? ' on' : ''}"><button class="cchip" data-c="${x.i}" data-cost="${x.c.cost}" aria-pressed="${S.carries.has(x.i)}" aria-label="${esc(cleanName(x.c))}에게 아이템 주기">${x.c.icon ? `<img src="${esc(x.c.icon)}" alt="">` : ''}</button>${esc(cleanName(x.c))}</span>`).join('')
    || '<span class="muted small">보드에 챔피언을 올리면 여기에 나와요</span>';
}

function bdRenderPalette() {
  const { esc, traitName } = bd, data = bdData(), S = bdState;
  for (const b of bd$('bdSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === S.pane);
  bd$('bdChampPane').hidden = S.pane !== 'champ'; bd$('bdItemPane').hidden = S.pane !== 'item';
  if (S.pane === 'champ') {
    for (const b of bd$('bdPtabs').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.p === S.pgroup);
    bd$('bdCosts').innerHTML = [0, 1, 2, 3, 4, 5].map(k => `<button data-k="${k}" ${k ? `data-cost="${k}"` : ''} aria-pressed="${S.costF === k}">${k || '전체'}</button>`).join('');
    const q = bd$('bdFilter').value.trim();
    const on = new Set(Object.values(S.cells).map(u => champKey(bdChamp(u.id))));
    const match = c => (!S.costF || c.cost === S.costF) && (!q || c.name.includes(q) || c.traits.some(t => traitName(t).includes(q)));
    const byCost = (a, b) => a.cost - b.cost || cleanName(a).localeCompare(cleanName(b), 'ko');
    // exact = 계열·직업별에서 형태 챔피언을 그 형태 그대로 (개화 칸의 럭스 = 개화 럭스)
    const card = (c, exact) => {
      const fm = isForm(c), shown = fm && !exact ? bestForm(c) : c;
      return `<button class="pc${on.has(champKey(c)) ? ' on' : ''}" data-id="${esc(c.id)}"${exact && fm ? ' data-exact="1"' : ''} draggable="true">${porImg(shown)}${esc(cleanName(c))}</button>`;
    };
    const grp = (head, cards, key = '') => cards.length ? `<div class="pgrp" data-g="${esc(key)}">${head ? `<h5>${head}</h5>` : ''}<div class="prow">${cards.join('')}</div></div>` : '';
    const firstOfForm = c => !isForm(c) || formGroup(c).find(match) === c;
    let html = '';
    if (S.pgroup === 'cost') {
      const list = data.champions.filter(match).filter(firstOfForm).sort(byCost);
      html = [1, 2, 3, 4, 5].map(k => grp(S.costF ? '' : `${k}코스트`, list.filter(c => c.cost === k).map(c => card(c)))).join('');
    } else {
      const traits = Object.keys(data.traits).filter(t => traitType(t) === S.pgroup).sort((a, b) => traitName(a).localeCompare(traitName(b), 'ko'));
      html = traits.map(t => grp(`${tbadge(t, '', true)}${esc(traitName(t))} <small>${data.traits[t].breakpoints.join(' · ')}</small>`,
        data.champions.filter(c => c.traits.includes(t) && match(c)).sort(byCost).map(c => card(c, true)), t)).join('');
      if (S.pgroup === 'origin') html += grp('고유 시너지 <small>혼자서 켜지는 시너지</small>', data.champions.filter(c => match(c) && !isForm(c) && c.traits.some(t => traitType(t) === 'unique')).sort(byCost).map(c => card(c)), 'unique');
    }
    bd$('bdPal').innerHTML = html || '<p class="muted small">찾는 챔피언이 없어요.</p>';
  } else {
    const groups = { normal: ['완성', data.items], radiant: ['찬란한', data.radiants || []], artifact: ['유물', [...(data.artifacts || [])].sort((a, b) => a.name.localeCompare(b.name, 'ko'))], component: ['재료', data.components || []], emblem: ['상징', data.emblems] };
    const q = bd$('bdItemFilter').value.trim();
    bd$('bdItabs').innerHTML = Object.entries(groups).filter(([, x]) => x[1].length).map(([g, x]) => `<button data-g="${g}" aria-pressed="${!q && S.igroup === g}">${x[0]}</button>`).join('');
    const list = q ? Object.values(groups).flatMap(x => x[1]).filter(i => i.name.includes(q)) : groups[S.igroup][1];
    const u = S.sel != null && S.cells[S.sel];
    bd$('bdItip').innerHTML = u ? `누르면 <b>${esc(cleanName(bdChamp(u.id)))}</b>에게 끼워요 (${u.items.length}/3)` : '누르면 남은 아이템 칸에 담겨요 · 챔피언을 고르면 그 챔피언에게 끼워요';
    bd$('bdItems').innerHTML = list.map(i => `<button class="ic" data-id="${esc(i.id)}" data-item="${esc(i.id)}" draggable="true">${i.icon ? `<img src="${esc(i.icon)}" alt="" draggable="false" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}${esc(i.name)}</button>`).join('') || '<p class="muted small">없어요</p>';
  }
}

// 챔피언 툴팁: 스킬 이름·마나 / 시너지 / 능력치 / 랭커 평균·3신기 (스킬 설명은 Set 18 데이터에 수치가 없어 뺌 — 11/16 사용자 판단)
const ROLE = { TANK: '탱커', AP: '마법 딜러', AD: '물리 딜러', FIGHTER: '전사' };
function tipHtml(c) {
  const { esc, traitName } = bd, data = bdData(), s = c.stats, ab = c.ability;
  const st = data.unitStats?.[c.weights && c.base && /lux/i.test(c.id) ? 'da_lux18_base' : c.id.toLowerCase()];
  const b = st?.builds?.find(x => x.games >= 3);
  return `<div class="th">${porImg(c)}<div><b>${esc(cleanName(c))}</b><div class="sub">${c.cost}코스트 · ${ROLE[c.role] || '—'}${c.range ? ` · 기본 공격 사거리 ${c.range}칸` : ''}</div>
      <div class="trs">${c.traits.map(t => `<span>${tbadge(t, '', true)}${esc(traitName(t))}${(c.weights?.[t] || 1) > 1 ? ' ×' + c.weights[t] : ''}</span>`).join('')}</div></div></div>
    ${ab?.name ? `<hr><div class="ab"><b>${esc(ab.name)}</b>${s?.mana ? `<span class="mana">마나 ${s.startMana || 0}/${s.mana}</span>` : ''}</div>` : ''}
    ${c.traits.includes(riftId()) && alphaBuff(c) ? `<hr><div class="buff">우두머리 표식: ${esc(alphaBuff(c))}</div>` : ''}
    ${s ? `<hr><div class="st"><span>체력 <b>${s.hp ?? '—'}</b></span><span>공격력 <b>${s.ad ?? '—'}</b></span><span>방어력 <b>${s.armor ?? '—'}</b></span><span>마저 <b>${s.mr ?? '—'}</b></span><span>공속 <b>${s.as ?? '—'}</b></span></div>` : ''}
    ${bd.itemHabitHtml ? bd.itemHabitHtml(c, true) : ''}
    ${st?.games ? `<hr><div class="rk">랭커 평균 <b>${st.avgPlace.toFixed(2)}등</b> · ${st.games.toLocaleString()}판${b ? ` · 3신기 ${b.items.map(id => itemImg(id)).join('')}` : ''}</div>` : ''}`;
}

function bdRenderSaved() {
  const list = bdLoadList();
  bd$('bdLoad').innerHTML = `<option value="">불러오기 (${list.length})</option>` + list.map(x => `<option>${bd.esc(x.name)}</option>`).join('');
}

// ---------------- 저장·코드 ----------------
function bdLoadList() { try { return JSON.parse(localStorage.getItem(BD_SAVE_KEY) || '[]'); } catch { return []; } }

// 코드 형식: [[칸번호, 챔피언id, 별, [아이템...], 형태?], ...] 을 JSON → base64 (한글 안전). 예전 코드도 그대로 읽힘
function bdEncode() {
  // 6번째 값 = 협곡야수 우두머리 순서 (형태가 없으면 5번째는 null)
  const arr = Object.entries(bdState.cells).map(([i, u]) => [Number(i), u.id, u.star, u.items, ...(u.form || u.alpha ? [u.form || null] : []), ...(u.alpha ? [u.alpha] : [])]);
  return btoa(unescape(encodeURIComponent(JSON.stringify(arr))));
}
function bdDecode(code) {
  try {
    const arr = JSON.parse(decodeURIComponent(escape(atob(code))));
    const cells = {};
    for (const [i, id, star, items, form, alpha] of arr) if (bdChamp(id)) cells[i] = { id, star: star === 3 ? 3 : 2, items: items || [], ...(form === 'AD' || form === 'AP' ? { form } : {}), ...(alpha > 0 ? { alpha: Number(alpha) } : {}) };
    bdState.alphaAug = Object.values(cells).filter(u => u.alpha).length > 1;
    bdState.cells = cells; bdState.plants = {}; bdState.sel = null; bdState.carries = new Set();
    bd.openTab('builder'); bdRender();
    return true;
  } catch { return false; }
}

function bdToast(msg) {
  const t = bd$('bdToast');
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
// 게임 팀 코드(팀 플래너)용 챔피언 번호 — tools/planner-codes.mjs 가 만든 파일 (11/17)
let plannerCodes = null;
fetch('data/planner-codes.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) })
  .then(r => (r.ok ? r.json() : null)).then(j => { plannerCodes = j; }).catch(() => {});
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
  $('setLabel').textContent = `전략적 팀 전투 · 세트 ${data.set.number ?? ''}`; // 11/17: 이름을 TFT 덱 메이커로 (롤토체스는 별명)
  $('specialWrap').hidden = !specialIds().length;
  $('specialName').textContent = specialName();
  renderAllPickers();
  $('results').innerHTML = '';
  bdOnData();
  renderMeta(); // 첫 화면(메타 덱 탭)이 비어 보이지 않도록 데이터가 오면 바로 그림
  renderHome();
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
    `<span class="chip gold">${img(state.data.emblems.find(e => e.trait === t)?.icon)}${esc(traitName(t))} 상징 ×${n}<button data-trait="${esc(t)}" aria-label="빼기">✕</button></span>`).join('');
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
function runSearch(fn, override = null) {
  const base = override || opts();
  const special = specialIds();
  const mode = override ? 'both' : $('specialMode').value; // 탭 위 설정 줄을 안 쓰는 화면(배치툴)은 기본값
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

function run(btn, title, fn, extra = null) { // extra() → { pre, post } (엔진 결과 앞·뒤에 붙일 HTML)
  if (!state.data) { setStatus('먼저 데이터를 불러와 주세요.', true); $('databar').open = true; return; }
  btn.disabled = true;
  $('results').innerHTML = `<div class="empty">조합을 계산하고 있어요…</div>`;
  setTimeout(() => {           // 로딩 문구가 먼저 그려지도록
    const t0 = performance.now();
    try {
      const decks = runSearch(fn);
      renderResults(title, decks, performance.now() - t0, extra ? extra() : {});
    } catch (e) {
      console.error(e);
      $('results').innerHTML = `<div class="empty">계산 중 오류가 났어요: ${esc(e.message)}</div>`;
    } finally { btn.disabled = false; }
  }, 30);
}

function renderResults(title, decks, ms, { pre = '', post = '' } = {}) {
  if (!decks.length) {
    $('results').innerHTML = `${pre}<div class="empty">조건에 맞는 덱을 찾지 못했어요. 목표 단계를 낮추거나 레벨을 올려 보세요.</div>${post}`;
    return;
  }
  const byId = new Map(state.data.champions.map(c => [c.id, c]));
  $('results').innerHTML = `${pre}
    <div class="resultHead"${pre ? ' style="margin-top:28px"' : ''}><h2>${esc(title)}</h2><span class="legend">${(ms / 1000).toFixed(1)}초 · 점선 테두리 = 상징 덕분에 열린 단계</span></div>
    ${decks.map((d, i) => deckCard(d, i, byId)).join('')}${post}`;
}

// ---- 상징 팀 메이커: 랭커가 이 상징으로 쓴 덱 (11/17 사용자: 요정+날렵이 상징이면 렝가 덱이 떠올랐는데 추천엔 없음) ----
// 고른 상징을 모두 낀 랭커 보드(weights.emblemBoards, 이번 패치)를 덱(주력 시너지|핵심 캐리)별로 합침.
// 엔진 추천 순위는 그대로 두고 아래에 따로 — 랭커 기록이 엔진과 다르거나 성적이 낮아도 그 자체로 정보
const EMB_DECK_MIN = 3, EMB_DECK_LOW = 10;
function emblemRankerDecks(picked) {
  const d = state.data, eb = state.weights?.emblemBoards;
  if (!eb || !picked.length || !$('useWeights').checked || state.weights.setNumber !== d.set.number) return null;
  const need = {};
  for (const t of picked) need[t] = (need[t] || 0) + 1;
  const traitOfItem = id => d.emblems.find(e => e.id === id || (e.ids || []).includes(id))?.trait;
  const acc = {};
  for (const [combo, rows] of Object.entries(eb)) {
    const have = {};
    for (const it of combo.split('+')) { const t = traitOfItem(it); if (t) have[t] = (have[t] || 0) + 1; }
    // 11/17 사용자: 고른 상징 그대로만 쓴 보드 (다른 상징이 더 있어야 되는 보드는 의미 없음 — 상징은 쉽게 못 구함)
    if (Object.keys({ ...need, ...have }).some(t => (have[t] || 0) !== (need[t] || 0))) continue;
    const extra = { ...have };
    for (const [t, n] of Object.entries(need)) extra[t] -= n;
    const extraKey = Object.entries(extra).filter(([, n]) => n > 0).map(([t, n]) => traitName(t) + (n > 1 ? ` ${n}개` : '')).join(', ');
    for (const [dk, games, avg, top4, board] of rows) {
      const a = (acc[dk] ||= { key: dk, games: 0, sum: 0, top4: 0, board: null, extras: {} });
      a.games += games; a.sum += games * avg; a.top4 += games * top4;
      a.extras[extraKey] = (a.extras[extraKey] || 0) + games;
      if (board && (!a.board || board.same > a.board.same)) a.board = board;
    }
  }
  const all = Object.values(acc);
  const total = all.reduce((s, a) => s + a.games, 0);
  const byLower = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
  const decks = all.filter(a => a.games >= EMB_DECK_MIN && a.board).sort((x, y) => y.games - x.games).slice(0, 3)
    .map(a => emblemRankerDeck(a, byLower)).filter(Boolean);
  return { decks, total: Math.round(total) };
}
function emblemRankerDeck(a, byLower) {
  const d = state.data;
  const [trait, carryLow] = a.key.split('|');
  const units = a.board.units;
  const allEmb = {};
  for (const u of units) for (const it of u.items) if (/emblem/i.test(it)) allEmb[it] = 1;
  const real = realBoardTeam({ board: { units }, core: [], emblems: allEmb, trait }, byLower);
  if (!real) return null;
  const { team, emblems } = real;
  const keyOf = c => (c.base || c.id).toLowerCase();
  const champOf = id => { const c = byLower.get(id); return c && team.find(x => keyOf(x) === keyOf(c)); };
  const carry = carryLow ? champOf(carryLow) : null;
  const ev = evaluateTeam(team, d, { carryIds: carry ? [carry.id] : [], emblems });
  // 상징은 랭커가 실제로 준 챔피언에게 (엔진 배정 대신)
  const holders = {};
  for (const u of units) for (const it of u.items) {
    const e = d.emblems.find(x => x.id === it || (x.ids || []).includes(it)); const c = champOf(u.id);
    if (e && c) (holders[e.trait] ||= []).push(c.id);
  }
  for (const x of ev.assignment || []) { const h = holders[x.trait]?.shift(); if (h) { x.holder = h; x.misfit = false; x.why = '랭커가 실제로 준 챔피언'; } }
  const items = {}, unitInfo = {};
  for (const u of units) {
    const c = champOf(u.id); if (!c) continue;
    items[c.id] = u.items.filter(it => !/emblem/i.test(it)).map(it => { const info = d.itemInfo?.[it.toLowerCase()]; return { id: it, name: info?.name || it, icon: info?.icon }; });
    unitInfo[c.id] = { rate: 1, star3: u.star >= 3 ? 1 : 0 };
  }
  const avg = a.sum / a.games, games = Math.round(a.games);
  const low = games < EMB_DECK_LOW ? ' <span class="lowconf" title="판수가 적어 참고용">표본 적음</span>' : '';
  const extras = Object.entries(a.extras).filter(([k]) => k).sort((x, y) => y[1] - x[1])[0];
  const name = carry ? `${trait && d.traits[trait] ? esc(traitName(trait)) + ' · ' : ''}${esc(carry.name)}` : esc(traitName(trait) || '랭커 덱');
  // 고른 상징을 캐리가 아닌 한 챔피언이 모두 들었으면 이름에 표시 (요정+날렵이 → 렝가)
  const pickedHolders = new Set(state.emblems.map(t => (ev.assignment || []).find(x => x.trait === t && x.holder)?.holder).filter(Boolean));
  const embHolder = pickedHolders.size === 1 && ![...pickedHolders].includes(carry?.id) ? team.find(c => pickedHolders.has(c.id)) : null;
  return {
    ...ev, team: [...team].sort((x, y) => x.cost - y.cost), items, unitInfo,
    core: { carry: carry?.id, tank: null }, noSpecialTag: true,
    title: `${name}${embHolder ? ` <span class="tag" title="고른 상징을 랭커가 모두 이 챔피언에게 줬어요">상징은 ${esc(embHolder.base && embHolder.weights ? embHolder.base : embHolder.name)}</span>` : ''} <span class="tag soft">랭커 실제 보드</span>`,
    metaInfo: `랭커 <b>${games}판</b> · 평균 <b>${avg.toFixed(2)}등</b> · 순방 ${Math.round(a.top4 / a.games * 100)}%${low} · 보이는 보드는 같은 구성 ${a.board.same}판 중 가장 잘한 판${extras && extras[1] >= a.games * 0.3 ? ` · ${esc(extras[0])} 상징도 함께 낀 판 ${Math.round(extras[1] / a.games * 100)}%` : ''}`,
  };
}
// ---- 상징 팀 메이커: 이 상징을 쓰기 좋은 메타 덱 (11/17 사용자: 상징을 주면 핵심 유닛 기준으로 — 억지 시너지(3협곡야수+코그모로 적응가)는 의미 없음) ----
// 티어표 덱(랭커 실제 보드)을 그대로 두고 상징만 더함. 상징이 그 덱에서 쓸모 있을 때만:
//   ① 랭커가 그 덱에서 이 상징을 쓴 판 비율(m.emblems) 10% 이상, 또는 ② 상징으로 그 시너지 단계가 실제로 오름
// 상징을 받을 챔피언 = 그 시너지가 없는 챔피언 중 랭커가 이 상징을 가장 많이 준 챔피언(전체 기록), 없으면 엔진 배정
const EMB_META_MIN = 15, EMB_USED = 0.1, EMB_ACTIVATE = 0.25; // 꺼진 시너지를 상징으로 최저 단계만 켜는 건 랭커가 그 덱에서 25% 이상 쓸 때만 (소환사 이즈리얼에 엄호대 2 = 10%)
function emblemMetaDecks(picked) {
  const d = state.data;
  if (!metaAvailable() || !picked.length) return [];
  const itemOf = t => d.emblems.find(e => e.trait === t);
  const wEmb = state.weights?.emblems || {};
  const out = [];
  for (const g of groupedDecks()) {
    if ((g.tierGames ?? tierGames(g.m) ?? g.m.games) < EMB_META_MIN && g.m.games < EMB_META_MIN) continue;
    let best = null;
    for (const v of [g, ...(g.variants || [])]) {
      const carryId = v.carryChampId || v.core?.carry;
      const base = (v.assignment || []).filter(a => a.holder).map(a => a.trait);
      // 랭커 보드에 이미 그 상징이 있으면 내 상징이 그 자리를 채움 (같은 상징을 하나 더 얹지 않음)
      const rest = [...base], filled = [];
      for (const t of picked) { const i = rest.indexOf(t); if (i >= 0) { rest.splice(i, 1); filled.push(t); } }
      const extra = [...picked]; for (const t of filled) extra.splice(extra.indexOf(t), 1);
      // 11/17 사용자: 상징은 쉽게 못 구함 → 고른 상징만으로 되는 덱만. 랭커 보드가 다른 상징(rest)에 기대면
      // 그 상징을 빼고도 주력 시너지 단계가 그대로일 때만 (빼면 단계가 떨어지는 덱 = 다른 상징이 있어야 되는 덱 → 제외)
      const evBase = evaluateTeam(v.team, d, { carryIds: carryId ? [carryId] : [], emblems: base });
      const ev0 = evaluateTeam(v.team, d, { carryIds: carryId ? [carryId] : [], emblems: filled });
      const ev1 = evaluateTeam(v.team, d, { carryIds: carryId ? [carryId] : [], emblems: [...picked] });
      const mainTier = ev => ev.traits.find(x => x.id === v.m.trait)?.tier || 0;
      if (rest.length && mainTier(ev1) < mainTier(evBase)) continue;
      // 고른 상징이 아닌 상징을 랭커가 이 덱에서 절반 넘게 쓰면 그 상징이 필요한 덱
      const needsOther = Object.entries(v.m.emblems || {}).some(([id, r]) => r >= 0.5 && !picked.includes(d.emblems.find(e => e.id === id || (e.ids || []).includes(id))?.trait));
      if (needsOther) continue;
      const tierOfT = (ev, t) => ev.traits.find(x => x.id === t)?.tier || 0;
      const why = [];
      let ok = true, fit = 0;
      // 점수: 랭커가 이 덱에서 이 상징을 쓴 비율이 가장 중요, 주력 시너지면 가산, 단계 상승은 작게, 덱 성적은 보조
      // (11/17 사용자: 사냥꾼 상징이면 사냥꾼 시비르 — 다른 강한 덱에 사냥꾼 하나 더 붙이는 건 억지)
      for (const t of [...new Set(picked)]) {
        const e = itemOf(t), used = Math.max(0, ...[e?.id, ...(e?.ids || [])].map(id => v.m.emblems?.[id] || 0));
        const t0 = tierOfT(ev0, t), t1 = tierOfT(ev1, t);
        if (filled.includes(t)) why.push(`랭커도 이 덱에서 ${traitName(t)} 상징을 ${Math.round(used * 100)}% 써요 (상징 자리)`);
        else if (t1 > t0) { const c0 = ev0.traits.find(x => x.id === t)?.count || 0, c1 = ev1.traits.find(x => x.id === t)?.count || 0; why.push(`${traitName(t)} ${c0} → ${c1}${used >= EMB_USED ? ` · 랭커도 이 덱에서 ${Math.round(used * 100)}%` : ''}`); fit += 0.3; }
        else if (used >= EMB_USED) why.push(`랭커도 이 덱에서 ${traitName(t)} 상징 ${Math.round(used * 100)}%`);
        fit += 2 * used + (v.m.trait === t ? 1 : 0);
        // 상징은 실제로 무언가를 바꿔야 함 (11/17 사용자: 엄호대+주문술사 → 5주문술사(2/4/6 사이), 3엄호대·1주문술사 덱이 나옴 —
        // "랭커도 10% 쓴다"만으로 통과시켰던 게 원인): 랭커 보드의 상징 자리를 채우거나, 그 시너지 단계를 올려야 함.
        // 꺼져 있던 시너지를 최저 단계로만 켜는 건 랭커도 그 덱에서 그 상징을 쓸 때만 (기원자 알룬에 사냥꾼 2 = 억지)
        if (!filled.includes(t) && !(t1 > t0 && (t0 > 0 || used >= EMB_ACTIVATE))) ok = false;
      }
      if (!ok) continue;
      // 상징 받을 챔피언: 랭커가 이 상징을 가장 많이 준 챔피언(그 시너지가 없는)
      for (const a of ev1.assignment || []) {
        if (!picked.includes(a.trait)) continue;
        const e = itemOf(a.trait), holders = wEmb[e?.id]?.holders || {};
        const cands = v.team.filter(c => !c.traits.includes(a.trait) && (v.items?.[c.id]?.length || 0) < 3);
        const pick = cands.sort((x, y) => (holders[y.id.toLowerCase()] || 0) - (holders[x.id.toLowerCase()] || 0))[0];
        if (pick && (holders[pick.id.toLowerCase()] || 0) > 0) { a.holder = pick.id; a.misfit = false; a.why = `랭커가 ${traitName(a.trait)} 상징을 많이 준 챔피언`; }
      }
      const score = fit + 0.5 * (4.5 - shrinkAvg(v.m.avgPlace, v.m.patchGames || v.m.games));
      if (!best || score > best.score) best = { v, ev1, why, score };
    }
    if (!best) continue;
    const { v, ev1, why } = best;
    const pickedNames = picked.map(t => traitName(t));
    const holderNames = [...new Set((ev1.assignment || []).filter(a => picked.includes(a.trait) && a.holder).map(a => v.team.find(c => c.id === a.holder)?.name).filter(Boolean))];
    out.push({ score: best.score, deck: {
      ...v, traits: ev1.traits, assignment: ev1.assignment, usedEmblems: ev1.usedEmblems, noSpecialTag: true,
      title: `${(v.title || esc(deckName(g))).replace(' · 이 보드는 미사용', '')}${g.variants?.length ? ` <span class="tag soft">${esc(deckName(g))} · 버전 ${g.variants.length + 1}개</span>` : ''}`,
      metaInfo: `${v.metaInfo || ''}<br><span class="embWhy">${esc(pickedNames.join(' + '))} 상징${holderNames.length ? ` → <b>${esc(holderNames.join(', '))}</b>` : ''} · ${esc(why.join(' · '))}</span>`,
    } });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4).map(x => x.deck);
}
function emblemMetaHtml() {
  const decks = emblemMetaDecks(state.emblems);
  const byId = new Map(state.data.champions.map(c => [c.id, c]));
  const head = `<div class="resultHead"><h2>이 상징을 쓰기 좋은 메타 덱</h2><span class="legend">랭커 메타 덱의 핵심 유닛은 그대로, 고른 상징만으로 되는 덱만 · 상징으로 단계가 오르거나 랭커가 그 덱에서 쓴 경우</span></div>`;
  if (!metaAvailable()) return '';
  if (!decks.length) return head + `<div class="empty">이 상징이 단계를 올려 주는 메타 덱이 없어요. 아래 랭커 기록과 시너지 계산 추천을 참고하세요.</div>`;
  return head + decks.map((x, i) => deckCard(x, i, byId)).join('');
}

function emblemRankerHtml() {
  const r = emblemRankerDecks(state.emblems);
  if (!r) return '';
  const byId = new Map(state.data.champions.map(c => [c.id, c]));
  const names = state.emblems.map(t => traitName(t)).join(' + ');
  const head = `<div class="resultHead" style="margin-top:28px"><h2>랭커가 이 상징 조합으로 쓴 보드</h2><span class="legend">${esc(names)} 상징만 낀 랭커 보드 ${r.total}판 · 이번 패치 · 판수 많은 순</span></div>`;
  if (!r.decks.length) return head + `<div class="empty">이 상징만 낀 랭커 덱이 ${EMB_DECK_MIN}판 이상인 경우가 없어요. 위의 추천은 시너지 계산 결과예요.</div>`;
  return head + r.decks.map((x, i) => deckCard(x, i, byId)).join('');
}

// 덱 카드의 "배치툴로 보기" 버튼이 참조할 덱 목록
const deckRegistry = [];
/** 덱 카드 (11/16 새 디자인): 덱 목록·다음 수 추천·상징 팀 메이커·아이템으로 찾기 공용 */
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
  const pct = v => Math.round(v * 100) + '%';
  const units = d.team.map(c => {
    const added = d.board?.added.includes(c.id);
    const ui = d.unitInfo?.[c.id];
    const isCarry = c.id === carryId, isTank = c.id === tankId;
    const opt = ui && ui.rate < 0.5 && !isCarry && !isTank;
    const cap = isCarry ? '핵심' : isTank ? '탱커' : added ? '새로 넣기' : ui && ui.rate < 0.05 ? '드물게' : opt ? `${pct(ui.rate)} 사용` : c.base && c.weights ? `${traitName(Object.keys(c.weights)[0])} 형태` : '';
    const tip = `${c.name} · ${c.cost}코 · ${(c.role === 'AD' || c.role === 'AP') && (c.range ?? 4) < 3 ? '근접 ' : ''}${roleKo[c.role] || ''}${c.weights ? ' · ' + Object.entries(c.weights).map(([t, n]) => `${traitName(t)} ${n}명분`).join(', ') : ''}${c.slots > 1 ? ` · ${c.slots}칸` : ''}${ui ? ` · 이 덱에서 ${pct(ui.rate ?? 1)} 사용${ui.star3 ? ` · 3성 ${pct(ui.star3)}` : ''}` : ''}`;
    const embs = (emb[c.id] || []).map(a => `<span class="embb${a.misfit ? ' misfit' : ''}" title="${esc(traitName(a.trait))} 상징${a.misfit ? ' — 어울리는 챔피언이 없어 임시로 배정' : ''}${a.why ? ' · ' + esc(a.why) : ''}">${traitBadge(a.trait, 'gold', true)}</span>`).join('');
    const its = (d.items?.[c.id] || []).map(it => `<span class="bi" data-item="${esc(it.id)}">${it.icon ? `<img src="${esc(it.icon)}" alt="${esc(it.name)}">` : esc(it.name.slice(0, 2))}</span>`).join('');
    return `<div class="dcU${isCarry ? ' carry' : ''}${isTank ? ' tank' : ''}${opt ? ' opt' : ''}${added ? ' added' : ''}" title="${esc(tip)}">
      <div class="stars">${ui && ui.star3 >= 0.4 ? '★★★' : ''}</div>
      <span class="pwrap">${hexPor(c)}${embs}${added ? '<i class="plus">+</i>' : ''}</span>
      <span class="nm">${esc(c.base && c.weights ? c.base : c.name)}</span><em>${cap}</em>${its ? `<span class="dcIts">${its}</span>` : ''}
    </div>`;
  }).join('');
  const order = { prism: 0, gold: 1, silver: 2, bronze: 3, '': 4 };
  const traits = d.traits.filter(t => t.tier > 0 || t.count >= 2).map(t => ({ ...t, st: traitStyle(t.tier, t.breakpoints.length) }))
    .sort((a, b) => (b.tier > 0) - (a.tier > 0) || (a.breakpoints.length === 1) - (b.breakpoints.length === 1) || order[a.st] - order[b.st] || b.count - a.count)
    .map(t => `<span class="tTr${t.tier ? '' : ' off'}${t.emblemOnly ? ' embOnly' : ''}" title="${esc(t.name)} ${t.breakpoints.join('/')}${t.emblemOnly ? ' · 상징이 있어야 켜지는 단계' : ''}${t.stat ? ` · 실제 경기 평균 ${t.stat.avgPlace}등 · ${t.stat.games}판` : ''}">${traitBadge(t.id, t.st)}<b>${t.count}</b>${esc(t.name)}${t.bonus ? `${bonusLabel(t)}` : ''}${t.breakpoints.length > 1 ? `<span class="bps2">${t.breakpoints.map((b, k) => k === t.tier - 1 ? `<b>${b}</b>` : b).join(' ')}</span>` : ''}</span>`).join('');
  const builds = [carryId, tankId, ...(d.m ? holderIds(d, carryId, tankId) : [])].filter(Boolean).map(id => {
    const c = byId.get(id); const own = d.builds?.[id], b = c && (own || buildsFor(c)[0]);
    return b ? `<div class="dcBuild"><span class="who">${id === carryId ? '핵심' : id === tankId ? '탱커' : subRole(b)} ${esc(c.name)}</span>${buildRow(b, !own && !!d.m)}</div>` : '';
  }).join('');
  const meta = d.metaInfo || `점수 ${d.score.toFixed(1)} · 총 ${d.gold}골드${d.usedEmblems ? ` · 상징 ${d.usedEmblems}개 사용` : ''}${d.wastedEmblems ? ` · <span style="color:var(--danger)">상징 ${d.wastedEmblems}개는 단계를 못 올림</span>` : ''}${unused ? ` · <span style="color:var(--danger)">상징 ${unused}개 못 씀</span>` : ''}${d.desiredMet === false ? ' · 목표 미달성' : ''}`;
  return `<article class="dcard${d.desiredMet === false ? ' warn' : ''}">
    <header class="dcHead">
      <span class="dcRank">${i + 1}</span>
      <div class="dcTitle">${goal}${specialIds().length && !d.noSpecialTag && !d.team.some(c => c.special) ? ` <span class="tag soft">${esc(specialName())} 없음</span>` : ''}</div>
      <button class="btn small toBuilder" data-reg="${reg}" title="이 덱을 배치툴에 세우기">배치툴에서 열기</button>
    </header>
    <p class="dcMeta">${carryId && !d.carry ? `핵심 <b>${esc(nameOf(carryId))}</b>${tankId ? ` · 탱커 <b>${esc(nameOf(tankId))}</b>` : ''} · ` : ''}${meta}</p>
    ${d.craft ? craftNote(d.craft) : ''}
    <div class="dcUnits">${units}</div>
    ${d.board?.removed.length ? `<p class="dcRemoved">빼는 챔피언 ${d.board.removed.map(id => { const c = byId.get(id); return c ? `<span class="mini out" title="${esc(c.name)}">${hexPor(c)}<i>−</i><small>${esc(c.base && c.weights ? c.base : c.name)}</small></span>` : ''; }).join('')}</p>` : ''}
    ${builds ? `<div class="dcBuilds">${builds}</div>` : ''}
    <div class="tTraits">${traits}</div>
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
  $('dexKind').onclick = e => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    dexKind = b.dataset.kind; dexSel = null; $('buildFilter').value = ''; renderBuilds();
  };
  // 도감: 목록 타일 → 상세, 상세 안의 챔피언·아이템·시너지 링크 → 그 항목으로 이동
  $('panel-builds').addEventListener('click', e => {
    const a = e.target.closest('[data-dex]'); if (!a) return;
    const [kind, id] = a.dataset.dex.split(':');
    if (kind !== dexKind) { dexKind = kind; $('buildFilter').value = ''; }
    dexSel = id; renderBuilds();
    if (innerWidth <= 980) $('dexDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('.toBuilder'); if (!b) return;
    const d = deckRegistry[Number(b.dataset.reg)];
    if (d) { bdOpenDeck(d); window.scrollTo({ top: 0 }); }
  });
  bindItemTips();
  initBuilder({
    getData: () => state.data, esc, traitName, roleKo, buildsFor, itemHabitHtml, plannerCodes: () => plannerCodes,
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
  $('patchChips').onclick = e => { const b = e.target.closest('[data-patch]'); if (b) renderPatch(b.dataset.patch); };
  $('patchView').addEventListener('click', e => { const f = e.target.closest('#pnFilters [data-f]'); if (f) { pnFilter = f.dataset.f; renderPatch(); } });
  $('metaSort').onchange = renderMeta;
  for (const id of ['metaKind', 'metaTrait']) $(id).onchange = renderMeta;
  $('metaQ').oninput = renderMeta;
  $('metaPatchChips').onclick = e => { const b = e.target.closest('button[data-mp]'); if (!b) return; metaPatchSel = b.dataset.mp === curPatch() ? null : b.dataset.mp; renderMeta(); };
  $('metaView').onclick = e => { const b = e.target.closest('button[data-view]'); if (!b) return; metaView = b.dataset.view; renderMeta(); };
  $('metaTiers').addEventListener('click', e => {
    const f = e.target.closest('#tierFilters button');
    if (f) { tierFilter = f.dataset.f; renderMeta(); return; }
    const b = e.target.closest('.dk'); if (!b) return;
    const x = tierDecks[Number(b.dataset.k)]; if (!x) return;
    tierSel = deckName(x) + '|' + deckType(x);
    for (const c of $('metaTiers').querySelectorAll('.dk')) c.setAttribute('aria-pressed', c === b);
    const byId = new Map(state.data.champions.map(c => [c.id, c]));
    const el = $('tierDetail'); el.innerHTML = tierDetailHtml(x, byId);
    el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
    if (innerWidth <= 980) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('metaMin').onchange = renderMeta;
  $('btnSample').onclick = async () => {
    const raw = window.TFT_SAMPLE || await (await fetch('data/sample-cdragon.json')).json();
    useRaw(raw, '샘플 데이터 (가상 세트, 실제 게임과 다름)');
  };

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    if (!t.classList.contains('active')) window.scrollTo({ top: 0 });
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== `panel-${t.dataset.tab}`);
    if (t.dataset.tab === 'home') renderHome();
    if (t.dataset.tab === 'builds') renderBuilds();
    if (t.dataset.tab === 'meta') renderMeta();
    if (t.dataset.tab === 'patch') renderPatch();
    if (t.dataset.tab === 'builder') bdRender();
    $('results').hidden = ['home', 'meta', 'patch', 'builds', 'builder'].includes(t.dataset.tab);
    // 레벨·코스트·5코스트·특수 기물 설정은 덱을 새로 짜는 탭에서만 의미가 있음 (사용자 피드백 11/15: 메타 덱에도 떠서 헷갈림)
    // 11/17: 옵션은 상징 팀 메이커 안 "시너지 계산 추천 설정" 접기로 옮김 (패널과 함께 보이고 숨음)
    $('results').innerHTML = '';
  });

  // 홈 (11/18)
  $('homeView').addEventListener('click', e => {
    const emb = e.target.closest('[data-home-emb]');
    if (emb) { // 상징 하나 → 상징 팀 메이커 바로 실행
      openTab('emblem'); state.emblems = [emb.dataset.homeEmb]; renderEmblems(); $('runEmblem').click(); return;
    }
    const deck = e.target.closest('[data-home-deck]');
    if (deck) { tierSel = deck.dataset.homeDeck; tierFilter = 'all'; metaView = 'tier'; metaPatchSel = null; openTab('meta'); return; }
    const go = e.target.closest('[data-home-go]');
    if (go) {
      const [tab, arg] = go.dataset.homeGo.split(':');
      if (tab === 'patch' && arg) $('patchChips').dataset.chosen = arg;
      openTab(tab); return;
    }
    const arrow = e.target.closest('[data-home-scroll]');
    if (arrow) { const row = $('homeDecks'); row.scrollBy({ left: Number(arrow.dataset.homeScroll) * row.clientWidth * 0.8, behavior: 'smooth' }); }
  });

  // 상징
  $('emblemFilter').oninput = renderEmblems;
  $('emblemGrid').onclick = e => { const b = e.target.closest('[data-trait]'); if (!b) return; state.emblems.push(b.dataset.trait); renderEmblems(); };
  $('emblemPicked').onclick = e => { const b = e.target.closest('button[data-trait]'); if (!b) return; removeOne(state.emblems, b.dataset.trait); renderEmblems(); };
  $('runEmblem').onclick = e => {
    if (!state.emblems.length) { $('results').innerHTML = '<div class="empty">상징을 하나 이상 골라 주세요.</div>'; return; }
    run(e.currentTarget, '시너지 계산 추천 (참고)', o => emblemTeamMaker(state.data, { ...o, emblems: state.emblems, desired: state.emblemDesired }),
      () => ({ pre: emblemMetaHtml() + emblemRankerHtml() }));
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
// 덱 안 3신기는 그 덱에서 3판 이상 똑같이 쓴 조합만 (11/16 사용자: 햇빛 아지르가 1판짜리 거인 학살자 2개+수은으로 나옴 —
// 덱 413개 중 209개가 1~2판짜리). 모자라면 그 챔피언 전체 랭커 기록의 3신기(아지르: 구인수+총검+라바돈 71판)
const DECK_BUILD_MIN = 3;
function buildsFor(c) {
  const st = state.data?.unitStats?.[c.id.toLowerCase()];
  return rankBuilds(st?.builds || []);
}
function rankBuilds(all) {
  const list = all.filter(b => !b.items.some(i => /ThiefsGloves|Tacticians/i.test(i))); // 예전 통계 파일 대비
  if (!list.length) return [];
  const total = list.reduce((s, b) => s + b.games, 0);
  const min = Math.max(BUILD_MIN_GAMES, total * 0.05);
  const shrunk = b => (b.avgPlace * b.games + 4.5 * BUILD_PRIOR) / (b.games + BUILD_PRIOR);
  return list.filter(b => b.games >= min).sort((a, b) => shrunk(a) - shrunk(b)).slice(0, 3);
}
// 캐리·탱커 말고 아이템을 드는 챔피언의 이름표 (11/17 사용자: "아이템도 드는 니달리"는 어색함) — 3신기의 탱템이 2개 이상이면 서브 탱커
function subRole(b) {
  const tank = (b?.items || []).filter(id => state.data.items.find(i => i.id === id)?.role === 'TANK').length;
  return tank >= 2 ? '서브 탱커' : '서브 딜러';
}

function itemLabel(id) {
  const info = state.data?.itemInfo?.[id.toLowerCase()];
  const name = info?.name || id.replace(/^(DA_|TFT\d*_Item_|TFT_Item_)/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return `<span class="bi" data-item="${esc(id)}">${info?.icon ? `<img src="${esc(info.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${esc(name)}</span>`;
}
function buildRow(b, overall = false) {
  const low = b.games < 15 ? ' <span class="lowconf" title="판수가 적어 참고용">표본 적음</span>' : '';
  const src = overall ? ' <span class="lowconf" title="이 덱에서 똑같이 쓴 조합이 3판이 안 돼서, 이 챔피언의 모든 랭커 경기 기록 기준으로 보여 줘요">챔피언 전체 기록</span>' : '';
  return `<div class="build">${b.items.map(itemLabel).join('')}<span class="bmeta">평균 ${b.avgPlace}등 · ${b.games}판${low}${src}</span></div>`;
}
// 아이템을 드는 방식 (11/17 사용자): 도적의 장갑을 많이 끼는 챔피언(케넨 20%)·아이템을 거의 안 받는 챔피언 표시
const THIEF_SHOW = 0.07, THIEF_MIN_GAMES = 20;
function unitStatFor(c) {
  const us = state.data?.unitStats; if (!us || !c) return null;
  return us[c.id.toLowerCase()] || (c.weights && c.base && /lux/i.test(c.id) ? us.da_lux18_base : null);
}
function itemHabitHtml(c, compact = false) {
  const st = unitStatFor(c); if (!st || st.games < 30) return '';
  const pct = v => Math.round(v * 100) + '%';
  const out = [];
  const th = st.thief;
  if (th && th.rate >= THIEF_SHOW && th.games >= THIEF_MIN_GAMES) {
    const more = th.rate > (st.carryRate || 0);
    out.push(`<span class="habit thief" title="랭커 경기에서 이 챔피언이 도적의 장갑(무작위 아이템 2개)을 낀 판이 ${pct(th.rate)}(${th.games.toLocaleString()}판), 그때 평균 ${th.avgPlace}등 · 이 챔피언 전체 평균 ${st.avgPlace}등${more ? ` · 아이템 3개 조합(${pct(st.carryRate || 0)})보다 많아요` : ''}"><img src="${esc(state.data.items.find(i => /ThiefsGloves/i.test(i.id))?.icon || '')}" alt="" onerror="this.remove()">도적의 장갑 ${pct(th.rate)}${compact ? '' : ` · ${th.avgPlace}등`}${more && !compact ? ' <b>3신기보다 많음</b>' : ''}</span>`);
  }
  if ((st.carryRate || 0) < 0.15 && st.held) {
    out.push(`<span class="habit few" title="랭커 경기에서 아이템 3개를 다 든 판이 ${pct(st.carryRate || 0)}뿐이에요 (아이템 없음 ${pct(st.held[0])}). 보통 아이템을 몰아주지 않는 챔피언이라 3신기 판수가 적어요">아이템 3개 든 판 ${pct(st.carryRate || 0)}${compact ? '' : ` · 템 없음 ${pct(st.held[0])}`}</span>`);
  }
  return out.length ? `<div class="habits">${out.join('')}</div>` : '';
}

// ---------------- 홈 (11/18) ----------------
// TFT Note(큰 한 줄 소개·덱 카드 넘기기·기능 배너)와 롤체지지(검색창이 주인공·최근 패치 목록)를 참고.
// 우리는 전적 검색이 없으니 검색창 자리에 "가진 상징 고르기"(상징 팀 메이커로 바로)를 둠.
const openTab = name => document.querySelector(`.tab[data-tab="${name}"]`)?.click();
function renderHome() {
  const box = $('homeView'), d = state.data;
  if (!box || !d) return;
  const w = state.weights, pt = w?.patch;
  const games = pt?.matches?.[pt.current] ?? w?.games;
  const when = w?.generatedAt ? new Date(w.generatedAt) : null;
  const whenTxt = when ? `${when.getMonth() + 1}월 ${when.getDate()}일 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} 갱신` : '';
  const dataLine = metaAvailable()
    ? `<p class="homeData"><b>${esc(pt?.current || '')} 패치</b> · 챌린저·그랜드마스터 랭커 <b>${Number(games || 0).toLocaleString()}경기</b>${whenTxt ? ` · ${whenTxt}` : ''}</p>`
    : `<p class="homeData">랭커 통계가 아직 없어요 — 시너지 계산 추천과 배치툴은 쓸 수 있어요.</p>`;

  // 검색창 자리: 상징 고르기 + 배치툴
  const embs = d.emblems.map(e => `<button class="homeEmb" data-home-emb="${esc(e.trait)}" title="${esc(traitName(e.trait))} 상징 — 이 상징으로 되는 덱 찾기">${img(e.icon)}<span>${esc(traitName(e.trait))}</span></button>`).join('');
  const start = `<section class="homeStart" aria-label="바로 시작">
    <div class="homeStartMain"><h2>가진 상징이 있나요?</h2><p>하나를 누르면 그 상징으로 되는 랭커 메타 덱을 바로 찾아줘요. 여러 개는 상징 팀 메이커에서 골라요.</p>
      <div class="homeEmbs">${embs}</div></div>
    <div class="homeStartSide"><h2>보드가 이미 있나요?</h2><p>지금 보드와 남은 아이템을 넣으면 가까운 메타 덱과 아이템 배분을 추천해요.</p>
      <button class="btn primary" data-home-go="builder">배치툴에서 다음 수 추천받기</button>
      <button class="btn" data-home-go="emblem">상징 여러 개 고르기</button></div>
  </section>`;

  // 티어 덱 카드 (S·A)
  let decksHtml = '';
  if (metaAvailable()) {
    const { tiers } = tierList(groupedDecks(), { min: Number($('metaMin').value) || 15 });
    const all = [...tiers.S, ...tiers.A, ...tiers.B, ...tiers.C];
    const top = [...tiers.S, ...tiers.A];
    const card = x => {
      const carry = carryOfDeck(x), team = [...x.team].sort((a, b) => a.cost - b.cost);
      return `<button class="homeDeck" data-home-deck="${esc(deckName(x) + '|' + deckType(x))}" title="${esc(deckName(x))} — 티어표에서 보기">
        <span class="homeDeckTop"><span class="tl t${x.tier}">${x.tier}</span>${hexPor(carry)}</span>
        <b class="homeDeckName">${esc(deckName(x))}</b>
        <span class="homeDeckType">${esc(deckType(x))}</span>
        <span class="homeDeckStat"><b>${x.m.avgPlace.toFixed(2)}등</b> · 순방 ${Math.round(x.m.top4 * 100)}% · ${(x.tierGames || tierGames(x.m) || x.m.games).toLocaleString()}판</span>
        <span class="homeDeckTeam">${team.slice(0, 9).map(c => hexPor(c)).join('')}</span>
      </button>`;
    };
    decksHtml = `<section class="homeSec">
      <div class="homeSecHead"><div><h2>${esc(pt?.current || '')} 패치 덱 티어</h2><p>랭커 실제 보드를 덱으로 묶어 평균 등수로 나눴어요 · S ${tiers.S.length}개 · A ${tiers.A.length}개</p></div>
        <div class="homeSecAct"><button class="iconBtn" data-home-scroll="-1" aria-label="이전 덱">‹</button><button class="iconBtn" data-home-scroll="1" aria-label="다음 덱">›</button><button class="btn" data-home-go="meta">전체 ${all.length}개 덱 보기</button></div></div>
      <div class="homeDecks" id="homeDecks">${top.map(card).join('')}</div>
    </section>`;
  }

  // 패치 예측 배너 + 최근 패치
  let patchHtml = '';
  const plist = (patchDoc?.patches || []).filter(p => p.summary || p.changes).reverse();
  const latest = plist.find(p => p.changes?.length);
  if (latest) {
    const n = dir => latest.changes.filter(c => c.dir === dir).length;
    const live = pt?.current === latest.patch;
    patchHtml = `<section class="homePatch">
      <div class="homePatchMain">
        <span class="homePatchKind">패치 예측</span>
        <h2>${esc(latest.patch)} 패치, 어떤 덱이 오를까?</h2>
        <p>바뀐 챔피언·시너지가 메타 덱의 어느 자리에 있는지로 성적 변화를 미리 예측하고, 패치 뒤 랭커 경기로 실제와 비교해 채점해요. ${live ? '이번 패치 경기가 쌓이는 중이에요.' : '이 패치 경기가 수집되면 채점이 시작돼요.'}</p>
        <div class="homePatchCnt"><span class="up">▲ 버프 ${n('buff')}</span><span class="down">▼ 너프 ${n('nerf')}</span>${n('adjust') ? `<span>◆ 조정 ${n('adjust')}</span>` : ''}</div>
        <button class="btn primary" data-home-go="patch:${esc(latest.patch)}">예측 보기</button>
      </div>
      <div class="homePatchList"><h3>최근 패치</h3>${plist.slice(0, 4).map(p => `<button data-home-go="patch:${esc(p.patch)}"><b>${esc(p.patch)}</b><span>${esc(p.date)}${p.balance === false ? ' · 버그 수정' : ''}</span></button>`).join('')}</div>
    </section>`;
  }

  const diff = `<section class="homeDiff" aria-label="이 사이트가 다른 점">
    <div><h3>정해진 공략이 아니라 실제 기록</h3><p>덱 구성·3신기·상징은 랭커가 실제로 쓴 보드 그대로예요. 판수가 적으면 "표본 적음"으로 알려요.</p></div>
    <div><h3>내 게임에서 출발하는 추천</h3><p>가진 상징, 남은 아이템, 지금 보드에 맞춰 덱과 아이템 배분을 골라줘요.</p></div>
    <div><h3>패치 예측을 채점</h3><p>패치 전에 예측하고, 패치 뒤 실제 성적으로 맞았는지 보여줘요.</p></div>
  </section>`;

  box.innerHTML = `<header class="homeHero"><h1>랭커의 실제 보드로,<br><span>내 게임에 맞는 덱을.</span></h1>${dataLine}</header>${start}${decksHtml}${patchHtml}${diff}`;
}

// ---------------- 도감 (11/17: 챔피언 3신기 탭 → 챔피언·아이템·시너지 + 랭커 통계) ----------------
let dexKind = 'champ', dexSel = null;
const dexPct = x => `${Math.round(x * 100)}%`;
const dexLink = (kind, id, html, title = '') => `<button class="dexLink" data-dex="${kind}:${esc(id)}"${title ? ` title="${esc(title)}"` : ''}>${html}</button>`;
const champLink = c => dexLink('champ', c.id, `${hexPor(c)}<span>${esc(c.name)}</span>`);
const traitLink = id => dexLink('trait', id, `${traitBadge(id, '', true)}<span>${esc(traitName(id))}</span>`);
const itemObj = id => { const d = state.data; return d.items.find(i => i.id === id) || d.radiants?.find(i => i.id === id) || d.artifacts?.find(i => i.id === id) || d.emblems.find(e => e.id === id || (e.ids || []).includes(id)) || null; };
const itemLink = id => { const it = itemObj(id); return it ? dexLink('item', it.id, `${img(it.icon)}<span>${esc(it.name)}</span>`, it.name) : ''; };
// 티어표 덱 묶음 + 티어 글자 (도감의 "이 챔피언·시너지가 들어간 메타 덱")
function dexDecks() {
  if (!metaAvailable()) return [];
  const grouped = groupedDecks(), { tiers } = tierList(grouped, { min: Number($('metaMin').value) || 15 });
  const tierOfDeck = new Map(), key = x => deckName(x) + '|' + deckType(x);
  for (const [t, list] of Object.entries(tiers)) for (const x of list) tierOfDeck.set(key(x), t);
  return grouped.map(x => ({ x, tier: tierOfDeck.get(key(x)) || '' }));
}
function dexDeckRows(list, why) {
  if (!list.length) return '';
  return `<div class="dexDecks">${list.map(({ x, tier, note }) => {
    const reg = deckRegistry.push({ ...x, bdName: deckName(x) }) - 1;
    return `<div class="dexDeck">${tier ? `<span class="tl t${tier}">${tier}</span>` : '<span class="tl">–</span>'}${hexPor(carryOfDeck(x))}
      <div><b>${esc(deckName(x))}</b><div class="muted small">${esc(deckType(x))} · ${x.m.avgPlace.toFixed(2)}등 · ${(tierGames(x.m) || x.m.games).toLocaleString()}판${note ? ` · ${note}` : ''}</div></div>
      <button class="altopen toBuilder" data-reg="${reg}" title="이 덱을 배치툴에 세우기">배치툴</button></div>`;
  }).join('')}</div>${why ? `<p class="muted small">${why}</p>` : ''}`;
}
const dexSec = (title, body, note = '') => body ? `<section class="dexSec"><h3>${title}${note ? `<span class="muted small"> ${note}</span>` : ''}</h3>${body}</section>` : '';
const dexStats = (games, avg, top4, win) => `<div class="dexStats"><div><b>${avg != null ? Number(avg).toFixed(2) : '–'}</b><span>평균 등수</span></div><div><b>${top4 != null ? dexPct(top4) : '–'}</b><span>순방률</span></div><div><b>${win != null ? dexPct(win) : '–'}</b><span>1등률</span></div><div><b>${games != null ? Number(games).toLocaleString() : '–'}</b><span>판</span></div></div>`;

function renderBuilds() {
  const d = state.data;
  for (const b of $('dexKind').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === dexKind);
  if (!d) { $('buildList').innerHTML = ''; $('dexDetail').innerHTML = ''; return; }
  const q = $('buildFilter').value.trim();
  $('buildFilter').placeholder = { champ: '챔피언·시너지 검색', item: '아이템 검색', trait: '시너지 검색' }[dexKind];
  const tile = (kind, id, icon, name, sub, extra = '') => `<button class="dk dexTile" data-dex="${kind}:${esc(id)}" aria-pressed="${id === dexSel}">${icon}<span><span class="nm">${esc(name)}</span><br><span class="ty">${sub}</span></span>${extra}</button>`;
  let groups = [];
  if (dexKind === 'champ') {
    const list = d.champions.filter(c => !q || c.name.includes(q) || c.traits.some(t => traitName(t).includes(q)));
    const seen = new Set(), champs = [];
    for (const c of list) { const k = c.base || c.id; if (c.base && seen.has(k)) continue; seen.add(k); champs.push(c); } // 럭스 형태는 하나로
    for (const cost of [1, 2, 3, 4, 5, 6, 7]) {
      const xs = champs.filter(c => c.cost === cost).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      if (xs.length) groups.push([`${cost}코스트`, xs.map(c => { const u = unitStatFor(c); return tile('champ', c.id, hexPor(c), c.base ? c.name.replace(/\s*\(.*\)$/, '') : c.name, c.traits.map(traitName).map(esc).join(' · '), u ? `<span class="sc"><b>${u.avgPlace}</b><span>${u.games.toLocaleString()}판</span></span>` : ''); })]);
    }
    if (!dexSel || !champs.some(c => c.id === dexSel)) dexSel = champs[0]?.id || null;
  } else if (dexKind === 'item') {
    const total = {};
    for (const u of Object.values(d.unitStats || {})) for (const [id, n] of Object.entries(u.items || {})) total[id] = (total[id] || 0) + n;
    const embTotal = id => state.weights?.emblems?.[id]?.total || 0;
    const cats = [['완성 아이템', d.items], ['찬란한 아이템', d.radiants || []], ['유물', d.artifacts || []], ['상징', d.emblems.map(e => ({ ...e, emb: true }))]];
    const all = [];
    for (const [label, xs] of cats) {
      const vis = xs.filter(i => !q || i.name.includes(q)).map(i => ({ ...i, n: i.emb ? embTotal(i.id) : total[i.id] || 0 })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ko'));
      all.push(...vis);
      if (vis.length) groups.push([label, vis.map(i => tile('item', i.id, `<span class="dexIc">${img(i.icon)}</span>`, i.name, i.n ? `랭커 ${i.n.toLocaleString()}번 낌` : '기록 없음'))]);
    }
    if (!dexSel || !all.some(i => i.id === dexSel)) dexSel = all[0]?.id || null;
  } else {
    const ts = Object.entries(d.traits).map(([id, t]) => ({ id, ...t })).filter(t => t.breakpoints?.length && (!q || t.name.includes(q)));
    const nChamps = id => d.champions.filter(c => c.traits.includes(id)).length;
    const uniq = ts.filter(t => t.breakpoints.length === 1 && t.breakpoints[0] === 1), rest = ts.filter(t => !uniq.includes(t)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    groups.push(['시너지', rest.map(t => tile('trait', t.id, `<span class="dexIc">${traitBadge(t.id)}</span>`, t.name, t.breakpoints.join(' / ')))]);
    if (uniq.length) groups.push(['고유 시너지', uniq.sort((a, b) => a.name.localeCompare(b.name, 'ko')).map(t => tile('trait', t.id, `<span class="dexIc">${traitBadge(t.id)}</span>`, t.name, `챔피언 ${nChamps(t.id)}명`))]);
    if (!dexSel || !ts.some(t => t.id === dexSel)) dexSel = rest[0]?.id || uniq[0]?.id || null;
  }
  $('buildList').innerHTML = groups.map(([label, tiles]) => `<h3 class="dexGroup">${label}</h3><div class="decks dexGrid">${tiles.join('')}</div>`).join('') || '<div class="empty">찾는 항목이 없어요.</div>';
  const el = $('dexDetail');
  el.innerHTML = !dexSel ? '' : dexKind === 'champ' ? dexChampHtml(d.champions.find(c => c.id === dexSel)) : dexKind === 'item' ? dexItemHtml(dexSel) : dexTraitHtml(dexSel);
  el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
}

// 내 시너지가 켜졌을 때 아이템이 달라지는 챔피언 (11/18 사용자: 처형자가 켜지면 스킬 치명타가 생겨 무한의 대검이 덜 필요)
// 집계 traitItems[시너지] = { on, off(판수), items: {아이템: [켜짐 비율, 안 켜짐 비율]}, builds(켜진 판 3신기) }
function dexTraitItemsHtml(c, u) {
  return Object.entries(u.traitItems || {}).map(([t, ti]) => {
    const tn = state.data.traits[t]?.name || t;
    const rows = Object.entries(ti.items).sort((a, b) => Math.abs(b[1][0] - b[1][1]) - Math.abs(a[1][0] - a[1][1])).slice(0, 4)
      .map(([id, [on, off]]) => `<span class="dexItemRate">${itemLink(id)}<b>${dexPct(off)} → ${dexPct(on)}</b></span>`).join('');
    const bs = (ti.builds || []).filter(b => b.games >= BUILD_MIN_GAMES);
    return dexSec(`${esc(tn)} 시너지가 켜졌을 때`,
      `<p class="muted small">켜진 판 ${ti.on.toLocaleString()} · 안 켜진 판 ${ti.off.toLocaleString()} — 든 아이템 중 그 아이템의 몫 (안 켜짐 → 켜짐)</p><div class="dexItems">${rows}</div>`
      + (bs.length ? `<p class="muted small" style="margin-top:8px">켜진 판의 랭커 3신기</p>` + dexBuildsHtml(ti.builds) : ''));
  }).join('');
}
// 도감 3신기 (11/18 사용자): 맨 위 = 가장 많이 쓴 조합(정석, 판수 1위), 그 아래 = 성적 좋은 조합(보정 평균 등수 순) 2개
// 아이템 기록이 어느 패치까지인지 (11/18: 아이템이 안 바뀐 패치면 이전 패치 경기도 그대로 씀)
function itemSpan() {
  const p = state.weights?.patch;
  return p?.prev && p.itemPrevWeight >= 1 ? `${p.prev}·${p.current} 패치 기록` : p?.current ? `${p.current} 패치 기록` : '';
}
function dexBuildsHtml(all) {
  const list = (all || []).filter(b => !b.items.some(i => /ThiefsGloves|Tacticians/i.test(i)) && b.games >= BUILD_MIN_GAMES);
  if (!list.length) return '<p class="muted small">아이템 3개 조합 기록이 부족해요 (5판 이상인 조합 없음)</p>';
  const total = (all || []).reduce((n, b) => n + b.games, 0);
  const top = [...list].sort((a, b) => b.games - a.games)[0];
  const good = rankBuilds(list).filter(b => b !== top).slice(0, 2);
  const tag = (t, tip) => `<span class="lowconf" title="${tip}">${t}</span>`;
  return `<div class="best">${buildRow(top).replace('<span class="bmeta">', `<span class="bmeta">${tag('가장 많이 씀', '이 챔피언이 아이템 3개를 든 판에서 가장 자주 나온 조합')} ${Math.round(top.games / total * 100)}% · `)}</div>`
    + good.map(b => `<div class="alt">${buildRow(b).replace('<span class="bmeta">', `<span class="bmeta">${tag('성적 좋음', '판수가 적은 조합은 4.5등 쪽으로 보정해서 비교')} `)}</div>`).join('');
}
function dexChampHtml(c) {
  if (!c) return '';
  const d = state.data, u = unitStatFor(c), base = c.base || c.id;
  const same = d.champions.filter(x => (x.base || x.id) === base), forms = same.length > 1 ? same.filter(x => x.name !== base) : [];
  const head = `<div class="dTop">${hexPor(c)}<div><h2>${esc(base)}</h2><p>${c.cost}코스트 · ${roleKo[c.role] || ''}${c.ability?.name ? ` · 스킬 ${esc(c.ability.name)}` : ''}${c.stats?.mana ? ` · 마나 ${c.stats.startMana ?? 0}/${c.stats.mana}` : ''}</p></div></div>
    <div class="dexTraits">${c.traits.map(traitLink).join('')}</div>
    ${forms.length ? `<p class="muted small">형태: ${forms.map(f => esc(f.name)).join(', ')} — 랭커 기록에는 형태 구분 없이 하나로 남아요</p>` : ''}`;
  if (!u) return head + '<div class="empty">랭커 기록이 없어요.</div>';
  const stars = Object.entries(u.stars || {}).filter(([, v]) => v.games >= 5).map(([k, v]) => `<span class="pill">${k}성 ${v.avgPlace}등 · ${v.games.toLocaleString()}판</span>`).join('');
  const items = Object.entries(u.items || {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, n]) => `<span class="dexItemRate">${itemLink(id)}<b>${dexPct(n / u.games)}</b></span>`).join('');
  // 상징: 랭커가 이 챔피언에게 가장 많이 준 상징
  const embs = Object.entries(state.weights?.emblems || {}).map(([id, e]) => [id, Object.entries(e.holders || {}).filter(([k]) => k === c.id.toLowerCase() || k === base.toLowerCase()).reduce((s, [, n]) => s + n, 0)])
    .filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `<span class="dexItemRate">${itemLink(id)}<b>${n}번</b></span>`).join('');
  // 메타 덱: 핵심 캐리인 덱 → 자주 들어가는 덱
  const decks = dexDecks(), keyOf = x => x?.base || x?.id;
  const carryIn = decks.filter(({ x }) => [x, ...(x.variants || [])].some(v => keyOf(carryOfDeck(v)) === base)).sort((a, b) => (tierGames(b.x.m) || b.x.m.games) - (tierGames(a.x.m) || a.x.m.games)).slice(0, 4);
  const inTeam = decks.filter(({ x }) => !carryIn.some(y => y.x === x) && x.team.some(t => keyOf(t) === base && (x.unitInfo?.[t.id]?.rate ?? 1) >= 0.75))
    .sort((a, b) => (tierGames(b.x.m) || b.x.m.games) - (tierGames(a.x.m) || a.x.m.games)).slice(0, 4);
  return head
    + dexStats(u.games, u.avgPlace, u.top4, u.win)
    + (stars ? `<div class="pills">${stars}</div>` : '')
    + itemHabitHtml(c)
    + dexSec('랭커 3신기', dexBuildsHtml(u.builds), `${itemSpan() ? itemSpan() + ' · ' : ''}맨 위가 가장 많이 쓴 조합 · % = 상위 조합 중 비율`)
    + dexTraitItemsHtml(c, u)
    + dexSec('자주 낀 아이템', items ? `<div class="dexItems">${items}</div>` : '', `이 챔피언이 나온 판 중 낀 비율${itemSpan() ? ' · ' + itemSpan() : ''}`)
    + dexSec('받은 상징', embs ? `<div class="dexItems">${embs}</div>` : '')
    + dexSec('핵심 캐리인 메타 덱', dexDeckRows(carryIn))
    + dexSec('자주 들어가는 메타 덱', dexDeckRows(inTeam), '덱에서 75% 이상 사용');
}

function dexItemHtml(id) {
  const d = state.data, it = itemObj(id);
  if (!it) return '';
  const emb = d.emblems.find(e => e.id === id);
  const recipe = (it.recipe || d.recipes?.[id] || []);
  const kind = emb ? '상징' : d.radiants?.some(i => i.id === id) ? '찬란한 아이템' : d.artifacts?.some(i => i.id === id) ? '유물' : '완성 아이템';
  const roleKoItem = it.role ? `${roleKo[it.role] || it.role}용` : '';
  const head = `<div class="dTop"><span class="dexBigIc">${img(it.icon)}</span><div><h2>${esc(it.name)}</h2><p>${kind}${roleKoItem ? ` · ${roleKoItem}` : ''}</p></div></div>
    ${recipe.length ? `<div class="dexRecipe">${recipe.map(r => { const c = d.components?.find(x => x.id === r) || d.itemInfo?.[r.toLowerCase()]; return `<span class="dexComp">${img(c?.icon)}${esc(c?.name || r)}</span>`; }).join('<span class="muted">+</span>')}</div>` : ''}
    ${emb ? `<div class="dexTraits">${traitLink(emb.trait)}</div>` : ''}`;
  if (emb) {
    const e = state.weights?.emblems?.[id];
    if (!e) return head + '<div class="empty">랭커 기록이 없어요.</div>';
    const byLower = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
    const hs = Object.entries(e.holders || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => { const c = byLower.get(k); return c ? `<div class="dexHolder">${champLink(c)}<b>${dexPct(n / e.total)}</b><span class="muted small">${n}번</span></div>` : ''; }).join('');
    return head + `<p class="muted">랭커가 이 상징을 낀 횟수 <b>${e.total.toLocaleString()}번</b></p>` + dexSec('상징을 받은 챔피언', `<div class="dexHolders">${hs}</div>`, '이 상징 중 그 챔피언에게 간 비율');
  }
  if (!d.unitStats) return head + '<div class="empty">통계가 없어요.</div>';
  // 이 아이템을 낀 챔피언: 그 챔피언이 나온 판 중 낀 비율 + 이 아이템 전체 중 몫
  const rows = carriesForItems(d, { itemIds: [id], top: 6 });
  const carriers = rows.map(r => `<div class="dexHolder">${champLink(r.champ)}<b>${dexPct(r.rates[0].rate)}</b><span class="muted small">판 · 몫 ${dexPct(r.rates[0].share)}</span></div>`).join('');
  // 이 아이템이 들어간 인기 3신기 (챔피언 상관없이 판수 순)
  const builds = [];
  for (const c of d.champions) for (const b of buildsFor(c)) if (b.items.includes(id)) builds.push({ c, b });
  const seen = new Set();
  const top = builds.sort((x, y) => y.b.games - x.b.games).filter(({ c, b }) => { const k = (c.base || c.id) + b.items.join(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5)
    .map(({ c, b }) => `<div class="dexBuild">${champLink(c)}${buildRow(b)}</div>`).join('');
  return head
    + dexSec('이 아이템을 낀 챔피언', carriers ? `<div class="dexHolders">${carriers}</div>` : '', `판 = 그 챔피언이 나온 판 중 낀 비율 · 몫 = 이 아이템 전체 중 그 챔피언에게 간 비율${itemSpan() ? ' · ' + itemSpan() : ''}`)
    + dexSec('이 아이템이 들어간 인기 3신기', top);
}

function dexTraitHtml(id) {
  const d = state.data, t = d.traits[id];
  if (!t) return '';
  const champs = d.champions.filter(c => c.traits.includes(id)).sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'ko'));
  // Set 18 설명은 수치가 ? 이고 %i:scaleAD% 같은 아이콘 표시가 남아 있음 → 표시만 지우고, 글자 없는 줄(수치뿐)은 뺌
  // 어댑터 14부터 descFilled = 단계별 실제 수치. 없으면(옛 캐시) 예전처럼 ? 줄을 정리해서
  const desc = t.descFilled ? t.descFilled.split('\n') : (t.desc || '').replace(/%i:[^%]*%/g, '').replace(/\(\?\)/g, '\n•').split('\n').map(x => x.trim()).filter(x => /[가-힣]/.test(x));
  const head = `<div class="dTop"><span class="dexBigIc">${traitBadge(id)}</span><div><h2>${esc(t.name)}</h2><p>${t.breakpoints.join(' / ')}명</p></div></div>
    ${desc.length ? `<div class="dexDesc">${desc.map(x => { const m = x.match(/^\((\d+)\)\s*(.*)$/); return m ? `<p class="dexRow"><span class="bp">${m[1]}</span>${esc(m[2])}</p>` : `<p>${esc(x)}</p>`; }).join('')}</div>` : ''}
    <div class="dexChamps">${champs.map(champLink).join('')}</div>`;
  // 단계별 성적 (weights.traits[id][단계 번호])
  const ws = state.weights?.traits?.[id];
  const tierRows = ws ? t.breakpoints.map((bp, i) => { const v = ws[i + 1]; return v?.games ? `<tr><td>${bp}명</td><td>${v.avgPlace}등</td><td>${dexPct(v.top4)}</td><td>${v.games.toLocaleString()}판</td></tr>` : ''; }).join('') : '';
  const emb = d.emblems.find(e => e.trait === id);
  const decks = dexDecks().filter(({ x }) => x.m.trait === id).sort((a, b) => (tierGames(b.x.m) || b.x.m.games) - (tierGames(a.x.m) || a.x.m.games)).slice(0, 6);
  return head
    + dexSec('단계별 랭커 성적', tierRows ? `<table class="dexTable"><thead><tr><th>단계</th><th>평균</th><th>순방</th><th>판수</th></tr></thead><tbody>${tierRows}</tbody></table>` : '', '그 단계로 끝낸 판')
    + dexSec('이 시너지가 주력인 메타 덱', dexDeckRows(decks))
    + (emb ? dexSec('상징', `<div class="dexItems">${itemLink(emb.id)}</div>`) : '');
}

// ---------------- 메타 덱 ----------------
// 랭커들의 실제 최종 덱을 "주력 시너지 + 핵심 캐리"로 묶은 통계 (tools/stats-lib.mjs → comps)
// 티어: 이번 패치 판수로 보정한 평균 등수 (engine/patch.js tierOf). 이번 패치 기록이 없으면 전체 판수로.
const metaTier = (avg, games) => tierOf(avg, games);
const deckTier = m => tierOf(m.avgPlace, tierGames(m) || m.games);
const metaAvailable = () => {
  const d = state.data, w = state.weights;
  return !!(d && w?.comps?.length && w.setNumber === d.set.number && $('useWeights').checked);
};
const metaShrunk = m => shrinkAvg(m.avgPlace, tierGames(m) || m.games); // 판수가 적으면 평균(4.5등) 쪽으로

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

/**
 * 형태를 고르는 챔피언(기본형 = 시너지 가중치 없음, 같은 base 에 형태별 챔피언이 있음)의 덱에 맞는 형태.
 * ① 덱의 주력 시너지 형태 ② 없으면 팀에서 가장 많이 겹치는 시너지 형태. 형태가 없는 챔피언이면 null.
 */
function formFor(c, mainTrait, team) {
  if (c.weights || !c.base) return null;
  const forms = state.data.champions.filter(x => x.base === c.base && x.weights);
  if (!forms.length) return null;
  const traitOf = f => Object.keys(f.weights)[0];
  const byMain = forms.find(f => traitOf(f) === mainTrait);
  if (byMain) return byMain;
  const count = t => team.filter(x => x !== c && x.traits.includes(t)).length;
  return [...forms].sort((a, b) => count(traitOf(b)) - count(traitOf(a)))[0];
}

/** 랭커들이 이 덱에서 주력 시너지 상징을 쓴 비율 (20% 이상일 때) */
/**
 * 대표 보드와 다른 실제 보드(m.alts, 판수 순) → 차이만: { add:[챔피언], remove:[챔피언], emb: 주력 상징 개수, games, avgPlace }
 * (11/15 사용자 피드백: 럭스를 못 쓰면 "다른 검은 가시 챔피언 + 상징"으로 채움 — 실제 보드로 확인)
 */
function altBoards(m, team, limit = 3) {
  const byLower = new Map(state.data.champions.map(c => [c.id.toLowerCase(), c]));
  const key = c => c.base || c.id;
  const have = new Set(team.map(key));
  const out = [];
  for (const a of m.alts || []) {
    if (a.games < 2) continue; // 1판짜리 구성은 우연일 수 있어 빼기
    const champs = a.ids.map(id => byLower.get(id)).filter(Boolean);
    const keys = new Set(champs.map(key));
    const add = champs.filter(c => !have.has(key(c))), remove = team.filter(c => !keys.has(key(c)));
    if (!add.length && !remove.length && !(a.mainEmb >= 0.5)) continue; // 대표 보드와 같은 구성
    out.push({ add, remove, emb: Math.round(a.mainEmb || 0), games: a.games, avgPlace: a.avgPlace, ids: a.ids, traits: a.traits });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 다른 구성 → 배치툴에서 열 덱 (11/15 사용자 아이디어: 다른 구성 옆에 "배치툴에서 열기")
 * 그 판 시너지 인원에 맞춰 럭스 형태, 그 보드에서 쓴 개수만큼 주력 상징, 핵심 캐리·탱커가 있으면 랭커 3신기
 */
function altDeck(x, a) {
  const d = state.data, mm = x.mainM || x.m;
  const real = realBoardTeam({ ...mm, board: { units: a.ids.map(id => ({ id, items: [] })), traits: a.traits } }, new Map(d.champions.map(c => [c.id.toLowerCase(), c])));
  if (!real) return null;
  const team = real.team;
  const emblems = Array(a.emb || 0).fill(mm.trait);
  const key = c => c.base || c.id;
  const pick = id => id && team.find(c => key(c) === key(d.champions.find(x => x.id === id) || { id }));
  const carry = pick(x.carryChampId) || team.find(c => c.cost >= 4) || team[0];
  const tank = pick(x.core?.tank);
  const ev = evaluateTeam(team, d, { carryIds: [carry.id], emblems });
  ev.core = { carry: carry.id, tank: tank?.id };
  const builds = {};
  for (const [id, b] of Object.entries(x.builds || {})) { const c = pick(id); if (c) builds[c.id] = b; }
  const unitInfo = {};
  for (const c of team) { const o = x.team.find(t => key(t) === key(c)); unitInfo[c.id] = (o && x.unitInfo?.[o.id]) || { rate: 0, star3: 0 }; }
  return { ...ev, team, builds, unitInfo, m: mm };
}

function emblemNote(m, deck = null) {
  const e = state.data.emblems.find(x => x.trait === m.trait);
  const r = e && Object.entries(m.emblems || {}).find(([id]) => id === e.id || (e.ids || []).includes(id))?.[1];
  if (!(r >= 0.2)) return '';
  // 보여 주는 보드가 그 상징을 안 쓰면 이유를 같이 (11/15 사용자 피드백: 검은 가시 베이가 — 보드는 럭스로 4를 맞췄는데 "상징 49%"만 보여서 5검은가시처럼 읽힘)
  const used = deck?.assignment?.some(a => a.holder && a.trait === m.trait);
  let why = '';
  if (deck && !used) {
    const form = deck.team.find(c => c.weights?.[m.trait]);
    const fr = form ? Math.round((deck.unitInfo?.[form.id]?.rate ?? 0) * 100) : 0;
    // 그 형태 챔피언 없이 상징을 쓴 실제 보드에서 "무엇으로 채웠는지"
    const alt = form && altBoards(m, deck.team, 6).find(a => a.remove.some(c => (c.base || c.id) === (form.base || form.id)) && a.emb >= 1);
    const fill = alt ? alt.add.filter(c => c.traits.includes(m.trait)).map(c => c.name) : [];
    const fb = form && (form.base || form.name);
    // "못 쓰면 ~로 채워요"는 랭커가 실제로 그 형태 없이 상징을 쓴 보드가 있을 때만 (럭스가 캐리인 덱은 럭스를 늘 써서 근거 없음)
    why = form ? ` 이 보드는 상징 대신 ${traitName(m.trait)} ${fb}(2명분)로 맞춘 버전이에요${fr < 95 ? `(${fb} ${fr}% 판에서 사용)` : ''}.${alt ? ` ${fb}를 못 쓴 판에서는 ${fill.length ? fill.join('·') + ' + ' : ''}${traitName(m.trait)} 상징${alt.emb > 1 ? ` ${alt.emb}개로` : '으로'} 채웠어요.` : ''}`
      : ' 이 보드는 상징 없이 맞춘 버전이에요.';
  }
  return ` <span class="tag soft" title="랭커들이 이 덱을 쓴 판 중 ${Math.round(r * 100)}%에서 ${esc(e.name)}을 썼어요.${esc(why)}">${esc(e.name)} ${Math.round(r * 100)}%${deck && !used ? ' · 이 보드는 미사용' : ''}</span>`;
}

/**
 * 자주 쓰인 순으로 자리를 채우면 주력 시너지 인원이 랭커 실제 기록과 어긋날 수 있음 (11/15 점검: 197개 중 28개)
 *  - 넘침: 개화 럭스 6개화(랭커 0%), 협곡야수 덩굴정령 8명(랭커 92%가 7명)
 *  - 모자람: 상징 덱 — 요정 시비르 3명(랭커 87%가 4명, 요정 상징 82%), 싸움꾼 코그모 2명(상징 100%)
 * 목표 = 랭커가 가장 많이 간 인원(mainCount 최빈값, 40% 이상일 때). 없으면 단계 사이 낭비만 없앰.
 * ① 주력 시너지 상징을 쓴 판이 50% 이상이면 상징으로 채움(90% 이상이면 2개까지)
 * ② 그래도 다르면 선택 자리(캐리·탱커 제외, 쓰인 비율 낮은 쪽)를 다음 후보로 바꿈(최대 2번)
 * → 쓸 상징 목록(시너지 id) 반환
 */
function fitMainCount(team, info, m, byLower, carry, carryRef = {}) {
  const d = state.data, bps = d.traits[m.trait]?.breakpoints;
  if (!bps?.length) return [];
  const countOf = list => list.reduce((s, c) => s + (c.traits.includes(m.trait) ? (c.weights?.[m.trait] ?? 1) : 0), 0);
  const mode = Object.entries(m.mainCount || {}).sort((a, b) => b[1] - a[1])[0];
  const target = mode && mode[1] >= 0.5 ? Number(mode[0]) : null; // 기록이 여러 인원으로 흩어진 덱(개화 럭스 3명 42%·5명 24%·9명 15%)은 목표 없이 낭비만 없앰
  const em = d.emblems.find(e => e.trait === m.trait);
  const embRate = em ? Object.entries(m.emblems || {}).find(([id]) => id === em.id || (em.ids || []).includes(id))?.[1] || 0 : 0;
  const emblems = [];
  const fillEmblems = () => {
    if (target == null || embRate < 0.5) return;
    while (countOf(team) + emblems.length < target && emblems.length < (embRate >= 0.9 ? 2 : 1)) emblems.push(m.trait);
  };
  // 목표와의 거리 (목표가 없으면 단계 사이 낭비)
  const off = list => {
    const n = countOf(list) + emblems.length;
    if (target != null) return Math.abs(n - target);
    return n - (bps.filter(b => b <= n).at(-1) || 0);
  };
  fillEmblems();
  const slotsOf = list => list.reduce((s, c) => s + (c.slots || 1), 0);
  for (let round = 0; round < 2 && off(team) > 0; round++) {
    const used = new Set(team.map(c => c.base || c.id));
    const cands = m.core.map(u => ({ u, c: byLower.get(u.id) })).filter(x => x.c && !used.has(x.c.base || x.c.id))
      .map(x => ({ ...x, c: formFor(x.c, m.trait, team) || x.c }));
    let best = null;
    for (let i = 0; i < team.length; i++) {
      const out = team[i];
      // 형태 챔피언(럭스)은 다른 형태로 바꾸는 것도 후보 (요정 아펠리오스: 요정 럭스면 5명인데 랭커 82%가 4명 → 다른 형태였음)
      const forms = out.weights && out.base ? d.champions.filter(x => x.base === out.base && x.weights && x !== out).map(c => ({ u: info[out.id] || { rate: 1 }, c, form: true })) : [];
      const isCore = out === carry || out.id.toLowerCase() === m.mainTank || (info[out.id]?.rate ?? 1) >= 0.75; // 거의 항상 쓰는 챔피언은 유지
      const outRate = info[out.id]?.rate ?? 1;
      for (const { u, c, form } of [...(isCore ? [] : cands), ...forms]) {
        const next = team.map((x, k) => (k === i ? c : x));
        if (slotsOf(next) > m.level) continue;
        const o = off(next);
        if (o >= off(team)) continue;
        const loss = form ? -1 : outRate - u.rate; // 형태만 바꾸는 게 가장 나음, 그다음 덜 쓰인 챔피언을 빼고 더 쓰인 후보를 넣기
        if (!best || o < best.o || (o === best.o && loss < best.loss)) best = { i, c, u, o, loss };
      }
    }
    if (!best) break;
    const was = team[best.i];
    delete info[was.id]; team[best.i] = best.c; info[best.c.id] = best.u;
    if (was === carry) carryRef.swapped = best.c; // 캐리(럭스)의 형태가 바뀌면 호출한 쪽에 알림
  }
  return emblems;
}

/**
 * 밸류덱: 시너지보다 5코스트 챔피언으로 힘을 내는 덱 (사용자 피드백 11/15: 드레이븐은 같이 가는 시너지가 없어 대부분 밸류덱)
 * 9레벨 이상 + 5코스트 4명 이상 + 주력 시너지가 두 번째 단계 이하·4명 이하 (지옥불 5명처럼 시너지를 3단계까지 맞춘 덱은 아님)
 * → 18.6: 드레이븐 8개 전부, 장로 드래곤 6개 등 21개
 */
function isValueDeck(team, m, ev) {
  const bps = state.data.traits[m.trait]?.breakpoints || [];
  const n = ev.traits.find(t => t.id === m.trait)?.count || 0;
  return m.level >= 9 && team.filter(c => c.cost >= 5).length >= 4 && bps.filter(b => b <= n).length <= 2 && n <= 4;
}

/**
 * 캐리 바로잡기 (11/16 사용자 피드백 "햇빛 아지르" 점검 후 전체 점검):
 * 판마다 "딜 아이템 최다" 챔피언을 캐리로 잡다 보니, 3성 리롤 캐리가 아이템을 든 덱인데도 다른 챔피언이 캐리로 잡힘
 *  - 약탈자 다이애나: 다이애나는 탱템(랭커 기록상 아이템 3개 드는 비율 2%) → 3성 워윅이 캐리
 *  - 싸움꾼 니달리 / 개화 니달리 / 나무정령 자이라: 3성 마스터 이·렝가·어미 부리도 3아이템 → 둘 다 캐리("마스터 이·니달리")
 * 대표 보드에서 아이템 2개 이상 든 챔피언 + 챔피언 전체 기록의 carryRate(아이템 3개 든 비율)로 판단
 */
function fixCarry(x) {
  const st = id => state.data.unitStats?.[id.toLowerCase()];
  const rate = c => st(c.id)?.carryRate ?? (/lux/i.test(c.id) ? st('da_lux18_base')?.carryRate : null) ?? 0.5;
  const carry = carryOfDeck(x); if (!carry) return x;
  const units = x.m.board?.units || [];
  const items = c => (units.find(u => u.id === c.id.toLowerCase() || (c.base && st(u.id) && x.team.find(t => t.id.toLowerCase() === u.id)?.base === c.base))?.items || []).filter(i => !/Emblem/i.test(i)).length;
  const holders = x.team.filter(c => c !== carry && items(c) >= 2 && rate(c) >= 0.3);
  // ① 캐리로 잡힌 챔피언이 사실상 아이템을 안 드는 챔피언(탱커 등)이면 홀더로 바꿈
  if (rate(carry) < 0.15 && holders.length) {
    const nc = holders.sort((a, b) => rate(b) - rate(a) || items(b) - items(a))[0];
    return { ...x, carryChampId: nc.id, core: { ...(x.core || {}), carry: nc.id } };
  }
  // ② 리롤 덱에서 3성 리롤 챔피언도 아이템 3개를 들면 그 챔피언을 앞에, 원래 캐리를 뒤에 ("마스터 이·니달리")
  const star3 = c => (x.unitInfo?.[c.id]?.star3 || 0) >= 0.5;
  if (!star3(carry)) {
    const rr = x.team.filter(c => c !== carry && c.cost <= 3 && star3(c) && items(c) >= 2 && rate(c) >= 0.2 && c.cost <= carry.cost).sort((a, b) => rate(b) - rate(a))[0];
    if (rr) return { ...x, carryChampId: rr.id, core: { ...(x.core || {}), carry: rr.id }, carries: [rr.base || rr.name, carry.base || carry.name] };
  }
  return x;
}
function metaDecks(minGames) { return metaDecksRaw(minGames).map(fixCarry); }
function metaDecksRaw(minGames) {
  const d = state.data;
  if (!metaAvailable()) return [];
  const byLower = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
  return mergedComps().filter(m => m.games >= minGames).map(m => {
    let carry = byLower.get(m.mainCarry || m.carry);
    if (!carry) return null;
    // ① 랭커가 실제로 쓴 대표 보드가 있으면 그대로 (11/15 사용자 피드백: 자주 나온 챔피언을 모아 채우면
    //    "N% 선택"만 6명인, 아무도 안 쓴 보드가 돼서 뭘 쓰라는 건지 모름)
    const real = realBoardTeam(m, byLower);
    if (real && real.team.some(c => (c.base || c.id) === (carry.base || carry.id))) {
      const { team, info, emblems, bonus } = real;
      carry = team.find(c => (c.base || c.id) === (carry.base || carry.id));
      return metaDeckFrom(m, team, info, emblems, carry, byLower, {}, true, bonus);
    }
    // ② 없으면 예전처럼 레벨만큼 자리 채우기: 자주 쓰인 순, 같은 챔피언의 다른 형태(럭스 등)는 하나만, 2칸 챔피언 고려
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
    // 형태가 있는 챔피언(화신 럭스): 경기 데이터엔 항상 기본 럭스(시너지 0명분)로만 남음 → 덱에 맞는 형태로 바꿈
    // (개화 덱이면 개화 럭스 = 개화 2명분. 사용자 피드백 11/15: 럭스가 있는데 4개화로 표시됨)
    const swap = {};
    for (let i = 0; i < team.length; i++) {
      const f = formFor(team[i], m.trait, team);
      if (f) { swap[team[i].id] = f; info[f.id] = info[team[i].id]; team[i] = f; }
    }
    if (swap[carry.id]) carry = swap[carry.id];
    const carryRef = {};
    const emblems = fitMainCount(team, info, m, byLower, carry, carryRef);
    if (carryRef.swapped) { swap[carry.id] = carryRef.swapped; carry = carryRef.swapped; }
    return metaDeckFrom(m, team, info, emblems, carry, byLower, swap, false);
  }).filter(Boolean);
}

/** 대표 보드(m.board: 랭커 실제 보드 — 챔피언·별·아이템·시너지 인원) → 팀. 럭스 형태는 그 판의 시너지 인원에 맞춰, 상징은 그 판에 낀 것 */
function realBoardTeam(m, byLower) {
  const d = state.data, b = m.board;
  if (!b?.units?.length) return null;
  const coreById = new Map(m.core.map(u => [u.id, u]));
  const team = [], info = {}, bases = new Set(), emblems = [], rare = [];
  for (const u of b.units) {
    const c = byLower.get(u.id);
    if (!c || bases.has(c.base || c.id)) continue;
    bases.add(c.base || c.id); team.push(c);
    info[c.id] = coreById.get(u.id) || { id: u.id, rate: 0, star3: 0 };
    // 상징: 이 덱에서 30% 이상 쓴 상징은 그대로, 드문 상징은 일단 후보로 (아래에서 시너지 단계에 꼭 필요한 것만 남김)
    for (const it of u.items || []) {
      const e = d.emblems.find(x => x.id === it || (x.ids || []).includes(it));
      if (e && (m.emblems?.[it] || 0) >= 0.3) emblems.push(e.trait);
      else if (e) rare.push(e.trait);
    }
  }
  if (team.length < 4) return null;
  // 형태 챔피언(럭스): 그 판의 시너지 인원과 맞는 형태
  for (let i = 0; i < team.length; i++) {
    const c = team[i];
    if (c.weights || !c.base) continue;
    const forms = d.champions.filter(x => x.base === c.base && x.weights);
    if (!forms.length) continue;
    const countWith = f => { const t = Object.keys(f.weights)[0]; return team.reduce((s, x) => s + (x === c ? 0 : x.traits.includes(t) ? (x.weights?.[t] ?? 1) : 0), 0) + f.weights[t] + emblems.filter(e => e === t).length; };
    // 그 판 실제 인원과 정확히 맞으면 2, 넘치면 -1(그 형태일 수 없음 — 지옥불 아리: 지옥불 럭스면 5인데 실제 3), 시너지만 있으면 1
    const fit = f => { const t = Object.keys(f.weights)[0], real = b.traits?.[t]; if (real == null) return 0; const n = countWith(f); return n === real ? 2 : n > real ? -1 : 1; };
    const best = [...forms].sort((x, y) => fit(y) - fit(x) || (Object.keys(y.weights)[0] === m.trait) - (Object.keys(x.weights)[0] === m.trait))[0];
    if (best) { info[best.id] = info[c.id]; team[i] = best; }
  }
  // 드문 상징이라도 그 판에서 시너지 단계를 만든 것은 남김 (11/15 사용자 피드백: 지옥불 럭스·애쉬가 3전쟁기계로 보임 —
  // 실제 판은 릴리아에게 전쟁기계 상징을 줘서 4전쟁기계. 빼면 단계가 떨어지는 상징만 남기고, 효과 없던 상징은 뺌)
  const cnt = t => team.reduce((s, x) => s + (x.traits.includes(t) ? (x.weights?.[t] ?? 1) : 0), 0) + emblems.filter(e => e === t).length;
  const lvl = (t, n) => (d.traits[t]?.breakpoints || []).filter(x => x <= n).length;
  for (const t of rare) {
    const real = b.traits?.[t];
    if (real != null && lvl(t, cnt(t) + 1) > lvl(t, cnt(t)) && cnt(t) + 1 <= real) emblems.push(t);
  }
  // 챔피언·상징으로 설명 안 되는 인원 = 증강 등 (요정 시비르: 챔피언 3명 + 증강 1 = 요정 4) → 주력 시너지만 반영
  // 주력 시너지뿐 아니라 모든 시너지에 (11/15 점검: 싸움꾼 1 표시인데 실제 2 같은 경우 47건 — 증강으로 받은 인원)
  const bonus = {};
  for (const [t, real] of Object.entries(b.traits || {})) {
    if (!d.traits[t]) continue;
    const have = team.reduce((s, x) => s + (x.traits.includes(t) ? (x.weights?.[t] ?? 1) : 0), 0) + emblems.filter(e => e === t).length;
    // 증강 '환영 조합'(비활성 특성을 가장 낮은 단계로 켬)으로 설명되는 경우만 반영.
    // 이미 켜진 시너지에 붙은 +1 은 게임 규칙상 원인이 없어(사용자 11/17: 상징·수호령 말고 인원을 올리는 건 없음) 무시 — 챔피언·상징 기준 인원으로 보여 줌
    const low = d.traits[t].breakpoints?.[0];
    // 11/17 사용자: '환영 조합'은 수호령 효과라 덱 구성으로 보여 줄 필요 없음 → 추가 인원은 모두 빼고 챔피언·상징 기준으로만
    void low; void real; void have;
  }
  return { team, info, emblems, bonus };
}

/** 팀·정보 → 메타 덱 카드 데이터 */
/** unitInfo 에 held = 이 덱에서 그 챔피언이 든 평균 아이템 수(딜+탱 아이템, 상징·도적 제외) */
/** 시너지 추가 인원 표시: 챔피언·상징으로는 비활성인데 실제 판에선 가장 낮은 단계로 켜져 있었으면 증강 "환영 조합"
 * (11/17 확인: DA_PhantomSplash18 "전투 시작: 비활성화된 특성 최대 N개가 가장 낮은 등급으로 활성화" — 싸움꾼 1→2, 나무정령 1→3 같은 판이 많음) */
function bonusLabel(t) {
  const before = t.count - t.bonus, low = t.breakpoints?.[0];
  const phantom = low && before < low && t.count === low;
  return phantom
    ? `<span class="aug" title="증강 '환영 조합': 전투 시작 시 비활성 특성을 가장 낮은 단계로 켜 줘요. 랭커 실제 판에서 이 시너지가 그렇게 켜졌어요">환영 조합</span>`
    : `<span class="aug" title="랭커 실제 판의 시너지 인원이 챔피언·상징으로 계산한 것보다 많았어요. 경기 데이터엔 원인이 남지 않아요">기타 +${t.bonus}</span>`;
}
function withHeld(info, m) {
  const out = {};
  for (const [k, u] of Object.entries(info || {})) out[k] = u?.off != null ? { ...u, held: Math.round((u.off + (u.tank || 0)) / Math.max(1, (u.rate || 0) * m.games) * 100) / 100 } : u;
  return out;
}
/** 핵심 캐리·탱커 말고도 아이템을 드는 챔피언 (평균 1.5개 이상, 많이 드는 순 최대 2명) */
const HOLDER_MIN = 1.5;
function holderIds(x, carryId, tankId) {
  return x.team.filter(c => c.id !== carryId && c.id !== tankId && (x.unitInfo?.[c.id]?.held || 0) >= HOLDER_MIN)
    .sort((a, b) => x.unitInfo[b.id].held - x.unitInfo[a.id].held).slice(0, 2).map(c => c.id);
}
function metaDeckFrom(m, team, info, emblems, carry, byLower, swap, isReal, bonus = {}) {
  const d = state.data;
  {
    const ev = evaluateTeam(team, d, { carryIds: [carry.id], emblems, bonus });
    let tank = m.mainTank ? byLower.get(m.mainTank) : null;
    if (tank && swap[tank.id]) tank = swap[tank.id];
    if (tank && !team.includes(tank)) tank = team.find(c => (c.base || c.id) === (tank.base || tank.id)) || tank;
    if (tank && team.includes(tank)) ev.core = { carry: carry.id, tank: tank.id };
    const tier = deckTier(m);
    // 3성작: 3코스트 이하 챔피언이 그 덱에서 절반 이상 3성으로 완성됨
    const reroll = team.some(c => c.cost <= 3 && (info[c.id]?.star3 || 0) >= 0.5);
    const builds = {};
    for (const [id, b] of Object.entries(m.builds || {})) { let c = byLower.get(id); if (c && swap[c.id]) c = swap[c.id]; if (c && !team.includes(c)) c = team.find(x => (x.base || x.id) === (c.base || c.id)) || c; if (c && b && b.games >= DECK_BUILD_MIN) builds[c.id] = b; }
    // 화면 레벨 = 보여 주는 보드의 칸 수(2칸 챔피언 포함). 평균 레벨 반올림(m.level)을 쓰면 "9레벨인데 8명"처럼 어긋남 (11/15 사용자 피드백)
    const level = isReal ? Math.min(10, team.reduce((s, c) => s + (c.slots || 1), 0)) : m.level;
    const value = isValueDeck(team, { ...m, level }, ev);
    const mainCnt = ev.traits.find(t => t.id === m.trait)?.count || 0;
    return {
      ...ev, team: [...team].sort((a, b) => a.cost - b.cost), m, tier, unitInfo: withHeld(info, m), builds, carryChampId: carry.id, value, realBoard: isReal, level,
      title: `<span class="tier t${tier}">${tier}</span> ${value ? `${esc(carry.name)} 밸류 <span class="tag soft" title="밸류덱: 시너지보다 5코스트 챔피언으로 힘을 내는 덱. 랭커 경기에서 주력으로 잡힌 시너지는 ${esc(traitName(m.trait))} ${mainCnt}명">${esc(traitName(m.trait))} ${mainCnt}</span>` : `${esc(traitName(m.trait))} · ${esc(carry.name)}`}${reroll ? ' <span class="tag reroll">3성작</span>' : ''}${emblemNote(m, { team, assignment: ev.assignment, unitInfo: info })}${m.mergedTraits?.length ? ` <span class="tag soft" title="같은 구성인데 랭커 경기에서 주력 시너지가 ${esc(m.mergedTraits.map(traitName).join(', '))}(으)로 잡힌 판도 합쳤어요">${esc(m.mergedTraits.map(traitName).join('·'))} 포함</span>` : ''}`,
      metaInfo: `평균 <b>${m.avgPlace}등</b>${patchDelta(m)} · 순방 ${(m.top4 * 100).toFixed(0)}% · 1등 ${(m.win * 100).toFixed(0)}% · 픽률 ${(m.playRate * 100).toFixed(1)}% · ${m.games}판${patchNote(m)} · 레벨 ${level}${isReal && m.board ? ` · <span class="tag soft" title="이 덱을 쓴 랭커의 실제 최종 보드 중, 자주 쓰인 챔피언을 가장 많이 담은 보드예요. 같은 구성으로 ${m.board.same}판, 평균 ${m.board.avgPlace}등">${m.board.same > 1 ? `랭커 실제 보드 · 같은 구성 ${m.board.same}판` : '랭커 실제 보드'}</span>` : ''}`,
    };
  }
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
  const p = state.weights?.patch, box = $('metaPatch'), chips = $('metaPatchChips');
  if (!p?.current || !metaAvailable()) { box.hidden = true; chips.hidden = true; return; }
  const cur = p.matches?.[p.current] || 0, prev = p.prev ? p.matches?.[p.prev] || 0 : 0;
  const vs = patchViews(), view = viewPatch();
  chips.hidden = vs.length < 2;
  chips.innerHTML = vs.map(v => `<button role="tab" aria-pressed="${(view || p.current) === v}" data-mp="${esc(v)}">${esc(v)}${v === p.current ? ' <small>최신</small>' : ''}</button>`).join('');
  box.hidden = false;
  if (view) {
    const n = p.matches?.[view] || 0, before = vs[vs.indexOf(view) + 1];
    box.innerHTML = `<b>${esc(view)} 패치</b> 기록으로 보는 중 · ${n.toLocaleString()}경기 · 지난 패치라 지금과 다를 수 있어요 (보드·3신기는 최근 기록 기준)`
      + (before ? ` · <span class="pdelta up">▲</span><span class="pdelta down">▼</span> = ${esc(before)} 대비` : '');
    return;
  }
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
    const db = dk.m.builds?.[carryId], build = db && db.games >= DECK_BUILD_MIN ? db.items : [];
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
// 홈의 패치 배너는 patches.json 이 늦게 오면 그때 다시 그림
patchDocReady.then(() => { if (!$('panel-home')?.hidden) renderHome(); });
const DIR_KO = { buff: ['▲', '버프', 'up'], nerf: ['▼', '너프', 'down'], adjust: ['◆', '조정', 'same'] };
const WHERE_KO = { carry: '핵심 캐리', tank: '메인 탱커', core: '구성원', flex: '가끔 쓰는', trait: '주력 시너지' };

// 패치 노트 (11/16 새 디자인): 요약·예측 성적표 → 바뀐 것(숫자 차이 강조) → 덱별 예측 vs 실제 (점 그래프)
let pnFilter = 'all';
/** "285/335/480 → 300/350/550" → 이전 값은 흐리게, 바뀐 숫자만 강조 */
function pnNote(note) {
  return esc(note || '').replace(/([0-9][0-9.%/]*)\s*→\s*([0-9][0-9.%/]*)/g, (all, a, b) => {
    const A = a.split('/'), B = b.split('/');
    const nb = B.map((x, k) => (A.length === B.length && A[k] === x ? x : `<b>${x}</b>`)).join('/');
    return `<span class="pnOld">${a}</span><span class="pnArr">→</span><span class="pnNew">${nb}</span>`;
  }).replace(/ · /g, '<br>');
}
/** 패치 예측용 덱 묶음: groupedDecks() 와 같은 단위. 반환 객체는 patchReport 가 쓰는 comp 모양 + impact + group */
function patchGroups(changes, prev, cur) {
  return groupedDecks().map(g => {
    const members = [g.mainM || g.m, ...(g.variants || []).map(v => v.m)];
    const byPatch = {};
    for (const m of members) for (const [k, s] of Object.entries(m.byPatch || {})) {
      const b = (byPatch[k] ||= { games: 0, sum: 0 }); b.games += s.games; b.sum += s.avgPlace * s.games;
    }
    for (const k in byPatch) byPatch[k] = { games: byPatch[k].games, avgPlace: Math.round(byPatch[k].sum / byPatch[k].games * 100) / 100 };
    const wOf = m => (m.byPatch?.[prev]?.games || 0) + (m.byPatch?.[cur]?.games || 0) || m.games || 1;
    const W = members.reduce((s, m) => s + wOf(m), 0);
    let score = 0;
    const hm = new Map();
    for (const m of members) {
      const w = wOf(m) / W, imp = patchImpact(m, changes);
      score += w * imp.score;
      for (const h of imp.hits) {
        // 같은 변경은 하나로 (버전마다 자리가 달라도: 니달리가 어떤 버전은 핵심 캐리, 어떤 버전은 구성원) — 가장 큰 자리로 표시
        const k = `${changes.indexOf(h.change)}|${h.id || ''}`;
        const e = hm.get(k) || { ...h, weight: 0, share: 0, reachSum: 0, best: 0 };
        e.weight += w * h.weight; e.share += w; e.reachSum += w * (h.reach ?? 1);
        if (Math.abs(h.weight) > e.best) { e.best = Math.abs(h.weight); e.where = h.where; e.rate = h.rate; }
        hm.set(k, e);
      }
    }
    const hits = [...hm.values()].map(e => ({ ...e, reach: e.reach != null ? e.reachSum / e.share : undefined }));
    return { trait: g.m.trait, mainCarry: g.m.mainCarry, carry: g.m.carry, byPatch, impact: { hits, score }, group: g };
  });
}
function renderPatch(selected) {
  const box = $('patchView'), chips = $('patchChips');
  if (!patchDoc?.patches) { box.innerHTML = '<div class="empty">패치 정보(data/patches.json)를 불러오지 못했어요.</div>'; return; }
  const list = patchDoc.patches.filter(p => p.summary || p.changes);
  if (!list.length) { box.innerHTML = '<div class="empty">등록된 패치 노트가 없어요.</div>'; return; }
  const latest = [...list].reverse();
  if (selected) chips.dataset.chosen = selected;
  const name = chips.dataset.chosen || (latest.find(x => x.changes?.length) || latest[0]).patch;
  chips.innerHTML = latest.slice(0, 8).map(x => `<button class="pill${x.patch === name ? ' on' : ''}${x.balance === false ? ' minor' : ''}" data-patch="${esc(x.patch)}" title="${esc(x.date)}${x.balance === false ? ' · 밸런스 변경 없음' : ''}">${esc(x.patch)}</button>`).join('');
  const p = list.find(x => x.patch === name);
  const prev = prevBalancePatch(patchDoc.patches, name);
  const d = state.data, byLower = new Map((d?.champions || []).map(c => [c.id.toLowerCase(), c]));
  const champsOf = m => (d?.champions || []).filter(c => c.id.toLowerCase().includes(String(m).toLowerCase()));
  const traitOf = m => Object.entries(d?.traits || {}).find(([k]) => k.toLowerCase() === String(m).toLowerCase());
  const changes = p.changes || [];
  const nBuff = changes.filter(c => c.dir === 'buff').length, nNerf = changes.filter(c => c.dir === 'nerf').length, nAdj = changes.length - nBuff - nNerf;

  // 예측 vs 실제
  // 11/17 사용자(나무정령 드레이븐 = 실제로는 드레이븐 밸류): 티어표와 같은 덱 묶음 단위로 예측·채점.
  // 버전마다 영향을 계산해 판수(이전+이번 패치) 가중 평균, 패치별 성적은 판수 합산 → 이름·표본이 티어표와 일치
  const comps = metaAvailable() ? patchGroups(changes, prev, p.patch) : [];
  const rep = changes.length && prev && comps.some(c => c.byPatch) ? patchReport(comps, p, prev) : null;
  const affected = new Map(); // 변경 → 영향 받는 덱 수
  for (const r of rep?.rows || []) for (const h of r.hits) if (h.where !== 'flex' && h.where !== 'core' && (h.share ?? 1) >= 0.2) affected.set(h.change, (affected.get(h.change) || 0) + 1); // 핵심 캐리·탱커·주력 시너지인 덱만

  // 1) 머리: 요약 + 성적표
  const miss = rep ? rep.judged - rep.hits : 0;
  const score = rep && rep.judged
    ? `<div class="pnScore"><span class="lbl">예측이 맞은 덱</span><div class="big">${rep.hits}<small> / ${rep.judged}</small></div>
        <div class="pnBar" role="img" aria-label="적중 ${rep.hits}, 빗나감 ${miss}, 구분 어려움 ${rep.flat}"><i class="hit" style="flex:${rep.hits}"></i><i class="miss" style="flex:${miss}"></i><i class="flat" style="flex:${rep.flat}"></i></div>
        <div class="pnLegend"><span><i class="hit"></i>적중 ${rep.hits}</span><span><i class="miss"></i>빗나감 ${miss}</span><span><i class="flat"></i>구분 어려움 ${rep.flat}</span></div>
        <p>실제 변화가 판수 오차보다 큰 덱만 채점해요. 기준 패치(${esc(prev)}) 표본이 적으면 구분 어려움이 많아져요.</p></div>`
    : `<div class="pnScore"><span class="lbl">예측 채점</span><div class="big muted">—</div><p>${!changes.length ? '밸런스 변경이 없는 패치예요.' : !rep ? '패치별 경기 기록이 쌓이면 채점돼요.' : rep.rows.some(r => r.now) ? '채점할 만큼 바뀐 덱이 없어요. 변화가 판수 오차 안이거나, 덱 자체가 받은 영향이 작아요.' : '이번 패치 경기가 쌓이는 중이에요.'}</p></div>`;
  const head = `<div class="pnHero">
    <div class="pnIntro">
      <div class="pnTitle"><h2>${esc(p.patch)} 패치</h2><span class="muted">${esc(p.date)} · 한국 서버는 다음 날 아침 적용</span></div>
      ${changes.length ? `<div class="pnCounts">${nBuff ? `<span class="cnt up">▲ 버프 ${nBuff}</span>` : ''}${nNerf ? `<span class="cnt down">▼ 너프 ${nNerf}</span>` : ''}${nAdj ? `<span class="cnt same">◆ 조정 ${nAdj}</span>` : ''}</div>` : ''}
      ${p.summary ? `<p class="pnSum">${esc(p.summary)}</p>` : ''}
      <div class="pnLinks">${p.source ? `<a href="${esc(p.source)}" target="_blank" rel="noopener">공식 패치노트 ↗</a>` : ''}${p.source_ko ? `<a href="${esc(p.source_ko)}" target="_blank" rel="noopener">롤체지지 한글 노트 ↗</a>` : ''}</div>
    </div>${score}</div>`;

  // 2) 바뀐 것
  const card = c => {
    const [arrow, word, cls] = DIR_KO[c.dir] || DIR_KO.adjust;
    let icon = '', nm = c.name || c.match;
    if (c.kind === 'champion') { const ch = champsOf(c.match)[0]; if (ch) { icon = hexPor(ch); nm = formClean(ch.name); } }
    if (c.kind === 'trait') { const tr = traitOf(c.match); if (tr) { icon = traitBadge(tr[0], c.dir === 'nerf' ? 'bronze' : 'gold'); nm = tr[1].name; } }
    const n = affected.get(c);
    return `<div class="pnCard ${cls}">${icon ? `<span class="pnIc">${icon}</span>` : ''}<div class="pnTx"><div class="pnName"><b>${esc(nm)}</b><span class="pdir ${cls}">${arrow} ${word}</span>${n ? `<span class="pnAff" title="이 챔피언·시너지가 핵심 캐리·메인 탱커·주력 시너지인 메타 덱 수">핵심인 덱 ${n}개</span>` : ''}</div><div class="pnNote">${pnNote(c.note)}</div></div></div>`;
  };
  const main = changes.filter(c => c.kind === 'champion' || c.kind === 'trait' || c.kind === 'item');
  const etc = changes.filter(c => !main.includes(c));
  const KIND = { augment: '증강', wisp: '수호령' };
  const changeHtml = changes.length ? `<section class="pnSec"><h3>바뀐 것</h3>
    ${main.length ? `<div class="pnGrid">${main.map(card).join('')}</div>` : ''}
    ${etc.length ? `<div class="pnEtc"><span class="muted small">증강·수호령 (덱 예측에는 반영 안 함)</span>${etc.map(c => { const [arrow, , cls] = DIR_KO[c.dir] || DIR_KO.adjust; return `<div class="pnLine"><span class="kind">${KIND[c.kind] || ''}</span><b>${esc(c.name || c.match)}</b><span class="pdir ${cls}">${arrow}</span><span class="pnNote">${pnNote(c.note)}</span></div>`; }).join('')}</div>` : ''}
  </section>` : '';

  // 3) 덱별 예측 vs 실제
  let predHtml = '';
  if (!changes.length) predHtml = '';
  else if (!comps.length) predHtml = '<div class="empty">메타 덱 통계가 없어서 영향 예측을 할 수 없어요.</div>';
  else if (!rep) predHtml = '<div class="empty">통계 파일에 패치별 기록이 아직 없어요. 다음 수집 후 표시돼요.</div>';
  else if (!rep.rows.length) predHtml = '<div class="empty">바뀐 챔피언·시너지를 쓰는 메타 덱이 없어요.</div>';
  else {
    const status = r => r.verdict || (r.base ? 'wait' : 'nobase');
    const order = { hit: 0, miss: 0, flat: 1, wait: 2, nobase: 3 };
    const all = rep.rows.filter(r => r.base || r.now).sort((a, b) => order[status(a)] - order[status(b)] || Math.abs(b.rel) - Math.abs(a.rel));
    const counts = all.reduce((o, r) => (o[status(r)] = (o[status(r)] || 0) + 1, o), {});
    const F = [['all', '전체', all.length], ['hit', '적중', counts.hit], ['miss', '빗나감', counts.miss], ['flat', '구분 어려움', counts.flat], ['wait', '판 쌓이는 중', (counts.wait || 0) + (counts.nobase || 0)]].filter(f => f[0] === 'all' || f[2]);
    if (!F.some(f => f[0] === pnFilter)) pnFilter = 'all';
    const shown = all.filter(r => pnFilter === 'all' || status(r) === pnFilter || (pnFilter === 'wait' && status(r) === 'nobase')).slice(0, 24);
    // 점 그래프: 평균 등수 2.5(왼쪽, 좋음) ~ 6(오른쪽, 나쁨)
    const LO = 2.5, HI = 6, pos = v => Math.max(0, Math.min(100, (v - LO) / (HI - LO) * 100));
    const V = { hit: ['hit', '✓ 적중'], miss: ['miss', '✗ 빗나감'], flat: ['flat', '구분 어려움'], wait: ['wait', '판 쌓이는 중'], nobase: ['wait', '비교 불가'] };
    const rows = shown.map(r => {
      const c = r.comp, g = c.group, carry = carryOfDeck(g) || byLower.get(c.mainCarry || c.carry);
      const why = r.hits.filter(h => (h.share ?? 1) * (h.reach ?? 1) >= 0.2).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).map(h => {
        const nm = h.where === 'trait' ? (traitOf(h.change.match)?.[1].name || traitName(c.trait)) : formClean(byLower.get(h.id)?.name || h.id);
        const [arrow, , cls] = DIR_KO[h.change.dir];
        const wk = WHERE_KO[h.where];
        return `<span class="pnWhy"${h.reach != null ? ` title="${h.change.minCount}단계만 바뀐 변경이라, 이 덱이 ${h.change.minCount}명 이상 간 판(${Math.round(h.reach * 100)}%)만큼만 반영했어요"` : ''}>${wk} ${esc(nm)}${h.where === 'flex' && h.rate != null ? ` ${Math.round(h.rate * 100)}%` : ''}${h.reach != null ? ` ${h.change.minCount}단계 ${Math.round(h.reach * 100)}%` : ''} <span class="pdir ${cls}">${arrow}</span></span>`;
      }).join('');
      const st = status(r), [vc, vt] = V[st];
      const reg = deckRegistry.push({ ...g, bdName: deckName(g) }) - 1;
      const dots = [];
      if (r.base) dots.push(`<i class="dot base" style="left:${pos(r.base.avgPlace)}%" title="${esc(prev)} 실제 ${r.base.avgPlace}등 (${r.base.games}판)"></i>`);
      if (r.predAvg != null) dots.push(`<i class="dot pred" style="left:${pos(r.predAvg)}%" title="${esc(p.patch)} 예측 ${r.predAvg}등"></i>`);
      if (r.now) dots.push(`<i class="dot now ${vc}" style="left:${pos(r.now.avgPlace)}%" title="${esc(p.patch)} 실제 ${r.now.avgPlace}등 (${r.now.games}판)"></i>`);
      const span = r.base && r.now ? `<i class="span" style="left:${Math.min(pos(r.base.avgPlace), pos(r.now.avgPlace))}%;width:${Math.abs(pos(r.now.avgPlace) - pos(r.base.avgPlace))}%"></i>` : '';
      // 실제 결과도 예측과 같은 기준(이전 패치 대비)으로 색 표시 (11/17 사용자: 4.95 → 예측 4.62 → 실제 4.83 이면 "그래도 올랐다" 초록)
      const ad = r.base && r.now ? r.now.avgPlace - r.base.avgPlace : null;
      const actWord = ad == null ? '' : Math.abs(ad) < 0.05 ? '<span class="pdir same">– 비슷</span><br>' : `<span class="pdir ${ad < 0 ? 'up' : 'down'}">${ad < 0 ? '▲' : '▼'}${Math.abs(ad).toFixed(2)} ${ad < 0 ? '올랐음' : '내렸음'}</span><br>`;
      const gap = r.predAvg != null && r.now ? r.now.avgPlace - r.predAvg : null;
      const own = Math.abs(PRED_PER_POINT * r.score) >= PRED_MIN; // 덱 자체 영향이 있어야 오를/내릴 것
      const predWord = !own ? '<span class="pdir same" title="덱 자체가 받는 영향이 작아요 (숫자는 다른 덱 변화까지 반영한 값)">– 비슷</span>' : r.predDelta <= -PRED_MIN ? '<span class="pdir up">▲ 오를 것</span>' : r.predDelta >= PRED_MIN ? '<span class="pdir down">▼ 내릴 것</span>' : '<span class="pdir same">– 비슷</span>';
      return `<div class="pnRow ${vc}">
        <div class="pnDeck">${carry ? hexPor(carry) : ''}<div><b>${esc(deckName(g))}</b>${g.variants?.length ? `<span class="muted small"> · 버전 ${g.variants.length + 1}개</span>` : ''}<div class="pnWhys">${why || '<span class="pnWhy">직접 바뀐 것 없음</span>'}</div></div></div>
        <div class="pnNums">
          <div><span class="k">${esc(prev)}</span><b>${r.base ? r.base.avgPlace.toFixed(2) : '—'}</b><small>${r.base ? r.base.games + '판' : '표본 부족'}</small></div>
          <div><span class="k">예측</span><b>${r.predAvg != null ? r.predAvg.toFixed(2) : '—'}</b><small>${predWord}</small></div>
          <div><span class="k">${esc(p.patch)} 실제</span><b>${r.now ? r.now.avgPlace.toFixed(2) : '—'}</b><small>${actWord}${r.now ? r.now.games + '판' : '쌓이는 중'}</small></div>
        </div>
        <div class="pnTrack" aria-hidden="true">${span}${dots.join('')}</div>
        <div class="pnRes"><span class="pnVerdict ${vc}">${vt}</span>${r.actualDelta != null ? `<small>${gap != null && Math.abs(gap) >= 0.05 ? `예측보다 ${Math.abs(gap).toFixed(2)}등 ${r.predDelta <= -PRED_MIN ? (gap > 0 ? '덜 오름' : '더 오름') : r.predDelta >= PRED_MIN ? (gap > 0 ? '더 내림' : '덜 내림') : (gap > 0 ? '나쁨' : '좋음')} · ` : ''}판수 오차 ±${r.noise}</small>` : ''}${reg >= 0 ? `<button class="altopen toBuilder" data-reg="${reg}">배치툴</button>` : ''}</div>
      </div>`;
    }).join('');
    predHtml = `<div class="pnFilters" id="pnFilters">${F.map(([k, l, n]) => `<button class="pill${k === pnFilter ? ' on' : ''}" data-f="${k}">${l} <span>${n}</span></button>`).join('')}</div>
      <div class="pnAxis"><span></span><span></span><span class="pnScale"><em>2.5등 · 좋음</em><em>6등 · 나쁨</em></span><span class="pnKeys"><span><i class="dot base"></i>${esc(prev)}</span><span><i class="dot pred"></i>예측</span><span><i class="dot now hit"></i>실제</span></span></div>
      <div class="pnRows">${rows || '<div class="empty">이 조건의 덱이 없어요.</div>'}</div>
      <details class="pnHow"><summary>예측은 어떻게 하나요?</summary><p>이전 밸런스 패치(${esc(prev)}) 성적에서 출발해, 바뀐 챔피언이 그 덱의 <b>핵심 캐리</b>면 크게, <b>탱커</b>면 중간, <b>구성원</b>이면 작게, <b>주력 시너지</b>가 바뀌면 크게 반영해요. 평균 등수는 8명이 1~8등을 나눠 갖는 값이라, 메타 전체가 받은 평균 영향보다 더 받은 만큼만 오르내린다고 봐요(그래서 작은 버프를 받아도 다른 덱이 더 크게 버프받으면 예측이 내려갈 수 있어요). 덱 자체 영향이 0.1등보다 작으면 이전 패치 그대로로 예측해요. 4판 중 1판도 안 쓰는 챔피언의 변경은 빼요. 실제 변화가 판수로 생기는 오차(±)보다 작거나, 덱 자체가 받는 영향이 0.1등보다 작으면 "구분 어려움"으로 보고 채점하지 않아요. 시너지의 특정 단계만 바뀐 경우(나무정령 9단계 등)는 그 덱이 그 인원까지 간 판 비율만큼만 반영해요. 증강·수호령 변경은 예측에 넣지 않아요.</p></details>`;
  }
  box.innerHTML = head + changeHtml + (changes.length ? `<section class="pnSec"><h3>메타 덱 영향 · 예측 vs 실제</h3>${predHtml}</section>` : '');
}

let metaView = 'tier';
function renderMeta() {
  renderPatchInfo();
  const d = state.data, w = state.weights;
  const box = $('metaList'), tbox = $('metaTiers');
  for (const b of $('metaView').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === metaView);
  for (const id of ['metaSortWrap', 'metaKindWrap', 'metaTraitWrap', 'metaQ', 'metaHelp']) $(id).hidden = metaView === 'tier';
  tbox.innerHTML = ''; box.innerHTML = '';
  if (!d) return;
  if (!metaAvailable()) {
    box.innerHTML = '<div class="empty">메타 덱 통계가 없어요. collect-stats.bat 으로 경기 데이터를 모은 뒤 새로고침하면 표시돼요.</div>';
    return;
  }
  const byId = new Map(d.champions.map(c => [c.id, c]));
  if (metaView === 'tier') return renderTiers(byId);
  renderMetaList(byId);
}

// ---- 덱 목록 (11/17): 티어표와 같은 덱 묶음·티어 기준 + 필터(종류·시너지·챔피언) + 정렬 ----
// (예전엔 캐리 챔피언 단위 metaDecks 30개 + 고정 기준 티어 글자라 티어표와 달랐음)
function renderMetaList(byId) {
  const box = $('metaList'), min = Number($('metaMin').value);
  const view = viewPatch();
  const { tiers } = tierList(groupedDecks(view), { min });
  const rows = [...tiers.S, ...tiers.A, ...tiers.B, ...tiers.C];
  // 시너지 목록: 지금 덱들의 주력 시너지 (덱 수 많은 순)
  const sel = $('metaTrait'), cur = sel.value, cnt = {};
  for (const x of rows) if (!x.value) cnt[x.m.trait] = (cnt[x.m.trait] || 0) + 1;
  sel.innerHTML = `<option value="">전체</option>` + Object.entries(cnt).sort((a, b) => b[1] - a[1] || traitName(a[0]).localeCompare(traitName(b[0]), 'ko'))
    .map(([t, n]) => `<option value="${esc(t)}"${t === cur ? ' selected' : ''}>${esc(traitName(t))} (${n})</option>`).join('');
  const kind = $('metaKind').value, trait = sel.value, q = $('metaQ').value.trim();
  const list = rows.filter(x => (kind === 'all' || tierKind(x) === kind) && (!trait || (!x.value && x.m.trait === trait))
    && (!q || [x, ...(x.variants || [])].some(v => v.team.some(c => c.name.includes(q) || (c.base || '').includes(q)))));
  const games = x => x.tierGames || tierGames(x.m) || x.m.games;
  const rank = { S: 0, A: 1, B: 2, C: 3 };
  const sorters = {
    tier: (a, b) => rank[a.tier] - rank[b.tier] || a.m.avgPlace - b.m.avgPlace,
    avg: (a, b) => a.m.avgPlace - b.m.avgPlace,
    pick: (a, b) => games(b) - games(a),
    win: (a, b) => b.m.win - a.m.win,
  };
  list.sort(sorters[$('metaSort').value] || sorters.tier);
  const pct = v => Math.round(v * 100) + '%';
  box.innerHTML = list.length
    ? `<p class="legend">${list.length}개 덱 · 티어는 티어표와 같은 기준(${view ? esc(view) + ' 패치' : '이번 패치'}, 판수 적으면 4.5등 쪽으로 보정) · 보여 주는 보드는 가장 많이 쓰인 버전의 랭커 실제 보드</p>`
      + list.map((x, i) => {
        const vn = x.variants?.length || 0;
        const reroll = /리롤/.test(deckType(x));
        return deckCard({
          ...x, noSpecialTag: true,
          title: `<span class="tier t${x.tier}">${x.tier}</span> ${esc(deckName(x))}${reroll ? ' <span class="tag reroll">3성작</span>' : ''}${vn ? ` <span class="tag soft" title="구성·캐리가 조금 다른 버전을 합친 성적">버전 ${vn + 1}개</span>` : ''}${emblemNote(x.mainM || x.m, x)}`,
          metaInfo: `${esc(deckType(x))} · 평균 <b>${x.m.avgPlace.toFixed(2)}등</b>${patchDelta(x.m)} · 순방 ${pct(x.m.top4)} · 1등 ${pct(x.m.win)} · ${games(x).toLocaleString()}판`,
        }, i, byId);
      }).join('')
    : '<div class="empty">조건에 맞는 덱이 없어요. 필터를 풀거나 최소 판수를 낮춰 보세요.</div>';
}

// ---- 자동 티어표: 이번 패치 성적 기준 S/A/B/C, 덱 단위 ----
const TIER_DESC = { S: '가장 강함', A: '강함', B: '할 만함', C: '비추천' };
let tierDecks = [];
/** 덱 이름: 밸류덱은 "드레이븐 밸류", 아니면 "주력 시너지 캐리" */
// 캐리 여러 명이 아이템을 나눠 드는 덱(묶인 버전의 캐리가 판수 15% 이상)은 "개화 아리·자이라"
const carryNames = d => (d.carries?.length ? d.carries : [carryOfDeck(d)?.name || '']).join('·');
// "지옥불 럭스 (지옥불)" → "럭스" 처럼 형태 챔피언 이름의 괄호 정리 (덱 이름 앞에 시너지가 이미 붙음)
const formClean = n => n.replace(/^(.+?) \((.+)\)$/, '$1');
const deckName = (d, sep = ' ') => (d.value ? `${formClean(carryNames(d))} 밸류` : `${traitName(d.m.trait)}${sep}${formClean(carryNames(d))}`);
const carryOfDeck = d => { const cid = d.carryChampId?.toLowerCase() || d.m.mainCarry || d.m.carry; return d.team.find(c => c.id.toLowerCase() === cid); };
/** 덱 종류: 3코 이하 챔피언이 절반 이상 3성이면 "N코 리롤", 아니면 "캐리 코스트 + 레벨" */
function deckType(d) {
  const rr = d.team.filter(c => c.cost <= 3 && (d.unitInfo?.[c.id]?.star3 || 0) >= 0.5).map(c => c.cost);
  if (rr.length) return `${Math.min(...rr)}코 리롤`;
  return `${carryOfDeck(d)?.cost || '?'}코 ${d.level || d.m.level}레벨`;
}
/** 같은 덱의 여러 버전(groupDecks) → 판수 가중으로 합친 성적 */
function combineDecks(main, variants) {
  const g = x => tierGames(x.m) || x.m.games;
  if (!variants.length) return { ...main, variants };
  const all = [main, ...variants];
  // 캐리별 판수 (같은 챔피언의 다른 형태는 하나로) → 판수 15% 이상인 캐리 최대 2명을 이름에
  const ck = c => c?.base || c?.name;
  const byCarry = new Map();
  for (const x of all) { const c = carryOfDeck(x); if (!c) continue; byCarry.set(ck(c), (byCarry.get(ck(c)) || 0) + g(x)); }
  const totalG = all.reduce((s, x) => s + g(x), 0);
  const mainKey = ck(carryOfDeck(main));
  const carries = [mainKey, ...[...byCarry].filter(([k, n]) => k !== mainKey && n >= 0.15 * totalG).sort((a, b) => b[1] - a[1]).map(([k]) => k)].slice(0, 2);
  const tw = all.reduce((s, x) => s + g(x), 0);
  const wavg = f => all.reduce((s, x) => s + f(x.m) * g(x), 0) / tw;
  const side = k => {
    const xs = all.map(x => x.m[k]).filter(v => v?.games);
    if (!xs.length) return null;
    const n = xs.reduce((s, v) => s + v.games, 0);
    return { games: n, avgPlace: Math.round(xs.reduce((s, v) => s + v.avgPlace * v.games, 0) / n * 100) / 100 };
  };
  const m = {
    ...main.m,
    games: all.reduce((s, x) => s + x.m.games, 0),
    patchGames: main.m.patchGames == null ? undefined : all.reduce((s, x) => s + (x.m.patchGames || 0), 0),
    avgPlace: Math.round(wavg(m => m.avgPlace) * 100) / 100,
    top4: wavg(m => m.top4), win: wavg(m => m.win),
    playRate: all.reduce((s, x) => s + (x.m.playRate || 0), 0),
    now: side('now'), before: side('before'),
  };
  // 챔피언 사용 비율도 묶인 버전 전체 기준으로 (지옥불 럭스·애쉬: 럭스 버전만 보면 애쉬 39% → 전체로는 거의 매판)
  const bk = c => c.base || c.id;
  const rateIn = (x, base) => { const c = x.team.find(t => bk(t) === base); return c ? (x.unitInfo?.[c.id]?.rate ?? 1) : 0; };
  const star3In = (x, base) => { const c = x.team.find(t => bk(t) === base); return c ? (x.unitInfo?.[c.id]?.star3 || 0) : 0; };
  const unitInfo = {};
  for (const c of main.team) {
    const base = bk(c);
    unitInfo[c.id] = { ...(main.unitInfo?.[c.id] || {}), rate: all.reduce((s, x) => s + g(x) * rateIn(x, base), 0) / totalG, star3: all.reduce((s, x) => s + g(x) * star3In(x, base), 0) / totalG };
  }
  return { ...main, m, tier: deckTier(m), variants, mainM: main.m, mainGames: g(main), carries: carries.length > 1 ? carries : main.carries, unitInfo };
}
let tierFilter = 'all', tierSel = null;
/** 덱 종류 필터: 밸류 / 리롤 / 레벨업 */
const tierKind = x => x.value ? 'value' : /리롤/.test(deckType(x)) ? 'reroll' : 'level';
/** 시너지 육각 배지 (단계 색: 고유 금, 마지막 단계 금(4단계 이상이면 프리즘), 그 아래 동·은·금) */
function traitStyle(tier, max) { return !tier ? '' : max === 1 ? 'gold' : tier >= max ? (max >= 4 ? 'prism' : 'gold') : ['bronze', 'silver', 'gold'][Math.min(tier, 3) - 1]; }
function traitBadge(id, style = '', sm = false) {
  const ic = state.data?.traits?.[id]?.icon;
  return `<span class="tb ${style}${sm ? ' sm' : ''}">${ic ? `<img src="${esc(ic)}" alt="" loading="lazy">` : ''}</span>`;
}
const hexPor = (c, extra = '') => `<span class="por" data-cost="${c?.cost || 1}"${extra}>${c?.icon ? `<img src="${esc(c.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}</span>`;

/** 티어표와 같은 덱 묶음 (작은 버전은 큰 덱에 합침) — 티어표·다음 수 추천 공용 */
// 지난 패치로 보기 (11/18 사용자: 새 패치 첫날엔 티어표가 휑함 → 18.6·18.7 을 눌러서 보도록)
// 덱마다 집계 byPatch[패치] 성적(판수·평균·순방·1등)으로 바꿔서 같은 묶음·티어 계산. 보드·3신기는 최근 기록 그대로.
let metaPatchSel = null; // null = 최신 패치
function patchViews() {
  const w = state.weights?.patch;
  if (!w?.current) return [];
  const order = (patchDoc?.patches || []).map(p => p.patch);
  const idx = p => { const i = order.indexOf(p); return i < 0 ? -1 : i; };
  return Object.entries(w.matches || {}).filter(([p, n]) => p === w.current || n >= 300)
    .map(([p]) => p).sort((a, b) => idx(b) - idx(a) || b.localeCompare(a, 'en', { numeric: true }));
}
const viewPatch = () => (metaPatchSel && metaPatchSel !== curPatch() && patchViews().includes(metaPatchSel) ? metaPatchSel : null);
function patchViewM(m, p, before) {
  const s = m.byPatch?.[p];
  if (!s?.games) return null;
  const b = before ? m.byPatch?.[before] : null;
  return { ...m, games: s.games, patchGames: s.games, avgPlace: s.avgPlace, top4: s.top4 ?? m.top4, win: s.win ?? m.win, now: s, before: b?.games ? b : null };
}
function groupedDecks(view = null) {
  let base = metaDecks(1);
  if (view) {
    const vs = patchViews(), before = vs[vs.indexOf(view) + 1] || null;
    base = base.map(d => { const m = patchViewM(d.m, view, before); return m ? { ...d, m } : null; }).filter(Boolean);
  }
  const decks = base.map(d => ({ ...d, carryChamp: carryOfDeck(d), games: tierGames(d.m) || d.m.games, value: d.value, trait: d.m.trait })).filter(d => d.carryChamp);
  return groupDecks(decks).map(g => combineDecks(g.main, g.variants));
}
function renderTiers(byId) {
  const min = Number($('metaMin').value);
  const view = viewPatch();
  const grouped = groupedDecks(view);
  const { tiers, watch, cuts } = tierList(grouped, { min });
  tierDecks = [];
  const p = view || curPatch();
  const show = x => tierFilter === 'all' || tierKind(x) === tierFilter;
  const keyOf = x => deckName(x) + '|' + deckType(x);
  const all = [...tiers.S, ...tiers.A, ...tiers.B, ...tiers.C, ...watch];
  if (!tierSel || !all.some(x => keyOf(x) === tierSel)) tierSel = all[0] ? keyOf(all[0]) : null;
  const tile = x => {
    const k = tierDecks.push(x) - 1, m = x.m, carry = carryOfDeck(x), vn = x.variants?.length || 0;
    return `<button class="dk" data-k="${k}" aria-pressed="${keyOf(x) === tierSel}" title="${esc(deckName(x))} — 눌러서 덱 보기">
      ${hexPor(carry)}
      <span><span class="nm">${esc(deckName(x))}</span><br><span class="ty">${x.value ? '' : traitBadge(m.trait, '', true)}${esc(deckType(x))}${vn ? ` · 버전 ${vn + 1}개` : ''}</span></span>
      <span class="sc"><b>${m.avgPlace.toFixed(2)}${patchDelta(m)}</b><span>${x.tierGames.toLocaleString()}판</span></span>
    </button>`;
  };
  const row = (t, list, label, open = true) => {
    const vis = list.filter(show);
    if (!vis.length) return '';
    const body = `<div class="decks">${vis.map(tile).join('')}</div>`;
    return open ? `<div class="tierBand" data-t="${t}"><div class="tmark"><span class="thex">${t}</span><small>${label}</small></div>${body}</div>`
      : `<details class="tierBand" data-t="${t}"><summary class="tmark"><span class="thex">${t}</span><small>${label} · ${vis.length}개</small></summary>${body}</details>`;
  };
  const ranked = tiers.S.length + tiers.A.length + tiers.B.length + tiers.C.length;
  const filters = [['all', '전체'], ['reroll', '리롤'], ['level', '레벨업'], ['value', '밸류']]
    .map(([k, n]) => `<button aria-pressed="${tierFilter === k}" data-f="${k}">${n}</button>`).join('');
  const bands = ['S', 'A', 'B'].map(t => row(t, tiers[t], TIER_DESC[t])).join('') + row('C', tiers.C, TIER_DESC.C, false)
    + (watch.filter(show).length ? `<div class="tierBand" data-t="W"><div class="tmark"><span class="thex">?</span><small>지켜볼 덱</small></div><div><p class="tierNote">${view ? esc(view) + ' 패치' : '이번 패치'} 판수가 아직 ${min}판이 안 되지만 성적이 좋은 덱이에요.</p><div class="decks">${watch.filter(show).map(tile).join('')}</div></div></div>` : '');
  $('metaTiers').innerHTML = !ranked && !watch.length
    ? `<div class="empty">${p ? esc(p) + ' 패치에서 ' : ''}${min}판 이상 나온 메타 덱이 아직 없어요. 최소 판수를 낮춰 보세요.</div>`
    : `<div class="tierHead2">
        <div><h2>${p ? esc(p) + ' 패치 티어' : '메타 티어'}</h2>
        <p>랭커 경기의 최종 덱을 묶어 평균 등수 순위로 나눴어요 — 상위 10% S(${cuts.S.toFixed(2)}등까지), 다음 20% A(${cuts.A.toFixed(2)}), 30% B(${cuts.B.toFixed(2)}), 나머지 C. 판수가 적은 덱은 4.5등 쪽으로 보정했고, 보드가 같은 덱은 아이템을 든 챔피언이 달라도 한 덱으로 묶었어요.</p></div>
        <div class="pillFilters" id="tierFilters" role="group" aria-label="덱 종류">${filters}</div>
      </div>
      <div class="tierLayout"><section class="tierBands">${bands || '<p class="muted">이 종류의 덱이 아직 없어요.</p>'}</section><aside class="tierDetail" id="tierDetail" aria-live="polite"></aside></div>`;
  const cur = tierDecks.find(x => keyOf(x) === tierSel) || tierDecks[0];
  if (cur && $('tierDetail')) $('tierDetail').innerHTML = tierDetailHtml(cur, byId);
}

/** 티어표 덱 상세 (오른쪽 패널): 구성 · 3신기 · 시너지 · 다른 구성 · 버전별 성적 */
function tierDetailHtml(x, byId) {
  const m = x.m, mm = x.mainM || x.m;
  const tierColor = { S: 'var(--gold)', A: 'var(--silver)', B: 'var(--bronze)', C: 'var(--faint)' }[x.tier] || 'var(--line)';
  const carry = carryOfDeck(x), carryId = carry?.id, tankId = x.core?.tank;
  const emb = {};
  for (const a of x.assignment || []) if (a.holder) (emb[a.holder] ||= []).push(a);
  const pct = v => Math.round(v * 100) + '%';
  const units = [...x.team].sort((a, b) => (b.id === carryId) - (a.id === carryId) || (b.id === tankId) - (a.id === tankId) || b.cost - a.cost).map(c => {
    const ui = x.unitInfo?.[c.id] || {}, rate = ui.rate ?? 1;
    const opt = rate < 0.5 && c.id !== carryId && c.id !== tankId;
    return `<div class="tUnit${c.id === carryId ? ' carry' : ''}${opt ? ' opt' : ''}">
      <div class="stars">${(ui.star3 || 0) >= 0.5 ? '★★★' : ''}</div>
      <span class="pwrap">${hexPor(c)}${(emb[c.id] || []).map(a => `<span class="embb" title="${esc(traitName(a.trait))} 상징">${traitBadge(a.trait, 'gold', true)}</span>`).join('')}</span>
      ${esc(c.base && c.weights ? c.base : c.name)}<em>${c.id === carryId ? '핵심 캐리' : c.id === tankId ? '메인 탱커' : rate < 0.05 ? '드물게 사용' : opt ? `${pct(rate)}만 사용` : ''}</em></div>`;
  }).join('');
  const builds = [carryId, tankId, ...holderIds(x, carryId, tankId)].filter(Boolean).map(id => {
    const c = byId.get(id), own = x.builds?.[id], b = c && (own || buildsFor(c)[0]);
    return b ? `<div class="tBuild"><span class="who">${id === carryId ? '캐리' : id === tankId ? '탱커' : subRole(b)} ${esc(c.name)}</span>${buildRow(b, !own)}</div>` : '';
  }).join('');
  const order = { prism: 0, gold: 1, silver: 2, bronze: 3, '': 4 };
  const traits = (x.traits || []).filter(t => t.tier > 0).map(t => ({ ...t, st: traitStyle(t.tier, t.breakpoints.length) }))
    .sort((a, b) => (a.breakpoints.length === 1) - (b.breakpoints.length === 1) || order[a.st] - order[b.st] || b.count - a.count)
    .map(t => `<span class="tTr" title="${esc(t.name)} ${t.breakpoints.join('/')}${t.stat ? ` · 실제 경기 평균 ${t.stat.avgPlace}등` : ''}">${traitBadge(t.id, t.st)}<b>${t.count}</b>${esc(t.name)}${t.bonus ? `${bonusLabel(t)}` : ''}${t.breakpoints.length > 1 ? `<span class="bps2">${t.breakpoints.map((b, k) => k === t.tier - 1 ? `<b>${b}</b>` : b).join(' ')}</span>` : ''}</span>`).join('');
  const regMain = deckRegistry.push({ ...x, bdName: deckName(x) }) - 1;
  const alts = altBoards(mm, x.team);
  const mini = (c, cls) => `<span class="mini ${cls}" title="${esc(c.name)}">${hexPor(c)}<i>${cls === 'out' ? '−' : '+'}</i><small>${esc(c.base && c.weights ? c.base : c.name)}</small></span>`;
  const altHtml = alts.length ? `<div class="dSec"><h3>다른 구성</h3><p class="real">랭커가 실제로 쓴 다른 보드예요. 위 보드에서 빼고 넣으면 돼요.</p>${alts.map(a => {
    const ad = altDeck(x, a), reg = ad ? deckRegistry.push({ ...ad, bdName: deckName(x) + ' · 다른 구성' }) - 1 : -1;
    const diff = m.avgPlace - a.avgPlace, few = a.games < 5;
    return `<div class="alt${few ? ' few' : ''}"><div class="altswap">
        <div class="side">${a.remove.map(c => mini(c, 'out')).join('')}</div><span class="arrow" aria-hidden="true">→</span>
        <div class="side">${a.add.map(c => mini(c, 'in')).join('')}${a.emb ? `<span class="mini in" title="${esc(traitName(mm.trait))} 상징">${traitBadge(mm.trait, 'gold')}<i>+</i><small>상징${a.emb > 1 ? ' ×' + a.emb : ''}</small></span>` : ''}${!a.add.length && !a.emb ? '<small class="none">빼기만</small>' : ''}</div>
      </div>
      <div class="altStat"><b>${a.avgPlace}등</b>${few ? '<span class="cmp">표본 적음</span>' : Math.abs(diff) < 0.15 ? '<span class="cmp">덱 평균과 비슷</span>' : `<span class="cmp ${diff > 0 ? 'up' : 'down'}">덱 평균보다 ${diff > 0 ? '▲' : '▼'}${Math.abs(diff).toFixed(2)}</span>`}<small>${a.games}판</small>${reg >= 0 ? `<button class="altopen toBuilder" data-reg="${reg}" title="이 구성을 배치툴에 세우기">배치툴에서 열기</button>` : ''}</div></div>`;
  }).join('')}</div>` : '';
  let vers = '';
  if (x.variants?.length) {
    const g = d => tierGames(d.m) || d.m.games;
    const rows = [{ d: x, main: true }, ...x.variants.map(d => ({ d }))].map(({ d, main: isMain }) => {
      const c = carryOfDeck(d), mc = carryOfDeck(x), otherCarry = !isMain && c && mc && (c.base || c.id) !== (mc.base || mc.id);
      const why = isMain ? (x.carries ? `${mc?.name || ''}에게 아이템을 몰아준 판` : '대표 버전') : otherCarry && c.cost >= 5 && !(x.carries || []).includes(c.base || c.name) && d.m.trait !== x.m.trait ? `후반 ${c.name}에게 아이템` : otherCarry ? `${c.name}에게 아이템을 몰아준 판` : x.value && d.value ? `같은 밸류덱, 함께 켠 시너지가 ${traitName(d.m.trait)}` : '같은 구성, 시너지만 다르게 잡힘';
      const vm = isMain ? x.mainM : d.m;
      return vm ? `<tr><td>${esc(traitName(vm.trait))} · ${esc(c?.name || '')}<span class="why">${esc(why)}</span></td><td>${vm.avgPlace}등</td><td>${(isMain ? x.mainGames : g(d))}판</td></tr>` : '';
    }).join('');
    vers = `<div class="dSec"><h3>버전별 성적</h3><p class="real">보드는 거의 같지만 아이템을 든 챔피언이나 주력 시너지가 다르게 잡힌 판들이에요. 후반 5코 캐리 버전은 이미 이기는 판에서 나오는 경우가 많아 좋아 보일 수 있어요.</p><table class="ver">${rows}</table></div>`;
  }
  const realNote = x.realBoard && mm.board ? `<p class="real">랭커가 실제로 쓴 보드예요${mm.board.same > 1 ? ` · 똑같은 구성 ${mm.board.same}판` : ''}. 흐린 챔피언은 이 덱을 쓴 판 중 절반이 안 되게 넣은 자리고, 육각 배지는 상징이에요.</p>` : '';
  return `<div class="dTop"><span class="thex" style="background:${tierColor}">${x.tier || '?'}</span>
      <div class="dTopMain"><h2>${esc(deckName(x))}</h2><p>${esc(deckType(x))}${x.value ? ` · 함께 켠 시너지 ${esc(traitName(m.trait))}` : ''}${emblemNote(mm, x)}</p></div>
      <button class="btn small primary toBuilder dTopBd" data-reg="${regMain}" title="이 덱을 배치툴에 세우기">배치툴</button></div>
    <div class="dStats"><div><b>${m.avgPlace.toFixed(2)}</b><span>평균 등수${patchDelta(m)}</span></div><div><b>${pct(m.top4)}</b><span>순방</span></div><div><b>${pct(m.win)}</b><span>1등</span></div><div><b>${(x.tierGames || m.games).toLocaleString()}</b><span>판</span></div></div>
    <div class="dSec"><h3>구성 · ${x.level || m.level}레벨</h3>${realNote}<div class="tBoard">${units}</div></div>
    ${builds ? `<div class="dSec"><h3>랭커 3신기</h3>${builds}</div>` : ''}
    <div class="dSec"><h3>시너지</h3><div class="tTraits">${traits}</div></div>
    ${altHtml}${vers}
    <div class="dCta"><button class="btn primary toBuilder" data-reg="${regMain}">배치툴에서 열기</button></div>`;
}

// ---------------- 내 보드 → 다음 수 추천 (배치툴) ----------------
/** 내 보드와 챔피언이 많이 겹치는 메타 덱 (같은 챔피언의 다른 형태도 겹침으로 셈) */
function metaNearBoard(board, carryId) {
  const byId = new Map(state.data.champions.map(c => [c.id, c]));
  const mine = board.map(u => byId.get(u.id)).filter(Boolean);
  const bases = new Set(mine.map(c => c.base || c.id));
  // 11/16 사용자 피드백: 8명 보드에 +5명짜리 덱이 추천됨 → 보드 6명 이상이면 "3명 이하로 더해서 되는 덱"만,
  // 초반(5명 이하)은 지금 챔피언을 거의 다(1명 빼고) 살리는 덱
  const early = mine.length <= 5, MAX_ADD = 3;
  // 11/17 사용자: "요정·소라카 4요정"인데 배치툴에선 3요정 — 랭커 보드의 요정 상징을 그대로 셌기 때문.
  // 상징은 쉽게 못 구하니, 내 보드·남은 아이템에 있는 상징만 쓰고 시너지를 다시 계산
  const d0 = state.data, haveEmb = {};
  for (const id of [...board.flatMap(u => u.items || []), ...bdInventory()]) {
    const e = d0.emblems.find(x => x.id === id || (x.ids || []).includes(id));
    if (e) haveEmb[e.trait] = (haveEmb[e.trait] || 0) + 1;
  }
  const onlyMyEmblems = d => {
    const want = (d.assignment || []).filter(a => a.holder).map(a => a.trait);
    if (!want.length) return d;
    const left = { ...haveEmb }, kept = [], dropped = [];
    for (const t of want) (left[t] > 0 ? (left[t]--, kept) : dropped).push(t);
    if (!dropped.length) return d;
    const carryId = d.carryChampId || d.core?.carry;
    const ev = evaluateTeam(d.team, d0, { carryIds: carryId ? [carryId] : [], emblems: kept });
    const names = [...new Set(dropped)].map(t => traitName(t) + ' 상징').join(', ');
    return { ...d, traits: ev.traits, assignment: ev.assignment, usedEmblems: ev.usedEmblems, droppedNote: ` · <span class="tag soft" title="랭커 보드에는 있었지만 내 보드·남은 아이템에 없는 상징이라 빼고 시너지를 계산했어요">${esc(names)} 없이 계산</span>` };
  };
  // 티어표처럼 묶은 덱 기준 (11/16 사용자: 8판짜리 "햇빛 아지르"가 따로 추천됨 — 실제로는 유나라·카르마·르블랑 3성 리롤에 아지르는 시너지용인 햇빛 유나라 덱의 한 버전)
  return groupedDecks().filter(d => d.m.games >= 8).map(onlyMyEmblems).map(d => ({ ...d, title: `<span class="tier t${d.tier}">${d.tier}</span> ${esc(deckName(d, ' · '))} <span class="tag soft">${esc(deckType(d))}</span>${d.variants?.length ? ` <span class="muted small">버전 ${d.variants.length + 1}개 · 덱 전체 평균 ${d.m.avgPlace}등 · ${d.m.games}판</span>` : ''}`, bdName: deckName(d) })).map(d => {
    const overlap = d.team.filter(c => bases.has(c.base || c.id)).length;
    const carryMatch = carryId && d.core?.carry === carryId;
    const ids = new Set(d.team.map(c => c.id));
    return {
      ...d, overlap, rank: overlap + (carryMatch ? 1.5 : 0) - metaShrunk(d.m) * 0.3,
      board: { added: d.team.filter(c => !bases.has(c.base || c.id)).map(c => c.id), removed: mine.filter(c => !ids.has(c.id)).map(c => c.id) },
      metaInfo: `<b>내 보드와 ${overlap}명 겹침</b>${carryMatch ? ' · 같은 핵심 캐리' : ''} · ${d.metaInfo}${d.droppedNote || ''}`,
    };
  }).filter(d => early ? d.overlap >= 2 && d.board.removed.length <= 1
    : d.board.added.length <= MAX_ADD && d.overlap * 2 >= d.team.length && d.team.length >= mine.length) // 지금보다 작은 덱(빼기만)은 다음 수가 아님
    .sort((a, b) => early ? b.rank - a.rank : a.board.added.length - b.board.added.length || b.rank - a.rank)
    // 보드에 적용했을 때 결과 구성이 같은 덱은 하나만 (예: 처형자·소라카 / 소환사·소라카 → 둘 다 같은 8명)
    .filter((d, i, arr) => arr.findIndex(x => x.team.map(c => c.base || c.id).sort().join() === d.team.map(c => c.base || c.id).sort().join()) === i);
}

function runBoard(btn) {
  const box = $('bdRecs');
  if (!state.data) { setStatus('먼저 데이터를 불러와 주세요.', true); $('databar').open = true; return; }
  const board = bdBoardUnits();
  if (!board.length) { box.innerHTML = '<div class="empty">보드에 챔피언을 먼저 올려 주세요.</div>'; return; }
  bdMarkRecBase();
  btn.disabled = true;
  box.innerHTML = '<div class="empty">내 보드에서 이어갈 덱을 계산하고 있어요…</div>';
  setTimeout(() => {
    const t0 = performance.now();
    try {
      const size = Number($('bdRecSize').value), keepAll = !$('bdRecFlex').checked;
      let res = null;
      // 배치툴은 탭 위 설정 줄(상징 팀 메이커·아이템 탭용)과 무관하게: 코스트 전체, 5코는 9레벨 이상이면 제한 없음(밸류덱), 아래면 2개까지
      const lvl = size || board.length + 1;
      const decks = runSearch(o => { res = decksFromBoard(withForms(state.data, board), { ...o, board, size, keepAll }); return res.decks; }, { size: lvl, maxCost: 5, max5: lvl >= 9 ? 99 : 2 });
      const { info } = res;
      const byId = new Map(state.data.champions.map(c => [c.id, c]));
      // 11/20 사용자: 지금 보드와 똑같은 메타 덱(더할 것·뺄 것 0)은 "다음 수"가 아님 → 위에 한 줄 + 접어서, 목록은 바뀌는 덱만 3개
      const nearAll = metaNearBoard(board, info.carry?.id);
      const sameIdx = nearAll.findIndex(d => !d.board.added.length && !d.board.removed.length);
      const same = sameIdx >= 0 ? nearAll[sameIdx] : null;
      const near = nearAll.filter(d => d !== same).slice(0, 3);
      for (const d of decks) {
        const names = d.board.added.map(id => byId.get(id)?.name).filter(Boolean);
        d.title = `레벨 ${res.size} · <b>+ ${esc(names.join(', '))}</b>`;
      }
      const head = `<div class="resultHead"><h2>다음 수 추천</h2><span class="legend">${((performance.now() - t0) / 1000).toFixed(1)}초 · 지금 ${board.length}명`
        + `${info.carry ? ` · 핵심 캐리 <b>${esc(info.carry.name)}</b>` : ''}`
        + `${info.emblems.length ? ` · 상징 ${info.emblems.map(traitName).map(esc).join(', ')}` : ''}`
        + ` · 점선 = 새로 넣을 챔피언</span></div>`;
      const sameHtml = same
        ? `<details class="recSame"><summary>지금 보드는 이미 <b>${esc(deckName(same, ' · '))}</b> 덱이에요 <span class="tier t${same.tier}">${same.tier}</span> <span class="muted small">평균 ${same.m.avgPlace}등 · ${same.m.games.toLocaleString()}판 — 아이템·3신기 보기</span></summary>${deckCard(same, 0, byId)}</details>`
        : '';
      const metaHtml = sameHtml + (near.length
        ? `<h3 class="recSub">${same ? '여기서 바꿔 갈 수 있는 메타 덱' : '내 보드와 가까운 메타 덱'}</h3>${near.map((d, i) => deckCard(d, i, byId)).join('')}`
        : metaAvailable() ? `<p class="muted small">${board.length <= 5 ? '지금 챔피언을 살려서 갈 수 있는 메타 덱이 없어요.' : '3명 안으로 더해서 갈 수 있는 메타 덱이 없어요.'}</p>` : '');
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
  if (!inventory.length) { box.innerHTML = '<div class="empty">가진 아이템을 "남은 아이템" 칸에 먼저 담아 주세요 (챔피언을 고르지 않은 채 오른쪽 아이템을 누르거나 끌어다 놓기).</div>'; return; }
  const carries = bdCarries();
  const r = assignItems(withForms(state.data, board), { board, inventory, carries });
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
    : a.basis?.kind === 'sparse' ? `<span title="이 챔피언은 랭커 경기에서 아이템을 드는 일이 드물어요. 랭커들이 이 챔피언에게 준 아이템 ${a.basis.total}개 중 비율이에요">랭커가 준 아이템 ${a.basis.total}개 중 ${Math.round(a.basis.share * 100)}% <span class="lowconf">기록 적음</span></span>`
    : a.basis?.kind === 'similar' ? `<span title="이 챔피언의 랭커 기록이 없어서, 역할이 같고 시너지·코스트가 비슷한 챔피언들의 기록으로 판단했어요">비슷한 챔피언(${esc(a.basis.names.join('·'))}) 기록 기준</span>`
    : a.basis?.kind === 'role' ? '<span class="muted" title="참고할 랭커 기록이 없어 역할(물리/마법/탱커)로 판단했어요">기록 없음 → 역할 기준</span>'
    : a.rate != null ? `<span title="랭커 경기에서 이 챔피언이 나온 판 중 이 아이템을 낀 비율이에요">랭커 판 ${Math.round(a.rate * 100)}%에서 낌</span>` : '역할 기준';
  const rows = groups.map(g => `<div class="asgRow"><div class="asgChamp" data-cost="${g.champ.cost}">${img(g.champ.icon)}<div><b>${esc(g.champ.name)}</b>${g.list.every(a => a.other) ? '<div class="small muted" title="고른 챔피언에게 줄 칸이 없거나 안 맞는 아이템이라, 다른 챔피언 중 잘 쓰는 쪽에게 줘요">남는 아이템</div>' : ''}${r.buildMatch?.[g.idx] ? `<div class="small good" title="최종 아이템 3개가 랭커들이 실제로 쓴 조합과 같아요">랭커 3신기 · ${r.buildMatch[g.idx].games}판 ${r.buildMatch[g.idx].avgPlace}등${r.buildMatch[g.idx].few ? ' <span class="lowconf">표본 적음</span>' : ''}</div>` : ''}</div></div>
    <div class="asgItems">${g.list.map(a => `<div class="asgItem">${itemLabel(a.item.id)}${a.from ? `<span class="muted small">${esc(a.from.map(compName).join(' + '))} 조합</span>` : ''}<span class="small">${why(a)}</span></div>`).join('')}</div></div>`).join('');
  const kept = [
    ...r.unplaced.map(x => `${itemLabel(x.id)}<span class="muted small">${x.why === 'nofit' ? (x.kind === 'emblem' ? '시너지가 없는 챔피언이 없음' : '어울리는 챔피언 없음') : '넣을 칸 없음'}</span>`),
    ...r.leftComponents.map(id => `${itemLabel(id)}<span class="muted small">재료 그대로</span>`),
  ];
  box.innerHTML = `
    <div class="resultHead"><h3>아이템 배분 추천</h3><span class="legend">${curPatch() ? esc(curPatch()) + ' 패치 · ' : ''}랭커 경기에서 그 챔피언이 그 아이템을 낀 비율 기준 · ${carries.length ? `<b>${esc(carries.map(i => state.data.champions.find(c => c.id === board.find(b => b.idx === i)?.id)?.name).filter(Boolean).join('·'))}</b>에게 먼저, 남는 아이템은 잘 쓰는 다른 챔피언에게` : '이미 아이템을 든 챔피언에게 몰아줌'} · 적응가는 물리/마법 아이템을 섞지 않음</span></div>
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
// 점검용(콘솔·테스트): 메타 덱 계산 결과를 그대로 볼 수 있게
window.__tftDebug = { metaDecks: n => metaDecks(n), state, tiers: () => tierDecks, grouped: () => groupedDecks(), carryOfDeck: d => carryOfDeck(d), deckName: d => deckName(d), deckType: d => deckType(d) };
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
