// [fnos-fork] 列表排序的纯函数：直接改序号、拖动排序共用。
// 只改变同一个数组的顺序，不增删元素；供 FnosSortableList / FnosSortPositionInput 使用（背包种子优先顺序等）。

/** 把 from 位置的元素移到 to 位置（0 起），其他元素顺延；返回新数组，原数组不变。to 越界时夹到 0..N-1，from 非法时原样返回副本。 */
export function fnosMoveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const length = next.length
  if (!Number.isInteger(from) || from < 0 || from >= length || !Number.isFinite(to))
    return next
  const target = Math.min(length - 1, Math.max(0, Math.trunc(to)))
  if (target === from)
    return next
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item as T)
  return next
}

/**
 * 解析用户输入的目标序号（1 起）。
 * 只接受整数（可带正负号和首尾空格，全角数字也认）；越界夹到 1..total；空、小数、非数字、total<1 返回 null（调用方恢复原值）。
 */
export function fnosParseSortPosition(raw: unknown, total: number): number | null {
  const count = Math.trunc(Number(total))
  if (!Number.isFinite(count) || count < 1)
    return null
  const text = String(raw ?? '')
    .replace(/[\uFF10-\uFF19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48))
    .replace(/\uFF0D/g, '-')
    .replace(/\uFF0B/g, '+')
    .trim()
  if (!/^[+-]?\d+$/.test(text))
    return null
  const value = Number(text)
  if (!Number.isFinite(value))
    return null
  return Math.min(count, Math.max(1, value))
}

export interface FnosSortRect {
  left: number
  top: number
  width: number
  height: number
}

export type FnosSortAxis = 'x' | 'y'
export type FnosSortSide = 'before' | 'after'

export interface FnosSortDropTarget {
  /** 指针所在（或最近）的那一项。 */
  hoverIndex: number
  /** 插在这一项前面还是后面。 */
  side: FnosSortSide
  /** 判断前后用的方向：多列网格看左右，单列看上下。 */
  axis: FnosSortAxis
  /** 松手后被拖动项的最终位置（0 起）。 */
  finalIndex: number
}

/** 多列网格（有两项在同一行、左右不同）时按左右判断插入位置，否则按上下。 */
export function fnosSortAxis(rects: readonly FnosSortRect[]): FnosSortAxis {
  for (let i = 1; i < rects.length; i++) {
    const a = rects[i - 1]!
    const b = rects[i]!
    if (Math.abs(a.top - b.top) < 4 && Math.abs(a.left - b.left) >= 4)
      return 'x'
  }
  return 'y'
}

/** 插入槽位（0..N，原列表下标）换算成被拖动项的最终位置。 */
export function fnosSlotToFinalIndex(slot: number, from: number) {
  return slot > from ? slot - 1 : slot
}

function distanceToRect(rect: FnosSortRect, x: number, y: number) {
  const dx = Math.max(rect.left - x, 0, x - (rect.left + rect.width))
  const dy = Math.max(rect.top - y, 0, y - (rect.top + rect.height))
  return Math.hypot(dx, dy)
}

/** 根据各项的位置和指针坐标算出插入位置；指针落在间隙或列表外时取最近的一项。 */
export function fnosComputeDropTarget(
  rects: readonly FnosSortRect[],
  point: { x: number, y: number },
  from: number,
): FnosSortDropTarget | null {
  if (rects.length === 0 || from < 0 || from >= rects.length)
    return null
  let hoverIndex = -1
  let best = Number.POSITIVE_INFINITY
  rects.forEach((rect, index) => {
    const distance = distanceToRect(rect, point.x, point.y)
    if (distance < best) {
      best = distance
      hoverIndex = index
    }
  })
  if (hoverIndex < 0)
    return null
  const axis = fnosSortAxis(rects)
  const rect = rects[hoverIndex]!
  const before = axis === 'x'
    ? point.x < rect.left + rect.width / 2
    : point.y < rect.top + rect.height / 2
  const side: FnosSortSide = before ? 'before' : 'after'
  const slot = before ? hoverIndex : hoverIndex + 1
  return { hoverIndex, side, axis, finalIndex: fnosSlotToFinalIndex(slot, from) }
}

/** 拖到滚动区边缘时的自动滚动速度（像素/帧，负数向上）；不在边缘返回 0。 */
export function fnosEdgeScrollSpeed(pointer: number, start: number, end: number, edge = 56, maxSpeed = 18) {
  if (end - start <= edge * 2)
    edge = Math.max(8, (end - start) / 4)
  if (pointer < start + edge)
    return -Math.ceil(maxSpeed * Math.min(1, (start + edge - pointer) / edge))
  if (pointer > end - edge)
    return Math.ceil(maxSpeed * Math.min(1, (pointer - (end - edge)) / edge))
  return 0
}
