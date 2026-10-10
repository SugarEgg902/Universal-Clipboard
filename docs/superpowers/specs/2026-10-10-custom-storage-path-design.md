# 剪贴板抽屉柜：自定义存储位置 设计文档

日期：2026-10-10
状态：已确认
前置：v1-v6 已合并入 main（v6 扫码快传 96/96 测试）

## 1. 概述

用户可自选剪贴板数据的存储目录（如从系统盘 C: 换到 D:）。配置 `dataDir` 存入 config.json；切换后新位置从零开始记录（或沿用该目录已有的 clipboard.db），旧位置数据原地不动。切换经应用自动重启生效。

## 2. 需求确认

| 决策项 | 结论 |
|---|---|
| 动机 | 本机换盘/换目录（非同步场景） |
| 迁移语义 | 只切换，不搬数据；旧库原地保留 |
| 目标已有 clipboard.db | 直接沿用（切回默认位置时 userData 旧库也沿用，历史接着用） |
| 生效方式 | 写配置 → app.relaunch() 自动重启（不做运行中热替换） |
| 入口 | 托盘菜单「存储位置…」+ 当前路径常驻显示 |

## 3. 架构

### 3.1 配置层（privacyConfig.js 扩展）

- config.json 新增 `dataDir: string | null`；`null` = 默认（userData）
- `getDataDir()`：返回归一化后的绝对路径或 null（空串/undefined 归一为 null）
- `setDataDir(dir | null)`：校验为字符串才写入；null 表示恢复默认

### 3.2 启动路径解析（index.js + 纯函数 resolveDataPaths）

新模块 `src/main/storagePath.js`：

- `resolveDataPaths(userDataDir, dataDir)` → `{ dbPath, imagesDir, effectiveDir }`
  - dataDir 为 null → `{ dbPath: userData/clipboard.db, imagesDir: userData/images, effectiveDir: userData }`
  - 否则 → `{ dbPath: dataDir/clipboard.db, imagesDir: dataDir/images, effectiveDir: dataDir }`
  - 归一：去掉尾部路径分隔符；相对路径不予拒绝（path.resolve 成绝对）
- `probeWritable(dir)`：尝试创建目录（不存在时）+ 写删探针文件，返回 { ok } 或 { ok:false, error }

### 3.3 托盘与切换流程（index.js）

托盘菜单「开机自启」之后新增：

- 常驻项 `存储位置：<实际生效路径>`（enabled: false，灰显）——显示启动时 resolveDataPaths 的生效结果（含 §3.4 回退后的默认路径），而非配置原值
- 「更改存储位置…」：click → `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`
  - 用户取消 → 无操作
  - 选中后 `probeWritable` 失败 → `dialog.showErrorBox('无法使用该目录', <原因>)`，不切换
  - 成功 → `privacyConfig.setDataDir(dir)` → `app.relaunch(); app.exit(0)`
- 「恢复默认位置」：setDataDir(null) + relaunch（仅在当前非默认时显示，或总是显示——简化为总是显示）

### 3.4 启动容错（index.js）

`app.whenReady` 现有 store 初始化改为：先 `resolveDataPaths`，若自定义目录建库抛错（只读盘满等）→ 控制台报错并回退 userData 默认路径建库（应用照常可用，托盘显示的实际生效路径）。

### 3.5 其他引用点

- README「数据位置」章节补充自定义说明
- 仅托盘入口；主窗口不加设置 UI（YAGNI）

## 4. 错误处理

| 场景 | 处理 |
|---|---|
| 选中目录不可写 | 提示错误框，保持原位置 |
| 自定义目录建库失败 | 启动回退默认路径 + 控制台报错 |
| relaunch 失败 | 用户下次手动启动同样生效（配置已写盘） |
| 目标目录已有 clipboard.db | 直接沿用（better-sqlite3 migrate 会校验/补 schema） |

## 5. 测试策略

- privacyConfig：getDataDir/setDataDir 归一（null/空串/合法路径）、与 pet 字段互不覆盖
- resolveDataPaths：默认/自定义/尾斜杠/相对路径四类
- probeWritable：正常目录 / 只读目录（chmod 0o555，POSIX）/ 文件路径当目录
- 渲染层无测试（惯例）；冒烟 = 切换 → 重启 → 验证 + 切回 → 沿用旧库

## 6. 不做（YAGNI）

- 数据迁移/搬运、多位置共存、按容量自动轮转
- 网络盘/同步盘检测与警告
- 主窗口设置页
