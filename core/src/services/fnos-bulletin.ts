export {};

/**
 * [fnos-fork] 游戏公告只读查看。
 *
 * 只调用 BulletinBoardService.GetBulletinList / GetBulletinDetail。
 * 不发送已读上报，也不调用任何会改游戏状态的接口。
 * GetBulletinList：解密真实客户端请求为 {1: 0, 2: 6}，即 count(field 1)=0、page_size(field 2)=6。
 * 早先只传 count=20 时服务器返回空列表（2026-11-02 实测），所以照抄客户端参数。
 * 回包为空时返回空列表，不报错。
 */

const { gatewayPath } = require('../config/fnos');
const { toNum } = require('../utils/utils');

const BULLETIN_SERVICE = 'gamepb.bulletinboardpb.BulletinBoardService';
const BULLETIN_LIST_COUNT = 0;
const BULLETIN_LIST_PAGE_SIZE = 6;

type BulletinSender = (service: string, method: string, body: Uint8Array) => Promise<{ body?: Uint8Array }>;

function bulletinImageUrl(value: unknown): string {
    return gatewayPath(String(value || '').trim());
}

function normalizeBulletinItem(item: any) {
    const id = toNum(item && item.id);
    const status = toNum(item && item.status);
    const type = toNum(item && item.type);
    return {
        id,
        title: String((item && item.title) || ''),
        status,
        read: status === 1,
        type,
        imageUrl: bulletinImageUrl(item && (item.image_url || item.imageUrl)),
    };
}

function normalizeBulletinList(reply: any) {
    const rows = Array.isArray(reply && reply.bulletins) ? reply.bulletins : [];
    return {
        bulletins: rows
            .map(normalizeBulletinItem)
            .filter((row: { id: number; title: string }) => row.id > 0 || row.title),
    };
}

function normalizeBulletinDetail(reply: any, id: number) {
    const source = reply || {};
    return {
        id,
        title: String(source.title || ''),
        content: String(source.content || ''),
        beginTime: String(source.begin_time || source.beginTime || ''),
        endTime: String(source.end_time || source.endTime || ''),
        imageUrl: bulletinImageUrl(source.image_url || source.imageUrl),
    };
}

/** 账号没启动、或进程在但还没登录时，给前端一句能直接看懂的话。对得上就返回文案，否则返回空串。 */
function describeBulletinAccessError(error: any): string {
    const raw = String((error && error.message) || error || '').trim();
    if (raw === '账号未运行' || raw === '账号已离线') {
        return '当前账号未运行，请先启动账号后再查看游戏公告';
    }
    if (raw === '账号未连接' || raw.includes('尚未登录') || raw.includes('连接未打开')) {
        return '账号尚未登录，请先完成登录并等待游戏连接成功后再查看公告';
    }
    return '';
}

function parseBulletinId(raw: unknown): number {
    const text = String(raw ?? '').trim();
    if (!/^[1-9]\d*$/.test(text)) return 0;
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : 0;
}

function protoTypes(): Record<string, any> {
    return require('../utils/proto').types;
}

function encodeListRequest(): Uint8Array {
    const Request = protoTypes().GetBulletinListRequest;
    return Request.encode(Request.fromObject({ count: BULLETIN_LIST_COUNT, page_size: BULLETIN_LIST_PAGE_SIZE })).finish();
}

function encodeDetailRequest(id: number): Uint8Array {
    const Request = protoTypes().GetBulletinDetailRequest;
    return Request.encode(Request.fromObject({ id })).finish();
}

async function getBulletinList(send?: BulletinSender) {
    const invoke: BulletinSender = send || require('../utils/network').sendMsgAsync;
    const reply = await invoke(BULLETIN_SERVICE, 'GetBulletinList', encodeListRequest());
    const decoded = protoTypes().GetBulletinListReply.decode((reply && reply.body) || Buffer.alloc(0));
    return normalizeBulletinList(decoded);
}

async function getBulletinDetail(rawId: unknown, send?: BulletinSender) {
    const id = parseBulletinId(rawId);
    if (!id) throw new Error('公告编号无效');
    const invoke: BulletinSender = send || require('../utils/network').sendMsgAsync;
    const reply = await invoke(BULLETIN_SERVICE, 'GetBulletinDetail', encodeDetailRequest(id));
    const decoded = protoTypes().GetBulletinDetailReply.decode((reply && reply.body) || Buffer.alloc(0));
    return normalizeBulletinDetail(decoded, id);
}

module.exports = {
    BULLETIN_SERVICE,
    BULLETIN_LIST_COUNT,
    BULLETIN_LIST_PAGE_SIZE,
    bulletinImageUrl,
    normalizeBulletinItem,
    normalizeBulletinList,
    normalizeBulletinDetail,
    describeBulletinAccessError,
    parseBulletinId,
    getBulletinList,
    getBulletinDetail,
};
