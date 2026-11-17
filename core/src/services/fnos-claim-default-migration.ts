export {};
/**
 * [fnos-fork] 2026-11-17：图鉴奖励自动领取改为默认开启后的一次性迁移。
 *
 * 用户要求「图鉴、巨大图鉴奖励自动领取加上」。两个开关早就有，但原来默认关，且设置保存时会把 false 显式写进配置文件，
 * 只改默认值对老账号不起作用，所以启动时（主进程，loadGlobalConfig 之前）把已有配置里的这两个开关打开一次：
 *   - fnosIllustratedAuto.autoClaimRewards（农场：作物图鉴 + 变异图鉴）
 *   - fnosRanch.illustratedAutoClaim（牧场：普通图鉴 + 巨大图鉴 / 重量分等级奖励）
 * 范围：data/store.json（accountConfigs.<id>、defaultAccountConfig）与 data/account-configs/<id>.json；只改已存在的对象，
 * 不新建字段（缺字段时读取会走新的默认值 true）。「自动完成图鉴」（会花金币 / 金券买种子、幼崽）不动。
 *
 * 只做一次：完成后写标记文件 data/fnos-migrations/illustrated-claim-default-on.json，之后用户再关掉开关不会被改回。
 * 幂等、从不抛错；单个文件失败只记警告，下次启动再试（标记只在没有失败时写）。
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = path.join('fnos-migrations', 'illustrated-claim-default-on.json');

function turnOn(cfg: any): number {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 0;
    let changed = 0;
    const ill = cfg.fnosIllustratedAuto;
    if (ill && typeof ill === 'object' && !Array.isArray(ill) && ill.autoClaimRewards !== true) { ill.autoClaimRewards = true; changed++; }
    const ranch = cfg.fnosRanch;
    if (ranch && typeof ranch === 'object' && !Array.isArray(ranch) && ranch.illustratedAutoClaim !== true) { ranch.illustratedAutoClaim = true; changed++; }
    return changed;
}

function patchFile(file: string, patch: (doc: any) => number, report: { files: string[]; changed: number; errors: string[] }): void {
    let doc: any;
    try {
        if (!fs.existsSync(file)) return;
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: any) {
        report.errors.push(`${file}: ${e && e.message ? e.message : e}`);
        return;
    }
    const changed = patch(doc);
    if (!changed) return;
    try {
        require('./json-db').writeTextFileAtomic(file, JSON.stringify(doc, null, 2));
        report.files.push(file);
        report.changed += changed;
    } catch (e: any) {
        report.errors.push(`${file}: ${e && e.message ? e.message : e}`);
    }
}

/** dataDir = store.json 所在目录。返回报告，从不抛错。 */
function migrateIllustratedClaimDefaultOn(dataDir: string): { skipped: boolean; files: string[]; changed: number; errors: string[] } {
    const report = { skipped: false, files: [] as string[], changed: 0, errors: [] as string[] };
    const marker = path.join(dataDir, MARKER);
    try {
        if (!dataDir || !path.isAbsolute(dataDir)) return { ...report, skipped: true }; // 真实数据目录总是绝对路径（单测 mock 的相对路径不动）
        if (fs.existsSync(marker)) return { ...report, skipped: true };
        patchFile(path.join(dataDir, 'store.json'), (doc) => {
            if (!doc || typeof doc !== 'object') return 0;
            let n = turnOn(doc.defaultAccountConfig);
            if (doc.accountConfigs && typeof doc.accountConfigs === 'object') {
                for (const cfg of Object.values(doc.accountConfigs)) n += turnOn(cfg);
            }
            return n;
        }, report);
        const accountDir = path.join(dataDir, 'account-configs');
        if (fs.existsSync(accountDir)) {
            for (const entry of fs.readdirSync(accountDir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
                patchFile(path.join(accountDir, entry.name), turnOn, report);
            }
        }
        if (!report.errors.length) {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            require('./json-db').writeTextFileAtomic(marker, JSON.stringify({ doneAt: new Date().toISOString(), files: report.files.length, changed: report.changed }, null, 2));
        }
    } catch (e: any) {
        report.errors.push(String(e && e.message ? e.message : e));
    }
    if (report.changed > 0) console.log(`[系统] 图鉴奖励自动领取改为默认开启：已在 ${report.files.length} 个配置文件中打开 ${report.changed} 个开关（只做一次）`);
    if (report.errors.length) console.warn('[系统] 打开图鉴奖励自动领取时跳过了部分文件:', report.errors.join('; '));
    return report;
}

module.exports = { migrateIllustratedClaimDefaultOn, MARKER };
