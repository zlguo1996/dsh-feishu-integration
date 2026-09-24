# dsh-feishu-integration

> **中文优先 / Chinese first**

将飞书与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 双向连接：

- DSH 会话完成后，把总结发送到飞书；
- 在飞书中回复某条总结，自动路由回产生该总结的 DSH 会话；
- 支持 p2p 和群聊的固定会话延续；
- 在 DSH 设置页查看绑定状态、扫码绑定、重连、断开和解绑；
- 提供二维码 provisioning 和 `fsum-admin` CLI 管理入口；
- 支持飞书 Feishu 域和国际版 Lark 域。

## 安全默认值

公开安装包默认使用 `takeoverInbound: false`。这样安装时不会自动和已有的飞书长连接插件竞争事件流。

只有在同一个 DSH profile 中禁用其他飞书长连接插件后，才应启用入站接管：

```yaml
- id: xmanrui-dsh-feishu
  disabled: true

- id: dsh-feishu-integration
  config:
    takeoverInbound: true
```

飞书长连接使用集群式事件分发；同一个应用同时运行多个长连接客户端可能导致事件随机分流。

## 安装

在目标 DSH profile 中安装 GitHub 仓库：

```bash
dsh plugin --profile web add github:yangwuan55/dsh-feishu-integration
```

其他 profile 例如：

```bash
dsh plugin --profile headless add github:yangwuan55/dsh-feishu-integration
```

安装完成后重启对应的 DSH profile。插件自带 `dsh.bundle.patch`，会自动进入 profile；默认不会开启入站长连接。

安装后可在：

```text
设置 → 插件 → 飞书
```

查看当前绑定状态并扫码绑定。绑定状态和二维码由 DSH 设置页提供，不要求先使用 CLI。

## 启用入站回复路由

如果需要“回复飞书总结 → 路由回对应 DSH 会话”，先确认旧飞书长连接插件已禁用，再在 profile patch 中覆盖配置：

```yaml
- id: xmanrui-dsh-feishu
  disabled: true

- id: dsh-feishu-integration
  config:
    takeoverInbound: true
    replyTimeoutMs: 600000
```

配置文件通常是：

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

也可以使用全局 patch：

```text
$DSH_HOME/cordis.patch.yml
```

修改 patch 后可热重载配置；插件代码或依赖变化需要重启 DSH Web。

## 通知摘要与 LLM 配置

### 卡片形态与话题承接

每条完成的回合产生一条**话题根消息**：

```text
顶层消息（2.0 卡片）= 飞书话题根
├─ 标题：本回合提问在讲什么（≤20 字，formatter 产出；取不到来源时用「本回合回复」）
├─ 摘要：针对本回合提问的一句话（≤80 字）+ 0~3 条要点
├─ 元信息：turn N · cwd: X
└─ 线程回复：完整回复，**以卡片发出**（首条带 reply_in_thread=true，创建飞书原生话题）
```

完整回复**不在卡片里折叠**：读者点卡片上的「N 条回复 / 话题」进入线程读原文。卡片只承载「一眼看懂」，正文既不占卡身体积、也不额外增加一次点击。仅当线程能力不可用（`threadDelivery: false`）时才回退为「正文折回卡片/纯文本」。

⚠️ 线程里的完整回复**必须以卡片（interactive）发出**：飞书**纯文本消息不渲染 Markdown**，`**加粗**` 会原样显示成星号；只有卡片的 markdown 组件会渲染加粗/标题/列表/表格。分段按**卡片字节预算**切（30KB 硬上限），不是按字符数。老客户端不支持卡片时，该分段退化为纯文本（内容仍送达，但 Markdown 不渲染），并记 `thread-text-fallback` 日志。

formatter 的输入是三段式：`PRIOR_CONTEXT`（最近 5 条会话项 = 用户输入与当时的回复总结，缺失不补造）、`CURRENT_QUESTION`（本回合直接人类提问）、`CURRENT_ASSISTANT_REPLY`（本回合回复）。历史只用于消解指代，**不授权任何事实**：标题的事实来源是本回合提问，摘要/要点的事实来源是本回合回复。

每个回合产出的摘要**先落盘再投递**到 `$DSH_HOME/integrations/dsh-feishu/digest-history.json`（只存摘要文本，不存回复全文；每 session 保留最近 20 回合、7 天 TTL），供后续回合当历史背景。

出站总结的摘要由**发送层 LLM 受约束压缩**产出，不用会话模型、不产生会话回合。它默认**零配置**工作：provider/model 优先取下面的显式配置，未配置时取 DSH 设置页的 **agent 默认模型**；两者都拿不到才回退到确定性兜底（引用式标题 + 首段首句 + 首个列表块前 3 条）。

```yaml
- id: dsh-feishu-integration
  config:
    notificationFormatter:
      enabled: true                 # false = 完全关闭 LLM，只用确定性兜底
      provider: raven-cc            # 省略则继承 agent 默认模型的 provider
      model: deepseek-flash-latest  # 省略则继承 agent 默认模型的 model
      timeoutMs: 1500               # 硬 deadline，200–10000；超时即回退，绝不阻塞通知
      maxTokens: 400
    threadDelivery: true            # false = 不建话题，完整回复折回卡片/纯文本（降级）
    digestHistoryMaxTurns: 20       # 每个 session 保留的摘要历史回合数
    replyMaxChars: 9000             # 单个线程分段上限
    # title 已废弃：卡片标题改由 formatter 按本回合提问产出，不再使用固定文案
```

给通知单独指定一个更快/更便宜的模型就填 `provider` + `model`；想跟随日常用的模型就整块省略。两者必须**同时**给出才生效——只给一个会被忽略并回落到 agent 默认模型。

排障：摘要走兜底时宿主日志会打 warn 级记录，`reason` 直接指出断点：

- `no-model-route` — agent 默认模型没解析出 provider/model（既没显式配置，也读不到 agent 默认模型）；
- `llm-unavailable` — 这个组合里根本没有 `llm` 服务；
- `stream-error(<code> / HTTP <status> / <provider 原文>)` — 请求发出去了但 provider 报错（路由指向的本地代理没起、凭据失效等）；
- `empty-output(chunks=…,finish=…)` — 流正常结束但一个 text-delta 都没有；
- `unparsable-output` — 有输出但不是契约要求的 JSON；
- `title-too-long:<n>` — 标题超过 20 字（模型输出直接打回，代码不会替你「修好」）；
- `title-source-coverage` — 标题引用了本回合提问里没有的事实 token；
- `source-coverage` / `summary-too-long` 等 — 摘要/要点违反契约（例如引入了本回合回复里没有的数字）。

另有 `[总结] 摘要走确定性兜底: <reason>` 一行汇总。这些以前是 info 级、**磁盘上什么都看不到**，现在统一提到 warn。

## CLI 管理

设置页是推荐入口。CLI 仍然保留，方便自动化和无 UI 环境：

```bash
fsum-admin list
fsum-admin bind
fsum-admin bind --app-id cli_xxx --app-secret xxx --owner ou_xxx
fsum-admin verify --app-id cli_xxx
fsum-admin set-owner --app-id cli_xxx --open-id ou_xxx
fsum-admin unbind --app-id cli_xxx
```

二维码绑定使用飞书 SDK 的设备授权流程。凭据优先通过 DSH loopback credentials RPC 写入；在 DSH Web 未运行时才回退到本地 credential 文件。

## 数据与兼容性

插件保留旧 `@xmanrui/dsh-feishu` 的本地数据布局，以便迁移时延续已有绑定和固定会话：

```text
$DSH_HOME/integrations/dsh-feishu/config.json
$DSH_HOME/integrations/dsh-feishu/reply-map.json
$DSH_HOME/integrations/dsh-feishu/bots/<bot-id>/state.json
```

敏感的 `app_secret` 使用 DSH credential store，不写入公开配置文件。

## 默认会话策略（不引用会话时落在哪个会话）

`takeoverInbound=true` 时，入站消息先按 `parent_id/root_id` 查 reply-map，**命中就进命中的会话**。没命中时，按 `defaultSessionPolicy` 决定落到哪里：

| 值 | 行为 |
|---|---|
| `fresh`（默认） | **每条消息新建一个 DSH 会话**，不继承之前的任何上下文 |
| `fixed` | 复用 `conversationKey`（p2p 按发送者、群聊按 chat_id）对应的固定会话，上下文持续累积 |
| `idle` | 复用固定会话，但空闲超过 `defaultSessionIdleMinutes`（默认 30 分钟）就换一个新的 |

为什么默认 `fresh`：固定会话的上下文**只增不减** —— 聊得越久，每轮喂给模型的 token 越多，
最终要么撞上上下文上限、要么让后续回答开始失焦。每条消息开新会话能从根上避免这件事。

**连续性靠「引用」，不靠固定会话**：出站总结卡与机器人的每条回答都会写 reply-map；
在飞书里长按引用任意一条，即可回到它所属的会话继续上文。

```yaml
- id: dsh-feishu-integration
  config:
    defaultSessionPolicy: fresh   # fresh | fixed | idle
    defaultSessionIdleMinutes: 30 # 仅 idle 生效
```

`/help` 会把当前生效的策略播报给用户。未知的策略名会被收敛为 `fresh`（而不是静默沿用固定会话）。

## 路由行为

1. DSH 完成一次会话回合；
2. 插件向飞书发送文本总结；
3. 插件记录 `message_id → sessionId` 映射；
4. 用户在飞书中回复该总结；
5. 插件根据 `parent_id/root_id` 查找映射；
6. 命中后给这条入站消息加一个 `OnIt` 表情，表示「已收到、正在处理」；
7. 以 queue 模式把文本注入对应 DSH session；
8. 最终回答回帖到原飞书线程。

不再另发「已转发到对应 DSH 会话」的文字回执：`OnIt` 表情已经表达「已收到」，再补一条消息只是刷屏（2026-09-24 用户要求去掉）。需要知道「这一轮进了哪个会话」时看 host 日志里的那行 `[路由]/[默认·延续]/[默认·新建] <messageId> → <sessionId>`。

入站消息本身与最终回答都会写入同一个 `sessionId` 映射，因此用户继续回复或长按引用其中任一条时，仍会回到同一个 DSH 会话——去掉文字回执不影响「引用续聊」的能力。

**发送重试**：总结直发内置有界重试——最多 10 次尝试，指数退避（1s 起、30s 封顶、±20% 抖动）；重试等待期间用 DNS 探测 `open.feishu.cn` 做可达性门控，断网时顺延等待（不消耗尝试次数），总截止 10 分钟。每次逻辑发送携带飞书消息幂等 `uuid`，「已送达但响应丢失」不会重复投递。重试全部放弃时写入死信 `~/.dsh/integrations/dsh-feishu/pending-summaries.jsonl` 供排查（不自动补发）。

等待回答超时（默认 600s）时插件保持静默：不追发「处理失败」回帖、不追加错误表情——此时飞书侧只剩那个 `OnIt` 表情（刻意如此，避免用错误文案刷屏），超时仅记录在 host 日志中。其他真实错误仍会回帖提示。

由飞书回复触发的 DSH 回合带有 `fsum-` RPC 标记，不会再次生成总结，从而避免回环。

## 会话提问转接（answerFromFeishu）

DSH 会话执行中调用 `ask_user_question` 暂停等待用户回答时，回合不会结束，飞书侧原本收不到任何通知。`takeoverInbound=true` 且 `answerFromFeishu=true`（默认）时，提问桥打通双向链路：

1. 插件经本机 WebSocket（`/api/events.mux` 下行流）收到 `question/requested`；
2. 问题与选项格式化后发到该会话最近使用过的飞书线程（无历史线程则落到总结目的地）；多问题批次逐题串行：先发第 1 题，回答后自动发下一题，全部答完一次性提交；
3. 用户在飞书回帖：数字选选项（multiSelect 可「1、3」组合）、选项原文精确匹配、其余文本作为自定义回答；回复「取消」放弃整批（等价网页端取消）；
4. 插件组装结构化作答 POST `/api/respond`，成功后在原帖回「✅ 已把全部回答提交给会话」（含逐题回显），会话继续执行；
5. 网页端抢先作答时插件收到 `accepted:false`，静默补一条说明；问题被取消同理。

断线自动重连（1s→30s 退避），重放帧按 rpcId 去重不会重复发帖。该通道为纯下行 WebSocket + HTTP 上行，不占用也不影响飞书长连接数量约束。

## 验证

```bash
dsh web --dump-config
node --check lib/index.js
node --check lib/client.js
```

检查启动后的 Web 页面 `window.__DSH_BOOT__.entries` 是否包含 `dsh-feishu-integration`。如果设置页没有「飞书」，优先检查：

1. package.json 是否保留 `exports["./package.json"]`；
2. 旧飞书插件是否被禁用；
3. DSH profile 是否已经重启；
4. `dsh web --dump-config` 是否包含新插件 entry。

## 目录结构

```text
lib/index.js        组装根：config 解析 + 模块装配（无业务细节）
lib/host/           host 侧领域模块：bot 存储 / reply-map / 飞书 API /
                    总结推送 / session 网关 / 单 bot 入站运行时 / 设置页 RPC
lib/shared/         纯函数与常量（findReplyMapping 等测试缝）
client-src/         浏览器设置页源码（api / styles / index）
lib/client.js       由 client-src 构建生成的浏览器 bundle（勿手改）
scripts/            build-client.mjs：esbuild 打包出 ModuleLoader 包装产物
test/               node:test 回归（路由映射 / 入站顺序 / 提问卡片）
```

约束：一个 bot 只允许一个飞书长连接（集群模式多 client 会随机分流事件）；
`parent_id/root_id → reply-map → DSH session` 的路由语义与 `fsum-` 防回环前缀不可变。

## 开发

```bash
git clone https://github.com/yangwuan55/dsh-feishu-integration.git
cd dsh-feishu-integration
pnpm install
pnpm build          # client-src/ → lib/client.js（改前端源码后必须重建）
pnpm test           # node:test 全量回归
node --check lib/index.js
```

改 host 侧逻辑直接编辑 `lib/host/*.js`，无需构建；改设置页 UI 编辑 `client-src/`，
然后 `pnpm build` 重新生成 `lib/client.js`。发布包只含 `lib/`、`bin/` 与文档。

## English

`dsh-feishu-integration` connects Feishu/Lark and DeepSeek Harness in both directions:

- Send completed DSH turn summaries to Feishu;
- Route a reply to a summary back to the DSH session that produced it;
- Preserve fixed p2p/group sessions for unmatched messages;
- Provide a DSH settings tab with binding status, QR binding, reconnect, disconnect, and delete actions;
- Support QR provisioning and the `fsum-admin` CLI;
- Support both Feishu and Lark domains.

When an inbound message is routed to a mapped DSH session, the plugin immediately replies in the same Feishu thread with the workspace path, session title, and session ID. That acknowledgement message is mapped to the same session, so follow-up replies continue in the same conversation.

If the answer does not arrive before the timeout (600s by default), the plugin stays silent in Feishu — no failure message, no error reaction. The routing acknowledgement already served as the delivery receipt; timeouts are only logged host-side. Genuine errors still get a failure reply.

### Notification card and LLM configuration

Each completed turn produces one **thread-root message**:

```text
Top-level message (card 2.0) = Feishu thread root
├─ Title: what the current question is about (<=20 chars, produced by the formatter)
├─ Summary: one question-targeted line (<=80 chars) + 0-3 bullets
├─ Meta: turn N · cwd: X
└─ Threaded reply: the complete assistant reply, sent AS A CARD
   (the first reply carries reply_in_thread=true, which creates the native thread)
```

The full reply is **not** collapsed inside the card: readers tap Feishu's native reply-count entry and read it in the thread. ⚠️ Each thread chunk is sent as a **card** (msg_type interactive): Feishu **plain-text messages do not render Markdown** (`**bold**` shows the asterisks literally); only a card's markdown component renders bold/headings/lists/tables. Chunks are split by the card **byte** budget (30KB hard limit), not by character count. On clients that reject cards, that chunk degrades to plain text (content still delivered, Markdown unrendered) and logs `thread-text-fallback`. The card only carries the at-a-glance layer. The in-card collapsible panel remains solely as the explicit degradation when thread delivery is unavailable (`threadDelivery: false`).

The formatter input is three sections: `PRIOR_CONTEXT` (the latest five conversational items — user inputs and the summaries actually produced for those turns; missing summaries are never fabricated), `CURRENT_QUESTION`, and `CURRENT_ASSISTANT_REPLY`. Prior context only resolves references — it never authorizes a fact: the `title` is validated against the current question, and `summary`/`bullets` against the current reply.

Every produced summary is persisted to `$DSH_HOME/integrations/dsh-feishu/digest-history.json` **before** delivery (summary text only, never full replies; 20 turns per session, 7-day TTL), so later turns can use it as context.

The outbound summary itself is produced by a constrained **send-side LLM call** — it does not use the session model and does not open a session turn. It works with **zero configuration**: `provider`/`model` come from the explicit config below, otherwise from the DSH **agent default model** in Settings; when neither resolves, the plugin falls back to a deterministic digest (a quote-only title plus the first paragraph's first sentence and the first three list items).

```yaml
- id: dsh-feishu-integration
  config:
    notificationFormatter:
      enabled: true                 # false disables the LLM entirely (deterministic digest only)
      provider: raven-cc            # omit to inherit the agent default model's provider
      model: deepseek-flash-latest  # omit to inherit the agent default model's model
      timeoutMs: 1500               # hard deadline, 200-10000; on timeout it falls back, never blocks
      maxTokens: 400
    threadDelivery: true            # false = no thread; the full reply folds back into the card/text
    digestHistoryMaxTurns: 20       # summary-history turns retained per session
    replyMaxChars: 9000             # per-chunk limit for threaded replies
    # `title` is deprecated: the card title now comes from the formatter's per-question topic
```

Set `provider` + `model` to pin a faster or cheaper model for notifications only; omit the block to follow the model you already use. Both fields must be present together — a lone `provider` or `model` is ignored and the agent default model is used instead.

Troubleshooting: a summary that falls back logs `[formatter] agent 默认模型未给出 provider/model，回退确定性兜底` (warn) and `[总结] 摘要走确定性兜底: <reason>` (info). If neither source yields a model, the profile has no explicit config and the agent default model did not resolve either.

### Session question relay (`answerFromFeishu`)

When a DSH session pauses on `ask_user_question`, the turn never ends, so Feishu used to hear nothing. With `takeoverInbound: true` and `answerFromFeishu: true` (default), a question bridge closes that loop:

1. The plugin receives `question/requested` frames over a local WebSocket downlink (`/api/events.mux`);
2. The question and options are posted to the most recent Feishu thread of that session (or the summary destination when none exists); multi-question batches run as sequential rounds — question 1 first, the next one after each answer, submitted once when all are answered;
3. A thread reply is parsed as: option numbers (multiSelect allows "1、3"), an exact option label, or free text as a custom answer; replying "取消" cancels the whole batch (equivalent to cancelling in the web UI);
4. The plugin submits the structured answers via `POST /api/respond` and confirms in-thread with a per-question recap; if the web UI answered first (`accepted:false`) it posts a short note instead;
5. Reconnects replay pending frames — dedupe by rpcId prevents duplicate posts.

### Development

Host-side modules live in `lib/host/` and `lib/shared/` (plain ESM, no build step). The settings UI source lives in `client-src/` and is bundled into `lib/client.js` with esbuild — run `pnpm build` after editing it. `pnpm test` runs the regression suite (route mapping, acknowledgement copy, inbound ordering with a fake Lark SDK).

### Safe default

The package defaults to `takeoverInbound: false`. Enable inbound takeover only after disabling every other Feishu long-connection plugin in the same profile:

```yaml
- id: xmanrui-dsh-feishu
  disabled: true

- id: dsh-feishu-integration
  config:
    takeoverInbound: true
```

Feishu long connections use clustered event delivery. Running multiple clients for the same app can split events unpredictably.

### Install

```bash
dsh plugin --profile web add github:yangwuan55/dsh-feishu-integration
```

The package ships a `dsh.bundle.patch`, so it is automatically mounted into the profile. Restart DSH after installation, then open:

```text
Settings → Plugins → Feishu
```

The settings UI is the preferred way to inspect binding status and scan a QR code.

### CLI

```bash
fsum-admin list
fsum-admin bind
fsum-admin verify --app-id cli_xxx
fsum-admin unbind --app-id cli_xxx
```

### Compatibility

The plugin intentionally keeps the legacy local data paths under `$DSH_HOME/integrations/dsh-feishu/`, so existing bindings, reply maps, and fixed-session state can be reused during migration.

### Official discovery

DeepSeek Harness currently recommends publishing a public GitHub repository and adding the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic for discovery. This repository follows that convention.

## License

MIT. See [`LICENSE`](./LICENSE).
