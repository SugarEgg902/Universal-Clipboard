# 剪贴板抽屉柜：桌宠悬浮抽屉柜 设计文档

日期：2026-10-09
状态：已确认
前置：v1-v4 已合并入 main（v4 Me-Search 76/76 测试）

## 1. 概述

新增常驻桌宠：一个贴在屏幕角落的迷你抽屉精灵（无边框透明小窗），平时做待机小动作，每次复制从头顶冒出预览气泡；单击唤起主窗口，可拖动换位。给剪贴板工具增加"在场感"与情感留存。

## 2. 需求确认

| 决策项 | 结论 |
|---|---|
| 形态 | 64×64 迷你吉祥物，默认 📦，托盘可换 🗃️🐱🐤 |
| 密码行气泡 | 只显示 🔒「已捕获密码」，永不显示内容；skip 模式（完全不记录）下不冒泡 |
| 单击行为 | 左键唤起主窗口；拖动（4px 阈值）换位；右键迷你菜单 |
| 待机小动作 | 用户明确要求：状态机（idle/action/hover/sleepy/excited）+ 随机动作池 |
| 置顶 | `floating` 层级，不压全屏应用，不做全屏检测 |

## 3. 主进程架构

### 3.1 pet 窗口（新模块 src/main/pet.js）

`createPet({ rendererDir }) → { show, hide, notifyClip(payload), getWindow }`，复刻 palette.js 模式：

- `BrowserWindow`：64×64（气泡渲染在窗外区域时放宽内容尺寸，窗口本身 ≥200×260 但透明区域点击需穿透——用 `setIgnoreMouseEvents` 逐形状切换成本高，简化方案：窗口固定 200×260 紧贴角落，透明区 `pointer-events: none` 由 CSS 处理，窗口设 `focusable: false`；macOS 下透明区不响应点击由 CSS `pointer-events:none` + 事件转发不做，接受透明窗格内小范围不可点（细节在计划期验证）
- `transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop('floating')`
- 加载独立页面 `pet.html`（不走 app.js 的 palette 分流）
- 窗口被销毁后 `getWindow()` 返回 null，`notifyClip` 容忍空窗口；再次 `show()` 重建
- 位置/显隐由 index.js 依配置驱动

### 3.2 复制事件接线

index.js watcher 回调中，文本/图片入库成功后：

- 文本：`secret = looksLikeSecret(String(text).trim())`（复用 v3 检测器）；`pet.notifyClip({ kind: 'text', preview: secret ? '' : text.slice(0, 60), secret })`
- 图片：`pet.notifyClip({ kind: 'image', preview: `${width}×${height}` })`
- skip 模式命中密码：return 前不通知（不冒泡）——与"完全不记录"语义一致
- 托盘新增"桌宠"checkbox（默认开），关闭时 `pet.hide()` 并持久化 `pet.enabled=false`

### 3.3 配置持久化

`config.json` 扩展为 `{ privacyMode, pet: { enabled, x, y, emoji } }`。privacyConfig 模块扩展（同一原子写模式）：
- `getPet()/setPet(patch)` 深合并 pet 子对象
- 旧 config.json 无 pet 字段时按默认值 `{enabled:true, x:null, y:null, emoji:'📦'}` 返回，不写回（懒默认）
- x/y 为 null 时用默认位置（右下角留边 24px，按主屏计算）

### 3.4 IPC

- `pet:moved`（renderer→main，{x, y}）→ 写配置
- `pet:open-main` → showWindow()；`pet:open-palette` → palette.show()
- 右键菜单由 pet.js 渲染层发 `pet:context-menu`，主进程 `Menu.popup` 迷你菜单（打开主窗口 / 快速粘贴面板 / 禁用桌宠）

## 4. 桌宠渲染层（pet.html + pet.js + pet.css）

### 4.1 冒泡

- 监听 IPC `pet:clip` → 生成气泡节点：text 显示截断预览（≤60 字，单行截断）、image 显示 🖼+尺寸、secret 显示 🔒 已捕获密码
- 动画：自吉祥物头顶升起 + 淡出，约 3s 后移除；最多叠 3 个（超出移除最旧）
- excited 状态：冒泡前先蹦两下

### 4.2 待机小动作状态机

| 状态 | 触发 | 动作（CSS keyframes 作用于 emoji 容器） |
|---|---|---|
| idle | 默认/动作结束 | 呼吸浮动（±4px 慢循环） |
| action | scheduler 每 25-45s 随机 | 动作池：眨眼(scaleY 快压扁回弹)/蹦一下(hop 16px)/左右张望(±10°×2)/伸懒腰(拉伸1.2x)/翻个身(360°)/小碎步横移 |
| hover | mouseenter/leave | 朝鼠标倾 10°+轻晃，离开回 idle |
| sleepy | 距上次复制 ≥30min | Zzz 浮出+整体变慢；新复制或悬停即唤醒 |
| excited | pet:clip 事件 | 蹦两下后进冒泡 |

- scheduler：`setTimeout` 随机间隔抽动作池，动作播放 3-4s 后回 idle
- 状态优先级：excited > hover > action > sleepy > idle
- 最近一次复制时间戳由 renderer 自记（notifyClip 到达即更新），主进程零改动

### 4.3 交互

- mousedown→mousemove>4px→drag：窗口移动（screen 坐标差累加），mouseup 后发 `pet:moved` 持久化
- 未达阈值 mouseup = 单击 → `pet:open-main`
- contextmenu → `pet:context-menu`
- 切换 emoji：IPC `pet:set-emoji`（托盘子菜单触发，渲染层更新显示）

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 桌宠窗口未创建/被销毁 | notifyClip 静默跳过；show() 重建 |
| 主显示器变化/分辨率调整 | x/y 越界时钳制到可见区；启动时校验 |
| 配置损坏 | 沿用 privacyConfig 现状（回退默认） |
| 快速连复制 | 气泡最多 3 个，excited 不叠加（播放中不重触发） |
| 主窗口已开时再点桌宠 | 复用 showWindow（置顶已有实例） |
| 系统睡眠唤醒 | 无状态丢失（无定时器精度依赖） |

## 6. 测试策略

- 配置：`getPet/setPet` 默认回填、深合并、损坏回退、原子写
- 冒泡 payload 组装：text/image/secret/skip 四分支（store 入库成功才通知）
- notifyClip 空窗口容忍
- 渲染层无自动化测试（惯例）：门 = `node --check` + 全量不回归 + 冒烟
- 冒烟：启动 → 复制文本/图片/密码各一 → 截图确认三种气泡；拖换位 → 重启 → 位置保持；托盘禁用/启用；待机 30s+ 截图确认小动作出现

## 7. 不做（YAGNI）

- 异形点击穿透、骨骼动画、多宠、语音
- 全屏检测/自动隐藏
- Windows/Linux 行为差异化处理
- 动作池用户自定义
