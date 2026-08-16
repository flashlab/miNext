// 冒烟测试:模拟音箱 client,验证 WS 协议编解码 + RPC 回路 + 事件分发
// 用法: bun run scripts/smoke-ws.ts [port]
const port = parseInt(process.argv[2] ?? "54389");

const log = (m: string) => console.log(`[smoke] ${m}`);

// ---- 假音箱:WS server 模拟 client 行为(供 miNext 连接测试用) ----
// 注:真实链路是音箱作 client 连 miNext;这里反过来:miNext 的 SpeakerLink
// 需要被连接方是 client。为了自测,我们起一个"假音箱"作为 WS client 去连 miNext。
// 所以先起 miNext(另开进程),本脚本扮演 client。

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let rpcOk = false;
let eventOk = false;

ws.onopen = () => {
  log("已连接,发送 instruction 事件(ASR: 播放本地测试)");
  ws.send(
    JSON.stringify({
      Event: {
        id: crypto.randomUUID(),
        event: "instruction",
        data: {
          NewLine: JSON.stringify({
            header: { namespace: "SpeechRecognizer", name: "RecognizeResult" },
            payload: { is_final: true, results: [{ text: "播放本地" }] },
          }),
        },
      },
    }),
  );
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.Request) {
    log(`收到 RPC: ${msg.Request.command} payload=${JSON.stringify(msg.Request.payload)}`);
    if (msg.Request.command === "run_shell") {
      ws.send(
        JSON.stringify({
          Response: {
            id: msg.Request.id,
            code: 0,
            data: { stdout: '{"code": 0}', stderr: "", exit_code: 0 },
          },
        }),
      );
      rpcOk = true;
    }
  }
};

setTimeout(() => {
  log(`结果: RPC 回路 ${rpcOk ? "✅" : "❌"}`);
  process.exit(rpcOk ? 0 : 1);
}, 3000);
