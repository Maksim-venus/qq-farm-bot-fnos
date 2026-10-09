import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface NasUser {
  uid: string
  username: string
  isAdmin: boolean
  viaGateway: boolean
}

/** 当前飞牛用户（由飞牛统一网关通过 X-Trim-* Header 提供） */
export const useNasUserStore = defineStore('nas-user', () => {
  const user = ref<NasUser | null>(null)

  async function fetchUser() {
    try {
      const { data } = await api.get('/api/fnos/me', { skipErrorToast: true } as any)
      if (data?.ok)
        user.value = data.data
    }
    catch {
      user.value = null
    }
  }

  return { user, fetchUser }
})
