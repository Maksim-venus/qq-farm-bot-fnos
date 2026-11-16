<script setup lang="ts">
// [fnos-fork] 2026-11-17 牧场最近访客：好友来我牧场做了什么，展示方式与农场「好友 → 最近访客」一致。
// 数据来自 InteractRecords（scene_id=2），后端按账号合并保存，服务器只给最近一段时也保留较早记录。
import { NButton } from 'naive-ui/es/button'
import { NButtonGroup } from 'naive-ui/es/button-group'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useRanchStore } from '@/stores/ranch'
import { FNOS_RANCH_VISITOR_FILTERS, fnosFormatVisitorTime, fnosRanchVisitorBadge, fnosRanchVisitorMatches } from '@/utils/fnos-ranch-visitors'

const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('visitors')

const filter = ref('all')
const failedAvatars = ref<Record<string, boolean>>({})
const records = computed<any[]>(() => Array.isArray(state.value?.visitors) ? state.value.visitors : [])
const filtered = computed(() => records.value.filter(record => fnosRanchVisitorMatches(record, filter.value)))
const visible = computed(() => filtered.value.slice(0, 100))
</script>

<template>
  <div class="visitors">
    <div class="page-toolbar !mb-0">
      <NButtonGroup size="small">
        <NButton
          v-for="item in FNOS_RANCH_VISITOR_FILTERS"
          :key="item.key"
          :type="filter === item.key ? 'primary' : 'default'"
          @click="filter = item.key"
        >
          {{ item.label }}
        </NButton>
      </NButtonGroup>
      <div class="page-toolbar__actions">
        <span class="visitors__count">共 {{ filtered.length }}/{{ records.length }} 条</span>
        <NButton secondary circle title="刷新访客" aria-label="刷新访客" :loading="loading" @click="refresh">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </div>

    <RanchGate @retry="refresh">
      <div v-if="loading && !records.length" class="visitors__loading" role="status" aria-label="正在读取访客">
        <span class="i-svg-spinners-90-ring-with-bg" />
      </div>
      <EmptyState v-else-if="!visible.length" title="暂无访客记录" description="好友来偷取、放蚊子、帮忙或抚摸后会显示在这里" icon="i-carbon-recently-viewed" />
      <div v-else class="space-y-3">
        <div v-for="record in visible" :key="record.key" class="flex items-start gap-3 cartoon-card rounded-2xl bg-white p-4 shadow-md dark:bg-gray-800">
          <div class="h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-700 dark:ring-gray-600">
            <img v-if="record.avatarUrl && !failedAvatars[record.key]" :src="record.avatarUrl" class="h-full w-full object-cover" alt="" loading="lazy" @error="failedAvatars[record.key] = true">
            <span v-else class="i-carbon-user text-xl text-gray-400" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="mb-1 flex flex-wrap items-center gap-2">
              <span class="max-w-full truncate text-base text-gray-800 font-medium dark:text-gray-100">{{ record.nick || `GID:${record.visitorGid}` }}</span>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="fnosRanchVisitorBadge(record.actionKey)" :title="record.actionCertain ? '' : `动作类型 ${record.actionType}：按抓包推断`">{{ record.actionLabel }}</span>
              <span v-if="record.level" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">Lv.{{ record.level }}</span>
              <span v-if="record.visitorGid" class="text-xs text-gray-400">GID {{ record.visitorGid }}</span>
            </div>
            <div class="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
              <img v-if="record.productImage" :src="record.productImage" alt="" class="h-6 w-6 object-contain">
              {{ record.actionDetail || record.actionLabel }}
            </div>
          </div>
          <div class="shrink-0 text-right text-xs text-gray-400">
            {{ fnosFormatVisitorTime(record.serverTimeMs) }}
          </div>
        </div>
        <div v-if="filtered.length > visible.length" class="text-center text-xs text-gray-400">
          仅展示最近 {{ visible.length }} 条
        </div>
      </div>
    </RanchGate>
  </div>
</template>

<style scoped>
.visitors {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 24px;
}

.visitors__count {
  color: var(--ui-muted);
  font-size: 13px;
}

.visitors__loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
  font-size: 28px;
  color: var(--ui-primary);
}
</style>
