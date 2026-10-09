# qq-farm-bot-fnos

QQ 农场助手的 **飞牛 fnOS 原生应用（FPK）** 版本。

- **不使用 Docker**：以飞牛原生进程运行，依赖应用中心的 Node.js v22（`nodejs_v22`，安装时自动安装）。
- **不开放任何端口**：服务只监听飞牛统一网关的 Unix Socket，从飞牛桌面图标「QQ 农场」或 `/app/qq-farm-bot/` 访问。
- **移除登录 / 改密模块**：应用内不再有管理员账号和密码，访问控制完全由飞牛登录负责。
- **默认仅飞牛管理员可用**：由环境变量 `QQ_FARM_ADMIN_ONLY` 控制（默认 `1`，设为 `0` 允许普通飞牛用户访问）。
- 数据保存在应用数据目录 `/vol*/@appdata/qq-farm-bot/data`。

## 安装

1. 在飞牛「应用中心」确认可安装「Node.js v22」。
2. 从 [Releases](https://github.com/Maksim-venus/qq-farm-bot-fnos/releases) 下载 `qq-farm-bot_<版本>_native_x86.fpk`，并核对 SHA-256。
3. 打开「应用中心 → 手动安装」，选择该 FPK；已安装旧版时确认覆盖升级。
4. 安装完成后从桌面图标「QQ 农场」打开。

> **从旧版 Docker 包升级**：覆盖安装时会自动停止旧容器 `qq-farm-bot`，并把 Docker 数据卷 `qq-farm-data`、`qq-farm-logs` 复制到新的数据目录（原数据卷不会删除，确认无误后可自行 `docker rm qq-farm-bot`、`docker volume rm qq-farm-data qq-farm-logs`）。

自行构建：`pnpm install && fnos/build.sh`，产物在 `fnos/out/`。详细说明见 [`fnos/飞牛部署与变更说明.md`](fnos/飞牛部署与变更说明.md)。

## 修改来源

本项目 fork 自 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot)，在其基础上做了飞牛原生打包与网关适配。QQ 农场助手的全部核心功能均来自上游项目，感谢原作者及贡献者。

许可沿用上游项目的声明（上游 `package.json` 中声明为 ISC）。本项目同样仅供学习与研究使用，使用者需自行承担因使用本工具产生的后果。
