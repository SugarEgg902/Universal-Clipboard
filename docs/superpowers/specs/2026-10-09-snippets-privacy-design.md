# 剪贴板抽屉柜：片段库 + 隐私安全区 设计文档

日期：2026-10-09
状态：已确认
前置：v1 基础版（461dcaf 合并）、v2 图片支持+键盘导航（3f5cc9c 合并，33/33 测试通过）

## 1. 概述

在已有剪贴板历史工具上增量增加两项留存型功能：

1. **片段库**：历史条目可 Pin 成片段，设触发词与分组；全局快捷键唤起迷你"快速粘贴面板"，选中即粘贴回之前的应用。
2. **隐私安全区**：启发式检测疑似密码的剪贴板内容，用户可配置"记录但打码"（默认）或"完全不记录"两种模式。

## 2. 需求确认

| 决策项 | 结论 |
|---|---|
| 展开方式 | 全局快捷键 `Cmd/Ctrl+Shift+;` 唤起快速粘贴面板，Enter 模拟粘贴（不做任意输入框直出） |
| 片段来源 | 仅从历史条目 Pin，不做手动新建 |
| 分组 | Pin 时可选填分组名，抽屉"📌 片段"视图按组折叠 |
| 隐私命中处理 | 可配置两种模式：记录但打码（默认）/ 完全不记录，托盘菜单单选切换，持久化 |
| 检测方式 | 内容启发式（长度/字符类/熵/排除规则），不依赖辅助功能权限读取来源应用 |

## 3. 数据层变更（store.js）

沿用 v2 的 PRAGMA table_info 迁移机制，`clips` 表新增三列（旧库无损升级）：

```sql
ALTER TABLE clips ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN trigger TEXT;
ALTER TABLE clips ADD COLUMN group_name TEXT;
```

### 新 API

- `pin(id, trigger, groupName)` — 设 pinned=1 + 触发词 + 分组；触发词冲突（同词不同条目，不区分大小写）抛错。触发词可为空（仅分组收藏）。
- `unpin(id)` — pinned=0，清 trigger/group_name。
- `updatePin(id, trigger, groupName)` — 修改触发词/分组，同样校验唯一性。
- `listSnippets()` — 所有 pinned 条目，按 group_name 分组（null 归"未分组"），组内按 created_at 倒序。
- `findByTrigger(trigger)` — 按触发词（不区分大小写）查 pinned 条目，快速面板用。
- 触发词唯一性：新建/修改时查询 `WHERE pinned=1 AND lower(trigger)=lower(?)`。
- v2 已有行为不变：**仅文本条目可 Pin**（片段本质是文本短语；图片条目不出现 Pin 按钮），搜索照常（片段仍是 clips 行）。

## 4. 主进程变更

### 片段快速粘贴（新模块 src/main/palette.js）

`palette.js` 负责迷你面板窗口的创建/显隐/生命周期，主进程入口 index.js 只做接线。

- **全局快捷键** `Cmd/Ctrl+Shift+;`（`globalShortcut.register`，注册失败 console.error）。
- **迷你面板窗口**：独立 `BrowserWindow`（尺寸约 480×360，frameless 或 slim，失焦自动隐藏，Esc 隐藏），加载同一 renderer 入口但带 query `?palette=1`，渲染层按 query 切换为面板模式（只读搜索+pinned 列表，无日期抽屉）。
- **Enter 流程**：`clipboard.writeText(snippet.text)` → 面板隐藏 → 模拟粘贴 → 隐藏后焦点自然回到之前的应用。
- **粘贴适配层 `src/main/paster.js`**：
  - `paste()` 接口，平台分支：
    - darwin：`osascript -e 'tell application "System Events" to keystroke "v" using command down'`
    - win32 / linux：v3 未实现，返回 `{ ok:false, reason:'unsupported-platform' }`
  - 任何失败返回 `{ok:false, reason}`，由调用方决定提示；内容已在剪贴板上，用户可手动 Cmd+V。
  - 首次失败（macOS 权限不足）→ 面板/renderer 显示一次性引导文案（系统设置 → 隐私与安全性 → 辅助功能 → 授权）。
- 面板与主窗口共用 `registerIpc`（palette 模式走 `clipboard:listSnippets` / `clipboard:searchSnippets` 通道或复用 listByDay——设计定：新增 `clipboard:listSnippets` handler 返回分组结构）。

### 隐私安全区

- **检测器 `src/main/secretDetector.js`**（纯函数，可单测）：`looksLikeSecret(text)` 同时满足：
  - 长度 ≥ 16
  - ≥3 类字符（小写/大写/数字/符号）
  - 无空格、无换行、无 tab
  - Shannon 字符熵 ≥ 3.5 bit/char
  - 排除：`://` 出现（URL）、以 `/` 开头或匹配盘符 `^[A-Za-z]:\\`（路径）、纯数字
- **配置 `src/main/privacyConfig.js`**：`userData/config.json` 读写 `{ privacyMode: 'mask' | 'skip' }`，默认 `'mask'`；托盘菜单"隐私模式"子菜单两个 radio item，点击写入配置（参照既有开机自启 checkbox 模式）。
- **watcher 接线**：`onClip` 在 index.js 先过 `looksLikeSecret`：
  - skip 模式：命中 → 不入库，console.log 留痕。
  - mask 模式：正常入库，行返回时带 `secret: true` 标记（由检测器在读取侧重新判定，还是入库时打标？——定：**读取侧判定**，DB 不动，避免模式切换后历史不一致；`withSecret(row)` 在 ipc 层对 text 行跑检测器附加 `secret` 字段）。
- **ipc**：listByDay/search 的 text 行附加 `secret` 布尔（图片行恒 false）。

### 托盘菜单

新增子菜单：
```
隐私模式 ▸ ◉ 记录但打码
            ○ 完全不记录
```

## 5. 渲染层变更

### 抽屉（主窗口）

- 左侧抽屉列顶部固定抽屉 **"📌 片段"**（icon 📌，排今天之前），无日期计数，显示片段总数。
- 片段视图：右侧按分组折叠（组名标题 + 条目数），组内时间倒序；条目行 = 文本行 + 触发词徽章（如 ⌁ addr）+ 分组标签。
- 条目操作：现有删除按钮保留；新增 **📌 按钮**（text/image 行悬浮出现）→ 弹出小表单（触发词 input + 分组 input + 确定/取消）→ 调 `clipboard:pin`；已 Pin 的条目 📌 变为填充态，点击弹"修改/取消 Pin"。
- **打码渲染**：`item.secret === true` 的行，文本区显示 `••••••••` + "已隐藏的密码条目"灰字 + 右侧"显示"按钮（点击临时明文，再点收回）；复制照常（点击行 = 复制，密码回剪贴板是合法用途）。

### 快速粘贴面板（`?palette=1`）

- 单一搜索框自动聚焦；输入即过滤（匹配触发词前缀 > 内容子串，触发词命中的排前）。
- `↑↓` 选择高亮，`Enter` 调 `clipboard:pasteSnippet(id)`（主进程：writeText → hide → 模拟粘贴 → 失败时返回 reason，renderer 短暂显示"已复制，请手动粘贴"），`Esc` 隐藏。
- 面板不计入 7 天抽屉逻辑，纯片段列表。

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 模拟粘贴失败（无辅助功能权限 / 非 macOS） | 内容已入剪贴板，面板闪提示"已复制，请手动粘贴"；macOS 首次失败附权限引导文案 |
| 触发词重复（含大小写变体） | Pin 表单内联报错"触发词已被占用"，不关闭表单 |
| 触发词含空白/特殊字符 | 表单校验：仅允许字母数字连字符下划线，长度 ≤ 32 |
| 同条目重复 Pin | 走 updatePin（修改），幂等 |
| 隐私模式切换 | 只影响切换后的新剪贴板；历史条目按读取侧检测器重新判定，行为即刻一致 |
| 非 macOS 平台按快捷键 | 面板正常唤起与复制；粘贴步骤退化提示，不崩溃 |

## 7. 测试策略

- secretDetector：密码样例（长短、各字符类组合）、URL、文件路径、纯数字长串、普通句子、边界长度 15/16、熵恰好阈值——全分支单测。
- store：pin/unpin/updatePin、触发词唯一性（大小写不敏感）、listSnippets 分组排序、图片条目 Pin。
- watcher/privacy：skip 模式拦截不落库；mask 模式正常落库。
- paster：mock child_process，darwin 分支命令正确、失败路径返回 reason。
- renderer 无自动化测试（沿袭前两轮惯例），手动验证：Pin 全流程、面板唤起/过滤/粘贴、打码显示切换、托盘菜单切换持久化。

## 8. 不做（YAGNI）

- 手动新建片段、片段富文本、图片片段（Pin 仅支持文本行）
- 任意输入框触发词直出（v3.2 再议）
- 跨设备同步、AI 功能（下一里程碑候选）
