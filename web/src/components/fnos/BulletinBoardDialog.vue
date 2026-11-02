<script setup lang="ts">
// [fnos-fork] 页头「游戏公告」：只读弹窗。请求走 Axios baseURL（与 gatewayPath() 同一网关前缀）。
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NSpin } from 'naive-ui/es/spin'
import { storeToRefs } from 'pinia'
import { ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { bulletinImageSrc, bulletinReadLabel, bulletinTypeLabel } from '@/utils/fnos-bulletin'

interface BulletinItem {
  id: number
  title: string
  status: number
  read: boolean
  type: number
  imageUrl: string
}

interface BulletinDetail {
  id: number
  title: string
  content: string
  beginTime: string
  endTime: string
  imageUrl: string
}

const show = defineModel<boolean>('show', { default: false })

const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)

const loading = ref(false)
const detailLoading = ref(false)
const error = ref('')
const detailError = ref('')
const items = ref<BulletinItem[]>([])
const selected = ref<BulletinItem | null>(null)
const detail = ref<BulletinDetail | null>(null)
const brokenImages = ref<string[]>([])
let listSeq = 0
let detailSeq = 0

watch(show, (open) => {
  if (!open) {
    selected.value = null
    detail.value = null
    detailError.value = ''
    return
  }
  void loadList()
})

watch(currentAccountId, () => {
  if (show.value)
    void loadList()
})

function requestOptions(accountId: string) {
  return {
    params: { accountId },
    headers: { 'x-account-id': accountId },
    skipErrorToast: true,
  }
}

async function loadList() {
  const accountId = String(currentAccountId.value || '')
  const seq = ++listSeq
  detailSeq += 1
  selected.value = null
  detail.value = null
  detailError.value = ''
  error.value = ''
  items.value = []
  brokenImages.value = []
  if (!accountId) {
    error.value = '请先选择账号'
    loading.value = false
    return
  }
  loading.value = true
  try {
    const { data } = await api.get('/api/fnos/bulletins', requestOptions(accountId) as any)
    if (seq !== listSeq)
      return
    if (!data?.ok) {
      error.value = data?.error || '游戏公告加载失败'
      return
    }
    const rows = data.data?.bulletins
    items.value = Array.isArray(rows) ? rows : []
  }
  catch (reason) {
    if (seq !== listSeq)
      return
    error.value = getApiErrorMessage(reason, '游戏公告加载失败')
  }
  finally {
    if (seq === listSeq)
      loading.value = false
  }
}

async function openDetail(item: BulletinItem) {
  const accountId = String(currentAccountId.value || '')
  selected.value = item
  detail.value = null
  detailError.value = ''
  if (!accountId) {
    detailError.value = '请先选择账号'
    return
  }
  const seq = ++detailSeq
  detailLoading.value = true
  try {
    const { data } = await api.get(`/api/fnos/bulletins/${encodeURIComponent(String(item.id))}`, requestOptions(accountId) as any)
    if (seq !== detailSeq)
      return
    if (!data?.ok) {
      detailError.value = data?.error || '公告正文加载失败'
      return
    }
    detail.value = data.data || null
    if (!detail.value)
      detailError.value = '公告正文加载失败'
  }
  catch (reason) {
    if (seq !== detailSeq)
      return
    detailError.value = getApiErrorMessage(reason, '公告正文加载失败')
  }
  finally {
    if (seq === detailSeq)
      detailLoading.value = false
  }
}

function backToList() {
  selected.value = null
  detail.value = null
  detailError.value = ''
}

function imageOf(url: unknown): string {
  const src = bulletinImageSrc(url)
  if (!src || brokenImages.value.includes(src))
    return ''
  return src
}

function markImageBroken(url: unknown) {
  const src = bulletinImageSrc(url)
  if (src && !brokenImages.value.includes(src))
    brokenImages.value = [...brokenImages.value, src]
}

function close() {
  show.value = false
}
</script>

<template>
  <NModal
    v-model:show="show"
    :mask-closable="true"
    :close-on-esc="true"
    :auto-focus="false"
  >
    <NCard
      class="bulletin-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="游戏公告"
      :bordered="false"
      title="游戏公告"
      :closable="true"
      @close="close"
    >
      <template v-if="selected" #header-extra>
        <NButton size="small" quaternary @click="backToList">
          返回
        </NButton>
      </template>

      <div v-if="selected" class="bulletin-detail">
        <h2 class="bulletin-detail__title">
          {{ detail?.title || selected.title || '未命名公告' }}
        </h2>
        <p class="bulletin-detail__meta">
          <span v-if="bulletinReadLabel(selected.status)" class="bulletin-badge" :data-read="selected.read ? 'yes' : 'no'">
            {{ bulletinReadLabel(selected.status) }}
          </span>
          <span v-if="bulletinTypeLabel(selected.type)">{{ bulletinTypeLabel(selected.type) }}</span>
          <span>编号 {{ selected.id }}</span>
        </p>
        <p v-if="detail?.beginTime || detail?.endTime" class="bulletin-detail__time">
          <span v-if="detail?.beginTime">开始 {{ detail.beginTime }}</span>
          <span v-if="detail?.endTime">结束 {{ detail.endTime }}</span>
        </p>
        <img
          v-if="imageOf(detail?.imageUrl || selected.imageUrl)"
          class="bulletin-detail__image"
          :src="imageOf(detail?.imageUrl || selected.imageUrl)"
          :alt="detail?.title || selected.title || '公告图片'"
          referrerpolicy="no-referrer"
          @error="markImageBroken(detail?.imageUrl || selected.imageUrl)"
        >
        <div v-if="detailLoading" class="bulletin-dialog__loading">
          <NSpin size="small" />
          <span>正在读取正文</span>
        </div>
        <EmptyState
          v-else-if="detailError"
          bare
          tone="error"
          icon="i-carbon-warning"
          title="正文没有载入"
          :description="detailError"
        >
          <NButton size="small" @click="openDetail(selected)">
            重试
          </NButton>
        </EmptyState>
        <div v-else class="bulletin-content">
          {{ detail?.content || '这条公告没有正文' }}
        </div>
      </div>

      <div v-else-if="loading" class="bulletin-dialog__loading">
        <NSpin size="medium" />
        <span>正在读取游戏公告</span>
      </div>
      <EmptyState
        v-else-if="error"
        bare
        tone="error"
        icon="i-carbon-warning"
        title="公告没有载入"
        :description="error"
      >
        <NButton size="small" @click="loadList">
          重试
        </NButton>
      </EmptyState>
      <EmptyState
        v-else-if="items.length === 0"
        bare
        icon="i-carbon-document"
        title="暂无游戏公告"
        description="当前账号没有可显示的公告。"
      />
      <ul v-else class="bulletin-list">
        <li v-for="item in items" :key="item.id">
          <button type="button" class="bulletin-row" @click="openDetail(item)">
            <img
              v-if="imageOf(item.imageUrl)"
              class="bulletin-row__image"
              :src="imageOf(item.imageUrl)"
              alt=""
              referrerpolicy="no-referrer"
              @error="markImageBroken(item.imageUrl)"
            >
            <span class="bulletin-row__main">
              <span class="bulletin-row__title">{{ item.title || '未命名公告' }}</span>
              <span class="bulletin-row__meta">
                <span v-if="bulletinTypeLabel(item.type)">{{ bulletinTypeLabel(item.type) }}</span>
                <span>编号 {{ item.id }}</span>
              </span>
            </span>
            <span v-if="bulletinReadLabel(item.status)" class="bulletin-badge" :data-read="item.read ? 'yes' : 'no'">
              {{ bulletinReadLabel(item.status) }}
            </span>
          </button>
        </li>
      </ul>
    </NCard>
  </NModal>
</template>

<style scoped>
.bulletin-dialog {
  width: min(640px, calc(100vw - 24px));
}

.bulletin-dialog :deep(.n-card__content) {
  max-height: min(72dvh, 640px);
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

.bulletin-dialog__loading {
  display: flex;
  min-height: 160px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ui-muted);
  font-size: 14px;
}

.bulletin-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.bulletin-row {
  display: flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-solid);
  color: var(--ui-ink);
  text-align: left;
  cursor: pointer;
}

.bulletin-row:hover,
.bulletin-row:focus-visible {
  border-color: var(--ui-border-strong);
  background: var(--ui-primary-soft);
  outline: none;
}

.bulletin-row__image {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 8px;
  object-fit: cover;
  background: var(--ui-surface-soft);
}

.bulletin-row__main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bulletin-row__title {
  overflow: hidden;
  font-size: 15px;
  font-weight: var(--fw-650, 600);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bulletin-row__meta,
.bulletin-detail__meta,
.bulletin-detail__time {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

.bulletin-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.6;
}

.bulletin-badge[data-read='yes'] {
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
}

.bulletin-badge[data-read='no'] {
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
}

.bulletin-detail__title {
  margin: 0 0 8px;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: var(--fw-700, 700);
  line-height: 1.4;
}

.bulletin-detail__image {
  display: block;
  width: 100%;
  max-height: 220px;
  margin: 12px 0;
  border-radius: 12px;
  object-fit: contain;
  background: var(--ui-surface-soft);
}

.bulletin-content {
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  user-select: text;
}

@media (max-width: 640px) {
  .bulletin-dialog {
    width: min(640px, calc(100vw - 16px));
  }

  .bulletin-detail__title {
    font-size: 17px;
  }

  .bulletin-row__title {
    white-space: normal;
  }
}
</style>
