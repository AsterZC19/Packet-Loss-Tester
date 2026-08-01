# 丢包测试 · WebRTC Packet-Loss Tester

基于 WebRTC 数据通道的丢包 / 延迟 / 抖动测试工具。服务器回显数据包,浏览器端计算指标。

传统测速用 TCP,TCP 会重传丢失的数据包,掩盖真实丢包。本工具用 WebRTC 数据通道
(`ordered:false, maxRetransmits:0`,基于 UDP/SCTP)发送带编号的数据包,测到的是真实丢包。

主指标是实测往返 RTT(客户端时钟,无需时钟同步)。

## 快速开始

```bash
npm install
npm start        # 打开 http://localhost:8787
```

localhost 即安全上下文,可直接测,无需 HTTPS。

## 指标

| 指标 | 说明 |
|---|---|
| 上传 / 下载丢包 | 发送后服务器未收到、回显后客户端未收到的比例 |
| 往返延迟 RTT | 一包一去一回的耗时,客户端时钟测量 |
| 抖动 Jitter | 相邻 RTT 的变化幅度(平均 / 最大) |
| 迟到包 | RTT 超过阈值的包 |
| 质量评级 | 丢包 + 延迟 + 抖动,评分 A–F |

丢包参考:0% 理想,<1% 可接受,1–2.5% 对游戏/语音有影响,>5% 严重。

## 预设

预设为按钮,点击联动更新参数;手动改参即变为自定义配置。

| 预设 | 包/秒 | 包大小 | 阈值 |
|---|---|---|---|
| 默认 | 15 | 212 B | 200 ms |
| 游戏（FPS） | 64 | 200 B | 80 ms |
| VoIP | 50 | 160 B | 150 ms |
| 视频通话 | 30 | 1200 B | 300 ms |
| 流媒体 | 10 | 512 B | 500 ms |

## 部署

浏览器使用 WebRTC 数据通道需要 HTTPS(localhost 除外)。

- 反向代理:nginx 模板见 `deploy/nginx.conf.example`,替换域名后使用;
- 进程内 TLS:`npm start -- --https --cert cert.pem --key key.pem`;
- 修改 `server/config.js` 中的 `public.hostname` 和 `servers`。

防火墙端口:

| 端口 | 协议 | 用途 |
|---|---|---|
| 8787 (可配) | TCP | 网页 + WebSocket 信令 |
| 49000–49100 | UDP | WebRTC ICE/DTLS/SCTP |

严格 NAT 下可配 TURN(见 `config.public.iceServers`)。

## 测试

```bash
npm test                 # 无头端到端测试(node-datachannel 模拟浏览器)
npm run test:browser     # 真实浏览器测试(Playwright + 本机 Edge)

# 服务器注入模拟丢包/延迟/抖动,验证指标
npm start -- --simulateLoss up=10,down=20,lat=50,jit=5
```

## 说明

- 基于 SCTP 数据通道,非裸 UDP,有自身拥塞控制;测量的是中等自控速率下的丢包,非洪泛丢包。
- 统计丢弃开测前约 1 秒样本(SCTP cwnd 预热)。
- 配置集中在 `server/config.js`;敏感项(如 TURN 凭据)放 `config.local.js`(已 gitignore)。

## License

MIT
