// =============================================================
// 화면 로직
// 데이터 → 어댑터(normalize) → 엔진(search) → 화면
// =============================================================
import { ADAPTER_VERSION, DEFAULT_URL, fetchRaw, listSets, normalize } from './adapters/cdragon.js';
import { decksForItems, emblemTeamMaker, decksFromBoard, craftPlans, recipeBook, carriesForItems, assignItems, withForms } from './engine/search.js';
import { evaluateTeam } from './engine/scorer.js';
import { patchReport, prevBalancePatch, tierOf, tierGames, tierList, shrinkAvg, TIER_CUTS, groupDecks, PRED_MIN, PRED_PER_POINT, patchImpact } from './engine/patch.js';
import { initBuilder, bdOpenDeck, bdOnData, bdRender, bdBoardUnits, bdInventory, bdApplyItems, bdCarries, bdMarkRecBase } from './builder.js';

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
    if (t.dataset.tab === 'builds') renderBuilds();
    if (t.dataset.tab === 'meta') renderMeta();
    if (t.dataset.tab === 'patch') renderPatch();
    if (t.dataset.tab === 'builder') bdRender();
    $('results').hidden = ['meta', 'patch', 'builds', 'builder'].includes(t.dataset.tab);
    // 레벨·코스트·5코스트·특수 기물 설정은 덱을 새로 짜는 탭에서만 의미가 있음 (사용자 피드백 11/15: 메타 덱에도 떠서 헷갈림)
    // 11/17: 옵션은 상징 팀 메이커 안 "시너지 계산 추천 설정" 접기로 옮김 (패널과 함께 보이고 숨음)
    $('results').innerHTML = '';
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
  const list = (st?.builds || []).filter(b => !b.items.some(i => /ThiefsGloves|Tacticians/i.test(i))); // 예전 통계 파일 대비
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

function dexChampHtml(c) {
  if (!c) return '';
  const d = state.data, u = unitStatFor(c), base = c.base || c.id;
  const same = d.champions.filter(x => (x.base || x.id) === base), forms = same.length > 1 ? same.filter(x => x.name !== base) : [];
  const head = `<div class="dTop">${hexPor(c)}<div><h2>${esc(base)}</h2><p>${c.cost}코스트 · ${roleKo[c.role] || ''}${c.ability?.name ? ` · 스킬 ${esc(c.ability.name)}` : ''}${c.stats?.mana ? ` · 마나 ${c.stats.startMana ?? 0}/${c.stats.mana}` : ''}</p></div></div>
    <div class="dexTraits">${c.traits.map(traitLink).join('')}</div>
    ${forms.length ? `<p class="muted small">형태: ${forms.map(f => esc(f.name)).join(', ')} — 랭커 기록에는 형태 구분 없이 하나로 남아요</p>` : ''}`;
  if (!u) return head + '<div class="empty">랭커 기록이 없어요.</div>';
  const stars = Object.entries(u.stars || {}).filter(([, v]) => v.games >= 5).map(([k, v]) => `<span class="pill">${k}성 ${v.avgPlace}등 · ${v.games.toLocaleString()}판</span>`).join('');
  const bs = buildsFor(c).slice(0, 3);
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
    + dexSec('랭커 3신기', bs.length ? bs.map((b, i) => `<div class="${i ? 'alt' : 'best'}">${buildRow(b)}</div>`).join('') : '<p class="muted small">아이템 3개 조합 기록이 부족해요 (5판 이상인 조합 없음)</p>')
    + dexSec('자주 낀 아이템', items ? `<div class="dexItems">${items}</div>` : '', '이 챔피언이 나온 판 중 낀 비율')
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
    + dexSec('이 아이템을 낀 챔피언', carriers ? `<div class="dexHolders">${carriers}</div>` : '', '판 = 그 챔피언이 나온 판 중 낀 비율 · 몫 = 이 아이템 전체 중 그 챔피언에게 간 비율')
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
  const { tiers } = tierList(groupedDecks(), { min });
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
    ? `<p class="legend">${list.length}개 덱 · 티어는 티어표와 같은 기준(이번 패치, 판수 적으면 4.5등 쪽으로 보정) · 보여 주는 보드는 가장 많이 쓰인 버전의 랭커 실제 보드</p>`
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
function groupedDecks() {
  const decks = metaDecks(1).map(d => ({ ...d, carryChamp: carryOfDeck(d), games: tierGames(d.m) || d.m.games, value: d.value, trait: d.m.trait })).filter(d => d.carryChamp);
  return groupDecks(decks).map(g => combineDecks(g.main, g.variants));
}
function renderTiers(byId) {
  const min = Number($('metaMin').value);
  const grouped = groupedDecks();
  const { tiers, watch, cuts } = tierList(grouped, { min });
  tierDecks = [];
  const p = curPatch();
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
    + (watch.filter(show).length ? `<div class="tierBand" data-t="W"><div class="tmark"><span class="thex">?</span><small>지켜볼 덱</small></div><div><p class="tierNote">이번 패치 판수가 아직 ${min}판이 안 되지만 성적이 좋은 덱이에요.</p><div class="decks">${watch.filter(show).map(tile).join('')}</div></div></div>` : '');
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
    .filter((d, i, arr) => arr.findIndex(x => x.team.map(c => c.base || c.id).sort().join() === d.team.map(c => c.base || c.id).sort().join()) === i)
    .slice(0, 3);
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
        : metaAvailable() ? `<p class="muted small">${board.length <= 5 ? '지금 챔피언을 살려서 갈 수 있는 메타 덱이 없어요.' : '3명 안으로 더해서 갈 수 있는 메타 덱이 없어요.'}</p>` : '';
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
