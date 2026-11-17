/**
 * [fnos-fork] 2026-11-16「自己收菜优先」「空闲时只保留心跳」：前端纯函数（读取回包补默认值、保存前收拢范围）。
 * 字段 fnosQuietPriority 在「设置 → 自动控制」里随「保存自动控制」一起走 /api/settings/save，按账号持久化。
 * 与 core/src/services/fnos-quiet-priority.ts 的 normalizeFnosQuietPriority 保持一致。
 */

export interface FnosQuietPriority {
  ownHarvestFirst: boolean
  mergeWindowSec: number
  idleKeepaliveOnly: boolean
  idleMinMinutes: number
  idleMaxMinutes: number
  /** [fnos-fork] 2026-11-17 按时间表偷菜（默认开）、好友列表扫描间隔（分钟，默认 5）、自家到期前几秒进去等（默认 2） */
  timetableSteal: boolean
  friendScanMinutes: number
  ownLeadSec: number
}

export const FNOS_QUIET_PRIORITY_DEFAULT: FnosQuietPriority = {
  ownHarvestFirst: true,
  mergeWindowSec: 10,
  idleKeepaliveOnly: false,
  idleMinMinutes: 1,
  idleMaxMinutes: 10,
  timetableSteal: true,
  friendScanMinutes: 5,
  ownLeadSec: 2,
}

function int(src: any, key: string, min: number, max: number, fallback: number): number {
  const raw = src && typeof src === 'object' ? src[key] : undefined
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n))
    return fallback
  return Math.max(min, Math.min(max, n))
}

export function fnosNormalizeQuietPriority(input: unknown): FnosQuietPriority {
  const d = FNOS_QUIET_PRIORITY_DEFAULT
  const src: any = input && typeof input === 'object' ? input : {}
  let idleMinMinutes = int(src, 'idleMinMinutes', 1, 180, d.idleMinMinutes)
  let idleMaxMinutes = int(src, 'idleMaxMinutes', 1, 180, d.idleMaxMinutes)
  if (idleMinMinutes > idleMaxMinutes)
    [idleMinMinutes, idleMaxMinutes] = [idleMaxMinutes, idleMinMinutes]
  return {
    ownHarvestFirst: src.ownHarvestFirst !== undefined ? !!src.ownHarvestFirst : d.ownHarvestFirst,
    mergeWindowSec: int(src, 'mergeWindowSec', 0, 30, d.mergeWindowSec),
    idleKeepaliveOnly: src.idleKeepaliveOnly !== undefined ? !!src.idleKeepaliveOnly : d.idleKeepaliveOnly,
    idleMinMinutes,
    idleMaxMinutes,
    timetableSteal: src.timetableSteal !== undefined ? !!src.timetableSteal : d.timetableSteal,
    friendScanMinutes: int(src, 'friendScanMinutes', 1, 60, d.friendScanMinutes),
    ownLeadSec: int(src, 'ownLeadSec', 0, 10, d.ownLeadSec),
  }
}
