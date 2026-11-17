#!/usr/bin/env node
/** npx bgm-grab 入口：转发到 server.mjs，继承所有参数与环境变量。 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
