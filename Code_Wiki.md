# Code_Wiki — UNO Guys（糖豆人式 UNO 网页原型）

## 项目基本介绍

本项目是类似 **Fall Guys / 糖豆人** 的 **网页 3D 原型**。

当前能力：

- 渲染糖果色软垫风格场景
- 玩家键盘 **移动 / 跳跃**（相对镜头）；点击锁定鼠标转镜头；**左键使用手持道具**；**G 丢弃**道具到身前（爆牌飞出）
- Rapier 物理 + Kinematic Character Controller
- 场景 **UNO 数字牌**拾取堆叠（`canStackOn`）；运回 **本家角**计分
- **背牌减速**：每张背包牌 **−5%** 移速，最低 **50%**（`shared/config/movement.ts`）
- **局域网联机**：多房间、大厅、房主开始、位姿+权威卡牌；可单机
- **服务器机器人**（测试）：捡牌/卸货/偶发偷家；持棒攻击有 **0.5–1.5s 随机前摇**；可布置 Skip
- **手持道具（互斥，仅 1 个）**：
  - **狼牙棒**：场上/手持为棒网格；左键挥击 → 眩晕 1.5s、掉背包顶至多 4 张
  - **Skip 陷阱**：场上为 Skip 牌面；左键布置到脚下（全员可见、无时限）；**他人**踩中眩晕 2s；**自己不踩中**
- **不掉对方手持道具**；**眩晕期间不可捡牌/卸货/偷家**
- **木头人**（场地中央）：可打测试靶，背后叠测试牌，眩晕后自动补牌
- **回合胜负**：2 分钟；先把牌送达老家 **20 张**者胜；超时则老家张数最多者胜（`shared/config/match.ts`）

**路线图：**

| 阶段 | 内容 | 状态 |
|------|------|------|
| 单机玩法 | 移动、捡牌、卸货 | ✅ |
| 联机 Phase 1–4 | 房间/移动/权威卡牌/多房间 | ✅ |
| 联机 Phase 5 | 机器人 + 眩晕战斗 + 木头人 | ✅ |
| 联机 Phase 6 | 回合计时 + 20 张胜负 | ✅ |
| 后续 | 静态托管、胜负 UI 等 | ⏳ |

工作区：`/Users/fengbotao/游戏设计/Uno`  
包名：`uno-guys`

联机知识笔记：https://notebooklm.google.com/notebook/b7142881-834b-438d-b046-86f9c17cded8

---

## 项目架构

```text
浏览器 (Vite + TS)
  ├── three / Rapier / Game 循环
  ├── NetClient + LobbyPanel  ──WebSocket──►  主机 Node server
  └── shared/protocol.ts（前后端共用消息）

主机 Node (tsx)
  ├── HTTP :8787 /health
  └── WebSocket RoomManager → Room → GameSim + Bot
```

**联机选型（锁定）：**

| 项 | 选择 |
|----|------|
| 拓扑 | 主机权威 Listen Server |
| 传输 | WebSocket（JSON） |
| 发现 | 主机 IP + 端口 8787 |
| 协议版本 | `PROTOCOL_VERSION = 6`（含 match_end / 计时） |
| 房间 | `RoomManager`：创建/房间码加入；测试房 `0000` 可一点即玩 |
| 位姿 | 客户端 20Hz 上报；服务器 10Hz 广播；远端插值 ~100ms |
| 卡牌 | `server/GameSim` 刷牌/拾取/卸货/攻击；客户端仅表现 |
| 道具 | 手持 `item`（狼牙棒 / Skip）≠ 背包 `stack`；`player_item` 公开同步；互斥 |
| 攻击 | 棒：锥形命中消耗；Skip：`trap_placed` 布置脚下，踩中 `trap_triggered` |
| 背上牌 | `private_state` + 全员 `player_stack` |
| 老家 | 四角 0–3；仅本家卸货 |
| 人数 | 最多 4（+ 非座位木头人 `training_dummy`） |
| 断线 | 座位保留 15s，`sessionToken` 可重连 |

---

## 目录与脚本作用

```text
Uno/
├── shared/
│   ├── protocol.ts
│   ├── config/{cards,home,movement,dummy}.ts
│   └── uno/{types,rules,deck}.ts
├── server/
│   ├── index.ts / RoomManager.ts / Room.ts
│   ├── GameSim.ts           # 权威卡牌+攻击+木头人
│   └── Bot.ts               # 服务端 AI
├── src/
│   ├── main.ts / core/Game.ts
│   ├── net/NetClient.ts
│   ├── entities/{Player,TrainingDummy,AttackRangeVisual,StunFx,SkipTrapMarker,...}
│   ├── systems/SkipTrapSystem.ts
│   ├── game/uno/{cardVisual,maceVisual}.ts
│   └── ui/{LobbyPanel,GameHud}.ts
└── Code_Wiki.md
```

| 文件 | 作用 |
|------|------|
| `shared/protocol.ts` | 消息类型；`attack` / `player_stunned` / `trap_*` / `ground_snapshot` 等 |
| `shared/config/movement.ts` | 背牌减速、基础移速（前后端共用） |
| `shared/config/dummy.ts` | 木头人 id / 高度 / 补牌张数 |
| `shared/uno/types.ts` | 牌型、`isStunBat` / `isSkipTrap` / `isHandItem`、眩晕与陷阱常量 |
| `shared/uno/deck.ts` | 刷牌；`stunFraction` / `skipFraction`；均为 0 时纯数字 |
| `server/GameSim.ts` | 场上牌、背包、道具、攻击、Skip 陷阱、爆牌、木头人 |
| `server/Bot.ts` | 机器人寻路、延迟挥棒、近敌布置 Skip |
| `server/Room.ts` | 房间 tick、位姿、攻击 pose 含木头人；转发 `trap_*` |
| `src/game/uno/maceVisual.ts` | 程序化狼牙棒网格 |
| `src/entities/SkipTrapMarker.ts` | 已布置 Skip 陷阱地面标记 |
| `src/systems/SkipTrapSystem.ts` | 客户端陷阱增删/动画 |
| `src/entities/TrainingDummy.ts` | 中央木头人 + 受击/眩晕表现 |
| `src/entities/AttackRangeVisual.ts` | 身前攻击扇形（仅狼牙棒） |
| `src/entities/StunFx.ts` | 头顶眩晕星星 |
| `src/entities/Player.ts` | 本地/远端豆人 + 手持棒/Skip 牌 + 背牌 |

### npm scripts

```bash
npm run dev       # 前端 Vite（--host）
npm run server    # 联机房间服 :8787
npm run build     # tsc + vite build
```

### 局域网怎么玩

1. 主机：`npm run server` + `npm run dev`  
2. 页面进房（或「本地双开测试」房间 `0000`）→ 房主开始  
3. 改 `server/` 或 `shared/` 后需 **重启 `npm run server`**；纯客户端可只刷新  

防火墙放行 **5173** / **8787**。

---

## 战斗与道具摘要

- 功能道具为**无色牌**，不按 UNO 顺序；占**唯一**手持槽 `item`（狼牙棒与 Skip **互斥**），不进背包  
- **狼牙棒**：场上/手持为棒网格；左键扇形最近目标；命中 → 眩晕 **1.5s**、掉背包顶 `min(4, 张数)`、消耗自己的棒  
- **Skip 陷阱**：场上刷更多（`skipFraction` 默认约 0.32）；左键在脚下布置（`trap_placed`）；**无存在时限**、**全员可见**；**放置者不会踩中**；他人踩入 `SKIP_TRAP_RADIUS` → 眩晕 **2s**，陷阱移除（`trap_removed` / `trap_triggered`）  
- **G 丢弃**：`discard_item` + yaw → 手持道具以 `stun_drop` 爆牌飞到身前约 1.35m，可再捡；眩晕中不可丢  
- **不掉对方手持道具**；被眩晕时 **tick / interact 均禁止** 捡牌、卸货、偷家  
- 爆落牌 `source: stun_drop`；木头人补牌 / 重连 welcome 会清理残留爆落；重连 `welcome.traps` 同步陷阱  
- 机器人：棒在范围内 0.5–1.5s 前摇再挥；持 Skip 时近敌会布置，冷却约 0.8–1.4s  


## 回合胜负

- 时长 `MATCH_DURATION_MS`（默认 2 分钟）、达标 `MATCH_WIN_SCORE`（默认 20，仅计老家）  
- `match_start` 带 `endsAt` / `winScore`；结束广播 `match_end` 并回大厅  
- HUD 倒计时 + 结算弹窗  

---

## 对上手开发者

1. 未 join：本地 `CardPickupSystem` 权威；join 后 `enterOnlineMode`。  
2. 攻击判定只在服务器；`handleAttack` 的 pose **必须包含** `TRAINING_DUMMY_ID`。  
3. 客户端眩晕特效用本地 `durationMs`，避免与服务器时钟偏差。  
4. `localStorage`：session / name / ws-url。  
5. 背牌移速：`maxSpeedForCarry(stack.length)`。  

---

## 建议后续阶段

| 阶段 | 内容 |
|------|------|
| 打磨 | 胜负 UI、更多功能牌、平衡调参 |
| 发布 | 一键 host 静态托管 |
|
