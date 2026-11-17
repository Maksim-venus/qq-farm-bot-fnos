import type { RanchAutomationConfig } from '../../config/ranch-automation';
export {};

const { RANCH_SWITCH_KEYS } = require('../../config/ranch-automation');
const { getAutomation } = require('../../models/store');
const { inScene, isUnlocked } = require('./transport');
const { loadRaw, snapshot, inventory, catalog, market, balance } = require('./state');
const { cubMap, quantity } = require('./model');
const { prepareAction, operate } = require('./actions');
const { getServerTimeSec, log } = require('../../utils/utils');
const { getShopGoodsById } = require('../../config/gameConfig');
const reservations = require('./operation-state');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const daily = require('./daily');
// [fnos-fork] 2026-11-16 小号等大号、牧场图鉴、好友牧场大小号规则与额外动作（见 fnos-ranch.ts）
const fnosRanch = require('./fnos-ranch');

let nextCheckAt = 0;
/** [fnos-fork] 2026-11-17 农牧轮流：上一轮算出的「定时事件」时间（动物成熟 / 升级完成 / 等大号到点），供插队判断；0 = 无 */
let timedWakeAtMs = 0;
/** [fnos-fork] 2026-11-17 严格交替：上次牧场例程结束后最早多久能再进（场景重进间隔，取代 ranch_check_minutes 作为进场门槛） */
let reentryAtMs = 0;
const YIELD_REENTRY_MS = 3000;
const ERROR_REENTRY_MS = 2 * 60_000;
/** [fnos-fork] 2026-11-17 好友时间表：到点的好友牧场（gid），本轮好友阶段先去 */
const fnosDueRanch: Array<{ gid: number; name: string; at: number }> = [];
/** [fnos-fork] 2026-11-17 严格交替后牧场一轮很频繁：常规轮巡好友牧场（每轮 3 位）最多每隔「好友列表扫描间隔」
 *  （按时间表偷菜关着时用 ranch_check_minutes）做一次；时间表到点的好友不受限 */
let fnosNextRegularFriendsAt = 0;
/** [fnos-fork] 2026-11-17 本轮好友牧场状态轮巡还没看的好友（让路后接着看） */
const fnosRanchProbeQueue: number[] = [];
function fnosRanchProbePending(): boolean {
    if (fnosRanchProbeQueue.length) return true;
    try {
        const tt = require('../fnos-timetable');
        if (!tt.isEnabled()) return false;
        const cached = require('../friend').getFriendsListCacheOnly();
        return Array.isArray(cached) && cached.length > 0 ? tt.hasRanchProbeWork(cached) : true;
    } catch { return false; }
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }
let nextFriendIndex = 0;
let friendVisits = 0;
let pendingFriendGid: string | null = null;
let cycleStartedAt = 0;
let cycleChanged = false;
const completedPhases = new Set<string>();
const completedSteps = new Set<string>();
const PATROL_SLICE_MS = 5000;
const SCENE_REENTRY_MS = 20_000;
const MARKET_CHECK_MS = 6 * 60 * 60 * 1000;
const MARKET_GOODS_PRIORITY = [80012, 80011];
let nextMarketCheckAt = 0;
let marketRunId = 0;
let lastMarketPoop: bigint | null = null;

function resetCycle(): void {
    completedPhases.clear();
    completedSteps.clear();
    friendVisits = 0;
    pendingFriendGid = null;
    cycleStartedAt = 0;
    cycleChanged = false;
}
const FRIEND_CONTROLS: Record<string, string> = { stroke: 'ranch_stroke', steal: 'ranch_friend_steal', cleanFriend: 'ranch_friend_clean', putMosquito: 'ranch_friend_mosquito' };
const enabled = (key: string) => getAutomation()[key] === true;
function marketDue(): boolean {
    return getAutomation().ranch_market_organic === true && Date.now() >= nextMarketCheckAt;
}
const due = (state: any) => !state.doneToday && Date.now() >= (state.nextCheckAt || 0);

function getRoutineState(): any {
    const auto = getAutomation();
    const work = RANCH_SWITCH_KEYS.some((key: string) => !['ranch_task', 'ranch_share', 'ranch_daily_benefit', 'ranch_grass_buy', 'ranch_market_organic'].includes(key) && auto[key]) || fnosRanch.hasForkWork(); // [fnos-fork]
    const routineDue = work || auto.ranch_task && due(daily.getTaskRoutineState()) || auto.ranch_share && due(daily.getShareRoutineState()) || auto.ranch_daily_benefit && due(daily.getBenefitRoutineState());
    return {
        doneToday: !isUnlocked() || !(routineDue || auto.ranch_market_organic),
        nextCheckAt: routineDue ? nextCheckAt : Math.max(nextCheckAt, nextMarketCheckAt),
        reentryAt: reentryAtMs, // [fnos-fork]
    };
}

function selectAnimal(goods: any[], settings: RanchAutomationConfig, kind: number): any {
    const strategy = settings.ranch_strategy === 'bag_priority' ? settings.ranch_bag_fallback : settings.ranch_strategy;
    const preferred = kind === 1 ? settings.ranch_coop_animal : settings.ranch_shed_animal;
    const candidates = goods.filter(good => good.available && good.animal?.enable_flag
        && good.animal.husbandry_type === (kind === 1 ? '窝' : '棚') && good.price.id === 1007 && BigInt(good.price.count) > 0n);
    if (strategy === 'preferred') return candidates.find(good => good.animal.id === preferred);
    // [fnos-fork] 自动完成牧场图鉴：优先买产物还没进图鉴的动物
    const forBook = fnosRanch.pickAnimalForBook(candidates);
    if (forBook) return forBook;
    const level = (good: any) => Number(getShopGoodsById(Number(good.id))?.conds?.match(/:(\d+)$/)?.[1] || good.requiredLevel || 0);
    return candidates.sort((a, b) => level(b) - level(a) || b.animal.id - a.animal.id)[0];
}

// [fnos-fork] 2026-11-17 农牧轮流：sliceMs = 每次进场最多连续做多久（默认 5 秒切片给农场让路；轮流模式传 Infinity，一轮做完，只为插队的农场定时事件让路）。
// 返回本次结果：done 一整轮做完 / yielded 让路未完 / skipped 无事可做 / disabled / error。
async function run(options: { farmDeadline?: () => number; sliceMs?: number; canContinue?: () => boolean } = {}): Promise<string> {
    if (getRoutineState().doneToday) return 'skipped';
    const sliceMs = options.sliceMs ?? PATROL_SLICE_MS;
    const auto: RanchAutomationConfig = getAutomation();
    if (!cycleStartedAt) cycleStartedAt = Date.now();
    nextCheckAt = cycleStartedAt + auto.ranch_check_minutes * 60_000;
    // [fnos-fork] 2026-11-17 好友时间表：到点的好友牧场排进本轮好友阶段（好友阶段做过了也重新打开）；好友互动全关时清空
    if (!friendTimetableActive()) fnosDueRanch.length = 0;
    else try {
        for (const t of require('../fnos-timetable').takeDueRanch()) {
            if (!fnosDueRanch.some(x => x.gid === t.gid)) fnosDueRanch.push({ gid: t.gid, name: t.name, at: t.at });
        }
    } catch { /* ignore */ }
    if (fnosDueRanch.length) completedPhases.delete('friends');
    const fnosMiscWait = () => { try { return require('../fnos-timetable').miscShouldWait(); } catch { return false; } };
    try {
        // 名单只用作拜访索引，实际资格由进好友牧场后的回包确认；复用农场已同步的名单。
        let friends: any[] = [];
        if (!completedPhases.has('friends') && Object.values(FRIEND_CONTROLS).some(enabled)) {
            const friendService = require('../friend');
            friends = friendService.getFriendsListCacheOnly();
            if (!friends.length) friends = await friendService.getFriendsList(false, 'normal', true);
        }
        // 首次名单读取可能较久，仍留在农场，等下一次空档再切换。
        if (options.canContinue?.() === false || Date.now() >= (options.farmDeadline?.() ?? Infinity)) {
            nextCheckAt = Date.now() + SCENE_REENTRY_MS;
            reentryAtMs = Date.now() + YIELD_REENTRY_MS; // [fnos-fork]
            return 'yielded';
        }
        await inScene(async (cells: any) => {
            const startedAt = Date.now();
            let steps = 0;
            const shouldYield = () => options.canContinue?.() === false
                || Date.now() >= Math.min(startedAt + sliceMs, options.farmDeadline?.() ?? Infinity);
            const checkpoint = () => {
                if (options.canContinue?.() === false || steps > 0 && shouldYield()) throw Object.assign(new Error('牧场巡查让路'), { code: 'RANCH_PATROL_YIELD' });
            };
            async function phase(name: string, work: () => Promise<any>): Promise<void> {
                if (completedPhases.has(name)) return;
                await work();
                completedPhases.add(name);
            }
            checkpoint();
            let raw = await loadRaw(cells);
            let nextActionAt = Infinity;
            const updateDeadline = () => {
                const state = snapshot(raw);
                const upcoming = state.facilities.flatMap((f: any) => [
                    ...(auto.ranch_harvest || auto.ranch_produce ? (f.ranch?.animals || []).map((a: any) => a.nextAtMs) : []),
                    auto.ranch_upgrade && f.upgradeState ? (f.upgradeEndTime < 100_000_000_000 ? f.upgradeEndTime * 1000 : f.upgradeEndTime) : 0,
                ]).filter((at: any) => at > state.serverTime);
                nextActionAt = upcoming.length ? Date.now() + Math.min(...upcoming) - state.serverTime : Infinity;
                // 续跑期间出现新成熟动物时，先处理自家产出，再接着原来的进度。
                for (const [action, flag] of [['harvest', 'can_harvest'], ['produce', 'can_deliver']]) {
                    // [fnos-fork] 小号等大号：在等大号偷的货架不算「可收」，避免反复进场
                    const ready = action === 'harvest' ? fnosRanch.ownHarvestReady(raw)
                        : raw.cells.facilities.some((f: any) => f.ranch?.animals.some((a: any) => a[flag]));
                    if (ready && enabled(action === 'harvest' ? 'ranch_harvest' : 'ranch_produce')) {
                        completedPhases.delete(action);
                        completedSteps.delete(`${action}:{"all":true}`);
                        nextActionAt = Math.min(nextActionAt, Date.now());
                    }
                }
            };
            updateDeadline();
            const available = (id: number) => {
                const funds = balance(raw.bag, id);
                return BigInt(funds.total) - BigInt(funds.locked) - BigInt(reservations.forCurrentAccount().reserved(`item:${id}`));
            };
            const affordable = (good: any, wanted: number) => {
                const money = available(good.price.id);
                const count = money > 0n ? money / BigInt(good.price.count) : 0n;
                return Number(count < BigInt(wanted) ? count : BigInt(wanted));
            };
            async function act(key: string, action: string, input: any = {}, currency?: number, progress?: string): Promise<boolean> {
                const isEnabled = () => enabled(key) && (key !== 'ranch_grass_buy' || enabled('ranch_grass'));
                if (!isEnabled()) return false;
                const step = `${action}:${JSON.stringify(input)}${progress === undefined ? '' : `:${progress}`}`;
                if (completedSteps.has(step)) return false;
                checkpoint();
                let label = action;
                try {
                    const quote = await prepareAction(action, input);
                    label = quote.label;
                    if (quote.skipped || currency && quote.costItems.some((cost: any) => cost.id !== currency)
                        || key === 'ranch_market_organic' && (quote.rewards.length !== 1 || !MARKET_GOODS_PRIORITY.includes(Number(quote.rewards[0].id)))) {
                        completedSteps.add(step);
                        steps++;
                        return false;
                    }
                    if (!isEnabled()) return false;
                    checkpoint();
                    const parent = getAmbientSendContext();
                    const result = await runWithSendContext({
                        check: (service: string, method: string) => parent?.check(service, method) || (isEnabled() ? null
                            : Object.assign(new Error('牧场操作开关已关闭'), { code: 'RANCH_AUTOMATION_DISABLED' })),
                        onSent: (service: string, method: string) => parent?.onSent(service, method),
                    }, () => operate(action, { ...input, expected: quote.expected }));
                    completedSteps.add(step);
                    steps++;
                    if (result.status === 'skipped') return false;
                    cycleChanged = true;
                    log('牧场', `${quote.label}${result.notice ? `：${result.notice}` : '完成'}`, { module: 'ranch', event: `ranch_${action}`, result: 'ok' });
                    raw = await loadRaw();
                    updateDeadline();
                    return true;
                } catch (error: any) {
                    // 状态或余额变化交给下一次巡查重新报价；已发出但结果未知的写入由持久账本保护。
                    if (['INSUFFICIENT_BALANCE', 'RESERVE_PROTECTED', 'PENDING_CONFIRMATION', 'RANCH_OFFER_CHANGED', 'GOODS_UNAVAILABLE', 'RANCH_STATE_CHANGED'].includes(error.code)) {
                        completedSteps.add(step);
                        steps++;
                        log('牧场', `${label} 暂未执行：${error.message}`, { module: 'ranch', event: `ranch_${action}`, result: 'skipped' });
                        return false;
                    }
                    throw error;
                }
            }

            await phase('harvest', async () => {
                // [fnos-fork] 小号等大号：有货架在等大号偷时只收成熟动物（op=4），不碰货架
                if (!enabled('ranch_harvest')) return;
                if (fnosRanch.planOwnHarvest(raw).mode === 'all') return act('ranch_harvest', 'harvest', { all: true });
                const ready = raw.cells.facilities.flatMap((f: any) => (f.ranch?.animals || []).filter((a: any) => a.can_harvest));
                for (const animal of ready) await act('ranch_harvest', 'harvest', { ranchId: quantity(animal.ranch_inst_id), animalId: animal.animal_inst_id });
            });
            await phase('produce', () => act('ranch_produce', 'produce', { all: true }));
            await phase('clean', () => act('ranch_clean', 'clean'));
            await phase('sell', () => act('ranch_sell', 'sell', { all: true }));

            await phase('market-organic', async () => {
                if (!enabled('ranch_market_organic')) return;
                const poop = available(7002);
                const stockReady = poop >= 3n && (lastMarketPoop === null || poop > lastMarketPoop);
                if (!marketDue() && !stockReady) return;
                checkpoint();
                const runId = marketRunId;
                const current = await market(raw);
                // 先兑尽 4 小时，再兑 1 小时；只使用便便，不碰松果或其它货币的同名商品。
                if (current.opened && current.present) {
                    for (const rewardId of MARKET_GOODS_PRIORITY) {
                        for (const good of current.goods.filter((entry: any) => entry.available && Number(entry.reward.id) === rewardId && Number(entry.price.id) === 7002 && BigInt(entry.price.count) > 0n)) {
                            while (good.available) {
                                const stock = available(7002);
                                const count = affordable(good, Math.min(good.remaining ?? 2147483647, 2147483647));
                                if (count < 1) break;
                                const exchanged = await act('ranch_market_organic', 'exchange', { goodsId: good.id, count }, 7002, `${runId}:${good.id}:${stock}`);
                                if (!exchanged) break;
                                if (good.remaining !== null) good.remaining = Math.max(0, good.remaining - count);
                                if (good.remaining === 0) good.available = false;
                            }
                        }
                    }
                }
                // 完成后才推迟检查；让路时保留到期状态，到账通知也不能被旧一轮覆盖。
                lastMarketPoop = available(7002);
                if (runId === marketRunId) nextMarketCheckAt = Date.now() + MARKET_CHECK_MS;
            });

            await phase('upgrade', async () => {
                if (enabled('ranch_upgrade')) {
                    for (const facility of snapshot(raw).facilities) {
                        const end = facility.upgradeEndTime < 100_000_000_000 ? facility.upgradeEndTime * 1000 : facility.upgradeEndTime;
                        if (facility.active && facility.upgradeState && (facility.upgradeState === 2 || end <= getServerTimeSec() * 1000)) {
                            await act('ranch_upgrade', 'completeUpgrade', { facilityId: facility.id });
                        } else if (facility.next?.available) {
                            await act('ranch_upgrade', 'upgrade', { facilityId: facility.id }, 1007);
                        }
                    }
                }
            });

            await phase('buy', async () => {
                if (enabled('ranch_buy') && raw.cells.facilities.some((f: any) => f.state === 1 && f.ranch && f.ranch.animal_count < f.ranch.capacity)) {
                    const shop = await catalog(raw, 5);
                    for (const original of raw.cells.facilities.filter((f: any) => f.state === 1 && f.ranch)) {
                        const id = quantity(original.instance_id);
                        const selected = selectAnimal(shop.goods, auto, original.ranch.husbandry_type);
                        const stock = inventory(raw).filter((item: any) => !item.locked && item.animalId && BigInt(item.count) > 0n
                            && cubMap.get(item.id).husbandry_type === (original.ranch.husbandry_type === 1 ? '窝' : '棚')
                            && (auto.ranch_strategy === 'bag_priority' || item.animalId === selected?.animal.id)).sort((a: any, b: any) => b.animalId - a.animalId);
                        const room = () => {
                            const current = raw.cells.facilities.find((f: any) => quantity(f.instance_id) === id);
                            return current.ranch.capacity - current.ranch.animal_count;
                        };
                        for (const item of stock) {
                            const count = Number(BigInt(Math.max(0, room())) < available(item.id) ? BigInt(Math.max(0, room())) : available(item.id));
                            if (count > 0) await act('ranch_buy', 'place', { ranchId: id, itemId: item.id, count });
                        }
                        if (room() > 0 && selected) {
                            const count = affordable(selected, Math.min(room(), selected.maxCount, selected.remaining ?? Infinity));
                            if (count > 0) await act('ranch_buy', 'buy', { shopId: 5, goodsId: selected.id, count, autoPlace: true }, 1007);
                        }
                    }
                }
            });

            await phase('grass', async () => {
                if (enabled('ranch_grass')) {
                    for (const original of raw.cells.facilities.filter((f: any) => f.state === 1 && f.feed_machine)) {
                        const id = quantity(original.instance_id);
                        let room = original.capacity - original.feed_machine.feed_count;
                        if (room <= 0 || original.feed_machine.feed_count * 100 >= original.capacity * auto.ranch_grass_threshold_percent) continue;
                        let stock = Math.max(0, Number(available(7001)));
                        if (stock < room && enabled('ranch_grass_buy')) {
                            const shop = await catalog(raw, 6);
                            const good = shop.goods.find((g: any) => g.available && g.reward.id === 7001 && g.reward.count === '1' && g.price.id === 1007 && BigInt(g.price.count) > 0n);
                            if (good) {
                                while (stock < room) {
                                    const count = affordable(good, Math.min(room - stock, good.maxCount, good.remaining ?? Infinity));
                                    // 按已到账库存区分限购批次，续跑时重新读取缺额，沿用农场到期让路。
                                    if (count <= 0 || !await act('ranch_grass_buy', 'buy', { shopId: 6, goodsId: good.id, count }, 1007, `${id}:${stock}`)) break;
                                    if (good.remaining !== null) good.remaining -= count;
                                    const current = raw.cells.facilities.find((f: any) => quantity(f.instance_id) === id);
                                    room = current.capacity - current.feed_machine.feed_count;
                                    stock = Math.max(0, Number(available(7001)));
                                }
                            }
                        }
                        const count = Math.min(room, Number(available(7001)));
                        if (count > 0) await act('ranch_grass', 'addGrass', { facilityId: id, count });
                    }
                }
            });

            await phase('cans', async () => {
                if (enabled('ranch_fill_cans')) {
                    for (const item of inventory(raw).filter((item: any) => item.can && !item.locked)) {
                        const count = Number(BigInt(item.count) < available(item.id) ? BigInt(item.count) : available(item.id));
                        if (count > 0) await act('ranch_fill_cans', 'useCan', { uid: item.uid, count });
                    }
                }
            });

            await phase('feed-normal', async () => { if (enabled('ranch_feed_normal') && available(7003) > 0n) await act('ranch_feed_normal', 'feed', { all: true, bucketType: 2 }); });
            await phase('feed-organic', async () => { if (enabled('ranch_feed_organic') && available(7004) > 0n) await act('ranch_feed_organic', 'feed', { all: true, bucketType: 1 }); });

            await phase('friends', async () => {
                // [fnos-fork] 2026-11-17 没有到点的好友牧场、常规轮巡也没到间隔、也没有要探的好友牧场：这一轮不碰好友（省掉次数查询和好友列表）
                if (!fnosDueRanch.length && !pendingFriendGid && Date.now() < fnosNextRegularFriendsAt && !fnosRanchProbePending()) return;
                if (Object.values(FRIEND_CONTROLS).some(enabled) || fnosRanch.friendExtrasEnabled()) { // [fnos-fork] 帮好友生产 / 给好友加牧草
                    fnosRanch.beginFriendPhase({ gold: Number(available(1007)), grass: Number(available(7001)) }); // [fnos-fork] 2026-11-17 给好友加牧草默认用仓库牧草
                    checkpoint();
                    const interactions = require('./friends');
                    const times = await interactions.getInteractionTimes();
                    const wanted = (action: string) => enabled(FRIEND_CONTROLS[action])
                        && (!['stroke', 'putMosquito'].includes(action) || times[action] > 0);
                    if (Object.keys(FRIEND_CONTROLS).some(wanted) || fnosRanch.friendExtrasEnabled()) { // [fnos-fork]
                        if (!friends.length) friends = await require('../friend').getFriendsList(); // 上游 #148 已先读缓存名单
                        const anyWanted = () => Object.keys(FRIEND_CONTROLS).some(wanted) || fnosRanch.friendExtrasEnabled();
                        const visitOne = async (friend: any): Promise<void> => {
                            try {
                                // [fnos-fork] 大小号规则：不偷大号 / 不帮大号清 / 放蚊子只给大号或不给大小号
                                const result = await interactions.automateFriend(friend.gid, fnosRanch.wrapFriendWanted(friend.gid, wanted), shouldYield);
                                Object.assign(times, result.times);
                                steps++;
                                for (const outcome of result.results) {
                                    daily.markTasksChanged();
                                    log('牧场', `${friend.name}：${outcome.notice}`, { module: 'ranch', event: `ranch_${outcome.action}`, result: 'ok' });
                                }
                                if (result.yielded) {
                                    pendingFriendGid = String(friend.gid);
                                    throw Object.assign(new Error('牧场好友巡查让路'), { code: 'RANCH_PATROL_YIELD' });
                                }
                            } catch (error: any) {
                                if (error.name !== 'GatewayError' || error.methodName !== 'EnterHomestead') throw error;
                                log('牧场', `暂不能拜访 ${friend.name}：${error.message}`, { module: 'ranch', event: 'ranch_friend', result: 'skipped' });
                            }
                            pendingFriendGid = null;
                        };
                        // [fnos-fork] 2026-11-17 好友时间表：先去到点的好友牧场（不占每轮 3 位的名额）
                        if (!anyWanted()) fnosDueRanch.length = 0;
                        while (fnosDueRanch.length && anyWanted()) {
                            checkpoint();
                            const due = fnosDueRanch[0];
                            const friend = friends.find((row: any) => Number(row.gid) === due.gid);
                            if (friend) {
                                if (pendingFriendGid !== String(friend.gid)) {
                                    log('牧场', `按时间表前往 ${friend.name || due.name}（预计可偷 ${require('../fnos-timetable').formatClock(due.at)}）`, { module: 'ranch', event: 'fnos好友牧场', result: 'timetable', friendGid: due.gid });
                                }
                                await visitOne(friend);
                            }
                            fnosDueRanch.shift();
                        }
                        // [fnos-fork] 2026-11-17 用户「轮完自己的工作，立刻轮好友农牧场状态」：按时间表偷菜开着时，自家牧场做完后
                        // 把要探的好友牧场（未扫描 / 暂无可偷到复查时间）轮一遍；已知可偷时间的跳过；翻阅节奏 500～1000 毫秒、每 300 位休息
                        const tt = require('../fnos-timetable');
                        if (tt.isEnabled()) {
                            if (!fnosRanchProbeQueue.length && !pendingFriendGid) {
                                const targets = tt.ranchProbeTargets(friends);
                                fnosRanchProbeQueue.push(...targets.map((f: any) => Number(f.gid)));
                                if (targets.length) log('牧场', `好友牧场状态轮巡：本轮 ${targets.length} 位，已知可偷时间的跳过`, { module: 'ranch', event: 'fnos好友牧场', result: 'probe', count: targets.length });
                            }
                            while ((fnosRanchProbeQueue.length || pendingFriendGid) && anyWanted()) {
                                checkpoint();
                                const gid = pendingFriendGid ? Number(pendingFriendGid) : fnosRanchProbeQueue[0];
                                const friend = friends.find((row: any) => Number(row.gid) === gid);
                                if (fnosRanchProbeQueue[0] === gid) fnosRanchProbeQueue.shift();
                                if (!friend) { pendingFriendGid = null; continue; }
                                const before = steps;
                                await visitOne(friend);
                                if (steps === before) tt.noteRanchProbeFailed(gid); // 进不去：1 小时内不再探
                                const pace = tt.nextPageTurn();
                                await sleep(pace.gapMs);
                                if (pace.restMs > 0 && fnosRanchProbeQueue.length) {
                                    log('牧场', `已翻阅 ${pace.count} 位好友，休息 ${Math.round(pace.restMs / 1000)} 秒`, { module: 'ranch', event: 'fnos好友牧场', result: 'rest' });
                                    for (let left = pace.restMs; left > 0; left -= 1000) { checkpoint(); await sleep(Math.min(1000, left)); }
                                }
                            }
                            if (!anyWanted()) fnosRanchProbeQueue.length = 0;
                        } else
                        // 沿用本轮巡查，每轮最多拜访三位，避免长期占用农牧场共用连接。
                        if (Date.now() >= fnosNextRegularFriendsAt || pendingFriendGid) {
                            for (; friendVisits < Math.min(3, friends.length) && anyWanted(); friendVisits++) {
                                checkpoint();
                                const friend = friends.find((row: any) => String(row.gid) === pendingFriendGid) || friends[nextFriendIndex % friends.length];
                                await visitOne(friend);
                                nextFriendIndex++;
                            }
                            let gapMs = 0;
                            try { gapMs = Number(require('../fnos-timetable').scanIntervalMs()) || 0; } catch { gapMs = 0; }
                            fnosNextRegularFriendsAt = Date.now() + (gapMs > 0 ? gapMs : Math.max(1, Number(auto.ranch_check_minutes) || 1) * 60_000);
                        }
                    }
                }
            });

            if (cycleChanged) daily.markTasksChanged();
            // [fnos-fork] 2026-11-17 杂项（牧场任务 / 分享 / 每日福利 / 图鉴）只在空闲时做：30 秒内有收获 / 偷菜 / 帮忙到点就留到下一轮
            const miscWait = fnosMiscWait();
            if (miscWait) log('牧场', '有收获 / 偷菜 / 帮忙即将到点，牧场任务、分享、每日福利、图鉴留到空闲时再做', { module: 'ranch', event: 'fnos牧场轮次', result: 'misc_deferred' });
            if (!miscWait) await phase('tasks', async () => { if (enabled('ranch_task') && due(daily.getTaskRoutineState())) { checkpoint(); await daily.claimTasks(); steps++; } });
            if (!miscWait) await phase('share', async () => { if (enabled('ranch_share') && due(daily.getShareRoutineState())) { checkpoint(); await daily.claimShare(); steps++; } });
            // [fnos-fork] 上游 #142 牧场每日福利同样算杂项，空闲时领
            if (!miscWait) await phase('benefit', async () => { if (enabled('ranch_daily_benefit') && due(daily.getBenefitRoutineState())) { checkpoint(); await daily.claimBenefit(); steps++; } });
            if (!miscWait) await phase('fnos-book', async () => { if (await fnosRanch.runBook()) cycleChanged = true; }); // [fnos-fork] 牧场图鉴自动领取
            if (fnosRanch.holdWakeAt() > 0) nextActionAt = Math.min(nextActionAt, fnosRanch.holdWakeAt()); // [fnos-fork] 等大号超时放行时提前回来
            timedWakeAtMs = Number.isFinite(nextActionAt) ? nextActionAt : 0; // [fnos-fork] 农牧轮流插队时间点
            nextCheckAt = Math.max(Date.now() + SCENE_REENTRY_MS, Math.min(nextCheckAt, nextActionAt, cycleChanged ? Date.now() + 30_000 : Infinity));
            resetCycle();
        });
        reentryAtMs = Date.now(); // [fnos-fork] 2026-11-17 去掉 20 秒重进间隔：什么时候再进牧场由农牧轮流（每边至少 1 分钟）决定
        return 'done';
    } catch (error: any) {
        if (error.code === 'RANCH_PATROL_YIELD') {
            nextCheckAt = Date.now() + SCENE_REENTRY_MS;
            reentryAtMs = Date.now() + YIELD_REENTRY_MS; // [fnos-fork] 让路后插队的事做完就接着做
            return 'yielded';
        }
        resetCycle();
        reentryAtMs = Date.now() + (error.code === 'RANCH_AUTOMATION_DISABLED' ? SCENE_REENTRY_MS : ERROR_REENTRY_MS); // [fnos-fork]
        if (error.code === 'RANCH_AUTOMATION_DISABLED') return 'disabled';
        nextCheckAt = Date.now() + Math.max(auto.ranch_check_minutes, 10) * 60_000;
        log('牧场', `日常牧场巡查失败：${error.message}`, { module: 'ranch', event: 'ranch_automation', result: 'error' });
        return 'error';
    }
}

// 上游 #147：便便到账后重新判断有机化肥兑换
function resetMarketSchedule(): void {
    nextMarketCheckAt = 0;
    lastMarketPoop = null;
    marketRunId++;
    completedPhases.delete('market-organic');
    nextCheckAt = Math.min(nextCheckAt, Date.now() + SCENE_REENTRY_MS);
    reentryAtMs = Math.min(reentryAtMs, Date.now() + YIELD_REENTRY_MS); // [fnos-fork]
}

/** [fnos-fork] 2026-11-17 农牧轮流：牧场定时事件（动物成熟 / 升级完成 / 等大号到点）的时间，今天无事或没有时返回 0 */
function timedWakeAt(): number {
    return getRoutineState().doneToday ? 0 : timedWakeAtMs;
}

/** [fnos-fork] 2026-11-17 好友牧场互动（偷 / 抚摸 / 清理 / 放蚊子 / 帮生产 / 加牧草）有任一开着：好友牧场时间表才有意义 */
function friendTimetableActive(): boolean {
    try { return Object.values(FRIEND_CONTROLS).some(enabled) || fnosRanch.friendExtrasEnabled(); } catch { return false; }
}

/** [fnos-fork] 2026-11-17 还有排队的到点好友牧场（让路后续跑） */
function hasPendingDueFriends(): boolean { return fnosDueRanch.length > 0; }

module.exports = { run, getRoutineState, selectAnimal, timedWakeAt, hasPendingDueFriends, friendTimetableActive, resetMarketSchedule, resetSchedule: () => { marketRunId++; nextMarketCheckAt = 0; lastMarketPoop = null; nextCheckAt = 0; timedWakeAtMs = 0; reentryAtMs = 0; fnosDueRanch.length = 0; fnosNextRegularFriendsAt = 0; fnosRanchProbeQueue.length = 0; resetCycle(); } };
