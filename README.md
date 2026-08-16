# miNext

**English** | [中文](README.zh-CN.md)

A unified management hub for flashed XiaoAi smart speakers running the [open-xiaoai](https://github.com/idootop/open-xiaoai) client. Full-stack [Bun](https://bun.sh) — backend has **zero npm dependencies** (built-in WebSocket, SQLite, and file serving), frontend is React + shadcn/ui + Tailwind.

## Features

- **Speaker instances** — manage multiple speakers (one WebSocket port each), live online status, device model/SN, per-instance voice-command keywords, runtime add/edit/delete with instant port rebinding (no restarts)
- **Playback** — per-speaker queue with loop modes (off / single / list / shuffle), drag-to-reorder, per-track actions (play now / pin top / play next / remove), stop-after-current, merged play/stop toggle, **volume slider**
- **Voice commands (中文)** — the original miMusic pipeline, ported: 播放本地 <关键词> / 随便听听 / 上一首 / 下一首 / 停止 / 继续 / 刷新曲库, with artist/album qualifiers (许嵩唱的…, 范特西中的…) and a volume-command interrupt whitelist with auto-resume
- **Music library** — SQLite index built by ffprobe, combined search across title/artist/album/filename, server-side pagination & sorting, multi-select batch play/append/delete, album view, library path management with per-directory uploads
- **Tools** — play arbitrary URL, TTS, ask XiaoAi (NLP passthrough), and an advanced on-speaker shell console
- **UI** — light / dark / system theme, compact Linear-style graphite + amber design

## Architecture

```
XiaoAi speaker (flashed, open-xiaoai client-rust)
      │  WebSocket (dials out, auto-reconnect 1s)
      ▼
miNext (Bun, one process)
  ├─ WS server per speaker  ── instruction events / run_shell RPC (see docs/protocol.md)
  ├─ HTTP :3000             ── REST API + SPA + music file serving (Range)
  ├─ SQLite (bun:sqlite)    ── songs / speakers / settings
  └─ ffprobe indexer        ── scans configured music dirs
```

The wire protocol was reconstructed from the public client source (the official server ships as a closed PyPI binary). Full documentation: [docs/protocol.md](docs/protocol.md).

## Requirements

- A flashed XiaoAi speaker (LX06 / OH2P) running the open-xiaoai client — see the [flash guide](https://github.com/idootop/open-xiaoai/blob/main/docs/flash.md)
- [Bun](https://bun.sh) ≥ 1.3 on the host (on AVX2-less CPUs like Intel N100, use the **baseline** build)
- `ffprobe` (ffmpeg) on the host
- Node.js only for building the frontend

## Quick start

```bash
# 1. Configure
cp minext.config.example.json minext.config.json   # edit lanHost, musicDirs, speaker ports

# 2. Backend (zero dependencies)
bun run src/index.ts

# 3. Frontend (build once)
cd web && npm install && npm run build && cd ..    # served from web/dist

# 4. Point each speaker's /data/open-xiaoai/server.txt at ws://<host>:<wsPort> and reboot it
```

### systemd (user service)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/minext.service ~/.config/systemd/user/   # edit WorkingDirectory
systemctl --user daemon-reload && systemctl --user enable --now minext
sudo loginctl enable-linger "$USER"                # survive logout
```

### Development

- `npx tsc --noEmit` — backend typecheck gate (Bun runs TS without typechecking; run this before deploying)
- `scripts/deploy.sh` — rsync-style deploy over SSH; target host comes from `.env` (`MINEXT_DEPLOY_HOST=user@host`)
- `.env` is auto-loaded by Bun and gitignored — put plugin API keys here (v2)

## Roadmap

- **v2**: pluggable music sources — search plugins (`search(query) → results`) and source plugins (`resolve(result) → playable/download`), e.g. a third-party music API or a Hermes agent resolving YouTube links via yt-dlp

## Credits & disclaimer

- Speaker client and original inspiration: [idootop/open-xiaoai](https://github.com/idootop/open-xiaoai) (MIT). This project is an independent server-side reimplementation, not affiliated with Xiaomi.
- For personal/research use only.

🌱 Built by [ZZBD](https://linux.do/u/zzbd/summary)
