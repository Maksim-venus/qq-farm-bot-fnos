// [fnos-fork] 「成熟作物先留给大号偷」开关：默认值、缺省兼容与超时输入只在开关打开时显示
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const source = readFileSync(new URL('../src/components/settings/FnosForkSettings.vue', import.meta.url), 'utf8')

test('holdForMaster defaults to true and a missing field from the API is treated as true', () => {
  assert.match(source, /interface AltAccount \{[^}]*holdForMaster: boolean/)
  assert.match(source, /const alt = ref<AltAccount>\(\{[^}]*holdForMaster: true/)
  assert.equal((source.match(/holdForMaster: (?:altRes|res)\.data\.data\?\.holdForMaster !== false/g) || []).length, 2)
})

test('the switch sits under the alt account card and the timeout input only shows when it is on', () => {
  const card = source.slice(source.indexOf('data-testid="fnos-alt-account"'), source.indexOf('data-testid="fnos-alt-coop"'))
  assert.match(card, /<BaseSwitch v-model="alt\.holdForMaster" label="成熟作物先留给大号偷" \/>/)
  const switchAt = card.indexOf('alt.holdForMaster" label')
  const guardAt = card.indexOf('<template v-if="alt.holdForMaster">')
  const timeoutAt = card.indexOf('v-model="timeoutModel"')
  const elseAt = card.indexOf('<p v-else')
  assert.ok(switchAt > 0 && guardAt > switchAt && timeoutAt > guardAt && elseAt > timeoutAt)
  // still requires the alt identity: the switch lives inside the「这是小号」block
  assert.ok(card.indexOf('<template v-if="alt.enabled">') < switchAt)
})
