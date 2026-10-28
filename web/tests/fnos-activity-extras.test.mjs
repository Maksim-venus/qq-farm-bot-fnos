// [fnos-fork] 2026-10-28 奶茶自动制作 / 领工资、图鉴自动设置的前端纯函数测试
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

const m = loadModule('fnos-activity-extras')

test('读取回包：缺字段补默认（全部关闭）', () => {
  assert.deepEqual(m.fnosNormalizeMilkTeaExtra(null), { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false })
  assert.deepEqual(m.fnosNormalizeMilkTeaExtra({ autoCraft: true }), { autoCraft: true, craftGoldenCheese: false, autoClaimWages: false })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto(undefined), { autoClaimRewards: false, autoComplete: false })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto({ autoComplete: 1 }), { autoClaimRewards: false, autoComplete: true })
})

test('制作说明：未开启 / 排除金露云酪 / 包括金露云酪', () => {
  assert.match(m.fnosCraftHint({ autoCraft: false, craftGoldenCheese: true }), /未开启/)
  assert.match(m.fnosCraftHint({ autoCraft: true, craftGoldenCheese: false }), /不做金露云酪/)
  assert.match(m.fnosCraftHint({ autoCraft: true, craftGoldenCheese: true }), /含森野黄金芽/)
})
