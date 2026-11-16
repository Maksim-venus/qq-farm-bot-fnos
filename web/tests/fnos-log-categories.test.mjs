// [fnos-fork] 运行日志分栏（偷菜 / 报错）前端纯函数测试
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

const m = loadModule('fnos-log-categories')

test('三个分栏，全部在第一个', () => {
  assert.deepEqual(m.FNOS_LOG_VIEWS.map(v => v.value), ['all', 'steal', 'error'])
  assert.deepEqual(m.FNOS_LOG_VIEWS.map(v => v.label), ['全部', '偷菜日志', '报错日志'])
})

test('「全部」不带任何额外参数（上游请求不变）', () => {
  assert.deepEqual(m.fnosBuildLogCategoryParams('all', 'error'), {})
  assert.deepEqual(m.fnosBuildLogCategoryParams('bogus'), {})
  assert.equal(m.fnosIsCategoryLogView('all'), false)
})

test('偷菜 / 报错参数，等级只对报错生效', () => {
  assert.deepEqual(m.fnosBuildLogCategoryParams('steal', 'error'), { category: 'steal', limit: 200 })
  assert.deepEqual(m.fnosBuildLogCategoryParams('error'), { category: 'error', limit: 200 })
  assert.deepEqual(m.fnosBuildLogCategoryParams('error', 'warn'), { category: 'error', limit: 200, level: 'warn' })
  assert.deepEqual(m.fnosBuildLogCategoryParams('error', 'x'), { category: 'error', limit: 200 })
  assert.equal(m.fnosIsCategoryLogView('steal'), true)
})

test('空列表文案', () => {
  assert.equal(m.fnosEmptyLogText('steal'), '暂无偷菜日志')
  assert.equal(m.fnosEmptyLogText('error'), '暂无报错日志')
  assert.equal(m.fnosEmptyLogText('all'), '暂无日志')
})

// [fnos-fork] 2026-11-17 农场 / 牧场日志分开
test('fnos-log-space：区分农场与牧场日志、牧场筛选项', () => {
  const s = loadModule('fnos-log-space')
  const rows = [
    { tag: '系统', meta: { module: 'ranch', event: 'ranch_steal' } },
    { tag: '任务', meta: { module: 'task', event: 'ranch_daily_share' } },
    { tag: '农场', meta: { module: 'farm', event: '农场循环' } },
    { tag: '好友', meta: { module: 'friend', event: '照顾好友' } },
  ]
  assert.deepEqual(rows.map(s.fnosIsRanchLog), [true, true, false, false])
  assert.equal(s.fnosFilterLogSpace(rows, 'ranch').length, 2)
  assert.equal(s.fnosFilterLogSpace(rows, 'farm').length, 2)
  assert.equal(s.fnosRanchEventLabel('ranch_fnosBad'), '放蚊子')
  assert.equal(s.fnosRanchEventLabel('unknown_x'), 'unknown_x')
  assert.equal(s.fnosRanchEventParam('ranch_steal,ranch_stroke', ''), 'ranch_steal,ranch_stroke')
  assert.equal(s.fnosRanchEventParam('a', 'b'), 'b')
  assert.equal(s.fnosRanchEventParam('', ''), undefined)
  for (const option of [...s.FNOS_RANCH_EVENT_OPTIONS, ...s.FNOS_RANCH_SCOPE_OPTIONS].filter(o => o.value))
    assert.ok(option.value.split(',').every(e => /^(?:ranch_|fnos牧场|fnos好友牧场)/.test(e)), option.label)
})
