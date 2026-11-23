import ranchLimits from '../../gameConfig/ranch/MCRanchFacilityConfig.json';
export {};

const { rpc, inScene } = require('./transport');
const network = require('../../utils/network');
const { error, positiveId, positiveCount, quantity, itemDto, sumItems } = require('./model');
const { animalDto, ranchCareer } = require('./state');
const reservations = require('./operation-state');
const { recordOperation } = require('../stats');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { getServerTimeSec, logWarn } = require('../../utils/utils');

// 每个账号 Worker 仅记住服务端确认已经用完的次数，按游戏日（北京时间）失效。
const exhaustedUntil = new Map<string, number>();
const DAY_SECONDS = 86_400;
const SHANGHAI_OFFSET_SECONDS = 8 * 3600;

function nextQuotaReset(serverSeconds = getServerTimeSec()): number {
    return serverSeconds + DAY_SECONDS - (serverSeconds + SHANGHAI_OFFSET_SECONDS) % DAY_SECONDS;
}

function getInteractionQuotaResetAt(action: string): number {
    const reset = exhaustedUntil.get(action);
    if (reset === undefined) return 0;
    const serverSeconds = getServerTimeSec();
    return reset === nextQuotaReset(serverSeconds) ? Date.now() + (reset - serverSeconds) * 1000 : 0;
}

function rememberQuota(action: string, count: number, reset: number): void {
    if (reset !== nextQuotaReset()) return;
    if (count === 0) exhaustedUntil.set(action, reset);
    else exhaustedUntil.delete(action);
}

function targets(ranches: any[]): any[] {
    const gid = quantity(network.getUserState().gid);
    return ranches.flatMap(ranch => ranch.shelves.filter((shelf: any) => shelf.can_steal && shelf.lots.some((lot: any) =>
        lot.can_steal && BigInt(quantity(lot.remain_num)) > 0n && !lot.stealers.some((id: any) => quantity(id) === gid)))
        .map((shelf: any) => ({ ranchId: quantity(ranch.ranch_inst_id), slot: shelf.slot_index,
            itemIds: shelf.lots.filter((lot: any) => lot.can_steal && !lot.stealers.some((id: any) => quantity(id) === gid)).map((lot: any) => quantity(lot.item_id)) })));
}

async function withFriendVisit(hostGid: unknown, run: (entry: any, host: string) => Promise<any>): Promise<any> {
    const host = positiveId(hostGid, '好友GID');
    if (host === quantity(network.getUserState().gid)) throw error('INVALID_ARGUMENT', '请选择好友牧场');
    return inScene(async () => {
        const socket = network.getWs();
        let result: any;
        let entryRejected = false;
        try {
            const entry = await rpc('enterFriend', { host_gid: host, reason: 2 });
            if (quantity(entry.basic?.gid) !== host || !entry.homestead_cells) throw error('RANCH_RESPONSE_MISMATCH', '好友牧场回包与目标不匹配');
            require('./fnos-friend-levels').recordLevel(host, Number(entry.basic.big_farm_level), 'visit'); // [fnos-fork] 进场顺手记牧场等级
            result = await run(entry, host);
            return result;
        } catch (error: any) {
            entryRejected = error.name === 'GatewayError' && error.serviceName === 'gamepb.visitpb.VisitService' && error.methodName === 'EnterHomestead';
            throw error;
        } finally {
            if (!entryRejected && network.getWs() === socket) {
                try {
                    await runWithSendContext({ check: () => null, onSent: () => {} }, () => rpc('leaveFriend', { host_gid: host }));
                } catch (error: any) {
                    logWarn('牧场', `离开好友牧场失败：${error.message}`, { module: 'ranch', event: 'ranch_friend_leave' });
                    network.invalidateGameScene('好友牧场离场未确认，需要重新登录');
                    if (result) Object.assign(result, { sceneRestored: false, refreshRequired: true, notice: '好友牧场离场未确认，账号需重新登录；请核对操作结果' });
                }
            }
        }
    });
}

function visit(hostGid: unknown, run: (entry: any, ranches: any[], host: string) => Promise<any>, fnosOptions: { entryOnly?: boolean } = {}): Promise<any> {
    return withFriendVisit(hostGid, async (entry, host) => {
        // [fnos-fork] entryOnly：慢读牧场等级只要进场回包，不再读动物详情
        const detail = fnosOptions.entryOnly ? { ranches: [] } : await rpc('animals', { host_gid: host });
        return run(entry, detail.ranches, host);
    });
}

async function getFriend(hostGid: unknown): Promise<any> {
    return visit(hostGid, async (entry, ranches, host) => {
        const eligible = targets(ranches);
        const times = await getInteractionTimes();
        const machine = entry.homestead_cells.facilities.find((facility: any) => facility.module_type === 8 && facility.state === 1 && facility.feed_machine);
        return { gid: host, name: entry.basic.name, level: Number(entry.basic.big_farm_level),
            career: await ranchCareer(Number(host)),
            feedMachine: machine ? { id: quantity(machine.instance_id), count: machine.feed_machine.feed_count, capacity: machine.capacity } : null,
            canSteal: eligible.length > 0, stealableShelves: eligible.length,
            cleanableHazards: ranches.reduce((sum, ranch) => sum + cleanableHazards(ranch).length, 0),
            strokeRemaining: times.stroke, mosquitoRemaining: times.putMosquito,
            // [fnos-fork] 大小号规则置灰原因（空串=允许）与「捣乱」可放蚊子数
            fnosRules: require('./fnos-ranch').manualFriendRules(host),
            fnosBadCount: badPlan(ranches, host, times).count,
            ranches: ranches.map(ranch => ({ id: quantity(ranch.ranch_inst_id),
                name: ranch.husbandry_type === 1 ? '窝' : '棚',
                ...mosquitoState(ranch),
                animals: ranch.animals.map((animal: any) => ({ ...animalDto(animal),
                    stroked: hasStroked(animal), canStroke: times.stroke > 0 && canStroke(animal) })),
                shelves: ranch.shelves.map((shelf: any) => ({ slot: shelf.slot_index,
                    canSteal: eligible.some(target => target.ranchId === quantity(ranch.ranch_inst_id) && target.slot === shelf.slot_index),
                    products: shelf.lots.map((lot: any) => itemDto({ id: lot.item_id, count: lot.remain_num })) })) })) };
    });
}

/** [fnos-fork] 慢读好友牧场等级：只进场读 basic.big_farm_level 再离开（离场确认同 visit），不做任何操作。 */
async function peekLevel(hostGid: unknown, canRun: () => boolean = () => true): Promise<number> {
    if (!canRun()) return 0;
    return visit(hostGid, async (entry) => Number(entry.basic.big_farm_level) || 0, { entryOnly: true });
}

async function getInteractionTimes(): Promise<any> {
    const reset = nextQuotaReset();
    const reply = await rpc('opTimes', { op_ids: [] });
    const remaining = (id: number, action?: string) => {
        const op = reply.ops.find((row: any) => quantity(row.op_id) === String(id));
        if (!op) throw error('RANCH_RESPONSE_MISMATCH', '牧场互动剩余次数未返回');
        const count = Number(quantity(op.remaining_times));
        if (!Number.isSafeInteger(count) || count < 0) throw error('RANCH_RESPONSE_MISMATCH', '牧场互动剩余次数无效');
        const limit = Number(quantity(op.times_limit));
        if (action && (count > 0 || limit > 0 && Number(quantity(op.used_times)) >= limit)) rememberQuota(action, count, reset);
        return count;
    };
    return { stroke: remaining(11009, 'stroke'), putMosquito: remaining(11003, 'putMosquito'), release: remaining(11008) };
}

function hasStroked(animal: any): boolean {
    const gid = quantity(network.getUserState().gid);
    return !!animal.mutation?.stroked_gids.some((id: any) => quantity(id) === gid);
}

function canStroke(animal: any): boolean {
    return !!animal.mutation?.strokable && !hasStroked(animal);
}

function mosquitoState(ranch: any): any {
    const configId = { 1: 6001001, 2: 6002001 }[ranch.husbandry_type as 1 | 2];
    const mosquitoLimit = ranchLimits.find(row => row.id === configId)?.mosquito_max_count ?? 0;
    const mosquitoes = ranch.hazards.filter((hazard: any) => hazard.hazard_type === 1).length;
    return { mosquitoes, mosquitoLimit, mosquitoRoom: Math.max(0, mosquitoLimit - mosquitoes) };
}

function cleanableHazards(ranch: any): any[] {
    const gid = quantity(network.getUserState().gid);
    return ranch.hazards.filter((hazard: any) => hazard.hazard_type !== 1 || quantity(hazard.owner) !== gid);
}

function interactionPlan(action: string, input: any, ranches: any[], host: string, times: any): any {
    if (action === 'cleanFriend') {
        const pens = ranches.filter(ranch => cleanableHazards(ranch).length);
        const payload = { host_gid: host, ranch_inst_ids: pens.map(ranch => quantity(ranch.ranch_inst_id)) };
        const hazards = pens.flatMap(ranch => cleanableHazards(ranch).map((hazard: any) => `${quantity(ranch.ranch_inst_id)}:${quantity(hazard.hazard_id)}`));
        return { action, label: '清理好友牧场', payload, count: hazards.length, target: `ranch:cleanFriend:${host}`,
            signature: JSON.stringify({ action, payload, hazards }) };
    }
    const ranchId = positiveId(input.ranchId, '牧场设施');
    const ranch = ranches.find(row => quantity(row.ranch_inst_id) === ranchId);
    if (!ranch) throw error('RANCH_STATE_CHANGED', '好友栏舍已变化，请刷新');
    if (times[action] <= 0) throw error('RANCH_INTERACTION_LIMIT', '今日互动次数已用完');
    let payload: any; let label: string; let marker: any;
    if (action === 'stroke') {
        const animalId = positiveCount(input.animalId);
        const animal = ranch.animals.find((row: any) => row.animal_inst_id === animalId);
        if (!animal || !canStroke(animal)) throw error('RANCH_STATE_CHANGED', '这只动物已抚摸或当前不能抚摸');
        payload = { host_gid: host, target: { ranch_inst_id: ranchId, animal_inst_id: animalId } };
        label = `抚摸${animalDto(animal).name}`;
        marker = quantity(animal.animal_id);
    } else {
        const state = mosquitoState(ranch);
        if (!state.mosquitoLimit) throw error('RANCH_CONFIG_UNKNOWN', '该栏舍的蚊子上限尚未确认');
        if (!state.mosquitoRoom) throw error('RANCH_HAZARD_FULL', `该栏舍已有 ${state.mosquitoLimit} 只蚊子`);
        payload = { host_gid: host, ranch_inst_id: ranchId, op_id: 11003, count: 1 };
        label = `向好友${ranch.husbandry_type === 1 ? '窝' : '棚'}放蚊子`;
        // 同一栏舍的未决投放始终共用目标，不因新污物而重复提交。
        marker = { mosquitoes: state.mosquitoes, limit: state.mosquitoLimit, hazards: ranch.hazards.map((hazard: any) => quantity(hazard.hazard_id)) };
    }
    return { action, label, payload, marker, remaining: times[action], count: 1,
        target: `ranch:${action}:${host}:${ranchId}${action === 'stroke' ? `:${payload.target.animal_inst_id}` : ''}`,
        signature: JSON.stringify({ action, payload, marker }) };
}

async function prepareInteraction(action: string, input: any): Promise<any> {
    if (action !== 'stroke') require('./fnos-ranch').assertManualFriendAction(input.hostGid, action); // [fnos-fork]
    return visit(input.hostGid, async (_entry, ranches, host) => {
        const plan = interactionPlan(action, input, ranches, host, action === 'cleanFriend' ? null : await getInteractionTimes());
        return { action, label: plan.label, costs: [], costItems: [], rewards: [], count: plan.count,
            expected: { signature: plan.signature }, skipped: plan.count === 0 };
    });
}

async function commitInteraction(plan: any, ranch?: any): Promise<any> {
    if (!plan.count) return { action: plan.action, status: 'skipped', costs: [], rewards: [], completed: 0, snapshot: null };
    return reservations.forCurrentAccount().spend({ target: plan.target, label: plan.label, costs: [], balances: [] }, async () => {
        const reset = nextQuotaReset();
        const reply = await rpc(plan.action === 'cleanFriend' ? 'clean' : plan.action, plan.payload, true);
        const remaining = Number(quantity(reply.remaining_times));
        const invalid = () => { throw error('RANCH_RESULT_UNKNOWN', `${plan.label}结果未能确认，请刷新核对，勿重复提交`); };
        if (plan.action !== 'cleanFriend' && remaining !== plan.remaining - 1) invalid();
        let rewards: any[];
        let completed = 1;
        if (plan.action === 'cleanFriend') {
            const keys = new Set<string>();
            for (const row of reply.op_results) {
                const key = `${quantity(row.facility_inst_id)}:${quantity(row.target_id)}`;
                if (row.kind !== 3 || !plan.payload.ranch_inst_ids.includes(quantity(row.facility_inst_id))
                    || BigInt(quantity(row.target_id)) <= 0n || keys.has(key) || row.costs.length) invalid();
                keys.add(key);
            }
            completed = reply.op_results.length;
            rewards = reply.op_results.flatMap((row: any) => row.rewards);
        } else if (plan.action === 'stroke') {
            const target = plan.payload.target;
            const result = reply.op_result;
            const animal = reply.ranches.find((ranch: any) => quantity(ranch.ranch_inst_id) === target.ranch_inst_id)
                ?.animals.find((row: any) => row.animal_inst_id === target.animal_inst_id);
            if (!result || result.kind !== 1 || quantity(result.facility_inst_id) !== target.ranch_inst_id
                || quantity(result.target_id) !== String(target.animal_inst_id) || result.costs.length
                || !animal || quantity(animal.animal_id) !== plan.marker || !hasStroked(animal)
                || reply.triggered && !animal.mutation?.mutation_type) invalid();
            rewards = result.rewards;
        } else {
            const owned = reply.hazards.filter((hazard: any) => hazard.hazard_type === 1 && quantity(hazard.owner) === quantity(network.getUserState().gid));
            const mosquitoes = reply.hazards.filter((hazard: any) => hazard.hazard_type === 1);
            if (quantity(reply.actual_count) !== '1' || owned.filter((hazard: any) => !plan.marker.hazards.includes(quantity(hazard.hazard_id))).length !== 1 || mosquitoes.length > plan.marker.limit
                || new Set(reply.hazards.map((hazard: any) => quantity(hazard.hazard_id))).size !== reply.hazards.length) invalid();
            rewards = reply.rewards;
        }
        if (rewards.some((item: any) => BigInt(quantity(item.count)) <= 0n)) invalid();
        if (plan.action !== 'cleanFriend') rememberQuota(plan.action, remaining, reset);
        // 放蚊子回包包含栏舍当前的全部污物，用它规划下一只。
        if (plan.action === 'putMosquito' && ranch) ranch.hazards = reply.hazards;
        const items = sumItems(rewards);
        if (plan.action === 'cleanFriend' && completed > 0) recordOperation('helpFarming', completed, 'ranch');
        return { action: plan.action, status: completed ? 'confirmed' : 'skipped', snapshot: null, costs: [], rewards: items, completed,
            remainingTimes: plan.action === 'cleanFriend' ? undefined : remaining, triggered: reply.triggered === true, refreshRequired: true,
            notice: `${plan.label}${completed ? '完成' : '当前已无可清理项目'}${reply.triggered ? '，触发巨大变异' : ''}${items.length ? `，获得 ${items.map((item: any) => `${item.name} ×${item.count}`).join('、')}` : ''}` };
    });
}

async function interact(action: string, input: any): Promise<any> {
    if (action !== 'stroke') require('./fnos-ranch').assertManualFriendAction(input.hostGid, action); // [fnos-fork]
    return visit(input.hostGid, async (_entry, ranches, host) => {
        const plan = interactionPlan(action, input, ranches, host, action === 'cleanFriend' ? null : await getInteractionTimes());
        if (!plan.count) return commitInteraction(plan);
        if (input.expected?.signature !== plan.signature) throw error('RANCH_OFFER_CHANGED', '好友牧场状态已变化，请重新确认');
        return commitInteraction(plan);
    });
}

function quote(host: string, ranches: any[]): any {
    const eligible = targets(ranches);
    return { action: 'steal', label: '偷取好友牧场产物', costItems: [], costs: [], rewards: [], count: eligible.length,
        expected: { signature: JSON.stringify({ host, targets: eligible }) }, skipped: eligible.length === 0 };
}

async function prepareSteal(input: any): Promise<any> {
    require('./fnos-ranch').assertManualFriendAction(input.hostGid, 'steal'); // [fnos-fork]
    return visit(input.hostGid, async (_entry, ranches, host) => quote(host, ranches));
}

async function steal(input: any): Promise<any> {
    require('./fnos-ranch').assertManualFriendAction(input.hostGid, 'steal'); // [fnos-fork]
    return visit(input.hostGid, async (_entry, ranches, host) => {
        const plan = quote(host, ranches);
        if (plan.skipped) return { status: 'skipped', snapshot: null, costs: [], rewards: [], completed: 0, refreshRequired: true };
        if (input.expected?.signature !== plan.expected.signature) throw error('RANCH_OFFER_CHANGED', '好友牧场可偷产物已变化，请重新确认');
        return commitSteal(host, ranches, plan);
    });
}

async function commitSteal(host: string, ranches: any[], plan: any): Promise<any> {
    return reservations.forCurrentAccount().spend({ target: `ranch:steal:${host}`, label: plan.label, costs: [], balances: [] }, async () => {
        // 原生一键偷取使用空 targets，由服务端筛选当前可偷货架。
        const reply = await rpc('steal', { host_gid: host, targets: [] }, true);
        const eligible = targets(ranches);
        const seen = new Set<string>();
        for (const row of reply.op_results) {
            const key = `${quantity(row.facility_inst_id)}:${quantity(row.target_id)}`;
            const target = eligible.find(target => target.ranchId === quantity(row.facility_inst_id) && String(target.slot) === quantity(row.target_id));
            if (!target || row.kind !== 2 || seen.has(key) || row.costs.length || !row.rewards.length
                || row.rewards.some((item: any) => !target.itemIds.includes(quantity(item.id)) || BigInt(quantity(item.count)) <= 0n)) {
                throw error('RANCH_RESULT_UNKNOWN', '偷取回包未能确认，请刷新核对，勿重复提交');
            }
            seen.add(key);
        }
        const completed = reply.op_results.length;
        const rewards = sumItems(reply.op_results.flatMap((row: any) => row.rewards));
        if (completed > 0) recordOperation('steal', completed, 'ranch');
        const notice = rewards.length ? `获得 ${rewards.map((item: any) => `${item.name} ×${item.count}`).join('、')}` : '当前没有可偷取的产物';
        return { action: 'steal', status: completed ? 'confirmed' : 'skipped', snapshot: null, costs: [],
            rewards, completed, refreshRequired: true,
            notice: completed < plan.count ? `${notice}；已完成 ${completed} / ${plan.count} 个货架，请刷新核对` : notice };
    });
}

// ============ [fnos-fork] 好友列表「捣乱」：把各栏舍放满蚊子（受每日放蚊子次数与栏舍蚊子上限限制） ============
function badPlan(ranches: any[], host: string, times: any): any {
    const pens = ranches.map(ranch => ({ id: quantity(ranch.ranch_inst_id), room: mosquitoState(ranch).mosquitoRoom })).filter(pen => pen.room > 0);
    const room = pens.reduce((sum, pen) => sum + pen.room, 0);
    const count = Math.max(0, Math.min(Number(times?.putMosquito) || 0, room));
    return { count, pens, remaining: Number(times?.putMosquito) || 0,
        signature: JSON.stringify({ action: 'fnosBad', host, pens, remaining: Number(times?.putMosquito) || 0 }) };
}

async function prepareBad(input: any): Promise<any> {
    require('./fnos-ranch').assertManualFriendAction(input.hostGid, 'putMosquito');
    return visit(input.hostGid, async (_entry, ranches, host) => {
        const times = await getInteractionTimes();
        if (times.putMosquito <= 0) throw error('RANCH_INTERACTION_LIMIT', '今日放蚊子次数已用完');
        const plan = badPlan(ranches, host, times);
        return { action: 'fnosBad', label: `向好友牧场放蚊子 ${plan.count} 只（今日剩余 ${times.putMosquito} 次）`, costs: [], costItems: [], rewards: [],
            count: plan.count, expected: { signature: plan.signature }, skipped: plan.count === 0,
            message: plan.count === 0 ? '好友各栏舍蚊子已满' : '' };
    });
}

async function bad(input: any): Promise<any> {
    require('./fnos-ranch').assertManualFriendAction(input.hostGid, 'putMosquito');
    return visit(input.hostGid, async (_entry, ranches, host) => {
        let times = await getInteractionTimes();
        if (times.putMosquito <= 0) throw error('RANCH_INTERACTION_LIMIT', '今日放蚊子次数已用完');
        const plan = badPlan(ranches, host, times);
        if (!plan.count) return { action: 'fnosBad', status: 'skipped', snapshot: null, costs: [], rewards: [], completed: 0, refreshRequired: true, notice: '好友各栏舍蚊子已满' };
        if (input.expected?.signature !== plan.signature) throw error('RANCH_OFFER_CHANGED', '好友牧场状态已变化，请重新确认');
        let placed = 0;
        const rewards: any[] = [];
        let stopped = '';
        for (const pen of plan.pens) {
            while (placed < plan.count && times.putMosquito > 0) {
                const ranch = ranches.find(row => quantity(row.ranch_inst_id) === pen.id);
                if (!ranch || mosquitoState(ranch).mosquitoRoom <= 0) break;
                try {
                    const outcome = await commitInteraction(interactionPlan('putMosquito', { ranchId: pen.id }, ranches, host, times));
                    placed += 1;
                    times = { ...times, putMosquito: outcome.remainingTimes };
                    rewards.push(...(outcome.rewards || []));
                } catch (e: any) {
                    stopped = e.message;
                    break;
                }
                const latest = (await rpc('animals', { host_gid: host })).ranches.find((row: any) => quantity(row.ranch_inst_id) === pen.id);
                if (!latest) break;
                ranch.hazards = latest.hazards;
            }
            if (stopped) break;
        }
        if (!placed && stopped) throw error('RANCH_RESULT_UNKNOWN', stopped);
        const items = sumItems(rewards);
        const tail = times.putMosquito <= 0 ? '；今日放蚊子次数已用完' : `；今日还可放 ${times.putMosquito} 次`;
        return { action: 'fnosBad', status: placed ? 'confirmed' : 'skipped', snapshot: null, costs: [], rewards: items, completed: placed, refreshRequired: true,
            notice: `放蚊子 ${placed} 只${items.length ? `，获得 ${items.map((item: any) => `${item.name} ×${item.count}`).join('、')}` : ''}${stopped ? `；中途停止：${stopped}` : tail}` };
    });
}

type FriendInteraction = { action: 'stroke'; ranchId: string; animalId: number }
    | { action: 'putMosquito'; ranchId: string; remaining: number };

export interface FriendPatrolProgress {
    stealChecked?: boolean;
    cleanChecked?: boolean;
    pending?: FriendInteraction[];
    helpProduceChecked?: boolean; // [fnos-fork]
    feedChecked?: boolean; // [fnos-fork]
}

// 按本轮剩余动作续跑，每次进入都重新核对目标资格和剩余次数。
async function automateFriend(
    hostGid: unknown,
    enabled: (action: string) => boolean,
    shouldYield: (acted: boolean) => boolean = () => false,
    onOutcome?: (outcome: any, nickname: string) => void,
    progress: FriendPatrolProgress = {},
): Promise<any> {
    return visit(hostGid, async (fnosEntry, ranches, host) => {
        const results: any[] = [];
        const nickname = fnosEntry.basic.name.trim();
        const times: Record<string, number> = {};
        let acted = false;
        const pause = () => shouldYield(acted);
        if (pause()) return { results, times, yielded: true };
        async function act(plan: any, run: () => Promise<any>): Promise<any> {
            const { action, label } = plan;
            if (!enabled(action)) return null;
            const parent = getAmbientSendContext();
            let outcome: any;
            try {
                outcome = await runWithSendContext({ ...parent,
                    check: (service: string, method: string) => parent?.check(service, method) || (enabled(action) ? null
                        : error('RANCH_AUTOMATION_DISABLED', '好友互动开关已关闭')),
                    onSent: (service: string, method: string) => parent?.onSent(service, method),
                }, run);
                acted = true;
            } catch (error: any) {
                // 已有待核对记录或服务端明确拒绝时，只跳过本项；未能确认的新请求仍由账本保护。
                const rejected = error.name === 'GatewayError';
                if (error.code !== 'PENDING_CONFIRMATION' && !rejected) throw error;
                if (rejected) acted = true;
                onOutcome?.({ action, status: 'skipped', notice: `${label}暂未执行：${error.message}` }, nickname);
                return null;
            }
            if (outcome.status === 'confirmed') results.push(outcome);
            if (outcome.status === 'confirmed' || action === 'steal') onOutcome?.(outcome, nickname);
            return outcome;
        }
        // 可偷产物可能被好友收走，先处理当前货架再做清理和需要查询次数的互动。
        if (!progress.stealChecked) {
            if (enabled('steal')) {
                const plan = quote(host, ranches);
                if (!plan.skipped) await act(plan, () => commitSteal(host, ranches, plan));
            }
            progress.stealChecked = true;
        }
        let cleaned = false;
        if (!progress.cleanChecked) {
            if (enabled('cleanFriend')) {
                const plan = interactionPlan('cleanFriend', {}, ranches, host, null);
                if (plan.count) {
                    if (pause()) return { results, times, yielded: true };
                    cleaned = (await act(plan, () => commitInteraction(plan)))?.status === 'confirmed';
                }
            }
            progress.cleanChecked = true;
        }
        // [fnos-fork] 帮好友生产（上游没有；开关 fnosRanch.friendHelpProduce）
        if (!progress.helpProduceChecked) {
            if (cleaned) {
                if (pause()) return { results, times, yielded: true };
                ranches = (await rpc('animals', { host_gid: host })).ranches;
                cleaned = false;
            }
            const helped = await require('./fnos-ranch').helpFriendProduce(host, ranches);
            progress.helpProduceChecked = true;
            if (helped) {
                results.push(helped);
                acted = true;
                if (pause()) return { results, times, yielded: true };
                ranches = (await rpc('animals', { host_gid: host })).ranches;
            }
        }
        if (enabled('stroke') || enabled('putMosquito')) {
            if (!progress.pending) {
                if (cleaned) {
                    if (pause()) return { results, times, yielded: true };
                    ranches = (await rpc('animals', { host_gid: host })).ranches;
                }
                const pending: FriendInteraction[] = [];
                for (const ranch of ranches) {
                    const ranchId = quantity(ranch.ranch_inst_id);
                    if (enabled('stroke')) {
                        for (const animal of ranch.animals.filter(canStroke)) {
                            pending.push({ action: 'stroke', ranchId, animalId: animal.animal_inst_id });
                        }
                    }
                    const remaining = mosquitoState(ranch).mosquitoRoom;
                    if (enabled('putMosquito') && remaining > 0) pending.push({ action: 'putMosquito', ranchId, remaining });
                }
                progress.pending = pending;
            }
            const pending = progress.pending;
            if (pending.some(step => enabled(step.action))) {
                if (pause()) return { results, times, yielded: true };
                Object.assign(times, await getInteractionTimes());
            }
            while (pending.length) {
                const step = pending[0];
                const ranch = ranches.find(row => quantity(row.ranch_inst_id) === step.ranchId);
                const eligible = ranch && (step.action === 'stroke'
                    ? ranch.animals.some((animal: any) => animal.animal_inst_id === step.animalId && canStroke(animal))
                    : mosquitoState(ranch).mosquitoRoom > 0);
                if (enabled(step.action) && times[step.action] > 0 && eligible) {
                    if (pause()) return { results, times, yielded: true };
                    const plan = interactionPlan(step.action, step, ranches, host, times);
                    const outcome = await act(plan, () => commitInteraction(plan, ranch));
                    if (outcome) times[step.action] = outcome.remainingTimes;
                    // 上游 #167：连续放蚊子复用本次回包的污物列表，不再重新拉栏舍
                    if (outcome && step.action === 'putMosquito' && --step.remaining > 0 && times.putMosquito > 0) {
                        continue;
                    }
                }
                pending.shift();
            }
        }
        // [fnos-fork] 给好友加牧草（扣金币，上游没有；开关 fnosRanch.friendFeed）
        if (!progress.feedChecked && !pause()) {
            const fed = await require('./fnos-ranch').feedFriend(host, fnosEntry);
            progress.feedChecked = true;
            if (fed) results.push(fed);
        }
        // [fnos-fork] 2026-11-17 好友时间表：记下这位好友牧场下一次产出（可偷）的时间
        try { require('../fnos-timetable').noteRanch(host, '', ranches); } catch { /* ignore */ }
        return { results, times };
    });
}

module.exports = { getFriend, withFriendVisit, prepareSteal, steal, getInteractionTimes, getInteractionQuotaResetAt, prepareInteraction, interact, automateFriend, prepareBad, bad, badPlan, peekLevel };
