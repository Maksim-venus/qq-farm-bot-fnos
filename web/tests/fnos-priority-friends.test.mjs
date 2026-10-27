// [fnos-fork] 优先雇佣人多选列表的纯函数测试
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadModule(name, localRequire = require) {
  const source = readFileSync(new URL(`../src/utils/${name}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports)
  return module.exports
}

const sortOrder = loadModule('fnos-sort-order')
const m = loadModule('fnos-priority-friends', id => (id === './fnos-sort-order' ? sortOrder : require(id)))

test('旧配置单个 priorityGid 转成一人列表；新字段优先', () => {
  assert.deepEqual(m.fnosPriorityFriendsFromConfig({ priorityGid: 11, priorityName: '甲' }), [{ gid: 11, name: '甲' }])
  assert.deepEqual(m.fnosPriorityFriendsFromConfig({ priorityGid: 0 }), [])
  assert.deepEqual(m.fnosPriorityFriendsFromConfig({ priorityGid: 11, priorityFriends: [{ gid: 22, name: '乙' }] }), [{ gid: 22, name: '乙' }])
  assert.deepEqual(m.fnosPriorityFriendsFromConfig(null), [])
})

test('添加去重、忽略无效 GID、最多 20 人', () => {
  let list = m.fnosAddPriorityFriend([], 1, 'a')
  list = m.fnosAddPriorityFriend(list, 2, 'b')
  list = m.fnosAddPriorityFriend(list, 1, 'dup')
  list = m.fnosAddPriorityFriend(list, 'x', 'bad')
  assert.deepEqual(list, [{ gid: 1, name: 'a' }, { gid: 2, name: 'b' }])
  let big = []
  for (let i = 1; i <= 25; i++) big = m.fnosAddPriorityFriend(big, i)
  assert.equal(big.length, m.FNOS_MAX_PRIORITY_FRIENDS)
})

test('移除与换序', () => {
  const list = [{ gid: 1, name: 'a' }, { gid: 2, name: 'b' }, { gid: 3, name: 'c' }]
  assert.deepEqual(m.fnosRemovePriorityFriend(list, 2).map(i => i.gid), [1, 3])
  assert.deepEqual(m.fnosMovePriorityFriend(list, 2, 0).map(i => i.gid), [3, 1, 2])
  assert.deepEqual(m.fnosMovePriorityFriend(list, 0, 1).map(i => i.gid), [2, 1, 3])
  assert.deepEqual(list.map(i => i.gid), [1, 2, 3])
})
