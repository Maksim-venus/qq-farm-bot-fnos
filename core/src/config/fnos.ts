export {};
/**
 * 飞牛 fnOS 原生应用运行环境适配。
 *
 * - QQ_FARM_GATEWAY_PREFIX：飞牛统一网关前缀，例如 /app/qq-farm-bot。
 *   网关转发时保留该前缀，服务端在入口处剥离，并在返回给前端的资源地址前补回。
 * - QQ_FARM_SOCKET：服务监听的 Unix Socket（飞牛网关转发目标，${TRIM_APPDEST}/app.sock）。
 *   设置后不会监听任何 TCP 端口。
 * - QQ_FARM_DATA_DIR：数据目录（飞牛下为 ${TRIM_PKGVAR}/data）。
 */

function normalizePrefix(raw: unknown): string {
    let text = String(raw || '').trim();
    if (!text || text === '/') return '';
    if (!text.startsWith('/')) text = `/${text}`;
    return text.replace(/\/+$/, '');
}

const GATEWAY_PREFIX: string = normalizePrefix(process.env.QQ_FARM_GATEWAY_PREFIX);

/** 将以 / 开头的本应用资源地址加上网关前缀。外部 URL、data:/blob: 和空值原样返回。 */
function gatewayPath(input: string): string {
    const value = String(input || '');
    if (!value || !value.startsWith('/') || value.startsWith('//')) return value;
    if (!GATEWAY_PREFIX) return value;
    if (value === GATEWAY_PREFIX || value.startsWith(`${GATEWAY_PREFIX}/`)) return value;
    return `${GATEWAY_PREFIX}${value}`;
}

/** 从请求路径中剥离网关前缀，返回剥离后的路径；不匹配时返回 null。 */
function stripGatewayPrefix(url: string): string | null {
    if (!GATEWAY_PREFIX) return null;
    const value = String(url || '');
    if (value === GATEWAY_PREFIX) return '/';
    if (value.startsWith(`${GATEWAY_PREFIX}/`) || value.startsWith(`${GATEWAY_PREFIX}?`)) {
        const rest = value.slice(GATEWAY_PREFIX.length);
        return rest.startsWith('?') ? `/${rest}` : rest;
    }
    return null;
}

function getListenSocketPath(): string {
    return String(process.env.QQ_FARM_SOCKET || '').trim();
}

/**
 * 飞牛原生包中禁止任何 TCP 监听：cmd/main 设置 QQ_FARM_NO_TCP=1，
 * 打包脚本还会在 core/ 下放置 FNOS_NATIVE 标记文件（即使环境变量丢失也生效）。
 */
function isTcpForbidden(): boolean {
    const raw = String(process.env.QQ_FARM_NO_TCP || '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes') return true;
    try {
        const fs = require('node:fs');
        const path = require('node:path');
        return [
            path.join(__dirname, '../../FNOS_NATIVE'),
            path.join(path.dirname(process.execPath), 'FNOS_NATIVE'),
        ].some((file: string) => fs.existsSync(file));
    } catch {
        return false;
    }
}

/** 网关已校验飞牛登录态；默认仅允许飞牛管理员使用（QQ_FARM_ADMIN_ONLY=0 可关闭）。 */
function isAdminOnly(): boolean {
    const raw = String(process.env.QQ_FARM_ADMIN_ONLY ?? '1').trim().toLowerCase();
    return !(raw === '0' || raw === 'false' || raw === 'no');
}

module.exports = {
    GATEWAY_PREFIX,
    gatewayPath,
    stripGatewayPrefix,
    getListenSocketPath,
    isTcpForbidden,
    isAdminOnly,
};
