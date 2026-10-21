// [fnos-fork] 地块卡片单块施肥按钮：禁用规则与挂载方式。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadRules() {
  const source = readFileSync(new URL('../src/utils/fnos-land-fertilize.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

const rules = loadRules()
const ready = { accountId: 'a', running: true, busy: false }
const growing = { id: 3, unlocked: true, status: 'growing', plantName: '白萝卜', matureInSec: 600, leftInorcFertTimes: 2 }

test('a growing crop can take both fertilizers from its own card', () => {
  assert.equal(rules.fnosCardFertilizeDisabledReason(growing, 'normal', ready), '')
  assert.equal(rules.fnosCardFertilizeDisabledReason(growing, 'organic', ready), '')
  assert.equal(rules.fnosCardFertilizeDisabledReason({ ...growing, leftInorcFertTimes: undefined }, 'organic', ready), '')
})

test('organic fertilizer is disabled once its uses are exhausted, normal still works', () => {
  const land = { ...growing, leftInorcFertTimes: 0 }
  assert.equal(rules.fnosCardFertilizeDisabledReason(land, 'normal', ready), '')
  assert.equal(rules.fnosCardFertilizeDisabledReason(land, 'organic', ready), '有机化肥次数已用完')
})

test('lands that cannot be fertilized explain why', () => {
  assert.equal(rules.fnosCardFertilizeDisabledReason({ ...growing, status: 'harvestable', matureInSec: 0 }, 'normal', ready), '当前作物无需施肥')
  assert.equal(rules.fnosCardFertilizeDisabledReason({ id: 1, unlocked: true, status: 'empty', plantName: '' }, 'normal', ready), '空地无需施肥')
  assert.equal(rules.fnosCardFertilizeDisabledReason({ id: 2, unlocked: false, status: 'locked' }, 'normal', ready), '未解锁')
  assert.equal(rules.fnosCardFertilizeDisabledReason({ ...growing, id: 4, occupiedByMaster: true, masterLandId: 3 }, 'normal', ready), '合种副地，请在主地 #3 施肥')
  assert.equal(rules.fnosIsFertilizeCandidate({ ...growing, matureInSec: 0 }), false)
})

test('buttons are disabled while the account is stopped or another operation runs', () => {
  assert.equal(rules.fnosCardFertilizeDisabledReason(growing, 'normal', { ...ready, accountId: '' }), '请先选择账号')
  assert.equal(rules.fnosCardFertilizeDisabledReason(growing, 'normal', { ...ready, running: false }), '账号未运行')
  assert.equal(rules.fnosCardFertilizeDisabledReason(growing, 'organic', { ...ready, busy: true }), '有操作正在进行，请稍候')
})

test('card buttons are mounted through the card slot, gated by the manual-fertilizer switch and hidden while selecting', () => {
  const card = readFileSync(new URL('../src/components/FarmLandCard.vue', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/components/FarmPanel.vue', import.meta.url), 'utf8')
  const buttons = readFileSync(new URL('../src/components/fnos/FnosLandFertilizeButtons.vue', import.meta.url), 'utf8')
  assert.match(card, /<slot name="actions" \/>/)
  assert.match(panel, /<template v-if="showManualFertilizerButtons && !selecting" #actions>\s*<FnosLandFertilizeButtons/)
  assert.match(panel, /show_manual_fertilizer !== false/)
  // 单块施肥沿用上游指定土地的施肥接口，只传这一块地。
  assert.match(buttons, /farmStore\.fertilizeAll\(accountId, type, \[landId\]\)/)
  // 按钮点击不能冒泡成「打开土地详情」。
  assert.match(buttons, /@click\.stop="fertilize\(/)
})
