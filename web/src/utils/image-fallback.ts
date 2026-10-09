/**
 * 图片兜底：本地没有对应资源（例如游戏新增、尚未收录的锦囊或道具）时，
 * 显示内置占位图，而不是空 src 或 404 裂图。占位图为内联 SVG，不依赖网关路径。
 */
export const IMAGE_PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<rect x="4" y="4" width="56" height="56" rx="14" fill="#eef2e8" stroke="#c9d3bf" stroke-width="2"/>'
  + '<path d="M32 44c-6-2-10-7-10-13 0-1 0-2 .3-3 4 0 7.7 1.7 9.7 4.4 2-2.7 5.7-4.4 9.7-4.4.3 1 .3 2 .3 3 0 6-4 11-10 13z" fill="#a9b99a"/>'
  + '<path d="M32 33V22" stroke="#a9b99a" stroke-width="2.5" stroke-linecap="round"/>'
  + '</svg>',
)}`

/** 返回可用的图片地址；为空时返回占位图。 */
export function imageOrPlaceholder(src?: string | null): string {
  const value = String(src || '').trim()
  return value || IMAGE_PLACEHOLDER
}

/**
 * 全局兜底：任何 <img> 加载失败（404、空 src）时换成占位图。
 * 只替换一次，避免占位图本身失败时循环；带 data-no-fallback 的图片不处理。
 */
export function installImageFallback(root: Document = document): void {
  root.addEventListener('error', (event) => {
    const target = event.target
    if (!(target instanceof HTMLImageElement))
      return
    if (target.dataset.noFallback !== undefined || target.dataset.fallbackApplied === '1')
      return
    target.dataset.fallbackApplied = '1'
    target.src = IMAGE_PLACEHOLDER
  }, true)
}
