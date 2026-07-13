# Code_Wiki — Bean Guys（糖豆人网页原型）

## 项目基本介绍

本项目是类似 **Fall Guys / 糖豆人** 的 **网页 3D 单机原型**（Phase 1）。

当前目标：

- 渲染一块糖果色软垫风格场景
- 玩家用键盘操控角色 **移动 / 跳跃**（相对镜头方向）
- 第三人称相机：**点击画面锁定鼠标**，移动鼠标转镜头（类似糖豆人）
- 使用物理引擎做角色与静态场景碰撞
- 场景随机生成 **UNO 卡牌**；靠近 **自动拾取**；仅允许按 UNO 规则接到当前顶牌（背包堆叠）；不合法则屏幕提示「不能接」
- **左下角老家**：出生点；把背上的牌运回老家区域自动卸货，累计送达张数

**明确不做（Phase 1）：** 联机、大厅、淘汰、Ragdoll、飞扑 Dive、抓取、复杂后处理、真人对战出牌。

工作区路径：`/Users/fengbotao/游戏设计/Uno`  
包名：`bean-guys-prototype`

---

## 项目架构

```text
浏览器
  └── Vite + TypeScript
        ├── three (WebGPURenderer，可降级 WebGL2)
        ├── @dimforge/rapier3d-compat（WASM 物理 + Character Controller）
        └── 游戏循环 Game.tick
              ├── InputManager（按键状态）
              ├── PlayerController（惯性/重力/跳跃 + KCC）
              ├── CardPickupSystem（自动拾取 / 合法堆叠）
              ├── PhysicsWorld.step
              └── CameraFollow + render
```

**选型理由（摘要）：**

| 层 | 选型 | 说明 |
|----|------|------|
| 构建 | Vite + TS | 快速本地开发 |
| 渲染 | `WebGPURenderer` | 对齐技术调研笔记；设备不支持时可降级 |
| 物理 | Rapier3D | KCC、性能、未来确定性联机 |
| 控制 | Kinematic Character Controller | 避免纯刚体控人导致的弹飞/卡角 |
| UI 框架 | 无 React / 无 R3F | Phase 1 直连 Three，心智负担最小 |

---

## 目录与脚本作用

```text
Uno/
├── index.html                 # 页面入口
├── package.json               # 依赖与 scripts
├── vite.config.ts             # esnext target、排除 rapier 预打包
├── tsconfig.json
├── Code_Wiki.md               # 本文件
└── src/
    ├── main.ts                # 挂载 HUD、创建并启动 Game
    ├── style.css              # 全屏 canvas + HUD 样式
    ├── vite-env.d.ts
    ├── config/
    │   └── movement.ts        # 速度/加速/跳跃/相机等可调参数
    ├── core/
    │   ├── Game.ts            # 场景、灯光、主循环、resize
    │   └── Physics.ts         # Rapier init + World 封装
    ├── managers/
    │   └── InputManager.ts    # WASD / 方向键 / Space
    ├── game/uno/
    │   ├── types.ts           # 花色/点数、显示文案
    │   ├── rules.ts           # canStackOn 合法接牌
    │   └── deck.ts            # 随机牌池生成
    ├── entities/
    │   ├── Environment.ts     # 地面、障碍、边界墙 + Fixed colliders
    │   ├── Player.ts          # 胶囊「豆」外观与转向
    │   ├── PlayerController.ts# KCC 位移、重力、落地检测
    │   └── CardPickup.ts      # 场景中可拾取卡牌 Mesh
    ├── systems/
    │   ├── CameraFollow.ts    # 第三人称 lerp 跟随
    │   └── CardPickupSystem.ts# 刷牌、自动捡、非法提示
    └── ui/
        └── GameHud.ts         # 牌堆 HUD + 底部提示
```

### 各模块说明

| 文件 | 作用 |
|------|------|
| `main.ts` | 入口；错误时在 HUD 显示 |
| `core/Game.ts` | `WebGPURenderer` 初始化、主循环 `tick`、灯光 |
| `core/Physics.ts` | `RAPIER.init()`、`World`、`step()` |
| `managers/InputManager.ts` | 缓存按键；跳跃用边沿触发 |
| `entities/Environment.ts` | 软垫地面 + 彩色方块障碍 + 半透明边界 |
| `entities/Player.ts` | 视觉网格（胶囊+五官）+ 后背牌堆 |
| `entities/HeadCardDisplay.ts` | 后背叠牌展示（最外层为顶牌）与张数 |
| `entities/HomeBase.ts` | 左下角老家平台与送达牌堆 |
| `config/home.ts` | 老家坐标 / 范围 / 出生点 |
| `entities/PlayerController.ts` | 读输入 → 水平速度惯性 → 重力/跳 → KCC → 同步 Mesh |
| `systems/CameraFollow.ts` | 鼠标 yaw/pitch 轨道相机 + 跟随；提供水平前后右方向给移动 |
| `systems/CardPickupSystem.ts` | 刷 28 张牌；范围内自动合法拾取；非法提示 |
| `game/uno/rules.ts` | 仅数字牌：同色或同数字可接 |
| `ui/GameHud.ts` | 顶牌与最近 8 张 chip、提示条 |
| `config/movement.ts` | **调手感只改这里** |

### UNO 拾取规则（背包堆叠）

1. **只生成 4 色数字卡**（红/黄/绿/蓝 × 0–9），无跳过/反转/+2/万能。  
2. 牌堆为空：靠近任意卡 → 自动捡入，成为顶牌。  
3. 已有顶牌：同色 **或** 同数字 → 自动捡入并更新顶牌。  
4. 靠近不合法卡：不捡起，底部提示「不能接」。  
5. 离开范围后清除非法提示。

---

## 本地运行

```bash
cd "/Users/fengbotao/游戏设计/Uno"
npm install
npm run dev
```

浏览器打开终端提示的本地地址（默认 `http://localhost:5173`）。

```bash
npm run build    # tsc + vite build
npm run preview  # 预览 dist
```

### 操作

- **移动：** `W A S D` 或方向键  
- **跳跃：** `Space`

---

## 手感调参

编辑 `src/config/movement.ts`：

- `maxSpeed` / `accel` / `decel`：走停惯性  
- `airControl`：空中水平控制比例  
- `jumpImpulse` / `gravity`：跳跃弧线  
- `turnSpeed`：转向快慢  
- `cameraOffset` / `cameraLerp`：镜头位置与滞后  

---

## 对上手开发者的重要信息

1. **物理与图形分离：** 位移由 Rapier KCC 算；Three Mesh 每帧从刚体 translation 同步。角色朝向只改 Mesh，不写进物理旋转。  
2. **重力自管：** 世界虽有 gravity，但角色用 `verticalVel` 自算，再并入 `computeColliderMovement`。  
3. **胶囊坐标：** Rapier capsule 的 translation 是胶囊中心；视觉 Group 原点在脚底附近，同步时要减 `halfHeight + radius`。  
4. **Phase 1 不做：** 网络、多玩家、淘汰、Ragdoll、Dive、Grab。  
5. **技术调研笔记：** [WebGPU+Three.js网页糖豆人](https://notebooklm.google.com/notebook/1fd51281-53f0-4529-a57e-627b68822de5)  
6. **若改用 R3F：** 可参考社区 `ecctrl` / wawa-guys，但本仓库当前为纯 Three。

---

## 建议后续阶段

| 阶段 | 内容 |
|------|------|
| 1.5 | 掉落重置、简单 squash 动画、可选 Dive |
| 2 | 动态机关、受击 stagger / 简易 Ragdoll |
| 3 | 联机与淘汰 |
