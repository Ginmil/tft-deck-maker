// Community Dragon 에서 최신 세트 데이터를 받아 공통 형식으로 바꾼 사본을 data/set-snapshot.json 에 저장합니다.
// 사이트는 처음 열 때 이 사본을 쓰므로, Community Dragon 서버가 느리거나 멈춰도 동작해요.
// 실행: node tools/snapshot-set.mjs   (GitHub Actions 의 snapshot.yml 이 매일, 그리고 어댑터를 고칠 때마다 실행)
import fs from 'fs';
import { ADAPTER_VERSION, DEFAULT_URL, listSets, normalize } from '../js/adapters/cdragon.js';

const OUT = new URL('../data/set-snapshot.json', import.meta.url);
const url = process.env.CDRAGON_URL || DEFAULT_URL;

const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
if (!res.ok) { console.error(`데이터를 받지 못했어요 (HTTP ${res.status})`); process.exit(1); }
const raw = await res.json();
const sets = listSets(raw);
if (!sets.length) { console.error('세트 데이터를 찾지 못했어요'); process.exit(1); }
const data = normalize(raw, sets[0].key);

// 내용이 같으면 파일을 건드리지 않음 (날짜만 바뀐 커밋이 매일 쌓이지 않게)
let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 처음 */ }
if (prev && prev.adapterVersion === ADAPTER_VERSION && JSON.stringify(prev.data) === JSON.stringify(data)) {
  console.log('변경 없음');
  process.exit(0);
}
const snap = { adapterVersion: ADAPTER_VERSION, source: url, fetchedAt: new Date().toISOString(), data };
fs.writeFileSync(OUT, JSON.stringify(snap));
console.log(`저장: ${data.set.name} · 챔피언 ${data.champions.length} · 아이템 ${data.items.length} · 재료 ${data.components.length} · ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
