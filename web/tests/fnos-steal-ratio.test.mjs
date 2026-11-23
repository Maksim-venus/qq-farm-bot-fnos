// [fnos-fork] 在线期间来偷菜自动删除的设置归一（偷收比筛选已下架）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

const m = loadModule('fnos-steal-ratio')

test('缺省在线期间删除关；旧的偷收比 / 筛选 / Bark / 自动删除字段读取时丢弃；没带的字段沿用已保存值', () => {
  assert.deepEqual(m.fnosNormalizeStealRatio(undefined), { autoDeleteOnlineStealer: false })
  assert.deepEqual(m.fnosNormalizeStealRatio({ thresholdPercent: 70, ignoreApplications: true, listFilter: true, barkOnSteal: true, autoDelete: true }), { autoDeleteOnlineStealer: false })
  assert.deepEqual(m.fnosNormalizeStealRatio({ autoDeleteOnlineStealer: true, autoDelete: true }), { autoDeleteOnlineStealer: true })
  assert.deepEqual(m.fnosNormalizeStealRatio({}, { autoDeleteOnlineStealer: true }), { autoDeleteOnlineStealer: true })
})

test('已下架的偷收比筛选工具不再导出', () => {
  assert.equal(m.fnosStealRatioInfo, undefined)
  assert.equal(m.fnosFriendMatchesStealFilter, undefined)
})
