// =============================================================
// 라이엇 공식 API로 상위 랭커 경기를 모아 시너지별 가중치 파일을 만듭니다.
//
// 사용법 (tft-deck-maker 폴더에서):
//   1) tools/config.example.json 을 복사해서 tools/config.json 으로 이름 바꾸기
//   2) config.json 의 apiKey 에 개발자 포털에서 받은 RGAPI-... 키 넣기
//   3) node tools/collect-stats.mjs
//
// 결과: data/weights.json (+ 더블클릭 실행용 data/weights.js)
// 받은 경기는 tools/cache/ 에 저장돼서, 중간에 멈춰도 다시 실행하면 이어서 진행됩니다.
// =============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aggregate, toWeights, patchWeights } from './stats-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cfgPath = path.join(here, 'config.json');

// 설정: tools/config.json (내 컴퓨터) 또는 환경변수 RIOT_API_KEY (GitHub Actions 등 서버)
const fileCfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
if (process.env.RIOT_API_KEY) fileCfg.apiKey = process.env.RIOT_API_KEY;
if (process.env.MAX_PLAYERS) fileCfg.maxPlayers = Number(process.env.MAX_PLAYERS);
if (process.env.MATCHES_PER_PLAYER) fileCfg.matchesPerPlayer = Number(process.env.MATCHES_PER_PLAYER);
// AGGREGATE_ONLY=1 : 라이엇 API를 부르지 않고 캐시에 있는 경기로 다시 집계만 (키 불필요, 몇 초)
const aggregateOnly = process.env.AGGREGATE_ONLY === '1' || process.argv.includes('--aggregate-only');
if (!fileCfg.apiKey && !aggregateOnly) {
  console.error('API 키가 없어요. tools/config.json 에 apiKey 를 넣거나 환경변수 RIOT_API_KEY 를 설정해주세요.');
  process.exit(1);
}
const cfg = {
  platform: 'kr',        // 서버: kr, jp1, na1, euw1 ...
  region: 'asia',        // 경기 조회용 지역: asia, americas, europe, sea
  tiers: ['challenger', 'grandmaster', 'master'],
  maxPlayers: 200,       // 경기를 가져올 플레이어 수
  matchesPerPlayer: 20,  // 플레이어당 최근 경기 수
  queueId: 1100,         // 1100 = 랭크 게임
  keepDays: 14,          // 캐시에 쌓인 경기 중 최근 며칠 치까지 집계에 쓸지 (이번 패치 경기는 날마다 쌓여서 표본이 커짐)
  requestIntervalMs: 1250, // 개발 키 제한(2분에 100회)을 넘지 않도록 요청 간격
  ...fileCfg,
};
if (!aggregateOnly && !/^RGAPI-/.test(cfg.apiKey || '')) {
  console.error('config.json 의 apiKey 가 비어 있거나 형식이 달라요. RGAPI- 로 시작하는 키를 넣어주세요.');
  process.exit(1);
}

const cacheDir = path.join(here, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });

// ---------------- API 호출 (속도 제한 + 재시도) ----------------
let last = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function riot(host, apiPath) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = last + cfg.requestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(`https://${host}.api.riotgames.com${apiPath}`, { headers: { 'X-Riot-Token': cfg.apiKey } });
    if (res.ok) return res.json();
    if (res.status === 429) {
      const sec = Number(res.headers.get('retry-after') || 10);
      console.log(`  요청 한도 초과 → ${sec}초 대기`);
      await sleep(sec * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`API 키가 거부됐어요 (HTTP ${res.status}). 개발 키는 24시간마다 만료되니 포털에서 다시 받아 config.json 에 넣어주세요.`);
    }
    if (res.status === 404) return null;
    if (res.status >= 500) { await sleep(3000); continue; }
    throw new Error(`HTTP ${res.status} — ${apiPath}`);
  }
  throw new Error(`재시도 실패 — ${apiPath}`);
}

// ---------------- 1. 상위 랭커 목록 ----------------
async function topPlayers() {
  const puuids = [];
  for (const tier of cfg.tiers) {
    const league = await riot(cfg.platform, `/tft/league/v1/${tier}?queue=RANKED_TFT`);
    const entries = (league?.entries || []).sort((a, b) => b.leaguePoints - a.leaguePoints);
    console.log(`${tier}: ${entries.length}명`);
    for (const e of entries) {
      if (puuids.length >= cfg.maxPlayers) return puuids;
      let puuid = e.puuid;
      if (!puuid && e.summonerId) { // 예전 응답 형식 대비
        puuid = (await riot(cfg.platform, `/tft/summoner/v1/summoners/${e.summonerId}`))?.puuid;
      }
      if (puuid) puuids.push(puuid);
    }
  }
  return puuids;
}

// ---------------- 2. 경기 ID ----------------
async function matchIds(puuids) {
  const ids = new Set();
  for (const [i, p] of puuids.entries()) {
    const list = await riot(cfg.region, `/tft/match/v1/matches/by-puuid/${p}/ids?count=${cfg.matchesPerPlayer}`);
    (list || []).forEach(id => ids.add(id));
    process.stdout.write(`\r경기 목록 ${i + 1}/${puuids.length} (경기 ${ids.size}개)`);
  }
  console.log();
  return [...ids];
}

// ---------------- 3. 경기 상세 (캐시) ----------------
async function fetchMatches(ids) {
  const out = [];
  for (const [i, id] of ids.entries()) {
    const file = path.join(cacheDir, `${id}.json`);
    let m;
    if (fs.existsSync(file)) m = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      m = await riot(cfg.region, `/tft/match/v1/matches/${id}`);
      if (m) fs.writeFileSync(file, JSON.stringify(m));
    }
    if (m) out.push(m);
    process.stdout.write(`\r경기 상세 ${i + 1}/${ids.length}`);
  }
  console.log();
  return out;
}

// ---------------- 4. 캐시에 쌓인 지난 경기 ----------------
// 오늘 목록에 없는 경기도 최근 keepDays 일 치는 집계에 씀 (패치별 가중치가 옛 패치는 걸러냄).
// 오래된 캐시 파일은 지워서 Actions 캐시가 끝없이 커지지 않게 함.
function cachedMatches(skipIds) {
  const now = Date.now(), keepMs = cfg.keepDays * 864e5, out = [];
  let removed = 0;
  for (const f of fs.readdirSync(cacheDir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(cacheDir, f);
    let m;
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.unlinkSync(file); continue; }
    const age = now - (m?.info?.game_datetime || 0);
    if (age > keepMs * 1.5) { fs.unlinkSync(file); removed++; continue; }
    if (age <= keepMs && !skipIds.has(m?.metadata?.match_id)) out.push(m);
  }
  if (removed) console.log(`오래된 캐시 경기 ${removed}개 정리`);
  return out;
}

// ---------------- 실행 ----------------
try {
  console.log(`서버 ${cfg.platform} / 지역 ${cfg.region} — 예상 소요: 약 ${Math.ceil((cfg.maxPlayers * (1 + 1 + cfg.matchesPerPlayer / 2)) * cfg.requestIntervalMs / 60000)}분 (캐시된 경기는 빠름)`);
  const fresh = aggregateOnly ? [] : await fetchMatches(await matchIds(await topPlayers()));
  if (aggregateOnly) console.log('집계만 다시 해요 (캐시된 경기 사용)');
  const matches = [...fresh, ...cachedMatches(new Set(fresh.map(m => m?.metadata?.match_id)))];
  // 패치 일정표 (경기 데이터에 패치 번호가 없을 때 경기 시각으로 패치를 정함)
  let schedule = null;
  try { schedule = JSON.parse(fs.readFileSync(path.join(root, 'data', 'patches.json'), 'utf8')).patches; } catch { console.log('data/patches.json 이 없어 패치 구분 없이 집계해요'); }
  const pw = patchWeights(matches, { queueId: cfg.queueId, schedule });
  const stats = aggregate(matches, { queueId: cfg.queueId, setNumber: pw.setNumber, weightOf: pw.weightOf, isCurrent: pw.isCurrent });
  stats.patch = { current: pw.current, prev: pw.prev, prevWeight: pw.prevWeight, mature: pw.mature, matches: pw.counts };
  if (!pw.current) {
    const ex = matches.find(m => m?.info)?.info || {};
    console.log(`패치 버전을 못 읽었어요. 예시 game_version=${JSON.stringify(ex.game_version)} / 버전 관련 필드: ${Object.keys(ex).filter(k => /version|patch/i.test(k)).map(k => `${k}=${JSON.stringify(ex[k])}`).join(', ')}`);
  }
  console.log(`패치별 경기: ${Object.entries(pw.counts).map(([p, n]) => `${p} ${n}판`).join(', ')} → 최신 ${pw.current}, 이전 ${pw.prev || '없음'} 가중치 ${pw.prevWeight}`);
  if (!stats.games) throw new Error('쓸 수 있는 랭크 경기가 없어요. queueId 나 서버 설정을 확인해주세요.');
  const weights = toWeights(stats);

  const json = JSON.stringify(weights, null, 1);
  fs.writeFileSync(path.join(root, 'data', 'weights.json'), json);
  fs.writeFileSync(path.join(root, 'data', 'weights.js'), `window.TFT_WEIGHTS = ${json};\n`);

  console.log(`\n완료: 세트 ${weights.setNumber}, 경기 ${matches.length}개(오늘 목록 ${fresh.length}), 플레이어 기록 ${weights.games}개(패치 가중치 반영)`);
  const rows = Object.entries(weights.traits).flatMap(([t, tiers]) =>
    Object.entries(tiers).map(([tier, r]) => ({ t, tier, ...r }))).filter(r => r.games >= 30);
  rows.sort((a, b) => a.avgPlace - b.avgPlace);
  console.log('\n평균 등수가 좋은 시너지 단계 (30판 이상):');
  for (const r of rows.slice(0, 10)) console.log(`  ${r.t} ${r.tier}단계  평균 ${r.avgPlace}등  순방 ${(r.top4 * 100).toFixed(0)}%  (${r.games}판)  가중치 ${r.weight}`);
  console.log('\n→ data/weights.json, data/weights.js 저장. index.html 을 새로고침하면 반영돼요.');
} catch (e) {
  console.error('\n오류:', e.message);
  process.exit(1);
}
