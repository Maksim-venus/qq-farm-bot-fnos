/**
 * 飞牛统一网关路径工具。
 *
 * 飞牛原生包构建时 VITE_BASE=/app/qq-farm-bot/，所有本应用资源、API、Socket.IO
 * 都需要带上该前缀；本地开发时 BASE_URL 为 /。
 */
export const APP_BASE: string = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')

/** 把以 / 开头的本应用地址转换为带网关前缀的地址；外部链接、data:/blob: 原样返回。 */
export function gatewayPath(path: string): string {
  const value = String(path || '')
  if (!value || !value.startsWith('/') || value.startsWith('//'))
    return value
  if (APP_BASE !== '/' && (value === APP_BASE.slice(0, -1) || value.startsWith(APP_BASE)))
    return value
  return `${APP_BASE}${value.slice(1)}`
}
