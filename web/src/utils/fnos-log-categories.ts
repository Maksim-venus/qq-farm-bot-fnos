// [fnos-fork] 运行日志「全部 / 偷菜日志 / 报错日志」分栏：纯函数，供 Dashboard 使用，规则说明见 core/src/runtime/fnos-log-categories.ts

export type FnosLogView = 'all' | 'steal' | 'error'
export type FnosErrorLevelFilter = '' | 'error' | 'warn'

export const FNOS_LOG_VIEWS: { value: FnosLogView, label: string, icon: string }[] = [
  { value: 'all', label: '全部', icon: 'i-carbon-list' },
  { value: 'steal', label: '偷菜日志', icon: 'i-carbon-shopping-bag' },
  { value: 'error', label: '报错日志', icon: 'i-carbon-warning-alt' },
]

export const FNOS_ERROR_LEVEL_OPTIONS: { label: string, value: FnosErrorLevelFilter }[] = [
  { label: '错误+警告', value: '' },
  { label: '仅错误', value: 'error' },
  { label: '仅警告', value: 'warn' },
]

/** 分类视图一次取的条数（服务端每类各存 1000 条） */
export const FNOS_CATEGORY_LOG_LIMIT = 200

export function fnosNormalizeLogView(value: unknown): FnosLogView {
  return value === 'steal' || value === 'error' ? value : 'all'
}

export function fnosIsCategoryLogView(view: unknown): boolean {
  return fnosNormalizeLogView(view) !== 'all'
}

/** 生成 /api/logs 的额外查询参数；「全部」不加参数，保持上游请求原样。 */
export function fnosBuildLogCategoryParams(view: unknown, level: unknown = ''): Record<string, string | number> {
  const v = fnosNormalizeLogView(view)
  if (v === 'all')
    return {}
  const params: Record<string, string | number> = { category: v, limit: FNOS_CATEGORY_LOG_LIMIT }
  if (v === 'error' && (level === 'error' || level === 'warn'))
    params.level = level
  return params
}

export function fnosEmptyLogText(view: unknown): string {
  const v = fnosNormalizeLogView(view)
  if (v === 'steal')
    return '暂无偷菜日志'
  if (v === 'error')
    return '暂无报错日志'
  return '暂无日志'
}
