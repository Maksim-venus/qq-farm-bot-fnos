#!/usr/bin/env bash
# 构建 QQ 农场飞牛原生 FPK
#
# 用法：fnos/build.sh [输出目录]        （默认 ./fnos/out）
# 版本（见变更说明「版本号规则」）：版本号 = 构建日期（Asia/Shanghai）YYYY.M.D，不补零，例如 2026.10.19；
#   同一天已有发布时依次加第 4 段 .1、.2、.3……（如 2026.10.19.1）。同一版本号用于 manifest version、
#   Release tag v<版本>-fnos、标题与安装包文件名 qq-farm-bot_<版本>_native_x86.fpk。
#   自动选号依据：模板 manifest 的 version（上次发布）与远端仓库已有的 v*-fnos tag（取最大者），按数字逐段比较。
#   可用 FPK_VERSION=2026.10.19.2 指定，但必须严格高于上次发布；本地测试可设 ALLOW_NOT_NEWER=1 跳过检查。
#   VERSION_ONLY=1 只输出将使用的版本号。RELEASE_REMOTE 指定查询 tag 的远端（默认 fork，不存在或离线时只用模板 manifest）。
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
VERSION_RE='^[1-9][0-9]*(\.(0|[1-9][0-9]*)){2,3}$'
# 按数字逐段比较（缺少的段视为 0）：$1 > $2 时返回 0
version_gt() {
    local IFS=. i
    local -a a=($1) b=($2)
    for i in 0 1 2 3; do
        if (( ${a[i]:-0} > ${b[i]:-0} )); then return 0; fi
        if (( ${a[i]:-0} < ${b[i]:-0} )); then return 1; fi
    done
    return 1
}
# 上次发布：模板 manifest 与远端 v*-fnos tag 中最大者
LAST_VERSION="$(manifest_get version)"
RELEASE_REMOTE="${RELEASE_REMOTE:-fork}"
if git -C "${ROOT}" remote get-url "${RELEASE_REMOTE}" >/dev/null 2>&1; then
    while read -r tag_ver; do
        [[ "${tag_ver}" =~ ${VERSION_RE} ]] || continue
        if [ -z "${LAST_VERSION}" ] || version_gt "${tag_ver}" "${LAST_VERSION}"; then LAST_VERSION="${tag_ver}"; fi
    done < <(timeout 30 git -C "${ROOT}" ls-remote --tags --refs "${RELEASE_REMOTE}" 'v*-fnos' 2>/dev/null \
        | sed -n 's#.*refs/tags/v\(.*\)-fnos$#\1#p')
fi

if [ -n "${FPK_VERSION:-}" ]; then
    APP_VERSION="${FPK_VERSION}"
else
    TODAY="$(TZ=Asia/Shanghai date '+%Y.%-m.%-d')"
    APP_VERSION="${TODAY}"
    if [ -n "${LAST_VERSION}" ]; then
        IFS=. read -r l1 l2 l3 l4 <<<"${LAST_VERSION}"
        if [ "${l1}.${l2}.${l3}" = "${TODAY}" ]; then
            APP_VERSION="${TODAY}.$(( ${l4:-0} + 1 ))"   # 同一天再次发布：.1、.2、.3……
            echo "==> 今天已发布 ${LAST_VERSION}，本次使用 ${APP_VERSION}" >&2
        fi
    fi
fi
if ! [[ "${APP_VERSION}" =~ ${VERSION_RE} ]]; then
    echo "版本号格式无效：${APP_VERSION}（应为不补零的 YYYY.M.D 或 YYYY.M.D.N，如 2026.10.19、2026.10.19.1）" >&2
    exit 1
fi
if [ -n "${LAST_VERSION}" ] && ! version_gt "${APP_VERSION}" "${LAST_VERSION}" && [ "${ALLOW_NOT_NEWER:-0}" != "1" ]; then
    echo "版本 ${APP_VERSION} 不高于上次发布的 ${LAST_VERSION}，飞牛应用中心不会把它当作升级。" >&2
    echo "如只是本地测试，可设置 ALLOW_NOT_NEWER=1；正式发布请换用更高的版本号。" >&2
    exit 1
fi
# 只输出将使用的版本号（不构建），便于检查或供 CI 使用
if [ "${VERSION_ONLY:-0}" = "1" ]; then echo "${APP_VERSION}"; exit 0; fi
FPK_NAME="qq-farm-bot_${APP_VERSION}_native_x86.fpk"
echo "==> 版本 ${APP_VERSION}（上次发布 ${LAST_VERSION:-无}）"

echo "==> 1/5 安装依赖"
cd "${ROOT}"
pnpm install --frozen-lockfile

echo "==> 2/5 构建前端（base=${GATEWAY_BASE}）与后端"
# 飞牛改动：把本次 APP_VERSION 注入前端（侧栏「fpk v…」），与 manifest version 同源
VITE_BASE="${GATEWAY_BASE}" FPK_VERSION="${APP_VERSION}" pnpm -C web build
pnpm -C core build:ts

echo "==> 3/5 组装应用目录"
rm -rf "${OUT_DIR}/stage" "${OUT_DIR}/deploy" "${OUT_DIR}/sea-work"
mkdir -p "${STAGE}"
cp -a "${TEMPLATE}/." "${STAGE}/"
# 写入本次构建版本
sed -i "s/^version[[:space:]]*=.*/version               = ${APP_VERSION}/" "${STAGE}/manifest"
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
echo "完成：${OUT_DIR}/${FPK_NAME}（版本 ${APP_VERSION}）"
echo "发布后请把 fnos/qq-farm-bot/manifest 的 version 更新为 ${APP_VERSION}（tag 为 v${APP_VERSION}-fnos）。"
