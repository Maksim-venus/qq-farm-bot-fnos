import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_STORAGE_KEY = 'theme_mode'

// [fnos-fork] 飞牛版只保留浅色且不可修改。忽略 localStorage 里的 dark/system，以及系统 prefers-color-scheme。
function enforceLightTheme() {
  const root = document.documentElement
  root.classList.remove('dark')
  if (root.getAttribute('data-theme') === 'dark')
    root.removeAttribute('data-theme')
  root.style.colorScheme = 'light'
  try {
    // 与原先 vueuse useStorage 一样写成 JSON，老用户已存的 "dark" 会被盖成浅色。
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify('light'))
  }
  catch {
    // 无法写 localStorage 时，本次会话仍然是浅色。
  }
}

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  // 活动详情有自己的标题栏，打开时布局隐藏通用页头并让活动外壳撑满内容区。
  const activityDetailOpen = ref(false)
  const sidebarCollapsed = useStorage('sidebar_collapsed', false)
  // [fnos-fork] 固定浅色，不再从 localStorage 读取主题。
  const themeMode = ref<ThemeMode>('light')
  const isDark = computed(() => false)

  enforceLightTheme()

  function setThemeMode(mode: ThemeMode) {
    // [fnos-fork] 主题入口已去掉；保留函数是为了兼容旧调用，任何值都保持浅色。
    void mode
    themeMode.value = 'light'
    enforceLightTheme()
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return {
    themeMode,
    isDark,
    setThemeMode,
    sidebarOpen,
    sidebarCollapsed,
    activityDetailOpen,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    toggleSidebarCollapsed,
  }
})
