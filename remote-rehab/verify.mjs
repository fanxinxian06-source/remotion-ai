import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const pagePath = new URL('./index.html', import.meta.url);
const html = await readFile(pagePath, 'utf8');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*\btype="module")[^>]*>([\s\S]*?)<\/script>/gi)];
const moduleScripts = [...html.matchAll(/<script\s+type="module"\s+src="([^"]+)"[^>]*>\s*<\/script>/gi)];
assert.equal(inlineScripts.length, 1, 'page should keep one inline app script');
assert.equal(moduleScripts.length, 1, 'page should load one dedicated vision module');
assert.ok(/src="\.\/vision\.mjs"\s+onerror="window\.visionModuleLoadError\(\)"/.test(html), 'vision load errors should come from the module request, not a separate probe');
new vm.Script(inlineScripts[0][1], { filename: fileURLToPath(pagePath) });
const visionPath = new URL(moduleScripts[0][1], pagePath);
const vision = await readFile(visionPath, 'utf8');

const dictMatch = inlineScripts[0][1].match(/const I=(\{[\s\S]*?\n\});/);
assert.ok(dictMatch, 'translation dictionaries should be defined');
const dictionaries = vm.runInNewContext(`(${dictMatch[1]})`);
for (const [, locale, extra] of inlineScripts[0][1].matchAll(/Object\.assign\(I\.(zh|en|ko),(\{.*?\})\);/g)) {
  Object.assign(dictionaries[locale], vm.runInNewContext(`(${extra})`));
}
for (const [, , source] of inlineScripts[0][1].matchAll(/const (Z|Z2|T2|T3)=(\{[\s\S]*?\});/g)) {
  const extra = vm.runInNewContext(`(${source})`);
  for (const locale of ['zh', 'en', 'ko']) Object.assign(dictionaries[locale], extra[locale] || extra.en);
}
assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'ko', 'zh']);
const referenceKeys = Object.keys(dictionaries.zh).sort();
for (const locale of ['en', 'ko']) {
  assert.deepEqual(Object.keys(dictionaries[locale]).sort(), referenceKeys, `${locale} translation keys must match Chinese`);
}
const referencedKeys = new Set([
  ...[...html.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]),
  ...[...inlineScripts[0][1].matchAll(/tr\('([^']+)'\)/g)].map(m => m[1]),
  ...[...vision.matchAll(/translate\('([^']+)'\)/g)].map(m => m[1]),
]);
for (const key of referencedKeys) assert.ok(dictionaries.zh[key], `missing Chinese string: ${key}`);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'HTML IDs must be unique');
const idSet = new Set(ids);
const dynamicIds = new Set([...inlineScripts[0][1].matchAll(/\.id\s*=\s*'([^']+)'/g)].map(m => m[1]));
for (const [, id] of [...inlineScripts[0][1].matchAll(/\$\('#([^']+)'\)/g), ...vision.matchAll(/\$\('([^']+)'\)/g)]) {
  assert.ok(idSet.has(id) || dynamicIds.has(id), `script references missing element #${id}`);
}
assert.equal((html.match(/<meta name="viewport"/g) || []).length, 1);
assert.ok(!/\b(XMLHttpRequest|WebSocket|EventSource|navigator\.bluetooth|requestDevice\s*\()\b/i.test(`${html}\n${vision}`) && !/\b(localStorage|sessionStorage)\b/i.test(vision), 'camera module does not upload, persist, or access unrelated device APIs');
assert.ok(!/<(?:img|iframe|audio)[^>]+(?:src|srcset)=/i.test(html), 'no external media embeds');
assert.ok(!/fetch\s*\(/i.test(vision), 'app code must not upload video frames');
assert.ok(/navigator\.mediaDevices\.getUserMedia/.test(vision), 'camera is requested by the vision module');
assert.ok(/id="visionFacing"[\s\S]*value="user"[\s\S]*value="environment"/.test(html), 'front and rear camera choices are available');
assert.ok(/facingMode:\s*\{\s*ideal:\s*facingSelect\.value\s*\}/.test(vision), 'selected camera direction is passed to the browser');
assert.ok(/visionFacingUnsupported/.test(vision) && /visionCameraDenied/.test(vision), 'camera direction and permission failures are surfaced');
assert.ok(/PULSE_MIN_DURATION_MS\s*=\s*10000/.test(vision) && /variance < 0\.0064/.test(vision), 'pulse output requires a warm-up and usable signal quality');
assert.ok(/visionPulseLimit/.test(html) && /cannot assess health|无法判断健康状况/.test(html), 'camera pulse UI disclaims health assessment');
assert.ok(/id="integrationTitle"/.test(html) && /data-i="integrationStatus">尚未连接/.test(html), 'Qingyun integration status is clearly unconnected');
assert.ok(/integrationApiTitle/.test(html) && /integrationTestTitle/.test(html) && /integrationOpsTitle/.test(html), 'integration readiness covers API, testing, and operations');
assert.ok(/不得将令牌、密钥或证书写入前端代码/.test(html), 'integration readiness forbids frontend secrets');
assert.ok(html.includes('바이테크 (김해)') && html.includes('광성 (양산)') && /integrationReceived/.test(html) && /integrationVirtualWorkers/.test(html), 'reference system sites and metrics are represented');
assert.ok(/integration-site-state" data-i="integrationSitePending"/.test(html) && /<b>—<\/b>/.test(html), 'reference metrics remain clearly pending rather than fabricated');
assert.ok(/splitManagerTitle/.test(html) && /splitTwinTitle/.test(html) && /splitSiteTitle/.test(html), 'site camera and Qingyun control room form a split workflow preview');
assert.ok(/href="tel:119"/.test(html) && /window\.confirm\(tr\('incidentConfirmPrompt'\)\)/.test(inlineScripts[0][1]) && /#incidentCall'\)\.hidden=false/.test(inlineScripts[0][1]), 'Korean emergency dialing is exposed only after explicit human confirmation');
assert.ok(/incidentIdle/.test(html) && /incidentNote/.test(html) && /自动识别事故|does not detect incidents/.test(html), 'incident handling is clearly manual and non-automated');
assert.ok(/startButton\.addEventListener\('click',[\s\S]*?startVision\(\)/.test(vision), 'start button launches camera inference');
assert.ok(/track\.stop\(\)/.test(vision) && /releaseModels\(\)/.test(vision), 'stop releases camera tracks and models');
assert.ok(/PoseLandmarker\.createFromOptions/.test(vision) && /detectForVideo/.test(vision), 'MediaPipe pose runs on video frames');
assert.ok(/FaceDetector\.createFromOptions/.test(vision) && /FACE_NEAR_RATIO/.test(vision), 'face proximity is an anonymous screen-size heuristic');
assert.ok(!/FaceRecognizer|face.?embedding|identity.?match/i.test(vision), 'no face identity recognition');
for (const model of ['yolox_nano.onnx', 'pose_landmarker_lite.task', 'blaze_face_short_range.tflite']) {
  assert.ok(vision.includes(`./models/${model}`), `vision module must load ${model} from the models folder`);
  const info = await stat(new URL(`./models/${model}`, import.meta.url));
  assert.ok(info.size > 100_000, `model file ${model} must be present and non-empty`);
}
for (const token of ['normal', 'heat', 'missing']) assert.ok(inlineScripts[0][1].includes(`'${token}'`), `scenario ${token} is wired`);
for (const token of ['missingNote', 'heatNote', 'normalNote', 'missingAlert', 'missingAlertDesc']) assert.ok(dictionaries.zh[token], `scenario copy ${token} exists`);
assert.ok(/scenario==='missing'[\s\S]*?qualityPoor/.test(inlineScripts[0][1]), 'missing signal maps metrics to unavailable');
assert.ok(/scenario==='missing'[\s\S]*?id:4,level:'info'/.test(inlineScripts[0][1]), 'missing signal creates a review prompt');
assert.ok(/scenario==='heat'[\s\S]*?id:3,level:'high'/.test(inlineScripts[0][1]), 'heat scenario creates a conservative review prompt');
assert.ok(/a\.ack=true/.test(inlineScripts[0][1]) && /alerts=alerts\.filter/.test(inlineScripts[0][1]), 'acknowledge and resolve actions are wired');
assert.ok(/<button[^>]+id="watchConnect"[^>]+aria-haspopup="dialog"/.test(html) && /\$\('#watchConnect'\)\.onclick=showModal/.test(inlineScripts[0][1]), 'device connection indicator opens the simulator');
assert.ok(/@keyframes signalPulse/.test(html) && /@keyframes packet/.test(html), 'online indicators and data-path packets animate');
assert.ok(html.includes('aria-live="polite"') && html.includes('role="dialog"'), 'dynamic updates and scenario dialog expose accessibility roles');
assert.ok(html.includes('@media(max-width:700px)') && html.includes('prefers-reduced-motion:reduce'), 'mobile and reduced-motion styles exist');
for (const id of ['story', 'console', 'principles']) assert.ok(idSet.has(id), `contest story section #${id} exists`);
assert.ok(html.includes('href="#manager"') && html.includes('href="#principles"'), 'hero calls to action navigate to the live demo and principles');
assert.ok(html.includes('class="side-nav"') && html.includes('href="#industry"') && html.includes('href="#principles"') && html.includes("document.querySelector('.flow').id='dataflow'"), 'desktop/mobile navigation reaches current overview and safety sections');
for (const key of ['navOverview', 'navSessions', 'navEdge', 'navSafety']) assert.ok(dictionaries.zh[key], `navigation copy ${key} exists`);
assert.ok(/\.side-nav\{position:fixed/.test(html) && /@media\(max-width:700px\)\{\.side-nav\{top:auto;bottom:0/.test(html), 'navigation adapts from desktop rail to mobile bottom bar');
assert.ok(html.includes('hero-art') && html.includes('principle-grid'), 'hero visual and design-principle narrative exist');

console.log(`PASS: app script parses; ${referenceKeys.length} translations match across 3 languages; ${ids.length} unique IDs; contest narrative, responsive navigation, camera controls, local models, privacy boundaries, scenario safeguards and accessibility checked.`);
