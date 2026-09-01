/**
 * cos-server.js —— 本地 COS 签名服务（第二阶段：工作台网页内直传）
 *
 * 作用：持有你的 SecretId/SecretKey，为工作台网页签发"预签名 PUT URL"。
 * 工作台拿到这个 URL 后直接上传文件到 COS，全程不把密钥暴露给页面。
 *
 * 启动：node server.js
 * 配置：先填下面 5 个常量（或用环境变量）。
 */
const http = require('http');
const url = require('url');
const path = require('path');

/* ================= 配置区（你自己填写/或用环境变量） ================= */
// 方式1：直接填在下面（仅本地开发用，不要把本文件提交到公网仓库）
const SECRET_ID = process.env.COS_SECRET_ID || 'YOUR_SECRET_ID_HERE';    // TODO: set COS_SECRET_ID env var or replace placeholder
const SECRET_KEY = process.env.COS_SECRET_KEY || 'YOUR_SECRET_KEY_HERE'; // TODO: set COS_SECRET_KEY env var or replace placeholder
const BUCKET = process.env.COS_BUCKET || 'your-bucket-name';             // TODO: set COS_BUCKET env var or replace placeholder
const REGION = process.env.COS_REGION || 'ap-guangzhou';                 // TODO: set COS_REGION env var or replace placeholder
const BASE_PATH = process.env.COS_BASE_PATH || 'workbench';           // 上传到什么目录
const PORT = Number(process.env.PORT || 3456);                        // 签名服务端口
/* ==================================================================== */

if (SECRET_ID.indexOf('YOUR_SECRET_ID_HERE') >= 0 || SECRET_KEY.indexOf('YOUR_SECRET_KEY_HERE') >= 0) {
  // 开发模式：未填密钥时可跑通路由框架，但返回 mock 结果（方便先调试前端）
  console.warn('[开发模式] 未配置真实密钥，签名接口将返回 mock 地址（不真正上传到COS）。');
  console.warn('  要真正上传，请在控制台拿 SecretId/SecretKey 后填到顶部或设环境变量。');
  const mockCos = {
    getPresignedUrl: (opts, cb) => cb(null, { Url: `http://127.0.0.1:${PORT}/${opts.Key}?mock=1` })
  };
  var cos = mockCos;
  var IS_MOCK = true;
} else {
  const COS = require('cos-nodejs-sdk-v5');
  var cos = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY });
  var IS_MOCK = false;
  console.log('✔ 已配置真实密钥，签名接口将真正对接 COS 桶 ' + BUCKET);
}

// CORS 响应头（允许工作台跨域调用）
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Origin,Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

// 生成预签名 PUT URL（上传）
function generatePutUrl(objectKey) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Method: 'PUT',
      Bucket: BUCKET,
      Region: REGION,
      Key: objectKey,
      Sign: true,        // 生成带签名的预签名 URL
      Expires: 600       // 10 分钟有效
    }, (err, data) => {
      if (err) return reject(err);
      resolve(data.Url);
    });
  });
}

// 生成预签名 GET（下载）URL
function generateGetUrl(objectKey) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Method: 'GET',
      Bucket: BUCKET,
      Region: REGION,
      Key: objectKey,
      Sign: true,
      Expires: 600
    }, (err, data) => {
      if (err) return reject(err);
      resolve(data.Url);
    });
  });
}

// --- 工作台状态同步：读写 COS 里的 state.json ---
const STATE_KEY = BASE_PATH + '/state.json';

// 读 state.json（不存在返回 null）
function readState() {
  return new Promise((resolve, reject) => {
    cos.getObject({ Bucket: BUCKET, Region: REGION, Key: STATE_KEY }, (err, data) => {
      if (err) {
        if (err.statusCode === 404 || err.code === 'NoSuchKey') return resolve(null);
        return reject(err);
      }
      try {
        resolve(JSON.parse(data.Body.toString('utf8')));
      } catch (e) {
        reject(new Error('state.json 解析失败: ' + e.message));
      }
    });
  });
}

// 写 state.json
function writeState(stateObj) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: BUCKET, Region: REGION, Key: STATE_KEY,
      Body: JSON.stringify(stateObj, null, 2),
      ContentType: 'application/json; charset=utf-8'
    }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// 删除 COS 里的对象
function deleteObject(objectKey) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket: BUCKET, Region: REGION, Key: objectKey }, (err) => {
      // 注意：删除不存在的对象，COS 通常也返回成功(204)，不视为错误
      if (err) return reject(err);
      resolve();
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 健康检查
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, service: 'cos-sign-server' }));
    return;
  }

  // 签发预签名 URL：GET/POST /api/sign-upload?filename=xxx.png&folder=board1
  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/sign-upload') {
    const filename = parsed.query.filename || '';
    const folder = parsed.query.folder || 'default';
    if (!filename) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: '缺少 filename 参数' }));
      return;
    }

    // 清理文件名避免路径穿越，拼 objectKey
    const safeName = path.basename(String(filename)).replace(/[\\/:*?"<>|]/g, '_');
    const objectKey = `${BASE_PATH}/${folder || 'default'}/${Date.now()}-${safeName}`;

    try {
      const presignedUrl = await generatePutUrl(objectKey);
      // 同时返回 objectKey 和可下载的公开/私有读取地址（私有访问直接走/用COS临时配置）
      // 注意：私有桶无法直接公开访问，这里仅回传 objectKey 便于后续管理
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        uploadUrl: presignedUrl,   // 用于 PUT 上传
        objectKey,                  // 后台记录用
        done: true
      }));
    } catch (e) {
      console.error('签名失败:', e);
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  // 签发预签名下载 URL：GET /api/sign-download?key=workbench/xxx
  if ((req.method === 'GET') && pathname === '/api/sign-download') {
    const objectKey = parsed.query.key || '';
    if (!objectKey) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: '缺少 key 参数' }));
      return;
    }
    try {
      const presignedUrl = await generateGetUrl(objectKey);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, downloadUrl: presignedUrl }));
    } catch (e) {
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  // 删除 COS 对象：GET /api/delete?key=workbench/xxx （供工作区"删除文件=同步删云端"）
  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/delete') {
    const objectKey = parsed.query.key || '';
    if (!objectKey) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: '缺少 key 参数' }));
      return;
    }
    try {
      await deleteObject(objectKey);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, deleted: objectKey }));
    } catch (e) {
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  // 工作台状态同步：GET 读 state.json / POST 写 state.json
  if (pathname === '/api/state') {
    if (req.method === 'GET') {
      try {
        const st = await readState();
        res.writeHead(200, corsHeaders());
        res.end(st ? JSON.stringify({ ok: true, state: st }) : JSON.stringify({ ok: true, state: null }));
      } catch (e) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      }
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const obj = JSON.parse(body);
          await writeState(obj);
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, saved: true }));
        } catch (e) {
          res.writeHead(500, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
        }
      });
      return;
    }
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`✔ COS 签名服务已启动: http://localhost:${PORT}`);
  console.log(`  测试: curl "http://localhost:${PORT}/health"`);
  console.log(`  签名接口: GET http://localhost:${PORT}/api/sign-upload?filename=test.txt&folder=board1`);
});