# 厂商诊断日志 · 逐次授权演示台

值班门户对嵌入的厂商诊断页读取设备日志实行**逐次人工批准**，防止 iframe 跳转、
刷新、切换设备后沿用旧授权。三源架构（FastAPI + 原生 JavaScript，零前端依赖）：

| 角色 | 源（origin） | 容器端口 | 职责 |
| --- | --- | --- | --- |
| 值班门户 portal | `http://localhost:8080` | 8080→8000 | 设备选择、申请展示、人工批准、日志取数与回传 |
| 获准厂商 vendor | `http://localhost:8081` | 8081→8000 | 诊断页，只能经 `postMessage` 申请，拿不到令牌 |
| 未获准站点 rogue | `http://localhost:8082` | 8082→8000 | 白名单之外的来源，所有申请被拒绝 |

三个容器使用同一镜像，按环境变量 `APP_ROLE` 切换角色；端口不同即浏览器意义上的不同源。

## 启动

```bash
docker compose up --build
```

浏览器入口：**<http://localhost:8080>**（建议 Chrome/Edge/Firefox 近期版本）。
停止：`Ctrl+C` 后 `docker compose down`。

无 Docker 环境时，本机安装 `pip install -r app/requirements.txt` 后开三个终端：

```bash
APP_ROLE=portal SELF_ORIGIN=http://localhost:8080 PORTAL_ORIGIN=http://localhost:8080 \
  VENDOR_ORIGIN=http://localhost:8081 ROGUE_ORIGIN=http://localhost:8082 \
  uvicorn --app-dir app main:app --port 8080
APP_ROLE=vendor SELF_ORIGIN=http://localhost:8081 PORTAL_ORIGIN=http://localhost:8080 \
  VENDOR_ORIGIN=http://localhost:8081 ROGUE_ORIGIN=http://localhost:8082 \
  uvicorn --app-dir app main:app --port 8081
APP_ROLE=rogue  SELF_ORIGIN=http://localhost:8082 PORTAL_ORIGIN=http://localhost:8080 \
  VENDOR_ORIGIN=http://localhost:8081 ROGUE_ORIGIN=http://localhost:8082 \
  uvicorn --app-dir app main:app --port 8082
```

## 演示剧本

### 1. 正常逐次授权

1. 门户顶部选择设备（两台样例：边缘网关 `dev-gw-01`、泵房控制器 `dev-pump-02`）。
2. 厂商 iframe 内点 **申请最近 20 条脱敏日志**。
3. 门户右侧“申请队列”出现申请卡片，点 **批准本次申请**（或“拒绝”）。
4. 批准后门户后端签发**一次性令牌**，门户用它调日志接口，再把 20 条脱敏结果
   仅 `postMessage` 回传给发起申请的那个文档。
5. 同一申请的批准按钮随即消失，再次调用也会被拦截；重复取数因令牌已消费返回 403。

### 2. 旁窗冒充（同源也不行）

- 门户按钮 **打开同源旁窗**：旁窗与门户同源，`event.origin` 合法，但它不是 iframe，
  被 `event.source === iframe.contentWindow` 校验拒绝。
- 厂商页按钮 **打开本厂商源旁窗**：与 iframe 同源（能过固定 origin 白名单），
  但来源窗口不同，同样被拒，不能形成绑定。
- 消息拒绝原因会分别显示在门户事件日志与旁窗结果区。

### 3. 未获准站点

- 门户点 **载入未获准站点**，iframe 跳到 8082；在该页点“发送日志申请/握手”，
  门户第一道**固定 origin 白名单**即拒绝，事件日志可见 `origin=...8082` 被拦。
- 该页“直接 fetch 门户日志接口”因无令牌且无 CORS 许可失败。

### 4. 跳转/刷新后的迟到结果

1. 把门户“取数延迟”调到 8 秒（0–30 可调，服务端钳制）。
2. 厂商页发起申请并批准，取数在途时立刻点 **重新加载 iframe**、
   或在厂商页点 **页内跳转**、或直接切换设备。
3. 门户推进“文档世代”，旧申请标记为**已失效**；迟到的取数结果回来后只做丢弃，
   新文档（新 `docId`）收不到任何旧数据。若令牌在批准往返期间就已换代，
   门户会主动把该令牌消费销毁，不发给任何窗口。

### 5. 厂商不能直读日志

厂商页 **直接 fetch 门户日志接口**：没有一次性令牌（令牌只存在门户主文档内存），
且门户不返回任何 CORS 头，跨源读取被浏览器拦截；`/api/approve`、`/api/devices` 同理。

## 安全设计与需求对应

| 需求 | 实现位置 |
| --- | --- |
| 逐次批准，无自动授权 | 每笔 `log:request` 生成独立申请卡片，仅 `pending` 且绑定有效时可批准一次 |
| 固定 origin 校验 | 门户消息处理第一道校验 `event.origin === VENDOR_ORIGIN`；后端 `/api/approve` 独立校验 `Origin` 头 |
| 实际 iframe 来源校验 | 第二道校验 `event.source === iframe.contentWindow`，同源旁窗/弹窗无法冒充 |
| 仅回复发起申请的文档 | 回传使用申请记录里的 `sourceWindow` + 固定 `targetOrigin`，并核对 `docId` |
| 每次加载重新绑定文档 | 厂商文档每次加载生成新 `docId` 并 `vendor:hello` 握手（150ms 重发消除 load/hello 时序竞争） |
| 每笔申请只能批准一次 | 前端状态机一次性流转 + 后端令牌 `pop` 消费，复用/错设备/伪造均 403 |
| 刷新/导航/切设备使旧申请失效 | 文档世代 `epoch` 单调递增，换代后在途申请全部 `invalidated` |
| 迟到结果不交给新文档 | 取数 `await` 前后两次 `isCurrentBinding()` 判定，失败即丢弃；厂商侧对未知 `requestId` 结果也丢弃 |
| 厂商无法直读日志接口 | 日志接口强制一次性令牌；无 CORS 头；令牌永不出门户主文档 |
| 设备与脱敏 | 两台设备各 24 条原始日志，接口只返回最近 20 条，服务端正则脱敏 IP/邮箱/手机号/ Bearer 令牌/十六进制摘要 |

其他加固：CSP（`default-src 'self'`、门户 `frame-src` 限定两个演示源、
各角色 `frame-ancestors` 限定门户）、`nosniff`、`Referrer-Policy: no-referrer`、
`base-uri 'none'`。

## 测试

无需第三方依赖（后端用标准库 + FastAPI 最小桩，前端用 Node `vm` + DOM 桩）：

```bash
python3 -I tests/run_backend_tests.py   # 39 项：脱敏、origin 校验、一次性令牌、角色隔离、延迟钳制
node tests/run_frontend_tests.js        # 35 项：绑定、冒充拒绝、世代失效、迟到丢弃、握手时序
```

## 目录结构

```
app/
  main.py              # FastAPI 应用：安全头、批准/取数接口、一次性令牌、角色隔离
  devices.py           # 两台设备样例与原始日志
  redact.py            # 日志脱敏
  requirements.txt
  Dockerfile
  static/
    portal/            # 8080 门户（index/probe + portal.js/probe.js）
    vendor/            # 8081 厂商诊断页（index/probe/navigated）
    rogue/             # 8082 未获准站点
docker-compose.yml     # 三容器三源
tests/                 # 标准库/Node 测试与桩
```

## 演示性质说明

令牌存储为单进程内存（uvicorn 单 worker），仅用于演示；生产环境应替换为带
TTL 的共享存储并加入审计、速率限制与认证。前端世代机制是授权生命周期的
主控，后端一次性令牌与 origin 校验构成纵深防御。
