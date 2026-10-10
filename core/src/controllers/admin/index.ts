import type { AdminContext } from './context';
export {};

/**
 * Admin panel HTTP server orchestrator.
 * Thin wrapper that wires up Express, routes, Socket.IO, and shared context.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { CONFIG } = require('../../config/config');
const { getResourcePath, getWebDistDir } = require('../../config/runtime-paths');
const { GATEWAY_PREFIX, stripGatewayPrefix, getListenSocketPath, isAdminOnly, isTcpForbidden } = require('../../config/fnos');
const { createModuleLogger } = require('../../services/logger');

const { createAdminContext } = require('./context');
const { mountSystemRoutes } = require('./system-routes');
const { mountAccountRoutes } = require('./account-routes');
const { mountFarmRoutes } = require('./farm-routes');
const { mountFriendRoutes } = require('./friend-routes');
const { mountActivityCenterRoutes } = require('./activity-center-routes');
const { mountCommerceRoutes } = require('./commerce-routes');
const { mountWxLoginRoutes } = require('./wx-login-routes');
const { mountQqLoginRoutes } = require('./qq-login-routes');
const { getGatewayUser } = require('./middleware');
const {
    setupSocketIO,
    emitRealtimeStatus: _emitStatus,
    emitRealtimeLog: _emitLog,
    emitRealtimeAccountLog: _emitAccountLog,
} = require('./socket');

const adminLogger = createModuleLogger('admin');

let ctx: AdminContext | null = null;

function startAdminServer(dataProvider: any): void {
    if (ctx) return;

    ctx = createAdminContext(dataProvider);

    const app = express();
    app.set('trust proxy', true);
    app.disable('x-powered-by');

    // 飞牛统一网关保留 /app/qq-farm-bot 前缀转发，进入路由前统一剥离
    app.use((req: any, _res: any, next: any) => {
        const stripped = stripGatewayPrefix(req.url);
        if (stripped !== null) req.url = stripped;
        next();
    });

    // 飞牛网关已校验 NAS 登录态；默认仅允许飞牛管理员访问
    app.use((req: any, res: any, next: any) => {
        if (!isAdminOnly()) return next();
        const user = getGatewayUser(req);
        if (user.isAdmin) return next();
        const message = '仅飞牛管理员可以使用 QQ 农场';
        if (req.path.startsWith('/api')) return res.status(403).json({ ok: false, error: message });
        return res.status(403).type('text/plain; charset=utf-8').send(message);
    });

    app.use(express.json());

    ctx.app = app;

    app.use((req: any, res: any, next: any) => {
        const allowedOrigins: string[] = CONFIG.ALLOWED_ORIGINS || ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
        const origin = req.headers.origin;

        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        } else if (!origin) {
            res.header('Access-Control-Allow-Origin', '*');
        }

        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const webDist = getWebDistDir(path.join(__dirname, '../../../../web/dist'));
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // Mount route modules
    mountSystemRoutes(app, ctx);
    mountWxLoginRoutes(app, ctx);
    mountQqLoginRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);

    // SPA fallback
    app.get('*', (req: any, res: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    const socketPath: string = getListenSocketPath();
    if (socketPath) {
        // 飞牛原生包：只监听统一网关的 Unix Socket，不开放任何 TCP 端口
        try {
            fs.rmSync(socketPath, { force: true });
        } catch (e: any) {
            adminLogger.warn('failed to remove stale socket', { socketPath, error: e?.message });
        }
        ctx.server = app.listen(socketPath, () => {
            adminLogger.info('admin panel started', { socket: socketPath, gatewayPrefix: GATEWAY_PREFIX || '/' });
        });
        const cleanup = () => {
            try { fs.rmSync(socketPath, { force: true }); } catch { /* ignore */ }
        };
        process.once('exit', cleanup);
    } else if (isTcpForbidden()) {
        // 飞牛原生包缺少 Socket 配置时直接退出，绝不回退到 TCP 端口
        adminLogger.error('QQ_FARM_SOCKET 未设置，飞牛原生包禁止监听 TCP，服务退出');
        process.exit(1);
    } else {
        // 本地开发：仅绑定回环地址
        const port: number = CONFIG.adminPort || 3007;
        const host: string = String(process.env.ADMIN_HOST || '127.0.0.1');
        ctx.server = app.listen(port, host, () => {
            adminLogger.info('admin panel started', { url: `http://${host}:${port}`, port });
        });
    }
    ctx.server.on('error', (err: any) => {
        adminLogger.error('admin server error', { error: err?.message || String(err) });
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 200);
    });

    // Setup Socket.IO
    setupSocketIO(ctx);

}

function emitRealtimeStatus(accountId: string, status: any): void {
    if (!ctx) return;
    _emitStatus(ctx, accountId, status);
}

function emitRealtimeLog(entry: any): void {
    if (!ctx) return;
    _emitLog(ctx, entry);
}

function emitRealtimeAccountLog(entry: any): void {
    if (!ctx) return;
    _emitAccountLog(ctx, entry);
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
