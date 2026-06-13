# 安全说明（公网部署必读）

本平台运行**玩家提交的不可信 JavaScript**（棋手脚本）。代码层已做的防护与**仍需在部署侧补齐**的隔离，分列如下。

## 一、代码层已实现

- **独立子进程执行**：所有不可信对局（正式挑战 / 烟雾测试 / 试玩）经 `engine/execpool.js` `fork` 到 `engine/runner.js` 子进程执行（fork-per-task），与 Web/DB 主进程隔离：
  - 子进程 env 经白名单剥离机密（`SESSION_SECRET`、SMTP 等不传入），逃逸后读不到这些机密；
  - 父进程对每个任务设硬超时并 `SIGKILL` 子进程，**主事件循环不被阻塞**（实测：子进程跑死循环烟雾时，主进程其它请求仍毫秒级响应）；
  - 子进程不持有数据库句柄；并发子进程数有上限（超出回 503）。
- **每手挂钟超时**：`engine/sandbox.js` 通过 vm `timeout` 对每次 `onTurn` 强制超时（`MOVE_TIMEOUT_MS`，数秒级），中断死循环/长耗时 → 判 `runtime` 负。
- **单场挂钟上限**：`engine/engine_quota.js` 的 `playMatch(maxMatchMs)` 防"每手不超时但整体长拖"的慢速消耗。
- **思考点计量（每手实例化）**：`makeRules(budget)` 每手一个计量实例，并发对局互不串改；交给脚本的 `Rules` 只含安全 API（**移除了 `_reset` / `_rawApply`**，杜绝脚本自行重置预算或绕过计量）。
- **收敛逃逸面**：沙箱不再注入宿主内置对象（`Math/JSON/…` 用上下文自带版本），去掉了 `Error.constructor('return process')` 这类最易用的逃逸路径。
- **接口频控**：`ratelimit.js` 对注册/登录/发布/挑战限速（超限 429）。
- **反刷分**：同一哈希对前 10 场计入段位/战绩/ELO，之后为练习赛不计分；正式挑战要求账号邮箱已验证。
- **鉴权**：密码 scrypt 加盐 + `timingSafeEqual`；会话为 HMAC 签名 Cookie（`HttpOnly`、`SameSite=Lax`）。

## 二、部署侧必须补齐（否则不要上公网）

> **Node 的 `vm` 不是安全边界。** 子进程内仍可经宿主对象（`game.rules`、`game.board` 等）的原型链触达该子进程的宿主 realm，进而 `require('fs')` 读盘。代码层已把执行关进**独立子进程**（机密不在其 env、句柄不可达、可被杀），但子进程本身仍需 OS 级隔离才能真正"关进盒子"：

1. **进程/容器隔离**：让 `engine/runner.js` 子进程跑在独立的低权限用户/容器中（容器 + seccomp，或 gVisor/Firecracker 等）。代码已是 fork-per-task 的可杀子进程，部署侧补齐 OS 约束即可。
2. **文件系统**：对执行子进程只读挂载，且**令其无法读取** `sixchess.db` 与任何密钥文件（escape 后可 `require('fs')` 读盘）。
3. **网络**：禁止执行进程对外发起网络连接（防数据外带/打内网）。
4. **密钥隔离**：`SESSION_SECRET` 等机密**不要**出现在执行进程可读的环境变量里（escape 后可读 `process.env`）。
5. **资源上限**：对执行进程设 CPU/内存/句柄 cgroup 限额，叠加在挂钟超时之上。

## 三、其他部署项

- **`SESSION_SECRET`**：务必设为稳定强随机值（未设则每次启动随机、重启即登出）。
- **邮箱投递**：接入 SMTP 真正投递验证链接；**生产勿**把验证链接随接口响应回传前端（当前仅非生产环境为演示而回传，见 `server.js` 的 `sendVerificationEmail`）。
- **棋手密钥**：当前 `api_keys.key_plain` 明文留存以支持站内展示掩码与一键 Prompt（demo 取舍）。更高安全要求下应改为只存哈希、明文仅创建/轮换时一次性返回。
- **反向代理**：若置于代理后，`clientIp()` 取的是直连地址；需改为信任经校验的 `X-Forwarded-For`，否则频控按代理 IP 聚合。
- **HTTPS**：生产应在代理层启用 TLS，并给会话 Cookie 增加 `Secure`。
- **多实例**：`ratelimit.js` 为单进程内存实现；多实例需换共享存储（如 Redis）。
