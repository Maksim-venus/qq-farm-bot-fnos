<script setup lang="ts">
// [fnos-fork] 地块卡片上的「普通肥」「有机肥」按钮：点一下只给这一块地施肥。
// 上游 PR #105 把单块施肥移到了「选择土地」批量模式，这里在卡片上补回直达入口，上游的选地施肥、一键施肥保持不变。
import type { FnosCardFertilizerType } from '@/utils/fnos-land-fertilize'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useFarmStore } from '@/stores/farm'
import { useToastStore } from '@/stores/toast'
import { fnosCardFertilizeDisabledReason } from '@/utils/fnos-land-fertilize'

const props = withDefaults(defineProps<{
  land: any
  accountId?: string | null
  running?: boolean
  /** 外层有其它操作（一键操作、务农、批量）进行中。 */
  busy?: boolean
}>(), {
  accountId: '',
  running: false,
  busy: false,
})

const farmStore = useFarmStore()
const toast = useToastStore()
const { fertilizePending, fertilizeError } = storeToRefs(farmStore)

const ctx = computed(() => ({
  accountId: props.accountId,
  running: props.running,
  busy: props.busy || fertilizePending.value,
}))

const buttons = computed(() => ([
  { type: 'normal' as const, label: '普通肥', name: '普通化肥', icon: 'i-carbon-chemistry' },
  { type: 'organic' as const, label: '有机肥', name: '有机化肥', icon: 'i-carbon-sprout' },
]).map(item => ({ ...item, reason: fnosCardFertilizeDisabledReason(props.land, item.type, ctx.value) })))

function formatRemaining(sec: number) {
  const remaining = Number(sec) || 0
  return remaining > 0 ? `，剩余 ${(remaining / 3600).toFixed(1)}h` : ''
}

async function fertilize(type: FnosCardFertilizerType, name: string) {
  const accountId = String(props.accountId || '')
  const landId = Number(props.land?.id) || 0
  if (!landId || fnosCardFertilizeDisabledReason(props.land, type, ctx.value))
    return
  const result = await farmStore.fertilizeAll(accountId, type, [landId])
  // 请求期间切换了账号：结果不属于当前页面，不再提示。
  if (String(props.accountId || '') !== accountId)
    return
  if (!result) {
    toast.error(fertilizeError.value || `#${landId} ${name}使用失败，请刷新土地确认最新状态`)
    return
  }
  if (!result.successCount) {
    toast.info(`#${landId} 当前无需施肥`)
    return
  }
  toast.success(`已为 #${landId} 施${name}${formatRemaining(Number(result.fertilizerRemainingSec || 0))}`)
  // 服务端没有回传最新土地时，主动刷新一次。
  if (!Array.isArray(result.updatedLands) || !result.updatedLands.length)
    await farmStore.fetchLands(accountId)
}
</script>

<template>
  <div class="fnos-fert" role="group" :aria-label="`第 ${land?.id} 块地施肥`" @click.stop @keydown.stop>
    <button
      v-for="item in buttons"
      :key="item.type"
      type="button"
      class="fnos-fert__btn"
      :class="`is-${item.type}`"
      :disabled="!!item.reason"
      :title="item.reason || `给 #${land?.id} 施${item.name}`"
      :aria-label="item.reason ? `${item.name}：${item.reason}` : `给第 ${land?.id} 块地施${item.name}`"
      @click.stop="fertilize(item.type, item.name)"
    >
      <span :class="item.icon" aria-hidden="true" />
      <span class="fnos-fert__label">{{ item.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.fnos-fert {
  container-type: inline-size;
  display: flex;
  width: 100%;
  gap: 4px;
  margin-top: 7px;
}
.fnos-fert__btn {
  display: inline-flex;
  min-width: 0;
  height: 22px;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0 4px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-primary) 35%, var(--ui-border));
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-surface-strong);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}
.fnos-fert__btn > span:first-child {
  flex: none;
  font-size: 11px;
}
.fnos-fert__label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.fnos-fert__btn.is-organic {
  border-color: color-mix(in srgb, #5f8f1d 40%, var(--ui-border));
  color: #5f8f1d;
}
.fnos-fert__btn:not(:disabled):hover {
  background: color-mix(in srgb, currentColor 10%, var(--ui-surface-strong));
}
.fnos-fert__btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ui-primary) 60%, transparent);
  outline-offset: 1px;
}
.fnos-fert__btn:disabled {
  border-color: var(--ui-border);
  color: var(--ui-subtle);
  background: transparent;
  cursor: not-allowed;
  opacity: 0.6;
}
/* 很窄的卡片（手机两列）只留图标，避免撑破卡片 */
@container (max-width: 104px) {
  .fnos-fert__label {
    display: none;
  }
}
.dark .fnos-fert__btn {
  background: transparent;
}
@media (prefers-reduced-motion: reduce) {
  .fnos-fert__btn {
    transition: none;
  }
}
</style>
