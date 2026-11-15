// =============================================================
// 배치툴 (11/16 새 디자인): 4×7 육각형 보드에 챔피언·아이템·상징·별을 배치하고 시너지를 실시간 계산
// - 여러 단계 되돌리기/다시 실행 (Ctrl+Z / Ctrl+Shift+Z), 보드 밖으로 끌어내 빼기
// - 챔피언 목록: 비용별 / 계열별 / 직업별, 왼쪽 시너지를 누르면 그 시너지로 이동
// - 나무정령 식물(3·5·7) 자동 배치, 달빛 2 이상이면 달빛 챔피언 주변 칸 표시
// - 챔피언 툴팁(스킬 이름·마나·시너지·능력치·랭커 평균·3신기)
// - 덱 카드의 "배치툴에서 열기" → bdOpenDeck(), 저장(브라우저) / 배치 코드 복사·붙여넣기
// 앱(app.js)에서 initBuilder(ctx) 로 연결. ctx = { getData, esc, traitName, roleKo, buildsFor, openTab }
// =============================================================

import { adaptorChamp } from './engine/search.js';

const BD_ROWS = 4, BD_COLS = 7;            // 0행 = 맨 앞줄(적과 가까운 줄), 3행 = 맨 뒷줄
const BD_SAVE_KEY = 'tft-deck-maker:boards';
let bd = null;                              // ctx
// cells[idx] = { id, star, items: [], form?: 'AD'|'AP' }, plants[idx] = 'bark'|'flower'|'guardian', inv = 남은 아이템
const bdState = {
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
const snap = () => JSON.stringify({ cells: bdState.cells, inv: bdState.inv, carries: [...bdState.carries], plants: bdState.plants });
function save() {
  bdState.past.push(snap());
  if (bdState.past.length > 50) bdState.past.shift();
  bdState.future = [];
}
function restore(s) {
  const o = JSON.parse(s);
  bdState.cells = o.cells; bdState.inv = o.inv || []; bdState.carries = new Set(o.carries || []); bdState.plants = o.plants || {};
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
export function bdAutoPlace(units, { carryId = null, tankId = null } = {}) {
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
export function bdOpenDeck(d) {
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
  save();
  if (d.board) {
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
    bdToast('추천 덱을 보드에 적용했어요 · Ctrl+Z 로 되돌리기');
  } else {
    bdState.cells = bdAutoPlace(units, { carryId, tankId });
    bdState.plants = {}; bdState.carries = new Set();
    bd$('bdName').value = d.bdName || (d.title || '').replace(/<span class="tag[^]*$/, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  bdState.sel = null;
  bd.openTab('builder');
  bdRender();
}
let bdResizeT = 0;
addEventListener('resize', () => { clearTimeout(bdResizeT); bdResizeT = setTimeout(() => { if (bdData() && !bd$('panel-builder').hidden) bdRenderBoard(); }, 120); });

/** 남은 아이템 목록 (자동 배분용) */
export function bdInventory() { return [...bdState.inv]; }
/** 사용자가 고른 "아이템 줄 챔피언" 칸 번호들 */
export function bdCarries() { return [...bdState.carries].map(Number); }
/** 자동 배분 결과를 보드에 넣기: [{ idx, itemId }] + 남길 아이템 목록 (되돌리기 가능) */
export function bdApplyItems(list, keep) {
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
export function bdBoardUnits() {
  return Object.entries(bdState.cells).map(([idx, u]) => ({ idx: Number(idx), id: u.id, star: u.star, items: [...u.items], ...(u.form ? { form: u.form } : {}) }));
}

// ---------------- 이벤트 ----------------
export function initBuilder(ctx) {
  bd = ctx;
  bd$('bdClear').onclick = () => { save(); bdState.cells = {}; bdState.inv = []; bdState.plants = {}; bdState.carries = new Set(); bdState.sel = null; bdRender(); };
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
  bd$('bdPaste').onclick = () => {
    const code = prompt('배치 코드를 붙여넣으세요');
    if (!code) return;
    save();
    if (!bdDecode(code.trim())) { bdState.past.pop(); bdToast('코드를 읽지 못했어요'); }
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
    const pl = h && e.target.closest('.plant'), it = h && e.target.closest('.its [data-k]');
    bdState.drag = it ? { itemFrom: Number(h.dataset.i), k: Number(it.dataset.k) } : pl ? { plantFrom: Number(h.dataset.i) } : h ? { from: Number(h.dataset.i) } : pc ? { champ: pc.dataset.id, exact: !!pc.dataset.exact } : ic ? { item: ic.dataset.id } : null;
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
    if (at && at.closest('#bdBoard')) return;
    if (d.from != null && bdState.cells[d.from]) removeUnit(d.from);
    else if (d.itemFrom != null && bdState.cells[d.itemFrom]?.items[d.k]) { // 낀 아이템을 보드 밖으로 = 버리기
      save(); const [gone] = bdState.cells[d.itemFrom].items.splice(d.k, 1); bdRender(); bdToast(`${bdItemInfo(gone).name} 뺐어요`);
    }
  });

  // 선택한 챔피언: 별 / 적응가 형태 / 럭스 형태 / 아이템 빼기
  bd$('bdUnit').addEventListener('click', e => {
    const i = bdState.sel, u = i != null && bdState.cells[i]; if (!u) return;
    const f = e.target.closest('[data-f]'), s = e.target.closest('[data-setstar]'), r = e.target.closest('[data-rmit]'), fm = e.target.closest('[data-form]');
    if (f) { save(); u.id = f.dataset.f; }
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
  bd$('bdTraits').addEventListener('click', e => { const r = e.target.closest('[data-tr]'); if (r) jump(r.dataset.tr); });
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
export function bdOnData() {
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

export function bdRender() {
  // 끌어다 놓는 중에 다시 그리면 끌던 요소가 사라져 dragend 가 안 옴 → 끝난 뒤에 그림
  if (bdState.inDrop) { clearTimeout(bdState.rt); bdState.rt = setTimeout(() => { bdState.inDrop = false; bdRender(); }, 40); return; }
  const data = bdData();
  if (!data) return;
  for (const k of [...bdState.carries]) if (!bdState.cells[k]) bdState.carries.delete(k);
  syncPlants();
  bdRenderBoard(); bdRenderTraits(); bdRenderUnit(); bdRenderInv(); bdRenderPalette(); bdRenderSaved();
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
  const moon = lunarCells(), pStar = plantStar(), moonIcon = moon.id ? bdData().traits[moon.id]?.icon : null;
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
        ${S.carries.has(i) ? '<span class="carryTag" title="아이템 줄 챔피언">템</span>' : ''}${u.form ? `<span class="formTag ${u.form}" title="적응가 ${u.form === 'AD' ? '물리' : '마법'} 형태">${u.form}</span>` : ''}
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
  bd$('bdTraits').innerHTML = rows.length ? rows.map(r => `<div class="trow${r.lvl ? '' : ' off'}" data-tr="${r.id}" role="button" tabindex="0" title="${esc(r.t.name)} 챔피언 보기">${tbadge(r.id, r.lvl ? bdTraitStyle(r.lvl, r.t.breakpoints.length) : '')}<span><span class="tnm">${r.k} ${esc(r.t.name)}</span>${r.uniq ? '' : `<span class="tbp">${r.t.breakpoints.map((b, i) => i === r.lvl - 1 ? `<b>${b}</b>` : b).join(' · ')}</span>`}</span></div>`).join('')
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
    ${forms ? `<div class="formRow"><span class="lbl">${esc(c.base)} 형태</span>${forms.map(f => { const t = Object.keys(f.weights || {})[0]; return `<button data-f="${esc(f.id)}" aria-pressed="${f.id === u.id}">${tbadge(t, f.id === u.id ? 'gold' : '', true)}${esc(bd.traitName(t))}</button>`; }).join('')}</div>` : ''}`;
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
    ${s ? `<hr><div class="st"><span>체력 <b>${s.hp ?? '—'}</b></span><span>공격력 <b>${s.ad ?? '—'}</b></span><span>방어력 <b>${s.armor ?? '—'}</b></span><span>마저 <b>${s.mr ?? '—'}</b></span><span>공속 <b>${s.as ?? '—'}</b></span></div>` : ''}
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
  const arr = Object.entries(bdState.cells).map(([i, u]) => (u.form ? [Number(i), u.id, u.star, u.items, u.form] : [Number(i), u.id, u.star, u.items]));
  return btoa(unescape(encodeURIComponent(JSON.stringify(arr))));
}
function bdDecode(code) {
  try {
    const arr = JSON.parse(decodeURIComponent(escape(atob(code))));
    const cells = {};
    for (const [i, id, star, items, form] of arr) if (bdChamp(id)) cells[i] = { id, star: star === 3 ? 3 : 2, items: items || [], ...(form === 'AD' || form === 'AP' ? { form } : {}) };
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
