/*!
 * @name 枫雨下载(miNext 内置默认)
 * @description 照 api-v2.yuafeng.cn 公开 API 自写的默认 lx 源,可审计;key 由宿主注入(lx.sourceConfig.ynxApiKey)。mg 解析上游已坏不声明
 * @version 1
 * @author minext
 */
(function () {
  var lx = globalThis.lx;
  var BASE = "https://api-v2.yuafeng.cn/API";
  // 枫雨音质映射:lx 档 → 枫雨 type(kw 实测值 48kaac/100kogg/128kmp3/192kmp3/320kmp3/2000kflac/4000kflac/20000kzp)
  var TYPE_MAP = {
    kw: { "128k": "128kmp3", "320k": "320kmp3", flac: "2000kflac", flac24bit: "4000kflac" },
    wy: { "128k": "standard", "320k": "exhigh", flac: "lossless", flac24bit: "hires" },
    tx: { "128k": "128k", "320k": "320k", flac: "flac" },
    kg: { "128k": "128k", "320k": "320k", flac: "flac" },
  };
  var QUALITYS = {
    kw: ["128k", "320k", "flac", "flac24bit"],
    wy: ["128k", "320k", "flac", "flac24bit"],
    tx: ["128k", "320k", "flac"],
    kg: ["128k", "320k", "flac"],
  };

  function getJson(url) {
    return new Promise(function (resolve, reject) {
      lx.request(url, { method: "GET", timeout: 20000 }, function (err, resp, body) {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error("响应非 JSON"));
        }
      });
    });
  }

  lx.on(lx.EVENT_NAMES.request, async function ({ action, source, info }) {
    if (action !== "musicUrl") throw new Error("action not support");
    var key = lx.sourceConfig.ynxApiKey;
    if (!key) throw new Error("未配置枫雨 API Key");
    var ep = source === "tx" ? "qq" : source;
    var idParam = source === "tx" ? "mid" : "id";
    var id = encodeURIComponent(info.musicInfo.id);
    var types = [];
    var mapped = TYPE_MAP[source] && TYPE_MAP[source][info.type];
    if (mapped) types.push(mapped);
    types.push(""); // 空 type 兜底(服务端默认档)
    for (var i = 0; i < types.length; i++) {
      var j = await getJson(
        BASE + "/" + ep + "music.php?" + idParam + "=" + id + "&type=" + encodeURIComponent(types[i]) + "&apikey=" + encodeURIComponent(key),
      );
      var d = j.data || j;
      var url = d && d.music;
      console.log("[ynx-default] " + source + "/" + info.type + " type=" + (types[i] || "(空)") + " code=" + (j && j.code) + " msg=" + ((j && j.msg) || "") + " music=" + (typeof url === "string" && url && url !== "0" ? "有" : "(空)"));
      if (j.code === 0 && typeof url === "string" && url !== "0" && /^https?:/.test(url)) return url;
      if (/用户组|apikey|访问被拒绝/.test(String((j && j.msg) || ""))) throw new Error("枫雨: " + j.msg); // 鉴权类不重试
    }
    throw new Error("枫雨: 直链为空");
  });

  lx.send(lx.EVENT_NAMES.inited, {
    status: true,
    sources: {
      kw: { name: "酷我", type: "music", actions: ["musicUrl"], qualitys: QUALITYS.kw },
      wy: { name: "网易云", type: "music", actions: ["musicUrl"], qualitys: QUALITYS.wy },
      tx: { name: "QQ音乐", type: "music", actions: ["musicUrl"], qualitys: QUALITYS.tx },
      kg: { name: "酷狗", type: "music", actions: ["musicUrl"], qualitys: QUALITYS.kg },
    },
  });
})();
