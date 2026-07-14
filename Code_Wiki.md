# Code_Wiki — UNO Guys（糖豆人式 UNO 网页原型）

## 项目基本介绍

本项目是类似 **Fall Guys / 糖豆人** 的 **网页 3D 原型**。

当前能力：

- 渲染糖果色软垫风格场景
- 玩家键盘 **移动 / 跳跃**（相对镜头）；点击锁定鼠标转镜头；**左键使用手持道具**；**G 丢弃**道具到身前（爆牌飞出）
- Rapier 物理 + Kinematic Character Controller
- 场景 **UNO 数字牌**拾取堆叠（`canStackOn`）；运回 **本家角**计分
- **背牌减速**：每张背包牌 **−5%** 移速，最低 **50%**（`shared/config/movement.ts`）
- **大厅**：主路径为 **单机游戏**（本地 3 机器人）；**局域对战暂未开启**（联机代码仍保留）
- **单机完整玩法**（无 WebSocket）：运牌、偷家、电网触电、你铲 / 机器人铲、2 分钟 / 20 张、UNO 时刻（`OfflineBotSystem` + 本地权威）
- **局域网联机**（代码在，大厅入口暂关）：多房间、房主开始、位姿+权威卡牌、服务端机器人
- **服务器机器人**（联机）：捡牌/卸货/偶发偷家；持棒攻击有 **0.5–1.5s 随机前摇**；可布置 Skip
- **手持道具（互斥，仅 1 个）**：
  - **狼牙棒**：场上/手持为棒网格；左键挥击 → 眩晕 1.5s、掉背包顶至多 4 张
  - **Skip 陷阱**：场上为 Skip 牌面；左键布置到脚下（全员可见、无时限）；**他人**踩中眩晕 2s；**自己不踩中**
- **不掉对方手持道具**；**眩晕期间不可捡牌/卸货/偷家**
- **木头人**（测试靶）：**默认不在场**；左侧按钮请求服务器 `debug_set_dummy` 才生成（逻辑+模型+背包+可打）；隐藏则彻底移除
- **UNO 时刻**：某玩家老家分首次进入「距胜利还差 ≤5 张」时，全房顶部一次性横幅（`uno_moment`）
- **老家电网**：主人站在自己老家平台内 → 四周全员可见电网；**非主人踩入即触电死亡**（全掉落背包+手持），**5s** 后自家重生；有电网时不可偷该家
- **回合胜负**：2 分钟；先把牌送达老家 **20 张**者胜；超时则老家张数最多者胜（`shared/config/match.ts`）

**路线图：**

| 阶段 | 内容 | 状态 |
|------|------|------|
| 单机玩法 | 移动、捡牌、卸货、3 Bot、偷家/电网/铲球 | ✅ |
| 联机 Phase 1–4 | 房间/移动/权威卡牌/多房间 | ✅（大厅入口暂关） |
| 联机 Phase 5 | 机器人 + 眩晕战斗 + 木头人 | ✅ |
| 联机 Phase 6 | 回合计时 + 20 张胜负 | ✅ |
| 联机 Phase 7 | 老家电网 + 死亡/重生 | ✅ |
| 发布 | 静态 ZIP 托管单机 | ✅ |
| 后续 | 重开局域对战入口、道具刷场等 | ⏳ |

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
| 协议版本 | `PROTOCOL_VERSION = 7`（含 home_fences / player_died / player_respawned） |
| 房间 | `RoomManager`：创建/房间码加入；测试房 `0000` 可一点即玩 |
| 位姿 | 客户端 20Hz 上报；服务器 10Hz 广播；远端插值 ~100ms |
| 卡牌 | `server/GameSim` 刷牌/拾取/卸货/攻击；客户端仅表现 |
| 道具 | 手持 `item`（狼牙棒 / Skip）≠ 背包 `stack`；`player_item` 公开同步；互斥 |
| 攻击 | 棒：锥形命中消耗；Skip：`trap_placed` 布置脚下，踩中 `trap_triggered` |
| 背上牌 | `private_state` + 全员 `player_stack` |
| 老家 | 四角 0–3；仅本家卸货；主人在家 → 电网 |
| 人数 | 最多 4；木头人 `training_dummy` **非座位**，仅 debug 开启时存在 |
| 断线 | 座位保留 15s，`sessionToken` 可重连 |
| 远端初始位姿 | 大厅无 `world_state` 时，远程角色（含 Bot）生成在各自 `homeIndex` 角落，避免落在原点 |

---

## 目录与脚本作用

```text
Uno/
├── shared/
│   ├── protocol.ts
│   ├── config/{cards,home,movement,dummy,match}.ts
│   └── uno/{types,rules,deck}.ts
├── server/
│   ├── index.ts / RoomManager.ts / Room.ts
│   ├── GameSim.ts           # 权威卡牌+攻击+电网+死亡+木头人
│   └── Bot.ts               # 服务端 AI
├── src/
│   ├── main.ts / core/Game.ts
│   ├── net/NetClient.ts
│   ├── entities/{Player,HomeBase,TrainingDummy,AttackRangeVisual,StunFx,SkipTrapMarker,...}
│   ├── systems/SkipTrapSystem.ts
│   ├── game/uno/{cardVisual,maceVisual}.ts
│   └── ui/{LobbyPanel,GameHud}.ts
└── Code_Wiki.md
```

| 文件 | 作用 |
|------|------|
| `shared/protocol.ts` | 消息类型；`attack` / `player_stunned` / `home_fences` / `player_died` / `player_respawned` / `trap_*` / `uno_moment` / `debug_set_dummy` / `dummy_state` 等 |
| `shared/config/home.ts` | 四角老家、`HOME_FENCE_DEATH_MS`、`isInsideHomeSlot` |
| `shared/config/movement.ts` | 背牌减速、基础移速（前后端共用） |
| `shared/config/dummy.ts` | 木头人 id / 高度 / 补牌张数 |
| `shared/config/match.ts` | 时长、`MATCH_WIN_SCORE`、`MATCH_UNO_REMAINING` |
| `shared/uno/types.ts` | 牌型、`isStunBat` / `isSkipTrap` / `isHandItem`、眩晕与陷阱常量 |
| `shared/uno/deck.ts` | 刷牌；默认 `stunFraction`/`skipFraction` **均为 0**（场上不刷棒/Skip） |
| `server/GameSim.ts` | 场上牌、背包、道具、攻击、Skip 陷阱、**老家电网/死亡/重生**、木头人开关（`setTrainingDummyActive`） |
| `server/Bot.ts` | 机器人寻路、延迟挥棒、近敌布置 Skip；**避开有电网的家** |
| `server/Room.ts` | 房间 tick、位姿、死亡锁定 pose、重生 snap；`uno_moment`；木头人 pose 仅 active 时注入 |
| `src/game/uno/maceVisual.ts` | 程序化狼牙棒网格 |
| `src/entities/HomeBase.ts` | 老家平台、牌堆、**电网视觉** |
| `src/entities/SkipTrapMarker.ts` | 已布置 Skip 陷阱地面标记 |
| `src/systems/SkipTrapSystem.ts` | 客户端陷阱增删/动画 |
| `src/entities/TrainingDummy.ts` | 中央木头人 + 受击/眩晕表现（仅服务器 active 时挂场景） |
| `src/systems/RemotePlayerSystem.ts` | 远端/机器人插值；创建时按 home 落角，避免站中心 |
| `src/systems/OfflineBotSystem.ts` | 单机 Bot：捡牌/偷家/铲人/触电重生 |
| `src/ui/LobbyPanel.ts` | 大厅：单机 / 局域对战（暂关） |
| `src/entities/AttackRangeVisual.ts` | 身前攻击扇形（仅狼牙棒） |
| `src/entities/StunFx.ts` | 头顶眩晕星星 |
| `src/entities/Player.ts` | 本地/远端豆人 + 手持棒/Skip 牌 + 背牌 |
| `src/ui/GameHud.ts` | HUD + 触电死亡遮罩 + **UNO 时刻顶栏** + 木头人调试按钮 |

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
- **Skip 陷阱**：左键在脚下布置（`trap_placed`）；**无存在时限**、**全员可见**；**放置者不会踩中**；他人踩入 `SKIP_TRAP_RADIUS` → 眩晕 **2s**，陷阱移除（`trap_removed` / `trap_triggered`）  
- **场上刷牌**：默认**不生成**狼牙棒 / Skip（`DEFAULT_STUN_FRACTION = 0`、`DEFAULT_SKIP_FRACTION = 0`）；调试面板仍可 `debug_give_item` 手动加  
- **G 丢弃**：`discard_item` + yaw → 手持道具以 `stun_drop` 爆牌飞到身前约 1.35m，可再捡；眩晕中不可丢  
- **不掉对方手持道具**；被眩晕时 **tick / interact 均禁止** 捡牌、卸货、偷家  
- 爆落牌 `source: stun_drop`；木头人补牌 / 重连 welcome 会清理残留爆落；重连 `welcome.traps` 同步陷阱  
- 机器人：持棒时会挥；持 Skip 时近敌会布置（需先手动给到道具）  

### 老家电网与死亡

- **开启条件**：主人**未死亡**且站在自己老家 `halfSize` 平台内 → 该 slot 电网激活  
- **表现**：四角半透明青色围栏（`HomeBase`），**全员可见**；状态广播 `home_fences { active: number[] }`  
- **触发**：非主人**踩入**有电网的老家平台 → 立即 `player_died`（不只偷牌时）  
- **惩罚**：背包 + 手持道具**全部掉落**（`stun_drop`）；不可移动/交互；本地全屏遮罩倒计时  
- **重生**：`HOME_FENCE_DEATH_MS`（默认 5s）后 `player_respawned`，传送到**自己**老家 spawn  
- **偷家**：有电网时权威端禁止从该家偷牌（先电死后无法 interact）  
- **单机**：你与 Bot 站自家 → 电网亮；踩有电的别人家 → 掉光背包、5s 遮罩后自家重生  

## 单机（静态页 / ZIP）

- 大厅仅 **单机游戏** + 灰显 **局域对战（暂未开启）**  
- `Game.startOfflineSolo`：本地刷牌 + `OfflineBotSystem`（3 Bot）  
- 偷家 / 电网 / 铲球均在客户端模拟；HTTPS 页无需 `ws://`  
- 场上默认不刷狼牙棒/Skip（`DEFAULT_*_FRACTION = 0`）  
- 构建产物：`npm run build` → `dist/`；发布包勿提交 zip（本地 `uno-guys-web-static.zip`）  

## 回合胜负

- 时长 `MATCH_DURATION_MS`（默认 2 分钟）、达标 `MATCH_WIN_SCORE`（默认 20，仅计老家）  
- `match_start` 带 `endsAt` / `winScore`；结束广播 `match_end` 并回大厅  
- HUD 倒计时 + 结算弹窗  
- **UNO 时刻**：送达后分数首次满足 `score >= WIN - MATCH_UNO_REMAINING` 且未获胜 → 每人每局一次 `uno_moment` 顶栏  

## 木头人（调试）

- **默认关闭**：开局不注册 `training_dummy`，不注入 pose，机器人不可打到  
- 客户端左侧「显示木头人」→ `debug_set_dummy { active }` → `GameSim.setTrainingDummyActive` → 广播 `dummy_state`  
- 开启：中央可打靶 + 补测试数字牌；关闭：删玩家、清 pose、清补牌计时与爆落清理  
- 重连 `welcome.dummyActive` 同步状态  

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
