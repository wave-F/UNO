# Web 局域网联机开发：知识体系调研总览

> 调研日期：2026-07-13  
> 适用目标：基于 Web（浏览器）开发局域网联机游戏；优先贴合 **回合制卡牌（如 UNO）+ 可选实时移动**  
> 用途：NotebookLM 导读总源 + 自学路径

---

## 0. 一句话结论

联机的**核心问题**（权威裁决、房间、状态/事件同步、断线重连、隐藏信息）与「是否用 Web」无关；  
Web 决定的是**传输与发现的约束**：浏览器侧几乎只能用 **WebSocket / WebRTC**，且难以做经典局域网 UDP 广播发现。

对 **局域网 Web 版 UNO**，社区与工程上最稳妥的默认方案是：

**主机本机跑权威服务器（Node + HTTP 静态资源 + WebSocket）→ 其他人用浏览器打开 `http://局域网IP:端口` → 客户端只发意图（出牌/摸牌），服务器校验规则并广播状态。**

---

## 1. 知识分层地图（建议学习顺序）

| 层级 | 主题 | 你要回答的问题 | UNO 相关度 |
|------|------|----------------|------------|
| L0 | 术语与问题空间 | 延迟、丢包、权威、房间、会话是什么 | 必学 |
| L1 | 架构 | C/S 权威服 vs P2P/主机模式如何选 | 必学 |
| L2 | 传输 | WebSocket vs WebRTC 何时用 | 必学 |
| L3 | 协议与状态 | Command / Event / Snapshot 怎么设计 | 必学 |
| L4 | 同步策略 | 状态同步 / 输入锁步 / 预测回滚边界 | 卡牌浅学；移动深学 |
| L5 | 房间与工程 | 生命周期、重连、隐私手牌、限流 | 必学 |
| L6 | 局域网产品 | 如何发现主机、同网段、访客 Wi‑Fi | 必学 |
| L7 | 框架与源码 | Colyseus / 手写 ws / NetplayJS 等 | 选框架时学 |

---

## 2. 架构层：平台无关的联机本质

### 2.1 权威服务器（Authoritative Server）

**定义**：游戏世界与规则只在服务器（或指定主机进程）上推进；客户端发送**输入/意图**，接收**已裁决结果**，主要负责渲染与交互。

**优点**：防作弊、规则一致、中途加入/观战更易、隐藏信息（手牌）可按客户端过滤下发。  
**代价**：多一跳延迟；需要可部署的服（局域网里可以是「某个人的电脑」）。

经典阐述：Gabriel Gambetta《Client-Server Game Architecture》  
→ https://www.gabrielgambetta.com/client-server-game-architecture.html

系列后续（动作游戏向，了解边界即可）：

- Client-Side Prediction & Reconciliation  
  https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html  
- Entity Interpolation  
  https://www.gabrielgambetta.com/entity-interpolation.html  
- Lag Compensation  
  https://www.gabrielgambetta.com/lag-compensation.html  
- Live Demo  
  https://www.gabrielgambetta.com/client-side-prediction-live-demo.html  

**对 UNO**：出牌是离散、低频、强一致事件——**几乎不需要客户端预测**；非法出牌由服务器拒绝并可选下发纠正状态即可。

### 2.2 P2P / 主机模式

- **P2P mesh**：玩家互连；需信令（signaling）、NAT 穿透（STUN/TURN），主机迁移复杂。  
- **Listen Server / Host 模式**：一名玩家进程兼权威服；断线则整局受影响。

**局域网派对**常等价于「一人当 host 权威服」，逻辑上仍是 C/S，只是服跑在玩家机器上。

### 2.3 工业引擎参考（概念词汇）

Valve Source 多人网络（tick、snapshot、lag compensation 等术语来源）：  
https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking  

Steam Networking 总览（现代 Valve 网络能力索引）：  
https://partner.steamworks.com/doc/features/multiplayer/networking  

> 注意：Source 文档面向 UDP 高频动作游戏；卡牌游戏吸收其「权威 + 快照/输入」思想即可，不必照搬 tickrate。

### 2.4 传输哲学（Gaffer on Games）

Gaffer 系列强调：实时游戏常在 UDP 上自建可靠性；TCP/WebSocket 的「队头阻塞」对高频状态更新不友好。  
入口索引：https://gafferongames.com/tags/networking/  
代表文：Reliable Ordered Messages  
https://gafferongames.com/post/reliable_ordered_messages/  

**对 UNO**：出牌需要可靠有序 → **WebSocket（TCP）完全合适**；不必为卡牌先上自定义 UDP 可靠层。

---

## 3. Web 传输层：浏览器真实能力边界

### 3.1 WebSocket（局域网 UNO 主线）

**能力**：全双工、基于 TCP、浏览器原生、文本或二进制帧。  
**官方文档**：

- MDN WebSocket API  
  https://developer.mozilla.org/en-US/docs/Web/API/WebSocket  
- Node 侧常用实现 `ws`  
  https://github.com/websockets/ws  
- 工程增强库 Socket.IO（自动降级、房间、重连、ACK）  
  https://socket.io/docs/v4/  
  Rooms：https://socket.io/docs/v4/rooms/  

**适用**：房间广播、回合事件、重连会话、与 HTTP 同端口提供页面。

**典型最小栈**：

```
Browser Client  --WebSocket-->  Node Host Process
                     ^
                     |
              同一进程提供 index.html / 静态资源
```

### 3.2 WebRTC DataChannel（P2P / 类 UDP 选修）

**能力**：点对点数据通道；可配置有序/可靠或更低延迟的不可靠模式；底层常走 UDP（经 SCTP）。  
**文档**：

- MDN：游戏场景下的 Data Channels  
  https://developer.mozilla.org/en-US/docs/Games/Techniques/WebRTC_data_channels  
- MDN：Using WebRTC data channels  
  https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels  
- webrtc.org 入门 Peer Connections  
  https://webrtc.org/getting-started/peer-connections  
- RFC 8831（Data Channels 规范，含游戏用例描述）  
  https://datatracker.ietf.org/doc/html/rfc8831  

**何时考虑**：

- 不想维持中心游戏状态服、少人 P2P  
- 需要浏览器↔Node 的「UDP 风格」通道（见 geckos.io）  
- 语音/视频同通道  

**代价**：信令、ICE、TURN、主机迁移；调试成本显著高于 WebSocket。

相关开源：

| 项目 | 链接 | 学什么 |
|------|------|--------|
| NetplayJS | https://github.com/rameshvarun/netplayjs | WebRTC + Rollback/Lockstep，浏览器 P2P |
| Trystero | https://github.com/dmotz/trystero | 无自建服的 P2P 应用抽象 |
| geckos.io | https://github.com/geckosio/geckos.io | 浏览器↔Node 的 WebRTC 数据通道 |
| awesome-webrtc | https://github.com/nuzulul/awesome-webrtc | 资源索引 |
| Pion WebRTC | https://github.com/pion/webrtc | Go 侧 WebRTC（进阶服务端） |

社区长文示例（DataChannel 记牌小游戏）：  
https://webrtchacks.com/datachannel-multiplayer-game/

### 3.3 Web 局域网发现的残酷现实

- 浏览器**不能**像原生游戏那样随意 UDP 广播扫局域网服务。  
- 实务 UX：主机展示 **IP + 端口** 或 **二维码**；或同一 Wi‑Fi 下口头报地址。  
- 坑：访客网络隔离、AP 隔离、手机蜂窝与 Wi‑Fi 混用、IPv6/链路本地地址。  
- 开发：Vite 开发服 + 代理 WS；发布：同一 Node 进程 `static + ws`。

---

## 4. 同步与协议设计（卡牌最佳实践）

### 4.1 三种同步流派（选型）

| 流派 | 做法 | 适合 | UNO |
|------|------|------|-----|
| 状态同步 / 快照 | 服务器持有 State，定期或变更时下发全量/增量 | 大多数 C/S 游戏 | **推荐** |
| 输入锁步 | 只同步输入，各方确定性模拟 | RTS、部分格斗；要求确定性 | 可选但不必要 |
| 预测 + 回滚 | 本地先演、错了回滚 | 格斗、平台动作 | 出牌不需要 |

### 4.2 消息分层（强烈建议）

**客户端 → 服务器：Command（意图）**

- `joinRoom { roomId, name }`  
- `ready`  
- `playCard { cardId }`  
- `drawCard`  
- `callUno`  
- `chooseColor { color }`（万能牌）  

**服务器 → 客户端：Event / Snapshot**

- `roomState`（座位、准备状态）  
- `gameStarted { publicState, yourHand }`  
- `cardPlayed { playerId, card, nextTurn, publicEffects }`  
- `privateHand`（仅本人）  
- `error { code, message }`  
- `playerDisconnected` / `playerReconnected`  

原则：

1. **客户端绝不直接改「真相状态」**（尤其是别人的手牌、牌堆顺序）。  
2. **服务器校验**颜色/数字匹配、是否轮到你、是否有禁手等。  
3. **序列号 / 版本号**防止乱序与重放。  
4. **幂等**：同一 `commandId` 只生效一次。  
5. **隐藏信息**：每人只收自己的 `hand`；公共区单独字段。  
6. **洗牌与 RNG 只在服务器**。

### 4.3 房间状态机

```
Lobby → (all ready) → Playing → Finished
         ↑                │
         └──── 再来一局 ──┘
```

房间字段建议：`roomId`、`hostId`、`players[]`、`phase`、`turnIndex`、`discardTop`、`direction`、`drawStack`（+2/+4 叠罚等，按规则）、`rngSeed`（仅服务器）。

### 4.4 重连

- 连接断开 ≠ 立即踢出座位；保留 `sessionToken` / `reconnectToken`。  
- 重连后：下发**私有手牌 + 当前公共快照**，而不是从头观战除非超时。  
- Socket.IO / Colyseus 对重连有现成钩子；手写 ws 需自管 `playerId ↔ socket` 映射。

### 4.5 与「实时移动」并存时

若同一项目既有 UNO 出牌又有角色移动：

- **出牌通道**：可靠事件（WebSocket 消息）。  
- **移动通道**：可低频状态同步（位置/速度快照），或仅大厅走动；不必与牌局同一 tick 模型。  
- 参考 Gambetta 预测/插值仅用于移动层。

---

## 5. 框架与社区最佳案例（源码精读清单）

### 5.1 Colyseus（Node 房间 + 状态同步首选教材）

- 官网/文档：https://docs.colyseus.io/  
- 状态同步：https://docs.colyseus.io/state  
- Room：https://docs.colyseus.io/room  
- FAQ（重连、按客户端可见性等）：https://docs.colyseus.io/faq  
- 源码：https://github.com/colyseus/colyseus  

**精读关注点**：

- `onCreate` / `onJoin` / `onLeave` / `onMessage`  
- Schema 状态与 patch（增量同步）  
- `allowReconnection`  
- 何时用 `state` vs 即时 `messages`（FAQ 明确讨论）

**适合**：快速做出权威房间；学习「服务器突变状态 → 自动同步」的产品级抽象。

### 5.2 手写 WebSocket / Socket.IO

适合建立肌肉记忆的最小闭环：

1. 连接与 `playerId`  
2. 房间 join/leave  
3. 广播 vs 单播  
4. 权威出牌校验  
5. 刷新页面重连  

教程向文章（思路参考，非唯一真理）：

- Medium：Multiplayer Game With WebSockets  
  https://medium.com/@diegolikescode/multiplayer-game-with-websockets-fd629686aaec  
- PlainEnglish：Building a Multiplayer Game with JS and WebSockets  
  https://javascript.plainenglish.io/building-a-multiplayer-game-with-javascript-and-websockets-in-one-weekend-a287d517fb60  

社区讨论：

- GameDev SE：WebSocket 权威服通信  
  https://gamedev.stackexchange.com/questions/137036/websocket-based-realtime-multiplayer-game-client-and-server-communication  
- Reddit：web-based realtime multiplayer 架构  
  https://www.reddit.com/r/gamedev/comments/ddj4oh/how_are_webbased_realtime_multiplayer_games/

### 5.3 P2P / Rollback 边界案例

- NetplayJS：https://github.com/rameshvarun/netplayjs  
  → 学「确定性 + 回滚」；**不要**默认用它做 UNO。  
- Trystero：https://github.com/dmotz/trystero  

### 5.4 精读任意 GitHub 多人大仓的 6 步

1. README 架构图：C/S 还是 P2P？  
2. 找 `server` / `room` / `messages`  
3. 列出全部 message type  
4. 全量状态还是 patch？  
5. join / leave / reconnect  
6. 手牌是否误广播？（隐藏信息审计）

GitHub 搜索公式：

```
websocket multiplayer language:TypeScript stars:>100
colyseus room example
"authoritative" multiplayer card
socket.io game room turn
webrtc datachannel game language:JavaScript
```

---

## 6. 局域网部署形态（产品级 checklist）

### 6.1 推荐拓扑

```
[主机电脑]
  Node: express/static(Vite build) + WebSocket 权威逻辑
  监听 0.0.0.0:PORT
        │
        ├── 本机浏览器 http://localhost:PORT
        ├── 手机 http://192.168.x.x:PORT
        └── 其他 PC 同上
```

### 6.2 检查清单

- [ ] 防火墙放行端口  
- [ ] 服务绑定 `0.0.0.0` 而非仅 `127.0.0.1`  
- [ ] 主机 UI 显示本机局域网 IPv4  
- [ ] 断线保留座位 N 秒  
- [ ] 主机退出 → 明确「房间解散」  
- [ ] 日志可回放一局（至少 message 流）  
- [ ] 非法操作返回错误码，不崩房间  

### 6.3 与 Vite 单机项目的演进路径（概念）

现有单机结构（示意）：

- `src/game/uno/rules` → 抽成**纯函数规则引擎**（服务器必跑，客户端可预校验 UX）  
- `deck` / RNG → **仅服务器**  
- `Game.ts` → 拆 `NetworkSession` + `Presentation`  
- HUD 输入 → 发 Command，不直接改权威 state  

---

## 7. 安全与一致性（最小集合）

1. **永远不信任客户端**：牌面、手牌数、是否能出，以服务器为准。  
2. **私有数据单播**：`socket.send` 给自己，不要 `broadcast` 手牌。  
3. **速率限制**：防刷 `draw`/`play`。  
4. **房间密码/简单口令**（可选，防串房）。  
5. **协议版本号**：客户端与服务器不匹配时拒绝入局。  
6. 公网以后再考虑：HTTPS、WSS、TURN、账号与反作弊。

---

## 8. 针对「Web 局域网 UNO」的最终推荐栈

| 层级 | 推荐 | 备选 |
|------|------|------|
| 架构 | 主机权威服 C/S | 后期再考虑匹配服 |
| 传输 | WebSocket | WebRTC（跨网/P2P 需求） |
| 库 | 手写 `ws` 学透，或 Colyseus 加速 | Socket.IO（要房间/重连糖） |
| 同步 | 事件 + 公共快照 + 私有手牌 | Schema patch（Colyseus） |
| 发现 | IP:端口 / 二维码 | mDNS 仅原生壳可做 |
| 移动同步 | 低频状态（若需要） | 预测插值（Gambetta） |

**不推荐作为 UNO 第一实现**：完整 rollback netcode、自研 UDP 可靠层、无服务器纯 mesh（除非刻意做技术实验）。

---

## 9. 分阶段自学计划（可执行）

| 天数 | 任务 | 验收 |
|------|------|------|
| D1 | 读 Gambetta Part I + 画 UNO 数据流 | 一张「出牌路径」图 |
| D2 | MDN WebSocket + 两人 echo 房间 | 两浏览器互通 JSON |
| D3 | 写出 Command/Event 列表 | 协议表 v0.1 |
| D4–5 | Colyseus 文档 Room + State | 能讲清 state vs message |
| D6 | 局域网：手机打开主机 IP | 真机进房 |
| D7 | 精读 1 个 GitHub 权威服示例 | 6 步审计笔记 |
| D8 | 隐藏信息 + 重连 | 刷新不丢座位 |
| D9+ | WebRTC / 移动同步选修 | 知道边界 |

---

## 10. 术语表（中英）

| 中文 | English | 简述 |
|------|---------|------|
| 权威服务器 | Authoritative server | 唯一规则与状态真相 |
| 意图/命令 | Command / Intent | 客户端请求执行的操作 |
| 快照 | Snapshot | 某一时刻的状态拷贝 |
| 增量/补丁 | Delta / Patch | 只同步变化字段 |
| 锁步 | Lockstep | 同步输入后共同模拟 |
| 客户端预测 | Client-side prediction | 先本地演再与服务器对齐 |
| 和解 | Reconciliation | 用服务器结果修正本地预测 |
| 插值 | Interpolation | 在快照之间平滑显示他人 |
| 延迟补偿 | Lag compensation | 服务器按过去时间回放命中等 |
| 信令 | Signaling | WebRTC 建连前交换 SDP/ICE |
| 房间 | Room | 一组玩家的会话隔离单元 |
| 会话 | Session | 玩家身份跨连接保持 |
| 队头阻塞 | Head-of-line blocking | TCP 丢包拖住后续字节 |

---

## 11. 权威链接书目（按主题分类）

### A. 架构与网络理论

1. https://www.gabrielgambetta.com/client-server-game-architecture.html  
2. https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html  
3. https://www.gabrielgambetta.com/entity-interpolation.html  
4. https://www.gabrielgambetta.com/lag-compensation.html  
5. https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking  
6. https://gafferongames.com/tags/networking/  
7. https://gafferongames.com/post/reliable_ordered_messages/  

### B. Web 官方与传输

8. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket  
9. https://developer.mozilla.org/en-US/docs/Games/Techniques/WebRTC_data_channels  
10. https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels  
11. https://webrtc.org/getting-started/peer-connections  
12. https://datatracker.ietf.org/doc/html/rfc8831  
13. https://github.com/websockets/ws  
14. https://socket.io/docs/v4/  
15. https://socket.io/docs/v4/rooms/  

### C. 框架与源码

16. https://docs.colyseus.io/  
17. https://docs.colyseus.io/state  
18. https://docs.colyseus.io/room  
19. https://docs.colyseus.io/faq  
20. https://github.com/colyseus/colyseus  
21. https://github.com/rameshvarun/netplayjs  
22. https://github.com/dmotz/trystero  
23. https://github.com/geckosio/geckos.io  
24. https://github.com/nuzulul/awesome-webrtc  
25. https://github.com/pion/webrtc  

### D. 社区讨论与教程

26. https://gamedev.stackexchange.com/questions/137036/websocket-based-realtime-multiplayer-game-client-and-server-communication  
27. https://www.reddit.com/r/gamedev/comments/ddj4oh/how_are_webbased_realtime_multiplayer_games/  
28. https://webrtchacks.com/datachannel-multiplayer-game/  
29. https://medium.com/@diegolikescode/multiplayer-game-with-websockets-fd629686aaec  

### E. 平台联网能力索引

30. https://partner.steamworks.com/doc/features/multiplayer/networking  

---

## 12. NotebookLM 使用建议（问笔记时）

可向本笔记提问的示例：

1. 对比 WebSocket 与 WebRTC 做局域网 UNO 的取舍。  
2. 根据权威服原则，列出 UNO 的 Command/Event 消息表。  
3. Colyseus 的 Room 生命周期如何映射到「开房-准备-对局-重连」。  
4. 为什么卡牌游戏通常不需要 rollback netcode？  
5. 设计一份局域网主机开房 checklist。  
6. 手牌隐藏信息应如何下发与审计？  

---

*本文为检索与综合整理，便于 NotebookLM 检索；实施时请以各官方文档最新版为准。*
