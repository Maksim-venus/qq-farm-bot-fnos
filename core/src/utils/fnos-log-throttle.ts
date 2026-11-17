/**
 * [fnos-fork] 2026-11-17 刷屏日志限频：同一条（同账号 + 同内容）每小时只记一次。
 *
 * 只针对「跳过 / 暂不执行」类的重复提示，例如：
 *   - 「暂不能拜访 小果：…不是好友无法拜访」（每轮好友牧场都会刷）；
 *   - 「购买鹅 ×4 暂未执行：该操作的上次结果未知…」（补栏保护期间每轮都刷）。
 * 规则：meta.result = skipped（或 skip），且内容命中 暂不能拜访 / 无法拜访 / 暂未执行。
 * 每个账号是独立的 worker 进程，所以这里的缓存天然按账号区分；键再带上 tag + event + 内容。
 * 一小时后再次出现时照常记录，并在末尾注明这一小时里省略了几次。
 */

export const FNOS_LOG_THROTTLE_WINDOW_MS = 60 * 60 * 1000;
const SPAM_MSG_RE = /暂不能拜访|无法拜访|暂未执行/;
const MAX_KEYS = 2000;

interface ThrottleState { lastAt: number, suppressed: number }

export function createFnosLogThrottle(windowMs = FNOS_LOG_THROTTLE_WINDOW_MS, now: () => number = () => Date.now()) {
    const states = new Map<string, ThrottleState>();

    function isSpam(msg: string, meta: any): boolean {
        const result = String((meta && meta.result) || '').toLowerCase();
        return (result === 'skipped' || result === 'skip') && SPAM_MSG_RE.test(String(msg || ''));
    }

    /** 返回 null 表示这次不记；否则返回要记的内容（可能带「省略 N 次」后缀）。 */
    function check(tag: string, msg: string, meta: any): string | null {
        if (!isSpam(msg, meta)) return msg;
        const key = `${tag}|${(meta && meta.accountId) || ''}|${(meta && meta.event) || ''}|${msg}`;
        const t = now();
        const state = states.get(key);
        if (state && t - state.lastAt < windowMs) {
            state.suppressed += 1;
            return null;
        }
        const suppressed = state ? state.suppressed : 0;
        states.delete(key);
        states.set(key, { lastAt: t, suppressed: 0 });
        if (states.size > MAX_KEYS) {
            for (const [k, v] of states) {
                if (states.size <= MAX_KEYS / 2) break;
                if (t - v.lastAt >= windowMs || states.size > MAX_KEYS) states.delete(k);
            }
        }
        return suppressed > 0 ? `${msg}（过去 1 小时同样提示省略 ${suppressed} 次）` : msg;
    }

    return { check, isSpam, size: () => states.size };
}

const defaultThrottle = createFnosLogThrottle();

export function fnosThrottleLogMessage(tag: string, msg: string, meta: any): string | null {
    return defaultThrottle.check(tag, msg, meta);
}
