<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { FNOS_RANCH_EVENT_OPTIONS, FNOS_RANCH_SCOPE_OPTIONS, fnosFilterLogSpace, fnosRanchEventLabel, fnosRanchEventParam } from '@/utils/fnos-log-space'

const statusStore = useStatusStore()
const toastStore = useToastStore()
const { logs: statusLogs, realtimeConnected, realtimeLogsEnabled } = storeToRefs(statusStore)
const { currentAccountId } = storeToRefs(useAccountStore())
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const clearingLogs = ref(false)
const filter = reactive({ module: '', event: '', keyword: '', isWarn: '' })

// [fnos-fork] 此卡片只在牧场概览使用：只显示牧场日志，用牧场自己的筛选（范围 / 事件），与农场概览的筛选互不影响
const allLogs = computed(() => {
  return fnosFilterLogSpace([...(statusLogs.value || [])], 'ranch')
    .slice(-200)
    .sort((a: any, b: any) => a.ts - b.ts)
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

/**
 * 连续出现、仅数字不同的同类日志合并为一行（×N + 时间范围），保留最新一条的内容，
 * 避免巡查类日志刷屏。
 */
const logGroups = computed(() => {
  const groups: Array<{ key: string, log: any, level: LogLevel, count: number, firstTime: string }> = []
  for (const log of allLogs.value) {
    const signature = `${getLogLevel(log)}|${log.tag}|${log.meta?.event || ''}|${String(log.msg || '').replace(/\d+/g, '#')}`
    const last = groups[groups.length - 1]
    if (last && last.key === signature) {
      last.count += 1
      last.log = log
      continue
    }
    groups.push({ key: signature, log, level: getLogLevel(log), count: 1, firstTime: log.time })
  }
  return groups
})

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keyword || filter.isWarn),
)

// [fnos-fork] 牧场筛选：filter.module 存「范围」、filter.event 存「事件」（均为逗号分隔的 meta.event 列表）
const modules = FNOS_RANCH_SCOPE_OPTIONS
const events = FNOS_RANCH_EVENT_OPTIONS

function getEventLabel(event: string) {
  return fnosRanchEventLabel(event)
}

const logs = [
  { label: '所有等级', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
]

function formatLogTime(timeStr: string) {
  // 2024/5/20 12:34:56 -> 12:34:56
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

/** 首次加载、断线兜底或启用筛选时走 HTTP；连接正常时由 WS 实时推送。 */
async function loadLogs(force = false) {
  if (!currentAccountId.value)
    return
  if (force || hasActiveLogFilter.value || !realtimeConnected.value) {
    await statusStore.fetchLogs(currentAccountId.value, {
      space: 'ranch', // [fnos-fork]
      event: fnosRanchEventParam(filter.module, filter.event),
      keyword: filter.keyword || undefined,
      isWarn: filter.isWarn === 'warn' ? true : filter.isWarn === 'info' ? false : undefined,
    })
  }
}

function onLogFilterChange() {
  loadLogs(true)
}

function onLogSearchTrigger() {
  loadLogs(true)
}

watch(currentAccountId, async () => {
  await loadLogs()
  scrollToBottom()
})

watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
  loadLogs()
})

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el)
    return
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  autoScroll.value = isNearBottom
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
      toastStore.error(`清空失败: ${data?.error || '未知错误'}`)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    toastStore.error(`清空失败: ${msg}`)
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
  // 上一个页面若因筛选暂停了实时日志，列表里还是筛选结果，这里重新读取完整日志。
  const filteredBefore = !realtimeLogsEnabled.value
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  await loadLogs(filteredBefore)
  scrollToBottom()
})

onBeforeUnmount(() => {
  if (logScrollFrame !== undefined)
    window.cancelAnimationFrame(logScrollFrame)
})

// Auto refresh fallback every 10s (WS 断开或筛选条件启用时会回退 HTTP)
useIntervalFn(loadLogs, 10000)
</script>

<template>
  <div class="dash-logs flex flex-1 flex-col gap-6 md:w-3/4">
    <!-- 桌面端高度跟随右侧一列（至少 480px），日志在卡片内部滚动，两列底部对齐 -->
    <div class="dash-logs__card flex flex-1 flex-col farm-card rounded-2xl bg-white p-5 shadow-md md:overflow-hidden dark:bg-gray-800">
      <div class="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <h3 class="flex shrink-0 items-center gap-2 whitespace-nowrap text-lg font-bold">
          <span class="i-carbon-document" /> <span>运行日志</span><span class="text-sm text-gray-400 font-normal" title="农场日志在「农场 → 概览」，筛选各自独立">· 牧场</span>
        </h3>

        <div class="log-filters">
          <BaseSelect
            v-model="filter.module"
            :options="modules"
            @change="onLogFilterChange"
          />

          <BaseSelect
            v-model="filter.event"
            :options="events"
            @change="onLogFilterChange"
          />

          <BaseSelect
            v-model="filter.isWarn"
            :options="logs"
            @change="onLogFilterChange"
          />

          <BaseInput
            v-model="filter.keyword"
            placeholder="关键词"
            clearable
            @keyup.enter="onLogSearchTrigger"
            @clear="onLogSearchTrigger"
          />

          <div class="log-filters__buttons">
            <BaseButton
              variant="primary"
              class="log-filters__icon"
              title="搜索日志"
              aria-label="搜索日志"
              @click="onLogSearchTrigger"
            >
              <span class="i-carbon-search" />
            </BaseButton>

            <BaseButton
              variant="secondary"
              class="log-filters__icon"
              title="清空日志"
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

      <div ref="logContainer" class="log-list max-h-[60vh] min-h-0 flex-1 overflow-y-auto md:max-h-none" @scroll="onLogScroll">
        <div v-if="!allLogs.length" class="py-8 text-center text-gray-400">
          暂无牧场日志
        </div>
        <div
          v-for="group in logGroups"
          :key="group.log.ts + group.key"
          class="log-row"
          :class="`log-row--${group.level}`"
        >
          <span class="log-row__time">
            {{ formatLogTime(group.log.time) }}
          </span>
          <span class="log-row__tag">{{ group.log.tag }}</span>
          <span class="log-row__body">
            <span v-if="group.log.meta?.event" class="log-row__event">{{ getEventLabel(group.log.meta.event) }}</span>
            <span class="log-row__msg">{{ group.log.msg }}</span>
            <span v-if="group.count > 1" class="log-row__repeat" :title="`${formatLogTime(group.firstTime)} 起重复 ${group.count} 次`">
              ×{{ group.count }} · {{ formatLogTime(group.firstTime) }} 起
            </span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 768px) {
  .dash-logs {
    position: relative;
    min-height: 480px;
  }

  .dash-logs__card {
    position: absolute;
    inset: 0;
  }
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
  padding: 6px;
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
  font-size: 13px;
  line-height: 1.55;
}

.log-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
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

@media (max-width: 640px) {
  .log-row {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 8px;
  }

  .log-row__body {
    grid-column: 1 / -1;
  }
}
</style>
