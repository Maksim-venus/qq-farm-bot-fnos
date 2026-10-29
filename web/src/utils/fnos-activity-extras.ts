/**
 * [fnos-fork] 2026-10-28 奶茶自动制作 / 自动领工资、图鉴奖励自动领取 / 自动完成图鉴：前端纯函数
 * （读取回包补默认值、卡片上的说明文字）。接口见 core/src/controllers/admin/fnos-fork-routes.ts。
 */

export interface FnosMilkTeaExtra { autoCraft: boolean, craftGoldenCheese: boolean, autoClaimWages: boolean, autoUpgradeShop: boolean }
export interface FnosIllustratedAuto { autoClaimRewards: boolean, autoComplete: boolean }

export const FNOS_MILK_TEA_EXTRA_DEFAULT: FnosMilkTeaExtra = { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false }
export const FNOS_ILLUSTRATED_AUTO_DEFAULT: FnosIllustratedAuto = { autoClaimRewards: false, autoComplete: false }

function bool(src: any, key: string, fallback: boolean): boolean {
  return src && typeof src === 'object' && src[key] !== undefined ? !!src[key] : fallback
}

export function fnosNormalizeMilkTeaExtra(input: unknown): FnosMilkTeaExtra {
  const d = FNOS_MILK_TEA_EXTRA_DEFAULT
  return {
    autoCraft: bool(input, 'autoCraft', d.autoCraft),
    craftGoldenCheese: bool(input, 'craftGoldenCheese', d.craftGoldenCheese),
    autoClaimWages: bool(input, 'autoClaimWages', d.autoClaimWages),
    autoUpgradeShop: bool(input, 'autoUpgradeShop', d.autoUpgradeShop), // [fnos-fork] 需求 27
  }
}

export function fnosNormalizeIllustratedAuto(input: unknown): FnosIllustratedAuto {
  const d = FNOS_ILLUSTRATED_AUTO_DEFAULT
  return {
    autoClaimRewards: bool(input, 'autoClaimRewards', d.autoClaimRewards),
    autoComplete: bool(input, 'autoComplete', d.autoComplete),
  }
}

/** 自动制作奶茶的当前效果说明。 */
export function fnosCraftHint(cfg: FnosMilkTeaExtra): string {
  if (!cfg.autoCraft)
    return '未开启：背包里的森野果实不会被自动做成奶茶。'
  return cfg.craftGoldenCheese
    ? '会把背包里所有可做奶茶的果实（含森野黄金芽 → 金露云酪）做成奶茶。'
    : '会把背包里可做奶茶的果实做成奶茶，森野黄金芽保留不做（不做金露云酪）。'
}

// ============ [fnos-fork] 2026-10-30 需求 27：森野种子自动兑换（按最大数量，可多选、可排序） ============

export interface FnosSeedExchangeEntry { id: number, enabled: boolean }
export interface FnosMilkTeaDaily { autoClaim: boolean, autoExchangeSeed: boolean, seedExchange: FnosSeedExchangeEntry[] }

/** 8 种森野种子（id 来自官方 ItemInfo.json），默认顺序与后端 FNOS_EXCHANGE_SEEDS 一致。 */
export const FNOS_EXCHANGE_SEEDS: ReadonlyArray<{ id: number, name: string }> = [
  { id: 20529, name: '森野芭乐种子' },
  { id: 29005, name: '森野黄金芽种子' },
  { id: 21435, name: '森野柿子种子' },
  { id: 20021, name: '森野可可豆种子' },
  { id: 20528, name: '森野红柚种子' },
  { id: 20527, name: '森野甜橙种子' },
  { id: 20526, name: '森野白桃种子' },
  { id: 20525, name: '森野甜莓种子' },
]

export function fnosSeedName(id: number): string {
  return FNOS_EXCHANGE_SEEDS.find(v => v.id === id)?.name || `物品 #${id}`
}

/** 规整种子列表（与后端 normalizeSeedExchange 相同）：缺省只勾森野黄金芽种子；去重、丢弃未知、缺的补在后面不勾。 */
export function fnosNormalizeSeedExchange(input: unknown): FnosSeedExchangeEntry[] {
  if (!Array.isArray(input))
    return FNOS_EXCHANGE_SEEDS.map(v => ({ id: v.id, enabled: v.id === 29005 }))
  const out: FnosSeedExchangeEntry[] = []
  for (const row of input) {
    const id = Number(row && typeof row === 'object' ? row.id : row)
    if (!FNOS_EXCHANGE_SEEDS.some(v => v.id === id) || out.some(v => v.id === id))
      continue
    out.push({ id, enabled: row && typeof row === 'object' ? !!row.enabled : true })
  }
  for (const v of FNOS_EXCHANGE_SEEDS) {
    if (!out.some(o => o.id === v.id))
      out.push({ id: v.id, enabled: false })
  }
  return out
}

export function fnosNormalizeMilkTeaDaily(input: unknown): FnosMilkTeaDaily {
  const src = input && typeof input === 'object' ? input as Record<string, any> : {}
  return {
    autoClaim: bool(src, 'autoClaim', false),
    autoExchangeSeed: bool(src, 'autoExchangeSeed', false),
    seedExchange: fnosNormalizeSeedExchange(src.seedExchange),
  }
}

/** 移动列表项（拖动或上下按钮），返回新数组。 */
export function fnosMoveSeedExchange(list: FnosSeedExchangeEntry[], from: number, to: number): FnosSeedExchangeEntry[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length)
    return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** 卡片说明：勾选了哪些、按什么顺序。 */
export function fnosSeedExchangeHint(cfg: FnosMilkTeaDaily): string {
  if (!cfg.autoExchangeSeed)
    return '未开启：不会自动兑换种子。'
  const names = cfg.seedExchange.filter(v => v.enabled).map(v => fnosSeedName(v.id))
  if (!names.length)
    return '已开启，但没有勾选任何种子。'
  return `每天按顺序兑换：${names.join(' → ')}，每种都按最大数量。`
}
