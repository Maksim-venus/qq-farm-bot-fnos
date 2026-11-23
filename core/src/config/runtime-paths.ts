export {};
const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntimePaths, resolveWebRootInfo } = require('@qq-farm-bot/session-contract');
const isPackaged: boolean = !!(process as any).pkg;

/** 是否运行在 Node 单文件可执行程序（SEA）中（飞牛原生包 V1.2.0 起）。 */
function detectSea(): boolean {
    try {
        return !!require('node:sea').isSea();
    } catch {
        return false;
    }
}
const isSea: boolean = detectSea();

/**
 * SEA 可执行文件所在目录的上一级（飞牛包中为 server/），
 * 静态资源与可执行文件分开存放：bin/、resources/、web/dist/。
 */
function getSeaRoot(): string {
    return path.join(path.dirname(process.execPath), '..');
}

function getResourceRoot(): string {
    // [fnos-fork] SEA / 飞牛包：优先环境变量和 server/resources，不走 pkg 的 src 回退。
    const override = String(process.env.QQ_FARM_RESOURCE_DIR || '').trim();
    if (override) return path.resolve(override);
    if (isSea) return path.join(getSeaRoot(), 'resources');

    const parent = path.join(__dirname, '..');
    // 编译和（上游 pkg）打包后仍从 src 读取协议、配置和 WASM 等静态资源。
    if (path.basename(parent) === 'dist') return path.join(parent, '..', 'src');
    return parent;
}

function getResourcePath(...segments: string[]): string {
    return path.join(getResourceRoot(), ...segments);
}

function getAppRootForWritable(): string {
    if (isSea) return getSeaRoot();
    return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '../..');
}

function getRuntimePaths() {
    const appRoot = getAppRootForWritable();
    // [fnos-fork] 飞牛原生包：数据、运行时目录都放在 QQ_FARM_DATA_DIR（${TRIM_PKGVAR}/data）下，安装目录保持只读；
    // 前端目录沿用 getWebDistDir（QQ_FARM_WEB_DIR / SEA 的 server/web/dist）。
    const fnosDataDir = String(process.env.QQ_FARM_DATA_DIR || '').trim();
    const defaultRuntimeDir = fnosDataDir
        ? path.join(path.resolve(fnosDataDir), 'runtime')
        : (isPackaged ? path.join(appRoot, 'runtime') : path.resolve(appRoot, '../runtime'));
    return resolveRuntimePaths({
        appRoot,
        isPackaged,
        defaultDataDir: getDataDir(),
        defaultRuntimeDir,
        defaultResourceRoot: getResourceRoot(),
        defaultWebRoot: getWebDistDir(path.resolve(__dirname, '../../../web/dist')),
        defaultShareFilePath: getShareFilePath(),
    });
}

function getWebRootInfo() {
    return resolveWebRootInfo(getRuntimePaths().runtimeDir, getWebDistDir(path.resolve(__dirname, '../../../web/dist')));
}

function getDataDir(): string {
    // 飞牛原生包通过 QQ_FARM_DATA_DIR 指向 ${TRIM_PKGVAR}/data，安装目录保持只读
    const override = String(process.env.QQ_FARM_DATA_DIR || '').trim();
    if (override) return path.resolve(override);
    return path.join(getAppRootForWritable(), 'data');
}

function ensureDataDir(): string {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getDataFile(filename: string): string {
    return path.join(getDataDir(), filename);
}

function getShareFilePath(): string {
    if (String(process.env.QQ_FARM_DATA_DIR || '').trim()) return path.join(getDataDir(), 'share.txt');
    return path.join(getAppRootForWritable(), 'share.txt');
}

/** 前端构建目录：QQ_FARM_WEB_DIR > SEA 默认（server/web/dist）> 源码默认（由调用方传入）。 */
function getWebDistDir(fallback: string): string {
    const override = String(process.env.QQ_FARM_WEB_DIR || '').trim();
    if (override) return path.resolve(override);
    if (isSea) return path.join(getSeaRoot(), 'web', 'dist');
    return fallback;
}

/** 账号 worker 脚本：QQ_FARM_WORKER_SCRIPT > SEA 默认（bin/worker.js）> 源码默认（由调用方传入）。 */
function getWorkerScriptPath(fallback: string): string {
    const override = String(process.env.QQ_FARM_WORKER_SCRIPT || '').trim();
    if (override) return path.resolve(override);
    if (isSea) return path.join(path.dirname(process.execPath), 'worker.js');
    return fallback;
}

module.exports = {
    isPackaged,
    isSea,
    getWebDistDir,
    getWorkerScriptPath,
    getResourcePath,
    getRuntimePaths,
    getWebRootInfo,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
