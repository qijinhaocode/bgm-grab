/**
 * BGM Grab - 本地单用户 YouTube 音频下载服务
 * 零依赖（Node >= 18）：node server.mjs
 * 只监听 127.0.0.1；URL 走 spawn 参数数组 + `--`，不拼 shell。
 * 配置见 config.mjs（env > config.json > 自动推断）。
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CLIENT, loadConfig, writeFileConfig, dirStatus, validOutDir, validUrl,
  parseUrls, buildCopyCommand, sanitizeClient, fileManagerBin, fileManagerArgs,
  outputTemplate,
} from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

let CFG = loadConfig();
let PORT = CFG.port;
let TOKEN = crypto.randomBytes(24).toString('hex');

function ytDlp() { return CFG.ytDlp; }
function versionOf(bin) {
  if (!bin) return null;
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
    return (r.stdout || '').trim() || null;
  } catch {
    return null;
  }
}
let VERSION = versionOf(ytDlp());

/* ---------------- 进程运行 ---------------- */

function runProcess(bin, args, { timeoutMs, onLine, onStderrLine }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, error: e.message });
      return;
    }
    let bufOut = '', bufErr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bufOut += chunk;
      const lines = bufOut.split('\n');
      bufOut = lines.pop();
      for (const l of lines) if (l.trim()) onLine?.(l);
    });
    child.stderr.on('data', (chunk) => {
      bufErr += chunk;
      const lines = bufErr.split('\n');
      bufErr = lines.pop();
      for (const l of lines) if (l.trim()) onStderrLine?.(l);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (bufOut.trim()) onLine?.(bufOut);
      if (bufErr.trim()) onStderrLine?.(bufErr);
      resolve({ code, error: timedOut ? `超时（>${Math.round(timeoutMs / 1000)}s）` : null });
    });
  });
}

/* ---------------- 预检 ---------------- */

async function probeOne(bin, url, client, allowPlaylist) {
  const args = [
    '--ignore-config',
    '--extractor-args', `youtube:player_client=${client}`,
    '--skip-download',
    '--no-warnings',
    '--print', '%(title)s\t%(duration_string)s\t%(id)s',
  ];
  if (!allowPlaylist) args.push('--no-playlist');
  args.push('--', url);

  let printed = '';
  let errTail = '';
  const r = await runProcess(bin, args, {
    timeoutMs: 45000,
    onLine: (l) => { if (!printed) printed = l; },
    onStderrLine: (l) => { errTail = l; },
  });
  if (r.code !== 0 || !printed) {
    return { url, ok: false, error: r.error || errTail || '无法读取视频信息' };
  }
  const [title, duration, id] = printed.split('\t');
  return { url, ok: true, title, duration, id };
}

/* ---------------- 下载任务 ---------------- */

const jobs = new Map();
let jobSeq = 0;

function emit(job, event) {
  job.history.push(event);
  if (job.history.length > 3000) job.history.shift();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

function snapshotMp3(outDir) {
  const map = new Map();
  try {
    for (const name of fs.readdirSync(outDir)) {
      if (!name.toLowerCase().endsWith('.mp3')) continue;
      const full = path.join(outDir, name);
      const st = fs.statSync(full);
      map.set(name, { path: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  } catch { /* ignore */ }
  return map;
}

function diffFiles(before, after) {
  const out = [];
  for (const [name, info] of after) {
    const prev = before.get(name);
    if (!prev || prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      out.push({ name, ...info });
    }
  }
  return out;
}

async function runJob(job) {
  const { urls, outDir, client, allowPlaylist } = job;
  emit(job, { type: 'job_start', total: urls.length, outDir });
  let okCount = 0, failCount = 0;

  for (let i = 0; i < urls.length; i++) {
    if (job.cancelled) break;
    const url = urls[i];
    emit(job, { type: 'item_start', index: i, total: urls.length, url });
    const before = snapshotMp3(outDir);

    const args = [...baseArgs(client), '-o', outputTemplate(outDir)];
    if (!allowPlaylist) args.push('--no-playlist');
    args.push('--', url);

    const r = await runProcess(ytDlp(), args, {
      timeoutMs: 15 * 60 * 1000,
      onLine: (l) => {
        emit(job, { type: 'log', index: i, line: l });
        const m = l.match(/\[download\][^\d]*(\d{1,3}(?:\.\d)?)%/);
        if (m) emit(job, { type: 'progress', index: i, percent: Number(m[1]) });
      },
      onStderrLine: (l) => emit(job, { type: 'log', index: i, line: l }),
    });

    const files = diffFiles(before, snapshotMp3(outDir));
    const ok = r.code === 0 && !job.cancelled;
    if (ok) okCount++; else failCount++;
    emit(job, {
      type: 'item_done', index: i, url, ok,
      code: r.code,
      error: r.error || (!ok && !job.cancelled ? `yt-dlp 退出码 ${r.code}` : null),
      files, cancelled: job.cancelled,
    });
  }

  job.status = 'done';
  emit(job, { type: 'job_done', total: urls.length, ok: okCount, failed: failCount, cancelled: job.cancelled });
}

function baseArgs(client) {
  return [
    '--ignore-config', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--extractor-args', `youtube:player_client=${client || DEFAULT_CLIENT}`,
    '--newline', '--no-warnings',
  ];
}

/* ---------------- HTTP  helpers ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 128 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

// 所有 POST 都要带 token；GET 只提供页面 / 只读状态 / SSE，不需要。
function authorized(req) {
  return req.headers['x-bgm-token'] === TOKEN;
}

function statusPayload() {
  return {
    ytdlp: ytDlp() ? { path: ytDlp(), version: VERSION } : null,
    ffmpeg: !!CFG.ffmpeg,
    ffmpegPath: CFG.ffmpeg,
    outDir: CFG.outDir,
    dir: dirStatus(CFG.outDir, CFG.strictVolume),
    defaultClient: CFG.client,
    port: PORT,
    configPath: CFG.configPath,
    token: TOKEN,
  };
}

function launchDetached(bin, args) {
  try {
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
}

/* ---------------- HTTP 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      html = html.replace('</head>', `<meta name="bgm-token" content="${TOKEN}"></head>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && p === '/api/status') {
      return json(res, 200, statusPayload());
    }

    if (req.method === 'POST' && !authorized(req)) {
      return json(res, 401, { error: '未授权：缺少有效的 x-bgm-token' });
    }

    if (req.method === 'POST' && p === '/api/status') {
      const body = await readBody(req);
      const outDir = body.outDir || CFG.outDir;
      return json(res, 200, { dir: dirStatus(outDir, CFG.strictVolume), valid: validOutDir(outDir) });
    }

    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const patch = {};
      if (body.outDir && validOutDir(body.outDir)) patch.outDir = path.resolve(body.outDir);
      if (body.client) patch.client = sanitizeClient(body.client);
      if (body.port !== undefined) {
        const n = Number(body.port);
        if (n >= 1 && n <= 65535) patch.port = n;
      }
      if (body.strictVolume !== undefined) patch.strictVolume = !!body.strictVolume;
      const saved = writeFileConfig(patch);
      CFG = loadConfig();
      VERSION = versionOf(ytDlp());
      return json(res, 200, { configPath: CFG.configPath, saved, note: '端口变更需重启服务生效' });
    }

    if (req.method === 'POST' && p === '/api/probe') {
      if (!ytDlp()) return json(res, 500, { error: '未找到 yt-dlp，请设置 YT_DLP 或在页面配置' });
      const body = await readBody(req);
      const urls = parseUrls(body.urls).filter(validUrl);
      if (!urls.length) return json(res, 400, { error: '没有有效的 http(s) 链接' });
      const client = sanitizeClient(body.client || CFG.client);
      const allowPlaylist = !!body.allowPlaylist;

      const items = new Array(urls.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < urls.length) {
          const idx = cursor++;
          items[idx] = await probeOne(ytDlp(), urls[idx], client, allowPlaylist);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return json(res, 200, { items });
    }

    if (req.method === 'POST' && p === '/api/command') {
      const body = await readBody(req);
      const urls = parseUrls(body.urls).filter(validUrl);
      const outDir = validOutDir(body.outDir) ? body.outDir : CFG.outDir;
      return json(res, 200, {
        command: buildCopyCommand({
          urls, outDir,
          client: sanitizeClient(body.client || CFG.client),
          allowPlaylist: !!body.allowPlaylist,
        }),
      });
    }

    if (req.method === 'POST' && p === '/api/download') {
      if (!ytDlp()) return json(res, 500, { error: '未找到 yt-dlp' });
      const body = await readBody(req);
      const urls = parseUrls(body.urls).filter(validUrl);
      const outDir = validOutDir(body.outDir) ? path.resolve(body.outDir) : CFG.outDir;
      if (!urls.length) return json(res, 400, { error: '没有有效的 http(s) 链接' });
      const st = dirStatus(outDir, CFG.strictVolume);
      if (!st.usable) {
        return json(res, 409, { error: `输出目录不可用：${st.reason || '不可写/未挂载'}`, dir: st });
      }

      const jobId = `j${++jobSeq}`;
      const job = {
        id: jobId, urls, outDir,
        client: sanitizeClient(body.client || CFG.client),
        allowPlaylist: !!body.allowPlaylist,
        clients: new Set(), history: [], status: 'running',
        cancelled: false, createdAt: Date.now(),
      };
      jobs.set(jobId, job);
      json(res, 200, { jobId });
      runJob(job).catch((e) => {
        job.status = 'done';
        emit(job, { type: 'job_done', error: e.message });
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/events') {
      const job = jobs.get(url.searchParams.get('jobId'));
      if (!job) return json(res, 404, { error: '任务不存在' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      job.clients.add(res);
      for (const e of job.history) {
        try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* ignore */ }
      }
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        job.clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/cancel') {
      const body = await readBody(req);
      const job = jobs.get(body.jobId);
      if (job) { job.cancelled = true; emit(job, { type: 'log', line: '已请求取消当前任务' }); }
      return json(res, 200, { ok: !!job });
    }

    if (req.method === 'POST' && p === '/api/open') {
      const body = await readBody(req);
      const target = body.path || CFG.outDir;
      if (!validOutDir(target)) return json(res, 400, { error: '路径不合法' });
      const root = (body.outDir && validOutDir(body.outDir)) ? path.resolve(body.outDir) : CFG.outDir;
      const resolved = path.resolve(target);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return json(res, 400, { error: '只能打开输出目录及其子目录' });
      }
      const isFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
      launchDetached(fileManagerBin(), fileManagerArgs(resolved, !!body.reveal && isFile));
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const next = PORT + 1;
    console.log(`端口 ${PORT} 已被占用，尝试 ${next}…`);
    PORT = next;
    server.listen(PORT, HOST);
    return;
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`BGM Grab 已启动: http://${HOST}:${PORT}/`);
  console.log(`yt-dlp: ${ytDlp() || '未找到（请设置 YT_DLP 或在页面配置）'} ${VERSION || ''}`);
  console.log(`ffmpeg: ${CFG.ffmpeg || '未找到'}`);
  console.log(`输出目录: ${CFG.outDir}`);
  console.log(`配置文件: ${CFG.configPath}`);
  console.log('按 Ctrl+C 停止。');
  if (!process.env.NO_OPEN) {
    launchDetached(process.platform === 'win32' ? 'explorer' : 'open', [`http://${HOST}:${PORT}/`]);
  }
});
