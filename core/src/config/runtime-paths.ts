export {};
const fs = require('node:fs');
const path = require('node:path');
const isPackaged: boolean = !!(process as any).pkg;

function getResourceRoot(): string {
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

module.exports = {
    isPackaged,
    getResourcePath,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
