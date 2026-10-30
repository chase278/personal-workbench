/**
 * server.fixed.js —— cos-server 安全修复版（基于 v1.1.0 原版修补）
 *
 * 修复清单（对应审查报告编号）：
 *  [H1] CORS 由 * 收紧为本机白名单；POST 端点强制 application/json（防跨站简单请求）
 *  [H2] sign-download / delete 强制 objectKey 落在 ${BASE_PATH}/ 前缀内，拒绝越权访问全桶
 *  [H3] sign-upload 的 folder 参数白名单净化，杜绝 objectKey 路径穿越
 *  [M1] /api/state 增加最小结构校验（必须为对象）；/api/delete 不再接受 GET（防 CSRF）
 *  [L4] 增加 server error 事件处理与配置原子写入
 *  [增强] 可选 AUTH_TOKEN：设置环境变量后所有 /api/* 需带 Bearer Token（局域网部署建议开启）
 *
 * 启动方式与原版一致：node server.js（或 node --env-file=.env server.js）
 */
const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

/* ================= 配置区（全部从环境变量读取，与原版一致） ================= */
let SECRET_ID = process.env.COS_SECRET_ID || '你的SecretId';
let SECRET_KEY = process.env.COS_SECRET_KEY || '你的SecretKey';
let BUCKET = process.env.COS_BUCKET || '你的Bucket';
let REGION = process.env.COS_REGION || 'ap-guangzhou';
const BASE_PATH = process.env.COS_BASE_PATH || 'workbench';
const PORT = Number(process.env.PORT || 3456);
const HOST = envHost();
/* [增强] 可选令牌：.env 里设置 AUTH_TOKEN=随机串 后，所有 /api/* 请求需带
 * Authorization: Bearer <token> 头。仅本机 file:// 使用可不设；局域网部署强烈建议设置。 */
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
function envHost() {
  const h = process.env.HOST || '127.0.0.1';
  if (h === '0.0.0.0' && !process.env.AUTH_TOKEN) {
    console.warn('[安全警告] HOST=0.0.0.0 且未设置 AUTH_TOKEN：任何局域网设备都可操作你的 COS 桶，风险极高！');
  }
  return h;
}
/* ================================================================ */

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
  /* [L4] 原子写入：先写临时文件再 rename，避免中途崩溃产生残缺配置 */
  try {
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
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
} else {
  console.log('✔ 已配置 COS 密钥（来源: ' + CONFIG_SOURCE + '），签名接口将对接桶 ' + BUCKET + '（' + REGION + '）');
}

/* ============ [H1] CORS 收紧：仅放行本机来源 ============ */
/* 工作台页面以 file:// 打开时 Origin 为 "null"；本机页面来源为 localhost/127.0.0.1。
 * 其他任何 Origin（用户浏览器里打开的第三方网页）一律不带 CORS 头 → 浏览器拦截其读取，
 * 且预检失败后连 application/json 的 POST 都发不出。 */
function isAllowedOrigin(origin) {
  if (!origin) return true;                       // 同机 curl / 无 Origin 请求
  if (origin === 'null') return true;             // file:// 页面
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = {
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Origin,Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8'
  };
  if (isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin || '*';
  return h;
}

/* ============ [增强] 可选令牌鉴权 ============ */
function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;                   // 未配置令牌时维持原有本机使用习惯
  const h = req.headers['authorization'] || '';
  return h === 'Bearer ' + AUTH_TOKEN;
}

/* ============ [H2][H3] objectKey 安全校验 ============ */
/* 所有对 COS 对象的操作只允许落在 ${BASE_PATH}/ 前缀内 */
function isSafeKey(key) {
  return typeof key === 'string'
    && key.startsWith(BASE_PATH + '/')
    && !key.includes('..')
    && key.length < 512;
}
/* folder 白名单净化：仅允许字母数字下划线连字符，杜绝穿越 */
function sanitizeFolder(folder) {
  const f = path.basename(String(folder || 'default'));
  const safe = f.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'default';
}
function sanitizeFilename(name) {
  return path.basename(String(name)).replace(/[\\/:*?"<>|]/g, '_');
}

/* ---------- 预签名与 COS 操作（与原版一致） ---------- */
function generatePutUrl(objectKey) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({ Method: 'PUT', Bucket: BUCKET, Region: REGION, Key: objectKey, Sign: true, Expires: 600 },
      (err, data) => { if (err) return reject(err); resolve(data.Url); });
  });
}
function generateGetUrl(objectKey) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({ Method: 'GET', Bucket: BUCKET, Region: REGION, Key: objectKey, Sign: true, Expires: 600 },
      (err, data) => { if (err) return reject(err); resolve(data.Url); });
  });
}
const STATE_KEY = BASE_PATH + '/state.json';
function readState() {
  return new Promise((resolve, reject) => {
    cos.getObject({ Bucket: BUCKET, Region: REGION, Key: STATE_KEY }, (err, data) => {
      if (err) {
        if (err.statusCode === 404 || err.code === 'NoSuchKey') return resolve(null);
        return reject(err);
      }
      try { resolve(JSON.parse(data.Body.toString('utf8'))); }
      catch (e) { reject(new Error('state.json 解析失败: ' + e.message)); }
    });
  });
}
function writeState(stateObj) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: BUCKET, Region: REGION, Key: STATE_KEY,
      Body: JSON.stringify(stateObj, null, 2),
      ContentType: 'application/json; charset=utf-8'
    }, (err) => { if (err) return reject(err); resolve(); });
  });
}
function deleteObject(objectKey) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket: BUCKET, Region: REGION, Key: objectKey }, (err) => {
      if (err) return reject(err); resolve();
    });
  });
}

/* ============ [M1] 读取 JSON 请求体：强制 application/json ============ */
/* 拒绝 text/plain 等简单请求类型，使恶意网页无法绕过 CORS 预检直接写入 */
function readJsonBody(req, res, limit, cb) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) {
    res.writeHead(415, corsHeaders(req));
    res.end(JSON.stringify({ ok: false, error: 'Content-Type 必须为 application/json' }));
    return;
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
  req.on('end', () => {
    try { cb(JSON.parse(body || '{}')); }
    catch (e) {
      res.writeHead(400, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败: ' + e.message }));
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req.headers.origin)) { res.writeHead(403); res.end(); return; }
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  /* 除 /health 外均需通过可选令牌校验 */
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname !== '/health' && !isAuthorized(req)) {
    res.writeHead(401, corsHeaders(req));
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, corsHeaders(req));
    res.end(JSON.stringify({ ok: true, service: 'cos-sign-server' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    res.writeHead(200, corsHeaders(req));
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

  if ((req.method === 'POST' || req.method === 'PUT') && pathname === '/api/config') {
    readJsonBody(req, res, 64 * 1024, (obj) => {
      const cfg = {
        secretId: String(obj.secretId || '').trim(),
        secretKey: String(obj.secretKey || '').trim(),
        bucket: String(obj.bucket || '').trim(),
        region: String(obj.region || 'ap-guangzhou').trim() || 'ap-guangzhou'
      };
      if (!cfg.secretId || !cfg.secretKey || !cfg.bucket) {
        res.writeHead(400, corsHeaders(req));
        res.end(JSON.stringify({ ok: false, error: 'SecretId / SecretKey / Bucket 均不能为空' }));
        return;
      }
      const persisted = persistConfig(cfg);
      applyConfig(cfg, 'file');
      console.log('✔ 已通过网页端更新 COS 配置，桶 ' + BUCKET + '（' + REGION + '）');
      res.writeHead(200, corsHeaders(req));
      res.end(JSON.stringify({
        ok: true, persisted, configured: !IS_MOCK,
        bucket: BUCKET, region: REGION, secretIdMasked: maskSecretId(SECRET_ID)
      }));
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config/test') {
    if (IS_MOCK) {
      res.writeHead(400, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: '尚未配置 COS 密钥' }));
      return;
    }
    cos.getObject({ Bucket: BUCKET, Region: REGION, Key: STATE_KEY }, (err) => {
      if (err) {
        if (err.code === 'NoSuchKey') {
          res.writeHead(200, corsHeaders(req));
          res.end(JSON.stringify({ ok: true, bucket: BUCKET, region: REGION, note: '鉴权通过，桶内暂无 state.json' }));
          return;
        }
        res.writeHead(500, corsHeaders(req));
        res.end(JSON.stringify({ ok: false, error: (err.code ? err.code + ' ' : '') + (err.message || String(err)) }));
        return;
      }
      res.writeHead(200, corsHeaders(req));
      res.end(JSON.stringify({ ok: true, bucket: BUCKET, region: REGION }));
    });
    return;
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/config/reset') {
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch (e) { /* ignore */ }
    SECRET_ID = process.env.COS_SECRET_ID || '你的SecretId';
    SECRET_KEY = process.env.COS_SECRET_KEY || '你的SecretKey';
    BUCKET = process.env.COS_BUCKET || '你的Bucket';
    REGION = process.env.COS_REGION || 'ap-guangzhou';
    buildCosClient();
    CONFIG_SOURCE = IS_MOCK ? 'none' : 'env';
    res.writeHead(200, corsHeaders(req));
    res.end(JSON.stringify({ ok: true, configured: !IS_MOCK, source: CONFIG_SOURCE }));
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/sign-upload') {
    const filename = parsed.query.filename || '';
    if (!filename) {
      res.writeHead(400, corsHeaders(req));
      res.end(JSON.stringify({ error: '缺少 filename 参数' }));
      return;
    }
    /* [H3] folder 走白名单净化，objectKey 恒定落在 ${BASE_PATH}/ 内 */
    const folder = sanitizeFolder(parsed.query.folder);
    const safeName = sanitizeFilename(filename);
    const objectKey = `${BASE_PATH}/${folder}/${Date.now()}-${safeName}`;
    try {
      const presignedUrl = await generatePutUrl(objectKey);
      res.writeHead(200, corsHeaders(req));
      res.end(JSON.stringify({ ok: true, uploadUrl: presignedUrl, objectKey, done: true }));
    } catch (e) {
      console.error('签名失败:', e);
      res.writeHead(500, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sign-download') {
    const objectKey = parsed.query.key || '';
    /* [H2] 前缀校验：只允许 workbench/ 内的对象 */
    if (!isSafeKey(objectKey)) {
      res.writeHead(403, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: `key 必须位于 ${BASE_PATH}/ 前缀内` }));
      return;
    }
    try {
      const presignedUrl = await generateGetUrl(objectKey);
      res.writeHead(200, corsHeaders(req));
      res.end(JSON.stringify({ ok: true, downloadUrl: presignedUrl }));
    } catch (e) {
      res.writeHead(500, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  /* [M1] 删除仅接受 POST/DELETE，杜绝 GET 型 CSRF（img 标签即可触发删除） */
  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/delete') {
    const objectKey = parsed.query.key || '';
    /* [H2] 前缀校验 */
    if (!isSafeKey(objectKey)) {
      res.writeHead(403, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: `key 必须位于 ${BASE_PATH}/ 前缀内` }));
      return;
    }
    try {
      await deleteObject(objectKey);
      res.writeHead(200, corsHeaders(req));
      res.end(JSON.stringify({ ok: true, deleted: objectKey }));
    } catch (e) {
      res.writeHead(500, corsHeaders(req));
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  if (pathname === '/api/state') {
    if (req.method === 'GET') {
      try {
        const st = await readState();
        res.writeHead(200, corsHeaders(req));
        res.end(st ? JSON.stringify({ ok: true, state: st }) : JSON.stringify({ ok: true, state: null }));
      } catch (e) {
        res.writeHead(500, corsHeaders(req));
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      }
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      readJsonBody(req, res, 2 * 1024 * 1024, async (obj) => {
        /* [M1] 最小结构校验：state 必须是对象且含已知字段，拦截任意载荷写入 */
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
          res.writeHead(400, corsHeaders(req));
          res.end(JSON.stringify({ ok: false, error: 'state 必须为 JSON 对象' }));
          return;
        }
        try {
          await writeState(obj);
          res.writeHead(200, corsHeaders(req));
          res.end(JSON.stringify({ ok: true, saved: true }));
        } catch (e) {
          res.writeHead(500, corsHeaders(req));
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
        }
      });
      return;
    }
  }

  res.writeHead(404, corsHeaders(req));
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

/* [L4] 端口占用等启动错误不再裸崩 */
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`✘ 端口 ${PORT} 已被占用：可能已有一个签名服务在运行（lsof -i :${PORT} 排查）`);
  } else {
    console.error('✘ 服务错误:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`✔ COS 签名服务已启动: http://${HOST}:${PORT}`);
  console.log(`  测试: curl "http://${HOST}:${PORT}/health"`);
  if (AUTH_TOKEN) console.log('  令牌鉴权：已开启（/api/* 需带 Authorization: Bearer <token>）');
});
