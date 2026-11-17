// 게임 팀 코드(팀 플래너 코드)용 챔피언 번호를 Community Dragon 맵 데이터에서 뽑아 data/planner-codes.json 에 저장합니다.
// 번호 위치(11/17 확인): game/data/maps/shipping/map22/map22.bin.json 의 "Maps/Shipping/Map22/Sets/TFTSet18/Shop/<챔피언>"
// (TftShopData) 안 이름 없는 항목 "{4d4e5cf5}" — 오른 1055 = 0x41f 가 롤체지지 팀 코드와 일치.
// 팀 코드 형식: "02" + 챔피언마다 16진수 3자리 × 10칸(빈칸 000) + "TFTSet18"
// 실행: node tools/planner-codes.mjs   (snapshot.yml 이 세트 사본과 함께 실행, 파일이 70MB 라 브라우저에선 안 받음)
import fs from 'fs';

const URL_MAP = process.env.MAP22_URL || 'https://raw.communitydragon.org/latest/game/data/maps/shipping/map22/map22.bin.json';
const OUT = new URL('../data/planner-codes.json', import.meta.url);
const snap = JSON.parse(fs.readFileSync(new URL('../data/set-snapshot.json', import.meta.url), 'utf8'));
const setKey = snap.data.set.key;
const ids = new Set(snap.data.champions.map(c => c.id));

const res = await fetch(URL_MAP, { signal: AbortSignal.timeout(300_000) });
if (!res.ok) { console.error(`맵 데이터를 받지 못했어요 (HTTP ${res.status})`); process.exit(1); }
const text = await res.text();
const re = new RegExp(`"Maps/Shipping/Map22/Sets/${setKey}/Shop/([^"]+)":\\{[^{}]*?"\\{4d4e5cf5\\}":(\\d+)`, 'g');
const codes = {};
for (const m of text.matchAll(re)) if (ids.has(m[1])) codes[m[1]] = Number(m[2]);
const missing = [...ids].filter(id => !(id in codes));
if (!Object.keys(codes).length) { console.error('팀 코드 번호를 하나도 찾지 못했어요 — 데이터 구조가 바뀌었는지 확인'); process.exit(1); }

const out = { set: setKey, codes };
let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 처음 */ }
if (prev && JSON.stringify(prev.codes) === JSON.stringify(codes) && prev.set === setKey) { console.log('변경 없음'); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify({ ...out, fetchedAt: new Date().toISOString() }, null, 1));
console.log(`저장: ${setKey} 챔피언 ${Object.keys(codes).length}명${missing.length ? ` · 번호 없음: ${missing.join(', ')}` : ''}`);
