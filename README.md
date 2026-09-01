# 个人工作台（脱敏副本）

此副本已移除敏感信息，可在新设备上继续部署使用。

## 文件说明

- `index.html`：个人工作台前端页面，数据默认保存在浏览器 localStorage，支持通过本地签名服务同步到腾讯云 COS。
- `cos-server/server.js`：本地 COS 签名服务，负责签发预签名 URL，前端不直接暴露密钥。
- `cos-server/package.json`：Node.js 依赖描述。

## 在新设备上启动

1. 安装 Node.js 依赖
   ```bash
   cd cos-server
   npm install
   ```

2. 配置腾讯云 COS 密钥（三选一）
   - 编辑 `cos-server/server.js` 顶部的 `SECRET_ID`、`SECRET_KEY`、`BUCKET`、`REGION`。
   - 或设置环境变量：
     ```bash
     export COS_SECRET_ID=你的SecretId
     export COS_SECRET_KEY=你的SecretKey
     export COS_BUCKET=你的bucket名
     export COS_REGION=你的地域
     ```
   - 建议使用环境变量，避免密钥写入文件。

3. 启动签名服务
   ```bash
   npm start
   # 或
   node server.js
   ```

4. 用浏览器打开 `index.html` 即可使用。

## 安全提醒

- 本副本中的 `server.js` 已抹去原 SecretId、SecretKey 和 Bucket 名，请使用新的密钥对进行配置。
- 如果原密钥已经泄漏（例如曾随文件发送或上传），请立即到腾讯云控制台【访问管理 > API 密钥管理】中禁用或删除该密钥，并创建新密钥。
