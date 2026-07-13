# Code_Wiki — UNO Guys（糖豆人式 UNO 网页原型）

## 项目基本介绍

本项目是类似 **Fall Guys / 糖豆人** 的 **网页 3D 原型**。

当前能力：

- 渲染糖果色软垫风格场景
- 玩家键盘 **移动 / 跳跃**（相对镜头）；点击锁定鼠标转镜头；**左键挥狼牙棒**
- Rapier 物理 + Kinematic Character Controller
- 场景 **UNO 数字牌**拾取堆叠（`canStackOn`）；运回 **本家角**计分
- **背牌减速**：每张背包牌 **−5%** 移速，最低 **50%**（`shared/config/movement.ts`）
- **局域网联机**：多房间、大厅、房主开始、位姿+权威卡牌；可单机
- **服务器机器人**（测试）：捡牌/卸货/偶发偷家；持棒攻击有 **0.5–1.5s 随机前摇**
- **眩晕道具**：无色功能牌 → 场上/手持为 **狼牙棒**网格；击中眩晕 1.5s、掉背包顶至多 4 张；**不掉对方手持道具**
- **木头人**（场地中央）：可打测试靶，背后叠测试牌，眩晕后自动补牌

**路线图：**

| 阶段 | 内容 | 状态 |
|------|------|------|
| 单机玩法 | 移动、捡牌、卸货 | ✅ |
| 联机 Phase 1–4 | 房间/移动/权威卡牌/多房间 | ✅ |
| 联机 Phase 5 | 机器人 + 眩晕战斗 + 木头人 | ✅ |
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
| 协议版本 | `PROTOCOL_VERSION = 5` |
| 房间 | `RoomManager`：创建/房间码加入；测试房 `0000` 可一点即玩 |
| 位姿 | 客户端 20Hz 上报；服务器 10Hz 广播；远端插值 ~100ms |
| 卡牌 | `server/GameSim` 刷牌/拾取/卸货/攻击；客户端仅表现 |
| 道具 | 手持 `item`（狼牙棒）≠ 背包 `stack`；`player_item` 公开同步 |
| 攻击 | 身前锥形 `ATTACK_RANGE`/`ATTACK_CONE_DEG`；命中消耗自己的棒 |
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
│   ├── entities/{Player,TrainingDummy,AttackRangeVisual,StunFx,...}
│   ├── game/uno/{cardVisual,maceVisual}.ts
│   └── ui/{LobbyPanel,GameHud}.ts
└── Code_Wiki.md
```

| 文件 | 作用 |
|------|------|
| `shared/protocol.ts` | 消息类型；`attack` / `player_stunned` / `ground_snapshot` 等 |
| `shared/config/movement.ts` | 背牌减速、基础移速（前后端共用） |
| `shared/config/dummy.ts` | 木头人 id / 高度 / 补牌张数 |
| `shared/uno/types.ts` | 牌型、眩晕常量、`isStunBat` |
| `shared/uno/deck.ts` | 刷牌；`stunFraction:0` 时不生成眩晕 |
| `server/GameSim.ts` | 场上牌、背包、道具、攻击、爆牌、木头人 |
| `server/Bot.ts` | 机器人寻路与延迟攻击 |
| `server/Room.ts` | 房间 tick、位姿、攻击 pose 含木头人 |
| `src/game/uno/maceVisual.ts` | 程序化狼牙棒网格 |
| `src/entities/TrainingDummy.ts` | 中央木头人 + 受击/眩晕表现 |
| `src/entities/AttackRangeVisual.ts` | 身前攻击扇形 |
| `src/entities/StunFx.ts` | 头顶眩晕星星 |
| `src/entities/Player.ts` | 本地/远端豆人 + 手持棒 + 背牌 |

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

- 眩晕为**无色功能牌**，不按 UNO 顺序；有空手持槽即可捡  
- 场上/手持显示为狼牙棒，不进背包  
- 左键：身前扇形内最近目标；命中 → 眩晕 1.5s、从背包**顶**掉 `min(4, 张数)` 数字牌、消耗自己的棒  
- **不掉对方手持道具**  
- 爆落牌 `source: stun_drop`；木头人补牌 / 重连 welcome 会清理残留爆落  
- 机器人攻击：范围内随机前摇 0.5–1.5s 再挥，冷却 0.9–1.7s  

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
