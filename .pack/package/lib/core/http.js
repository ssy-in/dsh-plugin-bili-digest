// 统一的出站 HTTP：只允许 B 站域名、带超时/重试/字节上限，并按最小间隔限速。
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MIN_INTERVAL_MS = 260;

const ALLOWED_HOSTS = [
  /(^|\.)bilibili\.com$/i,
  /(^|\.)biliapi\.net$/i,
  /(^|\.)hdslb\.com$/i,
  /(^|\.)bilivideo\.com$/i,
  // 天气/定位：公开只读接口，不带任何凭据。鲸鲸的心情要用温度和湿度。
  /(^|\.)open-meteo\.com$/i,
  /(^|\.)ipwho\.is$/i,
  /(^|\.)ip-api\.com$/i,
];

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', kind = 'http' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.kind = kind;
  }
}

/** 校验 URL 是否落在 B 站域名白名单内（防 SSRF：字幕地址来自接口，不能盲信）。 */
export function assertAllowedUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new HttpError(`不是合法 URL：${String(input).slice(0, 80)}`, { kind: 'url' });
  }
  if (u.protocol !== 'https:') throw new HttpError(`只允许 https：${u.protocol}`, { kind: 'url', url: u.href });
  if (u.username || u.password) throw new HttpError('URL 不允许携带凭据', { kind: 'url', url: u.href });
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) {
    throw new HttpError(`域名不在白名单：${u.hostname}`, { kind: 'url', url: u.href });
  }
  return u;
}

let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(minIntervalMs = MIN_INTERVAL_MS) {
  const now = Date.now();
  const wait = lastCallAt + minIntervalMs - now;
  lastCallAt = Math.max(now, lastCallAt + minIntervalMs);
  if (wait > 0) await sleep(wait + Math.random() * 80);
}

/** 硬性小时预算：滚动一小时最多 120 次出站请求，用超了直接失败——比被 B 站限流更保守。 */
const MAX_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;
const callLog = [];

function trimBudget(now) {
  while (callLog.length > 0 && now - callLog[0] > HOUR_MS) callLog.shift();
  return callLog.length;
}

/** 当前小时预算用量（给界面与 CLI 显示，避免不知不觉刷爆）。 */
export function budgetState(now = Date.now()) {
  const used = trimBudget(now);
  return { used, max: MAX_PER_HOUR, remaining: Math.max(0, MAX_PER_HOUR - used) };
}

/** 测试或用户显式要求时清空计数。 */
export function resetBudget() {
  callLog.length = 0;
}

/** 先记账再限速：超出小时预算就抛错，别把请求发出去。 */
async function spendBudget(minIntervalMs) {
  const used = trimBudget(Date.now());
  if (used >= MAX_PER_HOUR) {
    throw new HttpError(`本小时已用完 ${MAX_PER_HOUR} 次请求预算，歇一会儿再刷`, { status: 429, kind: 'budget' });
  }
  callLog.push(Date.now());
  await throttle(minIntervalMs);
}

/** 读响应体但不超过 maxBytes（边读边计，防止单个大响应吃掉内存）。 */
async function readLimitedBinary(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(`响应超过 ${maxBytes} 字节上限`, { status: response.status, kind: 'size' });
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
}

/** 读响应体但不超过 maxBytes（边读边计，防止单个大响应吃掉内存）。 */
async function readLimited(response, maxBytes) {
  const type = response.headers.get('content-type') || '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(`响应超过 ${maxBytes} 字节上限`, { status: response.status, kind: 'size' });
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), type };
}

/**
 * GET 一个 URL 并解析为 JSON。
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, retries?: number, maxBytes?: number, throttleMs?: number}} [options]
 */
export async function getJson(url, options = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 1,
    maxBytes = DEFAULT_MAX_BYTES,
    throttleMs = MIN_INTERVAL_MS,
  } = options;
  const target = assertAllowedUrl(url);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await spendBudget(throttleMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, { headers, signal: controller.signal, redirect: 'follow' });
      if (response.status === 412 || response.status === 429) {
        throw new HttpError(`被限流（${response.status}），请降低频率`, { status: response.status, url: target.href, kind: 'ratelimit' });
      }
      if (!response.ok) throw new HttpError(`HTTP ${response.status}`, { status: response.status, url: target.href });
      if (response.url) assertAllowedUrl(response.url);
      const { text } = await readLimited(response, maxBytes);
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`非 JSON 响应：${text.slice(0, 120)}`, { status: response.status, url: target.href, kind: 'parse' });
      }
    } catch (error) {
      lastError = error;
      const retryable = error.name === 'AbortError' || error.kind === 'parse' || (error.status >= 500 && error.status < 600);
      if (!retryable || attempt === retries) throw error.name === 'AbortError' ? new HttpError(`超时 ${timeoutMs}ms`, { url: target.href, kind: 'timeout' }) : error;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * POST 一个表单（写操作：发评论、收藏）。**不做重试**——写操作重放会产生重复评论。
 * 同样走域名白名单、小时预算、超时与字节上限。
 * @param {string} url
 * @param {Record<string,string|number|undefined>} fields
 * @param {{headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number, throttleMs?: number}} [options]
 */
export async function postForm(url, fields = {}, options = {}) {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, throttleMs = MIN_INTERVAL_MS } = options;
  const target = assertAllowedUrl(url);
  await spendBudget(throttleMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (response.status === 412 || response.status === 429) {
      throw new HttpError(`被限流（${response.status}），请降低频率`, { status: response.status, url: target.href, kind: 'ratelimit' });
    }
    if (!response.ok) throw new HttpError(`HTTP ${response.status}`, { status: response.status, url: target.href });
    if (response.url) assertAllowedUrl(response.url);
    const { text } = await readLimited(response, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(`非 JSON 响应：${text.slice(0, 120)}`, { status: response.status, url: target.href, kind: 'parse' });
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new HttpError(`超时 ${timeoutMs}ms`, { url: target.href, kind: 'timeout' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET 一个二进制资源（分镜图之类），同样走域名白名单、限速、超时与字节上限。
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, retries?: number, maxBytes?: number, throttleMs?: number}} [options]
 * @returns {Promise<{body: Buffer, contentType: string}>}
 */
export async function getBytes(url, options = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 1,
    maxBytes = 8 * 1024 * 1024,
    throttleMs = MIN_INTERVAL_MS,
  } = options;
  const target = assertAllowedUrl(url);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await spendBudget(throttleMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, { headers, signal: controller.signal, redirect: 'follow' });
      if (response.status === 412 || response.status === 429) {
        throw new HttpError(`被限流（${response.status}），请降低频率`, { status: response.status, url: target.href, kind: 'ratelimit' });
      }
      if (!response.ok) throw new HttpError(`HTTP ${response.status}`, { status: response.status, url: target.href });
      if (response.url) assertAllowedUrl(response.url);
      const { body, type } = await readLimitedBinary(response, maxBytes);
      return { body, contentType: type };
    } catch (error) {
      lastError = error;
      const retryable = error.name === 'AbortError' || (error.status >= 500 && error.status < 600);
      if (!retryable || attempt === retries) throw error.name === 'AbortError' ? new HttpError(`超时 ${timeoutMs}ms`, { url: target.href, kind: 'timeout' }) : error;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
