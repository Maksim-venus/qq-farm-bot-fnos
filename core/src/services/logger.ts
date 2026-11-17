export {};
const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir } = require('../config/runtime-paths');

let winston: any = null;
try {
    winston = require('winston');
} catch {
    winston = null;
}

const DIAGNOSTIC_CODE_KEY_RE = /^(?:disconnect|close|error|http|status|exit|reason)Code$/i;
const SENSITIVE_KEY_RE = /code|token|password|passwd|auth|ticket|cookie|session/i;

function redactString(input: any): string {
    let text = String(input || '');
    text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    return text;
}

function sanitizeMeta(value: any, depth = 0): any {
    if (depth > 4) return '[Truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => sanitizeMeta(v, depth + 1));

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (DIAGNOSTIC_CODE_KEY_RE.test(k) && typeof v === 'number' && Number.isSafeInteger(v)) {
            out[k] = v;
        } else if (SENSITIVE_KEY_RE.test(String(k))) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = sanitizeMeta(v, depth + 1);
        }
    }
    return out;
}

// ============ [fnos-fork] 2026-11-17 combined.log 按天切分，只留 7 天 ============
// 原来 data/logs/combined.log 只追加不切分（NAS 上已 400MB+）。现在每天一个文件 combined-YYYY-MM-DD.log（本机时区），
// 启动时删掉 7 天前的；旧的 combined.log 在主进程启动时改名归档为 combined-legacy-<日期>.log，
// 超过 10MB 的只保留末尾 10MB（只读末尾一段，不整读大文件，不拖慢启动），归档同样 7 天后删除。
// 多个进程（主进程 + 各账号 worker）都以追加方式写同一天的文件，O_APPEND 下单行写入不会交错。
const FNOS_COMBINED_KEEP_DAYS = 7;
const FNOS_LEGACY_KEEP_BYTES = 10 * 1024 * 1024;
const FNOS_COMBINED_FILE_RE = /^combined-(?:legacy-)?(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log$/;

function fnosLocalDateKey(ms: number = Date.now()): string {
    const d = new Date(ms);
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fnosCombinedLogFile(dir: string, ms: number = Date.now()): string {
    return path.join(dir, `combined-${fnosLocalDateKey(ms)}.log`);
}

/** 删掉 keepDays 天前的按天日志与归档（按文件名里的日期判断）。 */
function fnosCleanupCombinedLogs(dir: string, ms: number = Date.now(), keepDays = FNOS_COMBINED_KEEP_DAYS): string[] {
    const removed: string[] = [];
    const cutoff = fnosLocalDateKey(ms - keepDays * 24 * 3600 * 1000);
    let names: string[] = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return removed;
    }
    for (const name of names) {
        const m = FNOS_COMBINED_FILE_RE.exec(name);
        if (!m || m[1] > cutoff) continue;
        try {
            fs.unlinkSync(path.join(dir, name));
            removed.push(name);
        } catch {
            // ignore
        }
    }
    return removed;
}

/** 把旧的单文件 combined.log 归档：小的直接改名，大的只留末尾 keepBytes（从整行开始）。返回归档文件名或空串。 */
function fnosArchiveLegacyCombinedLog(dir: string, ms: number = Date.now(), keepBytes = FNOS_LEGACY_KEEP_BYTES): string {
    const legacy = path.join(dir, 'combined.log');
    let stat: any;
    try {
        stat = fs.statSync(legacy);
    } catch {
        return '';
    }
    if (!stat.isFile()) return '';
    const date = fnosLocalDateKey(ms);
    let name = `combined-legacy-${date}.log`;
    for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `combined-legacy-${date}-${i}.log`;
    const target = path.join(dir, name);
    try {
        if (stat.size <= keepBytes) {
            fs.renameSync(legacy, target);
            return name;
        }
        const fd = fs.openSync(legacy, 'r');
        try {
            const buf = Buffer.alloc(keepBytes);
            const read = fs.readSync(fd, buf, 0, keepBytes, stat.size - keepBytes);
            let start = buf.indexOf(0x0A);
            start = start >= 0 && start < read ? start + 1 : 0;
            fs.writeFileSync(target, buf.subarray(start, read));
        } finally {
            fs.closeSync(fd);
        }
        fs.unlinkSync(legacy);
        return name;
    } catch {
        return '';
    }
}

let fnosLogDirPrepared = false;

function fnosPrepareLogDir(dir: string): void {
    if (fnosLogDirPrepared) return;
    fnosLogDirPrepared = true;
    try {
        if (process.env.FARM_WORKER !== '1') fnosArchiveLegacyCombinedLog(dir);
        fnosCleanupCombinedLogs(dir);
    } catch {
        // 日志整理失败不影响启动
    }
}

const FnosTransportBase: any = winston && winston.Transport ? winston.Transport : class {};
const MESSAGE_SYMBOL = Symbol.for('message');

/** winston 传输：按本机日期写 combined-YYYY-MM-DD.log，跨天时换文件并清理过期文件。 */
class FnosDailyFileTransport extends FnosTransportBase {
    dir: string;
    date = '';
    stream: any = null;

    constructor(opts: any) {
        super(opts);
        this.dir = opts.dir;
    }

    log(info: any, callback: () => void): void {
        setImmediate(() => this.emit('logged', info));
        try {
            const now = Date.now();
            const date = fnosLocalDateKey(now);
            if (date !== this.date || !this.stream) {
                if (this.stream) this.stream.end();
                this.date = date;
                this.stream = fs.createWriteStream(fnosCombinedLogFile(this.dir, now), { flags: 'a' });
                this.stream.on('error', () => {});
                fnosCleanupCombinedLogs(this.dir, now);
            }
            const line = info[MESSAGE_SYMBOL] || JSON.stringify(info);
            this.stream.write(`${line}\n`);
        } catch {
            // ignore
        }
        if (callback) callback();
    }

    close(): void {
        if (this.stream) this.stream.end();
        this.stream = null;
    }
}

let fallbackLogDir: string | null = null;

function ensureFallbackLogDir(): string {
    if (fallbackLogDir) return fallbackLogDir;
    const dataDir = ensureDataDir();
    const dir = path.join(dataDir, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fnosPrepareLogDir(dir); // [fnos-fork]
    fallbackLogDir = dir;
    return fallbackLogDir;
}

function appendFallbackLog(level: string, moduleName: string, message: string, meta: any): void {
    try {
        const dir = ensureFallbackLogDir();
        const payload = {
            ts: new Date().toISOString(),
            level,
            module: moduleName,
            message: redactString(message),
            meta: sanitizeMeta(meta || {}),
        };
        const line = `${JSON.stringify(payload)}\n`;
        fs.appendFileSync(fnosCombinedLogFile(dir), line, 'utf8'); // [fnos-fork] 按天切分
        if (level === 'error') {
            fs.appendFileSync(path.join(dir, 'error.log'), line, 'utf8');
        }
    } catch {
        // ignore file write errors in fallback mode
    }
}

interface ModuleLogger {
    info: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
}

function createConsoleFallback(moduleName: string): ModuleLogger {
    const write = (level: string, message: string, meta: any) => {
        const ts = new Date().toISOString();
        const safeMsg = redactString(message);
        const safeMeta = sanitizeMeta(meta);
        appendFallbackLog(level, moduleName, safeMsg, safeMeta);
        if (safeMeta && Object.keys(safeMeta).length > 0) {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg} ${JSON.stringify(safeMeta)}`);
        } else {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg}`);
        }
    };
    return {
        info: (message: string, meta?: any) => write('info', message, meta),
        warn: (message: string, meta?: any) => write('warn', message, meta),
        error: (message: string, meta?: any) => write('error', message, meta),
        debug: (message: string, meta?: any) => write('debug', message, meta),
    };
}

let rootLogger: any = null;

function getRootLogger(): any {
    if (rootLogger) return rootLogger;

    if (!winston) {
        rootLogger = null;
        return rootLogger;
    }

    const dataDir = ensureDataDir();
    const logDir = path.join(dataDir, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fnosPrepareLogDir(logDir); // [fnos-fork] 归档旧 combined.log、删 7 天前的按天日志

    const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
    const { combine, timestamp, errors, json, colorize, printf } = winston.format;

    rootLogger = winston.createLogger({
        level,
        defaultMeta: { app: 'qq-farm-bot' },
        transports: [
            new winston.transports.Console({
                format: combine(
                    colorize(),
                    timestamp(),
                    errors({ stack: true }),
                    printf((info: any) => {
                        const moduleName = info.module ? `[${info.module}] ` : '';
                        const msg = redactString(info.message || '');
                        const meta = { ...info };
                        delete meta.level;
                        delete meta.message;
                        delete meta.timestamp;
                        delete meta.app;
                        delete meta.module;
                        const safeMeta = sanitizeMeta(meta);
                        const hasMeta = safeMeta && Object.keys(safeMeta).length > 0;
                        return `${info.timestamp} [${info.level}] ${moduleName}${msg}${hasMeta ? ` ${JSON.stringify(safeMeta)}` : ''}`;
                    }),
                ),
            }),
            // [fnos-fork] 按天切分：combined-YYYY-MM-DD.log，只留 7 天
            new FnosDailyFileTransport({
                dir: logDir,
                format: combine(timestamp(), errors({ stack: true }), json()),
            }),
            new winston.transports.File({
                filename: path.join(logDir, 'error.log'),
                level: 'error',
                format: combine(timestamp(), errors({ stack: true }), json()),
            }),
        ],
    });

    return rootLogger;
}

function createModuleLogger(moduleName = 'app'): ModuleLogger {
    const moduleTag = String(moduleName || 'app');
    const root = getRootLogger();
    if (!root) return createConsoleFallback(moduleTag);

    const child = root.child({ module: moduleTag });
    return {
        info(message: string, meta = {}) {
            child.info(redactString(message), sanitizeMeta(meta));
        },
        warn(message: string, meta = {}) {
            child.warn(redactString(message), sanitizeMeta(meta));
        },
        error(message: string, meta = {}) {
            child.error(redactString(message), sanitizeMeta(meta));
        },
        debug(message: string, meta = {}) {
            child.debug(redactString(message), sanitizeMeta(meta));
        },
    };
}

module.exports = {
    createModuleLogger,
    fnosLocalDateKey,
    fnosCombinedLogFile,
    fnosCleanupCombinedLogs,
    fnosArchiveLegacyCombinedLog,
    sanitizeMeta,
    redactString,
};
