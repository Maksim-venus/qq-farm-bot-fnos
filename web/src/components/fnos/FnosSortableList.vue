<script setup lang="ts">
// [fnos-fork] 可拖动排序的列表容器（pointer events 实现，鼠标和触屏都能用，不加依赖）。
// 用法：子项根元素带 data-fnos-sort-index="下标"，拖动手柄的 pointerdown 调用插槽里的 startDrag(index, event)；
// 松手时发出 move(from, to)，由父组件改同一个数组的顺序。拖动中通过 indicatorFor(index) 提供插入位置提示，
// 拖到滚动区上下边缘会自动滚动。只有按住手柄才进入拖动，手柄外的区域照常滑动页面。
import type { FnosSortAxis, FnosSortDropTarget, FnosSortRect, FnosSortSide } from '@/utils/fnos-sort-order'
import { computed, onBeforeUnmount, ref } from 'vue'
import { fnosComputeDropTarget, fnosEdgeScrollSpeed } from '@/utils/fnos-sort-order'

const props = defineProps<{
  itemCount: number
}>()

const emit = defineEmits<{
  move: [from: number, to: number]
}>()

const container = ref<HTMLElement | null>(null)
const draggingIndex = ref<number | null>(null)
const target = ref<FnosSortDropTarget | null>(null)
const moved = ref(false)
const pointer = ref({ x: 0, y: 0 })

let pointerId: number | null = null
let startPoint = { x: 0, y: 0 }
let scrollParent: HTMLElement | null = null
let rafId = 0
let previousUserSelect = ''

const MOVE_THRESHOLD = 4

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    if (/auto|scroll|overlay/.test(style.overflowY) && node.scrollHeight > node.clientHeight)
      return node
    node = node.parentElement
  }
  return null
}

function itemElements() {
  const root = container.value
  if (!root)
    return []
  return Array.from(root.querySelectorAll<HTMLElement>('[data-fnos-sort-index]'))
    .filter(el => el.closest('[data-fnos-sort-root]') === root)
    .sort((a, b) => Number(a.dataset.fnosSortIndex) - Number(b.dataset.fnosSortIndex))
}

function updateTarget() {
  if (draggingIndex.value === null)
    return
  const rects: FnosSortRect[] = itemElements().map((el) => {
    const rect = el.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
  target.value = fnosComputeDropTarget(rects, pointer.value, draggingIndex.value)
}

function scrollStep() {
  rafId = 0
  if (draggingIndex.value === null || !moved.value)
    return
  const bounds = scrollParent
    ? scrollParent.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight }
  const start = Math.max(0, bounds.top)
  const end = Math.min(window.innerHeight, bounds.bottom)
  const speed = fnosEdgeScrollSpeed(pointer.value.y, start, end)
  if (speed !== 0) {
    if (scrollParent)
      scrollParent.scrollTop += speed
    else
      window.scrollBy(0, speed)
    updateTarget()
  }
  rafId = requestAnimationFrame(scrollStep)
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerId !== pointerId)
    return
  pointer.value = { x: event.clientX, y: event.clientY }
  if (!moved.value) {
    if (Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) < MOVE_THRESHOLD)
      return
    moved.value = true
    if (!rafId)
      rafId = requestAnimationFrame(scrollStep)
  }
  event.preventDefault()
  updateTarget()
}

function cleanup() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('keydown', onKeyDown)
  if (rafId)
    cancelAnimationFrame(rafId)
  rafId = 0
  if (typeof document !== 'undefined')
    document.body.style.userSelect = previousUserSelect
  pointerId = null
  scrollParent = null
  draggingIndex.value = null
  target.value = null
  moved.value = false
}

function onPointerUp(event: PointerEvent) {
  if (event.pointerId !== pointerId)
    return
  const from = draggingIndex.value
  if (moved.value) {
    pointer.value = { x: event.clientX, y: event.clientY }
    updateTarget()
  }
  const to = moved.value ? target.value?.finalIndex : undefined
  cleanup()
  if (from !== null && to !== undefined && to !== from)
    emit('move', from, to)
}

function onPointerCancel(event: PointerEvent) {
  if (event.pointerId === pointerId)
    cleanup()
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape')
    cleanup()
}

function startDrag(index: number, event: PointerEvent) {
  if (draggingIndex.value !== null || index < 0 || index >= props.itemCount)
    return
  if (event.pointerType === 'mouse' && event.button !== 0)
    return
  event.preventDefault()
  pointerId = event.pointerId
  startPoint = { x: event.clientX, y: event.clientY }
  pointer.value = { ...startPoint }
  draggingIndex.value = index
  moved.value = false
  scrollParent = findScrollParent(container.value)
  previousUserSelect = document.body.style.userSelect
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onPointerMove, { passive: false })
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('keydown', onKeyDown)
}

function indicatorFor(index: number): { side: FnosSortSide, axis: FnosSortAxis } | null {
  const current = target.value
  if (!moved.value || !current || draggingIndex.value === null || current.finalIndex === draggingIndex.value)
    return null
  if (current.hoverIndex !== index)
    return null
  return { side: current.side, axis: current.axis }
}

const ghostLabel = computed(() => {
  if (!moved.value || draggingIndex.value === null)
    return ''
  const finalIndex = target.value?.finalIndex ?? draggingIndex.value
  return finalIndex === draggingIndex.value ? `第 ${finalIndex + 1} 位（不变）` : `移到第 ${finalIndex + 1} 位`
})

// 提示气泡放在指针右上方（手机上不被手指挡住），靠右边时贴着屏幕边缘不换行。
const ghostStyle = computed(() => {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  const left = Math.max(4, Math.min(pointer.value.x + 14, width - 120))
  return { left: `${left}px`, top: `${Math.max(4, pointer.value.y - 44)}px` }
})

onBeforeUnmount(cleanup)
</script>

<template>
  <div ref="container" data-fnos-sort-root>
    <slot
      :start-drag="startDrag"
      :dragging-index="moved ? draggingIndex : null"
      :indicator-for="indicatorFor"
    />
    <Teleport to="body">
      <div
        v-if="ghostLabel"
        class="pointer-events-none fixed z-[3000] whitespace-nowrap rounded-full bg-amber-500 px-2.5 py-1 text-xs text-white font-semibold shadow-lg"
        :style="ghostStyle"
      >
        {{ ghostLabel }}
      </div>
    </Teleport>
  </div>
</template>
