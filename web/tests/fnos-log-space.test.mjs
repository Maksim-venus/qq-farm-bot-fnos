// [fnos-fork] 2026-11-17 运行日志农场、牧场合成一张卡片：全部 / 农场 / 牧场 切换的纯函数测试
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

const m = loadModule('fnos-log-space')
const farm = i => ({ tag: '农场', msg: `f${i}`, meta: { module: 'farm' } })
const ranch = i => ({ tag: '牧场', msg: `r${i}`, meta: { module: 'ranch', event: 'ranch_steal' } })

test('切换项：全部 / 农场 / 牧场，默认全部', () => {
  assert.deepEqual(m.FNOS_LOG_SPACE_VIEWS.map(v => v.label), ['全部', '农场', '牧场'])
  assert.equal(m.fnosNormalizeLogSpaceView('bogus'), 'all')
  assert.equal(m.fnosNormalizeLogSpaceView('ranch'), 'ranch')
})

test('记住上次选择；存储不可用时回到全部', () => {
  const mem = new Map()
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  assert.equal(m.fnosLoadLogSpaceView(storage), 'all')
  m.fnosSaveLogSpaceView('ranch', storage)
  assert.equal(m.fnosLoadLogSpaceView(storage), 'ranch')
  const fail = () => {
    throw new Error('x')
  }
  const broken = { getItem: fail, setItem: fail }
  assert.equal(m.fnosLoadLogSpaceView(broken), 'all')
  assert.doesNotThrow(() => m.fnosSaveLogSpaceView('farm', broken))
})

test('按切换筛选', () => {
  const list = [farm(1), ranch(1), farm(2)]
  assert.equal(m.fnosFilterLogSpaceView(list, 'all').length, 3)
  assert.deepEqual(m.fnosFilterLogSpaceView(list, 'ranch').map(e => e.msg), ['r1'])
  assert.deepEqual(m.fnosFilterLogSpaceView(list, 'farm').map(e => e.msg), ['f1', 'f2'])
})

test('实时日志农场、牧场各留 cap 条，农场刷屏不挤掉牧场', () => {
  const list = [ranch(0)]
  for (let i = 0; i < 10; i++) list.push(farm(i))
  const trimmed = m.fnosTrimLogsPerSpace(list, 3)
  assert.deepEqual(trimmed.map(e => e.msg), ['r0', 'f7', 'f8', 'f9'])
  const small = [farm(1), ranch(1)]
  assert.equal(m.fnosTrimLogsPerSpace(small, 3), small)
})

test('牧场今日汇总文字', () => {
  const parts = m.fnosRanchSummaryParts({ steal: { times: 3, friends: ['A', 'B'], items: { 鸭蛋: 3, 鹅蛋: 10 } }, harvest: 2, putMosquito: 0, cleanFriend: 4 })
  assert.equal(parts.steal, '偷取 3 次（2 位好友）：鹅蛋×10、鸭蛋×3')
  assert.deepEqual(parts.actions, ['收获 2', '帮好友清理 4'])
  assert.equal(m.fnosRanchSummaryParts(null).steal, '偷取 0 次')
})

test('农场今日汇总文字', () => {
  const parts = m.fnosFarmSummaryParts({ steal: { times: 5, friends: ['琳琳', '小果'], items: { 白萝卜: 4, 胡萝卜: 1 } }, harvest: 6, fertilize: 5, plant: 3, helpWeed: 1, helpWater: 2, putWeed: 1 })
  assert.equal(parts.steal, '偷取 5 次（2 位好友）：白萝卜×4、胡萝卜×1')
  assert.deepEqual(parts.actions, ['收获 6', '施肥 5', '种植 3', '除草 1', '浇水 2', '放草 1'])
  assert.equal(m.fnosFarmSummaryParts(null).steal, '偷取 0 次')
})

test('北京时间 0 点切日边界：23:59 与 00:00 分属两天', () => {
  const before = Date.parse('2026-11-17T23:59:59.500+08:00')
  const after = Date.parse('2026-11-18T00:00:00.000+08:00')
  assert.equal(m.fnosBeijingDate(before), '2026-11-17')
  assert.equal(m.fnosBeijingDate(after), '2026-11-18')
  assert.equal(m.fnosMsUntilNextBeijingMidnight(before), 500)
  assert.equal(m.fnosMsUntilNextBeijingMidnight(after), 24 * 3600 * 1000)
})

test('一张卡片：合并后的首页用 RunLogCard（农场、牧场两个空间的概览是同一页）', () => {
  const dash = readFileSync(new URL('../src/views/Dashboard.vue', import.meta.url), 'utf8')
  const menu = readFileSync(new URL('../src/router/menu.ts', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../src/components/RunLogCard.vue', import.meta.url), 'utf8')
  assert.match(dash, /<RunLogCard/)
  assert.match(menu, /ranch-dashboard.*Dashboard\.vue/)
  assert.doesNotMatch(dash, /fetchLogs/)
  assert.match(card, /FNOS_LOG_SPACE_VIEWS/)
  assert.match(card, /FNOS_RANCH_SCOPE_OPTIONS/)
  assert.match(card, /log-row--ranch/)
  assert.match(card, /ranch-log-summary/)
  assert.match(card, /farm-log-summary/)
  assert.match(card, /今日农场/)
})
