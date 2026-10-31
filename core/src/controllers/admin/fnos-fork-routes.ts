import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * [fnos-fork] 本 fork 新增的按账号设置接口（上游没有）。
 *
 * 大号/小号：
 *   GET  /api/fnos/alt-account            读取（账号未运行也能读）
 *   POST /api/fnos/alt-account            保存
 * 奶茶活动自动雇佣（2026.10.21.2 起含优先雇佣人，与大小号解耦）：
 *   GET  /api/fnos/milk-tea-auto-hire     读取设置 + 可选时长/职业
 *   POST /api/fnos/milk-tea-auto-hire     保存
 * 奶茶收益每小时自动领取 / 兑换商店每日兑换森野黄金芽种子：
 *   GET  /api/fnos/milk-tea-daily         读取
 *   POST /api/fnos/milk-tea-daily         保存
 * 奶茶自动制作（可排除金露云酪）/ 自动领取工资（2026-10-28）：
 *   GET  /api/fnos/milk-tea-extra         读取
 *   POST /api/fnos/milk-tea-extra         保存（请求里没带的字段沿用已保存的值）
 * 图鉴奖励自动领取 / 自动完成图鉴（2026-10-28）：
 *   GET  /api/fnos/illustrated-auto       读取
 *   POST /api/fnos/illustrated-auto       保存（请求里没带的字段沿用已保存的值）
 * 以上都在前端「设置 → 活动设置」栏目。
 *
 * 保存走与设置页相同的 provider.saveSettings：写入账号配置（上游 2026-10-22 起为 data/account-configs/<id>.json），运行中的账号同步到 worker 并等待确认。
 */

const store = require('../../models/store');
const { normalizeFnosAltAccount, DEFAULT_FNOS_ALT_ACCOUNT } = require('../../services/farm/fnos-alt-account');
const {
    normalizeFnosMilkTeaAutoHire,
    resolveEffectiveHireConfig,
    DEFAULT_FNOS_MILK_TEA_AUTO_HIRE,
    MILK_TEA_DURATION_OPTIONS,
    MILK_TEA_TALENT_OPTIONS,
    MILK_TEA_WORK_OPTIONS,
} = require('../../services/fnos-milk-tea-auto-hire');
const { normalizeFnosMilkTeaDaily, DEFAULT_FNOS_MILK_TEA_DAILY } = require('../../services/fnos-milk-tea-daily');
const { normalizeFnosMilkTeaExtra } = require('../../services/fnos-milk-tea-extra');
const { normalizeFnosIllustratedAuto } = require('../../services/fnos-illustrated-auto');
const { normalizeFnosStealRatio } = require('../../services/friend/fnos-steal-ratio');
const { getAccId, handleApiError } = require('./middleware');

function sendSaveResult(res: Response, data: any, pick: (d: any) => any): void {
    const unconfirmed = data && data.status === 'unconfirmed';
    res.status(unconfirmed ? 202 : 200).json({
        ok: !unconfirmed,
        saved: !!(data && data.saved),
        stopped: !!(data && data.status === 'stopped'),
        unconfirmed: !!unconfirmed,
        error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但账号进程尚未确认应用') : undefined,
        data: pick(data || {}),
    });
}

function mountFnosForkRoutes(app: Application, ctx: AdminContext): void {
    app.get('/api/fnos/alt-account', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const snapshot = store.getConfigSnapshot(id);
            res.json({ ok: true, data: normalizeFnosAltAccount(snapshot && snapshot.fnosAltAccount) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/fnos/alt-account', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
            // [fnos-fork] holdForMaster「成熟作物先留给大号偷」：请求里没带时沿用已保存的值（旧配置缺省为 true）
            const current = normalizeFnosAltAccount(store.getConfigSnapshot(id)?.fnosAltAccount);
            const next = normalizeFnosAltAccount(body, { ...DEFAULT_FNOS_ALT_ACCOUNT, holdForMaster: current.holdForMaster });
            if (next.enabled && next.masterGid <= 0) {
                return res.status(400).json({ ok: false, error: '开启「这是小号」时必须选择大号' });
            }
            const data = await ctx.provider.saveSettings(id, { fnosAltAccount: next });
            sendSaveResult(res, data, d => normalizeFnosAltAccount(d.fnosAltAccount));
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/fnos/milk-tea-auto-hire', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const snapshot = store.getConfigSnapshot(id);
            // 2026.10.21.2：老配置（未用新卡片保存过）按旧版小号设置迁移后显示，保存时写入 priorityConfigured=true
            const { migratedFromAlt, ...data } = resolveEffectiveHireConfig(
                snapshot && snapshot.fnosMilkTeaAutoHire, normalizeFnosAltAccount(snapshot && snapshot.fnosAltAccount));
            res.json({
                ok: true,
                data,
                migratedFromAlt,
                options: { durations: MILK_TEA_DURATION_OPTIONS, talents: MILK_TEA_TALENT_OPTIONS, works: MILK_TEA_WORK_OPTIONS },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/fnos/milk-tea-auto-hire', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
            // [fnos-fork] 2026-10-27 多个优先雇佣人：请求里没带 priorityFriends / priorityGid 时沿用当前生效的列表
            // （含老配置按旧版小号迁移出的大号），其他字段仍按请求保存
            const snapshot = store.getConfigSnapshot(id);
            const current = resolveEffectiveHireConfig(
                snapshot && snapshot.fnosMilkTeaAutoHire, normalizeFnosAltAccount(snapshot && snapshot.fnosAltAccount));
            const next = {
                ...normalizeFnosMilkTeaAutoHire(body, { ...DEFAULT_FNOS_MILK_TEA_AUTO_HIRE, priorityFriends: current.priorityFriends }),
                priorityConfigured: true,
            };
            const data = await ctx.provider.saveSettings(id, { fnosMilkTeaAutoHire: next });
            sendSaveResult(res, data, d => normalizeFnosMilkTeaAutoHire(d.fnosMilkTeaAutoHire));
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/fnos/milk-tea-daily', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const snapshot = store.getConfigSnapshot(id);
            res.json({ ok: true, data: normalizeFnosMilkTeaDaily(snapshot && snapshot.fnosMilkTeaDaily) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/fnos/milk-tea-daily', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const next = normalizeFnosMilkTeaDaily(req.body || {}, DEFAULT_FNOS_MILK_TEA_DAILY);
            const data = await ctx.provider.saveSettings(id, { fnosMilkTeaDaily: next });
            sendSaveResult(res, data, d => normalizeFnosMilkTeaDaily(d.fnosMilkTeaDaily));
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // [fnos-fork] 2026-10-28 奶茶自动制作 / 领工资、图鉴奖励领取 / 自动完成图鉴：同一套读写
    const simpleRoutes: Array<[string, string, (input: any, fallback?: any) => any]> = [
        ['/api/fnos/milk-tea-extra', 'fnosMilkTeaExtra', normalizeFnosMilkTeaExtra],
        ['/api/fnos/illustrated-auto', 'fnosIllustratedAuto', normalizeFnosIllustratedAuto],
    ];
    for (const [route, key, normalize] of simpleRoutes) {
        app.get(route, (req: Request, res: Response) => {
            const id = getAccId(ctx, req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            try {
                const snapshot = store.getConfigSnapshot(id);
                res.json({ ok: true, data: normalize(snapshot && snapshot[key]) });
            } catch (e: any) {
                handleApiError(res, e);
            }
        });
        app.post(route, async (req: Request, res: Response) => {
            const id = getAccId(ctx, req);
            if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            try {
                const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
                const current = normalize(store.getConfigSnapshot(id)?.[key]);
                const next = normalize(body, current);
                const data = await ctx.provider.saveSettings(id, { [key]: next });
                sendSaveResult(res, data, d => normalize(d[key]));
            } catch (e: any) {
                handleApiError(res, e);
            }
        });
    }

    // [fnos-fork] 2026-10-31 偷收比：四项开关独立，缺字段沿用已保存值
    app.get('/api/fnos/steal-ratio', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const snapshot = store.getConfigSnapshot(id);
            res.json({ ok: true, data: normalizeFnosStealRatio(snapshot && snapshot.fnosStealRatio) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
    app.post('/api/fnos/steal-ratio', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
            const current = normalizeFnosStealRatio(store.getConfigSnapshot(id)?.fnosStealRatio);
            const next = normalizeFnosStealRatio(body, current);
            const data = await ctx.provider.saveSettings(id, { fnosStealRatio: next });
            sendSaveResult(res, data, d => normalizeFnosStealRatio(d.fnosStealRatio));
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
    app.post('/api/fnos/steal-ratio/lookup', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const gids = Array.isArray(req.body?.gids) ? req.body.gids : [];
            const data = await ctx.provider.lookupStealRatios(id, gids);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountFnosForkRoutes };
