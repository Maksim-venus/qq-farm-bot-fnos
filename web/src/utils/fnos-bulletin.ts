// [fnos-fork] 游戏公告展示用的纯函数。图片地址走 gatewayPath()；正文在组件里用文本节点渲染。
import { gatewayPath } from '@/utils/gateway'

/** proto 注释：status 1 = 已读。没有状态时不显示标签。 */
export function bulletinReadLabel(status: unknown): string {
  if (status === null || status === undefined || status === '')
    return ''
  const value = Number(status)
  if (!Number.isFinite(value))
    return ''
  if (value === 1)
    return '已读'
  if (value === 0)
    return '未读'
  return `状态 ${value}`
}

/** 类型没有官方名称表，只在有值时显示编号。 */
export function bulletinTypeLabel(type: unknown): string {
  const value = Number(type)
  if (!Number.isFinite(value) || value <= 0)
    return ''
  return `类型 ${value}`
}

/**
 * 只允许本应用路径和外链图片。本应用路径补上网关前缀；javascript: 等其他写法丢掉。
 */
export function bulletinImageSrc(url: unknown): string {
  const value = gatewayPath(String(url ?? '').trim())
  if (!value)
    return ''
  if (value.startsWith('/') || /^https?:\/\//i.test(value))
    return value
  return ''
}
