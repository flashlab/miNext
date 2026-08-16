# miNext

[English](README.md) | **中文**

统一管理刷机小爱音箱(open-xiaoai client)的工具。全栈 [Bun](https://bun.sh)——后端**零 npm 依赖**(内置 WebSocket、SQLite、文件服务),前端 React + shadcn/ui + Tailwind。

## 功能

- **音箱实例**——多音箱管理(每台一个 WebSocket 端口),实时在线状态、型号/序列号、每实例语音关键词;运行时增删改,端口即时重绑免重启
- **播放控制**——每音箱独立队列,循环模式(关/单曲/列表/随机),拖动排序,单曲菜单(立即播放/置顶/下一首播放/删除),播完当前即停,播放/停止合并按钮,**音量滑杆**
- **语音指令**——完整移植 miMusic 指令管道:播放本地<关键词>/随便听听/上一首/下一首/停止/继续/刷新曲库,支持歌手/专辑限定(许嵩唱的…、范特西中的…),音量类指令打断白名单+自动恢复
- **音乐库**——ffprobe 建索引存 SQLite,歌名/歌手/专辑/文件名组合搜索,服务端分页排序,多选批量播放/追加/删除,专辑视图,曲库路径管理+分目录上传
- **工具**——播放任意 URL、TTS、向小爱提问、音箱 shell 高级控制台
- **界面**——明/暗/跟随系统主题,Linear 风石墨+琥珀紧凑设计

## 架构

```
小爱音箱(刷机,open-xiaoai client-rust)
      │  WebSocket(主动外连,断线 1s 自动重连)
      ▼
miNext(Bun 单进程)
  ├─ 每音箱一个 WS server  ── instruction 事件 / run_shell RPC(见 docs/protocol.md)
  ├─ HTTP :3000            ── REST API + 前端 + 音乐文件服务(Range)
  ├─ SQLite(bun:sqlite)   ── 歌曲 / 音箱实例 / 设置
  └─ ffprobe 索引器        ── 扫描配置的曲库目录
```

线协议由公开的 client 源码逆向还原(官方 server 是闭源 PyPI 二进制)。完整文档:[docs/protocol.md](docs/protocol.md)。

## 环境要求

- 已刷机的小爱音箱(LX06 / OH2P)并运行 open-xiaoai client——见[刷机教程](https://github.com/idootop/open-xiaoai/blob/main/docs/flash.md)
- 主机安装 [Bun](https://bun.sh) ≥ 1.3(Intel N100 等无 AVX2 的 CPU 必须用 **baseline** 版本)
- 主机安装 `ffprobe`(ffmpeg)
- Node.js 仅用于构建前端

## 快速开始

```bash
# 1. 配置
cp minext.config.example.json minext.config.json   # 编辑 lanHost、musicDirs、音箱端口

# 2. 后端(零依赖)
bun run src/index.ts

# 3. 前端(构建一次)
cd web && npm install && npm run build && cd ..    # 由后端托管 web/dist

# 4. 每台音箱的 /data/open-xiaoai/server.txt 指向 ws://<主机IP>:<端口> 并重启音箱
```

### systemd(用户级服务)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/minext.service ~/.config/systemd/user/   # 编辑 WorkingDirectory
systemctl --user daemon-reload && systemctl --user enable --now minext
sudo loginctl enable-linger "$USER"                # 登出后保活
```

### 开发

- `npx tsc --noEmit`——后端类型检查门禁(Bun 直接跑 TS 不做类型检查,部署前必跑)
- `scripts/deploy.sh`——SSH 增量部署;目标主机写在 `.env` 的 `MINEXT_DEPLOY_HOST=user@host`
- `.env` 由 Bun 自动加载且不进 git——v2 插件的 API key 放这里

## 路线图

- **v2**:插件化音源——搜索插件(`search(query) → 结果列表`)与音源插件(`resolve(结果) → 可播/可下载`),例如第三方音乐 API,或由 Hermes agent 经 yt-dlp 解析 YouTube 链接

## 致谢与声明

- 音箱 client 与灵感来源:[idootop/open-xiaoai](https://github.com/idootop/open-xiaoai)(MIT)。本项目为独立的服务端重实现,与小米公司无关。
- 仅供个人学习研究使用。

🌱 Built by [ZZBD](https://linux.do/u/zzbd/summary)
