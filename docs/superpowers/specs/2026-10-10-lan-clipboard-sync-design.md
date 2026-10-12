# 剪贴板抽屉柜：局域网共享剪贴板 设计文档

日期：2026-10-10
状态：已确认
前置：v1-v7 已合并入 main（v7 自定义存储位置 108/108 测试）

## 1. 概述

局域网内多台机器共享同一剪贴板：一台机器开「主机模式」内嵌常驻 HTTP 服务，其 clipboard.db 即共享数据源；其他机器以「客户端模式」连接主机，复制的内容自动同步到主机并实时推送到所有客户端，各端本地存一份（断网可看历史）。同步内容进各机器正常的 7 天抽屉，界面零改动。

## 2. 需求确认

| 决策项 | 结论 |
|---|---|
| 同步方式 | 实时双向自动同步（复制后数秒内到达其他机器） |
| 拓扑 | 主机-客户端：主机是唯一权威数据源，不做 P2P |
| 设备发现 | 手动输入主机 IP + token 配对（主机托盘显示本机地址） |
| 同步内容 | 文本 + 图片（沿用本地 10MB 上限） |
| 疑似密码 | 照常同步，is_secret 标记随内容传，各端按自己的隐私模式打码；「完全不记录」模式下本端密码不上传 |
| 历史补传 | 不做全量历史迁移，只同步开启后的新内容；断网期间的本地复制在恢复连接后自动补传（幂等去重） |
| 安全模型 | 局域网明文 HTTP + 随机 token 头鉴权（与 v6 同级）；公共网络建议不开主机服务；TLS 证书分发本期不做 |

## 3. 架构

### 3.1 模块

新模块 `src/main/syncserver.js`（主机端）与 `src/main/syncclient.js`（客户端）。两者复用：
- v6 `qrserver.js` 的端口探测（43789-43999 扫第一个空闲端口）与 `lanIp()`
- `src/main/store.js` 的 ClipStore（主机直接写自己的 store；客户端写本地 store）
- `src/main/privacyConfig.js` 的 config.json（新增 `sync` 字段）
- v3 的 `is_secret` 检测（产生端计算）

### 3.2 设备与配对

- 每台设备持久 `deviceId`（uuid，存 config.json `sync.deviceId`，首次生成）
- 主机托盘「共享剪贴板服务：开启」→ 探测端口 + 取 lanIp，托盘显示「本机地址：IP:端口」；token 持久化（重启不变）
- 主机「重新生成配对码」→ 换 token（旧客户端断开需重连）
- 客户端托盘「连接主机…」→ 输入 IP:端口 + token → 校验通过写 config 并长连

### 3.3 主机端（syncserver.js）

- `http.createServer`，绑定 **lanIp()**（非 0.0.0.0），端口由探测得到
- 鉴权：所有端点校验 `Authorization: Bearer <token>`，不匹配 401（health 端点也要求 token）
- 路由：
  - `GET /health` → `{ ok, deviceId, version }`
  - `POST /clip`（JSON）→ 文本条目：`{ text, is_secret, originDeviceId, originId, ts }`；Content-Length ≤ 1MB，超限 413
  - `POST /clip-image`（octet-stream，头 `X-Meta: JSON{is_secret, originDeviceId, originId, ext}`）→ 图片 ≤ 10MB，超限 413；文件名由主机生成（自增 id + ext），**不接受客户端路径**
  - `GET /image/<id>` → 图片二进制（供客户端按需拉取）
  - `GET /items?since=<seq>&limit=200` → 断线补拉：seq 大于 since 的条目（元数据）
  - `GET /events`（SSE）→ 实时推送：每条 `data: { seq, kind: 'text'|'image', text?, imageId?, is_secret, originDeviceId, originId, day }`；心跳注释 `:ping` 每 25s
- **seq**：主机维护单调递增序号（启动时从 db 现有条目数/最大 seq 恢复），每条入库内容分配 seq 并持久记录
- **幂等去重**：db 对 `(originDeviceId, originId)` 建唯一索引；重复 POST 返回已有条目（200 + 同 seq），不重复入库
- 广播：入库并提交后向所有 SSE 连接写事件；**100ms 防抖合并**连续多条；主机自己 watcher 产生的内容同样走「入库→广播」路径
- 连接管理：req close 清理、进程退出 closeAllConnections；SSE 连接数上限（如 16），超限拒绝
- 请求体整体大小上限（按 Content-Length 提前拒绝）+ JSON 解析 try/catch → 400

### 3.4 客户端（syncclient.js）

- 连接：`GET /health` 校验 token → `GET /items?since=lastSeq` 补拉 → `GET /events` 长连
- 收到文本条目 → 写本地 store（`source='remote'`，**按内容去重**——同日相同文本不重复入库，沿用现有去重逻辑）
- 收到图片条目 → `GET /image/<id>` 拉二进制 → 存本地 images 目录 → 写本地 store
- `lastSeq` 持久化（config.json `sync.lastSeq`），每条成功写入后更新
- **store 迁移**：主机与客户端的本地 clips 表都新增列（沿用 store.js migrate 的 ALTER TABLE 模式）：`source`（'local'|'remote'）、`origin_device_id`、`origin_id`、`host_seq`（客户端记录该条对应的主机 seq）。主机端 `(origin_device_id, origin_id)` 唯一索引用于幂等去重；主机自己的本地条目中 origin_device_id = 本机 deviceId、origin_id = 本地行 id
- **补传**：本地 watcher 产生条目时若在线则立即 POST；断网期间的本地条目在恢复连接后按序补传（本地记录未确认的 originId 队列；成功以主机返回的 seq 确认）
- **回声抑制**：收到广播/补拉条目时 `originDeviceId === 本机 deviceId` → 跳过（视为自己的内容回来）；本地 store 写入时 `source='remote'` 的条目不触发上传（watcher 只对本地产生的内容上传）
- 掉线重连：指数退避（1s → 2s → … → 30s 封顶），托盘状态显示「已断开，重连中…」

### 3.5 隐私

- is_secret 由**产生端**计算并随内容传输，主机与各客户端直接信任该标记按本端 privacyMode 打码（配对设备即信任模型）
- 本端「完全不记录」模式：watcher 跳过的不入库也不上传
- 错误响应不回显文件路径/token

### 3.6 配置（privacyConfig.js 扩展）

config.json 新增 `sync` 字段：
```json
"sync": {
  "role": null | "host" | "client",
  "token": null | "<随机串>",
  "hostIp": null | "192.168.x.x",
  "hostPort": null | 43789,
  "deviceId": "<uuid>",
  "lastSeq": 0
}
```
同步字段原子写（沿用整体 config 写盘）。隐私模式 DEFAULTS 重置保留 sync（sync 不属于隐私配置，reset 不动它）。

### 3.7 托盘 UI

- 主机：separator + 「共享剪贴板服务：开/关」（checkbox）+ 「本机地址：IP:端口」（灰显，仅开启时）+ 「重新生成配对码」
- 客户端：separator + 「共享剪贴板：连接主机…」/「断开连接」+ 「状态：已连接 / 已断开，重连中…」（灰显）
- 一台机器同时只能是一种角色；切换角色先断开/关闭旧角色

## 4. 错误处理

| 场景 | 处理 |
|---|---|
| token 不匹配 | 401，客户端弹错并保持断开 |
| 请求体超限 | 413，不产生任何写入 |
| 主机端口被占 | 探测下一个空闲端口，托盘显示实际端口 |
| 客户端断网 | 本地照常记录；重连后补拉 + 补传 |
| 主机重启 | seq 从 db 恢复；客户端重连补拉 |
| 重复内容 | 主机按 (deviceId, originId) 幂等；客户端按内容去重 |
| 图片拉取失败 | 记日志，跳过该条，不影响后续 |
| 恶意/故障客户端刷量 | 请求体上限 + SSE 连接数上限；无独立限流（YAGNI） |

## 5. 测试策略

- **纯函数/路由单测**（仿 v6 qrserver 测试模式）：鉴权中间件、大小限制、413/401、幂等去重、seq 分配与恢复、items?since 补拉、SSE 帧格式
- **集成测试**：起真实主机服务 + http 假客户端——POST 文本/图片 → SSE 收到广播；断开 → 新条目 → 补拉拿到；重复 POST 返回同 seq；token 错误 401
- 客户端逻辑（补传队列、回声抑制、退避）以 mock fetch 单测
- 渲染层无测试（惯例）；双机真实环境冒烟由用户手动验证

## 6. 不做（YAGNI）

- 自动发现（UDP 广播/mDNS）、多台主机/主机切换
- TLS/证书交换（信任局域网 + token）
- 全量历史迁移、按天选择性同步
- 在线设备列表 UI、同步速度统计
- 公网穿透/NAT 穿透
