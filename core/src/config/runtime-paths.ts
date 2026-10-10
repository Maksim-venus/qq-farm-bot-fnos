export {};
const fs = require('node:fs');
const path = require('node:path');
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
    const override = String(process.env.QQ_FARM_RESOURCE_DIR || '').trim();
    if (override) return path.resolve(override);
    if (isSea) return path.join(getSeaRoot(), 'resources');

    // When compiled (node client.js): __dirname = core/dist/config/ → resources at core/src/
    // When tsx (tsx client.ts): __dirname = core/src/config/ → resources at core/src/
    const parent = path.join(__dirname, '..');
    if (!isPackaged) {
        // Check if we're inside dist/ (compiled mode)
        const parentName = path.basename(parent);
        if (parentName === 'dist') {
            return path.join(parent, '..', 'src');
        }
    }
    return parent;
}

function getResourcePath(...segments: string[]): string {
    return path.join(getResourceRoot(), ...segments);
}

function getAppRootForWritable(): string {
    if (isSea) return getSeaRoot();
    return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '../..');
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
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
