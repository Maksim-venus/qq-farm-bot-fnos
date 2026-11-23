import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * [fnos-fork] 本 fork 新增的按账号设置接口（上游没有）。
 *
 * 大号/小号：
 *   GET  /api/fnos/alt-account            读取（账号未运行也能读）
 *   POST /api/fnos/alt-account            保存
 * 图鉴奖励自动领取 / 自动完成图鉴（2026-10-28）：
 *   GET  /api/fnos/illustrated-auto       读取
 *   POST /api/fnos/illustrated-auto       保存（请求里没带的字段沿用已保存的值）
 * 图鉴在前端「设置 → 自动控制」栏目（2026-11-15 起）；奶茶 fork 接口（milk-tea-auto-hire / -daily / -extra）已于 2026-11-15 下架。
 *
 * 保存走与设置页相同的 provider.saveSettings：写入账号配置（上游 2026-10-22 起为 data/account-configs/<id>.json），运行中的账号同步到 worker 并等待确认。
 *
 * 游戏公告（只读，2026-11-02）：
 *   GET /api/fnos/bulletins?accountId=…     当前账号的公告标题列表
 *   GET /api/fnos/bulletins/:id             一条公告的标题、正文、起止时间、图片
 * 账号用 x-account-id（也接受 query accountId）。管理员校验沿用入口的 X-Trim-Isadmin。
 * 只调游戏的 GetBulletinList / GetBulletinDetail，不报已读。
 */

const store = require('../../models/store');
const { normalizeFnosAltAccount, DEFAULT_FNOS_ALT_ACCOUNT } = require('../../services/farm/fnos-alt-account');
const { normalizeFnosIllustratedAuto } = require('../../services/fnos-illustrated-auto');
const { normalizeFnosStealRatio } = require('../../services/friend/fnos-steal-ratio');
const { describeBulletinAccessError, parseBulletinId } = require('../../services/fnos-bulletin');
const { getAccId, handleApiError, resolveAccId } = require('./middleware');

function bulletinAccountId(ctx: AdminContext, req: Request): string {
    const headerId = getAccId(ctx, req);
    if (headerId) return headerId;
    const raw = req.query?.accountId;
    const queryId = Array.isArray(raw) ? raw[0] : raw;
    return queryId ? resolveAccId(ctx, queryId) : '';
}

function sendBulletinError(res: Response, error: any): void {
    const message = describeBulletinAccessError(error);
    if (message) {
        res.json({
            ok: false,
            error: message,
            errorCode: message.includes('未登录') ? 'ACCOUNT_NOT_LOGGED_IN' : 'ACCOUNT_OFFLINE',
        });
        return;
    }
    handleApiError(res, error);
}

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

    // [fnos-fork] 2026-10-28 图鉴奖励领取 / 自动完成图鉴（奶茶 fork 接口已于 2026-11-15 下架）
    const simpleRoutes: Array<[string, string, (input: any, fallback?: any) => any]> = [
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

    // [fnos-fork] 在线期间来偷菜的自动删除（接口路径沿用 steal-ratio）。缺字段沿用已保存值
    // [fnos-fork] 2026-11-17 好友时间表（农场好友 / 牧场好友列表「还多久可偷」列）：读 worker 落盘的 data/fnos-timetable/<账号>.json
    app.get('/api/fnos/timetable', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const rows = require('../../services/fnos-timetable').readSnapshotForAccount(id);
            res.json({ ok: true, data: { now: Date.now(), rows } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
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
    // [fnos-fork] 游戏公告只读查看。空列表也是成功。
    app.get('/api/fnos/bulletins', async (req: Request, res: Response) => {
        const id = bulletinAccountId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: '请先选择账号' });
        try {
            const data = await ctx.provider.getBulletinList(id);
            const bulletins = data && Array.isArray(data.bulletins) ? data.bulletins : [];
            res.json({ ok: true, data: { bulletins } });
        } catch (e: any) {
            sendBulletinError(res, e);
        }
    });

    app.get('/api/fnos/bulletins/:id', async (req: Request, res: Response) => {
        const accountId = bulletinAccountId(ctx, req);
        if (!accountId) return res.status(400).json({ ok: false, error: '请先选择账号' });
        const bulletinId = parseBulletinId(req.params.id);
        if (!bulletinId) return res.status(400).json({ ok: false, error: '公告编号无效' });
        try {
            const data = await ctx.provider.getBulletinDetail(accountId, bulletinId);
            res.json({ ok: true, data });
        } catch (e: any) {
            sendBulletinError(res, e);
        }
    });
}

module.exports = { mountFnosForkRoutes };
