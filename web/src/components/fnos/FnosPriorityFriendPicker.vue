<script setup lang="ts">
// [fnos-fork] 奶茶自动雇佣「优先雇佣人」多选：可搜索地从好友里添加，已选的人按顺序排成列表，
// 可按住手柄拖动（FnosSortableList，鼠标/触屏）或用上下按钮调整顺序，点 × 移除。
import type { FnosPriorityFriend } from '@/utils/fnos-priority-friends'
import { computed, ref } from 'vue'
import FnosSortableList from '@/components/fnos/FnosSortableList.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import {
  FNOS_MAX_PRIORITY_FRIENDS,
  fnosAddPriorityFriend,
  fnosMovePriorityFriend,
  fnosRemovePriorityFriend,
} from '@/utils/fnos-priority-friends'

interface FriendItem { gid: number | string, name?: string }

const props = defineProps<{
  friends: FriendItem[]
  loading?: boolean
}>()

const model = defineModel<FnosPriorityFriend[]>({ required: true })
const pickerValue = ref<number | undefined>(undefined)

const full = computed(() => model.value.length >= FNOS_MAX_PRIORITY_FRIENDS)
const addOptions = computed(() => {
  const chosen = new Set(model.value.map(item => item.gid))
  return props.friends
    .filter(f => Number(f.gid) > 0 && !chosen.has(Number(f.gid)))
    .map(f => ({ label: `${String(f.name || '').trim() || '未命名'}（GID ${f.gid}）`, value: Number(f.gid) }))
})

function displayName(item: FnosPriorityFriend): string {
  const live = props.friends.find(f => Number(f.gid) === item.gid)
  return String(live?.name || item.name || '').trim() || `GID ${item.gid}`
}

function onPick(value: string | number) {
  const gid = Number(value) || 0
  const friend = props.friends.find(f => Number(f.gid) === gid)
  model.value = fnosAddPriorityFriend(model.value, gid, String(friend?.name || '').trim())
  // 选完清空，方便继续添加下一个
  pickerValue.value = undefined
}

function remove(gid: number) {
  model.value = fnosRemovePriorityFriend(model.value, gid)
}

function move(from: number, to: number) {
  model.value = fnosMovePriorityFriend(model.value, from, to)
}

/** 供父组件「手动输入 GID」使用 */
function addGid(gid: number, name = '') {
  model.value = fnosAddPriorityFriend(model.value, gid, name)
}

defineExpose({ addGid })

function indicatorStyle(indicator: { side: 'before' | 'after', axis: 'x' | 'y' } | null) {
  if (!indicator)
    return null
  return { left: '0', right: '0', height: '3px', [indicator.side === 'before' ? 'top' : 'bottom']: '-5px' }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <BaseSelect
      :key="model.length"
      v-model="pickerValue"
      label="优先雇佣人（从本账号的好友中选择，可选多个）"
      :options="addOptions"
      filterable
      :disabled="full"
      :placeholder="loading ? '正在读取好友列表...' : full ? `最多 ${FNOS_MAX_PRIORITY_FRIENDS} 人` : '搜索并添加好友'"
      @change="onPick"
    />
    <p v-if="!model.length" class="text-xs text-gray-500 dark:text-gray-400">
      未指定：随机雇可雇佣好友。
    </p>
    <FnosSortableList
      v-else
      v-slot="sort"
      class="flex flex-col gap-1.5"
      :item-count="model.length"
      @move="move"
    >
      <div
        v-for="(item, index) in model"
        :key="item.gid"
        :data-fnos-sort-index="index"
        class="relative flex items-center gap-2 border border-pink-200 rounded-lg bg-pink-50/60 px-2 py-1.5 dark:border-pink-800/50 dark:bg-pink-900/15"
        :class="{ 'opacity-60 ring-2 ring-pink-400': sort.draggingIndex === index }"
      >
        <div
          v-if="indicatorStyle(sort.indicatorFor(index))"
          class="pointer-events-none absolute z-10 rounded-full bg-pink-500"
          :style="indicatorStyle(sort.indicatorFor(index)) || undefined"
        />
        <span class="h-6 min-w-6 flex shrink-0 items-center justify-center rounded-full bg-pink-500 px-1 text-xs text-white font-bold">
          {{ index + 1 }}
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm text-gray-800 font-medium dark:text-gray-100">
            {{ displayName(item) }}
          </div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400">
            GID {{ item.gid }}
          </div>
        </div>
        <div
          class="h-9 w-7 flex shrink-0 cursor-grab touch-none select-none items-center justify-center rounded text-lg text-pink-400 active:cursor-grabbing hover:bg-pink-100 dark:hover:bg-gray-700"
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
          class="h-9 w-8 flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-pink-100 dark:text-gray-300 disabled:opacity-30 dark:hover:bg-gray-700"
          :disabled="index === 0"
          title="上移"
          aria-label="上移"
          @click="move(index, index - 1)"
        >
          <span class="i-carbon-chevron-up" />
        </button>
        <button
          type="button"
          class="h-9 w-8 flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-pink-100 dark:text-gray-300 disabled:opacity-30 dark:hover:bg-gray-700"
          :disabled="index === model.length - 1"
          title="下移"
          aria-label="下移"
          @click="move(index, index + 1)"
        >
          <span class="i-carbon-chevron-down" />
        </button>
        <button
          type="button"
          class="h-9 w-8 flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-red-50 dark:text-gray-300 hover:text-red-600 dark:hover:bg-red-900/30"
          :title="`移除 ${displayName(item)}`"
          :aria-label="`移除 ${displayName(item)}`"
          @click="remove(item.gid)"
        >
          <span class="i-carbon-close" />
        </button>
      </div>
    </FnosSortableList>
  </div>
</template>
