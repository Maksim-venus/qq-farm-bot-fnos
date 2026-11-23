<script setup lang="ts">
import type { FnosErrorLevelFilter, FnosLogView } from '@/utils/fnos-log-categories'
import type { FnosFarmDaySummary, FnosLogSpaceView, FnosRanchDaySummary } from '@/utils/fnos-log-space'
import { useIntervalFn } from '@vueuse/core'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { fnosBuildLogCategoryParams, fnosEmptyLogText, fnosIsCategoryLogView } from '@/utils/fnos-log-categories'
import {
  FNOS_LOG_PER_SPACE_CAP,
  FNOS_LOG_SPACE_VIEWS,
  FNOS_RANCH_EVENT_OPTIONS,
  FNOS_RANCH_SCOPE_OPTIONS,
  fnosFarmSummaryParts,
  fnosFilterLogSpaceView,
  fnosIsRanchLog,
  fnosLoadLogSpaceView,
  fnosMsUntilNextBeijingMidnight,
  fnosRanchEventLabel,
  fnosRanchEventParam,
  fnosRanchSummaryParts,
  fnosSaveLogSpaceView,
} from '@/utils/fnos-log-space'

/**
 * [fnos-fork] 2026-11-17 运行日志：农场、牧场合成一张卡片。
 * 顶部「全部 / 农场 / 牧场」切换（默认全部，记住上次选择）：
 *   - 农场：沿用农场原来的「模块 / 事件 / 等级 / 关键词」与「全部 / 偷菜日志 / 报错日志」分栏，并显示今日农场汇总；
 *   - 牧场：沿用牧场原来的「范围 / 事件 / 等级 / 关键词」，并显示今日牧场汇总（偷了什么、做了几次）；
 *   - 全部：两边按时间合并，每行标出农场 / 牧场，同时显示今日农场与今日牧场。
 * 今日统计按北京时间 0 点切日，页面在切日时自动刷新。
 * 日志按账号持久化在 NAS 的 data/fnos-run-logs/ 里，重启或换页面后仍能看到。
 */
const statusStore = useStatusStore()
const toastStore = useToastStore()
const { logs: statusLogs, realtimeConnected } = storeToRefs(statusStore)
const { currentAccountId } = storeToRefs(useAccountStore())
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const clearingLogs = ref(false)

const space = ref<FnosLogSpaceView>(fnosLoadLogSpaceView())
const farmFilter = reactive({ module: '', event: '' })
const ranchFilter = reactive({ scope: '', event: '' })
const common = reactive({ keyword: '', isWarn: '' })
const fnosErrorLevel = ref<FnosErrorLevelFilter>('')

// 偷菜 / 报错分栏在「全部」「农场」可用（偷菜日志也包含牧场偷取）；牧场用自己的范围 / 事件
// [fnos-fork] 2026-11-23 取消「偷菜日志 / 报错日志」分栏，只保留一份统一日志（后端分类接口保留但前端不再使用）
const effectiveLogView = computed<FnosLogView>(() => 'all')

const hasActiveLogFilter = computed(() => {
  if (common.keyword || common.isWarn || fnosIsCategoryLogView(effectiveLogView.value))
    return true
  if (space.value === 'farm')
    return !!(farmFilter.module || farmFilter.event)
  if (space.value === 'ranch')
    return !!(ranchFilter.scope || ranchFilter.event)
  return false
})

const allLogs = computed(() => {
  return fnosFilterLogSpaceView([...(statusLogs.value || [])], space.value)
    .sort((a: any, b: any) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
    .slice(space.value === 'all' ? -FNOS_LOG_PER_SPACE_CAP * 2 : -FNOS_LOG_PER_SPACE_CAP)
})

type LogLevel = 'error' | 'warn' | 'success' | 'info'

function getLogLevel(log: any): LogLevel {
  const result = String(log?.meta?.result || '')
  if (log?.tag === '错误' || result === 'error' || result === 'failed')
    return 'error'
  if (log?.isWarn || log?.tag === '警告' || result === 'defer' || result === 'skip')
    return 'warn'
  if (['ok', 'success', 'done', 'resume', 'resumed'].includes(result))
    return 'success'
  return 'info'
}

/** 连续出现、仅数字不同的同类日志合并为一行（×N + 时间范围），保留最新一条的内容，避免巡查类日志刷屏。 */
const logGroups = computed(() => {
  const groups: Array<{ key: string, log: any, level: LogLevel, ranch: boolean, count: number, firstTime: string }> = []
  for (const log of allLogs.value) {
    const ranch = fnosIsRanchLog(log)
    const level = getLogLevel(log)
    const signature = `${ranch ? 'r' : 'f'}|${level}|${log.tag}|${log.meta?.event || ''}|${String(log.msg || '').replace(/\d+/g, '#')}`
    const last = groups[groups.length - 1]
    if (last && last.key === signature) {
      last.count += 1
      last.log = log
      continue
    }
    groups.push({ key: signature, log, level, ranch, count: 1, firstTime: log.time })
  }
  return groups
})

// 农场原有筛选
const farmModules = [
  { label: '所有模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '好友', value: 'friend' },
  { label: '仓库', value: 'warehouse' },
  { label: '任务', value: 'task' },
  { label: '系统', value: 'system' },
]

const farmEvents = [
  { label: '所有事件', value: '' },
  { label: '农场巡查', value: 'farm_cycle' },
  { label: '农牧轮次', value: 'fnos轮次切换,fnos轮次插队' }, // [fnos-fork] 2026-11-17 农场、牧场轮流
  { label: '收获作物', value: 'harvest_crop' },
  { label: '清理枯株', value: 'remove_plant' },
  { label: '种植种子', value: 'plant_seed' },
  { label: '施加化肥', value: 'fertilize' },
  { label: '土地推送', value: 'lands_notify' },
  { label: '选择种子', value: 'seed_pick' },
  { label: '购买种子', value: 'seed_buy' },
  { label: '购买化肥', value: 'fertilizer_buy' },
  { label: '开启礼包', value: 'fertilizer_gift_open' },
  { label: '获取任务', value: 'task_scan' },
  { label: '完成任务', value: 'task_claim' },
  { label: '免费礼包', value: 'mall_free_gifts' },
  { label: '分享奖励', value: 'daily_share' },
  { label: '会员礼包', value: 'vip_daily_gift' },
  { label: '月卡礼包', value: 'month_card_gift' },
  // [fnos-fork] 2026-11-17 图鉴奖励：实际写入的事件是「图鉴奖励领取」（fork 自动领取）与「图鉴奖励」（上游登录时领取），一并筛选
  { label: '图鉴奖励', value: 'illustrated_rewards,图鉴奖励领取,图鉴奖励' },
  { label: '邮箱领取', value: 'email_rewards' },
  { label: '出售成功', value: 'sell_success' },
  { label: '土地升级', value: 'upgrade_land' },
  { label: '土地解锁', value: 'unlock_land' },
  { label: '好友巡查', value: 'friend_cycle' },
  { label: '访问好友', value: 'visit_friend' },
  { label: '按时间表前往', value: '按时间表前往' }, // [fnos-fork] 2026-11-17 好友时间表到点直接去
]

const farmEventLabelMap: Record<string, string> = Object.fromEntries(
  farmEvents.filter(e => e.value).flatMap(e => e.value.split(',').map(value => [value, e.label])), // 一项可对应多个事件
)

// 上游 PR #139 的牧场事件中文名，fork 分组筛选没覆盖到的事件按这里显示
const upstreamRanchEventLabels: Record<string, string> = {
  ranch_automation: '牧场巡查',
  ranch_buy: '购买牧场商品',
  ranch_place: '放养幼崽',
  ranch_addGrass: '补充牧草',
  ranch_useCan: '填充罐头',
  ranch_feed: '喂养动物',
  ranch_produce: '牧场生产',
  ranch_harvest: '牧场收获',
  ranch_sell: '出售牧场产物',
  ranch_clean: '清理牧场',
  ranch_activateShed: '解锁牧场棚',
  ranch_upgrade: '升级牧场建筑',
  ranch_completeUpgrade: '完成建筑升级',
  ranch_claimTasks: '领取牧场任务',
  ranch_reportEntry: '牧场成长任务',
  ranch_exchange: '牧场集市兑换',
  ranch_claimIllustrated: '牧场图鉴奖励',
  ranch_claimDailyShare: '牧场每日分享',
  ranch_buyCan: '购买牧场罐头',
  ranch_steal: '偷取好友牧场',
  ranch_stroke: '抚摸好友动物',
  ranch_release: '放生动物',
  ranch_putMosquito: '放蚊子',
  ranch_cleanFriend: '清理好友牧场',
  ranch_friend: '拜访好友牧场',
  ranch_friend_leave: '离开好友牧场',
  ranch_scene_restore: '恢复场景',
  ranch_task_claim: '牧场任务',
  ranch_daily_share: '牧场分享礼包',
  ranch_daily_benefit: '牧场每日福利', // 上游 PR #142
}

/** 农场事件用农场标签；牧场事件先用 fork 分组标签，再用上游中文名，英文内部事件名不显示（同上游 PR #139）。 */
function getEventLabel(log: any) {
  const key = String(log?.meta?.event || '')
  if (!key)
    return ''
  if (!fnosIsRanchLog(log))
    return farmEventLabelMap[key] || key
  const label = fnosRanchEventLabel(key)
  if (label && label !== key)
    return label
  return upstreamRanchEventLabels[key] || (/[\u3400-\u9FFF]/u.test(key) ? key : '')
}

// 保留日志原 tag（如「好友牧场」），牧场日志没有 tag 时显示「牧场」
function getModuleLabel(log: any) {
  return log?.tag || (fnosIsRanchLog(log) ? '牧场' : '')
}

const levelOptions = [
  { label: '所有等级', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
]

const emptyText = computed(() => {
  const view = effectiveLogView.value
  if (fnosIsCategoryLogView(view))
    return fnosEmptyLogText(view)
  return space.value === 'ranch' ? '暂无牧场日志' : space.value === 'farm' ? '暂无农场日志' : '暂无日志'
})

function formatLogTime(timeStr: string) {
  // 2024/5/20 12:34:56 -> 12:34:56
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

function buildParams() {
  const params: Record<string, any> = {
    limit: FNOS_LOG_PER_SPACE_CAP,
    space: space.value,
    keyword: common.keyword || undefined,
    isWarn: common.isWarn === 'warn' ? true : common.isWarn === 'info' ? false : undefined,
  }
  if (space.value === 'farm') {
    params.module = farmFilter.module || undefined
    params.event = farmFilter.event || undefined
  }
  else if (space.value === 'ranch') {
    params.event = fnosRanchEventParam(ranchFilter.scope, ranchFilter.event)
  }
  return { ...params, ...fnosBuildLogCategoryParams(effectiveLogView.value, fnosErrorLevel.value) }
}

/** 切换、筛选、首次打开时走 HTTP；没有筛选且实时连接正常时由 WS 实时追加。 */
async function loadLogs(force = false) {
  if (!currentAccountId.value)
    return
  if (force || hasActiveLogFilter.value || !realtimeConnected.value)
    await statusStore.fetchLogs(currentAccountId.value, buildParams())
}

// 今日农场 / 牧场汇总（服务端按北京时间分天持久化，不受日志条数上限影响）
const farmSummary = ref<FnosFarmDaySummary | null>(null)
const ranchSummary = ref<FnosRanchDaySummary | null>(null)
const showFarmSummary = computed(() => space.value !== 'ranch' && !!farmSummary.value)
const showRanchSummary = computed(() => space.value !== 'farm' && !!ranchSummary.value)
const farmSummaryParts = computed(() => fnosFarmSummaryParts(farmSummary.value))
const ranchSummaryParts = computed(() => fnosRanchSummaryParts(ranchSummary.value))

async function loadSpaceSummary(kind: 'farm' | 'ranch') {
  const id = currentAccountId.value
  if (!id)
    return
  if (kind === 'farm' && space.value === 'ranch')
    return
  if (kind === 'ranch' && space.value === 'farm')
    return
  try {
    const { data } = await api.get(kind === 'farm' ? '/api/fnos/farm-log-summary' : '/api/fnos/ranch-log-summary', { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
    if (id !== currentAccountId.value)
      return
    const value = data?.ok && Array.isArray(data.data) ? data.data[0] || null : null
    if (kind === 'farm')
      farmSummary.value = value
    else ranchSummary.value = value
  }
  catch {
    // 汇总是补充信息，读不到不影响日志
  }
}

function loadSummaries() {
  loadSpaceSummary('farm')
  loadSpaceSummary('ranch')
}

let midnightTimer: ReturnType<typeof setTimeout> | undefined

function scheduleMidnightRefresh() {
  if (midnightTimer !== undefined)
    clearTimeout(midnightTimer)
  const wait = Math.min(fnosMsUntilNextBeijingMidnight(Date.now()) + 200, 24 * 3600 * 1000)
  midnightTimer = setTimeout(() => {
    midnightTimer = undefined
    loadSummaries()
    scheduleMidnightRefresh()
  }, wait)
}

function onLogFilterChange() {
  loadLogs(true)
}

watch([space], async () => {
  fnosSaveLogSpaceView(space.value)
  await loadLogs(true)
  scrollToBottom()
  loadSummaries()
})

watch(currentAccountId, async () => {
  farmSummary.value = null
  ranchSummary.value = null
  await loadLogs(true)
  scrollToBottom()
  loadSummaries()
})

watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
})

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el)
    return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 50
}

async function clearLogs() {
  if (!currentAccountId.value)
    return
  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await loadLogs(true)
    }
    else {
      toastStore.error(`清空失败: ${getApiErrorMessage(data, '未知错误')}`)
    }
  }
  catch (e: any) {
    toastStore.error(`清空失败: ${getApiErrorMessage(e, '请求失败')}`)
  }
  finally {
    clearingLogs.value = false
  }
}

let logScrollFrame: number | undefined

function scheduleLogScroll(force = false) {
  nextTick(() => {
    if (!logContainer.value || (!force && !autoScroll.value) || logScrollFrame !== undefined)
      return
    logScrollFrame = window.requestAnimationFrame(() => {
      if (logContainer.value)
        logContainer.value.scrollTop = logContainer.value.scrollHeight
      logScrollFrame = undefined
    })
  })
}

watch(allLogs, () => {
  scheduleLogScroll()
})

function scrollToBottom() {
  scheduleLogScroll(true)
}

onMounted(async () => {
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  // 每次打开都重新读一次：别的页面可能留下了筛选结果
  await loadLogs(true)
  scrollToBottom()
  loadSummaries()
  scheduleMidnightRefresh()
})

onBeforeUnmount(() => {
  if (logScrollFrame !== undefined)
    window.cancelAnimationFrame(logScrollFrame)
  if (midnightTimer !== undefined)
    clearTimeout(midnightTimer)
})

// WS 断开或筛选启用时每 10 秒回退 HTTP；牧场汇总每分钟刷新
useIntervalFn(loadLogs, 10000)
useIntervalFn(loadSummaries, 60000)
</script>

<template>
  <div class="run-log-card farm-card rounded-2xl bg-white p-5 shadow-md dark:bg-gray-800">
    <div class="mb-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
      <h3 class="flex shrink-0 items-center gap-2 whitespace-nowrap text-lg font-bold">
        <span class="i-carbon-document" /> <span>运行日志</span>
      </h3>

      <div class="log-filters">
        <template v-if="space === 'farm'">
          <BaseSelect v-model="farmFilter.module" :options="farmModules" @change="onLogFilterChange" />
          <BaseSelect v-model="farmFilter.event" :options="farmEvents" @change="onLogFilterChange" />
        </template>
        <template v-else-if="space === 'ranch'">
          <BaseSelect v-model="ranchFilter.scope" :options="FNOS_RANCH_SCOPE_OPTIONS" title="范围：自己牧场 / 好友牧场 / 任务与礼包" @change="onLogFilterChange" />
          <BaseSelect v-model="ranchFilter.event" :options="FNOS_RANCH_EVENT_OPTIONS" @change="onLogFilterChange" />
        </template>

        <BaseSelect v-model="common.isWarn" :options="levelOptions" @change="onLogFilterChange" />

        <BaseInput
          v-model="common.keyword"
          placeholder="关键词"
          clearable
          @keyup.enter="onLogFilterChange"
          @clear="onLogFilterChange"
        />

        <div class="log-filters__buttons">
          <BaseButton variant="primary" class="log-filters__icon" title="搜索日志" aria-label="搜索日志" @click="onLogFilterChange">
            <span class="i-carbon-search" />
          </BaseButton>

          <BaseButton
            variant="secondary"
            class="log-filters__icon"
            title="清空日志（农场、牧场一起清，牧场每日汇总保留）"
            aria-label="清空日志"
            :loading="clearingLogs"
            @click="clearLogs"
          >
            <template #icon>
              <span class="i-carbon-trash-can" />
            </template>
          </BaseButton>
        </div>
      </div>
    </div>

    <div class="fnos-log-views mb-3">
      <NTabs v-model:value="space" type="segment" size="small" class="fnos-log-views__space">
        <NTab v-for="view in FNOS_LOG_SPACE_VIEWS" :key="view.value" :name="view.value">
          <span class="inline-flex items-center gap-1 whitespace-nowrap"><span :class="view.icon" />{{ view.label }}</span>
        </NTab>
      </NTabs>
    </div>

    <div v-if="showFarmSummary" class="fnos-day-summary fnos-day-summary--farm mb-3" title="从升级到这一版开始按天累计，按北京时间 0 点切日，重启不丢；清空日志不会清掉汇总">
      <span class="fnos-day-summary__title">今日农场</span>
      <span class="fnos-day-summary__steal">{{ farmSummaryParts.steal }}</span>
      <span v-for="part in farmSummaryParts.actions" :key="part">{{ part }}</span>
    </div>

    <div v-if="showRanchSummary" class="fnos-day-summary fnos-day-summary--ranch mb-3" title="从升级到这一版开始按天累计，按北京时间 0 点切日，重启不丢；清空日志不会清掉汇总">
      <span class="fnos-day-summary__title">今日牧场</span>
      <span class="fnos-day-summary__steal">{{ ranchSummaryParts.steal }}</span>
      <span v-for="part in ranchSummaryParts.actions" :key="part">{{ part }}</span>
    </div>

    <div ref="logContainer" class="log-list" :class="{ 'log-list--single': space !== 'all' }" @scroll="onLogScroll">
      <div v-if="!allLogs.length" class="py-8 text-center text-gray-400">
        {{ emptyText }}
      </div>
      <div
        v-for="group in logGroups"
        :key="group.log.ts + group.key"
        class="log-row"
        :class="[`log-row--${group.level}`, { 'log-row--ranch': group.ranch }]"
      >
        <span class="log-row__time">
          {{ formatLogTime(group.log.time) }}
        </span>
        <span v-if="space === 'all'" class="log-row__space" :class="{ 'log-row__space--ranch': group.ranch }">{{ group.ranch ? '牧场' : '农场' }}</span>
        <span class="log-row__tag">{{ getModuleLabel(group.log) }}</span>
        <span class="log-row__body">
          <span v-if="getEventLabel(group.log)" class="log-row__event">{{ getEventLabel(group.log) }}</span>
          <span class="log-row__msg">{{ group.log.msg }}</span>
          <span v-if="group.count > 1" class="log-row__repeat" :title="`${formatLogTime(group.firstTime)} 起重复 ${group.count} 次`">
            ×{{ group.count }} · {{ formatLogTime(group.firstTime) }} 起
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* [fnos-fork] 卡片本身是纵向 flex：头部、切换、汇总固定，日志列表在卡片内滚动；高度由使用它的页面决定。 */
.run-log-card {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.run-log-card > :not(.log-list) {
  flex-shrink: 0;
}

.fnos-log-views {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.fnos-log-views__space {
  width: auto;
  min-width: 13rem;
  max-width: 16rem;
}

.fnos-log-views__tabs {
  width: auto;
  min-width: 18rem;
  max-width: 24rem;
}

.fnos-log-views__level {
  width: 8.5rem;
}

.fnos-day-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 6px 10px;
  border-radius: var(--ui-radius-control);
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

.fnos-day-summary--farm {
  background: color-mix(in srgb, var(--ui-primary) 8%, transparent);
}

.fnos-day-summary--ranch {
  background: color-mix(in srgb, var(--ui-violet) 8%, transparent);
}

.fnos-day-summary__title {
  font-weight: var(--fw-600);
  white-space: nowrap;
}

.fnos-day-summary--farm .fnos-day-summary__title {
  color: var(--ui-primary);
}

.fnos-day-summary--ranch .fnos-day-summary__title {
  color: var(--ui-violet);
}

.fnos-day-summary__steal {
  color: var(--ui-ink);
}

.log-row__space {
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
  font-size: 11px;
  white-space: nowrap;
}

.log-row__space--ranch {
  background: color-mix(in srgb, var(--ui-violet) 12%, transparent);
  color: var(--ui-violet);
}

.log-filters {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.log-filters__buttons {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 8px;
}

.log-filters__icon {
  width: 38px;
  min-width: 38px;
  height: 38px;
  padding: 0 !important;
}

@media (min-width: 640px) {
  .log-filters {
    grid-template-columns: repeat(4, minmax(0, 8.5rem)) auto;
    align-items: center;
  }

  .log-filters__buttons {
    grid-column: auto;
  }
}

.log-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 6px;
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
  font-size: 13px;
  line-height: 1.55;
}

.log-row {
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  padding: 5px 8px 5px 10px;
  border-left: 3px solid transparent;
  border-radius: 6px;
  content-visibility: auto;
  contain-intrinsic-size: auto 28px;
}

.log-row + .log-row {
  margin-top: 2px;
}

.log-row__time {
  color: var(--ui-subtle);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  white-space: nowrap;
  user-select: none;
}

.log-row__tag {
  min-width: 2.5em;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
  white-space: nowrap;
}

.log-row__body {
  min-width: 0;
  color: var(--ui-ink);
  overflow-wrap: anywhere;
}

.log-row__event {
  margin-right: 6px;
  color: var(--ui-muted);
  font-size: 12px;
}

.log-row__event::after {
  margin-left: 6px;
  color: var(--ui-subtle);
  content: '·';
}

.log-row__repeat {
  display: inline-block;
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ui-surface-strong);
  color: var(--ui-muted);
  font-size: 11px;
  white-space: nowrap;
}

.log-row--success {
  border-left-color: var(--ui-primary);
}

.log-row--success.log-row--ranch {
  border-left-color: var(--ui-violet);
}

.log-row--warn {
  border-left-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning-soft) 70%, transparent);
}

.log-row--warn .log-row__tag {
  color: var(--ui-warning);
}

.log-row--error {
  border-left-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger-soft) 80%, transparent);
}

.log-row--error .log-row__tag,
.log-row--error .log-row__msg {
  color: var(--ui-danger);
}

/* 只有「全部」显示空间标签；农场 / 牧场视图少一列 */
.log-list--single .log-row {
  grid-template-columns: auto auto minmax(0, 1fr);
}

@media (max-width: 767px) {
  .log-list {
    max-height: min(50vh, 28rem);
  }
}

@media (max-width: 640px) {
  .log-row {
    grid-template-columns: auto auto minmax(0, 1fr);
    gap: 2px 8px;
  }

  .log-list--single .log-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .log-row__body {
    grid-column: 1 / -1;
  }
}
</style>
