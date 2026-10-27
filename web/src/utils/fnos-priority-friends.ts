// [fnos-fork] 奶茶自动雇佣「优先雇佣人」多选：有序列表的纯函数（增、删、换序、规范化），供 FnosPriorityFriendPicker 使用。
import { fnosMoveIndex } from './fnos-sort-order'

export interface FnosPriorityFriend {
  gid: number
  name: string
}

/** 与后端 MAX_PRIORITY_FRIENDS 一致 */
export const FNOS_MAX_PRIORITY_FRIENDS = 20

function toGid(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 去掉无效/重复 GID，保留顺序，最多 20 人 */
export function fnosNormalizePriorityFriends(list: unknown): FnosPriorityFriend[] {
  const out: FnosPriorityFriend[] = []
  const seen = new Set<number>()
  for (const item of Array.isArray(list) ? list : []) {
    const raw = (item && typeof item === 'object') ? item as Record<string, unknown> : { gid: item }
    const gid = toGid(raw.gid)
    if (!gid || seen.has(gid))
      continue
    seen.add(gid)
    out.push({ gid, name: String(raw.name ?? '').trim().slice(0, 64) })
    if (out.length >= FNOS_MAX_PRIORITY_FRIENDS)
      break
  }
  return out
}

/** 读取接口返回的配置：有 priorityFriends 用它，否则把旧的单个 priorityGid/priorityName 转成一人列表 */
export function fnosPriorityFriendsFromConfig(cfg: { priorityFriends?: unknown, priorityGid?: unknown, priorityName?: unknown } | null | undefined): FnosPriorityFriend[] {
  if (!cfg)
    return []
  if (Array.isArray(cfg.priorityFriends))
    return fnosNormalizePriorityFriends(cfg.priorityFriends)
  const gid = toGid(cfg.priorityGid)
  return gid ? [{ gid, name: String(cfg.priorityName ?? '').trim() }] : []
}

/** 加到末尾；已在列表里或无效 GID 时原样返回副本 */
export function fnosAddPriorityFriend(list: readonly FnosPriorityFriend[], gid: unknown, name = ''): FnosPriorityFriend[] {
  return fnosNormalizePriorityFriends([...list, { gid, name }])
}

export function fnosRemovePriorityFriend(list: readonly FnosPriorityFriend[], gid: unknown): FnosPriorityFriend[] {
  const target = toGid(gid)
  return list.filter(item => item.gid !== target)
}

export function fnosMovePriorityFriend(list: readonly FnosPriorityFriend[], from: number, to: number): FnosPriorityFriend[] {
  return fnosMoveIndex(list, from, to)
}
