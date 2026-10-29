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
  assert.deepEqual(m.fnosNormalizeMilkTeaExtra(null), { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false })
  assert.deepEqual(m.fnosNormalizeMilkTeaExtra({ autoCraft: true }), { autoCraft: true, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto(undefined), { autoClaimRewards: false, autoComplete: false })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto({ autoComplete: 1 }), { autoClaimRewards: false, autoComplete: true })
})

test('制作说明：未开启 / 排除金露云酪 / 包括金露云酪', () => {
  assert.match(m.fnosCraftHint({ autoCraft: false, craftGoldenCheese: true }), /未开启/)
  assert.match(m.fnosCraftHint({ autoCraft: true, craftGoldenCheese: false }), /不做金露云酪/)
  assert.match(m.fnosCraftHint({ autoCraft: true, craftGoldenCheese: true }), /含森野黄金芽/)
})

// [fnos-fork] 需求 27
test('店铺自动升级开关：默认关，可读回', () => {
  assert.equal(m.fnosNormalizeMilkTeaExtra({ autoUpgradeShop: 1 }).autoUpgradeShop, true)
})

test('森野种子兑换：旧配置迁移只勾黄金芽；规整；移动；说明', () => {
  const d = m.fnosNormalizeMilkTeaDaily({ autoClaim: true, autoExchangeSeed: true })
  assert.equal(d.seedExchange.length, 8)
  assert.deepEqual(d.seedExchange.filter(v => v.enabled).map(v => v.id), [29005])
  assert.deepEqual(d.seedExchange.map(v => m.fnosSeedName(v.id)), ['森野芭乐种子', '森野黄金芽种子', '森野柿子种子', '森野可可豆种子', '森野红柚种子', '森野甜橙种子', '森野白桃种子', '森野甜莓种子'])
  const list = m.fnosNormalizeSeedExchange([{ id: 20525, enabled: true }, { id: 20525, enabled: false }, { id: 7, enabled: true }])
  assert.deepEqual(list[0], { id: 20525, enabled: true })
  assert.equal(list.length, 8)
  const moved = m.fnosMoveSeedExchange(list, 0, 7)
  assert.equal(moved[7].id, 20525)
  assert.equal(m.fnosMoveSeedExchange(list, 0, 9), list)
  assert.match(m.fnosSeedExchangeHint({ autoExchangeSeed: true, seedExchange: list }), /森野甜莓种子，每种都按最大数量/)
  assert.match(m.fnosSeedExchangeHint({ autoExchangeSeed: false, seedExchange: list }), /未开启/)
})
