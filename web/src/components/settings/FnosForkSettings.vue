<script setup lang="ts">
/**
 * [fnos-fork] 本 fork 新增的按账号设置（上游没有）：
 * - 大号/小号：小号成熟作物留给大号偷，大号偷过才自动收获
 * - 2026-11-15：奶茶 fork 功能（自动雇佣/工作事项/收益/种子兑换/制作/工资/店铺升级）按用户要求下架；
 *   图鉴奖励领取 / 自动完成图鉴移到「自动控制」（AutomationSettingsForm），随自动控制一起保存。
 * 所在栏目：
 * - section="coop"：设置 → 大小号协作（大号/小号、不偷大号、只给大号放捣乱、在线期间来偷菜自动删除）
 * - section="activity"：设置 → 活动设置（2026-11-17 起说明上游「牧歌初启」活动和牧场每日福利的位置）
 * 接口见 core/src/controllers/admin/fnos-fork-routes.ts；请求经 Axios baseURL，自动带飞牛网关前缀。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { fnosNormalizeStealRatio } from '@/utils/fnos-steal-ratio' // [fnos-fork] 在线期间来偷菜的自动删除
import { gatewayPath } from '@/utils/gateway' // [fnos-fork]

const props = defineProps<{ accountId?: string | null, accountName?: string | null, section?: 'coop' | 'activity' }>()
const isCoop = computed(() => props.section === 'coop')
const toast = useToastStore()

interface AltAccount { enabled: boolean, masterGid: number, masterName: string, holdForMaster: boolean, timeoutMinutes: number, skipStealMaster: boolean, badOnlyMaster: boolean }
interface FriendItem { gid: number | string, name?: string }

// [fnos-fork] holdForMaster「成熟作物先留给大号偷」缺省为 true（旧配置没有该字段时保持原有行为）
const alt = ref<AltAccount>({ enabled: false, masterGid: 0, masterName: '', holdForMaster: true, timeoutMinutes: 0, skipStealMaster: false, badOnlyMaster: false })
// [fnos-fork] 在线期间来偷菜自动删除，默认关
const stealRatio = ref(fnosNormalizeStealRatio(null))
const stealSaving = ref(false)
const friends = ref<FriendItem[]>([])
const friendsError = ref('')
const loading = ref(false)
const friendsLoading = ref(false)
const altSaving = ref(false)
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
  // [fnos-fork] 活动设置栏目目前只是占位，不读取任何接口
  if (!props.accountId || !isCoop.value)
    return
  loading.value = true
  try {
    const [altRes, stealRes] = await Promise.all([
      api.get('/api/fnos/alt-account', { headers: headers() }),
      api.get('/api/fnos/steal-ratio', { headers: headers() }),
    ])
    if (stealRes.data?.ok)
      stealRatio.value = fnosNormalizeStealRatio(stealRes.data.data)
    if (altRes.data?.ok)
      alt.value = { ...alt.value, ...altRes.data.data, holdForMaster: altRes.data.data?.holdForMaster !== false }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '读取大小号协作设置失败'))
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

async function saveStealRatio() {
  stealSaving.value = true
  try {
    const res = await api.post('/api/fnos/steal-ratio', stealRatio.value, { headers: headers() })
    if (res.data?.data)
      stealRatio.value = fnosNormalizeStealRatio(res.data.data)
    reportSave(res, '设置已保存')
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    stealSaving.value = false
  }
}

watch(() => props.accountId, () => {
  friends.value = []
  friendsError.value = ''
  manualGid.value = ''
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

    <!-- [fnos-fork] 2026-11-17 上游 PR #142 接入「牧歌初启」：活动本身在上游的「活动」页操作（没有自动项），这里只做说明，去掉原「当前没有进行中的活动」占位 -->
    <div v-if="!isCoop" class="farm-card rounded-2xl p-4 text-sm text-gray-600 leading-relaxed space-y-2 dark:text-gray-300" data-testid="fnos-activity-current">
      <div class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
        <img :src="gatewayPath('/activity-assets/muge/icon.png')" alt="" width="24" height="24" class="h-6 w-6 rounded">
        牧歌初启（牧场活动）
      </div>
      <p>庆典、好友、图鉴、牧场人格四个玩法都在「牧场 → 活动 → 牧歌初启」里手动操作，活动本身没有自动领取项。</p>
      <p>同期上游新增的「每日商城福利」是牧场自动项，开关在「牧场 → 策略 → 日常牧场」；它和任务、分享、图鉴一样算杂项，只在没有收获 / 偷菜 / 帮忙到点时才做。</p>
    </div>

    <div v-else-if="!accountId" class="py-8 text-center text-gray-500">
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
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="altSaving" @click="saveAlt('小号照顾大号设置已保存')">
              保存
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- [fnos-fork] 在线期间来偷菜的自动删除 -->
      <section v-if="isCoop" class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-steal-ratio">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-orange-50 text-orange-600 dark:bg-orange-900/25 dark:text-orange-400">
            <span class="i-carbon-chart-relationship text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              在线期间来偷菜
            </h4>
          </div>
        </div>

        <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
          <span class="i-carbon-circle-dash mr-1 inline-block animate-spin align-middle" />加载中...
        </div>
        <div v-else class="fnos-fork-card__body">
          <div class="fnos-setting-item">
            <BaseSwitch v-model="stealRatio.autoDeleteOnlineStealer" label="在线期间来偷菜的自动删除" />
          </div>
          <p class="fnos-hint text-gray-500 dark:text-gray-400">
            只删上线之后新来偷菜的人，默认关，不删大号和小号。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="stealSaving" @click="saveStealRatio">
              保存
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
