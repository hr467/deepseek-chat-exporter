import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const src = fs.readFileSync(new URL('../src/exporter.js', import.meta.url), 'utf8');
const collector = src.slice(src.indexOf('  async function collectByScrolling('), src.indexOf('  async function buildSession('));
async function run(delayed) {
  let pos = 100000, waits = 0, loaded = false;
  const scroller = {clientHeight: 600, scrollHeight: 100600,
    get scrollTop() { return pos; },
    set scrollTop(v) { pos = Math.min(100000, Math.max(0, v)); }};
  const env = {findScroller: () => scroller, blockKey: String,
    extractDom: () => [{role: 'user', content: loaded ? 'original opening' : 'screen ' + Math.floor(pos / 480)}],
    extractRawDump: () => [],
    sleep: async () => { if (pos === 0 && ++waits === 3 && delayed) {loaded = true; scroller.scrollHeight += 100;} }};
  vm.createContext(env);
  vm.runInContext(collector + ';this.collect = collectByScrolling;', env);
  const result = await env.collect({note() {}});
  return {result, waits};
}
test('scrolls beyond 80 screens to retain the opening', async () => {
  const {result} = await run(false);
  assert.equal(result[0].content, 'screen 0');
  assert.ok(result.length > 80);
});
test('waits for history that arrives after reaching the top', async () => {
  const {result, waits} = await run(true);
  assert.equal(result[0].content, 'original opening');
  assert.ok(waits >= 4);
});
