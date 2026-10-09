# 剪贴板抽屉柜：Me-Search（强化字面搜索）设计文档

日期：2026-10-09
状态：已确认
前置：v1 基础版、v2 图片+键盘导航（main）、v3 片段库+隐私安全区（feature/snippets-privacy，60/60 测试）

## 1. 概述

把主窗口搜索框从"SQL LIKE 子串匹配"升级为 **Me-Search** 引擎：用户记得"大概写法"或"读音"都能捞回历史条目，评分排序平铺呈现。定位叙事：从"剪贴板管理工具"升级为"搜索过去的自己"。

本轮明确**不做**：语义/向量搜索、正则模式、字段加权排序、图片 OCR、独立搜索窗口——保留给后续里程碑。

## 2. 需求确认

| 决策项 | 结论 |
|---|---|
| 搜索层级 | 强化字面搜索（模糊子序列 + 拼音），无模型无向量 |
| 入口形态 | 只升级主窗口搜索框，不新增窗口/热键 |
| 搜索范围 | 仅文本行（含片段）；图片行不进搜索（保持现状） |
| 匹配能力 | 模糊子序列匹配 + 拼音搜索（多选确认）；不做正则、不做字段加权 |
| 结果呈现 | 评分排序平铺列表（不再按日期分组），子串命中高亮，拼音/模糊命中加徽章 |

## 3. 引擎设计

### 3.1 拼音物化（写时索引）

- 新依赖：`pinyin-pro`（纯 JS、无词库文件、无模型，主进程 require）。
- 迁移：`ALTER TABLE clips ADD COLUMN pinyin TEXT`（沿用 `PRAGMA table_info` 门控惯例）。
- 入库时：文本行生成**连续、无音调、小写**拼音存 `pinyin` 列（"收货地址" → `shouhuodizhi`）。纯 ASCII 文本不生成（存 NULL，省空间省时间）。
- 存量回填：迁移时对 `pinyin IS NULL AND type='text'` 且含 CJK 字符的行一次性回填（边界：DB 极大时可能耗时数秒，可接受，迁移只跑一次）。

### 3.2 两阶段查询

```js
search(keyword):
  kw = trim(keyword); if (!kw) return []
  candidates = SQL(text LIKE '%kw%' OR (isRoman(kw) AND pinyin LIKE '%kw%'))   // 快路径
  results = scoreAndRank(candidates, kw)          // match_kind: substring / pinyin
  if (results.length < 20 && kw.length >= 3):
    fuzzy = subsequenceScan(recent 5000 text rows 排除已有命中, kw)  // match_kind: fuzzy
    results = merge(results, fuzzy)
  return top 50 (rows + score + match_kind + match_pos/match_len[仅 substring])
```

- `isRoman`：查询仅由 `[a-z0-9]` 构成才启用拼音路径（中文查询走 text LIKE + 模糊）。
- 模糊兜底只扫**最近 5000 条文本行**（有界，防大库卡顿）；子序列匹配 = 查询字符按序出现即命中，跨度越小分越高。
- 评分（纯函数 `scoreRow(row, kw)`，可单测）：
  - 连续子串命中：100 基分，越早出现越高；
  - 拼音列子串命中：90 基分（罗马查询时）；
  - 模糊子序列：80 基分减去跨度惩罚；
  - 同分 tie-breaker：`created_at` 新者优先。
- 短查询（<2 字符）走原有 LIKE 行为（兼容现状，评分也套用 substring 档）。

### 3.3 match_kind 与元数据

IPC `clipboard:search` 签名不变，返回行附加：
- `score: number`
- `match_kind: 'substring' | 'pinyin' | 'fuzzy'`
- `match_pos` / `match_len`：仅 `substring` 档有值（渲染高亮用）；拼音/模糊命中为 null，渲染层不强行映射回原文字符串。

## 4. 渲染层变更

- `doSearch` 改平铺：按 IPC 返回顺序（已评分排序）逐行渲染，**去掉按日期分组**；标题 `搜索“kw” · N 条` 不变。
- 高亮：`substring` 命中用 `<mark>` 包裹 `text[match_pos:match_pos+match_len]`（注意 XSS——用 textContent 分段构造，不拼 innerHTML）。
- 徽章：`pinyin`/`fuzzy` 命中行尾加灰字小徽章「拼音命中」/「模糊命中」。
- 密码行：照常可被搜到（匹配基于真实文本），展示仍 `••••••••` 打码 + 显示切换（v3 行为不变）；`match_pos` 对打码行不渲染高亮。
- 防抖：搜索输入 150ms 防抖后再发 IPC；清空/上档选择等其他现有交互不变。
- 片段视图、日期抽屉不受影响。

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 查询含空格 | trim 后按整体串匹配（现状如此，不变） |
| 查询 <2 字符 | 原 LIKE 行为，子串档评分 |
| 非罗马字符查询 | 不启用拼音 SQL 路径 |
| 快路径 ≥20 条 | 跳过模糊兜底（性能优先） |
| 空结果 | 保留现有"没有匹配的记录"空态 |
| 旧库无 pinyin 列 | 迁移 + 回填自动完成 |
| pinyin-pro 对某字无读音 | 跳过该字（降级为部分拼音），不报错 |

## 6. 测试策略

- store：拼音物化（中文/英文/混合/多音字降级）、存量回填、search 三档排序（substring > pinyin > fuzzy，同分新者先）、模糊兜底触发与边界（<20 条、≥3 字符、5000 行窗口）、LIKE 通配符转义回归（保留 v2 行为）、密码行可搜且 secret 标记不丢。
- 引擎纯函数：scoreRow/subsequence 匹配各分支单测。
- 渲染层无自动化测试（惯例）：门 = `node --check` + 全量不回归 + 冒烟手动验证。
- 冒烟：Pin 一条"收货地址"片段 → 搜 "shouhuodizhi" 命中（拼音徽章）；搜错拼 "clipbard" 命中历史 clipboard 行（模糊徽章）；子串命中出现高亮。

## 7. 不做（YAGNI）

- 语义/向量搜索、本地 embedding（v4.1+ 候选）
- 正则模式、字段加权排序
- 图片 OCR 可搜
- 独立全局搜索窗口 /  Alfred-Raycast 式 launcher
- 搜索历史、热门搜索建议
