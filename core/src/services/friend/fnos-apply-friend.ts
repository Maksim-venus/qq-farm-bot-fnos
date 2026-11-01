/**
 * [fnos-fork] 按 GID 加好友（测试）。
 *
 * 顺序与 2026-11-01 微信客户端抓包一致：
 * 1. VisitService.Enter 进入对方农场，从 EnterReply.apply_key（field 10）取凭证；
 * 2. VisitService.Leave；
 * 3. FriendService.ApplyFriend，field1=对方 gid、field2=凭证原样、field3=0。
 * Enter 失败时返回服务器原始错误，不拼造凭证，也不发送 ApplyFriend。
 */

const { sendMsgAsync } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { toLong, log } = require('../../utils/utils');
const { enterFriendFarm, leaveFriendFarm } = require('./api');

export interface ApplyFriendByGidResult {
    ok: boolean;
    gid: number;
    enterOk: boolean;
    applyKeyPrefix: string;
    applySent: boolean;
    error?: string;
    errorCode?: number;
    errorMessage?: string;
}

function positiveGid(input: unknown): number {
    const gid = Math.floor(Number(input));
    return Number.isFinite(gid) && gid > 0 ? gid : 0;
}

function describeError(error: any): { error: string; errorCode?: number; errorMessage?: string } {
    const errorCode = Number(error?.code);
    const raw = String(error?.errorMessage || error?.error_message || '').trim();
    const fallback = String(error?.message || error || '未知错误').trim() || '未知错误';
    return {
        error: raw || fallback,
        ...(Number.isFinite(errorCode) && errorCode !== 0 ? { errorCode } : {}),
        ...(raw ? { errorMessage: raw } : {}),
    };
}

function writeLog(result: ApplyFriendByGidResult): void {
    const enterText = result.enterOk ? '成功' : '失败';
    const keyText = result.applyKeyPrefix || '无';
    const applyText = !result.applySent ? '未发送' : (result.ok ? '成功' : '失败');
    const codeText = result.errorCode ? `，错误码 ${result.errorCode}` : '';
    const errText = !result.ok && result.error ? `，${result.error}` : '';
    log('好友', `按 GID 加好友：gid=${result.gid}，Enter ${enterText}，凭证 ${keyText}，ApplyFriend ${applyText}${codeText}${errText}`, {
        module: 'friend',
        event: '按GID加好友',
        result: result.ok ? 'ok' : 'error',
        gid: result.gid,
        enterOk: result.enterOk,
        applyKeyPrefix: result.applyKeyPrefix,
        applySent: result.applySent,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
}

function finish(result: ApplyFriendByGidResult): ApplyFriendByGidResult {
    writeLog(result);
    return result;
}

async function sendApplyFriend(gid: number, applyKey: string): Promise<void> {
    if (!types.ApplyFriendRequest || !types.ApplyFriendReply) {
        throw new Error('ApplyFriend 接口类型未加载');
    }
    const body: Uint8Array = types.ApplyFriendRequest.encode(types.ApplyFriendRequest.create({
        friend_gid: toLong(gid),
        apply_key: applyKey,
        source: toLong(0),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'ApplyFriend', body);
    const bytes = replyBody && replyBody.length ? replyBody : Buffer.alloc(0);
    types.ApplyFriendReply.decode(bytes);
}

export async function applyFriendByGid(gidInput: unknown): Promise<ApplyFriendByGidResult> {
    const gid = positiveGid(gidInput);
    if (!gid) {
        return finish({
            ok: false,
            gid: 0,
            enterOk: false,
            applyKeyPrefix: '',
            applySent: false,
            error: '无效的 GID',
        });
    }

    let applyKey = '';
    try {
        const reply = await enterFriendFarm(gid);
        applyKey = String(reply?.apply_key || reply?.applyKey || '').trim();
    } catch (error: any) {
        const described = describeError(error);
        return finish({
            ok: false,
            gid,
            enterOk: false,
            applyKeyPrefix: '',
            applySent: false,
            ...described,
        });
    }

    try {
        await leaveFriendFarm(gid);
    } catch {
        // Leave 失败不另造凭证；有凭证时仍继续申请。
    }

    if (!applyKey) {
        return finish({
            ok: false,
            gid,
            enterOk: true,
            applyKeyPrefix: '',
            applySent: false,
            error: 'Enter 成功但回包没有加好友凭证',
        });
    }

    const applyKeyPrefix = applyKey.slice(0, 8);
    try {
        await sendApplyFriend(gid, applyKey);
        return finish({
            ok: true,
            gid,
            enterOk: true,
            applyKeyPrefix,
            applySent: true,
        });
    } catch (error: any) {
        const described = describeError(error);
        return finish({
            ok: false,
            gid,
            enterOk: true,
            applyKeyPrefix,
            applySent: true,
            ...described,
        });
    }
}
