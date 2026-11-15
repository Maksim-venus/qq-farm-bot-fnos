export {};
/**
 * [fnos-fork] 2026-11-15：奶茶 fork 功能（自动雇佣 / 工作事项 / 收益领取 / 种子兑换 / 自动制作 / 工资 / 店铺升级）
 * 按用户要求下架后，启动时一次性清理它们留下的持久化数据。
 *
 * 只删 fork 专属的三个账号配置字段：fnosMilkTeaAutoHire、fnosMilkTeaDaily、fnosMilkTeaExtra。
 *   - data/store.json：旧版聚合 accountConfigs.<id>.* 与 defaultAccountConfig.* 中的这三个字段；
 *   - data/account-configs/<id>.json：每个账号文件里的这三个字段。
 * 这几个 fork 功能的运行状态（调度计时、退避、已兑换标记等）只在内存里，没有单独的数据文件或数据库表。
 * 上游自带奶茶功能不存任何本地数据，图鉴（fnosIllustratedAuto、data/fnos-illustrated/）等其他设置一律不动。
 *
 * 幂等：字段不存在时不写文件；单个文件读写失败只记警告并跳过，整个函数不抛错，不影响启动。
 * 不改 store.json.*.bak 备份（上游迁移前留的原始副本）。
 */

const fs = require('node:fs');
const path = require('node:path');

const FNOS_MILK_TEA_KEYS = ['fnosMilkTeaAutoHire', 'fnosMilkTeaDaily', 'fnosMilkTeaExtra'];

function stripKeys(target: any): number {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return 0;
    let removed = 0;
    for (const key of FNOS_MILK_TEA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
            delete target[key];
            removed += 1;
        }
    }
    return removed;
}

function writeJsonAtomic(file: string, value: any): void {
    const { writeTextFileAtomic } = require('./json-db');
    writeTextFileAtomic(file, JSON.stringify(value, null, 2));
}

function cleanFile(file: string, strip: (doc: any) => number, report: { files: string[]; removed: number; errors: string[] }): void {
    let doc: any;
    try {
        if (!fs.existsSync(file)) return;
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: any) {
        report.errors.push(`${file}: ${e && e.message ? e.message : e}`);
        return;
    }
    const removed = strip(doc);
    if (!removed) return;
    try {
        writeJsonAtomic(file, doc);
        report.files.push(file);
        report.removed += removed;
    } catch (e: any) {
        report.errors.push(`${file}: ${e && e.message ? e.message : e}`);
    }
}

/** 清理 dataDir（store.json 所在目录）下 fork 奶茶功能的残留字段。返回清理报告，从不抛错。 */
function cleanupFnosMilkTeaData(dataDir: string): { files: string[]; removed: number; errors: string[] } {
    const report = { files: [] as string[], removed: 0, errors: [] as string[] };
    try {
        cleanFile(path.join(dataDir, 'store.json'), (doc) => {
            if (!doc || typeof doc !== 'object') return 0;
            let n = stripKeys(doc) + stripKeys(doc.defaultAccountConfig);
            if (doc.accountConfigs && typeof doc.accountConfigs === 'object') {
                for (const cfg of Object.values(doc.accountConfigs)) n += stripKeys(cfg);
            }
            return n;
        }, report);
        const accountDir = path.join(dataDir, 'account-configs');
        if (fs.existsSync(accountDir)) {
            for (const entry of fs.readdirSync(accountDir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
                cleanFile(path.join(accountDir, entry.name), stripKeys, report);
            }
        }
    } catch (e: any) {
        report.errors.push(String(e && e.message ? e.message : e));
    }
    if (report.removed > 0) {
        console.log(`[系统] 奶茶 fork 功能已下架：已从 ${report.files.length} 个配置文件中清理 ${report.removed} 个奶茶设置字段`);
    }
    if (report.errors.length) {
        console.warn('[系统] 清理奶茶 fork 设置时跳过了部分文件:', report.errors.join('; '));
    }
    return report;
}

module.exports = { cleanupFnosMilkTeaData, FNOS_MILK_TEA_KEYS };
