<script setup lang="ts">
import { NConfigProvider } from 'naive-ui/es/config-provider'
import { NDialogProvider } from 'naive-ui/es/dialog'
import { NGlobalStyle } from 'naive-ui/es/global-style'
import { dateZhCN, zhCN } from 'naive-ui/es/locales'
import { NMessageProvider } from 'naive-ui/es/message'
import { NNotificationProvider } from 'naive-ui/es/notification'
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterView } from 'vue-router'
import PanelStatusBanner from '@/components/PanelStatusBanner.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { useAppUpdateStore } from '@/stores/app-update'
import { useStatusStore } from '@/stores/status'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'

// [fnos-fork] 固定浅色，不再使用 naive-ui darkTheme。
const themeOverrides = createNaiveThemeOverrides()

// 上游 #182：实时连接重连 / 服务端前端构建号变化时检查面板版本（飞牛版 fpk 升级后自动刷新到新页面）。
const appUpdateStore = useAppUpdateStore()
const statusStore = useStatusStore()
const { realtimeReconnecting, realtimeReconnectCount, serverWebBuildId } = storeToRefs(statusStore)

watch([realtimeReconnecting, realtimeReconnectCount], ([reconnecting, count]) => {
  appUpdateStore.syncSocketState(reconnecting, count)
}, { immediate: true })

watch(serverWebBuildId, (buildId) => {
  if (buildId)
    appUpdateStore.observeBuildId(buildId)
}, { immediate: true })

onMounted(() => {
  appUpdateStore.startMonitoring()
})

onBeforeUnmount(() => {
  appUpdateStore.stopMonitoring()
})
</script>

<template>
  <NConfigProvider
    :theme="null"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NGlobalStyle />
    <NMessageProvider placement="top-right" :max="4" keep-alive-on-hover>
      <NDialogProvider>
        <NNotificationProvider placement="top-right" :max="4">
          <div class="app-shell h-screen w-screen overflow-hidden">
            <RouterView />
            <PanelStatusBanner />
            <ToastContainer />
          </div>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
