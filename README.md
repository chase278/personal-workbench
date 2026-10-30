# 个人工作台（Personal Workbench）

一个**零构建、单文件**的本地个人工作台：把备忘录、周计划、月计划、共享文件和一键周报收纳在一页里，数据本地优先、可跨设备同步到腾讯云 COS。

打开 `index.html` 就能用，没有框架、没有打包、没有依赖安装。

---

## 一、功能一览

### 1. 个人资料卡
姓名 / 英文名 / 部门 / 岗位，点击「✎ 编辑」随时修改，头像取姓名首字母。

### 2. 工作概览
侧边栏实时统计三个数字：**待办**、**已完成**（含历史归档中的项）、**共享文件**。

### 3. 三合一计划卡（备忘录 / 本周计划 / 本月计划）
顶部 Tab 切换，每类都支持添加、勾选完成、删除：

- 勾选完成时记录 `completedAt` 时间戳（精确到分钟），列表里显示为完成时间标签
- 分为「未完成」和「已完成」两区，已完成项带删除线

### 4. 已完成任务的自动归档与折叠（本周 / 本月）

这是工作台的核心机制，避免「已完成」列表无限膨胀：

| 维度 | 归档时机 | 分组标签 | 归档位置 |
|---|---|---|---|
| 本周计划 | 跨周（每周一 00:00 起算新一周） | `2026-W38`（ISO 周） | 卡片底部「历史归档（按周折叠）」 |
| 本月计划 | 跨月（每月 1 日 00:00 起算新一月） | `2026-09` | 卡片底部「历史归档（按月折叠）」 |

- 打开页面时自动执行，**幂等**——重复刷新不会产生重复归档，从云端同步回旧数据后也会重新归档
- 归档依据是任务的 `completedAt`（而不是刷新时刻）
- 每组独立折叠：组头显示周/月标签、`完成 N 项` 计数、日期区间，点击即可展开收起
- **默认展开最近 2 组**，更早的收起；折叠状态只是页面级 UI 状态，不写入数据、不参与云同步

### 5. 共享工作区
按「板块」组织文件（默认 3 个板块，可新增 / 重命名 / 删除）：

- 选择本地文件加入板块，标记为「待上传」
- 勾选后批量上传到 COS（**预签名 URL 直传，密钥不经过浏览器**）
- 已上传的文件标记「已同步」，勾选框自动变灰避免重复上传
- 支持下载（云端走签名 URL，本地走 objectURL）和删除（本地列表 + 云端对象一起删）
- 每个板块底部显示「N 个待上传 · M 个已同步」

### 6. 数据本地优先 + 云端同步
- 所有操作即时写入浏览器 `localStorage`，断网也照常用
- 改动后 **1.5 秒防抖**推送到云端 `state.json`
- 打开页面时拉取云端状态，**云端更新时间戳更新则覆盖本地**（last-write-wins）

### 7. 周报中心（「本月计划」右侧 · 共享工作区「板块二」上方）

一个 2×2 的方形模块，四个动作：

- **一键生成周报**：汇总本周（周一 00:00 至周日 23:59）在备忘录 / 本周计划 / 本月计划中勾选完成的任务，调用模型整理成 `序号. 项目名称/姓名：项目内容，我做的工作`
- **同步学习风格**：取数据库最近 5 篇历史周报，让模型归纳出 300 字以内的「写作风格指南」，此后生成时自动套用（可用「生成时使用历史风格」开关关闭）
- **导入 Word / Excel**：支持 `.docx` / `.xlsx` / `.txt` / `.md`，**浏览器内本地解析，文件不上传**；导入成功后自动打开数据库展示解析结果
- **周报数据库**：生成与导入的周报统一保存，可查看 / 删除，随 `state.json` 一起云同步

导入解析零依赖：自行读取 ZIP 的 EOCD / 中央目录 / 局部头，用浏览器原生 `DecompressionStream("deflate-raw")` 解压；docx 解析 `word/document.xml`，xlsx 解析 `sharedStrings.xml` 与 `worksheets/sheetN.xml`。

### 8. 模型与云同步配置（侧边栏）

- **模型配置**：接口地址 / 模型名称 / API Key（👁 可切换显示隐藏），带「测试连接」——用一条极短输入真实请求一次 `/chat/completions`，返回耗时与模型回复，失败显示具体错误（401 / 模型不存在 / 跨域等）
- **云同步配置**：签名服务地址 + `SecretId` / `SecretKey` / `Bucket` / `Region`，可直接在网页填写，由本地服务写入 `cos-server/.cos-config.json`（权限 600，已 gitignore），**换设备只需填一次**；另有「测试连接」「立即同步」

---

## 二、技术架构

### 总体结构

```mermaid
flowchart LR
    subgraph B["浏览器 · index.html（file:// 直接打开）"]
        UI["界面与交互<br/>原生 JS"]
        LS[("localStorage<br/>workbench_state_v1")]
        UI <--> LS
    end

    subgraph S["本机 cos-server · Node 原生 http"]
        SIGN["/api/sign-*<br/>签发预签名 URL"]
        STATE["/api/state<br/>状态读写"]
        CONFIG["/api/config*<br/>网页端配置 COS 密钥"]
    end

    COS[("腾讯云 COS 私有桶<br/>workbench/state.json<br/>workbench/&lt;板块&gt;/文件")]
    LLM["LLM API<br/>OpenAI 兼容 /chat/completions"]

    UI -- "fetch localhost:3456" --> SIGN
    UI -- "fetch localhost:3456" --> STATE
    UI -- "fetch localhost:3456" --> CONFIG
    SIGN -- "SecretId / SecretKey" --> COS
    STATE --> COS
    UI -- "PUT 直传文件二进制" --> COS
    UI -- "生成周报 / 学习风格" --> LLM
```

### 设计要点

- **密钥永不下发前端**：浏览器只拿得到「10 分钟有效的预签名 URL」，`SecretId` / `SecretKey` 只在本地 Node 进程里，来源为环境变量 `.env` 或网页端写入的 `.cos-config.json`（二者都不进 git）
- **前端零依赖**：`index.html` 单文件承载全部 HTML + CSS + JS，不引入任何框架或 CDN 资源，双击即用、断网可用；Word / Excel 解析也由自实现的 ZIP 读取 + 原生 `DecompressionStream` 完成
- **服务端零框架**：只用 Node 内置 `http` / `url` / `path` 模块，唯一的第三方依赖是 `cos-nodejs-sdk-v5`
- **降级友好**：未配置 `.env` 时服务以「开发模式」启动，接口照常响应但签名返回 mock 地址，前端可独立调试

### 技术选型

| 层 | 选型 | 原因 |
|---|---|---|
| 前端 | 原生 JS + CSS 变量 | 单文件分发，无构建链，改完刷新即生效 |
| 本地存储 | localStorage | 本地优先，无后端也能用 |
| 云同步 | COS `state.json` | 已有 COS 桶可直接复用；last-write-wins 足够简单 |
| 文件存储 | COS 私有桶 + 预签名 URL | 前端不接触密钥，私有桶也能安全上传下载 |
| 服务端 | Node 内置 `http` | 需求只有几个接口，引入框架反而增加维护面 |

### 目录结构

```
personal-workbench/
├── index.html              # 单文件前端：界面 + 样式 + 逻辑（含周报生成与文件解析）
├── cos-server/
│   ├── server.js           # 本地服务（签发 URL / 状态同步 / 文件删除 / 网页端配置）
│   ├── package.json        # 唯一依赖：cos-nodejs-sdk-v5
│   ├── .env.example        # 配置模板（复制为 .env 后填密钥，可选）
│   └── .gitignore          # 排除 .env / .cos-config.json / server.log / node_modules
└── README.md
```

### 服务端接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查，返回 `{ ok: true }` |
| GET | `/api/config` | 查看 COS 配置状态（密钥脱敏，不回传明文） |
| POST | `/api/config` | 保存 COS 配置到 `.cos-config.json`，立即生效 |
| GET | `/api/config/test` | 测试 COS 连接（仅 `NoSuchKey` 视为鉴权通过） |
| POST | `/api/config/reset` | 清除网页端保存的配置，回到环境变量 / 开发模式 |
| GET / POST | `/api/sign-upload?filename=&folder=` | 签发预签名 **PUT** URL（10 分钟有效），供前端直传 |
| GET | `/api/sign-download?key=` | 签发预签名 **GET** URL，私有桶下载 |
| GET / POST | `/api/delete?key=` | 删除 COS 对象 |
| GET | `/api/state` | 读取云端 `state.json`，不存在返回 `null` |
| POST / PUT | `/api/state` | 写入云端 `state.json` |

所有接口带 CORS 头，允许 `file://` 页面直接调用。服务默认只监听 `127.0.0.1`，可用 `HOST=0.0.0.0` 覆盖。

### 数据模型

```jsonc
{
  "profile": { "name": "", "en": "", "dept": "", "job": "" },
  "tasks": {
    "memo":  { "active": [], "done": [] },
    "week":  {
      "active": [], "done": [],
      "history": [                       // 自动归档（按周）
        { "label": "2026-W38", "start": 1757520000000,
          "items": [ { "id": "…", "text": "…", "completedAt": 1757500000000 } ] }
      ]
    },
    "month": { "active": [], "done": [], "history": [] }   // 自动归档（按月）
  },
  "boards": [
    { "id": "b1", "name": "板块一",
      "files": [ { "id": "…", "name": "报告.pdf", "size": 102400,
                   "serverUploaded": true, "objectKey": "workbench/b1/…" } ] }
  ],
  "reports": [                        // 周报数据库（最多 40 篇，单篇最多 8000 字）
    { "id": "…", "title": "周报 · 2026 年第 44 周",
      "content": "1. 项目A/张三：…，我负责…",
      "createdAt": 1757500000000,
      "source": "generated",          // generated | imported
      "fileName": "" }                // 导入时记录源文件名
  ],
  "reportStyle": {                    // 已学习的周报风格
    "profile": "结构：编号列表；句式：…；语气：…",
    "updatedAt": 1757500000000,
    "sampleCount": 5
  },
  "updatedAt": 1757500000000          // 云同步用的版本时间戳
}
```

浏览器本地键：`workbench_state_v1`（主数据）、`workbench_last`（最后修改时间）、`workbench_lastpush`（最后推送时间）、`workbench_llm_cfg_v1`（模型配置）、`workbench_cloud_cfg_v1`（签名服务地址）。

---

## 三、快速开始

### 1. 安装依赖

```bash
cd cos-server
npm install
```

### 2. 配置密钥（二选一，换设备推荐方式 A）

**方式 A：直接在网页里填**

跳过这一步，先完成第 3 步启动服务，然后在工作台左侧「云同步配置」填写 `SecretId` / `SecretKey` / `Bucket` / `Region`，点「保存并连接」。服务会把配置写入 `cos-server/.cos-config.json`（权限 600），重启后自动加载。换设备时只需把这四项再填一次。

**方式 B：用 .env 文件**

```bash
cp .env.example .env
# 编辑 .env，填入 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET
```

`.env` 与 `.cos-config.json` 都已在 `.gitignore` 中排除，代码里不保存任何密钥。
优先级：环境变量(.env) > `.cos-config.json` > 开发模式。

### 3. 启动服务

需 Node ≥ 20.6（`--env-file` 的版本要求）：

```bash
cd cos-server
node --env-file=.env server.js      # 用 .env 方式
# 或
node server.js                      # 用网页端配置方式
```

启动成功会打印 `✔ 已配置 COS 密钥（来源: env / file），签名接口将对接桶 …`。
若显示「未配置」，说明密钥还没填——此时接口可用，但签名返回 mock 地址，不会真正上传。

> 想双击启动的话，可以在工作台目录放一个 `.command` 脚本，内容为
> `cd cos-server && node --env-file=.env server.js`，再 `chmod +x` 即可。

### 4. 打开工作台

浏览器打开 `index.html` 即可。建议固定用同一个浏览器（数据在 localStorage，换浏览器相当于换一份本地数据，云端同步会把数据拉回来）。

### 5. 配置模型（一键生成周报用）

左侧「模型配置」填写接口地址（需兼容 OpenAI `/chat/completions`）、模型名称、API Key，点「测试连接」确认可用。配置只存在本机 localStorage，不会上传。

---

## 四、安全说明

- `index.html` 中**不含任何密钥**，`server.js` 也不含——密钥只来自 `.env` 或网页端写入的 `.cos-config.json`（二者都已 gitignore）
- 上游仓库中所有敏感值均已替换为占位符，请使用自己的密钥对
- 服务默认只监听 `127.0.0.1`，且**没有鉴权**：如用 `HOST=0.0.0.0` 暴露到局域网请谨慎，切勿部署到公网
- `/api/config` 会接收网页提交的密钥，只有在本机可达的前提下才是安全的
- 若你的密钥曾以明文形式出现在代码、聊天记录或备份中，建议到腾讯云控制台【访问管理 > API 密钥管理】轮换一次

---

## 五、已知限制与后续规划

**限制**
- 文件二进制不落 localStorage：刷新后「待上传」的本地文件需要重新选择（已上传到 COS 的不受影响）
- 云同步为 last-write-wins，多设备同时编辑可能互相覆盖，不适合高频并发场景
- 周报数据库单篇最多 8000 字、最多 40 篇（控制 `state.json` 体积，服务端上限 2 MB）
- 仅支持 `.docx` / `.xlsx`，旧版 `.doc` / `.xls` 需另存为新格式再导入
- 模型请求由浏览器直接发出，若接口未开放 CORS 会失败，需改用支持跨域的接口或经本地代理访问

**规划**
- 月报生成、周报一键导出为 Word / PDF
- 模型请求改由 `cos-server` 代理（密钥同样走 `.env`），彻底规避跨域与前端持钥
