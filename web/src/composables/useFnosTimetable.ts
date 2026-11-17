// [fnos-fork] 2026-11-17 好友时间表「还多久可偷」：每 30 秒读一次后端时间表，每秒走一次倒计时
import type { Ref } from 'vue'
import type { FnosTimetableRow } from '@/utils/fnos-timetable'
import { onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import { fnosNormalizeTimetableRows } from '@/utils/fnos-timetable'

const REFRESH_MS = 30_000

export function useFnosTimetable(accountId: Ref<string | number | null | undefined>) {
  const rows = ref<Record<string, FnosTimetableRow>>({})
  const now = ref(Date.now())
  let offset = 0
  let alive = true

  async function refresh() {
    const id = String(accountId.value || '')
    if (!id) {
      rows.value = {}
      return
    }
    try {
      const res = await api.get('/api/fnos/timetable', { skipErrorToast: true, headers: { 'x-account-id': id } } as any)
      if (!alive || id !== String(accountId.value || ''))
        return
      const data = res.data?.ok ? res.data.data : null
      if (data && Number(data.now) > 0)
        offset = Number(data.now) - Date.now()
      const map: Record<string, FnosTimetableRow> = {}
      for (const row of fnosNormalizeTimetableRows(data?.rows))
        map[String(row.gid)] = row
      rows.value = map
    }
    catch {
      // 读不到就显示「未扫描」，不打扰
    }
  }

  const tick = setInterval(() => {
    now.value = Date.now() + offset
  }, 1000)
  const poll = setInterval(() => void refresh(), REFRESH_MS)
  watch(accountId, () => {
    rows.value = {}
    void refresh()
  }, { immediate: true })
  onBeforeUnmount(() => {
    alive = false
    clearInterval(tick)
    clearInterval(poll)
  })

  return { rows, now, refresh }
}
