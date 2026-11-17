/**
 * 真实下载自测（手动触发：npm run test:live）
 * 需要真实 yt-dlp + ffmpeg + 网络。不进 CI。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.mjs';

const cfg = loadConfig();
if (!cfg.ytDlp) {
  console.error('未找到 yt-dlp，请设置 YT_DLP 或安装到 PATH');
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-live-'));
const VIDEO = 'https://www.youtube.com/watch?v=fbszJJr9I9U'; // This Will Destroy You - The Mighty Rio Grande / 11:18

const args = [
  '--ignore-config', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
  '--extractor-args', `youtube:player_client=${cfg.client}`,
  '--newline', '--no-warnings',
  '-o', path.join(outDir, '%(title)s.%(ext)s'),
  '--', VIDEO,
];

console.log('开始真实下载自测（约 15 秒）…');
const child = spawn(cfg.ytDlp, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code) => {
  assert.equal(code, 0, 'yt-dlp 应成功退出');
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.mp3'));
  assert.ok(files.length > 0, '应产出 mp3 文件');
  const mp3 = path.join(outDir, files[0]);
  const size = fs.statSync(mp3).size;
  assert.ok(size > 1024 * 1024, `mp3 大小应 > 1MiB，实际 ${size}`);

  const probe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', mp3], { encoding: 'utf8' });
  let out = '';
  probe.stdout.on('data', (c) => { out += c; });
  probe.on('exit', () => {
    const dur = Number(out.trim());
    assert.ok(dur > 660 && dur < 695, `时长应 ≈ 678s，实际 ${dur}`);
    console.log(`PASS 真实下载：${files[0]} / ${size} bytes / ${dur.toFixed(1)}s`);
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
