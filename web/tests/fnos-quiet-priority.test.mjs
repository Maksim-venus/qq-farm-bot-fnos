// [fnos-fork] 2026-11-16「自己收菜优先」「空闲时只保留心跳」：前端纯函数与设置页结构测试
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadModule(name) {
  const source = readFileSync(new URL(`../src/utils/${name}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

const m = loadModule('fnos-quiet-priority')

test('读取回包：缺字段补默认（收菜优先开、合并 10 秒；空闲关、1～10 分钟），越界收拢', () => {
  assert.deepEqual(m.fnosNormalizeQuietPriority(undefined), { ownHarvestFirst: true, mergeWindowSec: 10, idleKeepaliveOnly: false, idleMinMinutes: 1, idleMaxMinutes: 10 })
  assert.deepEqual(m.fnosNormalizeQuietPriority({ ownHarvestFirst: false, idleKeepaliveOnly: 1, mergeWindowSec: '45', idleMinMinutes: 30, idleMaxMinutes: '5' }), { ownHarvestFirst: false, mergeWindowSec: 30, idleKeepaliveOnly: true, idleMinMinutes: 5, idleMaxMinutes: 30 })
  assert.equal(m.fnosNormalizeQuietPriority({ mergeWindowSec: '' }).mergeWindowSec, 10)
})

test('设置页：两项开关在「自动控制」里，随「保存自动控制」走 /api/settings/save', () => {
  const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  const form = read('components/settings/AutomationSettingsForm.vue')
  assert.match(form, /data-testid="fnos-quiet-priority"/)
  assert.match(form, /settings\.fnosQuietPriority\.ownHarvestFirst/)
  assert.match(form, /settings\.fnosQuietPriority\.idleKeepaliveOnly/)
  assert.match(form, /settings\.fnosQuietPriority\.mergeWindowSec/)
  assert.match(form, /settings\.fnosQuietPriority\.idleMinMinutes/)
  assert.match(form, /settings\.fnosQuietPriority\.idleMaxMinutes/)
  assert.match(form, /先留给大号偷/)
  const store = read('stores/setting.ts')
  assert.match(store, /'fnosQuietPriority', \/\/ \[fnos-fork\]/)
  assert.match(store, /fnosQuietPriority: fnosNormalizeQuietPriority\(data\.fnosQuietPriority\)/)
  const page = read('views/Settings.vue')
  assert.match(page, /fnosQuietPriority: fnosNormalizeQuietPriority\(null\)/)
  assert.match(page, /localAutomationSettings\.value\.fnosQuietPriority = fnosNormalizeQuietPriority\(/)
})
