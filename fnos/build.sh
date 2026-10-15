#!/usr/bin/env bash
# 构建 QQ 农场飞牛原生 FPK
#
# 用法：fnos/build.sh [输出目录]        （默认 ./fnos/out）
# 依赖：Node.js 20+、pnpm 10、curl；fnpack 不在 PATH 时自动下载官方 1.2.3 Linux x86 版本
# 后端打包为 Node 单文件可执行程序（SEA，见 fnos/sea/build-sea.sh），安装包不依赖飞牛 Node.js
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${ROOT}/fnos/qq-farm-bot"
OUT_DIR="$(mkdir -p "${1:-${ROOT}/fnos/out}" && cd "${1:-${ROOT}/fnos/out}" && pwd)"
STAGE="${OUT_DIR}/stage/qq-farm-bot"
GATEWAY_BASE="/app/qq-farm-bot/"
FNPACK_URL="https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64"

manifest_get() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "${TEMPLATE}/manifest" | head -n 1; }
APP_VERSION="$(manifest_get version)"
DISPLAY_VERSION="${DISPLAY_VERSION:-v1.2.2}"
FPK_NAME="qq-farm-bot_${DISPLAY_VERSION}_native_x86.fpk"

echo "==> 1/5 安装依赖"
cd "${ROOT}"
pnpm install --frozen-lockfile

echo "==> 2/5 构建前端（base=${GATEWAY_BASE}）与后端"
VITE_BASE="${GATEWAY_BASE}" pnpm -C web build
pnpm -C core build:ts

echo "==> 3/5 组装应用目录"
rm -rf "${OUT_DIR}/stage" "${OUT_DIR}/deploy" "${OUT_DIR}/sea-work"
mkdir -p "${STAGE}"
cp -a "${TEMPLATE}/." "${STAGE}/"
rm -f "${STAGE}/wizard/.gitkeep"
SERVER="${STAGE}/app/server"
mkdir -p "${SERVER}/bin" "${SERVER}/resources/utils" "${SERVER}/web"

# 后端：esbuild 打包 + Node SEA 单文件可执行程序（内置官方 Node.js linux-x64）
# 依赖均为纯 JS（已检查无 .node 原生模块），全部打进可执行文件，不再携带 node_modules
if [ -n "$(find -L "${ROOT}/core/node_modules" -name '*.node' -print -quit 2>/dev/null)" ]; then
    echo "检测到原生 .node 模块，需随包提供 linux-x64 预编译文件" >&2
    exit 1
fi
SEA_CACHE_DIR="${OUT_DIR}/cache" SEA_WORK_DIR="${OUT_DIR}/sea-work" "${ROOT}/fnos/sea/build-sea.sh" "${SERVER}/bin"
NODE_SEA_VERSION="${NODE_SEA_VERSION:-v22.23.3}"
cp -a "${OUT_DIR}/cache/node-${NODE_SEA_VERSION}-linux-x64/LICENSE" "${SERVER}/bin/NODE_LICENSE"
# 标记为飞牛原生包：服务端检测到该文件后绝不监听 TCP（可执行文件本身也已内置该限制）
echo "fnOS native package: TCP listening is disabled, gateway unix socket only." > "${SERVER}/bin/FNOS_NATIVE"

# 静态资源以普通文件放在可执行文件旁边
cp -a "${ROOT}/core/src/gameConfig" "${SERVER}/resources/gameConfig"
cp -a "${ROOT}/core/src/proto" "${SERVER}/resources/proto"
rm -f "${SERVER}/resources/proto/"*.bak
cp -a "${ROOT}/core/src/utils/tsdk.wasm" "${ROOT}/core/src/utils/tsdk-wx.wasm" "${SERVER}/resources/utils/"
cp -a "${ROOT}/web/dist" "${SERVER}/web/dist"

UPSTREAM_COMMIT="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "${SERVER}/BUILD_INFO" <<INFO
app_version=${APP_VERSION}
display_version=${DISPLAY_VERSION}
bot_version=$(node -p "require('${ROOT}/core/package.json').version")
source_commit=${UPSTREAM_COMMIT}
runtime=node-sea ${NODE_SEA_VERSION} linux-x64
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
