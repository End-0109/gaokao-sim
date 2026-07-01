# 陕西省高考志愿模拟填报系统

模拟陕西省 2025 年高职（专科）批次志愿填报流程。提供院校代码输入、专业组选择、专业填报、保存/确认等功能。

## 技术栈

- Node.js + Express
- sql.js（纯 JS SQLite，无需原生编译）
- 纯 HTML/CSS/JavaScript 前端
- express-session 用户登录

## 本地运行

```bash
npm install
npm start
```

默认端口 3000。首次启动会自动创建 `data.db` 并初始化院校数据。

## 部署到 Railway

1. 将代码 push 到 GitHub
2. Railway 关联该仓库
3. 启动命令：`npm start`
4. 环境变量：
   - `PORT` = 3000（Railway 会自动设置）
   - `SESSION_SECRET` = 任意长字符串
5. 部署完成后在 Settings → Networking 生成公网域名

## 默认管理员

管理员密码在 `data.db` 初始化时生成，见 `init-db.js` 末尾。

## 免责声明

本系统为模拟练习工具，所有数据均为模拟生成，与陕西省教育考试院无关。正式填报请以官方为准。
