// [fnos-fork] 背包种子优先顺序：直接改序号、拖动排序的纯函数与挂载方式。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadModule() {
  const source = readFileSync(new URL('../src/utils/fnos-sort-order.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

const m = loadModule()
const list = ['a', 'b', 'c', 'd', 'e']

test('moving an item to a position shifts the others', () => {
  assert.deepEqual(m.fnosMoveIndex(list, 4, 1), ['a', 'e', 'b', 'c', 'd'])
  assert.deepEqual(m.fnosMoveIndex(list, 4, 2), ['a', 'b', 'e', 'c', 'd'])
  assert.deepEqual(m.fnosMoveIndex(list, 0, 3), ['b', 'c', 'd', 'a', 'e'])
  assert.deepEqual(m.fnosMoveIndex(list, 0, 4), ['b', 'c', 'd', 'e', 'a'])
  assert.deepEqual(m.fnosMoveIndex(list, 2, 2), list)
  assert.deepEqual(list, ['a', 'b', 'c', 'd', 'e'], 'source array is not mutated')
})

test('move boundaries: target clamps, invalid source is a no-op', () => {
  assert.deepEqual(m.fnosMoveIndex(list, 4, -3), ['e', 'a', 'b', 'c', 'd'])
  assert.deepEqual(m.fnosMoveIndex(list, 0, 99), ['b', 'c', 'd', 'e', 'a'])
  assert.deepEqual(m.fnosMoveIndex(list, -1, 0), list)
  assert.deepEqual(m.fnosMoveIndex(list, 5, 0), list)
  assert.deepEqual(m.fnosMoveIndex(list, 1, Number.NaN), list)
  assert.deepEqual(m.fnosMoveIndex([], 0, 0), [])
  assert.deepEqual(m.fnosMoveIndex(['x'], 0, 3), ['x'])
})

test('typed positions clamp to 1..N, invalid input returns null', () => {
  assert.equal(m.fnosParseSortPosition('2', 5), 2)
  assert.equal(m.fnosParseSortPosition(' 3 ', 5), 3)
  assert.equal(m.fnosParseSortPosition('０２', 5), 2, 'full-width digits')
  assert.equal(m.fnosParseSortPosition('99', 5), 5)
  assert.equal(m.fnosParseSortPosition('0', 5), 1)
  assert.equal(m.fnosParseSortPosition('-4', 5), 1)
  for (const bad of ['', '  ', 'abc', '2.5', '1e2', '2a', null, undefined])
    assert.equal(m.fnosParseSortPosition(bad, 5), null, `rejects ${JSON.stringify(bad)}`)
  assert.equal(m.fnosParseSortPosition('1', 0), null)
})

const column = [0, 1, 2].map(i => ({ left: 0, top: i * 100, width: 300, height: 90 }))
const grid = [0, 1, 2, 3, 4].map(i => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 100, width: 100, height: 90 }))

test('drop target in a single column uses vertical halves', () => {
  assert.equal(m.fnosSortAxis(column), 'y')
  assert.deepEqual(m.fnosComputeDropTarget(column, { x: 10, y: 10 }, 2), { hoverIndex: 0, side: 'before', axis: 'y', finalIndex: 0 })
  assert.deepEqual(m.fnosComputeDropTarget(column, { x: 10, y: 170 }, 0), { hoverIndex: 1, side: 'after', axis: 'y', finalIndex: 1 })
  // 落在自己身上或紧邻的槽位 = 不变
  assert.equal(m.fnosComputeDropTarget(column, { x: 10, y: 110 }, 1).finalIndex, 1)
  assert.equal(m.fnosComputeDropTarget(column, { x: 10, y: 80 }, 1).finalIndex, 1)
  // 拖出列表上下方取最近一项
  assert.equal(m.fnosComputeDropTarget(column, { x: 10, y: -50 }, 2).finalIndex, 0)
  assert.equal(m.fnosComputeDropTarget(column, { x: 10, y: 900 }, 0).finalIndex, 2)
  // 间隙
  assert.equal(m.fnosComputeDropTarget(column, { x: 10, y: 95 }, 2).hoverIndex, 0)
  assert.equal(m.fnosComputeDropTarget([], { x: 0, y: 0 }, 0), null)
  assert.equal(m.fnosComputeDropTarget(column, { x: 0, y: 0 }, 5), null)
})

test('drop target in a multi-column grid uses horizontal halves', () => {
  assert.equal(m.fnosSortAxis(grid), 'x')
  assert.deepEqual(m.fnosComputeDropTarget(grid, { x: 120, y: 40 }, 4), { hoverIndex: 1, side: 'before', axis: 'x', finalIndex: 1 })
  assert.deepEqual(m.fnosComputeDropTarget(grid, { x: 300, y: 40 }, 0), { hoverIndex: 2, side: 'after', axis: 'x', finalIndex: 2 })
  assert.equal(m.fnosSlotToFinalIndex(3, 4), 3)
  assert.equal(m.fnosSlotToFinalIndex(5, 0), 4)
})

test('edge auto-scroll speed', () => {
  assert.equal(m.fnosEdgeScrollSpeed(400, 0, 800), 0)
  assert.ok(m.fnosEdgeScrollSpeed(5, 0, 800) < 0)
  assert.ok(m.fnosEdgeScrollSpeed(795, 0, 800) > 0)
  assert.equal(m.fnosEdgeScrollSpeed(-100, 0, 800), -18)
  assert.ok(m.fnosEdgeScrollSpeed(40, 100, 900) < 0, 'scroll container offset')
})

test('settings mounts the sortable list with handle and editable position', () => {
  const settings = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  assert.match(settings, /<FnosSortableList[\s\S]*?@move="fnosMoveBagSeedIndex"/)
  assert.match(settings, /@fnos-move-to="fnosMoveBagSeedIndex\(index, \$event - 1\)"/)
  assert.match(settings, /:data-fnos-sort-index="index"/)
  assert.match(settings, /@move-up="moveBagSeedUp\(seed\.seedId\)"/, 'up/down buttons kept')
  const item = readFileSync(new URL('../src/components/settings/BagSeedPriorityItem.vue', import.meta.url), 'utf8')
  assert.match(item, /<FnosSortPositionInput/)
  assert.match(item, /touch-none[^"]*"[\s\S]*?@pointerdown="handleFnosHandleDown"/)
  const list = readFileSync(new URL('../src/components/fnos/FnosSortableList.vue', import.meta.url), 'utf8')
  assert.match(list, /addEventListener\('pointermove'/)
  assert.doesNotMatch(list, /from ['"]sortablejs['"]/)
})
