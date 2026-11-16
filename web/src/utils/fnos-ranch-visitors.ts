// [fnos-fork] 2026-11-17 牧场最近访客的前端纯函数（筛选、徽标颜色、时间），动作类型说明见 core/src/services/ranch/fnos-visitors.ts

export const FNOS_RANCH_VISITOR_FILTERS: { key: string, label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'steal', label: '偷取' },
  { key: 'bad', label: '放蚊子' },
  { key: 'help', label: '帮忙' },
  { key: 'stroke', label: '抚摸' },
  { key: 'other', label: '其他' },
]

export function fnosRanchVisitorMatches(record: any, filter: string): boolean {
  if (!filter || filter === 'all')
    return true
  return String(record?.actionKey || 'other') === filter
}

export function fnosRanchVisitorBadge(actionKey: string): string {
  if (actionKey === 'steal')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (actionKey === 'help')
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (actionKey === 'bad')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (actionKey === 'stroke')
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

/** 与农场访客同样的相对时间写法：刚刚 / N 分钟前 / 今天 HH:mm / M-D HH:mm / YYYY-M-D HH:mm */
export function fnosFormatVisitorTime(timestamp: number, nowMs: number = Date.now()): string {
  const ts = Number(timestamp) || 0
  if (!ts)
    return '--'
  const date = new Date(ts)
  const now = new Date(nowMs)
  const diff = nowMs - ts
  const minute = 60 * 1000
  const hour = 60 * minute
  if (diff >= 0 && diff < minute)
    return '刚刚'
  if (diff >= minute && diff < hour)
    return `${Math.floor(diff / minute)} 分钟前`
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth() && now.getDate() === date.getDate())
    return `今天 ${hm}`
  if (now.getFullYear() === date.getFullYear())
    return `${date.getMonth() + 1}-${date.getDate()} ${hm}`
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${hm}`
}
