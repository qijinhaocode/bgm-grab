# bgm-grab

> Clipboard-to-MP3 local workbench for yt-dlp. 给剪辑人的素材入库台。

把 YouTube 链接变成 mp3，直接落到你的素材盘。不是又一个万能下载器 —— 只做音频、只管本机、只解决「把听到的曲子准确放进素材盘」这一件事。

## 为什么存在

做纪录片剪 BGM 时，真正的痛点不是「下载」，是这三件小事：

1. **预检防下错曲子** —— 粘贴后先显示标题和时长，确认无误再下。
2. **素材盘没接就拦截** —— 外置卷未挂载时直接拒绝下载，避免静默写进系统盘、素材散落。
3. **命令可审计** —— 一键复制等效的 yt-dlp 命令，可回终端手动跑、可改参数。

## 快速开始

前置依赖：**Node.js >= 18**、**yt-dlp**、**ffmpeg**（后两者需在本机可用）。

```bash
# 方式一：npx（推荐，零安装）
npx bgm-grab

# 方式二：clone
git clone https://github.com/qijinhaocode/bgm-grab.git
cd bgm-grab
node server.mjs
```

启动后浏览器自动打开 `http://127.0.0.1:<PORT>/`（默认 8765）。服务只监听本机，不对外暴露。

## 配置

配置按优先级从高到低读取：

1. **环境变量**：`YT_DLP`（yt-dlp 路径）、`BGM_OUT_DIR`（输出目录）、`BGM_PORT`（端口）、`BGM_CLIENT`（player_client）
2. **配置文件**：`~/.config/bgm-grab/config.json`
3. **自动推断**：yt-dlp 从 PATH、pyenv、常见 venv 位置自动发现；输出目录默认 `~/Downloads/bgm`

页面上也提供设置入口，改完即写入配置文件。

## 功能

- 粘贴链接（支持多行批量）→ 自动预检标题 / 时长
- 串行队列下载，实时日志 + 进度条
- 产物自动落到输出目录，可在 Finder / 文件管理器中显示
- 播放列表默认关闭，避免误拖整张歌单
- `player_client` 可切换，应对 YouTube 反爬策略变化
- 一键复制等效 yt-dlp 命令

## 测试

```bash
npm test        # 确定性单测：mock yt-dlp，不依赖网络
npm run test:live  # 真实下载自测（需 yt-dlp + ffmpeg + 网络，手动触发）
```

CI（GitHub Actions）在 push / PR 时跑 `npm test`。

## 开发流程

本项目采用 STORY 驱动的 issue-driven 流程，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 看板：https://github.com/users/qijinhaocode/projects/8
- 所有改动先建 `STORY-NNN` Issue，commit 首行绑号，由 git hook 强制。
- AI 绝不自动 commit/push，需用户明确放行。

## License

MIT
