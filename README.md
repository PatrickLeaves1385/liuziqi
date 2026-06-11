# 六子棋 · AI 对战观战（Node 全栈 Demo）

可玩 Demo 第一版：在浏览器里观看两套 AI 流派对弈，逐手回放、查看棋谱与终局裁定。
后端复用已验证的确定性引擎（`engine/`，源自 `GameDesign/` 的规则与模板），前端做可视化与播放控制。

## 运行

> 需要 Node.js（≥16）。本机已通过 Chocolatey 安装 Node v24.16.0。

```powershell
cd E:\liuziqi
node server.js
```

然后浏览器打开 http://localhost:3000 。无需 `npm install`（零第三方依赖）。

## 玩法

- 选择**黑方**与**红方**的流派（子力派 / 封锁派 / 裁定派 / 抢中派），设定**种子**与**思考点**，点「开始对局」。
- 对局是**确定性的**：同流派 + 同种子 + 同思考点 → 结果完全一致。
- 播放控制：⏮ 回开局 / ◀ 上一手 / ▶ 播放暂停 / ▶ 下一手 / ⏭ 跳终局；方向键←→单步、空格播放/暂停。
- 右侧显示双方子数、当前回合、无吃子手数（/20）、棋谱（可点击跳手）与终局裁定。

## 结构

```
server.js            # 零依赖 HTTP 服务器：静态资源 + /api/templates + /api/match
engine/              # 自包含引擎（从 GameDesign 复制，未改动）
  rules_metered.js   #   规则 + 吃子结算 + 终局裁定（带思考点计量）
  engine_quota.js    #   对局主循环（黑方先行 / 自动停手 / 判负）
  templates_factory.js #  四套评估流派 + negamax 搜索
public/              # 前端
  index.html  style.css  app.js
GameDesign/          # 原始策划与规则代码（参考，未纳入运行）
```

## API

- `GET /api/templates` → `{ templates:[{name,summary}], weights }`
- `POST /api/match`，body `{ black, red, seed, budget }`
  → `{ ok, winner, reason, turns, finalPieces, initialBoard, history, elapsedMs }`
  - `winner`: `black` | `red` | `draw`
  - `reason`: `eliminated`（吃至≤1子）/ `material`（20手裁定）/ `stalemate`（互停裁定）/ `draw` / `illegal` / `runtime` / `error`

## 规则要点

4×4 棋盘，黑子与红子各 6 子，黑方先行，每手沿横竖走一步到相邻空格。
走棋方形成「2 连己方 + 1 对方」的相连三子即吃掉对方那子（仅结算落子的横线与竖线，双线同吃，单手至多 2 子，不连锁，送上门不吃）。
对方 ≤1 子判负；连续 20 手无吃子按子力裁定，**领先 1 子即判胜**。

## 后续可扩展（按需）

人机对战 / 本地双人 / 对局分享链接 / 多 AI 锦标赛榜单 / 策划案中的 Agent 平台（账号、代码版本、排位、侦察与回滚 API）。

## 状态

已在本机完整验证（2026-06-11）：规则单元测试 12/12 通过（含规则 v2.1 §5.3 全部官方示例）；
API 确定性复跑一致、非法入参返回 400；浏览器实测开局布局、播放回放、吃子标记、双线同吃、
eliminated 与 material 两种终局横幅均正常，控制台无报错。
规则文档《六子棋规则_v2.1.md》与引擎实现已逐条核对一致。
