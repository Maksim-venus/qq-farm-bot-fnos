<script setup lang="ts">
/**
 * [fnos-fork] 本 fork 新增的按账号设置（上游没有）：
 * - 大号/小号：小号成熟作物留给大号偷，大号偷过才自动收获
 * - 奶茶活动自动雇佣：时长/职业可选或随机；小号优先雇大号 24 小时
 * 接口见 core/src/controllers/admin/fnos-fork-routes.ts；请求经 Axios baseURL，自动带飞牛网关前缀。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{ accountId?: string | null, accountName?: string | null }>()
const toast = useToastStore()

interface AltAccount { enabled: boolean, masterGid: number, masterName: string, timeoutMinutes: number }
interface MilkTeaAutoHire { enabled: boolean, durationId: number, talentId: number, allowRobots: boolean }
interface FriendItem { gid: number | string, name?: string }

const alt = ref<AltAccount>({ enabled: false, masterGid: 0, masterName: '', timeoutMinutes: 0 })
const tea = ref<MilkTeaAutoHire>({ enabled: false, durationId: 0, talentId: 0, allowRobots: false })
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

// 小号模式下「雇佣时长」不生效（大号 24 小时、其他好友 4 小时）
const altActive = computed(() => alt.value.enabled && alt.value.masterGid > 0)

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
    const [altRes, teaRes] = await Promise.all([
      api.get('/api/fnos/alt-account', { headers: headers() }),
      api.get('/api/fnos/milk-tea-auto-hire', { headers: headers() }),
    ])
    if (altRes.data?.ok)
      alt.value = { ...alt.value, ...altRes.data.data }
    if (teaRes.data?.ok) {
      tea.value = { ...tea.value, ...teaRes.data.data }
      durationOptions.value = teaRes.data.options?.durations || []
      talentOptions.value = teaRes.data.options?.talents || []
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '读取大号/小号、奶茶雇佣设置失败'))
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

async function saveAlt() {
  if (alt.value.enabled && !(alt.value.masterGid > 0)) {
    toast.error('开启「这是小号」时请先选择大号')
    return
  }
  altSaving.value = true
  try {
    const res = await api.post('/api/fnos/alt-account', alt.value, { headers: headers() })
    if (res.data?.data)
      alt.value = { ...alt.value, ...res.data.data }
    reportSave(res, '大号/小号设置已保存')
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
    const res = await api.post('/api/fnos/milk-tea-auto-hire', tea.value, { headers: headers() })
    if (res.data?.data)
      tea.value = { ...tea.value, ...res.data.data }
    reportSave(res, '奶茶自动雇佣设置已保存')
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    teaSaving.value = false
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
        <span class="i-carbon-user-multiple text-lg" />
        大小号与雇佣
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
      <!-- 大号/小号 -->
      <section class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-alt-account">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
            <span class="i-carbon-user-multiple text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              大号/小号
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              小号的成熟作物先留给大号偷；检测到大号偷过这块地，自动巡田才收获。手动点「收获」「一键全收」不受限制。
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
            <BaseInput
              v-model="timeoutModel"
              type="number"
              :min="0"
              :max="10080"
              label="超时后仍收获（分钟，0 = 一直等大号）"
            />
            <p class="fnos-hint text-gray-500 dark:text-gray-400">
              判定依据：土地数据里的偷菜者列表，或访客记录里大号的「偷取作物」（不早于成熟时间）。还没被大号偷的地会在日志「小号」里写明原因。非小号账号不受影响。
            </p>
          </template>

          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="altSaving" @click="saveAlt">
              保存大号/小号
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- 奶茶活动自动雇佣 -->
      <section class="fnos-fork-card farm-card rounded-2xl p-4" data-testid="fnos-milk-tea-auto-hire">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-pink-50 text-pink-600 dark:bg-pink-900/25 dark:text-pink-400">
            <span class="i-carbon-cafe text-xl" />
          </div>
          <div class="min-w-0">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              奶茶活动自动雇佣
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
              员工位空出（到期）时自动从可雇佣好友里雇人，约每 5 分钟检查一次。
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
            <p v-if="altActive" class="fnos-hint fnos-hint--box bg-blue-50 text-blue-700 dark:bg-blue-900/25 dark:text-blue-300">
              当前是小号：大号空闲时优先雇大号 24 小时（不受职业限制）；大号已被雇时随机雇其他好友 4 小时，「雇佣时长」不生效。
            </p>
            <div class="fnos-select-grid">
              <BaseSelect
                v-model="durationModel"
                :label="altActive ? '雇佣时长（小号模式不生效）' : '雇佣时长'"
                :options="durationSelectOptions"
                :disabled="altActive"
              />
              <BaseSelect v-model="talentModel" label="职业（员工特长）" :options="talentSelectOptions" />
            </div>
            <div class="fnos-setting-item">
              <BaseSwitch v-model="tea.allowRobots" label="好友都不可雇时雇系统员工" />
            </div>
          </template>
          <p class="fnos-hint fnos-hint--box bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            ⚠️ 雇佣会消耗奶茶券：4 小时 40、12 小时 130、24 小时 270（以游戏当时返回的价格为准）。奶茶券不足、活动结算期或剩余营业时间不足时自动跳过。
          </p>
          <div class="fnos-fork-card__footer">
            <BaseButton variant="primary" size="sm" :loading="teaSaving" @click="saveTea">
              保存奶茶雇佣
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
