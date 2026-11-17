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
  const r = m.fnosNormalizeRanch({ altHoldFallbackMinutes: 1, friendFeedPerTime: 9999, friendHelpProduce: 1, altHold: false, rotation: true, friendSteal: true })
  assert.equal(r.altHoldFallbackMinutes, 5)
  assert.equal(r.friendFeedPerTime, 500)
  assert.equal(r.friendHelpProduce, true)
  assert.equal(r.altHold, false)
  // 2026.11.16.1 起被上游取代的旧字段读到即丢弃
  assert.equal('rotation' in r, false)
  assert.equal('friendSteal' in r, false)
  assert.equal(m.FNOS_RANCH_DEFAULT.friendHelpProduce, false)
  assert.equal(m.fnosNormalizeRanch({}).friendFeedGoldKeep, 10000)
})

test('fnosGrassLands：默认关闭、自动补买默认开、X 夹取 0..24', () => {
  assert.deepEqual(m.fnosNormalizeGrassLands(null), { count: 0, autoBuy: true })
  assert.deepEqual(m.fnosNormalizeGrassLands({ count: 30, autoBuy: false }), { count: 24, autoBuy: false })
  assert.deepEqual(m.fnosNormalizeGrassLands({ count: -2 }), { count: 0, autoBuy: true })
})

test('设置页：牧场空间自动控制有「飞牛增强」卡片；农场自动控制有牧草地；随保存自动控制提交', () => {
  const form = read('components/settings/AutomationSettingsForm.vue')
  assert.match(form, /data-testid="fnos-ranch"/)
  for (const k of ['rotation', 'friendSteal', 'friendClean', 'friendMosquito', 'friendPutMosquito', 'friendPutPerFriend', 'friendIntervalMinutes', 'friendMaxPerPatrol', 'friendDailyVisitLimit'])
    assert.doesNotMatch(form, new RegExp(`settings\\.fnosRanch\\.${k}"`))
  assert.match(form, /settings\.fnosRanch\.friendFeedPerTime/)
  assert.match(form, /settings\.fnosRanch\.friendFeedGoldKeep/)
  assert.match(form, /金币（约 60\/份）/) // [fnos-fork] 2026-11-17 加草来源可选金币
  assert.doesNotMatch(form, /friendFeedKeep/)
  assert.match(form, /settings\.fnosRanch\.friendHelpProduce" label="好友牧场：帮忙生产" \/>/)
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

// [fnos-fork] 2026-11-17 牧场最近访客
test('fnos-ranch-visitors：筛选、徽标、时间格式；牧场好友分区含「最近访客」标签', () => {
  const v = loadModule('fnos-ranch-visitors')
  assert.deepEqual(v.FNOS_RANCH_VISITOR_FILTERS.map(f => f.key), ['all', 'steal', 'bad', 'help', 'stroke', 'other'])
  assert.equal(v.fnosRanchVisitorMatches({ actionKey: 'steal' }, 'steal'), true)
  assert.equal(v.fnosRanchVisitorMatches({ actionKey: 'bad' }, 'steal'), false)
  assert.equal(v.fnosRanchVisitorMatches({}, 'other'), true)
  assert.equal(v.fnosRanchVisitorMatches({ actionKey: 'bad' }, 'all'), true)
  assert.match(v.fnosRanchVisitorBadge('bad'), /red/)
  const now = new Date(2026, 10, 17, 12, 0, 0).getTime()
  assert.equal(v.fnosFormatVisitorTime(0, now), '--')
  assert.equal(v.fnosFormatVisitorTime(now - 30_000, now), '刚刚')
  assert.equal(v.fnosFormatVisitorTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(v.fnosFormatVisitorTime(new Date(2026, 10, 17, 9, 5).getTime(), now), '今天 09:05')
  assert.equal(v.fnosFormatVisitorTime(new Date(2026, 10, 16, 13, 5).getTime(), now), '11-16 13:05')
  const ranchView = readFileSync(new URL('../src/views/Ranch.vue', import.meta.url), 'utf8')
  assert.match(ranchView, /key: 'visitors', label: '最近访客'/)
})

test('牧场好友列表按牧场等级从高到低排序，未读取的按 Lv1', () => {
  const panel = readFileSync(new URL('../src/components/ranch/RanchFriendsPanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /\[\.\.\.list\]\.sort\(\(a, b\) => fnosRanchLevelOf\(b\) - fnosRanchLevelOf\(a\)\)/)
  assert.match(panel, /Number\(friend\?\.ranchLevel\) > 0 \? Number\(friend\.ranchLevel\) : 1/)
  assert.match(panel, /暂按 Lv1/)
  assert.doesNotMatch(panel, /Number\(b\?\.level\)/)
})

test('[fnos-fork] 2026-11-17 农牧轮流：农场日志可筛「农牧轮次」，牧场「牧场巡查」含轮次切换', () => {
  const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  assert.match(read('components/RunLogCard.vue'), /value: 'fnos轮次切换,fnos轮次插队'/)
  assert.match(read('utils/fnos-log-space.ts'), /ranch_automation,ranch_scene_restore,fnos牧场轮次'/)
})

test('[fnos-fork] 2026-11-17 给好友加牧草来源：默认仓库牧草，旧配置缺字段迁移到默认，设置页可选', () => {
  assert.equal(m.fnosNormalizeRanch({}).friendFeedSource, 'warehouse')
  assert.equal(m.fnosNormalizeRanch({ friendFeedSource: 'gold' }).friendFeedSource, 'gold')
  assert.equal(m.fnosNormalizeRanch({ friendFeedSource: 'xx' }).friendFeedSource, 'warehouse')
  const form = readFileSync(new URL('../src/components/settings/AutomationSettingsForm.vue', import.meta.url), 'utf8')
  assert.match(form, /settings\.fnosRanch\.friendFeedSource/)
  assert.match(form, /仓库牧草（默认）/)
})

test('[fnos-fork] 2026-11-17 上游牧场策略独立页：fork 牧场增强 fnosRanch 跟着移过去并一起保存；牧场设置页保留 fork 栏目', () => {
  const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  const strategy = read('views/RanchStrategy.vue')
  assert.match(strategy, /next\.fnosRanch = fnosNormalizeRanch\(next\.fnosRanch\)/)
  assert.match(strategy, /fnosRanch: fnosNormalizeRanch\(model\.value\.fnosRanch\)/)
  assert.match(read('views/Settings.vue'), /ranchTabKeys: SettingsTab\[\] = \['account', 'fnos-coop', 'fnos-alt', 'system'\]/)
  assert.match(read('utils/fnos-log-space.ts'), /ranch_task_claim,ranch_daily_share,ranch_daily_benefit/)
})
