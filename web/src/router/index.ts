import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { APP_BASE } from '@/utils/gateway'
import { menuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

const router = createRouter({
  history: createWebHistory(APP_BASE),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: menuRoutes.map(route => ({
        path: route.path,
        name: route.name,
        component: route.component,
        meta: route.meta,
      })),
    },
    {
      path: '/mystery-shop',
      name: 'mystery-shop',
      redirect: to => ({ name: 'game-mall', query: { ...to.query, tab: 'mystery' }, hash: to.hash }),
    },
    {
      // 旧版登录页地址：访问控制已交给飞牛，直接回到首页
      path: '/login',
      redirect: '/',
    },
  ],
})

router.beforeEach(() => {
  NProgress.start()
  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
