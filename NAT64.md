# NAT64 自动回退版

将 `_worker_nat64.js` 的完整内容粘贴到现有 Worker 的代码编辑器并部署。原始 `_worker.js` 保留不变；新文件是可单独部署的完整脚本，不需要导入其他项目文件。若用 Wrangler 部署，将入口指向 `_worker_nat64.js`。

## 现有配置

- 保留 `amclubs` KV 绑定和现有 `KV_CONFIG`，无需修改 UUID。
- `kv_pDomain`、`kv_p64Domain` 可以继续为空数组。
- 保留自定义域名 `trip.0x8.site` 和原客户端节点配置。
- 无需设置 `P64=true`，即使 `P64=false`，失败后也优先尝试 NAT64。

## 连接行为

默认顺序：目标直连 → NAT64 → 原有 PADDR 反代。显式配置的域名路由、SOCKS5 入口继续保留。

首次连接同步抛错、异步拒绝、建连超时、初始数据写入失败，以及尚未收到远端数据就关闭或读取报错，都会进入回退。NAT64 使用目标的 IPv4 / DNS A 记录合成 IPv6 地址，并保留目标端口。IPv4 字面量不再发起无效的 A 查询；纯 IPv6 目标不能用 NAT64，失败后继续尝试反代。

为避免将不完整的 TCP 会话重放到新连接，收到远端数据或开始发送后续客户端数据后，不再自动切换连接。首包重试仍可能重复执行已被远端接收、但尚未响应的请求。此机制适用于连接建立阶段的回退，不是会话迁移。

建连和 DNS 查询有超时；已建立但一直不响应的连接没有首字节超时，不会仅因沉默而重试。应用层 HTTP 403、验证码、TLS 拒绝不属于建连失败，无法保证通过 NAT64 解决。

## 可选 Worker 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `P64PREFIX` | `2602:fc59:b0:64::` | 沿用原脚本的 NAT64 网关前缀，仅支持 /96；也可写成 `2602:fc59:b0:64::/96` |
| `NAT64_DNS_TIMEOUT` | `3000` | A 记录查询超时，毫秒，范围 250–10000 |
| `TCP_CONNECT_TIMEOUT` | `1000` | 每次 TCP 建连超时，毫秒，范围 250–10000；跨网网关较慢时可设为 3000 |
| `PADDR` | 沿用原脚本公共反代 | NAT64 失败后的反代地址；空字符串可禁用该后备反代 |

上述参数也兼容原有 WebSocket URL 查询参数形式。

NAT64 前缀必须对应从 Workers 可达、允许访问目标的实际网关。保留默认前缀不等于验证了该公共服务当前可用；如失败，需要换成可用的 /96 网关前缀。

Cloudflare 官方说明 Workers TCP sockets 禁止直连 Cloudflare IP 范围：
https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations

## 验证

本地运行：

```sh
node --check _worker_nat64.js
node --test tests/nat64.test.mjs
```

测试使用真实脚本函数和 Web Streams，替换 Cloudflare TCP API 与 DNS 返回值；覆盖失败回退、端口和初始数据保留、后续上传、无错误重放、DNS 超时和前缀校验。这不是 Cloudflare 网络实测。

部署后通过代理访问之前失败的站点，在 Worker 日志中查看 `[direct] failed, trying NAT64` 和 `[nat64]`；如果出现 `[tryOnce] nat64 failed`，结合错误检查 DNS、前缀和网关连通性。已成功直连的请求不会出现 NAT64 日志。
