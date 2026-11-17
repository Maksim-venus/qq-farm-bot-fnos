// [fnos-fork] 2026-11-17 好友时间表「还多久可偷」列：前端纯函数与页面结构测试
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

const m = loadModule('fnos-timetable')
const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
const row = o => ({ gid: 1, name: 'a', farmRipeAt: 0, farmHelpAt: 0, farmSeenAt: 0, farmVisitedAt: 0, ranchReadyAt: 0, ranchSeenAt: 0, ranchVisitedAt: 0, ...o })

test('倒计时 hh:mm:ss，超过 24 小时照样累计小时，不足 1 秒按 1 秒', () => {
  assert.equal(m.fnosFormatCountdown(0), '00:00:00')
  assert.equal(m.fnosFormatCountdown(400), '00:00:01')
  assert.equal(m.fnosFormatCountdown((3600 + 2 * 60 + 5) * 1000), '01:02:05')
  assert.equal(m.fnosFormatCountdown(26 * 3600 * 1000 + 191_000), '26:03:11')
})

test('农场「还多久可偷」：未扫描 / 倒计时 / 可偷（高亮）/ 空地；列表实时可偷优先', () => {
  const now = 1_000_000
  assert.deepEqual([m.fnosFarmCountdown(undefined, now).text, m.fnosFarmCountdown(undefined, now).ready], ['未扫描', false])
  assert.equal(m.fnosFarmCountdown(row({ farmRipeAt: now + 5000 }), now).text, '未扫描', '没进去读过成熟时间')
  const c = m.fnosFarmCountdown(row({ farmSeenAt: 1, farmRipeAt: now + 65_000 }), now)
  assert.deepEqual([c.text, c.counting, c.ready], ['00:01:05', true, false])
  assert.match(c.title, /^预计 \d\d:\d\d:\d\d 成熟$/)
  const r = m.fnosFarmCountdown(row({ farmSeenAt: 1, farmRipeAt: now - 1 }), now)
  assert.deepEqual([r.text, r.ready], ['可偷', true])
  assert.equal(m.fnosFarmCountdown(row({ farmSeenAt: 1, farmVisitedAt: 1 }), now).text, '空地')
  assert.deepEqual([m.fnosFarmCountdown(undefined, now, true).text, m.fnosFarmCountdown(undefined, now, true).ready], ['可偷', true])
  assert.match(m.fnosFarmCountdown(row({ farmSeenAt: 1, farmRipeAt: now + 1000, farmHelpAt: now + 9000 }), now).title, /需要帮忙/)
})

test('牧场「还多久可偷」（赶产倒计时）同规则', () => {
  const now = 5_000_000
  assert.equal(m.fnosRanchCountdown(undefined, now).text, '未扫描')
  assert.equal(m.fnosRanchCountdown(row({ ranchSeenAt: 1, ranchReadyAt: now + 3_600_000 }), now).text, '01:00:00')
  assert.equal(m.fnosRanchCountdown(row({ ranchSeenAt: 1, ranchReadyAt: now - 1 }), now).ready, true)
  assert.equal(m.fnosRanchCountdown(row({ ranchSeenAt: 1 }), now).text, '暂无可偷')
})

test('回包规整：去掉无效行，缺字段补 0', () => {
  assert.deepEqual(m.fnosNormalizeTimetableRows([{ gid: '7', farmRipeAt: '12' }, { gid: 0 }, null]), [row({ gid: 7, name: '', farmRipeAt: 12 })])
  assert.deepEqual(m.fnosNormalizeTimetableRows(undefined), [])
})

test('页面：农场好友、牧场好友列表都有「还多久可偷」，可偷行高亮；数据来自 /api/fnos/timetable；扫描间隔是可填输入框默认 5', () => {
  const friends = read('views/Friends.vue')
  assert.match(friends, /data-testid="fnos-tt-farm"/)
  assert.match(friends, /'is-tt-ready'/)
  const ranch = read('components/ranch/RanchFriendsPanel.vue')
  assert.match(ranch, /data-testid="fnos-tt-ranch"/)
  assert.match(ranch, /'is-tt-ready'/)
  assert.match(read('composables/useFnosTimetable.ts'), /\/api\/fnos\/timetable/)
  const form = read('components/settings/AutomationSettingsForm.vue')
  assert.match(form, /<BaseInput v-model\.number="settings\.fnosQuietPriority\.friendScanMinutes" label="好友列表扫描间隔 \(分钟，默认 5\)" type="number"/)
})
