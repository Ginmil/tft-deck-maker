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

await mirrorIcons(data);

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

/**
 * 아이콘 이미지도 저장소(data/icons)에 복사해 GitHub Pages 에서 받게 함.
 * Community Dragon 이 느릴 때 아이콘 하나에 20초씩 걸린 일(11/14) 대응.
 * data/icons/map.json = { 원본 URL: 'data/icons/파일.png' } — 사이트가 데이터를 불러올 때 이 표로 주소를 바꿈.
 */
async function mirrorIcons(data) {
  const DIR = new URL('../data/icons/', import.meta.url);
  fs.mkdirSync(DIR, { recursive: true });
  const lists = [data.champions, Object.values(data.traits), data.items, data.emblems, data.components, data.artifacts || [], data.radiants || []];
  const urls = [...new Set(lists.flat().map(o => o?.icon).filter(Boolean))];
  const hash = str => { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };
  const fileOf = u => `${u.split('/').pop().replace(/[^a-z0-9_.-]/gi, '_').replace(/\.png$/i, '')}-${hash(u)}.png`;
  const map = {};
  let got = 0, kept = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const u = urls[next++], f = fileOf(u), out = new URL(f, DIR);
      if (fs.existsSync(out)) { map[u] = `data/icons/${f}`; kept++; continue; }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
          map[u] = `data/icons/${f}`; got++;
          break;
        } catch (e) {
          if (attempt === 3) { failed++; console.warn(`아이콘 실패(원본 주소 그대로 씀): ${u} — ${e.message}`); }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  // 더 이상 쓰지 않는 아이콘 파일 정리
  const used = new Set(Object.values(map).map(p => p.split('/').pop()));
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.png') && !used.has(f)) fs.unlinkSync(new URL(f, DIR));
  const sorted = Object.fromEntries(Object.entries(map).sort());
  fs.writeFileSync(new URL('map.json', DIR), JSON.stringify(sorted, null, 0));
  const size = fs.readdirSync(DIR).reduce((s, f) => s + fs.statSync(new URL(f, DIR)).size, 0);
  console.log(`아이콘: 새로 ${got} · 기존 ${kept} · 실패 ${failed} · 합계 ${(size / 1024 / 1024).toFixed(1)}MB`);
}
