#!/usr/bin/env bash
# 把后端打包成 Node 单文件可执行程序（SEA，linux-x64），不依赖系统 Node.js。
#
# 用法：fnos/sea/build-sea.sh <输出目录>
#   产物：<输出目录>/qq-farm-bot（SEA 可执行文件）、<输出目录>/worker.js（账号 worker 线程脚本）
# 前置：已执行 pnpm -C core build:ts（以 core/dist 为打包入口）
# 环境变量：NODE_SEA_VERSION（默认 v22.23.3，官方 linux-x64 二进制，按 SHASUMS256 校验）、SEA_CACHE_DIR、SEA_WORK_DIR
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
NODE_VERSION="${NODE_SEA_VERSION:-v22.23.3}"
CACHE="${SEA_CACHE_DIR:-${ROOT}/fnos/out/cache}"
WORK="${SEA_WORK_DIR:-${ROOT}/fnos/out/sea-work}"
NODE_DIST="node-${NODE_VERSION}-linux-x64"
ESBUILD="${ROOT}/node_modules/.bin/esbuild"
POSTJECT="${ROOT}/node_modules/.bin/postject"

mkdir -p "${CACHE}"
rm -rf "${WORK}" && mkdir -p "${WORK}"

echo "  -> 下载并校验官方 Node.js ${NODE_VERSION} linux-x64"
if [ ! -x "${CACHE}/${NODE_DIST}/bin/node" ]; then
    curl -fsSL -o "${CACHE}/${NODE_DIST}.tar.gz" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.gz"
    curl -fsSL -o "${CACHE}/SHASUMS256-${NODE_VERSION}.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
    (cd "${CACHE}" && grep " ${NODE_DIST}.tar.gz\$" "SHASUMS256-${NODE_VERSION}.txt" | sha256sum -c -)
    tar -xzf "${CACHE}/${NODE_DIST}.tar.gz" -C "${CACHE}"
fi
NODE_BIN="${CACHE}/${NODE_DIST}/bin/node"

# 打进可执行文件本身：即使环境变量丢失也绝不监听 TCP
BANNER="process.env.QQ_FARM_NO_TCP = '1';"
# ws / node-fetch 的可选原生加速模块（运行时 try/catch，不存在时自动回退纯 JS）
EXTERNALS=(--external:bufferutil --external:utf-8-validate --external:encoding)
COMMON=(--bundle --platform=node --target=node22 --format=cjs --legal-comments=none --log-level=warning "${EXTERNALS[@]}")

echo "  -> esbuild 打包主程序与 worker"
"${ESBUILD}" "${ROOT}/fnos/sea/entry.js" "${COMMON[@]}" --banner:js="${BANNER}" --outfile="${WORK}/main.js"
"${ESBUILD}" "${ROOT}/core/dist/core/worker.js" "${COMMON[@]}" --banner:js="${BANNER}" --outfile="${OUT}/worker.js"

echo "  -> 生成 SEA 资源并注入官方 Node 二进制"
cat > "${WORK}/sea-config.json" <<JSON
{
  "main": "${WORK}/main.js",
  "output": "${WORK}/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
JSON
"${NODE_BIN}" --experimental-sea-config "${WORK}/sea-config.json"
cp "${NODE_BIN}" "${OUT}/qq-farm-bot"
chmod u+w "${OUT}/qq-farm-bot"
"${POSTJECT}" "${OUT}/qq-farm-bot" NODE_SEA_BLOB "${WORK}/sea-prep.blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null
chmod 755 "${OUT}/qq-farm-bot"
echo "  -> SEA 完成：${OUT}/qq-farm-bot ($(du -h "${OUT}/qq-farm-bot" | cut -f1))，Node ${NODE_VERSION}"
