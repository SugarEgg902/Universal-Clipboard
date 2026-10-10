# 剪贴板抽屉柜：扫码快传（QR Transfer）设计文档

日期：2026-10-10
状态：已确认
前置：v1-v5 已合并入 main（v5 桌宠 86/86 测试）

## 1. 概述

剪贴板内容一键生成二维码，手机扫码即得：条目悬浮 QR 按钮、日期抽屉 QR 按钮（整天）、多选合并（文本）三种入口，弹出独立二维码小窗。短文本直接编码进二维码（离线可扫）；长文本/图片/整天/多选自动起临时局域网 HTTP 服务，二维码只编码带随机 token 的内网 URL。

## 2. 需求确认

| 决策项 | 结论 |
|---|---|
| 传输架构 | 混合：≤1000 字节文本直编二维码；其余走局域网临时 HTTP |
| 图片条目 | 支持，自动走局域网路线（扫码浏览器打开看原图，可长按保存） |
| 入口 | 悬浮按钮（条目 hover QR 图标 + 抽屉头部 QR 按钮），多选为行 hover 复选框 |
| 展示 | 独立小弹窗（复用 palette 窗口模式），320×380 |
| 选取粒度 | 单条 + 整天 + 多选合并；多选仅限文本条目 |
| 二维码阈值 | 1000 字节（文本，UTF-8） |

## 3. 主进程架构

### 3.1 临时 HTTP 服务（新模块 src/main/qrserver.js）

`startServer({ contentType, text, imagePath, portRange }) → { url, token, port }`，Node 内置 `http`，零新依赖：

- 路径 `/t/<token>`，token = 128 位随机 hex（crypto.randomBytes(16)），不可猜测
- 绑定 `0.0.0.0`（手机需访问），端口从 43789–43999 顺序探测可用端口
- 响应：`contentType: 'text'` → `text/plain; charset=utf-8` 输出全文；`'image'` → `image/png` 流式输出文件；`'bundle'`（多选/整天，文本）→ `text/plain`，每条一行、行间空行分隔
- 生命周期：调用方（QR 窗口关闭）触发 `stopServer()`；自身 10 分钟硬超时自动关；单次成功响应后仍可重复访问（防止手机一次没复制成功），直到超时/显式停止
- 取 IP：`os.networkInterfaces()` 第一个非回环 IPv4（family 为 'IPv4' 或 4，非 internal）
- 无可用内网 IP → 返回特定错误码 `no-network`，由渲染层提示降级文案

### 3.2 IPC 与双路判定

`ipcMain.handle('qr:generate', (event, payload) → { mode: 'inline' | 'url', ... })`

- payload `{ kind: 'text', text }` 单条文本；`{ kind: 'image', path }` 单条图片（读 imagesDir）；`{ kind: 'bundle', texts: [...] }` 多选/整天
- 判定纯函数 `routeFor(payload)`（单测目标）：单条文本且 `Buffer.byteLength(text, 'utf8') ≤ 1000` → `{ mode: 'inline', data: text }`；其余 → 起服务 `{ mode: 'url', url }`
- image 条目不读 QR 按钮（UI 层控制），但 handler 仍校验 path 必须在 imagesDir 内（防目录穿越）

### 3.3 QR 弹窗（新模块 src/main/qrwin.js）

复刻 palette.js 模式：`createQrWin({ rendererDir }) → { show(payload), hide, getWindow }`

- 320×380、无边框、透明背景否（用浅色实底更易扫——白底黑码）、focusable: true（要显示且可点复制按钮）、alwaysOnTop('floating'）、skipTaskbar
- 加载 `qr.html`；`show()` 后 `did-finish-load` 时经 webContents.send 发 `qr:render`，携带 qr:generate 的判定结果（不走 URL query——避免长度限制与内容进历史记录）
- 关闭/失焦 → `stopServer()`（若起了服务）

### 3.4 隐私

- 🔒 secret 条目（password 标记）不渲染 QR 按钮
- 明文 HTTP 仅限局域网，spec 注明；token 路径不可猜测 + 短生命周期
- bundle 内容含 secret 文本？多选/整天入口自动排除 secret 条目（查询 SQL 过滤）

## 4. 渲染层

### 4.1 入口（app.js）

- 条目 hover 操作区追加 QR 按钮（📱 或 QR 图标，样式对齐现有 📌/删除按钮）；secret 条目不渲染
- 日期抽屉头部追加 QR 按钮（与"清空当天"同排）
- 多选：行 hover 出现复选框（仅文本行），勾选 ≥1 后顶部浮出操作条"生成二维码（已选 N 条）· 取消"

> 注：不设快捷键——macOS 上 Cmd+Q 是系统级退出应用，Ctrl 系快捷键在本应用已被全局唤起（Cmd+Shift+V）与面板（Cmd+Shift+;）占用，悬浮按钮可达性已足够。

### 4.2 QR 小窗（qr.html + qr.js + qr.css）

- `qrcode` npm 包（纯 JS，无原生依赖）渲染到 canvas，尺寸 ~240px，白底
- inline 模式：文案"手机扫码即得"；url 模式：文案"手机连同一 WiFi 后扫码打开" + 链接文本 + "复制链接"按钮
- 无网络降级（`no-network` 且非 inline）：提示"未检测到局域网，该内容超出二维码容量"
- 错误/加载态：转圈 → 结果；超时未扫不主动关（用户自己关）

## 5. 错误处理

| 场景 | 处理 |
|---|---|
| 内容超 1000 字节且无局域网 | 提示降级文案，不静默截断 |
| 端口被占 | 端口范围内顺序探测，耗尽则报错提示 |
| token 404 | 服务只认当前 token，旧码失效 |
| 图片文件已丢失 | qr:generate 返回 not-found，提示"图片已不存在" |
| QR 窗口重复打开 | 复用单例，新 payload 替换旧内容，旧服务先停 |

## 6. 测试策略

- qrserver 单测：起停、GET 取文本/图片/bundle、错误 token 404、超时自动关（缩短超时注入）、多网卡取 IP、无网卡报错（mock os.networkInterfaces）
- routeFor 纯函数单测：边界 1000/1001 字节、中文多字节、image/bundle 恒 url
- 渲染层无自动化测试（惯例）：门 = node --check + 全量不回归（86 基线 + 新增）+ 冒烟
- 冒烟：真机生成三种形态二维码 → 手机扫码验证（或本机浏览器开 URL 验证内容一致）→ 关窗后 URL 失效

## 7. 不做（YAGNI）

- 公网穿透 / HTTPS / 跨网段
- 手机 → Mac 反向传输
- 扫码历史管理 / 二维码保存为图片文件
- 多选包含图片条目
