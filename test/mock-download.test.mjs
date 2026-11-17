import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 用假 yt-dlp 验证「进程调用 → 参数传递 → 产物落盘 → 快照 diff」链路，
// 完全不依赖网络与真实 yt-dlp。
const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'server.mjs');
const NODE = process.execPath;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-mock-'));
}

function makeFakeYtDlp(dir, { fail = false } = {}) {
  const fake = path.join(dir, 'yt-dlp');
  const script = fail
    ? '#!/bin/sh\necho "simulated failure" >&2\nexit 1\n'
    : `#!/bin/sh
# 解析 -o 参数拿到输出模板
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
# 把模板里的 %(title)s / %(ext)s 替换成固定值
name=$(printf '%s' "$out" | sed 's/%(title)s/mock-song/g; s/%(ext)s/mp3/g')
printf 'ID3 mock audio content' > "$name"
echo "[download] 100% of 1.00MiB in 00:00:01"
exit 0
`;
  fs.writeFileSync(fake, script, { mode: 0o755 });
  return fake;
}

async function startServer(env) {
  const child = spawn(NODE, [SERVER], {
    env: { ...process.env, NO_OPEN: '1', ...env },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });

  // 从输出里解析实际监听端口（端口占用会自动递增）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) return { child, port: Number(m[1]), getOutput: () => output };
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('服务启动超时: ' + output);
}

async function api(base, p, body, token) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bgm-token': token },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

async function collectSse(base, jobId) {
  const r = await fetch(base + '/api/events?jobId=' + encodeURIComponent(jobId));
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue;
      try {
        const e = JSON.parse(l.slice(6));
        events.push(e);
        if (e.type === 'job_done') { reader.cancel(); return events; }
      } catch { /* ignore */ }
    }
  }
  return events;
}

test('mock yt-dlp：完整下载链路成功，产物被捕获', async () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  const fake = makeFakeYtDlp(dir);
  const { child, port } = await startServer({
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'cfg'),
    BGM_PORT: '18901',
    YT_DLP: fake,
    FFMPEG: '/usr/bin/true',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const st = await (await fetch(base + '/api/status')).json();
    const token = st.token;
    assert.equal(st.ytdlp.path, fake);
    assert.equal(st.outDir, path.join(dir, 'Downloads', 'bgm'));

    const dl = await api(base, '/api/download', {
      urls: ['https://www.youtube.com/watch?v=mock123'],
      outDir,
    }, token);
    assert.equal(dl.status, 200);
    const events = await collectSse(base, dl.json.jobId);
    const done = events.find((e) => e.type === 'job_done');
    assert.ok(done, '应收到 job_done');
    assert.equal(done.ok, 1);
    assert.equal(done.failed, 0);

    const item = events.find((e) => e.type === 'item_done');
    assert.ok(item.files.length > 0, '应捕获产物文件');
    assert.equal(item.files[0].name, 'mock-song.mp3');
    assert.ok(fs.existsSync(path.join(outDir, 'mock-song.mp3')));

    const progress = events.find((e) => e.type === 'progress');
    assert.ok(progress, '应解析到进度事件');
    assert.equal(progress.percent, 100);
  } finally {
    child.kill();
  }
});

test('mock yt-dlp 失败时返回失败状态但服务不崩', async () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  const fake = makeFakeYtDlp(dir, { fail: true });
  const { child, port } = await startServer({
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'cfg'),
    BGM_PORT: '18902',
    YT_DLP: fake,
    FFMPEG: '/usr/bin/true',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const st = await (await fetch(base + '/api/status')).json();
    const dl = await api(base, '/api/download', {
      urls: ['https://www.youtube.com/watch?v=mockfail'],
      outDir,
    }, st.token);
    assert.equal(dl.status, 200);
    const events = await collectSse(base, dl.json.jobId);
    const done = events.find((e) => e.type === 'job_done');
    assert.equal(done.ok, 0);
    assert.equal(done.failed, 1);
  } finally {
    child.kill();
  }
});
