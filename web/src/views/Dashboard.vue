<script setup lang="ts">
import type { OverviewSnapshot } from '@/utils/fnos-overview'
import { useIntervalFn, useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import LevelForecast from '@/components/LevelForecast.vue'
import { RANCH_IMAGE, useRanchLoader, useRanchUnmountReset } from '@/components/ranch/ranch-shared'
import RunLogCard from '@/components/RunLogCard.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { getPlatformLabel, useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { buildFarmSnapshot, buildRanchSnapshot, formatUpdatedAt, shouldPersist, snapshotHash } from '@/utils/fnos-overview'

// [fnos-fork] 2026-11-23 首页合并概览：农场、牧场放在同一个首页（农场、牧场两个空间的「概览」都是这一页）。
// 当前所在空间读实时数据；另一边读服务端缓存的快照（/api/fnos/overview-cache），不额外实时查游戏。
const route = useRoute()
const inRanch = computed(() => route.meta.gameSpace === 'ranch')
const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const ranchStore = useRanchStore()
const {
  status,
  diamondBalance,
  realtimeConnected,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { state: ranchState, loading: ranchLoading, error: ranchError } = storeToRefs(ranchStore)
const isOnline = computed(() => !!currentAccount.value?.running && status.value?.connection?.connected === true)
const { dashboardItems } = storeToRefs(bagStore)
const lastBagFetchAt = ref(0)
const now = useNow({ interval: 1000 })

if (inRanch.value) {
  useRanchLoader('overview')
  useRanchUnmountReset()
}
function refreshRanch() {
  if (currentAccountId.value)
    void ranchStore.load(String(currentAccountId.value), 'overview')
}

const displayName = computed(() => {
  const account = accountStore.currentAccount
  const gameName = status.value?.status?.name
  if (gameName) {
    if (account?.name && account.name !== gameName)
      return `${gameName} (${account.name})`
    return gameName
  }
  if (!status.value?.connection?.connected) {
    if (account) {
      if (account.name && account.nick && account.name !== account.nick)
        return `${account.nick} (${account.name})`
      return account.name || account.nick || '未登录'
    }
    return '未登录'
  }
  if (account) {
    if (account.name && account.nick && account.name !== account.nick)
      return `${account.nick} (${account.name})`
    return account.name || account.nick || '未命名'
  }
  return '未命名'
})

// ---- 概览快照：当前空间实时，另一边缓存 ----
const cache = ref<{ farm: OverviewSnapshot | null, ranch: OverviewSnapshot | null }>({ farm: null, ranch: null })
const statusIsCurrent = computed(() => String(status.value?.accountId || '') === String(currentAccountId.value || ''))
const farmLive = computed(() => !inRanch.value && statusIsCurrent.value && !!status.value?.connection?.connected)
const farmSnap = computed<OverviewSnapshot | null>(() => farmLive.value
  ? buildFarmSnapshot({ status: status.value, items: dashboardItems.value, diamond: diamondBalance.value, now: now.value.getTime() })
  : cache.value.farm)
const ranchLive = computed(() => inRanch.value && !!ranchState.value)
const ranchSnap = computed<OverviewSnapshot | null>(() => ranchLive.value
  ? buildRanchSnapshot({
      state: ranchState.value,
      ranchOperations: statusIsCurrent.value ? status.value?.ranchOperations : null,
      ranchRemainSec: statusIsCurrent.value ? status.value?.nextChecks?.ranchRemainSec : null,
      imageOf: RANCH_IMAGE,
      now: now.value.getTime(),
    })
  : cache.value.ranch)

async function loadCache() {
  const id = String(currentAccountId.value || '')
  cache.value = { farm: null, ranch: null }
  if (!id)
    return
  try {
    const { data } = await api.get('/api/fnos/overview-cache', { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
    if (data?.ok && String(currentAccountId.value || '') === id)
      cache.value = { farm: data.data?.farm || null, ranch: data.data?.ranch || null }
  }
  catch {
    // 缓存读不到就当作没有，对应区块显示「暂无缓存」
  }
}

const lastSaved: Record<string, { at: number, hash: string }> = {}
async function persist(space: 'farm' | 'ranch', snapshot: OverviewSnapshot | null, intervalMs: number) {
  const id = String(currentAccountId.value || '')
  if (!id || !snapshot)
    return
  const key = `${id}:${space}`
  const hash = snapshotHash(snapshot)
  if (!shouldPersist(lastSaved[key], hash, Date.now(), intervalMs))
    return
  lastSaved[key] = { at: Date.now(), hash }
  try {
    await api.put(`/api/fnos/overview-cache/${space}`, snapshot, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
  }
  catch {
    delete lastSaved[key]
  }
}
// 读到数据就回写（节流）：农场每次状态 / 背包 / 钻石变化，牧场每次读取牧场数据
watch(farmSnap, snap => farmLive.value && snap?.level ? persist('farm', snap, 30_000) : undefined)
watch(ranchSnap, snap => ranchLive.value && snap?.level ? persist('ranch', snap, 15_000) : undefined)

const farmStamp = computed(() => farmLive.value ? { live: true, text: '实时' } : { live: false, text: cache.value.farm?.updatedAt ? `缓存 · ${formatUpdatedAt(cache.value.farm.updatedAt, now.value.getTime())}更新` : '暂无缓存' })
const ranchStamp = computed(() => ranchLive.value ? { live: true, text: '实时' } : { live: false, text: cache.value.ranch?.updatedAt ? `缓存 · ${formatUpdatedAt(cache.value.ranch.updatedAt, now.value.getTime())}更新` : '暂无缓存' })
const groups = computed(() => [
  { space: 'farm' as const, name: '农场', snap: farmSnap.value, stamp: farmStamp.value },
  { space: 'ranch' as const, name: '牧场', snap: ranchSnap.value, stamp: ranchStamp.value },
])
const ranchRevealed = computed(() => ranchSnap.value)

const FARM_ICONS: Record<string, string> = {
  gold: 'i-fas-coins text-yellow-500',
  coupon: 'i-fas-ticket-alt text-emerald-500',
  goldBean: 'i-fas-seedling text-amber-500',
  diamond: 'i-fas-gem text-cyan-500',
  1011: 'i-fas-flask text-emerald-500',
  1012: 'i-fas-vial text-emerald-500',
  3001: 'i-fas-bookmark text-violet-400',
  3002: 'i-fas-gem text-violet-400',
}
const TODO_ICONS: Record<string, string> = {
  harvest: 'i-carbon-wheat text-amber-500',
  produce: 'i-carbon-circle-dash text-green-500',
  feed: 'i-carbon-flash text-sky-500',
  clean: 'i-carbon-clean text-violet-400',
}
function expPercent(snap: OverviewSnapshot | null) {
  const needed = snap?.exp?.needed || 0
  return needed > 0 ? Math.min(100, Math.max(0, snap!.exp.current / needed * 100)) : 100
}
function expText(snap: OverviewSnapshot | null) {
  if (!snap)
    return '—'
  return `${snap.exp.current.toLocaleString('zh-CN')} / ${snap.exp.needed ? snap.exp.needed.toLocaleString('zh-CN') : snap.space === 'ranch' ? '—' : '?'}`
}

// ---- 下次巡查倒计时（农场 / 牧场分别调度，各自一行；非当前空间按缓存的绝对时间估算）----
function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return d > 0 ? `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
}
const countdowns = computed(() => groups.value.flatMap(({ snap, stamp, space }) => (snap?.nextChecks || []).map((c) => {
  let text: string
  const live = stamp.live
  if (live && space === 'farm' && !status.value?.connection?.connected)
    text = '账号未登录'
  else if (c.at === null)
    text = c.note || '—'
  else if (c.at <= now.value.getTime())
    text = live ? '巡查中...' : '待更新'
  else
    text = formatDuration((c.at - now.value.getTime()) / 1000)
  return { key: `${space}-${c.key}`, space, label: c.label, text, cached: !live, icon: c.key === 'friend' ? 'i-carbon-collaborate text-blue-500' : space === 'ranch' ? 'i-carbon-pedestrian-family text-amber-500' : 'i-carbon-sprout text-green-500' }
})))

const localUptime = ref(0)
useIntervalFn(() => {
  if (status.value?.connection?.connected)
    localUptime.value++
}, 1000)
watch(() => status.value?.uptime, (uptime) => {
  if (uptime !== undefined)
    localUptime.value = uptime
}, { immediate: true })

const expRate = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.sessionElapsedSeconds ?? status.value?.uptime ?? 0
  if (!uptime)
    return '0/时'
  const hours = uptime / 3600
  return `${Math.floor(hours > 0 ? gain / hours : 0)}/时`
})

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return d > 0 ? `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
}

const platformLabel = computed(() => getPlatformLabel(accountStore.currentAccount?.platform))
const accountAvatar = computed(() => {
  const account = accountStore.currentAccount
  if (!account)
    return ''
  const live = statusIsCurrent.value ? String(status.value?.status?.avatarUrl || '').trim() : ''
  return live || String(account.avatar || '').trim()
})
const failedAccountAvatar = ref('')
watch(accountAvatar, () => {
  failedAccountAvatar.value = ''
})
function handleAccountAvatarError(event: Event) {
  failedAccountAvatar.value = (event.currentTarget as HTMLImageElement | null)?.getAttribute('src') || ''
}

// 农场背包 / 钻石只在农场空间实时读取；牧场空间里农场一侧读缓存，不再查询。
async function refreshBag(force = false) {
  if (inRanch.value || !currentAccountId.value || !currentAccount.value?.running || !status.value?.connection?.connected)
    return
  const t = Date.now()
  if (!force && t - lastBagFetchAt.value < 2500)
    return
  lastBagFetchAt.value = t
  await bagStore.fetchBag(currentAccountId.value)
}
async function refreshDiamond() {
  if (inRanch.value || !currentAccountId.value || !currentAccount.value?.running || !status.value?.connection?.connected)
    return
  await statusStore.fetchDiamond(currentAccountId.value)
}
async function refresh() {
  if (currentAccountId.value) {
    if (!currentAccount.value)
      return
    if (!realtimeConnected.value)
      await statusStore.fetchStatus(currentAccountId.value)
    await refreshBag()
  }
}

watch(currentAccountId, async () => {
  diamondBalance.value = 0
  await loadCache()
  await refresh()
  await refreshDiamond()
})
watch(() => status.value?.connection?.connected, (connected) => {
  if (connected) {
    refreshBag(true)
    refreshDiamond()
  }
})
function operationsEqual(next: Record<string, unknown> | null | undefined, prev: Record<string, unknown> | null | undefined) {
  const a = next || {}
  const b = prev || {}
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}
watch(() => status.value?.operations, (next, prev) => {
  if (!realtimeConnected.value || operationsEqual(next, prev))
    return
  refreshBag()
})

onMounted(async () => {
  await loadCache()
  await refresh()
  await refreshDiamond()
})
useIntervalFn(refresh, 10000)
</script>

<template>
  <div class="page-stack flex flex-col gap-5">
    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后查看概览" icon="i-carbon-user-avatar" />
    <template v-else>
      <div class="overview-grid">
        <!-- 账号：身份、在线状态，农场 / 牧场等级与经验 -->
        <section class="ov-card ov-account">
          <div class="ov-account__head">
            <div class="ov-avatar" :class="{ 'is-online': isOnline }">
              <img v-if="accountAvatar && accountAvatar !== failedAccountAvatar" :key="accountAvatar" :src="accountAvatar" alt="" @error="handleAccountAvatarError">
              <span v-else class="i-carbon-user-avatar" />
              <i class="ov-avatar__dot" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="ov-account__name-row">
                <strong class="ov-account__name" :title="displayName">{{ displayName }}</strong>
                <span class="ov-level">农场 Lv.{{ farmSnap?.level || 0 }}</span>
                <span class="ov-level">牧场 Lv.{{ ranchSnap?.level || 0 }}</span>
              </div>
              <div class="ov-presence">
                <span class="ov-presence__state" :class="isOnline ? 'is-online' : 'is-offline'">{{ isOnline ? '在线' : '离线' }}</span>
                <span v-if="isOnline" class="ov-presence__item"><span class="i-carbon-time" />已运行 {{ formatUptime(localUptime) }}</span>
                <span v-if="platformLabel" class="ov-presence__item">{{ platformLabel }}</span>
              </div>
            </div>
            <button v-if="inRanch" type="button" class="ov-refresh" :disabled="ranchLoading" title="刷新牧场" aria-label="刷新牧场" @click="refreshRanch">
              <span class="i-carbon-renew" />
            </button>
          </div>

          <div v-for="g in groups" :key="g.space" class="ov-exp">
            <div class="ov-exp__labels">
              <span>{{ g.name }}经验 <small class="ov-stamp" :class="{ 'is-live': g.stamp.live }">{{ g.stamp.text }}</small></span>
              <span class="ov-exp__value">
                {{ expText(g.snap) }}
                <b>{{ g.snap ? Math.floor(expPercent(g.snap)) : 0 }}%</b>
              </span>
            </div>
            <div class="ov-exp__track">
              <div class="ov-exp__bar" :style="{ width: `${g.snap ? expPercent(g.snap) : 0}%` }" />
            </div>
          </div>

          <div v-if="farmLive" class="ov-account__foot">
            <span>本次经验/时 <b>{{ expRate }}</b></span>
            <LevelForecast v-if="isOnline" class="ov-forecast" :forecast="status?.levelForecast" />
          </div>
          <div v-if="ranchError && !ranchLive && inRanch" class="ov-account__foot">
            <span>牧场读取失败：{{ ranchError }}</span>
          </div>
        </section>

        <!-- 资产：农场 + 牧场 -->
        <section class="ov-card">
          <h3 class="ov-card__title">
            资产
          </h3>
          <div v-for="g in groups" :key="g.space" class="ov-group">
            <div class="ov-group__head">
              <span>{{ g.name }}</span><small class="ov-stamp" :class="{ 'is-live': g.stamp.live }">{{ g.stamp.text }}</small>
            </div>
            <div v-if="g.snap" class="ov-tiles">
              <div v-for="t in g.snap.assets" :key="t.key" class="ov-tile">
                <span class="ov-tile__label"><img v-if="t.image" class="ov-tile__img" :src="t.image" alt=""><span v-else :class="FARM_ICONS[String(t.key)]" />{{ t.label }}</span>
                <strong class="ov-tile__value" :title="t.value">{{ t.value }}</strong>
              </div>
            </div>
            <div v-else class="ov-stamp">
              暂无缓存，进入{{ g.name }}后自动记录
            </div>
          </div>
        </section>

        <!-- 库存：农场化肥 / 收藏点 + 牧场牧草 / 便便 / 罐头 -->
        <section class="ov-card">
          <h3 class="ov-card__title">
            库存
          </h3>
          <div v-for="g in groups" :key="g.space" class="ov-group">
            <div class="ov-group__head">
              <span>{{ g.name }}</span><small class="ov-stamp" :class="{ 'is-live': g.stamp.live }">{{ g.stamp.text }}</small>
            </div>
            <div v-if="g.snap" class="ov-tiles">
              <div v-for="t in g.snap.stock" :key="t.key" class="ov-tile">
                <span class="ov-tile__label"><img v-if="t.image" class="ov-tile__img" :src="t.image" alt=""><span v-else :class="FARM_ICONS[String(t.key)]" />{{ t.label }}</span>
                <strong class="ov-tile__value">{{ t.value }}</strong>
              </div>
            </div>
            <div v-else class="ov-stamp">
              暂无缓存，进入{{ g.name }}后自动记录
            </div>
          </div>
        </section>
      </div>

      <div v-if="ranchRevealed?.notice" class="ranch-alert" role="status">
        <span class="i-carbon-warning-alt" aria-hidden="true" />
        <span>{{ ranchRevealed.notice }}</span>
      </div>

      <div class="dash-split">
        <div class="dash-split__logs">
          <RunLogCard class="dash-log-card" />
        </div>

        <div class="dash-split__side">
          <!-- 下次巡查倒计时 -->
          <div class="flex flex-col farm-card rounded-2xl bg-white p-6 shadow-md dark:bg-gray-800">
            <h3 class="mb-4 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-time" /> <span>下次巡查倒计时</span>
            </h3>
            <div class="flex flex-col justify-center gap-4">
              <div v-for="c in countdowns" :key="c.key" class="flex items-center justify-between">
                <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                  <span class="text-lg" :class="c.icon" />
                  <span>{{ c.label }}</span>
                </div>
                <div class="text-lg tabular-nums font-bold" :class="{ 'opacity-60': c.cached }">
                  {{ c.text }}
                </div>
              </div>
            </div>
          </div>

          <!-- 今日统计 / 今日收益统计 -->
          <div class="farm-card rounded-2xl bg-white p-5 shadow-md dark:bg-gray-800">
            <h3 class="mb-3 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-chart-column" /> <span>今日收益统计</span>
            </h3>
            <div v-for="g in groups" :key="g.space" class="ov-group">
              <div class="ov-group__head">
                <span>{{ g.name }}</span><small class="ov-stamp" :class="{ 'is-live': g.stamp.live }">{{ g.stamp.text }}</small>
              </div>
              <EmptyState v-if="g.space === 'farm' && g.stamp.live && !status?.connection?.connected" bare title="账号未登录" description="启动账号后显示今日统计" icon="i-carbon-connection-signal-off" />
              <dl v-else-if="g.snap?.today?.length" class="grid grid-cols-2 gap-2">
                <div v-for="item in g.snap.today" :key="item.key" class="ranch-todo" :class="{ 'is-zero': !item.count }">
                  <dt class="text-xs text-gray-500 dark:text-gray-400">
                    {{ item.label }}
                  </dt>
                  <dd class="m-0 tabular-nums font-semibold">
                    {{ item.count }}
                  </dd>
                </div>
              </dl>
              <div v-else class="ov-stamp">
                {{ g.snap ? '暂无统计' : '暂无缓存' }}
              </div>
            </div>
          </div>

          <!-- 牧场生涯 -->
          <section v-if="ranchSnap?.career" class="ov-card">
            <h3 class="ov-card__title">
              牧场生涯 <small class="ov-stamp" :class="{ 'is-live': ranchStamp.live }">{{ ranchStamp.text }}</small>
            </h3>
            <CareerHarvestSteal :career="ranchSnap.career" variant="tiles" />
          </section>

          <!-- 待处理 -->
          <section v-if="ranchSnap?.todo?.length" class="farm-card rounded-2xl p-5">
            <header class="ranch-card-head">
              <h3 class="flex items-center gap-2 text-lg font-display font-medium">
                <span class="i-carbon-task" /> <span>牧场待处理</span>
              </h3>
              <small class="ov-stamp" :class="{ 'is-live': ranchStamp.live }">{{ ranchStamp.text }}</small>
            </header>
            <div class="grid grid-cols-2 gap-2 2xl:gap-3">
              <div v-for="item in ranchSnap.todo" :key="item.key" class="ranch-todo" :class="{ 'is-zero': !item.value }">
                <div class="flex items-center gap-2">
                  <span class="select-none text-base" :class="TODO_ICONS[item.key]" />
                  <span class="text-xs text-gray-500">{{ item.label }}</span>
                </div>
                <b>{{ item.value }}</b>
              </div>
            </div>
          </section>

          <!-- 设施 -->
          <section v-if="ranchSnap?.facilities?.length" class="farm-card rounded-2xl p-5">
            <header class="ranch-card-head">
              <h3 class="flex items-center gap-2 text-lg font-display font-medium">
                <span class="i-carbon-building" /> <span>牧场设施</span>
              </h3>
              <small class="ov-stamp" :class="{ 'is-live': ranchStamp.live }">{{ ranchStamp.text }}</small>
            </header>
            <div class="ranch-facilities">
              <div v-for="f in ranchSnap.facilities" :key="f.id" class="ranch-facility" :class="{ 'is-pending': f.pending }">
                <div class="ranch-facility__row">
                  <span class="ranch-facility__name">{{ f.name }}<small>Lv.{{ f.level }}</small></span>
                  <span class="ranch-facility__value">{{ f.text }}</span>
                </div>
                <div class="ranch-facility__track" aria-hidden="true">
                  <i :style="{ width: `${Math.min(100, f.percent)}%` }" />
                </div>
              </div>
            </div>
          </section>
          <section v-else-if="!ranchSnap" class="farm-card rounded-2xl p-5">
            <h3 class="mb-2 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-building" /> <span>牧场生涯 / 待处理 / 设施</span>
            </h3>
            <div class="ov-stamp">
              暂无缓存，进入牧场后自动记录
            </div>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

@media (min-width: 768px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ov-account {
    grid-column: 1 / -1;
  }
}

@media (min-width: 1280px) {
  .overview-grid {
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 1fr);
  }

  .ov-account {
    grid-column: auto;
  }
}

.ov-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.ov-card__title {
  margin: 0;
  color: var(--ui-muted);
  font-size: 13px;
  font-weight: var(--fw-600);
  line-height: 1.4;
}

/* 账号 */
.ov-account__head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.ov-avatar {
  position: relative;
  width: 52px;
  height: 52px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 16px;
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
  font-size: 26px;
}

.ov-avatar img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.ov-avatar__dot {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 14px;
  height: 14px;
  border: 3px solid var(--ui-surface-strong);
  border-radius: 999px;
  background: var(--ui-subtle);
}

.ov-avatar.is-online .ov-avatar__dot {
  background: #3fa765;
}

.ov-account__name-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ov-account__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: var(--fw-700);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-level {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
  font-size: 12px;
  font-weight: var(--fw-700);
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}

.ov-presence {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-top: 5px;
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-presence__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 9px 1px 7px;
  border-radius: 999px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.ov-presence__state::before {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  content: '';
}

.ov-presence__state.is-online {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.ov-presence__state.is-offline {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.ov-presence__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.ov-exp__labels {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-exp__value {
  font-variant-numeric: tabular-nums;
}

.ov-exp__value b {
  margin-left: 6px;
  color: var(--ui-ink);
  font-weight: var(--fw-700);
}

.ov-exp__track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.ov-exp__bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #5c9fd0, #4b86c5);
  transition: width 0.5s ease;
}

.ov-account__foot {
  display: grid;
  gap: 4px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px dashed var(--ui-border-strong);
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-account__foot b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.ov-forecast {
  margin-top: 0 !important;
}

/* 资产 / 库存数据格 */
.ov-tiles {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.ov-tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.ov-tile__label {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
}

.ov-tile__label > span {
  flex: none;
  font-size: 13px;
}

.ov-tile__value {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 20px;
  font-weight: var(--fw-700);
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-tile__delta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ov-tile__delta.is-up {
  color: var(--ui-primary);
}

.ov-tile__delta.is-down {
  color: var(--ui-danger);
}

@media (max-width: 520px) {
  .ov-card {
    padding: 16px;
  }

  .ov-tile {
    padding: 10px 12px;
  }

  .ov-tile__value {
    font-size: clamp(15px, 4.5vw, 18px);
  }
}

/* [fnos-fork] 运行日志高度跟随右侧「下次巡查倒计时 + 今日统计」，底边与今日统计对齐。 */
.dash-split {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.dash-split__side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1.5rem;
}

.dash-log-card {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

@media (min-width: 768px) {
  .dash-split {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
    align-items: stretch;
  }

  /* 日志卡片不参与行高计算，行高由右侧列决定，卡片再铺满这一行。 */
  .dash-split__logs {
    position: relative;
    min-width: 0;
    min-height: 0;
  }

  .dash-log-card {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
}

/* [fnos-fork] 合并首页：牧场卡片样式（来自原牧场概览） */
.ov-tile__img {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}

.ranch-alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 30%, transparent);
  border-radius: var(--ui-radius-control);
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 13px;
}

.ranch-alert > :last-child {
  margin-left: auto;
}

.ranch-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.ranch-todo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
  font-variant-numeric: tabular-nums;
}

.ranch-todo b {
  font-size: 15px;
}

.ranch-todo.is-zero {
  opacity: 0.6;
}

.ranch-facilities {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ranch-facility__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.ranch-facility__name {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.ranch-facility__name small {
  color: var(--ui-subtle);
  font-size: 11px;
  font-weight: var(--fw-500);
}

.ranch-facility__value {
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.ranch-facility__track {
  height: 6px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.ranch-facility__track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
  transition: width 0.4s ease;
}

.ranch-facility.is-pending {
  opacity: 0.6;
}

/* [fnos-fork] 运行日志卡片：桌面端高度跟随右侧一列（至少 480px），日志在卡片内滚动，两列底部对齐 */
@media (min-width: 768px) {
  .ranch-logs {
    position: relative;
    min-height: 480px;
  }

  .ranch-logs__card {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
}

.ov-group + .ov-group {
  padding-top: 12px;
  border-top: 1px dashed var(--ui-border);
}

.ov-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-stamp {
  color: var(--ui-subtle);
  font-size: 11px;
}

.ov-stamp.is-live {
  color: var(--ui-primary);
}

.ov-refresh {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ui-muted);
  cursor: pointer;
}

.ov-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
