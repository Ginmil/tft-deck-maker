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

export function initBuilder(ctx) {
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
export function bdOnData() {
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
export function bdAutoPlace(units, { carryId = null, tankId = null } = {}) {
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
  box.innerHTML = bdState.inv.map((id, i) => {
    const it = bdItemInfo(id);
    return `<span class="chip">${it.icon ? `<img src="${bd.esc(it.icon)}" alt="" class="chipIcon" onerror="this.remove()">` : ''}${bd.esc(it.name)}<button data-i="${i}" aria-label="빼기">✕</button></span>`;
  }).join('');
}
/** 남은 아이템 목록 (자동 배분용) */
export function bdInventory() { return [...bdState.inv]; }
/** 자동 배분 결과를 보드에 넣기: [{ idx, itemId }] + 남길 아이템 목록 (되돌리기 가능) */
export function bdApplyItems(list, keep) {
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
export function bdBoardUnits() {
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

export function bdRender() {
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
