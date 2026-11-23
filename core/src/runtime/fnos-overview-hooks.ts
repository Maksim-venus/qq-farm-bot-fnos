// [fnos-fork] 2026-11-23 首页概览缓存的取数钩子：Worker 里拿到背包 / 钻石 / 牧场数据时调用 emit，
// Worker 入口把 sink 接到「发给主进程」；主进程在 fnos-overview-writer 里合成快照并落盘。没有 sink（主进程、测试）时什么都不做。
export {};

type Sink = (kind: 'bag' | 'diamond' | 'ranch' | 'ranchCareer' | 'farmCareer', data: any) => void;
let sink: Sink | null = null;

function setOverviewSink(next: Sink | null): void {
    sink = next;
}

function emitOverviewData(kind: 'bag' | 'diamond' | 'ranch' | 'ranchCareer' | 'farmCareer', data: any): void {
    if (!sink) return;
    try {
        sink(kind, data);
    } catch {
        // 取数钩子不能影响正常业务
    }
}

module.exports = { setOverviewSink, emitOverviewData };
