import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 系统路由：心跳、版本、调度器状态、飞牛身份。
 *
 * 飞牛原生包中访问控制完全交给飞牛统一网关（NAS 登录态 + 管理员校验），
 * 本应用不再有独立的管理员账号、密码或令牌。
 */

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');

const {
    getAccId,
    getGatewayUser,
    handleApiError,
} = require('./middleware');

function mountSystemRoutes(app: Application, ctx: AdminContext): void {
    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        const { clientVersion, wxClientVersion } = getRuntimeConfig();
        res.json({ ok: true, clientVersion, wxClientVersion, botVersion: version });
    });

    // 当前飞牛用户（来自统一网关转发的 X-Trim-* Header）
    app.get('/api/fnos/me', (req: Request, res: Response) => {
        res.json({ ok: true, data: getGatewayUser(req) });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });
}

module.exports = { mountSystemRoutes };
