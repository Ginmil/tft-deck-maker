// =============================================================
// 화면 로직
// 데이터 → 어댑터(normalize) → 엔진(search) → 화면
// =============================================================
import { ADAPTER_VERSION, DEFAULT_URL, fetchRaw, listSets, normalize } from './adapters/cdragon.js';
import { decksForTraits, decksForItems, emblemTeamMaker, decksFromBoard, craftPlans, recipeBook } from './engine/search.js';
import { evaluateTeam } from './engine/scorer.js';
import { initBuilder, bdOpenDeck, bdOnData, bdRender, bdBoardUnits } from './builder.js';

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
    $('weightLabel').textContent = `통계 가중치 사용 중 · 세트 ${w.setNumber} · ${w.games.toLocaleString()}명 기록 · ${w.generatedAt.slice(0, 10)}`;
  } else {
    delete d.weights; delete d.unitStats; delete d.emblemStats;
    $('weightLabel').textContent = !w ? '통계 가중치 없음 (기본 점수)'
      : w.setNumber !== d.set.number ? `가중치 파일이 세트 ${w.setNumber}용이라 사용 안 함`
      : '통계 가중치 꺼짐';
  }
}

function setData(data) {
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
}

// ---------------- 선택 UI ----------------
const traitName = id => state.data?.traits[id]?.name || id;
const roleKo = { AD: '물리', AP: '마법', TANK: '탱커', FIGHTER: '전사', FLEX: '범용' };

function renderAllPickers() {
  renderEmblems(); renderItems();
  renderTraitList('traitList', state.desired, $('traitFilter').value);
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
  full: '가지고 있는 완성 아이템을 고르세요. 아이템을 가장 잘 쓰는 캐리와 그 캐리 중심 덱을 찾아줍니다.',
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
  $('useWeights').onchange = () => { applyWeights(); $('results').innerHTML = ''; renderBuilds(); };
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
    if (t.dataset.tab === 'builder') bdRender();
    $('results').hidden = ['meta', 'builds', 'builder'].includes(t.dataset.tab);
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
  $('traitFilter').oninput = () => renderTraitList('traitList', state.desired, $('traitFilter').value);
  const toggleBp = (target, listId, q) => e => {
    const b = e.target.closest('.bp'); if (!b) return;
    const t = b.dataset.trait, bp = Number(b.dataset.bp);
    if (target[t] === bp) delete target[t]; else target[t] = bp;
    renderTraitList(listId, target, q());
  };
  $('traitList').onclick = toggleBp(state.desired, 'traitList', () => $('traitFilter').value);
  $('emblemTraitList').onclick = toggleBp(state.emblemDesired, 'emblemTraitList', () => '');
  $('runTraits').onclick = e => {
    if (!Object.keys(state.desired).length) { $('results').innerHTML = '<div class="empty">시너지 단계를 하나 이상 골라 주세요.</div>'; return; }
    const title = Object.entries(state.desired).map(([t, b]) => `${traitName(t)} ${b}`).join(' + ') + ' 덱';
    run(e.currentTarget, title, o => decksForTraits(state.data, { ...o, desired: state.desired }));
  };

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
function metaDecks(minGames) {
  const d = state.data, w = state.weights;
  if (!metaAvailable()) return [];
  const byLower = new Map(d.champions.map(c => [c.id.toLowerCase(), c]));
  return w.comps.filter(m => m.games >= minGames).map(m => {
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
      title: `<span class="tier t${tier}">${tier}</span> ${esc(traitName(m.trait))} · ${esc(carry.name)}${reroll ? ' <span class="tag reroll">3성작</span>' : ''}`,
      metaInfo: `평균 <b>${m.avgPlace}등</b> · 순방 ${(m.top4 * 100).toFixed(0)}% · 1등 ${(m.win * 100).toFixed(0)}% · 픽률 ${(m.playRate * 100).toFixed(1)}% · ${m.games}판 · 레벨 ${m.level}`,
    };
  }).filter(Boolean);
}

function renderMeta() {
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
  }).filter(d => d.overlap >= need).sort((a, b) => b.rank - a.rank).slice(0, 3);
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
