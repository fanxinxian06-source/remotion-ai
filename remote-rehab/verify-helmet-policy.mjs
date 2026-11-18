import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const classPass = html.match(/function helmetClassPass\(classIndex\)\{[^\n]+\}/)?.[0];
const decision = html.match(/function helmetDecision\(classIndex,modelReady\)\{[^\n]+\}/)?.[0];
assert.ok(classPass && decision, 'helmet policy functions must exist in the page');

const context = vm.createContext({
  HH: { names: ['helmet', 'no_helmet', 'hardhat', 'Safety Helmet', 'safety_helmet', 'person', 'helmeted'] },
});
new vm.Script(`${classPass}\n${decision}`).runInContext(context);
assert.deepEqual(
  JSON.parse(JSON.stringify(vm.runInContext('[0,1,2,3,4,5,6,99].map(helmetClassPass)', context))),
  [true, false, true, true, true, false, false, false],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(vm.runInContext('[helmetDecision(0,true), helmetDecision(1,true), helmetDecision(99,true), helmetDecision(0,false)]', context))),
  ['yes', 'no', 'no', null],
);

console.log('PASS: only helmet/hardhat labels pass; other classes, missing detections, and unavailable models do not pass.');
