// 插件装配测试：用假 ctx 检查工具注册与 HTTP 路由的同源/头部防护（不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BILI_DIGEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-digest-test-'));

const { apply, inject, name, Config } = await import('../lib/index.js');

function makeHarness() {
  const tools = [];
  const routes = [];
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    inject: (deps, callback) => callback({ webServer: { register: (route) => routes.push(route), port: 59321, getOrigin: () => 'http://127.0.0.1:59321' } }),
  };
  apply(ctx, { minCharsPerMinute: 60, limit: 5, days: 0, maxK: 8, maxSegmentChars: 3600, keepReports: 5 });
  return { tools, routes, ctx };
}

function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = {};
  const request = {
    method,
    url,
    headers,
    on(event, handler) {
      listeners[event] = handler;
      return request;
    },
    destroy() {},
  };
  setImmediate(() => {
    if (body !== undefined && listeners.data) listeners.data(Buffer.from(JSON.stringify(body)));
    if (listeners.end) listeners.end();
  });
  return request;
}

function fakeResponse() {
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers || {};
      return response;
    },
    end(chunk) {
      if (chunk) response.body += String(chunk);
    },
  };
  return response;
}

async function callRoute(routes, requestOptions) {
  const route = routes[0];
  const response = fakeResponse();
  await route.handler(fakeRequest(requestOptions), response);
  return { status: response.status, headers: response.headers, json: () => JSON.parse(response.body) };
}

test('插件身份与配置 schema 存在', () => {
  assert.equal(name, 'bili-digest');
  assert.deepEqual(inject, ['tools']);
  assert.ok(Config && typeof Config === 'object');
});

test('注册七个工具与一条前缀路由', () => {
  const { tools, routes } = makeHarness();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['bili_digest', 'bili_frames', 'bili_inbox', 'bili_mood', 'bili_push', 'bili_read', 'bili_recall']);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/bili-digest/api');
  for (const tool of tools) {
    assert.ok(tool.description.length > 10);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
  }
});

test('抓帧工具声明了 BV 号与帧数参数', () => {
  const { tools } = makeHarness();
  const frames = tools.find((tool) => tool.name === 'bili_frames');
  assert.ok(frames.parameters.bvid.required);
  assert.equal(frames.parameters.count.type, 'integer');
  assert.equal(frames.parameters.seconds.type, 'array');
  const props = frames.output.schema.properties;
  assert.ok(props.text.required);
  assert.equal(props.images.type, 'array');
});

test('/frame 与 /frames 也做同源校验', async () => {
  const { routes } = makeHarness();
  const crossSite = await callRoute(routes, { url: '/bili-digest/api/frame?bvid=BV1Fdna6mE9W&t=10', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const postFrames = await callRoute(routes, { method: 'POST', url: '/bili-digest/api/frames', headers: { 'sec-fetch-site': 'cross-site' }, body: { bvid: 'BV1Fdna6mE9W' } });
  assert.equal(postFrames.status, 403);
});

test('跨站请求被拒绝', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { url: '/bili-digest/api/job', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(result.status, 403);
});

test('外来 Origin 被拒绝', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { url: '/bili-digest/api/job', headers: { origin: 'https://evil.example' } });
  assert.equal(result.status, 403);
});

test('POST 缺少自定义头被拒绝', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { method: 'POST', url: '/bili-digest/api/settings', body: { limit: 3 } });
  assert.equal(result.status, 403);
  assert.match(result.json().error, /x-bili-digest/);
});

test('方法不符返回 405', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { method: 'POST', url: '/bili-digest/api/job', headers: { 'x-bili-digest': '1' }, body: {} });
  assert.equal(result.status, 405);
});

test('/job 在空闲时返回 idle', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { url: '/bili-digest/api/job', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(result.status, 200);
  assert.equal(result.json().job.status, 'idle');
});

test('/settings 拒绝 cookie 注入式 SESSDATA', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, {
    method: 'POST',
    url: '/bili-digest/api/settings',
    headers: { 'x-bili-digest': '1', 'sec-fetch-site': 'same-origin' },
    body: { sessdata: 'abc; bili_jct=evil' },
  });
  assert.equal(result.status, 400);
  assert.match(result.json().error, /SESSDATA/);
});

test('/settings 接受合法 SESSDATA 并保存到 0600 文件', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, {
    method: 'POST',
    url: '/bili-digest/api/settings',
    headers: { 'x-bili-digest': '1', 'sec-fetch-site': 'same-origin' },
    body: { sessdata: 'test%2Csessdata_value-123', limit: 7 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json().ok, true);
  const file = path.join(process.env.BILI_DIGEST_HOME, 'config.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.sessdata, 'test%2Csessdata_value-123');
  assert.equal(saved.limit, 7);
});

test('未知接口 404', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { url: '/bili-digest/api/nope', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(result.status, 404);
});

test('没有 webServer 时工具仍注册', () => {
  const tools = [];
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {} }, {});
  assert.equal(tools.length, 7);
});

test('心情工具声明了档位枚举与去重开关', () => {
  const { tools } = makeHarness();
  const mood = tools.find((tool) => tool.name === 'bili_mood');
  assert.deepEqual(mood.parameters.preset.enum, ['relax', 'learn', 'rant', 'hype', 'random']);
  assert.equal(mood.parameters.all.type, 'boolean');
  assert.ok(mood.output.schema.properties.diary);
});

test('/mood 与 /diary 也做同源校验', async () => {
  const { routes } = makeHarness();
  const crossSite = await callRoute(routes, {
    method: 'POST',
    url: '/bili-digest/api/mood',
    headers: { 'x-bili-digest': '1', 'sec-fetch-site': 'cross-site' },
    body: { mood: '有点累' },
  });
  assert.equal(crossSite.status, 403);
  const missingHeader = await callRoute(routes, {
    method: 'POST',
    url: '/bili-digest/api/mood',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { mood: '有点累' },
  });
  assert.equal(missingHeader.status, 403);
  const diary = await callRoute(routes, { url: '/bili-digest/api/diary', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(diary.status, 404);
});

test('/state 带上心情档位与预算', async () => {
  const { routes } = makeHarness();
  const result = await callRoute(routes, { url: '/bili-digest/api/state', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(result.status, 200);
  const body = result.json();
  assert.equal(body.moodPresets.length, 5);
  assert.equal(body.budget.max, 120);
  assert.equal(typeof body.diaryDir, 'string');
});
