# 安全说明（公网部署必读）

本平台运行**玩家提交的不可信 JavaScript**（棋手脚本）。代码层已做的防护与**仍需在部署侧补齐**的隔离，分列如下。

## 一、代码层已实现

- **独立子进程执行**：所有不可信对局（正式挑战 / 烟雾测试 / 试玩）经 `engine/execpool.js` `fork` 到 `engine/runner.js` 子进程执行（fork-per-task），与 Web/DB 主进程隔离：
  - 子进程 env 经白名单剥离机密（`SESSION_SECRET`、SMTP 等不传入），逃逸后读不到这些机密；
  - 父进程对每个任务设硬超时并 `SIGKILL` 子进程，**主事件循环不被阻塞**（实测：子进程跑死循环烟雾时，主进程其它请求仍毫秒级响应）；
  - 子进程不持有数据库句柄；并发子进程数有上限（超出回 503）。
- **Node 权限模型（子进程内进程级闸门）**：`execpool.js` 以 `--permission --allow-fs-read=<engine 目录>` fork 子进程。即便 vm 逃逸拿到宿主 realm 的真实 `fs`/`child_process`，越权操作也会在 C++ 层被拒（`ERR_ACCESS_DENIED`）：
  - **只放行读取 `engine/` 目录**（跑对局所需的本仓库代码，非机密）。app 根目录下的 `ecosystem.config.js`（含 `SESSION_SECRET`）与 `sixchess.db` 都在 `engine/` 之外 → **逃逸后也读不到**（已实测：关闭权限模型时逃逸脚本能读出密钥文件，开启后同样脚本被 `ERR_ACCESS_DENIED` 拦下）；
  - **禁止一切 fs 写、`child_process`、`worker_threads`、原生插件**（均实测 `ERR_ACCESS_DENIED`）；
  - 兜底开关 `CHILD_PERMISSION=off` 可临时关闭（仅在极端不兼容时用，不建议线上关）；
  - **权限模型不拦网络出站**——网络隔离仍须靠部署侧（见下方第 3 项）。
- **每手挂钟超时**：`engine/sandbox.js` 通过 vm `timeout` 对每次 `onTurn` 强制超时（`MOVE_TIMEOUT_MS`，数秒级），中断死循环/长耗时 → 判 `runtime` 负。
- **单场挂钟上限**：`engine/engine_quota.js` 的 `playMatch(maxMatchMs)` 防"每手不超时但整体长拖"的慢速消耗。
- **思考点计量（每手实例化）**：`makeRules(budget)` 每手一个计量实例，并发对局互不串改；交给脚本的 `Rules` 只含安全 API（**移除了 `_reset` / `_rawApply`**，杜绝脚本自行重置预算或绕过计量）。
- **收敛逃逸面**：沙箱不再注入宿主内置对象（`Math/JSON/…` 用上下文自带版本），去掉了 `Error.constructor('return process')` 这类最易用的逃逸路径。
- **接口频控**：`ratelimit.js` 对注册/登录/发布/挑战限速（超限 429）。
- **反刷分**：同一哈希对前 10 场计入段位/战绩/ELO，之后为练习赛不计分；正式挑战要求账号邮箱已验证。
- **鉴权**：密码 scrypt 加盐 + `timingSafeEqual`；会话为 HMAC 签名 Cookie（`HttpOnly`、`SameSite=Lax`）。

## 二、部署侧必须补齐（否则不要上公网）

> **Node 的 `vm` 不是安全边界。** 子进程内仍可经宿主对象（`game.rules`、`game.board`、`me.pieces` 等）的原型链触达该子进程的宿主 realm。代码层已把执行关进**独立子进程**并叠加 **Node 权限模型**——逃逸后已读不到机密文件/数据库、不能写盘、不能起子进程/线程（见上）。**但权限模型不拦网络出站**，且深度防御仍建议再叠一层 OS 级隔离。下列按「当前风险」排序，**第 1 项（网络）为上公网前的必做**：

1. **网络出站隔离（必做）**：权限模型不拦 socket，逃逸脚本仍可对外连接（数据外带 / 打内网 / SSRF）。让 `engine/runner.js` 子进程无法主动对外发起连接——推荐做法：将 runner 子进程以**专用低权限用户**运行，再用 `iptables`/`nftables` 的 owner 匹配丢弃该用户的 OUTPUT（放行到主进程 IPC 所需的本机回环即可）；或整体置于禁网的网络命名空间/容器。
2. **进程/容器隔离（建议）**：让子进程跑在独立低权限用户 / 容器中（容器 + seccomp，或 gVisor/Firecracker 等），把权限模型之外的攻击面（内核漏洞、`/proc` 信息泄露等）也收口。代码已是 fork-per-task 的可杀子进程，部署侧补齐 OS 约束即可。
3. **资源上限（建议）**：对执行进程设 CPU/内存/句柄 cgroup 限额，叠加在挂钟超时之上，防单场极端占用拖垮小机器。
4. **密钥隔离（已由权限模型 + env 白名单覆盖，仍建议冗余）**：`SESSION_SECRET` 等机密既不在子进程 env 中，其所在文件也在只读放行目录之外；进一步可把机密文件挪出应用目录并收紧属主权限。

## 三、其他部署项

- **`SESSION_SECRET`**：务必设为稳定强随机值（未设则每次启动随机、重启即登出）。
- **邮箱投递**：接入 SMTP 真正投递验证链接；**生产勿**把验证链接随接口响应回传前端（当前仅非生产环境为演示而回传，见 `server.js` 的 `sendVerificationEmail`）。
- **棋手密钥**：当前 `api_keys.key_plain` 明文留存以支持站内展示掩码与一键 Prompt（demo 取舍）。更高安全要求下应改为只存哈希、明文仅创建/轮换时一次性返回。
- **反向代理**：若置于代理后，`clientIp()` 取的是直连地址；需改为信任经校验的 `X-Forwarded-For`，否则频控按代理 IP 聚合。
- **HTTPS**：生产应在代理层启用 TLS，并给会话 Cookie 增加 `Secure`。
- **多实例**：`ratelimit.js` 为单进程内存实现；多实例需换共享存储（如 Redis）。
