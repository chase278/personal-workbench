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
const fs = require('fs');

/* ================= 配置区（全部从环境变量读取） =================
 * 密钥不再写死在代码里，统一放在同目录的 .env 文件中（该文件不进 git）。
 *
 * 启动方式（二选一）：
 *   1) 推荐：双击「启动工作台.command」，它会用 node --env-file=.env 自动注入
 *   2) 手动：cd cos-server && node --env-file=.env server.js
 *
 * 新增配置项时，同步补到 .env（真实值）和 .env.example（模板）里。
 * ================================================================= */
/* 运行期可变配置：环境变量 > 网页端保存的 .cos-config.json > 占位符（开发模式） */
let SECRET_ID = process.env.COS_SECRET_ID || '你的SecretId';
let SECRET_KEY = process.env.COS_SECRET_KEY || '你的SecretKey';
let BUCKET = process.env.COS_BUCKET || '你的Bucket';
let REGION = process.env.COS_REGION || 'ap-guangzhou';
const BASE_PATH = process.env.COS_BASE_PATH || 'workbench';      // 上传到什么目录
const PORT = Number(process.env.PORT || 3456);                   // 签名服务端口
const HOST = process.env.HOST || '127.0.0.1';                    // 默认只监听本机；如需局域网访问设 HOST=0.0.0.0
/* ================================================================ */

/* 网页端「云同步配置」保存的密钥文件（不进 git，权限 600） */
const CONFIG_FILE = path.join(__dirname, '.cos-config.json');
let IS_MOCK = true;
let cos = null;
let CONFIG_SOURCE = 'none';

function isUnset(v) { return !v || String(v).indexOf('你的') >= 0; }
function maskSecretId(id) {
  if (!id) return '';
  if (id.length <= 10) return id.slice(0, 2) + '****';
  return id.slice(0, 6) + '****' + id.slice(-4);
}
function buildCosClient() {
  IS_MOCK = isUnset(SECRET_ID) || isUnset(SECRET_KEY) || isUnset(BUCKET);
  if (IS_MOCK) {
    // 开发模式：未配置密钥时可跑通路由框架，但返回 mock 结果
    cos = {
      getObjectUrl: (opts, cb) => cb(null, { Url: `http://127.0.0.1:${PORT}/${opts.Key}?mock=1` }),
      getObject: (opts, cb) => cb({ statusCode: 404, code: 'NoSuchKey' }),
      putObject: (opts, cb) => cb(null, {}),
      deleteObject: (opts, cb) => cb(null, {}),
      getBucket: (opts, cb) => cb(null, { Contents: [] })
    };
    return;
  }
  const COS = require('cos-nodejs-sdk-v5');
  cos = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY });
}
function loadPersistedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg && cfg.secretId && cfg.secretKey) return cfg;
    }
  } catch (e) { console.warn('[配置] 读取 .cos-config.json 失败:', e.message); }
  return null;
}
function persistConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn('[配置] 写入 .cos-config.json 失败:', e.message);
    return false;
  }
}
function applyConfig(cfg, source) {
  if (cfg && cfg.secretId) SECRET_ID = cfg.secretId;
  if (cfg && cfg.secretKey) SECRET_KEY = cfg.secretKey;
  if (cfg && cfg.bucket) BUCKET = cfg.bucket;
  if (cfg && cfg.region) REGION = cfg.region;
  if (source) CONFIG_SOURCE = source;
  buildCosClient();
}

// 启动时加载：环境变量已配置则优先用环境变量，否则用网页端保存的配置文件
const envConfigured = !isUnset(process.env.COS_SECRET_ID) && !isUnset(process.env.COS_SECRET_KEY) && !isUnset(process.env.COS_BUCKET);
const persistedCfg = loadPersistedConfig();
if (envConfigured) {
  buildCosClient();
  CONFIG_SOURCE = 'env';
} else if (persistedCfg) {
  applyConfig(persistedCfg, 'file');
} else {
  buildCosClient();
  CONFIG_SOURCE = IS_MOCK ? 'none' : 'env';
}

if (IS_MOCK) {
  console.warn('[未配置] 尚未检测到 COS 密钥，签名接口将返回 mock 地址（不真正上传到 COS）。');
  console.warn('  方式一：打开工作台网页，在左侧「云同步配置」填写 SecretId / SecretKey / Bucket 并保存；');
  console.warn('  方式二：在 cos-server/.env 中填写 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET 后重启。');
} else {
  console.log('✔ 已配置 COS 密钥（来源: ' + CONFIG_SOURCE + '），签名接口将对接桶 ' + BUCKET + '（' + REGION + '）');
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

  // 读取当前 COS 配置状态（不回传密钥明文）
  if (req.method === 'GET' && pathname === '/api/config') {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({
      ok: true,
      configured: !IS_MOCK,
      source: CONFIG_SOURCE,
      bucket: IS_MOCK ? '' : BUCKET,
      region: REGION,
      basePath: BASE_PATH,
      secretIdMasked: IS_MOCK ? '' : maskSecretId(SECRET_ID)
    }));
    return;
  }

  // 网页端保存 COS 配置：写入 .cos-config.json 并立即生效
  if ((req.method === 'POST' || req.method === 'PUT') && pathname === '/api/config') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const obj = JSON.parse(body || '{}');
        const cfg = {
          secretId: String(obj.secretId || '').trim(),
          secretKey: String(obj.secretKey || '').trim(),
          bucket: String(obj.bucket || '').trim(),
          region: String(obj.region || 'ap-guangzhou').trim() || 'ap-guangzhou'
        };
        if (!cfg.secretId || !cfg.secretKey || !cfg.bucket) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: 'SecretId / SecretKey / Bucket 均不能为空' }));
          return;
        }
        const persisted = persistConfig(cfg);
        applyConfig(cfg, 'file');
        console.log('✔ 已通过网页端更新 COS 配置，桶 ' + BUCKET + '（' + REGION + '）');
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true, persisted, configured: !IS_MOCK,
          bucket: BUCKET, region: REGION, secretIdMasked: maskSecretId(SECRET_ID)
        }));
      } catch (e) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '配置解析失败: ' + e.message }));
      }
    });
    return;
  }

  // 测试 COS 连接：读 state.json，404 说明鉴权通过只是没有文件
  if (req.method === 'GET' && pathname === '/api/config/test') {
    if (IS_MOCK) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ ok: false, error: '尚未配置 COS 密钥' }));
      return;
    }
    cos.getObject({ Bucket: BUCKET, Region: REGION, Key: STATE_KEY }, (err) => {
      if (err) {
        // 仅当「桶存在、鉴权通过、只是没有 state.json」时算成功
        if (err.code === 'NoSuchKey') {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, bucket: BUCKET, region: REGION, note: '鉴权通过，桶内暂无 state.json' }));
          return;
        }
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: (err.code ? err.code + ' ' : '') + (err.message || String(err)) }));
        return;
      }
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, bucket: BUCKET, region: REGION }));
    });
    return;
  }

  // 清除网页端保存的配置，回到环境变量 / 开发模式
  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/config/reset') {
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch (e) { /* ignore */ }
    SECRET_ID = process.env.COS_SECRET_ID || '你的SecretId';
    SECRET_KEY = process.env.COS_SECRET_KEY || '你的SecretKey';
    BUCKET = process.env.COS_BUCKET || '你的Bucket';
    REGION = process.env.COS_REGION || 'ap-guangzhou';
    buildCosClient();
    CONFIG_SOURCE = IS_MOCK ? 'none' : 'env';
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, configured: !IS_MOCK, source: CONFIG_SOURCE }));
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

server.listen(PORT, HOST, () => {
  console.log(`✔ COS 签名服务已启动: http://${HOST}:${PORT}`);
  console.log(`  测试: curl "http://${HOST}:${PORT}/health"`);
  console.log(`  配置状态: curl "http://${HOST}:${PORT}/api/config"`);
  console.log(`  签名接口: GET http://${HOST}:${PORT}/api/sign-upload?filename=test.txt&folder=board1`);
});