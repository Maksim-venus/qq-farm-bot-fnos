// [fnos-fork] 好友页「按 GID 加好友（测试）」默认收起，并调用按 GID 申请接口。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const friends = readFileSync(new URL('../src/views/Friends.vue', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/components/fnos/FnosApplyFriendByGid.vue', import.meta.url), 'utf8')

test('好友页挂上默认收起的按 GID 加好友区域', () => {
  assert.match(friends, /<FnosApplyFriendByGid \/>/)
  const openTag = panel.match(/<details[^>]*>/)?.[0] || ''
  assert.equal(openTag, '<details class="fnos-apply-friend">')
  assert.equal(openTag.includes('open'), false)
  assert.match(panel, /<summary>按 GID 加好友（测试）<\/summary>/)
  assert.match(panel, /\/api\/friend\/\$\{gid\}\/apply/)
  assert.match(panel, /申请加好友/)
})
