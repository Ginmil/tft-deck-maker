// 아이템 자동 배분 테스트 (샘플 세트, 통계 없음 → 역할 기준)
// 실행: node test/assign-test.mjs
import fs from 'fs';
import assert from 'assert';
import { normalize, listSets } from '../js/adapters/cdragon.js';
import { assignItems, withForms } from '../js/engine/search.js';

const raw = JSON.parse(fs.readFileSync(new URL('../data/sample-cdragon.json', import.meta.url)));
const d = normalize(raw, listSets(raw)[0].key);
const ch = n => d.champions.find(c => c.name === n);
const C = n => `TFT_Item_${n}`;
const board = [
  { idx: 0, id: ch('검은표범').id, star: 2, items: [C('IE')] },   // 물리 캐리 (무한의 대검 보유)
  { idx: 1, id: ch('곰').id, star: 2, items: [] },                // 탱커
  { idx: 2, id: ch('대마법요정').id, star: 2, items: [] },         // 마법 캐리
  { idx: 3, id: ch('솔방울').id, star: 1, items: [] },
];
const r = assignItems(d, { board, inventory: [C('LW'), C('WM'), C('Rab'), C('BFSword'), C('SparringGloves'), C('Spatula')] });
const to = id => r.assignments.find(a => a.item.id === id)?.champ.name;
assert.equal(to(C('LW')), '검은표범', '물리 아이템은 이미 무한을 든 물리 캐리에게');
assert.equal(to(C('WM')), '곰', '탱커 아이템은 탱커에게');
assert.equal(to(C('Rab')), '대마법요정', '마법 아이템은 마법 캐리에게');
const crafted = r.assignments.find(a => a.from);
assert.ok(crafted, '재료(대검+장갑)로 완성 아이템을 만들어 배분');
assert.deepEqual([...crafted.from].sort(), [C('BFSword'), C('SparringGloves')].sort());
assert.deepEqual(r.leftComponents, [C('Spatula')], '짝 없는 뒤집개는 보관');
for (const a of r.assignments) {
  const held = board.find(b => b.idx === a.idx).items.length;
  assert.ok(held + r.assignments.filter(x => x.idx === a.idx).length <= 3, '한 챔피언 최대 3칸');
}
console.log(r.assignments.map(a => `${a.item.name}${a.from ? '(조합)' : ''} → ${a.champ.name}`).join(', '), '| 보관', r.leftComponents);
console.log('아이템 자동 배분 테스트 통과');

// 실제 Set 18 데이터 + 랭커 통계로 사용자 정답 시나리오 (11/15 사용자 피드백)
// 자이라에게 공허 + 모렐로 + 블루(눈물 2개) — 블루가 자이라에게 최고는 아니지만 캐리 3칸을 채우는 게 맞음.
// 아무무에게 워모그를 나눠 주면 안 됨. 홀수 재료 중 허리띠를 남기는 것도 선택지여야 함.
const snapPath = new URL('../data/set-snapshot.json', import.meta.url), wPath = new URL('../data/weights.json', import.meta.url);
if (fs.existsSync(snapPath) && fs.existsSync(wPath)) {
  const rd = JSON.parse(fs.readFileSync(snapPath)).data;
  const w = JSON.parse(fs.readFileSync(wPath));
  if (w.setNumber === rd.set.number) {
    rd.unitStats = w.units;
    const rc = n => rd.champions.find(c => c.name === n)?.id, ri = n => rd.items.find(i => i.name === n)?.id, rp = n => rd.components.find(c => c.name === n)?.id;
    const held = { 말파이트: ['가고일 돌갑옷', '워모그의 갑옷'], 소라카: ['대천사의 지팡이', '라바돈의 죽음모자'] };
    const names = ['말파이트', '피들스틱', '쉔', '요릭', '아무무', '자이라', '아지르', '소라카'];
    if (names.every(rc)) {
      const rboard = names.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: (held[n] || []).map(ri) }));
      const inv = ['B.F. 대검', '여신의 눈물', '곡궁', '여신의 눈물', '거인의 허리띠', '쓸데없이 큰 지팡이', '여신의 눈물', '여신의 눈물', '쓸데없이 큰 지팡이', '쇠사슬 조끼', '거인의 허리띠'].map(rp);
      const rr = assignItems(rd, { board: rboard, inventory: inv });
      const gave = n => rr.assignments.filter(a => a.champ.name === n).map(a => a.item.name).sort();
      assert.deepEqual(gave('자이라'), ['공허의 지팡이', '모렐로노미콘', '푸른 파수꾼'].sort(), `자이라: ${gave('자이라')}`);
      assert.deepEqual(gave('말파이트'), ['크라운가드']);
      assert.deepEqual(gave('소라카'), ['쇼진의 창']);
      assert.deepEqual(gave('아무무'), [], '아무무에게 나눠 주지 않음');
      assert.deepEqual(rr.leftComponents, [rp('거인의 허리띠')]);
      console.log('실데이터 사용자 정답 시나리오 통과 (자이라 공허·모렐로·블루)');

      // 적응가 니달리 (11/15 사용자 피드백): AD 로 키울 때 AP 아이템(라바돈 등)을 섞으면 안 되고,
      // "몰아줄 캐리 = 니달리"면 랭커 최다 3신기(무한 + 스테락 + 밤의 끝자락)
      const nNames = ['아무무', '파수꾼', '바이', '다이애나', '니달리', '아펠리오스', '코그모', '바루스'];
      if (nNames.every(rc)) {
        const nInv = ['곡궁', '쓸데없이 큰 지팡이', '곡궁', '음전자 망토', 'B.F. 대검', '연습용 장갑', 'B.F. 대검', '여신의 눈물', '거인의 허리띠', 'B.F. 대검', '여신의 눈물', '쇠사슬 조끼', '쓸데없이 큰 지팡이', '거인의 허리띠', '거인의 허리띠'].map(rp);
        const t0 = Date.now();
        const nr = assignItems(rd, { board: nNames.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: n === '아펠리오스' ? [ri('구인수의 격노검')] : [] })), inventory: nInv });
        const nid = nr.assignments.filter(a => a.champ.name === '니달리');
        assert.ok(!nid.some(a => a.item.role === 'AP'), `AD 니달리에게 AP 아이템: ${nid.map(a => a.item.name)}`);
        const nr2 = assignItems(rd, { board: nNames.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: [] })), inventory: nInv, carryIdx: nNames.indexOf('니달리') });
        const got = nr2.assignments.filter(a => a.champ.name === '니달리').map(a => a.item.name).sort();
        assert.deepEqual(got, ['무한의 대검', '밤의 끝자락', '스테락의 도전'].sort(), `니달리 캐리: ${got}`);
        assert.ok(Date.now() - t0 < 5000, '재료 15개도 몇 초 안에');
        console.log('실데이터 적응가 니달리 시나리오 통과 (무한·스테락·밤의 끝자락, AP 아이템 없음)');

        // 적응가 형태 직접 지정 (11/15 할 일): AP 로 정하면 AP 아이템만, AD 로 정하면 AD 아이템만
        const formRun = form => {
          const b = nNames.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: [], ...(n === '니달리' ? { form } : {}) }));
          const res = assignItems(withForms(rd, b), { board: b, inventory: nInv, carryIdx: nNames.indexOf('니달리') });
          return res.assignments.filter(a => a.champ.name === '니달리').map(a => a.item);
        };
        const ap = formRun('AP'), ad = formRun('AD');
        assert.ok(ap.length >= 2 && ap.every(x => x.role !== 'AD'), `AP 니달리: ${ap.map(x => x.name)}`);
        assert.ok(ap.some(x => x.role === 'AP'), `AP 니달리에게 AP 아이템이 하나도 없음: ${ap.map(x => x.name)}`);
        assert.ok(ad.length >= 2 && ad.every(x => x.role !== 'AP'), `AD 니달리: ${ad.map(x => x.name)}`);
        console.log(`적응가 형태 지정 통과 — AP 니달리: ${ap.map(x => x.name).join('·')} / AD 니달리: ${ad.map(x => x.name).join('·')}`);
      }

      // 아이템 줄 챔피언 여러 명 선택 (11/15): 랭커 기록상 홀더가 아닌 5코 나르도 고르면 아이템을 받고,
      // 고르지 않은 챔피언은 일반 아이템을 받지 않음
      const gNames = ['릴리아', '오른', '헤카림', '알리스타', '다이애나', '나르', '아펠리오스', '자야'];
      if (gNames.every(rc)) {
        const gInv = ['곡궁', '쇠사슬 조끼', 'B.F. 대검', '거인의 허리띠', '연습용 장갑', '음전자 망토', '곡궁', '쓸데없이 큰 지팡이', '음전자 망토', 'B.F. 대검', 'B.F. 대검', '거인의 허리띠', '거인의 허리띠', '거인의 허리띠', '쇠사슬 조끼', '쇠사슬 조끼', '여신의 눈물', '음전자 망토'].map(rp);
        const picked = ['나르', '아펠리오스', '릴리아'].map(n => gNames.indexOf(n));
        const gr = assignItems(rd, { board: gNames.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: [] })), inventory: gInv, carries: picked });
        assert.ok(gr.assignments.every(a => a.item.kind === 'emblem' || picked.includes(a.idx)), '고르지 않은 챔피언에게 일반 아이템');
        const gnar = gr.assignments.filter(a => a.champ.name === '나르');
        assert.ok(gnar.length >= 2 && gnar.every(a => a.item.role !== 'TANK'), `나르: ${gnar.map(a => a.item.name)}`);
        assert.equal(gr.assignments.filter(a => a.champ.name === '아펠리오스').length, 3);
        console.log('실데이터 여러 캐리 선택 시나리오 통과 (나르:', gnar.map(a => a.item.name).join('·') + ')');
        assert.ok(gnar.every(a => a.basis?.kind === 'sparse'), '나르는 자기 랭커 기록(적음)으로 판단');

        // 통계가 아예 없는 챔피언(새 패치·새 세트)을 고르면 비슷한 챔피언(같은 역할 + 시너지/코스트) 기록을 빌림
        const noStat = { ...rd, unitStats: { ...rd.unitStats } };
        delete noStat.unitStats[rc('나르').toLowerCase()];
        const sr = assignItems(noStat, { board: gNames.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: [] })), inventory: gInv, carries: picked });
        const sg = sr.assignments.filter(a => a.champ.name === '나르');
        assert.ok(sg.length >= 1 && sg.every(a => a.basis?.kind === 'similar' && a.item.role !== 'TANK'), `통계 없는 나르: ${sg.map(a => a.item.name + JSON.stringify(a.basis))}`);
        console.log('통계 없는 챔피언 → 비슷한 챔피언 기록:', sg[0].basis.names.join('·'), '→', sg.map(a => a.item.name).join('·'));
      }
    }
  }
}

// 밤끝 vs 수은 (11/17 사용자): 둘 다 낀 판 비율이 높아(77%·59%) 예전엔 똑같이 1로 쳐서 다른 챔피언 사정으로 갈렸음.
// 덩굴정령이 구인수+정의의 손길을 들었으면 랭커는 밤끝으로 마무리(179판) ≫ 수은(25판) → 밤끝
{
  const sp = new URL('../data/set-snapshot.json', import.meta.url), wp = new URL('../data/weights.json', import.meta.url);
  const rd = fs.existsSync(sp) && JSON.parse(fs.readFileSync(sp)).data, w = fs.existsSync(wp) && JSON.parse(fs.readFileSync(wp));
  if (rd && w && w.setNumber === rd.set.number && w.units?.da_brambleback18) {
    rd.unitStats = w.units;
    const rc = n => rd.champions.find(c => c.name === n)?.id, ri = n => rd.items.find(i => i.name === n)?.id, rp = n => rd.components.find(c => c.name === n)?.id;
    const names = ['덩굴정령', '파수꾼', '바위 게', '조약돌', '어스름늑대', '렝가', '세주아니'];
    if (names.every(rc)) {
      const r = assignItems(rd, {
        board: names.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: n === '덩굴정령' ? [ri('구인수의 격노검'), ri('정의의 손길')] : [] })),
        inventory: ['B.F. 대검', '쇠사슬 조끼', '연습용 장갑', '음전자 망토'].map(rp), carries: [0],
      });
      const got = r.assignments.filter(a => a.champ.name === '덩굴정령').map(a => a.item.name);
      assert.deepEqual(got, ['밤의 끝자락'], `덩굴정령 마지막 칸: ${got}`);
      console.log('밤끝 vs 수은: 든 아이템 기준 랭커 마무리로 밤끝 통과');
    }
  }
}

// 처형자 상징 (11/18 사용자): 처형자는 스킬 치명타라 딜러에게 주는 상징 — 요릭(인원만 채우는 비홀더)에게 주면 안 됨.
// 랭커는 처형자 상징을 카르마(296)·자이라(220)에게 → 햇빛 유나라·카르마 보드에선 카르마
{
  const sp = new URL('../data/set-snapshot.json', import.meta.url), wp = new URL('../data/weights.json', import.meta.url);
  const rd = fs.existsSync(sp) && JSON.parse(fs.readFileSync(sp)).data, w = fs.existsSync(wp) && JSON.parse(fs.readFileSync(wp));
  if (rd && w && w.setNumber === rd.set.number) {
    rd.unitStats = w.units;
    rd.emblemStats = {};
    for (const e of rd.emblems) { const st = w.emblems?.[e.id]; if (st) rd.emblemStats[e.trait] = st; }
    const rc = n => rd.champions.find(c => c.name === n)?.id, rp = n => rd.components.find(c => c.name === n)?.id;
    const names = ['요릭', '세주아니', '레오나', '유나라', '르블랑', '카르마', '아지르', '케일'];
    const exe = rd.emblems.find(e => /Executioner/.test(e.trait));
    if (names.every(rc) && exe) {
      const inv = [exe.id, ...['B.F. 대검', 'B.F. 대검', 'B.F. 대검', '여신의 눈물', '여신의 눈물', '여신의 눈물', '곡궁', '연습용 장갑', '연습용 장갑', '쓸데없이 큰 지팡이'].map(rp)];
      const r = assignItems(rd, { board: names.map((n, i) => ({ idx: i, id: rc(n), star: 2, items: [] })), inventory: inv });
      const who = r.assignments.find(a => a.item.id === exe.id)?.champ.name;
      assert.equal(who, '카르마', `처형자 상징: ${who}`);
      console.log('처형자 상징 → 카르마 통과 |', r.assignments.map(a => `${a.item.name}→${a.champ.name}`).join(', '));
    }
  }
}
