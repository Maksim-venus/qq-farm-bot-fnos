export {};
/**
 * [fnos-fork] Bark 推送与渠道成功码判断。
 *
 * 上游经 pushoo 0.1.11 的 noticeBark 发送 Bark：只能 GET `/:key/:title/:body/`，
 * 无法传 level/volume/call；而且 Bark 成功时返回 `{ code: 200, message: "success" }`，
 * 上游 sendPushooMessage 只认 code 为 0/ok，于是推送其实成功却提示「测试失败: success」。
 *
 * 这里按 Bark 官方 API（https://github.com/Finb/bark-server/blob/master/docs/API_V2.md）
 * 用 POST JSON 发送，并支持「重要警告」：level=critical（静音/勿扰也响铃）+ volume + call=1。
 */

const axios = require('axios').default;

const BARK_DEFAULT_BASE_URL = 'https://api.day.app';
/** 重要警告铃声音量（Bark 取值 0-10） */
const BARK_CRITICAL_VOLUME = '5';

/**
 * 业务码表示成功、但不是 0 的渠道。
 * - bark：`{ code: 200, message: "success" }`
 * - pushplus / pushplushxtrip：`{ code: 200, msg: "请求成功" }`
 * - wxpusher：`{ code: 1000, msg: "处理成功", success: true }`
 */
const CHANNEL_SUCCESS_CODES: Record<string, string[]> = {
    bark: ['200'],
    pushplus: ['200'],
    pushplushxtrip: ['200'],
    wxpusher: ['1000'],
};

function isChannelSuccessCode(channel: unknown, code: unknown): boolean {
    const key = String(channel || '').trim().toLowerCase();
    const list = CHANNEL_SUCCESS_CODES[key];
    return !!list && list.includes(String(code ?? '').trim());
}

interface BarkRequestInput {
    token: unknown;
    title: unknown;
    content: unknown;
    critical?: boolean;
}

/**
 * token 可以是设备 Key，也可以是完整地址（官方或自建服务器，如 https://api.day.app/KEY）。
 * 返回 POST 地址与 JSON 请求体。
 */
function buildBarkRequest(input: BarkRequestInput): { url: string; body: Record<string, string> } {
    const token = String(input.token || '').trim();
    if (!token) throw new Error('Bark Key 不能为空');
    const title = String(input.title || '').trim();
    const content = String(input.content || '').trim();
    if (!content) throw new Error('content 不能为空');

    let url: string;
    if (/^https?:\/\//i.test(token)) {
        try {
            const parsed = new URL(token);
            parsed.pathname = parsed.pathname.replace(/\/+$/, '');
            url = parsed.toString().replace(/\/+$/, '');
        } catch {
            throw new Error('Bark 地址格式无效');
        }
    } else {
        url = `${BARK_DEFAULT_BASE_URL}/${encodeURIComponent(token)}`;
    }

    const body: Record<string, string> = { body: content };
    if (title) body.title = title;
    if (input.critical) {
        body.level = 'critical';
        body.volume = BARK_CRITICAL_VOLUME;
        body.call = '1';
    }
    return { url, body };
}

/**
 * 发送 Bark 推送。HTTP 非 2xx 时把 Bark 的错误信息转换成 `{ code, message, error }`，
 * 便于 sendPushooMessage 统一判断。
 */
async function sendBarkMessage(input: BarkRequestInput, post: (url: string, body: any) => Promise<any> = (u, b) => axios.post(u, b, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    timeout: 15000,
})): Promise<any> {
    const { url, body } = buildBarkRequest(input);
    try {
        const response = await post(url, body);
        const data = response && response.data;
        return (data && typeof data === 'object') ? data : { data };
    } catch (error: any) {
        const data = error?.response?.data;
        const status = Number(error?.response?.status) || 0;
        const message = String((data && (data.message || data.msg)) || error?.message || 'Bark 推送失败');
        return {
            code: (data && data.code) || status || 'error',
            message,
            error: { message },
        };
    }
}

module.exports = {
    BARK_CRITICAL_VOLUME,
    CHANNEL_SUCCESS_CODES,
    buildBarkRequest,
    isChannelSuccessCode,
    sendBarkMessage,
};
