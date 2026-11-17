import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CLIENT, readFileConfig, writeFileConfig, loadConfig, resolveYtDlp,
  findOnPath, sanitizeClient, validOutDir, validUrl, parseUrls,
  buildCopyCommand, outputTemplate, dirStatus,
} from '../config.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-test-'));
}

test('sanitizeClient 去掉非法字符并兜底', () => {
  assert.equal(sanitizeClient('web_embedded'), 'web_embedded');
  assert.equal(sanitizeClient('tv,web_safari'), 'tv,web_safari');
  assert.equal(sanitizeClient('bad client!@#'), 'badclient');
  assert.equal(sanitizeClient(''), DEFAULT_CLIENT);
  assert.equal(sanitizeClient(undefined), DEFAULT_CLIENT);
});

test('validUrl 只接受 http(s) 且带 host', () => {
  assert.equal(validUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(validUrl('http://youtu.be/abc'), true);
  assert.equal(validUrl('ftp://example.com/x'), false);
  assert.equal(validUrl('not a url'), false);
  assert.equal(validUrl('https://'), false);
  assert.equal(validUrl(null), false);
});

test('validOutDir 拒绝根目录与系统目录，接受普通绝对路径', () => {
  assert.equal(validOutDir('/Users/me/Downloads/bgm'), true);
  assert.equal(validOutDir('/tmp/x'), true);
  assert.equal(validOutDir('/'), false);
  assert.equal(validOutDir('/System'), false);
  assert.equal(validOutDir('relative/path'), false);
  assert.equal(validOutDir(null), false);
});

test('parseUrls 支持数组与多行/空格分隔文本', () => {
  assert.deepEqual(parseUrls(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(parseUrls('https://a.com\nhttps://b.com https://c.com'),
    ['https://a.com', 'https://b.com', 'https://c.com']);
});

test('buildCopyCommand 保留原始固定参数并支持播放列表开关', () => {
  const urls = ['https://www.youtube.com/watch?v=abc'];
  const cmd = buildCopyCommand({ urls, outDir: '/tmp/bgm', client: 'web_embedded', allowPlaylist: false });
  assert.match(cmd, /--ignore-config/);
  assert.match(cmd, /--audio-quality 0/);
  assert.match(cmd, /--extractor-args 'youtube:player_client=web_embedded'/);
  assert.match(cmd, /--no-playlist/);
  assert.match(cmd, /-o '\/tmp\/bgm\/%\(title\)s\.\%\(ext\)s'/);
  assert.match(cmd, /'https:\/\/www\.youtube\.com\/watch\?v=abc'/);

  const withPlaylist = buildCopyCommand({ urls, outDir: '/tmp/bgm', allowPlaylist: true });
  assert.doesNotMatch(withPlaylist, /--no-playlist/);
});

test('outputTemplate 使用正斜杠，跨平台一致', () => {
  assert.equal(outputTemplate('/tmp/bgm'), '/tmp/bgm/%(title)s.%(ext)s');
});

test('配置分层：env > config.json > 推断', () => {
  const dir = tmpDir();
  const env = {
    HOME: dir,
    PATH: '/usr/bin:/bin',
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
  };
  writeFileConfig({ outDir: path.join(dir, 'from-file'), client: 'tv' }, env);

  const fromFile = loadConfig(env, dir);
  assert.equal(fromFile.outDir, path.join(dir, 'from-file'));
  assert.equal(fromFile.client, 'tv');

  const fromEnv = loadConfig({ ...env, BGM_OUT_DIR: path.join(dir, 'from-env'), BGM_CLIENT: 'web_safari' }, dir);
  assert.equal(fromEnv.outDir, path.join(dir, 'from-env'));
  assert.equal(fromEnv.client, 'web_safari');
});

test('loadConfig 在干净环境推断出 ~/Downloads/bgm 且不崩', () => {
  const dir = tmpDir();
  const cfg = loadConfig({ HOME: dir, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(dir, 'xdg') }, dir);
  assert.equal(cfg.outDir, path.join(dir, 'Downloads', 'bgm'));
  assert.equal(cfg.ytDlp, null);
  assert.equal(cfg.client, DEFAULT_CLIENT);
});

test('resolveYtDlp 通过 YT_DLP 环境变量找到可执行文件', () => {
  const dir = tmpDir();
  const fake = path.join(dir, 'yt-dlp');
  fs.writeFileSync(fake, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  const found = resolveYtDlp({ YT_DLP: fake, PATH: '/usr/bin:/bin' }, dir);
  assert.equal(found, fake);
});

test('resolveYtDlp 自动扫描 pyenv 版本目录（不写死版本号）', () => {
  const dir = tmpDir();
  const pybin = path.join(dir, '.pyenv', 'versions', '3.99.0', 'bin');
  fs.mkdirSync(pybin, { recursive: true });
  const fake = path.join(pybin, 'yt-dlp');
  fs.writeFileSync(fake, '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
  const found = resolveYtDlp({ PATH: '/usr/bin:/bin' }, dir);
  assert.equal(found, fake);
});

test('findOnPath 从 PATH 找可执行文件', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mybin'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findOnPath('mybin', { PATH: dir }), path.join(dir, 'mybin'));
});

test('dirStatus 正确报告存在、可写、可用空间', () => {
  const dir = tmpDir();
  const st = dirStatus(dir, false);
  assert.equal(st.exists, true);
  assert.equal(st.writable, true);
  assert.equal(st.usable, true);
  assert.equal(st.strict, false);
});

test('dirStatus 对不存在的目录返回 exists=false', () => {
  const st = dirStatus('/tmp/definitely-not-exists-bgm-test', false);
  assert.equal(st.exists, false);
  assert.equal(st.usable, false);
});

test('writeFileConfig 合并写入而非覆盖', () => {
  const dir = tmpDir();
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  writeFileConfig({ a: 1 }, env);
  writeFileConfig({ b: 2 }, env);
  assert.deepEqual(readFileConfig(env), { a: 1, b: 2 });
});
