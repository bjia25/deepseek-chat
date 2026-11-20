'use strict';

/**
 * DeepSeek 聊天 —— 零依赖单进程服务
 *
 * 同时负责：
 *   1. 提供 public/ 下的聊天页面（HTML/CSS/JS）
 *   2. 把浏览器发来的对话转发给 DeepSeek 官方 API，并把流式结果原样回传
 *
 * 不写入任何对话数据：聊天记录只保存在用户浏览器的 localStorage 里。
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ------------------------------------------------------------------ */
/* 配置                                                               */
/* ------------------------------------------------------------------ */

/** 读取同目录下的 .env（如果存在）。已存在的环境变量优先。 */
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const ACCESS_PASSWORD = (process.env.ACCESS_PASSWORD || '').trim();
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-chat';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 12000;
const MAX_BODY_BYTES = 1_000_000;

const AUTH_COOKIE = 'ds_chat_auth';
const AUTH_TOKEN = ACCESS_PASSWORD
  ? crypto.createHmac('sha256', ACCESS_PASSWORD).update('deepseek-chat|v1').digest('base64url')
  : '';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
  if (!ACCESS_PASSWORD) return true;
  const token = readCookie(req.headers.cookie || '', AUTH_COOKIE);
  return typeof token === 'string' && safeEqual(token, AUTH_TOKEN);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** 极简内存限流：同一 key 在 windowMs 内最多 limit 次。 */
const rateBuckets = new Map();
function hitRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now > v.reset) rateBuckets.delete(k);
    }
  }
  return bucket.count > limit;
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                           */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...SECURITY_HEADERS,
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 接口：会话 / 登录                                                   */
/* ------------------------------------------------------------------ */

function handleSession(req, res) {
  sendJson(res, 200, {
    authRequired: Boolean(ACCESS_PASSWORD),
    authed: isAuthed(req),
    defaultModel: DEFAULT_MODEL,
  });
}

async function handleLogin(req, res) {
  if (!ACCESS_PASSWORD) return sendJson(res, 200, { ok: true });

  const ip = clientIp(req);
  if (hitRateLimit(`login:${ip}`, 10, 10 * 60 * 1000)) {
    return sendJson(res, 429, {
      error: { code: 'rate_limited', message: '尝试次数太多，请 10 分钟后再试。' },
    });
  }

  let data;
  try {
    data = JSON.parse(await readBody(req, 8192));
  } catch {
    return sendJson(res, 400, { error: { code: 'bad_request', message: '请求格式不正确。' } });
  }

  const password = typeof data.password === 'string' ? data.password : '';
  if (!safeEqual(password, ACCESS_PASSWORD)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return sendJson(res, 401, { error: { code: 'bad_password', message: '密码不对，再试试。' } });
  }

  const isHttps = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${
      isHttps ? '; Secure' : ''
    }`
  );
  sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  sendJson(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* 接口：聊天（流式代理）                                              */
/* ------------------------------------------------------------------ */

const UPSTREAM_FRIENDLY = {
  400: '请求参数有误，可能是上下文太长或模型名称不对。',
  401: 'API Key 无效或已过期，请检查服务端的 DEEPSEEK_API_KEY。',
  402: 'DeepSeek 账户余额不足，请到 platform.deepseek.com 充值后再试。',
  422: '请求参数有误，可能是上下文太长。',
  429: '请求太频繁，请稍等几秒再试。',
  500: 'DeepSeek 服务出错了，请稍后重试。',
  503: 'DeepSeek 服务繁忙，请稍后重试。',
};

function relayUpstreamError(res, status, raw) {
  let detail = '';
  try {
    const parsed = JSON.parse(raw);
    const err = parsed && parsed.error;
    detail = typeof err === 'string' ? err : (err && err.message) || parsed.message || '';
  } catch {
    /* 非 JSON 错误体，忽略 */
  }
  if (typeof detail !== 'string') detail = '';
  sendJson(res, 502, {
    error: {
      code: 'upstream_error',
      status,
      message: UPSTREAM_FRIENDLY[status] || `DeepSeek 返回了 HTTP ${status}。`,
      detail: detail.slice(0, 300),
    },
  });
}

async function handleChat(req, res) {
  if (!isAuthed(req)) {
    return sendJson(res, 401, { error: { code: 'unauthorized', message: '需要访问密码。' } });
  }

  const ip = clientIp(req);
  if (hitRateLimit(`chat:${ip}`, 60, 10 * 60 * 1000)) {
    return sendJson(res, 429, {
      error: { code: 'rate_limited', message: '发送太频繁了，休息一下再试。' },
    });
  }

  if (!API_KEY) {
    return sendJson(res, 503, {
      error: {
        code: 'no_api_key',
        message: '服务器还没有配置 DEEPSEEK_API_KEY，先在环境变量里填上再试。',
      },
    });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_BODY_BYTES));
  } catch (err) {
    const status = err && err.code === 'TOO_LARGE' ? 413 : 400;
    return sendJson(res, status, { error: { code: 'bad_request', message: '请求格式不正确。' } });
  }

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!rawMessages.length || rawMessages.length > MAX_MESSAGES) {
    return sendJson(res, 400, { error: { code: 'bad_request', message: '消息数量不合法。' } });
  }

  const messages = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') {
      return sendJson(res, 400, { error: { code: 'bad_request', message: '消息格式不合法。' } });
    }
    const role = item.role;
    const content = typeof item.content === 'string' ? item.content : '';
    if (!['system', 'user', 'assistant'].includes(role)) {
      return sendJson(res, 400, { error: { code: 'bad_request', message: '消息角色不合法。' } });
    }
    if (!content || content.length > MAX_MESSAGE_CHARS) {
      return sendJson(res, 400, { error: { code: 'bad_request', message: '消息内容为空或过长。' } });
    }
    messages.push({ role, content });
  }
  if (messages[messages.length - 1].role !== 'user') {
    return sendJson(res, 400, { error: { code: 'bad_request', message: '最后一条必须是用户消息。' } });
  }

  const model = MODELS.has(payload.model) ? payload.model : DEFAULT_MODEL;
  const body = { model, messages, stream: true };
  if (model === 'deepseek-chat' && Number.isFinite(payload.temperature)) {
    body.temperature = Math.min(2, Math.max(0, payload.temperature));
  }
  if (Number.isFinite(payload.max_tokens)) {
    body.max_tokens = Math.min(8192, Math.max(64, Math.floor(payload.max_tokens)));
  }

  const target = new URL(`${BASE_URL}/chat/completions`);
  const transport = target.protocol === 'https:' ? https : http;

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${API_KEY}`,
        'User-Agent': 'deepseek-chat/1.0',
      },
      timeout: 180000,
    },
    (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        const chunks = [];
        let size = 0;
        upstreamRes.on('data', (chunk) => {
          size += chunk.length;
          if (size < 65536) chunks.push(chunk);
        });
        upstreamRes.on('end', () =>
          relayUpstreamError(res, upstreamRes.statusCode || 502, Buffer.concat(chunks).toString('utf8'))
        );
        upstreamRes.on('error', () => relayUpstreamError(res, 502, ''));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      // 只有「客户端提前断开」才销毁上游；正常结束时 writableEnded 为 true
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy();
      });
      upstreamRes.on('data', (chunk) => res.write(chunk));
      upstreamRes.on('end', () => res.end());
      upstreamRes.on('error', () => {
        try {
          res.end();
        } catch {
          /* 已断开 */
        }
      });
    }
  );

  upstream.on('timeout', () => upstream.destroy(new Error('连接 DeepSeek 超时')));
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { code: 'upstream_unreachable', message: `连接 DeepSeek 失败：${err.message}` },
      });
    } else {
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
    }
  });

  upstream.end(JSON.stringify(body));

  // 注意：不能用 req.on('close')，它在请求体读完时就会触发
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          apiKeyConfigured: Boolean(API_KEY),
          authEnabled: Boolean(ACCESS_PASSWORD),
          defaultModel: DEFAULT_MODEL,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }
      if (pathname === '/api/session') return handleSession(req, res);
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: { code: 'not_found', message: '接口不存在。' } });
      }
      return serveStatic(req, res, pathname);
    }

    if (method === 'POST') {
      if (pathname === '/api/chat') return handleChat(req, res);
      if (pathname === '/api/login') return handleLogin(req, res);
      if (pathname === '/api/logout') return handleLogout(req, res);
      return sendJson(res, 404, { error: { code: 'not_found', message: '接口不存在。' } });
    }

    res.writeHead(405, { Allow: 'GET, HEAD, POST', ...SECURITY_HEADERS });
    res.end();
  } catch (err) {
    console.error('[deepseek-chat] 未捕获错误:', err);
    sendJson(res, 500, { error: { code: 'internal_error', message: '服务器内部错误。' } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[deepseek-chat] 已启动：http://${HOST}:${PORT}`);
  if (!API_KEY) {
    console.warn('[deepseek-chat] ⚠ 未设置 DEEPSEEK_API_KEY，聊天接口会返回 503。请在 .env 或托管平台里配置。');
  }
  if (!ACCESS_PASSWORD) {
    console.warn('[deepseek-chat] ⚠ 未设置 ACCESS_PASSWORD，任何知道网址的人都能用你的额度聊天。');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[deepseek-chat] 收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
