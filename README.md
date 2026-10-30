# 个人工作台 Personal Workbench

一个纯本地的个人工作台：备忘录 / 本周计划 / 本月计划 / 共享文件区 / 一键生成周报，
数据可同步到腾讯云 COS，实现多台设备（Windows / macOS）共用同一份数据。

## 功能

- **备忘录 / 本周计划 / 本月计划**：任务勾选完成，自动记录完成时间并按周 / 月归档
- **共享工作区**：按板块管理文件，勾选后批量上传到 COS，支持云端删除与签名下载
- **一键生成周报**：汇总本周已完成任务，调用大模型整理成「序号. 项目名称/姓名：项目内容，我做的工作」格式
- **大模型配置**：接口地址 / 模型名称 / API Key（支持密码显隐），配置只存在本机浏览器
- **云同步配置**：在网页里直接填写 SecretId / SecretKey / Bucket / Region，保存后写入本地服务，换设备只需填一次
- **状态同步**：工作台数据（含任务、板块、文件元信息）存为 COS 里的 `state.json`

## 文件结构

```
.
├── index.html                 # 工作台页面（前端全部逻辑）
├── cos-server/
│   ├── server.js              # 本地 COS 签名服务
│   ├── package.json           # Node 依赖
│   ├── .env.example           # 环境变量模板
│   └── .gitignore             # 已排除 .env / .cos-config.json
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
cd cos-server
npm install
```

### 2. 启动签名服务

```bash
npm start
```

启动后可访问：`http://127.0.0.1:3456/health`

### 3. 打开工作台

直接用浏览器打开根目录的 `index.html`，或在项目根目录执行：

```bash
python3 -m http.server 8080
```

然后访问 `http://127.0.0.1:8080/index.html`（推荐，可避免部分接口的跨域限制）。

## 配置 COS（两种方式任选其一）

### 方式一：在网页里填（推荐，换设备最省事）

1. 打开工作台，左侧「云同步配置」
2. 填写 **SecretId / SecretKey / Bucket / Region**
3. 点「保存并连接」→ 服务端会写入 `cos-server/.cos-config.json`（已 gitignore，权限 600）
4. 点「测试连接」验证密钥是否正确

换一台设备时，只需要装好依赖、启动服务、打开页面，把这四项再填一次即可，无需改任何代码。

### 方式二：用 .env 文件

```bash
cd cos-server
cp .env.example .env
# 编辑 .env 填入 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
node --env-file=.env server.js
```

> 优先级：环境变量(.env) > `.cos-config.json` > 开发模式(mock)

## 配置大模型（用于一键生成周报）

左侧「大模型配置」填写：

- **接口地址**：需兼容 OpenAI 的 `/chat/completions`，例如 `https://api.deepseek.com/v1`
- **模型名称**：例如 `deepseek-chat`
- **API Key**：支持 👁 按钮切换显示 / 隐藏

配置保存在浏览器 localStorage，不会上传到任何服务器。

## 接口一览（本地签名服务）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/config` | 查看 COS 配置状态（密钥脱敏） |
| POST | `/api/config` | 保存 COS 配置到 `.cos-config.json` |
| GET | `/api/config/test` | 测试 COS 连接 |
| POST | `/api/config/reset` | 清除网页端保存的配置 |
| GET/POST | `/api/sign-upload` | 签发上传预签名 URL |
| GET | `/api/sign-download` | 签发下载预签名 URL |
| GET/POST | `/api/delete` | 删除 COS 对象 |
| GET/POST | `/api/state` | 读写云端 `state.json` |

## 安全说明

- 服务默认只监听 `127.0.0.1`，不对局域网开放。如需局域网访问，设置 `HOST=0.0.0.0`（会带来密钥暴露风险，请谨慎）。
- `.env` 与 `.cos-config.json` 都已在 `.gitignore` 中排除，不会被提交。
- 仓库内的 `server.js` 不包含任何真实密钥，全部通过环境变量或网页端配置注入。
- 如果密钥曾经泄漏，请立即到腾讯云控制台「访问管理 > API 密钥管理」禁用并重新创建。
