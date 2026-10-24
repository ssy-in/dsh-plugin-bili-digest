// 生成本地测试所需的 peer 依赖桩：真实运行时这些包由 DSH 宿主提供，测试时只需占位。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const STUBS = {
  '@deepseek-ai/schemastery': {
    'package.json': JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test', type: 'module', main: 'index.js' }, null, 2),
    'index.js': `// 测试桩：真实环境由 DSH 提供 @deepseek-ai/schemastery。
function chain(extra) {
  return Object.assign(
    {
      default(value) {
        this.value = value;
        return this;
      },
      description(text) {
        this.text = text;
        return this;
      },
    },
    extra || {},
  );
}
export default {
  number: () => chain(),
  string: () => chain(),
  boolean: () => chain(),
  object: (shape) => chain({ shape }),
};
`,
  },
  '@deepseek-ai/dsh-tools': {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-test', type: 'module', main: 'index.js' }, null, 2),
    'index.js': `// 测试桩：真实环境由 DSH 提供 @deepseek-ai/dsh-tools。
export const defineTool = (spec) => spec;
`,
  },
};

for (const [pkg, files] of Object.entries(STUBS)) {
  const dir = path.join(root, 'node_modules', pkg);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

process.stdout.write(`peer 依赖桩已就绪：${Object.keys(STUBS).join('、')}\n`);
