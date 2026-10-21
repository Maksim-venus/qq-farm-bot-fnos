<script setup lang="ts">
// [fnos-fork] 可直接改的序号：点一下变成输入框，输入目标位置后回车或失焦即提交；Esc 取消。
// 越界自动夹到 1..total，空/小数/非数字恢复原值（规则见 fnosParseSortPosition）。
import { nextTick, ref } from 'vue'
import { fnosParseSortPosition } from '@/utils/fnos-sort-order'

const props = defineProps<{
  /** 当前序号（1 起）。 */
  position: number
  total: number
}>()

const emit = defineEmits<{
  commit: [position: number]
}>()

const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
let cancelled = false

async function startEdit() {
  if (props.total < 2)
    return
  cancelled = false
  draft.value = String(props.position)
  editing.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function finish() {
  if (!editing.value)
    return
  editing.value = false
  if (cancelled)
    return
  const next = fnosParseSortPosition(draft.value, props.total)
  if (next !== null && next !== props.position)
    emit('commit', next)
}

function cancel() {
  cancelled = true
  editing.value = false
}
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    type="text"
    inputmode="numeric"
    enterkeyhint="done"
    maxlength="4"
    class="h-9 w-9 shrink-0 border-2 border-amber-400 rounded-lg bg-white text-center text-xs text-amber-800 font-bold outline-none dark:bg-gray-900 dark:text-amber-200"
    :aria-label="`输入目标序号（1-${total}）`"
    @keydown.enter.prevent="input?.blur()"
    @keydown.esc.prevent="cancel"
    @blur="finish"
    @mousedown.stop
  >
  <button
    v-else
    type="button"
    class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-100 text-xs text-amber-700 font-bold dark:bg-amber-900/50 dark:text-amber-300 hover:ring-2 hover:ring-amber-300"
    :class="total > 1 ? 'cursor-text' : 'cursor-default'"
    :title="total > 1 ? `点击直接改序号（1-${total}）` : undefined"
    :aria-label="`第 ${position} 位，点击改序号`"
    @click="startEdit"
    @mousedown.stop
  >
    {{ position }}
  </button>
</template>
