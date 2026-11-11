// 더블클릭으로 열 수 있도록 모듈들을 하나의 일반 스크립트(js/bundle.js)로 합칩니다.
// 코드를 고친 뒤에는 `node build.mjs` 를 다시 실행하세요.
import fs from 'fs';
const files = ['js/adapters/cdragon.js', 'js/engine/roles.js', 'js/engine/scorer.js', 'js/engine/search.js', 'js/builder.js', 'js/app.js'];
let out = '// 자동 생성 파일 — 직접 고치지 말고 js/ 폴더의 원본을 고친 뒤 node build.mjs\n(() => {\n';
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
    .replace(/^import .*?;\s*$/gm, '')
    .replace(/^export (?=(async )?function|const|let|class)/gm, '');
  out += `\n// ===== ${f} =====\n${src}\n`;
}
out += '\n})();\n';
fs.writeFileSync('js/bundle.js', out);
const sample = fs.readFileSync('data/sample-cdragon.json', 'utf8');
fs.writeFileSync('data/sample.js', `window.TFT_SAMPLE = ${sample};\n`);
console.log('built js/bundle.js, data/sample.js');
