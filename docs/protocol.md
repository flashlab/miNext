# Open-XiaoAI 线协议文档(逆向整理)

来源:`idootop/open-xiaoai` 仓库 `packages/client-rust` 源码(协议权威定义)+ 本地 miMusic `main.py` 实际调用佐证。
本文档仅覆盖 miNext 用到的子集:事件接收 + `run_shell` RPC。音频流(`Stream` 帧、`start_play`/`start_recording`)未使用,仅存档。

## 1. 传输层

- WebSocket。音箱上的 client 主动连接 `ws://<server_ip>:<port>`(地址写在音箱 `/data/open-xiaoai/server.txt`)。
- 断线后 client 每 1s 自动重连,无鉴权、无路径要求、无自定义 header。
- 一方一个连接;新连接到来即可替换旧连接。

## 2. 帧格式

### 文本帧:AppMessage(serde 外部标签枚举)

```jsonc
// 三种之一,外层必带类型标签
{"Event":    {"id": "uuid", "event": "instruction", "data": ...}}
{"Request":  {"id": "uuid", "command": "run_shell", "payload": ...}}
{"Response": {"id": "uuid", "code": 0, "msg": "success", "data": ...}}
```

### 二进制帧:Stream(存档,miNext 不用)

Stream 结构体的 JSON 字节:`{"id","tag":"play"|"record","bytes":[...u8 数组],"data"?}`。
- `tag=play`:server→client 推音频(配 `start_play` RPC 使用)
- `tag=record`:client→server 麦克风音频(配 `start_recording` RPC 使用)

## 3. Client → Server 事件(Event)

client 在音箱上跑三个监视器,变化时推事件:

### 3.1 `instruction`(核心)

`data` = FileMonitorEvent:`{"NewLine": "<一行 JSON 字符串>"}`(偶有 `"NewFile"`)。

内层行解析为 LogMessage:

```jsonc
{
  "header": {"dialog_id","id","name","namespace"},
  "payload": { ... }  // untagged 枚举,按字段形态区分
}
```

关键 payload:
- **ASR 结果**:`header.namespace=="SpeechRecognizer" && header.name=="RecognizeResult"`,`payload={is_final, is_vad_begin, results:[{text, confidence, ...}]}`。只有 `is_final==true` 的 `results[0].text` 是可靠指令文本。
- **小爱回话**:namespace 含 `tts`/`speechsynthesizer`/`nlp`/`dialog`/`assistant`,payload 或行内某处含 text/reply/answer/content 等键的字符串。`SpeechSynthesizer`+`Speak` 事件 = 小爱在说话(用于应答打断)。

### 3.2 `playing`

`data` = `"Playing" | "Paused" | "Idle"`(单元枚举直接是字符串)。
client 每 10ms 轮询 `mphelper mute_stat`(1=playing,2=paused,其他=idle),状态变化才推。

### 3.3 `kws`(存档,自定义唤醒词)

`data` = `"Started"` 或 `{"Keyword": "<唤醒词>"}`。来自 `/tmp/open-xiaoai/kws.log`。

## 4. Server → Client RPC

### 请求/响应

```jsonc
// 发送
{"Request": {"id": "<uuid>", "command": "run_shell", "payload": "<脚本字符串>"}}
// 收 Response:id 对应,code=0 成功 / -1 失败,data 为返回值
{"Response": {"id": "<uuid>", "code": 0, "data": {"stdout": "...", "stderr": "...", "exit_code": 0}}}
```

- client 默认 10s 超时;server 端也应 10s 超时并清理 pending。
- client 并发处理上限 32(semaphore)。

### `run_shell`(唯一必需命令)

payload 是 shell 脚本字符串,在音箱上 `/bin/sh -c` 执行,返回 `{stdout, stderr, exit_code}`。

miNext 用到的脚本:

| 功能 | 脚本 |
|---|---|
| 播 URL | `ubus call mediaplayer player_play_url '{"url":"<u>","type":1}'` |
| 停止/暂停 | `mphelper pause` |
| 恢复 | `mphelper play` |
| TTS | `/usr/sbin/tts_play.sh '<text>'`(单引号需 `'\''` 转义) |
| 问小爱 | `ubus call mibrain ai_service '{"tts":1,"nlp":1,"nlp_text":"<text>"}'` |
| 播放状态 | `mphelper mute_stat`(stdout 含 1=playing/2=paused) |
| 麦克风开/关 | `ubus -t1 -S call pnshelper event_notify '{"src":3,"event":7}'` / event:8 |
| 唤醒 | `ubus call pnshelper event_notify '{"src":1,"event":0}'` |
| 中断小爱 | `/etc/init.d/mico_aivs_lab restart` |
| 设备型号/SN | `echo $(micocfg_model)` / `echo $(micocfg_sn)` |

成功判定:多数 ubus 命令 stdout 含 `"code": 0`(注意有的无空格 `"code":0`)。

### 其他命令(存档,未实现)

`get_version`、`start_play`(payload=AudioConfig,随后推 Stream play)、`stop_play`、`start_recording`、`stop_recording`。

## 5. 连接生命周期与在线状态

- client `connect_async(url)` 成功即视为音箱**在线**;WS close/读取出错即**离线**。
- miNext 据此维护 `online` + `lastEventAt`,无需额外心跳(playing 监视器在播放状态变化时会有事件;空闲时可能长时间无事件,属正常)。

## 6. 与旧实现的对应

旧 `open_xiaoai_server`(PyPI 二进制,Rust PyO3)Python 绑定:
- `start_server(port)` ≈ 本文 WS server
- `register_fn("on_event", cb)` ≈ 订阅 Event(cb 收到的是去掉外层 `Event` 标签的内层对象)
- `run_shell(script, timeout_ms)` ≈ `run_shell` RPC
- `on_output_data(data)` / 音频流:未使用
