import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * [fnos-fork] 本 fork 新增的按账号设置接口（上游没有）。
 *
 * 大号/小号：
 *   GET  /api/fnos/alt-account            读取（账号未运行也能读）
 *   POST /api/fnos/alt-account            保存
 * 奶茶活动自动雇佣：
 *   GET  /api/fnos/milk-tea-auto-hire     读取设置 + 可选时长/职业
 *   POST /api/fnos/milk-tea-auto-hire     保存
 * 奶茶收益每小时自动领取 / 兑换商店每日兑换森野黄金芽种子：
 *   GET  /api/fnos/milk-tea-daily         读取
 *   POST /api/fnos/milk-tea-daily         保存
 * 以上都在前端「设置 → 活动设置」栏目。
 *
 * 保存走与设置页相同的 provider.saveSettings：写入 store.json，运行中的账号同步到 worker 并等待确认。
 */

const store = require('../../models/store');
const { normalizeFnosAltAccount, DEFAULT_FNOS_ALT_ACCOUNT } = require('../../services/farm/fnos-alt-account');
const {
    normalizeFnosMilkTeaAutoHire,
    DEFAULT_FNOS_MILK_TEA_AUTO_HIRE,
    MILK_TEA_DURATION_OPTIONS,
    MILK_TEA_TALENT_OPTIONS,
    MILK_TEA_WORK_OPTIONS,
} = require('../../services/fnos-milk-tea-auto-hire');
const { normalizeFnosMilkTeaDaily, DEFAULT_FNOS_MILK_TEA_DAILY } = require('../../services/fnos-milk-tea-daily');
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
            const next = normalizeFnosAltAccount(req.body || {}, DEFAULT_FNOS_ALT_ACCOUNT);
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
            res.json({
                ok: true,
                data: normalizeFnosMilkTeaAutoHire(snapshot && snapshot.fnosMilkTeaAutoHire),
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
            const next = normalizeFnosMilkTeaAutoHire(req.body || {}, DEFAULT_FNOS_MILK_TEA_AUTO_HIRE);
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
}

module.exports = { mountFnosForkRoutes };
