// [fnos-fork] 游戏公告：已读/类型文案、图片走网关前缀、弹窗不用 v-html
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadTs(relative, envBase = '/') {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  const localRequire = (id) => {
    if (id === './gateway' || id.endsWith('/gateway'))
      return loadTs('../src/utils/gateway.ts', envBase)
    return require(id)
  }
  // typescript 保留 import.meta，这里换成测试注入的对象。
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'importMeta', outputText.replaceAll('import.meta', 'importMeta'))(
    localRequire,
    module,
    module.exports,
    { env: { BASE_URL: envBase } },
  )
  return module.exports
}

const bulletin = loadTs('../src/utils/fnos-bulletin.ts', '/app/qq-farm-bot/')

test('已读状态和类型只在有值时显示', () => {
  assert.equal(bulletin.bulletinReadLabel(1), '已读')
  assert.equal(bulletin.bulletinReadLabel(0), '未读')
  assert.equal(bulletin.bulletinReadLabel(3), '状态 3')
  assert.equal(bulletin.bulletinReadLabel(''), '')
  assert.equal(bulletin.bulletinTypeLabel(2), '类型 2')
  assert.equal(bulletin.bulletinTypeLabel(0), '')
  assert.equal(bulletin.bulletinTypeLabel(undefined), '')
})

test('图片地址走网关前缀，外链和危险地址不改写进页面', () => {
  assert.equal(
    bulletin.bulletinImageSrc('/uploads/gengxingonggao_bn.png'),
    '/app/qq-farm-bot/uploads/gengxingonggao_bn.png',
  )
  assert.equal(
    bulletin.bulletinImageSrc('https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png'),
    'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png',
  )
  assert.equal(bulletin.bulletinImageSrc('javascript:alert(1)'), '')
  assert.equal(bulletin.bulletinImageSrc(''), '')
})

test('页头入口和弹窗用纯文本保留换行，接口走现有网关前缀客户端', () => {
  const header = readFileSync(new URL('../src/components/PageHeader.vue', import.meta.url), 'utf8')
  const dialog = readFileSync(new URL('../src/components/fnos/BulletinBoardDialog.vue', import.meta.url), 'utf8')
  assert.match(header, /aria-label="游戏公告"/)
  assert.match(header, /BulletinBoardDialog/)
  assert.match(header, /不要恢复 ThemeSwitcher/)
  assert.doesNotMatch(header, /<ThemeSwitcher/)
  assert.doesNotMatch(dialog, /v-html/i)
  assert.match(dialog, /white-space:\s*pre-wrap/)
  assert.match(dialog, /\/api\/fnos\/bulletins/)
  assert.match(dialog, /accountId/)
  assert.match(dialog, /x-account-id/)
  assert.match(dialog, /bulletinImageSrc/)
  assert.match(dialog, /请先选择账号/)
})
