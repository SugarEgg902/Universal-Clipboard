# 剪贴板抽屉柜：图片支持 + 键盘导航 设计文档

日期：2026-10-09
状态：已确认
前置：2026-10-08 基础版已完成并合并 main（23/23 测试通过）

## 1. 概述

在已有文本剪贴板历史工具上增量增加两项功能：

1. **图片支持**：剪贴板含图片时捕获、存储、展示（行内缩略图），可点击复制回剪贴板。
2. **键盘导航**：↑↓ 选择条目、Enter 复制、Cmd/Ctrl+K 聚焦搜索、Esc 语义细化。

## 2. 需求决策

| 决策项 | 结论 |
|---|---|
| 图片存储 | 文件系统：图片写 `userData/images/<hash16>.png`，SQLite 只存元数据 |
| 列表展示 | 行内 ~40px 等比缩略图 + 「🖼 图片 · 宽×高」标注 |
| 大图上限 | 跳过 >10MB 的图片（console 记录日志） |
| 图片去重 | SHA-256 内容哈希，同一天内同图不重复记录；同哈希复用同一文件 |
| 搜索 | 仅搜索文本条目，图片不参与 |

## 3. 数据层变更（store.js）

### Schema 迁移

`clips` 表新增两列（启动时 `PRAGMA table_info` 检测，缺列则 ALTER，带默认值无损迁移旧库）：

```sql
ALTER TABLE clips ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE clips ADD COLUMN image_path TEXT;
```

`image_path` 存相对于 images 目录的文件名（如 `<hash16>.png`）。

### 新 API

- `insertImage({ hash, width, height, saveFile }, now)` —— 接收 PNG buffer 与保存回调；同一天同哈希去重；返回 rowid 或 null。文件写入由调用方（主进程）完成或回调完成，store 负责元数据与去重。
- `get(id)` / `listByDay` / `listDays` 返回行新增 `type`、`image_path`、`width`、`height`（后两者可为 null）。
- `search` 仅匹配 `type='text'`。
- `delete(id)` / `clearDay(dateKey)`：删除图片条目时若无其他行引用同一 `image_path`，同步删除对应图片文件。store 需要知道 images 目录绝对路径（构造时注入）。

## 4. 主进程变更

### watcher.js

- `check()` 先查 `clipboard.availableFormats()`：含 `image/*` 走图片分支，否则走文本分支（现有逻辑不变）。
- 图片分支：`readImage()` → 空图跳过 → `toPNG()` → >10MB 跳过（console.error）→ 回调 `onImage(buffer, { width, height })`。
- 构造函数注入扩展：`onImage` 可选。

### index.js

- 启动时创建 `userData/images` 目录；`protocol.handle('clipimg', ...)` 注册缩略图协议：按 id 查库，流式返回磁盘图片文件（仅允许该目录内文件）。
- watcher 的 onImage：计算 sha256 → 同哈希文件已存在则跳过写盘 → `store.insertImage(...)`。
- `clipboard:copy`：图片条目用 `nativeImage.createFromPath` + `clipboard.writeImage`。

### ipc.js

- `listDays` / `listByDay` 返回条目附带 `type`、`width`、`height`、`thumb`（图片条目为 `clipimg://<id>`，文本为 null）。
- copy handler 按 `row.type` 分支。

### preload.js

- 无需新增方法（复用现有通道）。

## 5. 渲染层变更

### UI

- 图片条目行：左侧 ~40px 缩略图（`clipimg://` 协议加载，等比、圆角），文字标注「🖼 图片 · 800×600」；点击整行复制图片。
- 文本条目维持现状。
- CSP 头增加 `img-src 'self' clipimg:`。

### 键盘导航

| 按键 | 行为 |
|---|---|
| ↑ / ↓ | 右侧条目列表移动选中态（`.item.selected` 高亮） |
| Enter | 复制选中条目 |
| Cmd/Ctrl+K | 聚焦搜索框并全选 |
| Esc | 搜索有内容 → 清空并回到当天；否则隐藏窗口 |

实现：全局 keydown 监听；焦点在搜索框时 ↑↓ 仍作用于列表（阻止默认光标移动需处理）；输入框内 Enter 不触发复制。

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 剪贴板图片读取失败 | 同文本：记录日志、跳过本次 |
| 图片写盘失败 | 记录日志、不入库 |
| clipimg 请求无效 id / 越界路径 | 返回 404/空响应，不崩溃 |
| 图片文件已被删但库记录在 | 缩略图加载失败显示占位（破图图标 alt） |

## 7. 测试策略

- store：迁移（旧库无新列→自动 ALTER）、图片插入与同日哈希去重、跨天同图、文本搜索不含图片、删除图片条目清理文件（含多行引用同一文件只删一次）、清空当天清理文件。
- watcher：availableFormats 有图→onImage、无图→onClip 文本、空图跳过、>10MB 跳过（注入尺寸构造测试）。
- 手动验证：截屏复制 → 抽屉出现缩略图 → 点击粘贴到预览/聊天窗口；旧数据库启动正常。

## 8. 不做（YAGNI）

- 文件/文件夹剪贴板（Finder 复制文件）——后续单独里程碑
- 图片搜索 / OCR
- 多设备同步
