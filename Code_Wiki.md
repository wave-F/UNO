# Code_Wiki — Bean Guys（糖豆人网页原型）

## 项目基本介绍

本项目是类似 **Fall Guys / 糖豆人** 的 **网页 3D 原型**。

当前能力：

- 渲染糖果色软垫风格场景
- 玩家键盘 **移动 / 跳跃**（相对镜头）；点击锁定鼠标转镜头
- Rapier 物理 + Kinematic Character Controller
- 场景 **UNO 数字牌**拾取堆叠（`canStackOn`）；运回 **左下角老家**计分
- **局域网联机（已落地）**：多房间 RoomManager、大厅准备、房主开始、位姿+权威卡牌；可单机

**路线图：**

| 阶段 | 内容 | 状态 |
|------|------|------|
| 单机玩法 | 移动、捡牌、卸货 | ✅ |
| 联机 Phase 1–3 | 房间/移动/权威卡牌 | ✅ |
| 联机 Phase 4 | **多房间 + 大厅 + 房主开始** | ✅ |
| 后续 | 静态托管、胜负 UI 等 | ⏳ |

工作区：`/Users/fengbotao/游戏设计/Uno`  
包名：`bean-guys-prototype`

联机知识笔记：https://notebooklm.google.com/notebook/b7142881-834b-438d-b046-86f9c17cded8

---

## 项目架构

```text
浏览器 (Vite + TS)
  ├── three / Rapier / Game 循环（单机权威）
  ├── NetClient + LobbyPanel  ──WebSocket──►  主机 Node server
  └── shared/protocol.ts（前后端共用消息）

主机 Node (tsx)
  ├── HTTP :8787 /health
  └── WebSocket Room（join / room_state / reconnect / rate limit）
```

**联机选型（锁定）：**

| 项 | 选择 |
|----|------|
| 拓扑 | 主机权威 Listen Server |
| 传输 | WebSocket（JSON） |
| 发现 | 主机 IP + 端口 8787 |
| 协议版本 | `PROTOCOL_VERSION = 4`（多房间大厅） |
| 房间 | `RoomManager`：创建/房间码加入；每房一房主；对局中不可加入 |
| 位姿 | 客户端 20Hz 上报；服务器 10Hz 广播；远端插值 ~100ms |
| 卡牌 | `server/GameSim` 刷牌/拾取/卸货；客户端仅表现 |
| 背上牌 | 本地 `private_state`；全员 `player_stack` 驱动远端 `HeadCardDisplay` |
| 老家 | 四角各一座（`homeSlots` 0–3）；座位 `homeIndex`；仅本家卸货 |
| 人数 | 最多 4 |
| 断线 | 座位保留 15s，`sessionToken` 可重连 |

---

## 目录与脚本作用

```text
Uno/
├── package.json
├── shared/
│   ├── protocol.ts
│   ├── config/{cards,home}.ts
│   └── uno/{types,rules,deck}.ts
├── server/
│   ├── index.ts
│   ├── Room.ts
│   ├── GameSim.ts           # 权威卡牌世界
│   └── tsconfig.json
├── src/
│   ├── main.ts              # Game + LobbyPanel + NetClient
│   ├── net/NetClient.ts     # WS + pose 上报
│   ├── entities/RemotePlayer.ts
│   ├── systems/RemotePlayerSystem.ts
│   ├── ui/LobbyPanel.ts
│   ├── ui/GameHud.ts
│   ├── core/Game.ts         # attachNet + remotes
│   └── game/uno/ …          # 规则仍仅客户端（Phase 3 上移 shared）
└── Code_Wiki.md
```

| 文件 | 作用 |
|------|------|
| `shared/protocol.ts` | 消息类型、pose/world_state、频率常量 |
| `server/index.ts` | 绑定 `0.0.0.0:8787` |
| `server/Room.ts` | 房间、限流、位姿校验、10Hz world_state |
| `src/net/NetClient.ts` | join、tickPose、worldState 事件 |
| `src/entities/RemotePlayer.ts` | 远端胶囊 + 名牌 + 插值 |
| `src/systems/RemotePlayerSystem.ts` | roster 与 world_state 应用 |
| `src/ui/LobbyPanel.ts` | 联机 UI |

### npm scripts

```bash
npm run dev       # 前端 Vite（--host，可被局域网打开页面）
npm run server    # 联机房间服 :8787
npm run build     # tsc + vite build
```

### 局域网怎么玩（Phase 1）

1. **主机**终端：`npm run server`（看日志里的 `ws://192.168.x.x:8787`）  
2. **主机**另开：`npm run dev`  
3. 浏览器打开 Vite 地址；右上角填昵称，WS 默认 `ws://本机hostname:8787`  
4. **其他设备**：打开 `http://主机局域网IP:5173`，WS 填 `ws://主机局域网IP:8787`，点「加入房间」  
5. 进房后：对方移动 + **同一套场上牌**；一人捡走全员消失；得分在 HUD「联机得分」  

防火墙放行 **5173** / **8787**。协议 v3 需重启 `npm run server`。

---

## 单机玩法摘要

- 仅数字牌四色 0–9；同色或同点可叠  
- 老家卸货累计张数（单机默认西南角；联机四人四角）  
- 调参：`src/config/movement.ts`、`cards.ts`、`shared/config/home.ts`

---

## 对上手开发者

1. 未 join：本地 `CardPickupSystem` 权威；join 后 `enterOnlineMode`。  
2. 断线：15s 后座位移除，背包牌掉回场上。  
3. 本地忽略自己的 world_state 位姿。  
4. 物理与图形分离：位移 KCC，Mesh 跟 translation。  
5. `localStorage`：session / name / ws-url。  
6. `HomeYard` 渲染四角；`PublicPlayer.homeIndex` 绑定座位；`match_start.homes` 权威下发；开局传送本家。  
7. 场上刷牌避开四角 `cardSpawnClearRadius`；别人家里不能捡牌也不能卸货。  
8. 本地 `PlayerController.teleport` 排队避开 KCC 覆盖；服务器对「落在本家出生点」的位姿不做限速钳制。

---

## 建议后续阶段

| 阶段 | 内容 |
|------|------|
| 4 | 一键 host 静态托管、胜负 UI、表现打磨 |
