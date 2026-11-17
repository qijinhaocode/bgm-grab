/**
 * 配置分层与平台适配 —— 纯函数为主，便于确定性单测。
 * 优先级：环境变量 > ~/.config/bgm-grab/config.json > 自动推断。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export const DEFAULT_CLIENT = 'web_embedded';
export const DEFAULT_PORT = 8765;

/* ---------------- 配置文件 ---------------- */

export function configDir(env = process.env) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'bgm-grab');
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'bgm-grab');
  }
  return path.join(os.homedir(), '.config', 'bgm-grab');
}

export function configPath(env = process.env) {
  return path.join(configDir(env), 'config.json');
}

export function readFileConfig(env = process.env) {
  try {
    const obj = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export function writeFileConfig(patch, env = process.env) {
  const next = { ...readFileConfig(env), ...patch };
  fs.mkdirSync(configDir(env), { recursive: true });
  fs.writeFileSync(configPath(env), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/* ---------------- 可执行文件发现 ---------------- */

export function findOnPath(bin, env = process.env) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of String(env.PATH || '').split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111))) return candidate;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111));
  } catch {
    return false;
  }
}

export function resolveYtDlp(env = process.env, home = os.homedir()) {
  if (env.YT_DLP) {
    const fromEnv = path.isAbsolute(env.YT_DLP) ? env.YT_DLP : findOnPath(env.YT_DLP, env);
    if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  }
  const fromPath = findOnPath('yt-dlp', env);
  if (fromPath) return fromPath;

  const pyenvBase = path.join(home, '.pyenv', 'versions');
  const pyenvCandidates = [];
  try {
    for (const v of fs.readdirSync(pyenvBase)) {
      pyenvCandidates.push(path.join(pyenvBase, v, 'bin', 'yt-dlp'));
    }
  } catch { /* no pyenv */ }

  const candidates = [
    ...pyenvCandidates,
    path.join(home, '.local', 'bin', 'yt-dlp'),
    path.join(home, 'bin', 'yt-dlp'),
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    'C:\\Program Files\\yt-dlp\\yt-dlp.exe',
  ];
  return candidates.find(isExecutable) || null;
}

export function resolveFfmpeg(env = process.env) {
  if (env.FFMPEG) return isExecutable(env.FFMPEG) ? env.FFMPEG : null;
  return findOnPath('ffmpeg', env)
    || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : null)
    || (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : null);
}

/* ---------------- 配置加载 ---------------- */

export function loadConfig(env = process.env, home = os.homedir()) {
  const file = readFileConfig(env);
  const outDir = env.BGM_OUT_DIR || file.outDir || path.join(home, 'Downloads', 'bgm');
  const rawPort = env.BGM_PORT || env.PORT || file.port || DEFAULT_PORT;
  const port = Number(rawPort) || DEFAULT_PORT;
  const client = env.BGM_CLIENT || file.client || DEFAULT_CLIENT;
  const strictRaw = env.BGM_STRICT_VOLUME ?? file.strictVolume;
  const strictVolume = strictRaw === undefined ? null : ['1', 'true', 'yes'].includes(String(strictRaw).toLowerCase());

  return {
    outDir: path.resolve(outDir),
    port,
    client: sanitizeClient(client),
    strictVolume,
    ytDlp: resolveYtDlp(env, home),
    ffmpeg: resolveFfmpeg(env),
    configPath: configPath(env),
  };
}

export function sanitizeClient(client) {
  const s = String(client || DEFAULT_CLIENT).replace(/[^a-zA-Z0-9_,:-]/g, '');
  return s || DEFAULT_CLIENT;
}

/* ---------------- 路径 / URL 校验 ---------------- */

const BLOCKED_ROOTS = ['/', '/System', '/Library', '/private', '/Applications', '/usr', '/bin', '/sbin'];

export function validOutDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  const normalized = path.resolve(p);
  const root = path.parse(normalized).root;
  return normalized !== root && !BLOCKED_ROOTS.some((b) => normalized === b || normalized.startsWith(b + path.sep));
}

export function validUrl(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  try {
    return !!new URL(u).hostname;
  } catch {
    return false;
  }
}

export function parseUrls(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw || '')
    .split(/[\n\r]+/)
    .flatMap((line) => line.trim().split(/\s+/))
    .filter(Boolean);
}

/* ---------------- 目录状态 ---------------- */

export function dirStatus(outDir, strictVolume = null) {
  const result = {
    outDir, exists: false, writable: false,
    mounted: true, mountCheck: false, freeBytes: null,
    device: null, strict: false, usable: false, reason: '',
  };
  try {
    const st = fs.statSync(outDir);
    if (!st.isDirectory()) {
      result.reason = '路径存在但不是目录';
      return result;
    }
    result.exists = true;
    fs.accessSync(outDir, fs.constants.W_OK);
    result.writable = true;
  } catch (e) {
    result.reason = e.code === 'ENOENT' ? '目录不存在' : e.message;
    return result;
  }

  // 只有看起来像 macOS 外置卷（/Volumes/xxx）时才强校验挂载；
  // 内置路径不拦截，避免把正常目录误判成未挂载。
  const looksExternal = process.platform === 'darwin' && /^\/Volumes\/[^/]+/.test(outDir);
  result.strict = strictVolume === true || (strictVolume === null && looksExternal);

  if (process.platform !== 'win32') {
    try {
      const r = spawnSync('df', ['-k', outDir], { encoding: 'utf8', timeout: 8000 });
      const lines = (r.stdout || '').trim().split('\n');
      const cols = (lines[lines.length - 1] || '').trim().split(/\s+/);
      if (cols.length >= 6) {
        result.device = cols[0];
        result.freeBytes = Number(cols[3]) * 1024;
        result.mounted = cols[0].startsWith('/dev/');
        result.mountCheck = true;
        if (!result.mounted) result.reason = '外置卷未挂载（df 未报告磁盘设备）';
      }
    } catch (e) {
      result.reason = `无法确认挂载状态：${e.message}`;
    }
  }

  result.usable = result.exists && result.writable && (!result.strict || result.mounted);
  return result;
}

/* ---------------- 命令生成 ---------------- */

export function outputTemplate(outDir) {
  return path.join(outDir, '%(title)s.%(ext)s').replace(/\\/g, '/');
}

export function buildCopyCommand({ urls, outDir, client = DEFAULT_CLIENT, allowPlaylist = false }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const head = [
    'yt-dlp --ignore-config \\',
    '  -x --audio-format mp3 --audio-quality 0 \\',
    `  --extractor-args ${q(`youtube:player_client=${client}`)} \\`,
  ];
  if (!allowPlaylist) head.push('  --no-playlist \\');
  head.push(`  -o ${q(outputTemplate(outDir))} \\`);
  const tail = urls.map((u, i) => `  ${q(u)}${i < urls.length - 1 ? ' \\' : ''}`);
  return [...head, ...tail].join('\n');
}

/* ---------------- 平台适配 ---------------- */

export function fileManagerBin() {
  if (process.platform === 'darwin') return 'open';
  if (process.platform === 'win32') return 'explorer';
  return 'xdg-open';
}

export function fileManagerArgs(target, reveal = false) {
  if (process.platform === 'darwin' && reveal) return ['-R', target];
  if (process.platform === 'win32' && reveal) return ['/select,', target];
  return [target];
}

export function openBrowserArgs(url) {
  return process.platform === 'win32' ? [url] : [url];
}
