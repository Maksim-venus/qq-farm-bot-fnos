// [fnos-fork] 地块卡片单块施肥：可施肥判断与禁用原因。
// 判断规则与 FarmPanel.vue 里的 isFertilizeCandidate / canOrganicFertilize 保持一致（上游 PR #105 的选地批量施肥）。
export type FnosCardFertilizerType = 'normal' | 'organic'

export interface FnosCardFertilizeContext {
  /** 当前账号 ID。 */
  accountId?: string | null
  /** 账号是否在运行（未运行时不能施肥）。 */
  running?: boolean
  /** 有施肥、务农、批量操作或一键操作正在进行。 */
  busy?: boolean
}

export function fnosIsFertilizeCandidate(land: any) {
  return !!land?.unlocked
    && !land?.occupiedByMaster
    && String(land?.status || '') === 'growing'
    && Number(land?.matureInSec) > 0
}

export function fnosCanOrganicFertilize(land: any) {
  const left = land?.leftInorcFertTimes
  return left == null || Number(left) > 0
}

/** 返回按钮的禁用原因；空字符串表示可以点击。 */
export function fnosCardFertilizeDisabledReason(land: any, type: FnosCardFertilizerType, ctx: FnosCardFertilizeContext = {}) {
  if (!ctx.accountId)
    return '请先选择账号'
  if (!ctx.running)
    return '账号未运行'
  if (ctx.busy)
    return '有操作正在进行，请稍候'
  if (!land || land.unlocked === false || String(land.status || '') === 'locked')
    return '未解锁'
  const master = Number(land.masterLandId) || 0
  if (land.occupiedByMaster && master > 0 && master !== Number(land.id))
    return `合种副地，请在主地 #${master} 施肥`
  if (!String(land.plantName || '').trim() || String(land.status || '') === 'empty')
    return '空地无需施肥'
  if (!fnosIsFertilizeCandidate(land))
    return '当前作物无需施肥'
  if (type === 'organic' && !fnosCanOrganicFertilize(land))
    return '有机化肥次数已用完'
  return ''
}
