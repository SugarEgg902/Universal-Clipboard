# 剪贴板抽屉柜 (Clipboard Drawer)

跨平台（macOS / Windows / Linux）剪贴板历史工具。以"抽屉柜"形式展示剪贴板历史：左侧为最近 7 个日期的抽屉，点击抽屉右侧展示当天复制的所有文本。

## 功能

- 常驻系统托盘，按 `Cmd/Ctrl+Shift+V` 全局唤起
- 最近 7 天日期抽屉，显示每天条数
- 点击文本重新复制到剪贴板
- 图片剪贴板自动存档（截图/复制图片，>10MB 跳过），行内缩略图，点击复制图片
- 跨全部历史搜索（不限 7 天），按日期分组
- 删除单条 / 清空当天；同一天相同文本自动去重
- 数据存于本地 SQLite（`userData/clipboard.db`），永久保留
- 深色/浅色跟随系统；失去焦点自动隐藏

## 快捷键

- `Cmd/Ctrl+Shift+V` 全局唤起窗口
- `↑` / `↓` 选择条目，`Enter` 复制选中条目
- `Cmd/Ctrl+K` 聚焦搜索框
- `Esc` 清空搜索（有搜索词时）或隐藏窗口

## 开发

```bash
npm install        # 安装依赖（postinstall 自动重编译 better-sqlite3）
npm test           # 运行单元测试（node:test）
npm start          # 启动应用
```

## 打包

```bash
npm run pack       # 免安装目录（dist/）
npm run dist       # 完整安装包（mac: dmg / win: nsis / linux: AppImage）
```

## 数据位置

- macOS: `~/Library/Application Support/clipboard-drawer/clipboard.db`
- Windows: `%APPDATA%/clipboard-drawer/clipboard.db`
- Linux: `~/.config/clipboard-drawer/clipboard.db`
