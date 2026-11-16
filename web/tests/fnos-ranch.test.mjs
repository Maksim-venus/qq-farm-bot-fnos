// [fnos-fork] 2026-11-16 牧场增强（fnosRanch）与「最后 X 块地只种牧草」（fnosGrassLands）的前端纯函数与设置页结构测试
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

const m = loadModule('fnos-ranch')
const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

test('fnosRanch：缺字段补默认、数值夹取', () => {
  assert.deepEqual(m.fnosNormalizeRanch(undefined), m.FNOS_RANCH_DEFAULT)
  const r = m.fnosNormalizeRanch({ rotationIdleMinutes: 0, friendDailyVisitLimit: 9999, friendSteal: 1, rotation: false })
  assert.equal(r.rotationIdleMinutes, 1)
  assert.equal(r.friendDailyVisitLimit, 500)
  assert.equal(r.friendSteal, true)
  assert.equal(r.rotation, false)
})

test('fnosGrassLands：默认关闭、自动补买默认开、X 夹取 0..24', () => {
  assert.deepEqual(m.fnosNormalizeGrassLands(null), { count: 0, autoBuy: true })
  assert.deepEqual(m.fnosNormalizeGrassLands({ count: 30, autoBuy: false }), { count: 24, autoBuy: false })
  assert.deepEqual(m.fnosNormalizeGrassLands({ count: -2 }), { count: 0, autoBuy: true })
})

test('设置页：牧场空间自动控制有「飞牛增强」卡片；农场自动控制有牧草地；随保存自动控制提交', () => {
  const form = read('components/settings/AutomationSettingsForm.vue')
  assert.match(form, /data-testid="fnos-ranch"/)
  assert.match(form, /settings\.fnosRanch\.rotation"/)
  assert.match(form, /settings\.fnosRanch\.friendSteal"/)
  assert.match(form, /settings\.fnosRanch\.friendClean" label="好友牧场：清理便便" \/>/)
  assert.match(form, /settings\.fnosRanch\.friendMosquito" label="好友牧场：打蚊子" \/>/)
  assert.match(form, /settings\.fnosRanch\.friendFeedPerTime/)
  assert.match(form, /settings\.fnosRanch\.friendFeedKeep/)
  assert.doesNotMatch(form, /待抓包/)
  assert.match(form, /data-testid="fnos-grass-lands"/)
  assert.match(form, /settings\.fnosGrassLands\.count/)
  const store = read('stores/setting.ts')
  assert.match(store, /'fnosRanch'/)
  assert.match(store, /'fnosGrassLands'/)
  const page = read('views/Settings.vue')
  assert.match(page, /fnosRanch: fnosNormalizeRanch\(source\.fnosRanch\)/)
  assert.match(page, /delete payload\.fnosRanch/)
})
