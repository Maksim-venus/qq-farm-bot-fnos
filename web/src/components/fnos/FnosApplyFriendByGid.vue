<script setup lang="ts">
// [fnos-fork] 好友页「按 GID 加好友（测试）」，默认收起。
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useAccountStore } from '@/stores/account'

const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)

const gidText = ref('')
const pending = ref(false)
const resultText = ref('')
const resultOk = ref<boolean | null>(null)

async function submit() {
  const gid = Number(String(gidText.value).trim())
  if (!currentAccountId.value) {
    resultOk.value = false
    resultText.value = '请先选择账号'
    return
  }
  if (!Number.isFinite(gid) || gid <= 0) {
    resultOk.value = false
    resultText.value = '请输入有效的 GID'
    return
  }

  pending.value = true
  resultText.value = ''
  resultOk.value = null
  try {
    const res = await api.post(`/api/friend/${gid}/apply`, {}, { skipErrorToast: true } as any)
    const payload = res.data || {}
    const data = payload.data || {}
    resultOk.value = !!payload.ok
    const prefix = data.applyKeyPrefix ? `，凭证 ${data.applyKeyPrefix}` : ''
    const enterText = data.enterOk === false ? 'Enter 失败' : (data.enterOk ? 'Enter 成功' : '')
    if (payload.ok) {
      resultText.value = `已向 GID ${gid} 发送好友申请${enterText ? `（${enterText}${prefix}）` : ''}`
      return
    }
    const message = getApiErrorMessage(payload, '加好友失败')
    const code = data.errorCode || payload.errorCode
    const head = [enterText, prefix.replace(/^，/, '')].filter(Boolean).join('，')
    resultText.value = `${head ? `${head}。` : ''}${message}${code ? `（错误码 ${code}）` : ''}`
  }
  catch (error: any) {
    resultOk.value = false
    resultText.value = getApiErrorMessage(error, '加好友失败')
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <details class="fnos-apply-friend">
    <summary>按 GID 加好友（测试）</summary>
    <p class="fnos-apply-friend__hint">
      先进入对方农场读取加好友凭证，再发送申请。进不去时显示服务器原始错误，不会编造凭证。
    </p>
    <div class="fnos-apply-friend__row">
      <BaseInput
        v-model="gidText"
        label="对方 GID"
        placeholder="输入 GID"
        :disabled="pending"
      />
      <BaseButton
        variant="primary"
        size="sm"
        :loading="pending"
        :disabled="pending"
        @click="submit"
      >
        申请加好友
      </BaseButton>
    </div>
    <p
      v-if="resultText"
      class="fnos-apply-friend__result"
      :class="resultOk ? 'is-ok' : 'is-error'"
    >
      {{ resultText }}
    </p>
  </details>
</template>

<style scoped>
.fnos-apply-friend {
  border: 1px dashed var(--ui-border, #d1d5db);
  border-radius: 12px;
  background: var(--ui-card, #fff);
  padding: 8px 12px;
  font-size: 13px;
}

.fnos-apply-friend summary {
  cursor: pointer;
  color: var(--ui-text-secondary, #6b7280);
  user-select: none;
}

.fnos-apply-friend__hint {
  margin: 8px 0 0;
  color: var(--ui-text-secondary, #6b7280);
  font-size: 12px;
}

.fnos-apply-friend__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.fnos-apply-friend__row :deep(.base-input),
.fnos-apply-friend__row > :first-child {
  flex: 1 1 180px;
  min-width: 160px;
}

.fnos-apply-friend__result {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.fnos-apply-friend__result.is-ok {
  color: #15803d;
}

.fnos-apply-friend__result.is-error {
  color: #b91c1c;
}
</style>
