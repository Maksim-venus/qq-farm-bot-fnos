'use strict';
/**
 * 飞牛原生包 SEA 入口（与 core/client.ts 等价，但使用静态 require，便于 esbuild 打包成单文件）。
 * 由 fnos/sea/build-sea.sh 打包为 bin/qq-farm-bot。
 */
if (process.env.FARM_WORKER === '1') {
    // 进程模式（FARM_RUNTIME_MODE=process）下由自身以 FARM_WORKER=1 重新启动
    require('../../core/dist/core/worker');
} else {
    const {
        startAdminServer,
        emitRealtimeStatus,
        emitRealtimeLog,
        emitRealtimeAccountLog,
    } = require('../../core/dist/controllers/admin');
    const { createRuntimeEngine } = require('../../core/dist/runtime/runtime-engine');
    const { createModuleLogger } = require('../../core/dist/services/logger');
    const mainLogger = createModuleLogger('main');

    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: process.execPath,
        startAdminServer,
        onStatusSync: (accountId, status) => emitRealtimeStatus(accountId, status),
        onLog: (entry, accountId) => {
            if (accountId && entry) entry.accountId = accountId;
            emitRealtimeLog(entry);
        },
        onAccountLog: entry => emitRealtimeAccountLog(entry),
    });

    runtimeEngine.start({ startAdminServer: true, autoStartAccounts: false }).catch((err) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
