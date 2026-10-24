// 客户端 bundle 装配测试：用假的 window.__ModuleLoader__ / react 跑一遍注册与首屏渲染，不碰浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fakeReact() {
  let hookIndex = 0;
  const states = [];
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (initial) => {
      const index = hookIndex;
      hookIndex += 1;
      if (states[index] === undefined) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next;
      }];
    },
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
    __reset: () => {
      hookIndex = 0;
    },
  };
}

function loadBundle() {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } };
  globalThis.document = { baseURI: 'http://127.0.0.1:52439/' };
  globalThis.fetch = () => Promise.reject(new Error('测试中不应联网'));

  const source = require$readClient();
  const module = { exports: {} };
  new Function('window', 'module', 'exports', 'require', source)(globalThis.window, module, module.exports, (id) => {
    if (id === 'react') return loadBundle.react;
    throw new Error(`未预期的依赖：${id}`);
  });
  assert.ok(captured, '__ModuleLoader__.load 未被调用');
  const exported = captured.factory((id) => {
    if (id === 'react') return loadBundle.react;
    throw new Error(`未预期的依赖：${id}`);
  });
  return { entry: captured, exported };
}

function require$readClient() {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js'), 'utf8');
}

loadBundle.react = fakeReact();

test('客户端 bundle 暴露 name / inject / apply', () => {
  const { entry, exported } = loadBundle();
  assert.equal(entry.id, 'dsh-plugin-bili-digest');
  assert.equal(exported.name, 'bili-digest');
  assert.deepEqual(exported.inject, ['slots']);
  assert.equal(typeof exported.apply, 'function');
});

test('注册到 plugins.item 槽位并带页面标题', () => {
  const { exported } = loadBundle();
  let registration = null;
  const ctx = {
    slots: {
      inject: (name, callback) => {
        assert.equal(name, 'plugins.item');
        return callback();
      },
      register: (options, Component) => {
        registration = { options, Component };
        return {};
      },
    },
  };
  exported.apply(ctx);
  assert.ok(registration, '没有注册任何槽位');
  assert.equal(registration.options.name, 'plugins.item');
  assert.equal(registration.options.id, 'bili-digest');
  assert.equal(typeof registration.options.label, 'function');
  assert.ok(registration.options.label().length > 0);
  assert.equal(registration.options.order, 40);
});

test('summary 视图给出一句话说明', () => {
  const { exported } = loadBundle();
  let Component = null;
  exported.apply({ slots: { inject: (_name, callback) => callback(), register: (_options, comp) => ((Component = comp), {}) } });
  loadBundle.react.__reset();
  const tree = Component({ view: 'summary' });
  assert.equal(tree.type, 'span');
  assert.match(String(tree.children[0]), /字幕/);
});

test('page 视图首屏能渲染出表单与状态块', () => {
  const { exported } = loadBundle();
  let Component = null;
  exported.apply({ slots: { inject: (_name, callback) => callback(), register: (_options, comp) => ((Component = comp), {}) } });
  loadBundle.react.__reset();
  const tree = Component({ view: 'page' });
  assert.equal(tree.type, 'div');
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value));
  assert.match(text, /读取状态/);
  assert.match(text, /关键词/);
  assert.match(text, /SESSDATA/);
  assert.match(text, /开始一轮/);
});
