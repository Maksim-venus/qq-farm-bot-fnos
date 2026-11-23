// [fnos-fork] 2026-11-23 首页合并概览：后台每次拿到农场 / 牧场数据就把概览快照写进 data/fnos-overview-cache/<账号>.json，
// 不依赖首页是否打开。同一账号同一边写盘节流（默认 15 秒），内容没变不写；节流期间的最新数据用定时器补写。
// 快照字段与前端 web/src/utils/fnos-overview.ts 的 OverviewSnapshot 一致。
export {};

const FARM_OP_LABELS: Record<string, string> = {
    harvest: '收获', farming: '一键务农', fertilize: '施肥', plant: '种植', steal: '偷菜', helpFarming: '帮务农', taskClaim: '任务', sell: '出售',
};

function amount(value: unknown): string {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)).toLocaleString('zh-CN') : '0';
}

function formatCount(value: unknown): string {
    const text = String(value ?? '0');
    try {
        return BigInt(text).toLocaleString('zh-CN');
    } catch {
        const n = Number(text);
        return Number.isFinite(n) ? n.toLocaleString('zh-CN') : text;
    }
}

function formatDuration(seconds: number): string {
    const n = Math.max(0, Math.ceil(seconds));
    const d = Math.floor(n / 86400);
    const h = Math.floor(n % 86400 / 3600);
    const m = Math.floor(n % 3600 / 60);
    if (d > 0) return `${d}天${h}小时`;
    if (h > 0) return `${h}小时${m}分`;
    return `${m}分${n % 60}秒`;
}

function remainToAt(sec: unknown, now: number): number | null {
    const n = Number(sec);
    return sec === null || sec === undefined || !Number.isFinite(n) ? null : now + Math.max(0, n) * 1000;
}

function buildFarmSnapshot(input: { status: any, items?: any[] | null, diamond?: number | null, career?: any, prev?: any, now: number }): any {
    const s = input.status || {};
    const prev = input.prev || null;
    const items = input.items;
    const item = (id: number) => (items || []).find((i: any) => Number(i.id) === id);
    const bucket = (id: number) => {
        const it = item(id);
        if (!it) return '0.0h';
        return it.hoursText ? String(it.hoursText).replace('小时', 'h') : `${((Number(it.count) || 0) / 3600).toFixed(1)}h`;
    };
    const count = (id: number) => (Number(item(id)?.count) || 0).toLocaleString('zh-CN');
    const checks = s.nextChecks || {};
    const friendSec = checks.friendRemainSec ?? checks.helpRemainSec ?? checks.stealRemainSec;
    const friendQuiet = checks.friendQuiet ?? checks.helpQuiet ?? checks.stealQuiet;
    const ops = s.operations || {};
    const prevAsset = (key: string) => (prev?.assets || []).find((t: any) => t.key === key)?.value;
    const stock = items
        ? [
            { key: 1011, label: '普通化肥', value: bucket(1011) },
            { key: 1012, label: '有机化肥', value: bucket(1012) },
            { key: 3001, label: '普通收藏点', value: count(3001) },
            { key: 3002, label: '典藏收藏点', value: count(3002) },
        ]
        : (prev?.stock || [
            { key: 1011, label: '普通化肥', value: '0.0h' }, { key: 1012, label: '有机化肥', value: '0.0h' },
            { key: 3001, label: '普通收藏点', value: '0' }, { key: 3002, label: '典藏收藏点', value: '0' },
        ]);
    return {
        space: 'farm',
        level: Number(s.status?.level) || 0,
        exp: { current: Number(s.levelProgress?.current) || 0, needed: Number(s.levelProgress?.needed) || 0 },
        assets: [
            { key: 'gold', label: '金币', value: amount(s.status?.gold) },
            { key: 'coupon', label: '点券', value: amount(s.status?.coupon) },
            { key: 'goldBean', label: '金豆豆', value: amount(s.status?.goldBean) },
            { key: 'diamond', label: '钻石', value: input.diamond !== null && input.diamond !== undefined ? amount(input.diamond) : (prevAsset('diamond') ?? '0') },
        ],
        stock,
        // [fnos-fork] 农场生涯：游戏生涯接口（CareerInfoGet）里自己的累计收获 / 累计偷菜；没取到就沿用缓存
        career: input.career ? { harvest: Number(input.career.harvest) || 0, steal: Number(input.career.steal) || 0 } : (input.prev?.career || null),
        facilities: [],
        todo: [],
        today: Object.keys(ops).filter(k => k !== 'upgrade' && k !== 'levelUp').map(k => ({ key: k, label: FARM_OP_LABELS[k] || k, count: Number(ops[k]) || 0 })),
        nextChecks: [
            { key: 'farm', label: '农场', at: checks.farmQuiet ? null : remainToAt(checks.farmRemainSec, input.now), note: checks.farmQuiet ? '静默中' : undefined },
            { key: 'friend', label: '好友任务', at: friendQuiet ? null : remainToAt(friendSec, input.now), note: friendQuiet ? '静默中' : undefined },
        ],
    };
}

function sortFacilities(list: any[]): any[] {
    const order: Record<number, number> = { 6: 0, 7: 1, 8: 2 };
    return [...list].sort((a, b) => (order[Number(a.moduleType)] ?? 9) - (order[Number(b.moduleType)] ?? 9)
        || String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true }));
}

function buildRanchSnapshot(input: { state: any, career?: any, ranchOperations?: any, ranchRemainSec?: unknown, now: number }): any {
    const st = input.state || {};
    const facilities = sortFacilities(st.facilities || []);
    const pens = facilities.filter(f => f.ranch);
    const animals = pens.flatMap(f => (f.ranch.animals || []));
    const shelvesReady = pens.reduce((sum, f) => sum + (f.ranch.shelves || []).filter((x: any) => x.canCollect).length, 0);
    const hazards = pens.reduce((sum, f) => sum + (f.ranch.hazards?.length || 0), 0);
    const blocked = animals.filter((a: any) => a.grassBlocked).length;
    const currency = (id: number) => (st.currencies || []).find((c: any) => Number(c.id) === id);
    const dung = currency(7002);
    const serverNow = Number(st.serverTime) || input.now;
    const ops = input.ranchOperations || null;
    const meter = (f: any) => {
        if (f.state === 2) return { text: '待建造', percent: 0 };
        if (f.upgradeState) {
            const end = Number(f.upgradeEndTime);
            const ms = end < 100_000_000_000 ? end * 1000 : end;
            return { text: `升级中 · ${formatDuration((ms - serverNow) / 1000)}`, percent: 0 };
        }
        if (f.ranch) return { text: `${f.ranch.count} / ${f.ranch.capacity}`, percent: f.ranch.capacity ? f.ranch.count / f.ranch.capacity * 100 : 0 };
        if (f.feed) return { text: `牧草 ${f.feed.count} / ${f.capacity}`, percent: f.capacity ? f.feed.count / f.capacity * 100 : 0 };
        return { text: `容量 ${f.capacity}`, percent: 0 };
    };
    const hours = (id: number) => `${((Number((st.buckets || []).find((x: any) => Number(x.id) === id)?.seconds) || 0) / 3600).toFixed(1)}h`;
    const remain = input.ranchRemainSec as any;
    const career = input.career || st.career || null;
    return {
        space: 'ranch',
        level: Number(st.level) || 0,
        exp: { current: Number(st.currentExp) || 0, needed: Number(st.neededExp) || 0 },
        assets: [1007, 1002, 1005, 1008].map(currency).filter(Boolean).map((c: any) => ({ key: c.id, label: c.name, value: formatCount(c.count), image: c.image })),
        stock: [
            { key: 7001, label: '牧草', value: formatCount(st.grass ?? 0), imageId: 7001 },
            ...(dung ? [{ key: 7002, label: dung.name, value: formatCount(dung.count), image: dung.image }] : []),
            { key: 7003, label: '普通罐头', value: hours(7003), imageId: 80021 },
            { key: 7004, label: '有机罐头', value: hours(7004), imageId: 80031 },
        ],
        career: career ? { harvest: Number(career.harvest) || 0, mature: Number(career.mature) || 0, steal: Number(career.steal) || 0 } : null,
        facilities: facilities.map(f => ({ id: String(f.id), name: String(f.name), level: Number(f.level) || 0, ...meter(f), pending: f.state === 2 })),
        todo: [
            { key: 'harvest', label: '可收获', value: animals.filter((a: any) => a.canHarvest).length + shelvesReady },
            { key: 'produce', label: '可生产', value: animals.filter((a: any) => a.canProduce).length },
            { key: 'feed', label: '可喂养', value: animals.filter((a: any) => a.canFeed).length },
            { key: 'clean', label: '待清理', value: hazards },
        ],
        today: ops
            ? [
                { key: 'harvest', label: '收获', count: Number(ops.harvest) || 0 },
                { key: 'produce', label: '生产', count: Number(ops.produce) || 0 },
                { key: 'helpFarming', label: '帮忙清理', count: Number(ops.helpFarming) || 0 },
                { key: 'steal', label: '偷取货架', count: Number(ops.steal) || 0 },
            ]
            : [],
        nextChecks: [{ key: 'ranch', label: '牧场', at: remainToAt(remain, input.now), note: remain === null || remain === undefined ? '今日已完成或暂停' : undefined }],
        notice: blocked ? `牧草不足，${blocked} 只动物已暂停成长。` : undefined,
    };
}

function snapshotHash(snapshot: any): string {
    return JSON.stringify({ ...snapshot, nextChecks: undefined, updatedAt: undefined });
}

type AccountMem = {
    status?: any;
    items?: any[] | null;
    diamond?: number | null;
    ranchState?: any;
    ranchCareer?: any;
    farmCareer?: any;
    ranchOps?: any;
    ranchRemain?: unknown;
};

function createOverviewWriter(options: { cache?: any, now?: () => number, intervalMs?: number } = {}) {
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const intervalMs = options.intervalMs ?? 15_000;
    const mem = new Map<string, AccountMem>();
    const written = new Map<string, { at: number, hash: string }>();
    const timers = new Map<string, NodeJS.Timeout>();
    const cache = () => options.cache || require('./fnos-overview-cache').getOverviewCache();
    const keyOf = (id: string, space: string) => `${id}:${space}`;

    function build(id: string, space: 'farm' | 'ranch'): any | null {
        const m = mem.get(id);
        if (!m) return null;
        const t = now();
        if (space === 'farm') {
            if (!m.status || !(Number(m.status.status?.level) > 0)) return null;
            if (!m.status.connection?.connected) return null;
            return buildFarmSnapshot({ status: m.status, items: m.items, diamond: m.diamond, career: m.farmCareer, prev: cache().get(id).farm, now: t });
        }
        if (!m.ranchState || !(Number(m.ranchState.level) > 0)) return null;
        const prev = cache().get(id).ranch;
        return buildRanchSnapshot({ state: m.ranchState, career: m.ranchCareer || prev?.career, ranchOperations: m.ranchOps, ranchRemainSec: m.ranchRemain, now: t });
    }

    function flush(id: string, space: 'farm' | 'ranch'): boolean {
        const k = keyOf(id, space);
        const timer = timers.get(k);
        if (timer) { clearTimeout(timer); timers.delete(k); }
        let snap: any;
        try { snap = build(id, space); } catch { return false; }
        if (!snap) return false;
        const hash = snapshotHash(snap);
        const prev = written.get(k);
        if (prev && prev.hash === hash) return false;
        try {
            cache().set(id, space, snap);
            written.set(k, { at: now(), hash });
            return true;
        } catch {
            return false;
        }
    }

    function schedule(id: string, space: 'farm' | 'ranch'): void {
        const k = keyOf(id, space);
        const prev = written.get(k);
        if (!prev || now() - prev.at >= intervalMs) { flush(id, space); return; }
        if (timers.has(k)) return;
        const timer = setTimeout(() => { timers.delete(k); flush(id, space); }, Math.max(0, intervalMs - (now() - prev.at)));
        if (typeof (timer as any).unref === 'function') (timer as any).unref();
        timers.set(k, timer);
    }

    const slot = (id: string): AccountMem => {
        let m = mem.get(id);
        if (!m) { m = {}; mem.set(id, m); }
        return m;
    };

    return {
        /** 主进程收到 Worker 的状态同步（农场每次状态刷新；牧场今日收益 / 下次巡查也来自这里） */
        onStatus(accountId: string, status: any): void {
            const id = String(accountId || '');
            if (!id || !status) return;
            const m = slot(id);
            m.status = status;
            m.ranchOps = status.ranchOperations || m.ranchOps;
            m.ranchRemain = status.nextChecks ? status.nextChecks.ranchRemainSec : m.ranchRemain;
            schedule(id, 'farm');
            if (m.ranchState) schedule(id, 'ranch');
        },
        /** 背包读取（巡查、登录初始化、接口调用都会走到）：只保留概览要的几项 */
        onBag(accountId: string, items: any[]): void {
            const id = String(accountId || '');
            if (!id || !Array.isArray(items)) return;
            slot(id).items = items;
            schedule(id, 'farm');
        },
        onDiamond(accountId: string, diamond: unknown): void {
            const id = String(accountId || '');
            const n = Number(diamond);
            if (!id || !Number.isFinite(n)) return;
            slot(id).diamond = Math.max(0, n);
            schedule(id, 'farm');
        },
        /** 牧场数据读取（牧场自动化每轮、牧场页面读取）；overview 视图会带生涯 */
        onRanchState(accountId: string, state: any): void {
            const id = String(accountId || '');
            if (!id || !state || state.unlocked === false) return;
            const m = slot(id);
            m.ranchState = state;
            if (state.career) m.ranchCareer = state.career;
            schedule(id, 'ranch');
        },
        /** 农场巡查每轮单独拉到的生涯（累计收获 / 累计偷菜） */
        onFarmCareer(accountId: string, career: any): void {
            const id = String(accountId || '');
            if (!id || !career) return;
            slot(id).farmCareer = { harvest: Number(career.harvest) || 0, steal: Number(career.steal) || 0 };
            schedule(id, 'farm');
        },
        /** 牧场巡查每轮单独拉到的生涯（不带牧场状态） */
        onRanchCareer(accountId: string, career: any): void {
            const id = String(accountId || '');
            if (!id || !career) return;
            const m = slot(id);
            m.ranchCareer = career;
            if (m.ranchState) schedule(id, 'ranch');
            else {
                const prev = cache().get(id).ranch;
                if (prev) { try { cache().set(id, 'ranch', { ...prev, career: { harvest: Number(career.harvest) || 0, mature: Number(career.mature) || 0, steal: Number(career.steal) || 0 } }); } catch { /* ignore */ } }
            }
        },
        flush,
        dispose(): void { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
    };
}

let defaultWriter: ReturnType<typeof createOverviewWriter> | null = null;
function getOverviewWriter(): ReturnType<typeof createOverviewWriter> {
    if (!defaultWriter) defaultWriter = createOverviewWriter();
    return defaultWriter;
}

module.exports = { createOverviewWriter, getOverviewWriter, buildFarmSnapshot, buildRanchSnapshot };
