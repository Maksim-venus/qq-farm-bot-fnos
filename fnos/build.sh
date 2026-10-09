#!/usr/bin/env bash
# 构建 QQ 农场飞牛原生 FPK
#
# 用法：fnos/build.sh [输出目录]        （默认 ./fnos/out）
# 依赖：Node.js 20+、pnpm 10、fnpack（不在 PATH 时自动下载官方 1.2.3 Linux x86 版本）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${ROOT}/fnos/qq-farm-bot"
OUT_DIR="$(mkdir -p "${1:-${ROOT}/fnos/out}" && cd "${1:-${ROOT}/fnos/out}" && pwd)"
STAGE="${OUT_DIR}/stage/qq-farm-bot"
GATEWAY_BASE="/app/qq-farm-bot/"
FNPACK_URL="https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64"

manifest_get() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "${TEMPLATE}/manifest" | head -n 1; }
APP_VERSION="$(manifest_get version)"
DISPLAY_VERSION="${DISPLAY_VERSION:-v1.1.0}"
FPK_NAME="qq-farm-bot_${DISPLAY_VERSION}_native_x86.fpk"

echo "==> 1/5 安装依赖"
cd "${ROOT}"
pnpm install --frozen-lockfile

echo "==> 2/5 构建前端（base=${GATEWAY_BASE}）与后端"
VITE_BASE="${GATEWAY_BASE}" pnpm -C web build
pnpm -C core build:ts

echo "==> 3/5 组装应用目录"
rm -rf "${OUT_DIR}/stage" "${OUT_DIR}/deploy"
mkdir -p "${STAGE}"
cp -a "${TEMPLATE}/." "${STAGE}/"
rm -f "${STAGE}/wizard/.gitkeep"
SERVER="${STAGE}/app/server"
mkdir -p "${SERVER}/core/src/utils" "${SERVER}/web"

# 生产依赖：按 pnpm-lock.yaml 安装，hoisted 布局避免 pnpm 符号链接；纯 JS 依赖，无原生模块
pnpm --config.inject-workspace-packages=true --filter qq-farm-bot deploy --prod --config.node-linker=hoisted "${OUT_DIR}/deploy"
cp -a "${OUT_DIR}/deploy/node_modules" "${SERVER}/core/node_modules"
rm -rf "${SERVER}/core/node_modules/.bin" "${SERVER}/core/node_modules/.pnpm" "${SERVER}/core/node_modules/.modules.yaml"
if [ -n "$(find "${SERVER}/core/node_modules" -name '*.node' -print -quit)" ]; then
    echo "检测到原生 .node 模块，platform=x86 包需确认其架构" >&2
fi
cp -a "${ROOT}/core/package.json" "${SERVER}/core/package.json"
cp -a "${ROOT}/core/client.js" "${SERVER}/core/client.js"
cp -a "${ROOT}/core/dist" "${SERVER}/core/dist"
cp -a "${ROOT}/core/src/gameConfig" "${SERVER}/core/src/gameConfig"
cp -a "${ROOT}/core/src/proto" "${SERVER}/core/src/proto"
cp -a "${ROOT}/core/src/utils/tsdk.wasm" "${ROOT}/core/src/utils/tsdk-wx.wasm" "${SERVER}/core/src/utils/"
cp -a "${ROOT}/web/dist" "${SERVER}/web/dist"
cp -a "${ROOT}/package.json" "${SERVER}/package.json"
# 去掉 source map / 声明文件，减小体积
find "${SERVER}/core/dist" \( -name '*.map' -o -name '*.d.ts' \) -delete

UPSTREAM_COMMIT="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "${SERVER}/BUILD_INFO" <<INFO
app_version=${APP_VERSION}
display_version=${DISPLAY_VERSION}
bot_version=$(node -p "require('${ROOT}/core/package.json').version")
source_commit=${UPSTREAM_COMMIT}
built_at=$(date '+%Y-%m-%d %H:%M:%S %z')
INFO

# 清理 fnpack 会带入产物的垃圾文件
find "${STAGE}" \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '.gitkeep' \) -delete
chmod +x "${STAGE}"/cmd/*

echo "==> 4/5 打包 FPK"
FNPACK="$(command -v fnpack || true)"
if [ -z "${FNPACK}" ]; then
    FNPACK="${OUT_DIR}/fnpack"
    [ -x "${FNPACK}" ] || { curl -fsSL -o "${FNPACK}" "${FNPACK_URL}"; chmod +x "${FNPACK}"; }
fi
cd "${OUT_DIR}/stage"
rm -f ./*.fpk
"${FNPACK}" build --directory "${STAGE}"
BUILT="$(ls -t "${OUT_DIR}"/stage/*.fpk 2>/dev/null | head -n 1 || true)"
[ -z "${BUILT}" ] && BUILT="$(ls -t ./*.fpk "${STAGE}"/*.fpk 2>/dev/null | head -n 1 || true)"
[ -n "${BUILT}" ] || { echo "fnpack 未生成 fpk" >&2; exit 1; }
mv -f "${BUILT}" "${OUT_DIR}/${FPK_NAME}"

echo "==> 5/5 计算 SHA-256"
cd "${OUT_DIR}"
sha256sum "${FPK_NAME}" | tee "${FPK_NAME}.sha256"
echo "完成：${OUT_DIR}/${FPK_NAME}（内部版本 ${APP_VERSION}）"
