// [fnos-fork] 图鉴自动设置（2026-11-15 起在「自动控制」里）的前端纯函数与设置页结构测试
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

const m = loadModule('fnos-illustrated-auto')

test('读取回包：缺字段补默认（奖励领取默认开 2026-11-17，自动完成默认关）', () => {
  assert.deepEqual(m.fnosNormalizeIllustratedAuto(undefined), { autoClaimRewards: true, autoComplete: false })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto({ autoComplete: 1 }), { autoClaimRewards: true, autoComplete: true })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto({ autoClaimRewards: false }), { autoClaimRewards: false, autoComplete: false })
  assert.deepEqual(m.fnosNormalizeIllustratedAuto({ autoClaimRewards: true, autoComplete: false, fnosMilkTeaExtra: {} }), { autoClaimRewards: true, autoComplete: false })
})

test('设置页：图鉴开关在「自动控制」里，随「保存自动控制」一起保存；活动设置只剩占位；不再有奶茶 fork 选项', () => {
  const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  const form = read('components/settings/AutomationSettingsForm.vue')
  assert.match(form, /data-testid="fnos-illustrated-auto"/)
  assert.match(form, /settings\.fnosIllustratedAuto\.autoClaimRewards/)
  assert.match(form, /settings\.fnosIllustratedAuto\.autoComplete/)
  const store = read('stores/setting.ts')
  assert.match(store, /'fnosIllustratedAuto'/)
  const page = read('views/Settings.vue')
  assert.match(page, /fnosIllustratedAuto: fnosNormalizeIllustratedAuto\(/)
  assert.match(page, /key: 'fnos-alt', label: '活动设置'/)
  const fork = read('components/settings/FnosForkSettings.vue')
  assert.match(fork, /牧歌初启/) // 2026-11-17 占位换成上游活动说明
  assert.doesNotMatch(fork, /illustrated/i)
  // 去掉注释后，界面与逻辑里不应再有任何奶茶 fork 选项
  const strip = text => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const text of [fork, form, page, store].map(strip)) {
    assert.doesNotMatch(text, /milk-tea|MilkTea|奶茶|雇佣|工资|金露云酪|seedExchange/)
  }
})

test('[fnos-fork] 2026-11-17 牧场图鉴 / 巨大图鉴领取默认开；农场日志「图鉴奖励」筛选包含实际事件名', () => {
  const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  assert.match(read('utils/fnos-ranch.ts'), /illustratedAutoClaim: true/)
  assert.match(read('stores/setting.ts'), /illustratedAutoClaim: true/)
  assert.match(read('components/settings/AutomationSettingsForm.vue'), /牧场图鉴 \/ 巨大图鉴奖励自动领取/)
  assert.match(read('components/RunLogCard.vue'), /value: 'illustrated_rewards,图鉴奖励领取,图鉴奖励'/)
})
