#!/bin/bash
# QQ 农场 飞牛原生包公共函数（由 cmd/* 脚本 source）

APP_NAME="${TRIM_APPNAME:-qq-farm-bot}"
APP_DEST="${TRIM_APPDEST:-/var/apps/${APP_NAME}/target}"
PKG_VAR="${TRIM_PKGVAR:-/var/apps/${APP_NAME}/var}"
APP_USER="${TRIM_USERNAME:-qq-farm-bot}"
APP_GROUP="${TRIM_GROUPNAME:-${APP_USER}}"

SERVER_DIR="${APP_DEST}/server/core"
DATA_DIR="${PKG_VAR}/data"
LOG_FILE="${PKG_VAR}/app.log"
PID_FILE="${PKG_VAR}/app.pid"
SOCKET_PATH="${APP_DEST}/app.sock"
GATEWAY_PREFIX="/app/${APP_NAME}"

# 旧版 Docker 包使用的容器与数据卷（只读取、不删除）
OLD_CONTAINER="qq-farm-bot"
OLD_DATA_VOLUME="qq-farm-data"
OLD_LOGS_VOLUME="qq-farm-logs"
MIGRATED_MARKER="${DATA_DIR}/.migrated-from-docker"

log_msg() {
    mkdir -p "${PKG_VAR}" 2>/dev/null
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*" >> "${LOG_FILE}"
}

user_error() {
    # 写入 TRIM_TEMP_LOGFILE 的内容会展示给用户
    log_msg "ERROR: $*"
    if [ -n "${TRIM_TEMP_LOGFILE}" ]; then
        echo "$*" > "${TRIM_TEMP_LOGFILE}"
    fi
}

find_node() {
    local candidate
    for candidate in \
        /var/apps/nodejs_v22/target/bin/node \
        /var/apps/nodejs_v24/target/bin/node \
        /var/apps/nodejs_v20/target/bin/node; do
        if [ -x "${candidate}" ]; then
            echo "${candidate}"
            return 0
        fi
    done
    command -v node 2>/dev/null
}

app_user_exists() {
    id -u "${APP_USER}" >/dev/null 2>&1
}

# 以应用专用用户运行命令；用户不存在时（未按预期创建）退回当前用户
run_as_app() {
    if [ "$(id -u)" = "0" ] && app_user_exists; then
        runuser -u "${APP_USER}" -- "$@"
    else
        "$@"
    fi
}

prepare_dirs() {
    mkdir -p "${DATA_DIR}/logs"
    if [ "$(id -u)" = "0" ] && app_user_exists; then
        # 数据目录与 Socket 所在目录交给应用用户；仅在属主不一致时 chown
        if [ -n "$(find "${PKG_VAR}" \( ! -user "${APP_USER}" \) -print -quit 2>/dev/null)" ]; then
            chown -R "${APP_USER}:${APP_GROUP}" "${PKG_VAR}" 2>/dev/null || true
        fi
        chown "${APP_USER}:${APP_GROUP}" "${APP_DEST}" 2>/dev/null || true
    fi
    chmod 750 "${DATA_DIR}" 2>/dev/null || true
}

rotate_log() {
    if [ -f "${LOG_FILE}" ] && [ "$(stat -c %s "${LOG_FILE}" 2>/dev/null || echo 0)" -gt 10485760 ]; then
        mv -f "${LOG_FILE}" "${LOG_FILE}.1"
    fi
}

check_process() {
    local pid="$1"
    [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
}

read_pid() {
    [ -f "${PID_FILE}" ] && head -n 1 "${PID_FILE}" | tr -d '[:space:]'
}

is_running() {
    local pid
    pid="$(read_pid)"
    if check_process "${pid}"; then
        return 0
    fi
    rm -f "${PID_FILE}"
    return 1
}

data_dir_has_data() {
    [ -f "${DATA_DIR}/accounts.json" ] || [ -f "${DATA_DIR}/store.json" ]
}

docker_volume_path() {
    local name="$1" path=""
    if command -v docker >/dev/null 2>&1; then
        path="$(docker volume inspect -f '{{.Mountpoint}}' "${name}" 2>/dev/null)"
    fi
    if [ -z "${path}" ] || [ ! -d "${path}" ]; then
        local candidate
        for candidate in /var/lib/docker/volumes/"${name}"/_data /vol*/docker/volumes/"${name}"/_data /vol*/@docker/volumes/"${name}"/_data; do
            if [ -d "${candidate}" ]; then
                path="${candidate}"
                break
            fi
        done
    fi
    [ -n "${path}" ] && [ -d "${path}" ] && echo "${path}"
}

stop_old_container() {
    command -v docker >/dev/null 2>&1 || return 0
    docker inspect "${OLD_CONTAINER}" >/dev/null 2>&1 || return 0
    if [ "$(docker inspect -f '{{.State.Running}}' "${OLD_CONTAINER}" 2>/dev/null)" = "true" ]; then
        log_msg "停止旧版 Docker 容器 ${OLD_CONTAINER}（不删除容器和数据卷）"
        docker stop "${OLD_CONTAINER}" >> "${LOG_FILE}" 2>&1 || true
    fi
    # unless-stopped 的容器被手动停止后不会随 Docker 重启自动拉起；再关掉重启策略以防万一
    docker update --restart=no "${OLD_CONTAINER}" >> "${LOG_FILE}" 2>&1 || true
}

# 3007 仍被占用时记录占用进程（本应用不监听 TCP，通常是旧 Docker 容器或其他程序）
warn_port_3007() {
    command -v ss >/dev/null 2>&1 || return 0
    local line
    line="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:3007$/' | head -n 1)"
    if [ -n "${line}" ]; then
        log_msg "WARN: 3007 端口仍被占用（不是 QQ 农场原生版）：${line}"
    fi
}

# 从旧版 Docker 数据卷迁移数据（只复制，不删除原数据卷）
migrate_from_docker() {
    mkdir -p "${DATA_DIR}/logs"
    if [ -f "${MIGRATED_MARKER}" ]; then
        log_msg "已迁移过 Docker 数据，跳过"
        return 0
    fi
    if data_dir_has_data; then
        log_msg "原生数据目录已有数据，跳过 Docker 数据迁移"
        return 0
    fi

    stop_old_container

    local src logs_src
    src="$(docker_volume_path "${OLD_DATA_VOLUME}")"
    logs_src="$(docker_volume_path "${OLD_LOGS_VOLUME}")"
    if [ -z "${src}" ]; then
        log_msg "未找到 Docker 数据卷 ${OLD_DATA_VOLUME}，按全新安装处理"
        return 0
    fi

    log_msg "迁移 Docker 数据卷 ${OLD_DATA_VOLUME}: ${src} -> ${DATA_DIR}"
    if ! cp -a "${src}/." "${DATA_DIR}/" >> "${LOG_FILE}" 2>&1; then
        log_msg "WARN: 复制数据卷时出现错误，请检查 ${LOG_FILE}"
    fi
    if [ -n "${logs_src}" ]; then
        log_msg "迁移 Docker 日志卷 ${OLD_LOGS_VOLUME}: ${logs_src} -> ${DATA_DIR}/logs"
        cp -a "${logs_src}/." "${DATA_DIR}/logs/" >> "${LOG_FILE}" 2>&1 || log_msg "WARN: 复制日志卷时出现错误"
    fi
    # 管理员登录功能已移除，旧凭据文件不再使用，改名保留
    for f in admin.json login-attempts.json; do
        [ -f "${DATA_DIR}/${f}" ] && mv -f "${DATA_DIR}/${f}" "${DATA_DIR}/${f}.unused" 2>/dev/null
    done
    {
        echo "migrated_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
        echo "data_volume=${OLD_DATA_VOLUME} (${src})"
        echo "logs_volume=${OLD_LOGS_VOLUME} (${logs_src:-not found})"
        echo "note=原 Docker 数据卷未删除，确认无误后可手动执行 docker volume rm ${OLD_DATA_VOLUME} ${OLD_LOGS_VOLUME}"
    } > "${MIGRATED_MARKER}"
    log_msg "Docker 数据迁移完成"
    return 0
}
