<script setup lang="ts">
/**
 * [fnos-fork] 本 fork 新增的按账号设置（上游没有）：
 * - 大号/小号：小号成熟作物留给大号偷，大号偷过才自动收获
 * - 奶茶活动自动雇佣：可选「优先雇佣人」（好友，2026-10-27 起可多选并排序），统一的雇佣时长与职业可选或随机；2026.10.21.2 起与大小号解耦
 * - 奶茶收益每小时自动领取、兑换商店每日兑换森野黄金芽种子（2026.10.21）
 * - 奶茶自动制作（可排除金露云酪）、自动领取工资；图鉴奖励自动领取、自动完成图鉴（2026-10-28）
 * - 需求 27（2026-10-30）：店铺自动升级；森野种子自动兑换（8 种可勾选、可拖动排序，按最大数量）
 * 所在栏目（2026.10.21.3 起拆成两个独立栏目，都不在「自动控制」里）：
 * - section="coop"：设置 → 大小号协作（大号/小号、不偷大号、只给大号放捣乱）
 * - section="activity"：设置 → 活动设置（奶茶自动雇佣/工作事项、奶茶收益与兑换）
 * 接口见 core/src/controllers/admin/fnos-fork-routes.ts；请求经 Axios baseURL，自动带飞牛网关前缀。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import FnosPriorityFriendPicker from '@/components/fnos/FnosPriorityFriendPicker.vue' // [fnos-fork] 多个优先雇佣人
import FnosSortableList from '@/components/fnos/FnosSortableList.vue' // [fnos-fork] 需求 27 种子兑换顺序
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { fnosCraftHint, fnosMoveSeedExchange, fnosNormalizeIllustratedAuto, fnosNormalizeMilkTeaDaily, fnosNormalizeMilkTeaExtra, fnosSeedExchangeHint, fnosSeedName } from '@/utils/fnos-activity-extras' // [fnos-fork] 2026-10-28；需求 27
import { fnosPriorityFriendsFromConfig } from '@/utils/fnos-priority-friends'

const props = defineProps<{ accountId?: string | null, accountName?: string | null, section?: 'coop' | 'activity' }>()
const isCoop = computed(() => props.section === 'coop')
const toast = useToastStore()

interface AltAccount { enabled: boolean, masterGid: number, masterName: string, holdForMaster: boolean, timeoutMinutes: number, skipStealMaster: boolean, badOnlyMaster: boolean }
interface MilkTeaAutoHire { enabled: boolean, durationId: number, priorityFriends: Array<{ gid: number, name: string }>, priorityGid: number, priorityName: string, priorityConfigured: boolean, talentId: number, allowRobots: boolean, autoWork: boolean, workType: number }
interface FriendItem { gid: number | string, name?: string }

// [fnos-fork] holdForMaster「成熟作物先留给大号偷」缺省为 true（旧配置没有该字段时保持原有行为）
const alt = ref<AltAccount>({ enabled: false, masterGid: 0, masterName: '', holdForMaster: true, timeoutMinutes: 0, skipStealMaster: false, badOnlyMaster: false })
const tea = ref<MilkTeaAutoHire>({ enabled: false, durationId: 0, priorityFriends: [], priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 0, allowRobots: false, autoWork: false, workType: 0 })
const workOptions = ref<Array<{ workType: number, name: string, description: string, risky: boolean }>>([])
const daily = ref(fnosNormalizeMilkTeaDaily(null)) // [fnos-fork] 需求 27：含 8 种森野种子的勾选与顺序
const seedHint = computed(() => fnosSeedExchangeHint(daily.value))
function moveSeed(from: number, to: number) {
  daily.value.seedExchange = fnosMoveSeedExchange(daily.value.seedExchange, from, to)
}
function seedIndicatorStyle(indicator: { side: 'before' | 'after', axis: 'x' | 'y' } | null) {
  if (!indicator)
    return null
  return { left: '0', right: '0', height: '3px', [indicator.side === 'before' ? 'top' : 'bottom']: '-5px' }
}
const dailySaving = ref(false)
// [fnos-fork] 2026-10-28 奶茶自动制作 / 领工资、图鉴自动
const extra = ref(fnosNormalizeMilkTeaExtra(null))
const extraSaving = ref(false)
const illustrated = ref(fnosNormalizeIllustratedAuto(null))
const illustratedSaving = ref(false)
const craftHint = computed(() => fnosCraftHint(extra.value))
const durationOptions = ref<Array<{ durationId: number, label: string, cost: number }>>([])
const talentOptions = ref<Array<{ talentId: number, name: string }>>([])
const friends = ref<FriendItem[]>([])
const friendsError = ref('')
const loading = ref(false)
const friendsLoading = ref(false)
const altSaving = ref(false)
const teaSaving = ref(false)
const manualGid = ref<string | number>('')

const friendOptions = computed(() => {
  const list = friends.value
    .filter(f => Number(f.gid) > 0)
    .map(f => ({ label: `${String(f.name || '').trim() || '未命名'}（GID ${f.gid}）`, value: Number(f.gid) }))
  // 已保存的大号不在当前好友列表里时也显示出来
  if (alt.value.masterGid > 0 && !list.some(o => o.value === alt.value.masterGid))
    list.unshift({ label: `${alt.value.masterName || '已选大号'}（GID ${alt.value.masterGid}）`, value: alt.value.masterGid })
  return list
})

const masterGidModel = computed<number | undefined>({
  get: () => alt.value.masterGid > 0 ? alt.value.masterGid : undefined,
  set: (value) => {
    const gid = Number(value) || 0
    alt.value.masterGid = gid
    const f = friends.value.find(item => Number(item.gid) === gid)
    alt.value.masterName = String(f?.name || '').trim()
  },
})

const durationSelectOptions = computed(() => [
  { label: '随机（按活动剩余时间可选的档位）', value: 0 },
  ...durationOptions.value.map(d => ({ label: `${d.label}（${d.cost} 奶茶券）`, value: d.durationId })),
])
const talentSelectOptions = computed(() => [
  { label: '不限（随机）', value: 0 },
  ...talentOptions.value.map(t => ({ label: t.name, value: t.talentId })),
])
const workSelectOptions = computed(() => [
  { label: '随机（只在宣传推广 / 花式摇杯 / 招牌试饮中选）', value: 0 },
  ...workOptions.value.map(w => ({ label: w.name, value: w.workType })),
])
const workModel = computed<number>({
  get: () => tea.value.workType,
  set: (v) => {
    tea.value.workType = Number(v) || 0
  },
})
const workDescription = computed(() => workOptions.value.find(w => w.workType === tea.value.workType)?.description || '')
const teaMigratedFromAlt = ref(false)
const priorityManualGid = ref<string | number>('')
// [fnos-fork] 2026-10-27 优先雇佣人可多选：列表由 FnosPriorityFriendPicker 维护，手动输入 GID 时追加到末尾
const priorityPicker = ref<InstanceType<typeof FnosPriorityFriendPicker> | null>(null)
function applyPriorityManualGid() {
  const gid = Number.parseInt(String(priorityManualGid.value || ''), 10)
  if (!Number.isSafeInteger(gid) || gid <= 0) {
    toast.error('请输入正确的 GID')
    return
  }
  priorityPicker.value?.addGid(gid, String(friends.value.find(item => Number(item.gid) === gid)?.name || '').trim())
  priorityManualGid.value = ''
}
const durationModel = computed<number>({
  get: () => tea.value.durationId,
  set: (v) => {
    tea.value.durationId = Number(v) || 0
  },
})
const talentModel = computed<number>({
  get: () => tea.value.talentId,
  set: (v) => {
    tea.value.talentId = Number(v) || 0
  },
})
const timeoutModel = computed<number>({
  get: () => alt.value.timeoutMinutes,
  set: (v) => {
    alt.value.timeoutMinutes = Math.max(0, Math.min(10080, Math.floor(Number(v) || 0)))
  },
})

function headers() {
  return { 'x-account-id': String(props.accountId || '') }
}

async function loadFriends(force = false) {
  if (!props.accountId)
    return
  friendsLoading.value = true
  friendsError.value = ''
  try {
    if (!force) {
      const cache = await api.get('/api/friends/cache', { headers: headers(), skipErrorToast: true } as any).catch(() => null)
      if (cache?.data?.ok && Array.isArray(cache.data.data) && cache.data.data.length > 0) {
        friends.value = cache.data.data
        return
      }
    }
    const res = await api.get('/api/friends', { headers: headers(), skipErrorToast: true, params: force ? { forceSync: 'true' } : {} } as any)
    friends.value = Array.isArray(res.data?.data) ? res.data.data : []
    if (!friends.value.length)
      friendsError.value = '好友列表为空（账号需要在运行中才能读取好友，可先启动账号后点「刷新好友」）'
  }
  catch (e: any) {
    friendsError.value = `读取好友列表失败（账号需要在运行中）：${getApiErrorMessage(e, '未知错误')}`
  }
  finally {
    friendsLoading.value = false
  }
}

async function load() {
  if (!props.accountId)
    return
  loading.value = true
  try {
    const [altRes, teaRes, dailyRes, extraRes, illustratedRes] = await Promise.all([
      api.get('/api/fnos/alt-account', { headers: headers() }),
      api.get('/api/fnos/milk-tea-auto-hire', { headers: headers() }),
      api.get('/api/fnos/milk-tea-daily', { headers: headers() }),
      api.get('/api/fnos/milk-tea-extra', { headers: headers() }),
      api.get('/api/fnos/illustrated-auto', { headers: headers() }),
    ])
    if (extraRes.data?.ok)
      extra.value = fnosNormalizeMilkTeaExtra(extraRes.data.data)
    if (illustratedRes.data?.ok)
      illustrated.value = fnosNormalizeIllustratedAuto(illustratedRes.data.data)
    if (dailyRes.data?.ok)
      daily.value = fnosNormalizeMilkTeaDaily(dailyRes.data.data)
    if (altRes.data?.ok)
      alt.value = { ...alt.value, ...altRes.data.data, holdForMaster: altRes.data.data?.holdForMaster !== false }
    if (teaRes.data?.ok) {
      tea.value = { ...tea.value, ...teaRes.data.data, priorityFriends: fnosPriorityFriendsFromConfig(teaRes.data.data) }
      durationOptions.value = teaRes.data.options?.durations || []
      talentOptions.value = teaRes.data.options?.talents || []
      workOptions.value = teaRes.data.options?.works || []
      teaMigratedFromAlt.value = !!teaRes.data.migratedFromAlt
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '读取活动设置失败'))
  }
  finally {
    loading.value = false
  }
  loadFriends()
}

function applyManualGid() {
  const gid = Number.parseInt(String(manualGid.value || ''), 10)
  if (!Number.isSafeInteger(gid) || gid <= 0) {
    toast.error('请输入正确的 GID')
    return
  }
  masterGidModel.value = gid
}

function reportSave(res: any, okText: string) {
  if (res.data?.unconfirmed)
    toast.warning(res.data.error || '已保存，账号进程尚未确认')
  else if (res.data?.stopped)
    toast.success(`${okText}（账号未运行，启动后生效）`)
  else
    toast.success(okText)
}

async function saveAlt(okText = '大号/小号设置已保存') {
  if (alt.value.enabled && !(alt.value.masterGid > 0)) {
    toast.error('开启「这是小号」时请先选择大号')
    return
  }
  altSaving.value = true
  try {
    const res = await api.post('/api/fnos/alt-account', alt.value, { headers: headers() })
    if (res.data?.data)
      alt.value = { ...alt.value, ...res.data.data, holdForMaster: res.data.data?.holdForMaster !== false }
    reportSave(res, okText)
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    altSaving.value = false
  }
}

async function saveTea() {
  teaSaving.value = true
  try {
    // [fnos-fork] 旧字段 priorityGid/priorityName 同步为列表第一位（降级兼容）
    const first = tea.value.priorityFriends[0]
    const payload = { ...tea.value, priorityGid: first?.gid || 0, priorityName: first?.name || '' }
    const res = await api.post('/api/fnos/milk-tea-auto-hire', payload, { headers: headers() })
    if (res.data?.data)
      tea.value = { ...tea.value, ...res.data.data, priorityFriends: fnosPriorityFriendsFromConfig(res.data.data) }
    teaMigratedFromAlt.value = false
    reportSave(res, '奶茶雇佣与工作事项设置已保存')
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    teaSaving.value = false
  }
}

async function saveDaily() {
  dailySaving.value = true
  try {
    const res = await api.post('/api/fnos/milk-tea-daily', daily.value, { headers: headers() })
    if (res.data?.data)
      daily.value = fnosNormalizeMilkTeaDaily(res.data.data)
    reportSave(res, '奶茶收益与兑换设置已保存')
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    dailySaving.value = false
  }
}

async function saveExtra() {
  extraSaving.value = true
  try {
    const res = await api.post('/api/fnos/milk-tea-extra', extra.value, { headers: headers() })
    if (res.data?.data)
      extra.value = fnosNormalizeMilkTeaExtra(res.data.data)
    reportSave(res, '奶茶制作与工资设置已保存')
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    extraSaving.value = false
  }
}

async function saveIllustrated() {
  illustratedSaving.value = true
  try {
    const res = await api.post('/api/fnos/illustrated-auto', illustrated.value, { headers: headers() })
    if (res.data?.data)
      illustrated.value = fnosNormalizeIllustratedAuto(res.data.data)
    reportSave(res, '图鉴设置已保存')
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    illustratedSaving.value = false
  }
}

watch(() => props.accountId, () => {
  friends.value = []
  friendsError.value = ''
  manualGid.value = ''
  priorityManualGid.value = ''
  load()
}, { immediate: true })

// 手机宽度下设置页标签栏需要横向滚动，进入本栏目时把当前标签滚到可见处
onMounted(() => {
  nextTick(() => {
    const tab = document.querySelector<HTMLElement>('.settings-page .n-tabs-tab--active')
    const scroller = tab?.closest<HTMLElement>('.n-tabs-nav-scroll-content')?.parentElement
    if (tab && scroller && scroller.scrollWidth > scroller.clientWidth)
      scroller.scrollLeft = Math.max(0, tab.offsetLeft - (scroller.clientWidth - tab.offsetWidth) / 2)
  })
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="flex items-center gap-2 text-lg text-gray-900 font-bold dark:text-gray-100">
        <span :class="isCoop ? 'i-carbon-user-multiple' : 'i-carbon-event'" class="text-lg" />
        {{ isCoop ? '大小号协作' : '活动设置' }}
        <span v-if="accountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
          ({{ accountName }})
        </span>
      </h3>
    </div>

    <div v-if="!accountId" class="py-8 text-center text-gray-500">
      <div class="i-carbon-settings mx-auto mb-2 text-3xl text-gray-400" />
      <p>请先选择账号</p>
    </div>

    <div v-else class="fnos-fork-layout">
      <!-- 大号/小号（大小号协作栏目） -->
      <section v-if="isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-alt-account">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
            <span class="i-carbon-user-multiple text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              大号/小号
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              标记本账号是大号的小号。可选「成熟作物先留给大号偷」：检测到大号偷过这块地，自动巡田才收获；手动点「收获」「一键全收」不受限制。
            </p>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <div class="fnos-setting-item">
            <BaseSwitch v-model="alt.enabled" label="这是小号" />
          </div>

          <template v-if="alt.enabled">
            <div class="fnos-field-row">
              <div class="min-w-0 flex-1">
                <BaseSelect
                  v-model="masterGidModel"
                  label="大号（从本账号的好友中选择）"
                  :options="friendOptions"
                  filterable
                  :placeholder="friendsLoading ? '正在读取好友列表...' : '请选择大号'"
                />
              </div>
              <BaseButton class="shrink-0" variant="secondary" size="md" :loading="friendsLoading" @click="loadFriends(true)">
                刷新好友
              </BaseButton>
            </div>
            <p v-if="friendsError" class="fnos-hint text-amber-700 dark:text-amber-300">
              {{ friendsError }}
            </p>
            <div v-if="friendsError || !friendOptions.length" class="fnos-field-row">
              <div class="min-w-0 flex-1">
                <BaseInput v-model="manualGid" label="或手动输入大号 GID" placeholder="例如 4300123456" />
              </div>
              <BaseButton class="shrink-0" variant="secondary" size="md" @click="applyManualGid">
                使用
              </BaseButton>
            </div>
            <!-- [fnos-fork] 成熟作物先留给大号偷：开关（关闭时小号正常收获，超时不生效） -->
            <div class="fnos-setting-item" data-testid="fnos-alt-hold-for-master">
              <BaseSwitch v-model="alt.holdForMaster" label="成熟作物先留给大号偷" />
            </div>
            <template v-if="alt.holdForMaster">
              <BaseInput
                v-model="timeoutModel"
                type="number"
                :min="0"
                :max="10080"
                label="超时后仍收获（分钟，从发现可收时算起，0 = 一直等大号）"
              />
              <p class="fnos-hint text-gray-500 dark:text-gray-400">
                判定依据：土地数据里的偷菜者列表，或访客记录里大号的「偷取作物」（不早于成熟时间）。还没被大号偷的地会在日志「小号」里写明原因；保存后日志会打印「小号模式已启用…」确认已生效。非小号账号不受影响。
              </p>
            </template>
            <p v-else class="fnos-hint text-gray-500 dark:text-gray-400">
              已关闭：小号像普通账号一样正常收获自己的地。「不偷大号的菜」「只给大号放捣乱」不受影响。
            </p>
          </template>

          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="altSaving" @click="saveAlt()">
              保存大号/小号
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- 小号照顾大号（2026.10.21.3，大小号协作栏目） -->
      <section v-if="isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-alt-coop">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-900/25 dark:text-sky-400">
            <span class="i-carbon-partnership text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              小号照顾大号
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              只对「这是小号」且已选大号的账号生效，作用于自动好友巡查（需要打开「自动控制」里的好友巡查）。面板里的手动操作不受影响。
            </p>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <p v-if="!alt.enabled || !(alt.masterGid > 0)" class="fnos-hint fnos-hint--box bg-gray-50 text-gray-600 dark:bg-gray-800/40 dark:text-gray-300">
            先在左边打开「这是小号」并选择大号，下面的选项才会生效。
          </p>
          <div class="fnos-setting-item">
            <BaseSwitch v-model="alt.skipStealMaster" label="不偷大号的菜" />
          </div>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            自动巡查好友时跳过偷大号，帮忙、捣乱照常（受下一项影响）。
          </p>
          <div class="fnos-setting-item">
            <BaseSwitch v-model="alt.badOnlyMaster" label="只给大号放捣乱" />
          </div>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            放草、放虫只对大号做，不再对其他好友做；即使「自动控制」里的「自动捣乱」关着也会对大号放（每块未成熟的地最多 1 草 1 虫，用的是每日捣乱次数，约 10 分钟最多专门进一次大号农场）。
            打开后帮大号时只帮「只缺水」的地，有草/虫的地不帮，留给大号自己清。
          </p>
          <p class="fnos-hint fnos-hint--box bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            ⚠️ 大号账号的「自动控制」里不要打开「巡田时跳过一键务农」，草/虫才会被及时清掉。游戏数据里没有找到「主人清除自家草/虫能得经验」的依据，请按实际效果决定是否开启。
          </p>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            想让大号拿奶茶工资：在「活动设置 → 奶茶活动自动雇佣」里把大号设为优先雇佣人。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="altSaving" @click="saveAlt('小号照顾大号设置已保存')">
              保存
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- 奶茶活动自动雇佣 -->
      <section v-if="!isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-milk-tea-auto-hire">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-pink-50 text-pink-600 dark:bg-pink-900/25 dark:text-pink-400">
            <span class="i-carbon-cafe text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              奶茶活动自动雇佣
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              员工位空出（到期）时自动雇人，可按顺序指定多个优先雇佣人，约每 10 分钟检查一次（员工下班后约 1 分钟内补雇）；任何账号都可开启；本账号被别人雇佣时还可以自动做工作事项。
            </p>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <div class="fnos-setting-item">
            <BaseSwitch v-model="tea.enabled" label="自动雇佣" />
          </div>
          <template v-if="tea.enabled">
            <p v-if="teaMigratedFromAlt" class="fnos-hint fnos-hint--box bg-blue-50 text-blue-700 dark:bg-blue-900/25 dark:text-blue-300">
              已沿用旧版小号设置：优先雇佣人为大号，时长按下方「雇佣时长」。点「保存」后按本卡片的设置执行，不再参考大号/小号。
            </p>
            <div class="fnos-field-row fnos-field-row--top">
              <div class="min-w-0 flex-1">
                <FnosPriorityFriendPicker ref="priorityPicker" v-model="tea.priorityFriends" :friends="friends" :loading="friendsLoading" />
              </div>
              <BaseButton class="shrink-0" variant="secondary" size="md" :loading="friendsLoading" @click="loadFriends(true)">
                刷新好友
              </BaseButton>
            </div>
            <p v-if="friendsError" class="fnos-hint text-amber-700 dark:text-amber-300">
              {{ friendsError }}
            </p>
            <div v-if="friendsError || !friends.length" class="fnos-field-row">
              <div class="min-w-0 flex-1">
                <BaseInput v-model="priorityManualGid" label="或手动输入 GID 添加优先雇佣人" placeholder="例如 4300123456" />
              </div>
              <BaseButton class="shrink-0" variant="secondary" size="md" @click="applyPriorityManualGid">
                添加
              </BaseButton>
            </div>
            <p class="fnos-hint text-gray-500 dark:text-gray-400">
              按顺序优先雇佣，都不空闲时随机雇其他好友：有空员工位时，按列表顺序把当前空闲的优先雇佣人依次雇进来（不受职业限制）；列表里的人都已被雇、冷却中、已在本店上班或未指定时，从可雇佣好友里随机雇其他人。雇谁都按同一个「雇佣时长」。
            </p>
            <div class="fnos-select-grid">
              <BaseSelect v-model="durationModel" label="雇佣时长" :options="durationSelectOptions" />
              <BaseSelect v-model="talentModel" label="职业（员工特长）" :options="talentSelectOptions" />
            </div>
            <div class="fnos-setting-item">
              <BaseSwitch v-model="tea.allowRobots" label="好友都不可雇时雇系统员工" />
            </div>
          </template>
          <div class="fnos-setting-item">
            <BaseSwitch v-model="tea.autoWork" label="雇佣后自动做工作事项（本账号被雇佣时）" />
          </div>
          <template v-if="tea.autoWork">
            <BaseSelect v-model="workModel" label="工作事项" :options="workSelectOptions" />
            <p class="fnos-hint text-gray-500 dark:text-gray-400">
              {{ workDescription || '每个兼职班次自动选一项工作事项为老板提交（每班次 1 次），约每 10 分钟检查一次。' }}
              工作事项由<strong>被雇佣的账号</strong>完成：例如小号雇了大号，要在<strong>大号</strong>的这个栏目里打开本开关。不影响「自动雇佣」开关。
            </p>
            <p v-if="tea.workType === 4 || tea.workType === 5" class="fnos-hint fnos-hint--box bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">
              ⚠️ 该事项有概率让本班工资减半。
            </p>
          </template>
          <p class="fnos-hint fnos-hint--box bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            ⚠️ 雇佣会消耗奶茶券：4 小时 40、12 小时 130、24 小时 270（以游戏当时返回的价格为准）。奶茶券不足、活动结算期或剩余营业时间不足时自动跳过。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="teaSaving" @click="saveTea">
              保存奶茶雇佣与工作事项
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- 奶茶收益与兑换（2026.10.21） -->
      <section v-if="!isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-milk-tea-daily">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-900/25 dark:text-emerald-400">
            <span class="i-carbon-gift text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              奶茶收益与兑换
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              账号运行时自动领取奶茶店收益、每天兑换一次兑换商店里勾选的森野种子（按最大数量）。保存后约 5 秒先执行一次。
            </p>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <div class="fnos-setting-item">
            <BaseSwitch v-model="daily.autoClaim" label="奶茶收益每小时自动领取" />
          </div>
          <div class="fnos-setting-item">
            <BaseSwitch v-model="daily.autoExchangeSeed" label="森野种子自动兑换（按最大数量）" />
          </div>
          <!-- [fnos-fork] 需求 27：8 种森野种子，勾选的按列表顺序兑换；按住手柄拖动或用上下按钮排序 -->
          <div v-if="daily.autoExchangeSeed" class="flex flex-col gap-1.5 border border-gray-100 rounded-lg p-2 dark:border-gray-700/60" data-testid="fnos-seed-exchange-list">
            <p class="text-xs text-gray-500 dark:text-gray-400">
              勾选要兑换的种子；货币不够全部换满时按从上到下的顺序兑换（按住 ⠿ 拖动或用上下箭头调整顺序）。
            </p>
            <FnosSortableList
              v-slot="sort"
              class="flex flex-col gap-1.5"
              :item-count="daily.seedExchange.length"
              @move="moveSeed"
            >
              <div
                v-for="(item, index) in daily.seedExchange"
                :key="item.id"
                :data-fnos-sort-index="index"
                class="relative flex items-center gap-2 border border-emerald-200 rounded-lg bg-emerald-50/50 px-2 py-1 dark:border-emerald-800/50 dark:bg-emerald-900/15"
                :class="{ 'opacity-60 ring-2 ring-emerald-400': sort.draggingIndex === index }"
              >
                <div
                  v-if="seedIndicatorStyle(sort.indicatorFor(index))"
                  class="pointer-events-none absolute z-10 rounded-full bg-emerald-500"
                  :style="seedIndicatorStyle(sort.indicatorFor(index)) || undefined"
                />
                <span class="h-6 min-w-6 flex shrink-0 items-center justify-center rounded-full bg-emerald-500 px-1 text-xs text-white font-bold">
                  {{ index + 1 }}
                </span>
                <label class="min-w-0 flex flex-1 cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
                  <input v-model="item.enabled" type="checkbox" class="h-4 w-4 accent-emerald-600" :data-testid="`fnos-seed-${item.id}`">
                  <span class="truncate">{{ fnosSeedName(item.id) }}</span>
                </label>
                <div
                  class="h-9 w-7 flex shrink-0 cursor-grab touch-none select-none items-center justify-center rounded text-lg text-emerald-500 active:cursor-grabbing hover:bg-emerald-100 dark:hover:bg-gray-700"
                  title="按住拖动排序"
                  aria-label="按住拖动排序"
                  role="button"
                  @pointerdown="sort.startDrag(index, $event)"
                  @dragstart.prevent
                  @contextmenu.prevent
                >
                  <span class="i-carbon-draggable" />
                </div>
                <button
                  type="button"
                  class="h-9 w-8 flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-emerald-100 dark:text-gray-300 disabled:opacity-30 dark:hover:bg-gray-700"
                  :disabled="index === 0"
                  title="上移"
                  aria-label="上移"
                  @click="moveSeed(index, index - 1)"
                >
                  <span class="i-carbon-chevron-up" />
                </button>
                <button
                  type="button"
                  class="h-9 w-8 flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-emerald-100 dark:text-gray-300 disabled:opacity-30 dark:hover:bg-gray-700"
                  :disabled="index === daily.seedExchange.length - 1"
                  title="下移"
                  aria-label="下移"
                  @click="moveSeed(index, index + 1)"
                >
                  <span class="i-carbon-chevron-down" />
                </button>
              </div>
            </FnosSortableList>
          </div>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            {{ seedHint }}
          </p>
          <p class="fnos-hint fnos-hint--box bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            ⚠️ 兑换会消耗兑换商店的货币（价格和币种以游戏当时为准）。每种勾选的种子都按最大数量兑换：受剩余限购、当前货币和背包持有上限 9999 限制；没有限购的种子会用掉当时所有能用的该种货币。今日已兑换、已售罄、货币不足或结算期时写日志跳过，当天不再重试。结果在日志「奶茶收益」「奶茶兑换」里查看。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="dailySaving" @click="saveDaily">
              保存奶茶收益与兑换
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- [fnos-fork] 奶茶制作与工资（2026-10-28） -->
      <section v-if="!isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-milk-tea-extra">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-pink-50 text-pink-600 dark:bg-pink-900/25 dark:text-pink-400">
            <span class="i-carbon-cafe text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              奶茶制作与工资
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              账号运行时约每 10 分钟检查一次：把背包里的森野果实做成奶茶、领取打工工资、升级店铺。保存后约 8 秒先执行一次。
            </p>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <div class="fnos-setting-item">
            <BaseSwitch v-model="extra.autoCraft" label="自动制作奶茶" />
          </div>
          <div v-if="extra.autoCraft" class="fnos-setting-item">
            <BaseSwitch v-model="extra.craftGoldenCheese" label="也制作金露云酪（消耗森野黄金芽）" />
          </div>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            {{ craftHint }}只做店铺已解锁的配方；背包里锁定的果实不会动；结算期不制作。
          </p>
          <div class="fnos-setting-item">
            <BaseSwitch v-model="extra.autoClaimWages" label="自动领取工资（被雇佣打工的工资）" />
          </div>
          <!-- [fnos-fork] 需求 27 店铺自动升级 -->
          <div class="fnos-setting-item">
            <BaseSwitch v-model="extra.autoUpgradeShop" label="店铺自动升级" />
          </div>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            自己的奶茶店营业额达到下一级要求（游戏显示「可升级」）时自动升级并领取升级奖励，一次可连升多级；条件不够时约 30 分钟再看一次，满级后不再升级。需要本账号的奶茶店已开业。结果在日志「奶茶升级」里查看。
          </p>
          <p class="fnos-hint fnos-hint--box bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            ⚠️ 制作会把对应果实整组用掉（不再能卖金币）。工资需要本账号的奶茶店已开业才能领取（游戏限制）。结果在日志「奶茶制作」「奶茶工资」里查看。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="extraSaving" @click="saveExtra">
              保存奶茶制作与工资
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- [fnos-fork] 图鉴（2026-10-28） -->
      <section v-if="!isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-illustrated-auto">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-900/25 dark:text-sky-400">
            <span class="i-carbon-notebook text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              图鉴
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              账号运行时约每 10 分钟检查一次作物图鉴和变异图鉴。保存后约 12 秒先执行一次。
            </p>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <div class="fnos-setting-item">
            <BaseSwitch v-model="illustrated.autoClaimRewards" label="图鉴奖励自动领取" />
          </div>
          <div class="fnos-setting-item">
            <BaseSwitch v-model="illustrated.autoComplete" label="自动完成图鉴" />
          </div>
          <p class="fnos-hint fnos-hint--box bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            ⚠️ 自动完成图鉴会花金币：找出作物图鉴里未收藏、背包里没有种子、地里也没种着的作物，从种子商店买 1 个种子（只买已解锁、等级够、不需要解锁卡、未售罄且金币够的），每次检查最多买 1 个、同时最多 2 个待种；下次自动播种时先把它种下，种下或收藏后恢复原来的播种顺序。需要打开「自动控制」里的自动种植。结果在日志「图鉴」里查看。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="illustratedSaving" @click="saveIllustrated">
              保存图鉴设置
            </BaseButton>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 与上游「自动控制」卡片一致：≥1280px 两列并排、等高，保存按钮贴底；更窄时上下排列 */
.fnos-fork-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
}

@media (min-width: 1280px) {
  .fnos-fork-layout {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: stretch;
  }
}

.fnos-fork-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.fnos-fork-card__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.75rem;
}

.fnos-fork-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
}

/* 开关行沿用上游 automation-setting-item 的外观 */
.fnos-setting-item {
  display: flex;
  min-height: 42px;
  align-items: center;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}

.fnos-field-row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

/* [fnos-fork] 多个优先雇佣人：列表较高，「刷新好友」与标题对齐；窄屏时换到列表下方，列表占满宽度 */
.fnos-field-row--top {
  align-items: flex-start;
  flex-wrap: wrap;
}
.fnos-field-row--top > .min-w-0 {
  flex: 1 1 18rem;
}
.fnos-field-row--top > .shrink-0 {
  margin-top: 1.625rem;
}

/* 卡片单独占一行（<1280px）且够宽时，两个下拉框并排 */
.fnos-select-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75rem;
}

@media (min-width: 640px) and (max-width: 1279px) {
  .fnos-select-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.fnos-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.fnos-hint--box {
  padding: 8px 10px;
  border-radius: var(--ui-radius-control);
}
</style>
