// lx 宿主本地验证台:加载源 → 打印声明 → 可选取链
// 用法:cd <含 data/lx-source.js 的目录> && bun run scripts/lx-test.ts [resolve <source> <id> [quality]]
// cwd 决定覆盖文件:data/lx-source.js 存在即覆盖内置默认源;YNX_KEY 环境变量注入宿主 key
import { lxDownload } from "../src/plugins/lxhost";

const ctx = {
  getSetting: () => ({}),
  getShared: (k: string) => (k === "ynx.apiKey" ? (process.env.YNX_KEY ?? "") : ""),
};

await lxDownload.load(ctx as never);
console.log("runtimeInfo:", JSON.stringify(lxDownload.runtimeInfo()));
console.log("sources:", JSON.stringify(lxDownload.sources));
console.log("qualities:", JSON.stringify(lxDownload.qualities));

if (process.argv[2] === "resolve") {
  const source = process.argv[3] ?? "wy";
  const id = process.argv[4] ?? "347230";
  try {
    const r = await lxDownload.resolve(
      { source, id, quality: process.argv[5] ?? "320k", meta: { title: "晴天", artist: "周杰伦", album: "叶惠美" } },
      ctx as never,
    );
    console.log("RESOLVED:", JSON.stringify(r));
  } catch (e) {
    console.log("RESOLVE-FAILED:", String((e as Error).message || e));
  }
}
process.exit(0);
