// [fnos-fork] 偷收比：公式、阈值边界、好友列表筛选
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

test('缺省配置四项开关全关，阈值 80；没带的字段沿用已保存值', () => {
  assert.deepEqual(m.fnosNormalizeStealRatio(undefined), {
    thresholdPercent: 80,
    ignoreApplications: false,
    listFilter: false,
    barkOnSteal: false,
    autoDelete: false,
  })
  const next = m.fnosNormalizeStealRatio({ barkOnSteal: true }, {
    thresholdPercent: 70,
    ignoreApplications: true,
    listFilter: false,
    barkOnSteal: false,
    autoDelete: false,
  })
  assert.equal(next.thresholdPercent, 70)
  assert.equal(next.ignoreApplications, true)
  assert.equal(next.barkOnSteal, true)
  assert.equal(next.autoDelete, false)
  assert.equal(m.fnosNormalizeStealRatio({ thresholdPercent: 0 }).thresholdPercent, 80)
  assert.equal(m.fnosNormalizeStealRatio({ thresholdPercent: 101 }).thresholdPercent, 101)
  assert.equal(m.fnosNormalizeStealRatio({ thresholdPercent: 250 }).thresholdPercent, 250)
  assert.equal(m.fnosNormalizeStealRatio({ thresholdPercent: 100001 }).thresholdPercent, 80)
  assert.equal(m.fnosNormalizeStealRatio({ thresholdPercent: 80.4 }).thresholdPercent, 80)
})

test('偷收比 = 生涯偷菜 / 生涯收获；恰好 80% 不超过，只偷不收视为超过', () => {
  assert.equal(m.fnosStealRatioInfo(100, 80).text, '80%')
  assert.equal(m.fnosStealRatioAbove(100, 80, 80), false)
  assert.equal(m.fnosStealRatioAbove(100, 81, 80), true)
  assert.equal(m.fnosStealRatioInfo(0, 0).text, '0%')
  assert.equal(m.fnosStealRatioAbove(0, 0, 80), false)
  assert.equal(m.fnosStealRatioInfo(0, 5).text, '只偷不收')
  assert.equal(m.fnosStealRatioAbove(0, 5, 80), true)
  assert.equal(m.fnosStealRatioInfo(3, 1).text, '33.3%')
})

test('好友筛选：全部、高于阈值、不高于、区间；未知生涯只在「全部」里出现', () => {
  const high = { harvest: 100, steal: 90 }
  const exact = { harvest: 100, steal: 80 }
  const low = { harvest: 100, steal: 10 }
  const onlySteal = { harvest: 0, steal: 4 }
  assert.equal(m.fnosFriendMatchesStealFilter(null, 'all', 80, 0, 100), true)
  assert.equal(m.fnosFriendMatchesStealFilter(null, 'above', 80, 0, 100), false)
  assert.equal(m.fnosFriendMatchesStealFilter(high, 'above', 80, 0, 100), true)
  assert.equal(m.fnosFriendMatchesStealFilter(exact, 'above', 80, 0, 100), false)
  assert.equal(m.fnosFriendMatchesStealFilter(exact, 'below', 80, 0, 100), true)
  assert.equal(m.fnosFriendMatchesStealFilter(onlySteal, 'above', 80, 0, 100), true)
  assert.equal(m.fnosFriendMatchesStealFilter(onlySteal, 'below', 80, 0, 100), false)
  assert.equal(m.fnosFriendMatchesStealFilter(low, 'range', 80, 0, 20), true)
  assert.equal(m.fnosFriendMatchesStealFilter(high, 'range', 80, 0, 20), false)
  assert.equal(m.fnosFriendMatchesStealFilter(onlySteal, 'range', 80, 0, 99), false)
  assert.equal(m.fnosFriendMatchesStealFilter(onlySteal, 'range', 80, 90, ''), true)
  assert.equal(m.fnosFriendMatchesStealFilter(low, 'range', 80, 50, 10), true)
})

test('偷收比可超过 100%：阈值 150 生效；区间上限留空不限，只偷不收只在不限时出现', () => {
  assert.equal(m.fnosStealRatioInfo(100, 250).text, '250%')
  assert.equal(m.fnosStealRatioAbove(100, 250, 150), true)
  assert.equal(m.fnosStealRatioAbove(100, 140, 150), false)
  const big = { harvest: 100, steal: 300 }
  const only = { harvest: 0, steal: 5 }
  assert.equal(m.fnosFriendMatchesStealFilter(big, 'range', 80, 200, ''), true)
  assert.equal(m.fnosFriendMatchesStealFilter(big, 'range', 80, 0, 250), false)
  assert.equal(m.fnosFriendMatchesStealFilter(big, 'range', 80, 0, 500), true)
  assert.equal(m.fnosFriendMatchesStealFilter(only, 'range', 80, 0, ''), true)
  assert.equal(m.fnosFriendMatchesStealFilter(only, 'range', 80, 0, 500), false)
})
