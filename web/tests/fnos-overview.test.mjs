// [fnos-fork] 2026-11-23 首页合并概览快照纯函数测试
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/fnos-overview.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const mod = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require)
const o = mod.exports

test('农场快照：等级、经验、资产、库存、今日统计、巡查倒计时', () => {
  const s = o.buildFarmSnapshot({
    now: 1_000_000,
    diamond: 12,
    items: [{ id: 1011, hoursText: '27.8小时' }, { id: 3001, count: 1234 }],
    status: {
      status: { level: 40, gold: 1500, coupon: 3, goldBean: 9 },
      levelProgress: { current: 10, needed: 100 },
      operations: { harvest: 5, levelUp: 1, steal: 2 },
      nextChecks: { farmRemainSec: 30, friendRemainSec: 60, friendQuiet: true },
    },
  })
  assert.equal(s.level, 40)
  assert.deepEqual(s.exp, { current: 10, needed: 100 })
  assert.equal(s.assets.find(t => t.key === 'gold').value, '1,500')
  assert.equal(s.assets.find(t => t.key === 'diamond').value, '12')
  assert.equal(s.stock.find(t => t.key === 1011).value, '27.8h')
  assert.equal(s.stock.find(t => t.key === 3001).value, '1,234')
  assert.equal(s.stock.find(t => t.key === 1012).value, '0.0h')
  assert.deepEqual(s.today.map(t => t.key), ['harvest', 'steal'])
  assert.equal(s.nextChecks[0].at, 1_030_000)
  assert.equal(s.nextChecks[1].at, null)
  assert.equal(s.nextChecks[1].note, '静默中')
})

test('农场没有数据时不崩', () => {
  const s = o.buildFarmSnapshot({ status: null })
  assert.equal(s.level, 0)
  assert.equal(s.nextChecks[0].at, null)
})

const ranchState = {
  level: 7,
  currentExp: 50,
  neededExp: 200,
  grass: 99,
  serverTime: 5_000_000,
  currencies: [{ id: 1007, name: '金币', count: '1000', image: 'a.png' }, { id: 7002, name: '便便', count: '3', image: 'd.png' }],
  buckets: [{ id: 7003, seconds: 7200 }],
  career: { harvest: 10, mature: 4, steal: 2 },
  facilities: [
    { id: '2', moduleType: 8, name: '牧草机', level: 1, state: 1, capacity: 100, feed: { count: 10 } },
    { id: '1', moduleType: 6, name: '鸡窝', level: 2, state: 1, capacity: 4, ranch: { count: 2, capacity: 4, shelves: [{ canCollect: true }], hazards: [1], animals: [{ canHarvest: true, grassBlocked: true }, { canFeed: true }] } },
  ],
}

test('牧场快照：六项数据 + 生涯、设施、待处理、今日收益、巡查', () => {
  const s = o.buildRanchSnapshot({ state: ranchState, ranchOperations: { harvest: 3, steal: 1 }, ranchRemainSec: 120, imageOf: id => `img${id}`, now: 10 })
  assert.equal(s.level, 7)
  assert.deepEqual(s.exp, { current: 50, needed: 200 })
  assert.equal(s.assets[0].value, '1,000')
  assert.deepEqual(s.stock.map(t => t.key), [7001, 7002, 7003, 7004])
  assert.equal(s.stock[2].value, '2.0h')
  assert.equal(s.stock[0].image, 'img7001')
  assert.deepEqual(s.career, { harvest: 10, mature: 4, steal: 2 })
  assert.deepEqual(s.facilities.map(f => f.name), ['鸡窝', '牧草机'])
  assert.equal(s.facilities[0].text, '2 / 4')
  assert.equal(s.todo.find(t => t.key === 'harvest').value, 2)
  assert.equal(s.todo.find(t => t.key === 'clean').value, 1)
  assert.equal(s.today.find(t => t.key === 'steal').count, 1)
  assert.equal(s.nextChecks[0].at, 120_010)
  assert.match(s.notice, /1 只/)
})

test('牧场今日完成 / 无统计时倒计时为空、今日收益为空', () => {
  const s = o.buildRanchSnapshot({ state: ranchState, ranchRemainSec: null, imageOf: String })
  assert.equal(s.nextChecks[0].at, null)
  assert.deepEqual(s.today, [])
})

test('更新时间展示', () => {
  const now = 100 * 3_600_000
  assert.equal(o.formatUpdatedAt(undefined, now), '')
  assert.equal(o.formatUpdatedAt(now - 1000, now), '刚刚')
  assert.equal(o.formatUpdatedAt(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(o.formatUpdatedAt(now - 3 * 3_600_000, now), '3 小时前')
})

test('资产合并：点券、金豆豆只显示一个，取更新的一边；独有项各留各的', () => {
  const farm = o.buildFarmSnapshot({ now: 1, diamond: 5, status: { status: { level: 1, gold: 100, coupon: 10, goldBean: 20 } } })
  const ranch = o.buildRanchSnapshot({ imageOf: String, state: { level: 1, currencies: [
    { id: 1007, name: '金券', count: '7' },
    { id: 1002, name: '点券', count: '11' },
    { id: 1005, name: '金豆豆', count: '21' },
    { id: 1008, name: '松果', count: '3' },
  ] } })
  const byKey = list => Object.fromEntries(list.map(t => [t.key, t]))
  let m = byKey(o.mergeOverviewAssets(farm, ranch, 100, 50))
  assert.equal(m.coupon.value, '10')
  assert.equal(m.goldBean.value, '20')
  assert.equal(m.coupon.from, 'farm')
  m = byKey(o.mergeOverviewAssets(farm, ranch, 50, 100))
  assert.equal(m.coupon.value, '11')
  assert.equal(m.goldBean.value, '21')
  assert.equal(m.coupon.from, 'ranch')
  const list = o.mergeOverviewAssets(farm, ranch, 1, 2)
  assert.equal(list.length, 6)
  assert.deepEqual(list.map(t => t.label), ['金币', '点券', '金豆豆', '钻石', '金券', '松果'])
  // 缺一边
  assert.deepEqual(o.mergeOverviewAssets(null, ranch).map(t => t.label), ['点券', '金豆豆', '金券', '松果'])
  assert.deepEqual(o.mergeOverviewAssets(farm, null).map(t => t.label), ['金币', '点券', '金豆豆', '钻石'])
  assert.deepEqual(o.mergeOverviewAssets(null, null), [])
})

test('农场快照带生涯：只有累计收获 / 累计偷菜', () => {
  const s = o.buildFarmSnapshot({ status: {}, career: { harvest: 100, steal: 20 } })
  assert.deepEqual(s.career, { harvest: 100, steal: 20 })
  assert.equal(o.buildFarmSnapshot({ status: {} }).career, null)
})
