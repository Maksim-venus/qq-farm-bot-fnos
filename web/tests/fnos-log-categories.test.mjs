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
