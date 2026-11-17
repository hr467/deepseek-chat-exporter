import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const env={window:{}};
vm.createContext(env);
vm.runInContext(fs.readFileSync(new URL('../src/exporter.js',import.meta.url),'utf8'),env);
const core=env.window.DSExportCore._internals;
test('numeric string timestamps are parsed as seconds',()=>{
 const m=core.mapMessage({role:'user',content:'hi',inserted_at:'1767225600'},{includeMeta:false});
 assert.equal(m.inserted_at_iso,'2026-01-01T00:00:00.000Z');
});
test('late captures match whitespace changes without losing timestamps',()=>{
 const items=[{role:'user',content:'hello\nworld'}];
 core.attachTimes(items,[{role:'user',content:'hello world',inserted_at_iso:'2026-01-01T00:00:00Z'}]);
 assert.equal(items[0].inserted_at_iso,'2026-01-01T00:00:00Z');
});
test('ambiguous duplicate messages never get guessed timestamps',()=>{
 const items=[{role:'user',content:'continue'}];
 core.attachTimes(items,[{role:'user',content:'continue',inserted_at_iso:'2026-01-01T00:00:00Z'},
 {role:'user',content:'continue',inserted_at_iso:'2026-01-02T00:00:00Z'}]);
 assert.equal(items[0].inserted_at_iso,undefined);
});
