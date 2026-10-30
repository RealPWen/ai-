# 公司投研看板

项目目录：`sites/company-research/`。通用桌面前端和独立本地后端，德赛西威只是默认示例。「核心市场分歧」现在使用 **DeepSeek API**，先从 ima 读取研报并整理参考观点，再通过官方 Search API 联网核验，最后由 `deepseek-v4-pro` 的 Responses API 综合整理，整理最多 3 个问题的正反观点及证据，无需登录 ChatGPT。

## 启动

需要 Node.js 22+ 和 PostgreSQL。首次执行 `npm install`。后端 `.env` 配置：

```dotenv
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-v4-pro
```

密钥仅保存在后端 `.env`，权限建议 `0600`；`.env` 已被 Git 忽略，不会复制到网页构建。不要把密钥写入前端。默认使用 `deepseek-v4-pro`；也可将 `DEEPSEEK_MODEL` 设为账号模型目录可用的其他 DeepSeek 模型。检索由独立 Search API 完成，不依赖模型自行多轮调用工具。配置更改后重启后端。

在两个终端分别执行：

```bash
npm run backend   # http://127.0.0.1:8000
npm run dev       # http://127.0.0.1:8765
```

本机现有 launchd 网页及后端作业会常驻运行，无需重复启动。前端修改后执行 `npm run build` 并刷新；后端修改或 `.env` 更新后重启 `com.panwen.company-research.backend`。前端默认同源请求 `/api`，网页服务固定代理到本机后端。后端端口变更时同时设置网页服务的 `FRONTEND_BACKEND_PORT`。

### 使用 DeepSeek

1. 打开 `http://127.0.0.1:8765/#debates`，选择股票，自动读取该股票唯一保存的最新分歧。
2. 只有点击「生成分歧 / 更新分歧」才使用 DeepSeek API 检索和整理今日信息。
3. 更新成功原子替换旧内容，页面显示北京时间「最后更新」；生成、核验或保存失败时保留原内容与更新时间。数据截止日期仅影响行情、EPS、估值、关系和事件，不影响核心分歧。

页面初始化及重新聚焦时在后台仅读取安全配置状态，不执行推理；状态读取失败会禁止生成并显示原因。切换股票和读取已保存内容也不执行模型推理；切换数据日期不重读、不重置核心分歧。重新生成会产生新的 API 调用；取消等待仅停止前端等待，已提交的请求可能继续完成并计费。生成失败不会覆盖已有报告，不自动重试推理。

DeepSeek 的 401 密钥无效、402 余额不足、429 速率限制，以及模型配置、网络和超时错误会分别显示安全提示，不返回上游原始错误或凭据。核心分歧在取得 ima 正文后，先执行一次无工具的参考观点整理，再并行执行 3 个联网检索请求，最后执行一次无工具的综合整理；未取得 ima 正文时跳过第一轮模型调用并明确披露原因。研究仍须取得真实搜索记录，引用须与本次工具结果对应；模型记忆或生成的链接不能冒充已检索来源。核心分歧按股票保留一份当前内容，不按日期、服务商、模型或提示词分位置；报告保留实际来源、模型和提示词版本，切换配置不会隐藏已保存内容。

### ima 研报与联网综合生成

仅核心市场分歧接入「彭博社➕国际投行研报」。`IMA_RESEARCH_ENABLED=false` 可关闭；默认启用，凭证从 `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY` 或 `~/.config/ima/client_id`、`api_key` 读取，始终只在后端使用。上下游识别和涨跌归因沿用原有流程。

点击生成后，按公司名及证券代码执行最多 2 次 ima 关键词检索，各取一页候选；按标题日期排序，尝试读取最多 3 份相关 PDF/文本（单文件最多 24 MiB）。PDF 临时提取前 4 页，有需要时本机 OCR，临时原文件处理后清理。读取预算 90 秒，不做全库扫描或下载。需 Python `pypdfium2`、Pillow 和带 `eng+chi_sim` 的 Tesseract；当前机器自动检测 Codex 随附 Python，也可设置 `IMA_PYTHON`、`IMA_TESSERACT` 指向已安装运行时。仅有文件名日期时作为排序提示；日期须与首页文本一致才能作为已知发布日期。

取得的正文先由 DeepSeek 整理最多 3 条参考观点及待核验主题；这些观点与原始证据一起进入第二轮。现有 3 次联网检索包括证券身份和支持/反证搜索，然后综合生成最终结果。正常是 2 次模型调用，任何一次模型调用失败都不自动重试。ima 搜索、权限、额度或正文读取失败时，使用现有联网流程并在页面明确显示「本次未使用 ima 资料」；不是已完成混合研究。返回码 220021 后停止继续调用，当前进程在上海次日之前不再尝试；次日只有用户再次点击才探测，这不是对供应商精确恢复时间的承诺。

来源通过可信检索记录核对。`ima://` 仅是内部文档标识，不是公开下载地址；页面显示「ima 数据」、知识库、原始标题、机构、日期及可展开的实际读取片段。已保存报告同时保留参考观点及证据、获取状态和实际引用数量。原文识别存在误差，摘要不冒充全文；引用可追溯也不证明观点正确。同一机构及同一报告的转载不能作为独立双方。进程内成功读取结果复用 30 分钟，页面展示复用状态；重启后重新检索，不永久镜像知识库。

验证命令（会使用真实 DeepSeek 额度；写入临时隔离数据库表，不覆盖页面现有报告）：

```sh
node --env-file=.env scripts/verify-ima-pipeline.mjs live
# 仅验证后半段：回放此前取得的德赛西威真实研报，不能算实时 ima 成功
node --env-file=.env scripts/verify-ima-pipeline.mjs replay
```

结果保存到 `backend/storage/research-data/ima/pipeline-verification/`，分别记录实时与回放结果。恢复正常额度后仍需以 live 验证完整的云端读取流程。

### 同一 Wi-Fi 访问

网页服务支持 `FRONTEND_HOST=0.0.0.0 npm run dev`，可使用本机 Wi-Fi IPv4 的 8765 端口访问（`ipconfig getifaddr en0` 查询地址）。本机现有网页作业已监听局域网。电脑需保持开机并连接同一网络。

后端 8000 端口仍只监听本机。通过 8765 局域网网址访问时，权限与本机网页一致：可读取报告、生成及更新核心分歧和三个周期归因、AI 识别上下游、人工修改关系和测试连接；共用服务器的 AI 配置、连接状态及 PostgreSQL 数据库。仅点击生成或测试按钮才调用 AI，普通读取和轮询不触发推理。代理保留同源及 Host 校验，密钥仍只由后端使用。自选和研究笔记按姓名保存在同一 PostgreSQL 数据库；浏览器草稿备份仍按设备与访问网址独立保存。

### 研究笔记与数据库

笔记沿用自选栏当前姓名，在 `research_data.user_notes` 中按 `(owner_name, ticker)` 保存每位作者对每家公司的当前笔记。同名共用，没有密码验证，与现有自选身份规则一致。

| 字段 | 内容 |
| --- | --- |
| `owner_name` | 作者姓名（自选栏当前姓名） |
| `ticker`、`company_name` | 股票代码与公司名称 |
| `content` | 笔记原文，保留换行，最多 50000 字符 |
| `created_at` | 首次入库时间，由 PostgreSQL 生成 |
| `updated_at` | 最近保存时间，由 PostgreSQL 生成，页面按北京时间显示 |
| `version` | 防止旧页面覆盖较新笔记的版本号 |

输入停顿后自动保存；只有数据库确认成功才显示“已保存到数据库”。浏览器同时保留按姓名和代码区分的草稿，失败可重试。切换公司或姓名不会把旧请求的内容写入新公司的笔记。不同页面编辑冲突时保留草稿，并由用户选择版本。

首次选择姓名时，把该浏览器旧的未署名笔记迁入当前姓名，保留原存储键与内容；已归属的旧笔记不会重复迁入其他姓名。数据库已有不同原文时不覆盖，页面提示切换对应公司核对。旧笔记没有可靠的原始时间，`created_at` 记录迁入数据库的时间。

`GET /api/notes?owner=姓名&ticker=002920.SZ` 读取笔记，未保存时返回 `{ "data": null }`。`POST /api/notes` 接收 `{ "owner": "姓名", "ticker": "002920.SZ", "companyName": "德赛西威", "content": "笔记内容", "expectedVersion": 0 }`；新建版本为 0，更新需携带上次返回的 `version`，冲突返回 HTTP 409。

后端启动自动执行可重复的建表迁移；数据库备份会包含该表。2026-10-30 凌晨生成的旧 GitHub 上传包早于此功能，不含此表，上传前需重新导出最新数据和源码。

### 后端网络配置

`BACKEND_HTTP_TRANSPORT` 支持 `native` 和 `curl`。本机保留系统 `/usr/bin/curl` 传输，凭据通过标准输入发送，不进入子进程参数、环境或临时文件；保持 HTTPS 证书验证，不跟随重定向。`.env` 的 `NO_PROXY` 包含 `api.deepseek.com`，使 DeepSeek 官方 API 直连，其他既有代理配置继续保留。

连接测试最多等待 45 秒；每个检索请求最多 45 秒，整理生成最多 120 秒，总预算 5 分钟，前端等待上限 6 分钟。需要代理时修改 `.env` 的 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 并重启后端；原生环境代理另需支持 `--use-env-proxy` 的 Node 版本。

### 原 ChatGPT 模式

保留兼容路径：显式设置 `AI_PROVIDER=chatgpt` 并重启后端，恢复原 ChatGPT 套餐 OAuth 授权；生成须验证当前账号，已保存核心分歧仍使用本机单股内容库。可选 `CHATGPT_MODEL` 必须是账号实际可见模型。DeepSeek 模式不读取、刷新或撤销这些订阅凭据，也不使用 `OPENAI_API_KEY`。

## 接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 服务、AI 服务商、模型及提示词版本 |
| `GET /api/auth/status` | 当前服务商及安全配置状态，不返回密钥或凭据 |
| `POST /api/auth/chatgpt/start` | 仅 ChatGPT 模式：生成官方授权链接（JSON 空对象） |
| `GET /auth/callback` | 仅 ChatGPT 模式：官方 OAuth 回调 |
| `POST /api/auth/logout` | 仅 ChatGPT 模式：退出本项目（JSON 空对象） |
| `GET /api/auth/models` | 当前服务商的模型目录，不执行推理 |
| `POST /api/auth/test` | 显式最短 API 连接测试（JSON 空对象） |
| `GET /api/debates?ticker=002920.SZ` | 只按股票读取唯一当前内容，不调用推理；没有结果返回 `{ "data": null }` |
| `POST /api/debates/generate` | 按今日联网更新，通过核验和保存后覆盖同股旧内容，返回 `{ "data": report }` |

研究 POST 示例（需先配置 DeepSeek Key；始终检索上海时区今日的近期信息）：

```bash
curl http://127.0.0.1:8000/api/debates/generate \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"002920.SZ","companyName":"德赛西威"}'
```

`ticker` 必填，保留市场后缀与前导零；`companyName` 可选，只是名称提示，模型应以代码核实证券身份。旧客户端传入的 `asOf` 不再参与读取、研究日期或存储定位，更新始终以今日及之前 89 天为检索窗口；返回报告自己的 `asOf`、`windowStart` 和生成时间，不能将旧报告重标为今日。无法确认证券身份或缺少可核验来源时不替换原内容。

错误格式为 `{ "error": { "code": "…", "message": "…", "diagnostic": { "stage": "stream", "elapsedMs": 42000, "curlExitCode": 56 } } }`，诊断字段可选且仅包含白名单信息。DeepSeek 模式区分密钥、余额、速率、配置、网络、检索/生成超时、格式与代码不一致错误；原订阅模式保留授权诊断。失败结果不会替换已有有效内容，不自动重试付费调用。同一股票的并发更新请求合并为一次生成，即使旧客户端传入不同日期。

核心分歧保存在 `market_data.core_market_debates`，`ticker` 为唯一主键，`report` 为完整已审核 JSON，`updated_at` 为该份内容的真实生成时间。成功更新使用原子 UPSERT，新内容替换旧内容；数据库写入失败不会删除旧报告。内容长期保留，不随日线的一年窗口清理。未配置数据库时使用每股固定文件作为降级存储。

后端启动会仅导入来源归属可证明的旧共享 DeepSeek 缓存，每股选生成时间最新的一份，且不会覆盖数据库中的较新内容。旧账号分区报告不自动导入共享内容库。迁移不调用 AI，原文件仅作迁移备份，不再作为 PostgreSQL 模式的活跃版本。

## 提示词与结果

研究提示词统一放在 `backend/prompts/`：`core-debates.md` 为核心分歧，`return-attribution.md` 为涨跌归因，`relations-ai.md` 为网页上下游识别；这三份在后端启动时加载。`company-relations.md` 与 `company-relations-worker.md` 供离线批量研究使用。提示词仅保留业务判断、证据口径和执行契约；结构、证券身份、条数、日期及引用校验继续由原后端负责，客户端不再重复追加长篇规则。修改在线提示词后重启后端生效，已保存报告保留，点击生成或更新时使用新版。

核心分歧提示词包含：

- 检索公司公告/IR、公开卖方研报、alpha派、雪球、TradingView 公开 Ideas、X 和其他公开资料。
- 正反双方围绕同一问题，保留作者/机构、日期、链接和引用范围；最多 3 条，允许不足或没有分歧。
- 区分 `source_view`（来源明确观点）、`model_inference`（有依据的研究假设）和 `insufficient`（证据不足）。缺少反方不编造机构或观点。
- 每条分歧标注已取得双方观点、研究假设或证据不足；雪球固定标记「低质量引用」。
- 平台覆盖如实列明取得内容、范围有限、未找到、未检索或需导入，不承诺所有平台都能访问。
- 日期晚于截止日的资料排除；日期未知只能作为背景，不能支撑某历史时点的明确观点。

报告包含 `company`、`summary`、`debates`、`sources`、`coverage`、`limitations`，以及后端生成的 `ticker`、`asOf`、`windowStart`、`generatedAt`、`updatedAt`、`provider`、`model`、`promptVersion` 和 `cached`。字段定义见 `backend/src/schema.mjs`。每方观点通过 `sourceIds` 关联具体来源。

来源链接与本次服务商搜索工具返回的 URL 元数据核对；未对应的链接移除，相关观点降级。`citationVerified` **只表示链接出现在搜索记录中，不代表内容真实或来源可靠**。未确认打开的页面标为搜索摘要；即使有打开记录，也保守标为部分正文，不宣称读到整篇报告。

当前不提供 alpha派、雪球或 X 的登录采集，不绕过付费内容；需要用户导入的材料会标记缺口，导入功能留待私有数据库阶段实现。公开搜索无法严格重建历史 point-in-time，作者、发布日期和观点语义仍需复核。

## 结构

```text
backend/
  server.mjs                 启动、AI服务商选择、数据库单股内容与旧缓存迁移
  app.mjs                    本机 HTTP/CORS/输入错误与接口
  prompts/core-debates.md     独立中文研究提示词
  src/
    deepseek-client.mjs       DeepSeek模型目录、固定检索、单次整理与安全错误
    deepseek-service.mjs      DeepSeek生成权限与单股内容服务
    chatgpt-auth.mjs          OAuth登录、PKCE、刷新和本项目退出
    oauth-jwt.mjs             官方JWKS签名与身份/nonce校验
    chatgpt-client.mjs         OAuth模型目录、SSE推理与研究请求
    curl-fetch.mjs            本机代理兼容的可选HTTPS流式传输
    subscription-service.mjs  套餐生成授权及账号切换校验，禁止Key回退
    openai-client.mjs          历史API Key客户端，当前服务不使用
    schema.mjs               输出结构与本地格式校验
    source-audit.mjs          引用对应、日期/证据/来源质量处理
    input.mjs                股票代码与日期校验
    research-service.mjs     研究生成、相同请求合并、并发限制
    debate-store.mjs         PostgreSQL每股单份核心分歧及旧文件迁移
    debate-schema.sql        ticker唯一主键的当前内容表
    cache.mjs                无数据库时的单股原子文件存储
    errors.mjs               不含密钥的结构化错误
  storage/chatgpt/            本项目host/注册/凭据；文件0600、目录0700；Git忽略
  storage/debates/            旧JSON迁移来源/无数据库时单股文件；Git忽略
frontend/
  config.js                  公开服务地址，禁止写入 API Key
  src/api/                   独立 GET/POST 请求和接口路径
  src/services/              后端响应 → 展示模型
  src/views/                 正反观点、来源、平台覆盖和其他模块展示
  src/features/              AI状态、研究任务状态/结果版本、标的切换、日期和笔记
  src/data/companies.js       初始选择项与通用研究问题
scripts/build.mjs            仅将 frontend/ 复制到 dist/
tests/                       HTTP、API、引用、缓存和前端适配测试
```

前端顶部显示当前研究标的，点击名称或搜索框可打开股票选择面板，也可在非输入状态按 `/`。已入库的 A 股及完整在市目录中的港股公司支持名称/代码搜索，可切换“全部 / A 股 / 港股”筛选，输入防抖并取消旧请求。港股目录中尚无日线的公司也可搜索，行情显示实际缺失状态。港股代码保留五位数字及 `.HK` 后缀，例如 `00700.HK`；可搜索“腾讯”或“00700”。其他市场仍仅筛选本地记录。最近使用最多保存 8 条名称与代码，仅保存在当前浏览器。

左侧自选栏可将当前股票加入自选，点击名称切换完整看板，点击 `×` 移出自选。`×` 前显示研究日期之前最近一个股票交易日的涨跌幅，红涨绿跌，悬停查看实际交易日；周末及假期取最近已有收盘日线，未取得数据显示 `—`。涨跌幅复用本地报价接口，以有限并发读取并在内存中去重，切换研究日期会取消旧请求。列表按添加顺序保存在当前浏览器（`company-research.watchlist.v1`），刷新后保留，仅保存公司标识；不自动收藏示例股票。自选切换沿用笔记保存保护及旧请求取消逻辑。

选择股票后统一按当前 `ticker` 取数，取消旧请求并清空其他公司的内容；搜索和筛选本身不会调用研究接口。笔记继续按证券代码独立保存在当前浏览器，兼容原德赛西威笔记。

研究任务与当前展示报告独立管理：生成中保留上次结果并明确标注，显示已等待时间；成功后自动替换结果并恢复按钮，失败或取消时保留旧版本并说明原因。结果栏显著显示北京时间最后更新时间，报告信息保留实际研究截止日期、来源和模型；更新成功替换当前内容，不累计历史版本行。平台覆盖及引用来源默认折叠，点击观点引用编号会自动展开并定位来源。

### 日线数据库

A 股日线采集器从后端 `.env` 读取 `TUSHARE_TOKEN` 和 `DATABASE_URL`，使用 Tushare 官方 HTTPS API。港股当前配置采集全部在市公司主柜台的腾讯公开未复权日线；腾讯行情无需 Token，每日在市名单核对仍使用 Tushare Token。港股 PE/PB 和 EPS 均配置为全部在市公司范围，供应商无数据时明确保留缺口。数据库为本机 Postgres.app 中的 `company_research`；表位于 `market_data` schema。

- `daily_prices`：按证券代码及交易日期唯一保存未复权日线、数据来源和采集时间。A 股 `vol` 单位为手、`amount` 单位为千元；港股成交量为股，报价及成交额币种按 HKD/USD 柜台保存并由单位列标注，腾讯未提供的成交额保留 `NULL`。
- `sync_days`：记录每个市场每个日期的完整导入或失败状态，便于重跑。
- `securities`：股票名称、行业分类及上市/退市资料；港股当前在市范围由 `hk_listed_universe.active` 确定。与历史价格分表，当前名称不代表历史时点名称。
- `daily_valuations`：`daily_basic` 原始 PE、PE-TTM、PB、市值、换手率和股本，缺失值保留 `NULL`。市值为万元、股本为万股、换手率为百分数。下载缓存独立放在 `valuations/A/`，完成记录以 `source_api` 区分，日线完成不会跳过估值。
- `hk_daily_valuations`：投资池 28 只港股的百度股市通历史 PE-TTM、PB，单位为倍；按代码和实际交易日期唯一保存，负数与明确缺失值保留。原始响应和逐股采集记录分别在 `HK-valuations/` 缓存与 `hk_valuation_update_runs` / `hk_valuation_symbol_runs` 表。
- 下载缓存和状态在 `backend/storage/market-data/`，已被 Git 忽略。Token 不进入日志、命令参数或缓存。

在项目目录运行，日期范围两端都包含：

```sh
# 下载并入库；已有完整日期自动跳过。
npm run data:sync -- --start 20251014 --end 20261013 --markets A --mode sync
# 只下载，暂不连接数据库。
npm run data:sync -- --start 20251014 --end 20261013 --markets A --mode download
# 从现有完整缓存离线入库，不调用 Tushare。
npm run data:sync -- --start 20251014 --end 20261013 --markets A --mode import
# 补齐同一区间每日估值；支持同样的 download / import / sync 模式。
npm run data:valuations -- --start 20251014 --end 20261013 --mode sync
```

港股日线当前使用 `.env` 的 `HK_PRICE_SCOPE=all`、`HK_PRICE_PROVIDER=tencent`，覆盖当前上市公司主柜台。`npm run data:hk:market` 可独立回填和断点续传；`npm run data:update -- --markets HK` 及每天北京时间 06:00 的原有调度均使用同一全市场流程。每天核对港交所证券名单与 Tushare `hk_basic(list_status=L)`，纳入主板、GEM、上市投资公司、合订证券及存托凭证，排除基金、衍生证券、临时并行柜台和人民币重复柜台。2026-10-19 核对目录为 2,769 个公司证券主柜台，其中 2,768 个 HKD，00770.HK 为唯一 USD 柜台。港交所文件标注 2026-10-20 的下一交易日准备名单，审计如实保留来源日期，并按本次在市状态、上市日期和官方上市文件确认 19 日范围。

目录及原始证据保存在 `backend/storage/market-data/hk-market/catalog/`，数据库目录为 `market_data.hk_listed_universe`。独立更新锁、逐股区间及尝试记录位于 `hk_market_update_runs`、`hk_market_symbol_ranges`、`hk_market_symbol_attempts`。近一年区间截至昨天，每股完成后只保留一年内记录及起点前一条真实收盘基准。腾讯空行情、连接失败不生成价格、不认证覆盖、不触发历史清理；其他股票继续下载，失败可断点重试。`--retry-no-data` 可重新请求本日空行情。周末或完整香港交易日历确认休市的区间可单独记录休市证明。`npm run data:hk:audit` 只读核验逐股覆盖、保留范围、来源、币种及单位，写入 `audits/hk-market-YYYYMMDD/database-verification.json`；有行情行数与已验证完整覆盖数分别统计。

PE/PB 与卖方 EPS 同样覆盖当前在市公司目录，分别由 `HK_VALUATION_SCOPE=all`、`HK_FORECAST_SCOPE=all` 控制。全市场股票均可搜索、切换和读取已入库日 K、估值及预测；供应商无覆盖、尚未采集或失败分别标注。原 `backend/market-data/hk-universe.json` 的 28 只工作簿投资池保留，可将相应范围显式设为 `pool`。

当前部署在 `.env` 显式配置 `HK_PRICE_PROVIDER=tencent`，使用腾讯未复权日线接口，与 [AKShare `stock_zh_ah_daily` 的不复权分支](https://github.com/akfamily/akshare/blob/main/akshare/stock/stock_zh_ah_tx.py)一致。只读取 `/appstock/app/kline/kline` 的 `day` 数组，不读取前/后复权数组。`source='tencent'`、`source_api='tencent_hk_daily'`，OHLC 为来源原值、成交量为股，币种按上市柜台和腾讯身份字段验证为 HKD 或 USD；没有成交额，`amount` 保留 `NULL`。昨收、涨跌额和涨跌幅由前一有效交易日的来源收盘价派生，缺少前价时保留 `NULL`，原始响应及推导方法保留在缓存中。

2026-10-19 首次投资池回填已成功下载并入库 **28 只、6,792 条腾讯日线**，数据截至 **2026-10-16**（最近交易日）。26 只各有 245 条，乐舒适从 2025-11-10 起有 231 条，智谱从 2026-01-08 起有 191 条；不伪造上市前价格。入库后已逐股票检查数量、日期、来源与名单。该次历史核验结果保存在 `audits/hk-pool-20261019/database-verification.json`，不代表当前全市场采集范围。

投资池模式可显式使用 `--hk-scope pool --provider eastmoney`，使用与 [AKShare `stock_hk_hist`](https://akshare.akfamily.xyz/data/stock/stock.html) 相同的东方财富参数及字段映射，提供 OHLC、成交量（股）和成交额（港元）。同模式也支持 `--provider yahoo`，读取 quote OHLC、忽略 adjclose，检查影响窗口的拆股并在有风险时拒绝按未复权口径导入；该源成交额未知，保留 `NULL`。2026-10-19 东方财富下载 19 只后持续连接提前关闭，Yahoo 单只测试成功但完整名单首只失败，因此该次投资池采集统一采用已完整验证的腾讯来源。程序不会在单次失败后静默切换来源。

2026-10-19 也再次使用当前 Token 按安踏体育单股票一年区间测试 Tushare，仍返回 `40203`、每小时 1 次的限制，减少股票数量不会改变账号额度。可用 `npm run data:update -- --markets HK --hk-scope pool --provider tushare` 显式重试投资池；完成进度按数据源独立记录。程序识别明确的小时/日额度后立即停止本轮请求，不用几秒退避重复请求。

[`hk_daily`](https://tushare.pro/document/2?doc_id=192) 支持指定交易日取全市场，或按股票及历史日期区间查询，单次最多 5,000 行，当日行情约 18:00 更新。该接口需在 Tushare 权限中心单独开通“港股历史日线”，不只看积分；分页也是独立调用。港股复权行情 `hk_daily_adj` 属于同一项单独权限，当前账号实测拒绝访问，不作为自动替代来源。

A 股 Tushare 采集按照交易日历，按日取全市场数据并分页直到空页。只有整个交易日下载、字段和唯一键校验通过，才写入完成标记；价格写入和完成标记在同一事务提交。开市日空结果会记为失败，停牌股票不填零。港股腾讯流程使用下文的逐股区间及独立完成记录。缓存可以断点继续，重复入库采用 upsert。

后端现已接入每日自动滚动更新，以下章节说明启动方式。Postgres.app 首次连接若弹出权限提示，请允许当前应用连接；电脑关闭期间不会采集。

股票资料初始化使用 `npm run data:securities`（可复用下载缓存），以后刷新名称/上市状态时使用 `npm run data:securities -- --refresh`。股票搜索返回在日线库中已有数据的 A 股及 `hk_listed_universe.active=true` 的全部港股公司，后者不以是否已有日线为搜索条件。市场筛选在数据库查询中执行，避免港股结果被 A 股搜索数量上限遮住。

港股全市场资料由 `data:hk:market` 及每日调度核对港交所与 [`hk_basic`](https://tushare.pro/document/2?doc_id=191) 后原子写入 `hk_listed_universe`，并同步名称和上市日期到 `securities`，不会删除旧证券历史记录。原 `npm run data:hk:securities -- --refresh` 仍是仅更新 28 只投资池资料的辅助命令，缓存位于 `securities/HK/pool-<名单hash>.json`，支持 `--mode download` 和 `--mode import`，不替代完整在市目录刷新。基础资料不参与一年日线清理。网页支持全部当前在市港股搜索、公司切换，以及已入库的行情快照、1M/6M/1Y 日 K 线和成交量。

2026-10-19 初次投资池阶段按用户要求将原先 3,288 条港股基础资料缩减为名单内 **28 条**，移除 3,260 条名单外资料。缩减前完整数据库记录备份在 `backend/storage/market-data/audits/hk-pool-20261019/securities-before-prune.json`；原始下载快照作为历史备份保留。缩减时库内港股日线为 0 条；后续全市场需求使用重新核对的当前在市目录，不以该旧快照界定范围。

### A 股与全市场港股行情只读接口

以下接口只读 PostgreSQL，不要求 ChatGPT 登录，不调用 Tushare 或 GPT。返回格式为 `{ "data": ... }`，异常沿用上文结构。

| 接口 | 参数 | 返回 |
| --- | --- | --- |
| `GET /api/stocks` | `q` 名称或代码，`market=all/A/HK`，`limit` 1–50，默认 20 | `[{ticker,name,market}]` |
| `GET /api/stocks/profile` | `ticker` | 名称、行业分类、资料来源，未收集业务简介不推断 |
| `GET /api/market/quote` | `ticker`，可选 `asOf` | 截止日之前最近收盘价、官方日涨跌、开高低、成交量额、同交易日 PE-TTM/PB 及各自日期 |
| `GET /api/market/prices` | `ticker`，可选 `asOf`、`period=1m/6m/1y`、`adjustment=none/qfq`、`benchmark=sw2021_l3` | `{ticker,points,meta,benchmark?}`，正序日线及可选申万行业指数，三级不可用时使用所属二级 |
| `GET /api/market/bands` | `ticker`，可选 `asOf`、`period=6m/1y`（默认 1y） | PE-TTM / PB 历史倍数、分位区间、最新值历史位置和实际数据范围 |
| `GET /api/relations` | `ticker`，可选 `asOf` | 已保存的上下游、同行、人工修正、证据及各公司的收盘、区间回报、同日 PE-TTM/PB；仅只读数据库 |
| `GET /api/events` | `ticker`，可选 `asOf`、`category=全部/公司/同行/上游/下游`、`limit=1–50`、`offset` | 截止日近三个日历月的已入库资讯、分页及实际采集覆盖情况 |

`ticker` 须为带后缀的 A 股代码，或 `hk_listed_universe.active=true` 的五位港股代码；港股日线不再限制为 28 只投资池。`asOf` 默认上海时区今日，拒绝无效日期及未来日期。历史查询始终限制 `trade_date <= asOf`。快照无记录返回 `null`，走势无记录返回空 `points`，不替换成其他股票数据。报价按原始收盘口径：A 股 CNY、成交量为手、成交额为千元；港股成交量为股，报价按 HKD/USD 柜台，成交额单位相应为港元/美元（腾讯未提供时为 `null`）。来源按实际数据库记录返回。后端启动时先创建目录与进度表，读接口不会因自动更新尚未运行而缺表。

前端 A 股 K 线继续请求前复权及申万行业对照；港股 K 线明确请求 `adjustment=none` 且不带行业指数参数，展示“港股未复权日 K 线”及真实来源、日期、币种和单位。全部在市港股的 PE-TTM、PB 接入百度股市通，逐券商 EPS 预测接入经济通；数据按股票逐步入库并明确显示源覆盖与采集状态。复权因子、申万分类保持未接入状态，不使用同公司 A 股的数据补值。切股清空上一标的数据；自选栏也可读取港股的实际涨跌幅。

A 股报价按同证券、同市场及**同价格交易日**关联 `daily_valuations`；港股从 `hk_daily_valuations` 精确关联所选价格交易日的真实估值，缺少同日估值则留空，估值日与价格日分别标注。两者返回 `peTtm`、`pb`、`valuationAsOf`、`valuationSource`、`valuationStatus`。缺失估值不从价格推算，也不把旧值写成新交易日记录。前端标注实际估值日和倍数，亏损或无有效 PE 不显示 0 倍，负 PB 按源值保留。

前端支持 1M/6M/1Y **日 K 线与成交量柱**、悬停和键盘选日、开高低收及成交量额读数。K 线实体表示开盘/收盘、影线表示最高/最低，红涨绿跌、平盘灰色，成交量同色；坐标与区间高低来自完整 OHLC。缺失或不合法的 OHLC 不会伪造成 K 线。实际数据日期、研究截止和库内截止分开展示；切换股票或研究日期会取消旧行情请求并清空旧图。当前已接入核心市场分歧、股票搜索/资料、A 股及港股行情、每日估值、卖方盈利预测、历史估值 band 和近期资讯；港股估值与 EPS 采集范围均为全部在市公司。接口通过 `adapters.js` 映射到展示模型。后端只监听 `127.0.0.1`，允许 8765 本地前端调用。

### 近三个月资讯

资讯按时间统一下载，再按公司名称、已验证别名或完整证券代码关联到日线库中的 A 股。采集不逐只股票重复请求，不调用 GPT。每家公司可能没有匹配资讯；名称匹配的依据保存在数据库中，不能视作事件影响或股价归因。

2026-10-15 当前 Token 曾成功取得 `major_news`；快讯 `news` 和公告 `anns_d` 当时探测为无权限。此前采用约每小时 30 次的保守采集节奏，但现存记录不足以证明这是账号的实际授权额度。2026-10-16 再次诊断时，历史/近期新闻、800 条/1 条请求均被上游拒绝。12:02（上海时间）绕过项目采集器，直接向官方 HTTPS 接口发送与官方示例一致的单来源、一分钟范围请求，不带 `limit` / `offset`、不要求正文，仍为 HTTP 200、业务码 `40203`、无数据；同一 Token 的 `stock_basic` 对照返回业务码 0、1 条数据。失败发生在上游新闻访问检查阶段，不能解释为历史数据已下载完。

`40203` 是响应 JSON 中的业务错误码，不是 HTTP 状态码；此次提示涉及频率，未披露具体配额和恢复时间，也未明确说明是否缺少独立新闻授权，不能仅靠这个数字认定权限或具体限流周期。[新闻接口说明](https://tushare.pro/document/2?doc_id=195)要求单独开通“新闻资讯”；[官方权限列表](https://tushare.pro/document/2?doc_id=290)将其与积分权限分开，正式新闻权限列示每分钟 400 次，不代表当前 Token 已取得该额度。需在账号权限中心核对授权及有效期，已授权但持续拒绝时由 Tushare 核查账号侧限制。

已取得的长篇资讯保存标题、正文、发布时间和媒体来源；该接口没有返回原文 URL，页面不伪造原文链接。交易所公告的专门采集与解读尚未接入。

```sh
# 默认从上海时间今天往前推三个日历月，下载至运行时刻并入库。
npm run data:news
# 已测过权限后可跳过探测；指定同一区间续传完整缓存及数据库窗口。
npm run data:news -- --no-probe --start 20260715 --end 20261014
# 离线将已完成下载的原始缓存重新入库，不调用 Tushare。
npm run data:news -- --mode import --start 20260715 --end 20261014
```

日期参数包含末日；精确时间参数使用左闭右开窗口，例如 `--end 2026-10-15T07:31:48Z`。达到返回上限时继续按时间切分，短页还会确认没有后续记录；只有完整窗口才入库并标记完成。表为 `market_data.news_articles`、`stock_news_links`、`news_sync_windows` 和 `news_source_status`。原始压缩缓存位于 `backend/storage/market-data/news/`，已被 Git 忽略。

新闻独立限速默认每 122 秒一次，遇到限流等待一小时继续，临时网络错误逐步退避。这是本地保守策略，不是 Tushare 的账号配额或一小时后恢复的承诺。默认首次失败后最多再重试 3 次，持续失败即保存 `incomplete` 进度并退出，不再无限重试；`NEWS_MAX_RETRIES` 可设置为 0–10。日志保存安全的上游数字错误码，不写原始报错、Token 或连接串。配置见 `.env.example` 中的 `NEWS_*`；调低间隔不会提高账号权限。重跑同一区间可续传。此采集器与每天 06:00 的行情更新独立。

2026-10-16 已按用户要求暂停 Tushare「每小时采集股票资讯」自动任务（ID：`automation-2`），并停止、卸载该新闻采集的临时 launchd 作业；该 Tushare 任务不会自动重试或继续下载。已入库文章和断点缓存保留，不能将进程停止视为历史采集完成。财联社每日更新使用下述独立来源，与这个暂停的每小时任务无关。

本次三个月初始化任务的日志在 `backend/storage/market-data/news/backfill.log`，PID 文件为同目录 `backfill.pid`。日志的 `news_wait` / `news_retry` 提供下次请求时间，`news_window_completed` 表示窗口已入库，最终 `news_summary.status=completed` 才表示该范围下载完成。

新闻采集此前由临时 macOS `launchd` 作业 `com.panwen.company-research.news-backfill` 运行。该作业现已卸载，配置仍保留于同目录 `backfill.once.plist`，未加入开机或登录启动。`backfill.log` 链接到 `~/Library/Logs/company-research/news-backfill.log`。不能只凭旧 PID 文件判断仍在运行；当前暂停状态及去敏诊断记录见 `backend/storage/market-data/news/diagnostic-20261016.json`。

网页和后端也由本机临时作业 `com.panwen.company-research.web`、`com.panwen.company-research.backend` 启动，日志位于 `~/Library/Logs/company-research/`。已有服务运行时无需重复 `npm run dev` / `npm run backend`；注销或重启后可在终端用上文命令重新启动。

前端「近期资讯与行业事件」默认显示公司资讯，仅展示公司、同行、上游、下游四个筛选，支持分页和默认折叠正文。关联公司采用已核验并入库的上下游关系；尚未补齐的关系不会编造。采集中仍展示已有资讯，并按已完成窗口的并集显示覆盖进度。点击「刷新列表」只重新读取本地库，不消耗 Tushare 或 ChatGPT 用量。后端保留显式 `category=全部` 兼容已有调用。

### 财联社官网公开文章

新增独立的 `cls_web` 来源，页面标注“财联社官网”并提供原文链接，不使用 Tushare Token 或 GPT。采集器读取公开首页中实际存在的文章链接，以及通过 `--urls-file` 提供的文章链接；只允许 `https://www.cls.cn/detail/数字`，不枚举文章 ID、不跟随重定向。正文来自公开 HTML，转换为纯文本；明确要求付费或登录的文章只保留公开标题和链接，不保存受限正文。股票关联优先使用官网标签，并校验本地 A 股证券字典；其余沿用名称和代码匹配。

```sh
# 默认按最近三个日历月过滤，低频读取首页发现的公开文章并入库。
npm run data:news:cls -- --max-articles 100
# 额外提供已发现的历史文章链接，每行一个，可配合 --no-homepage。
npm run data:news:cls -- --urls-file /absolute/path/cls-urls.txt
# 已下载缓存重新入库，不访问官网。
npm run data:news:cls -- --mode import --max-articles 1000
# 正常匿名列表协议，按时间游标连续回补你提供的栏目 1003。
npm run data:news:cls:history -- --max-pages 1000
# 使用原始冻结范围和已提交游标续传，不会改成新的结束时间。
npm run data:news:cls:history -- --resume --max-pages 1000
# 栏目返回空页时，可使用官网公开搜索继续回补更早文章。
npm run data:news:cls:search -- --keyword 财联社 --max-pages 1000
npm run data:news:cls:search -- --keyword 财联社 --resume --max-pages 1000
```

请求单并发，间隔至少 2 秒；403/429 立即停止，网络错误只有限重试。已下载文章缓存复用，按来源及文章 ID 幂等入库，不影响既有 Tushare 记录。`--max-articles` 在在线模式限制本轮新请求的文章数量，已有缓存不占新请求预算。原始缓存和进度记录位于 `backend/storage/market-data/news/cls_web/`，已被 Git 忽略。此命令是一次性采集，不会启用定时任务。

**范围过滤不等于历史全量采集。** 2026-10-16 的初版只读取首页和文章详情，遗漏了官网匿名列表所需的普通参数校验，因此列表请求返回 `10012`。2026-10-19 已核对官网公开客户端格式：该校验是公开参数的无密钥摘要，不需要账户 Token；按正常匿名请求格式，栏目初始化和历史翻页均已成功返回文章。此前将 `10012` 直接视为历史不可获取的结论已修正。探测与修正记录保存在同目录 `history-diagnostic.json`。

公开首页采集结果仍标注 `status: partial`、`coverageVerified: false`；文章存在或首末发布日期跨度不作为完整覆盖证明。历史游标采集也只代表所选栏目，不能冒充财联社全站或所有资讯平台已覆盖，不创建 `news_sync_windows` 完成窗口。前端继续展示已入库文章，公开摘要明确标为“摘要”，已有完整正文不会被摘要覆盖。

历史列表保存公开标题、摘要、发布时间及原文链接，以 `content_kind=summary` 区分正文；后续详情下载可升级为 `fulltext`，摘要或空内容重导不会降级已有全文。每页先缓存，成功入库后才推进游标。每次请求至少间隔两秒，页面重复、时间逆序、游标不下降、登录/权限/验证码或限流会停止并保留断点，不轮换身份或绕过限制。栏目返回条数可能与 `rn=20` 不同，不按固定条数截断或判断结束；翻至起点前并再次确认一页全部早于起点，才标记 `rangeReachedStart=true`、`status=range_reached`。同秒边界的不确定性保存在 warnings，`coverageVerified` 始终为 false。

本次历史回补采用一次性 launchd 作业 `com.panwen.company-research.cls-history-once`，`RunAtLoad=false`、`KeepAlive=false`，没有每小时或每日调度。进度在 `backend/storage/market-data/news/cls_web/channel-1003/`，`latest.json` 指向冻结范围的 `checkpoint.json`；日志在同级 `history.log`。原 Tushare 每小时任务继续暂停。

2026-10-19 栏目正常翻页在第 9 页后返回空列表，重新验证结果相同，游标约到 9 月 26 日；这不证明更早新闻不存在。官网公开搜索的第 100 页实际返回了 9 月 18 日文章，故增加匿名搜索回补。搜索固定 `type=depth`、默认关键词“财联社”，每页保存公开标题、摘要、日期和链接，沿页码续传，遇到实时索引插入造成的跨页重叠时告警并按文章 ID 去重。关键词结果、动态索引及页码遍历不代表全站无遗漏，报告保留 `scope`、`searchKeyword`、`historicalPointInTime=false`、`coverageVerified=false`。只有翻过起点并再次确认较早一页，才记为该关键词范围已触达。

公开搜索回补由一次性作业 `com.panwen.company-research.cls-search-history-once` 运行，配置为同目录 `search-history.once.plist`，没有周期性计划。日志为 `search-history.log`；进度位于 `search-<关键词哈希>/latest.json` 所指范围目录中的 `checkpoint.json`。`saved` 是幂等写入次数，去重后的实际文章数量应查询 PostgreSQL，不能直接拿累计写入数当新增新闻数。

2026-10-16 本次试采：首页发现 54 个文章链接，52 篇在请求范围内入库、2 篇越界排除；形成 192 条股票关联，涉及 158 只 A 股。已有文章发布日期从 2026-07-20 到 2026-10-16，但中间历史未连续回补。离线重新导入后仍为 52 篇，未重复增加记录，原有 2,828 篇 Tushare 新闻保留。江波龙（`301308.SZ`）资讯接口已验证可返回 4 篇财联社官网文章。

2026-10-19 回补结果：公开搜索累计读取 367 页，已触达上海时间 7 月 19 日起、10 月 19 日 11:41:42 之前的查询范围。去重后财联社文章池共 7,344 篇，其中全文 52 篇、摘要 6,864 篇、标题与链接 428 篇，关联 1,089 只 A 股。此为“财联社”关键词的公开资讯检索结果，不保证全站无遗漏或历史时点快照。完成后 `--resume` 验证请求数为 0，文章数不增加；原有 Tushare 2,828 篇保持不变。该次一次性采集作业已结束并卸载；随后按用户要求将财联社前一日增量接入下面的 06:00 共用调度，原 Tushare 每小时任务继续暂停。页面按“文章池”展示来源数量，与当前公司相关结果数量分开。

### 历史估值 band

EPS 模块下方的 PE-TTM / PB band 分别读取 A 股 `daily_valuations`、港股全部在市公司的 `hk_daily_valuations` 原始历史倍数，默认近一年，提供独立的近半年 / 近一年切换。展示每日走势、整段窗口的 P10/P25/P50/P75/P90 分位线，以及最新倍数、中位数和最新值历史分位；这不是 EPS/BPS 推算的股价估值带。

两种指标分别以窗口内正值样本计算统计。缺失、非有限及非正值保留日期缺口，不填零、不连接跨缺口走势；缺失与非正值分别计数。原始负值仍保存在数据库中，源端末日为空或非正时，最新倍数和当前分位不向前回退。少于 20 个有效样本只展示走势，暂不计算分位线与百分位。

分位数采用 Type 7 线性插值：对排序样本取位置 `(N-1)×p`，在相邻样本间插值。历史分位为 `100×(小于该值的样本数＋0.5×相等样本数)/N`，相同值使用中秩。整幅图按当前查询窗口统一计算，不能视为历史各日当时可获得的滚动分位。图表覆盖全部有效样本，不裁去极端倍数。页面保留核心指标、走势图和图例，不展示样本统计、分位数明细及技术脚注。

接口和图表无需 ChatGPT 登录，只读本地 PostgreSQL。切股、研究日期和估值窗口变化会取消旧请求、清空旧图及交互监听，并检查响应标的、日期和窗口与当前请求一致。官方指标口径见 [Tushare 每日指标](https://tushare.pro/document/2?doc_id=32)。

港股估值使用[百度股市通](https://finance.baidu.com)公开历史指标，调用方式对应 [AKShare 官方 `stock_hk_valuation_baidu` 实现](https://github.com/akfamily/akshare/blob/main/akshare/stock_feature/stock_hk_valuation_baidu.py)。PE 指标明确为 TTM；直接保存供应商公布的历史倍数，不用当前 EPS/BPS 回算。供应商原生包含周末沿用值，入库仅与已有 HK 日线的实际交易日相交；缺少任一实际交易日时保留部分进度、阻止成功收尾与清理，不向前填充。新上市股票仅保留上市以来记录。百度来源口径与 A 股 Tushare 来源分别标注。

```bash
# 独立回填或续传全部在市港股估值。估值本身无Token，刷新名册需要TUSHARE_TOKEN。
npm run data:hk:valuations
# 仅更新原投资池：
npm run data:hk:valuations -- --scope pool
```

2026-10-19 已回填 28 只港股共 6,792 个实际交易日估值记录，日期为 2025-10-20 至 2026-10-16；其中乐舒适为 231 条、智谱为 191 条，其余每股 245 条。每条均保存 PE-TTM 与 PB，负值保留用于核对，历史分位继续只纳入正值。

### 申万行业指数与前复权 K 线

前端行情图默认请求 `adjustment=qfq&benchmark=sw2021_l3`，展示前复权日 K 线、原始成交量及申万行业指数。查询参数保留兼容：优先选择区间内有可对齐行情的申万 2021 三级指数；三级未发布、缺分类、缺行情或无共同交易日时，尝试所属二级指数。整段图只使用一个指数，不逐日拼接层级。分类来自 Tushare 的申万接口，与 `securities.industry` 中已有的股票基本资料分类独立；历史研究日期也使用最新行业归属。

新增表均位于 `market_data`：

- `sw_industries`：三级行业目录及是否发布指数。
- `sw_industries_l2`：二级行业目录及是否发布指数。
- `sw_industry_members`：最新股票归属、一级至三级代码/名称及源端纳入/退出日期；完整快照验证后事务更新。
- `sw_industry_members_l2`：通过二级成员接口独立采集的股票标签，保留源端一至三级代码/名称。原三级成员没有当前记录时使用该来源，完整采集后事务更新。
- `sw_index_daily`：每个二、三级指数每个交易日的原始点位，所有同行业股票共用。
- `stock_adj_factors`：股票每日复权因子；原始 `daily_prices` 不被覆盖。

在项目目录首次补齐与已有行情相同的日期范围：

```sh
npm run data:industries -- --start 20251014 --end 20261013 --mode sync
npm run data:adjustments -- --start 20251014 --end 20261013 --mode sync
# 从现有完整缓存离线入库；也支持 --mode download 仅下载。
npm run data:industries -- --start 20251014 --end 20261013 --mode import
npm run data:adjustments -- --start 20251014 --end 20261013 --mode import
# 更新最新归属，并重新抓取指定范围的源端数据。
npm run data:industries -- --start 20261013 --end 20261013 --mode sync --refresh
# 将原来只导入三级的日期补为二级＋三级，复用已有原始日缓存。
npm run data:industries -- --start 20251015 --end 20261014 --mode sync --reimport
# 单独下载并入库完整二级成员标签，复用已下载的二级目录，不重下行情。
node --env-file-if-exists=.env scripts/sync-l2-members.mjs
```

采集器按日抓取全市场复权因子及申万指数，指数行情保存目录中已发布的二、三级指数。使用独立缓存、分页验证与断点续传，价格/因子写入和 `sync_days` 中相应 `source_api` 的完成标记在同一事务提交。刷新时以完整源数据事务替换当天分区，后续每日更新也保留两个层级；`--reimport` 绕过原来的完成标记重新入库，不强制重下原始行情。二、三级均不可用时保留股票 K 线并说明原因，不自动换成大盘指数。

`benchmark.level`、`indexCode`、`industryName` 表示实际使用的层级和指数；`classification` 保留原始二、三级归属，`fallbackReason` 说明三级不可用原因。页面在回退时标明“申万二级”。来源缺目录、未发布、行情缺失和无共同日期分别保留状态。两份成员来源按股票优先选择，不混合快照；原来源存在多归属时，仅在唯一二级归属可确认时降级。

2026-10-15 已回填 2025-10-15 至 2026-10-14 的 242 个交易日：124 个二级指数与 258 个三级指数，共 92,444 条点位；二级目录共 134 项，独立成员表为 5,917 条安全证券记录。对本地 5,597 只股票逐一读取近一年前复权行情并经过前端适配校验，5,310 只采用三级、265 只采用二级，22 只因两级均未发布指数仍不可用。逐股票核验结果及未覆盖清单保存在 Git 忽略的 `backend/storage/market-data/audits/`，该统计随数据日期及研究窗口变化。

申万成员源数据中的 `T` 加五位数字的旧退市证券别名完整保留在原始成员缓存中，并以 `unsupportedHistoricalAliases` 单独计数；应用成员表只保存可查询的六位 A 股代码。其他非法代码或字段仍会阻止快照发布。断点续传保留各行业成员实际采集时间，避免把复用的旧缓存标为刚采集。

前复权计算为 `原始 OHLC × 当日因子 ÷ 锚点因子`，锚点为研究截止日之前最近的股票交易日，不使用未来因子。成交量额不复权。因子缺失的日期不混入未复权价格；锚点因子缺失时明确提示。该口径消除价格除权跳变，但不是含分红再投资的总回报指标。

行业线以区间内首个共同有效交易日为基准，按 `当日指数点数 ÷ 基准指数点数 × 基准日前复权股价` 缩放。图例注明“指数按共同起点缩放”；悬停或键盘选日显示实际指数点数。缺失交易日断线，不补零；开关仅控制显示，不再次取数。选股、日期和区间变化共用一条行情请求，取消并清除旧图。

图表摘要展示截止研究日期前的最新股票收盘价、行业指数真实点位及当前 1M/6M/1Y 区间的相对表现，各自标注实际日期。`benchmark.latest` 独立返回 `{date,close}`，不会因股票停牌而遗漏较新的指数交易日。相对表现使用区间首末共同有效交易日，计算 `(股票期末收盘/期初收盘 - 指数期末点位/期初点位) × 100`，单位为百分点；不是两者价格差，也不是收益率之比。少于两个共同交易日时显示暂无可比数据，详细计算口径默认折叠。

旧接口省略 `adjustment` 时仍返回未复权价格；`/api/market/quote` 的收盘价、日涨跌及同日估值保持原始口径。接口只读取本地数据库，不在页面请求期间下载 Tushare 数据。

官方依据：[申万分类](https://tushare.pro/document/2?doc_id=181)、[申万成员](https://tushare.pro/document/2?doc_id=335)、[指数日线](https://tushare.pro/document/2?doc_id=327)、[复权因子](https://tushare.pro/document/2?doc_id=28)。分类与成员接口需要 2,000 积分，申万日线需要 5,000 积分；实际以账号权限为准。自动任务只增量更新指数日线，最新行业成员归属仍需通过上面的分类刷新命令维护。

### 每天 06:00 自动滚动更新

`backend/market-data/daily-scheduler.mjs` 检测北京时间并触发回调；A 股由 `rolling-update.mjs` 维护全市场窗口，港股当前 `HK_PRICE_SCOPE=all` 由 `hk-market-sync.mjs` 维护全部在市公司主柜台日线，`hk-forecast-sync.mjs` 按 `HK_FORECAST_SCOPE=all` 维护全部在市公司的逐券商 EPS 快照，`hk-valuation-sync.mjs` 按 `HK_VALUATION_SCOPE=all` 维护全部在市公司的估值。显式切换 `HK_PRICE_SCOPE=pool` 才使用 `hk-pool-sync.mjs` 的投资池日线流程。财联社由 `daily-news-update.mjs` 采集前一日公开新闻。共用 `update-runtime.mjs` 的一个 06:00 调度器，启动后端 `npm run backend` 即启用。港股日线步骤结束后并行启动估值及 EPS，各自独立限速和续传，日线已完成或失败均不会跳过后续步骤。新闻与行情独立执行；每步保留各自的结果与成功记录。

调度器最长每 60 秒检测一次，正常在北京时间 06:00 触发。启动时若已经过六点，会补跑当天遗漏任务；进程休眠后恢复也会检测是否错过时间。同进程不并发执行，跨进程使用各市场独立的 PostgreSQL advisory lock；A 股当天成功状态保存在 `market_data.daily_update_runs`，当前港股全市场运行状态保存在 `market_data.hk_market_update_runs`，按运行日及在市成员 hash 隔离，逐股覆盖按实际腾讯来源独立校验。`hk_pool_update_runs` 仅供显式 pool 日线模式，旧 `hk_daily_update_runs` 保留此前 Tushare 全市场试跑记录。当天 A 股已完成仍会运行港股；港股权限或限流失败不阻止 A 股维护。失败保留可重试记录，次日补齐缺失范围，也可手动重试。

```sh
# 日常使用：HTTP 后端与自动更新一起常驻。
npm run backend
# 立即更新一次；失败时也可用此命令重试。
npm run data:update
# 单独更新全部在市港股日线、估值及EPS，读取.env范围配置。
npm run data:update -- --markets HK --skip-news
# 明确选择全市场腾讯日线。
npm run data:update -- --markets HK --hk-scope all --provider tencent --skip-news
# 仅回填港股日线，不执行估值、EPS或新闻步骤；支持断点续传。
npm run data:hk:market
# 显式切回28只投资池，并选择包含成交额的东方财富来源。
npm run data:update -- --markets HK --hk-scope pool --provider eastmoney --skip-news
# 仅对投资池测试Tushare；仍受当前Token的接口权限与频次约束。
npm run data:update -- --markets HK --hk-scope pool --provider tushare --skip-news
# 仅维护 A 股。
npm run data:update -- --markets A --skip-news
# 如果只想运行更新进程，可单独常驻（不启动 HTTP 服务）。
npm run data:worker
```

在 `.env` 设置 `MARKET_AUTO_UPDATE_ENABLED=false` 可关闭后端附带的整个调度器；`MARKET_AUTO_UPDATE_CATCH_UP=false` 可禁止启动后立即补跑。`CLS_NEWS_AUTO_UPDATE_ENABLED=false` 只关闭财联社这一步，默认开启，不需要 Tushare 或 GPT 密钥。单独 worker 由明确运行 `data:worker` 启动，不受后端总开关影响，但沿用新闻开关。无需同时运行后端与 worker；即使重复启动，数据库锁和成功记录也会防止重复更新。手动 `data:update` 默认也包含新闻，可加 `--skip-news` 只更新行情。

新闻范围按上海自然日计算：例如 **2026-10-20 06:00** 只采集 **10 月 19 日 00:00 至 10 月 20 日 00:00**（左闭右开），周末同样执行。复用财联社公开搜索 `type=depth`、关键词“财联社”，保存标题、公开摘要、原文链接并关联股票；已有文章按 ID 幂等更新，不删除历史新闻。每次至少间隔 2 秒，权限、验证码或限流停止，网络错误有限重试。独立 PostgreSQL 锁与 `market_data.daily_news_update_runs` 记录每日状态；只有搜索遍历触达并确认范围起点才记录本次任务成功，`coverageVerified` 仍为 false，不能据此宣称全站完整。未完成任务保留缓存及安全错误码，可手动重试；缓存放在 `backend/storage/market-data/daily/<运行日>/` 下，不改变三个月历史回补的续传指针。

2026-10-19 已验证真实采集前一日（10 月 18 日）范围：5 次公开请求、5 页，幂等处理 30 篇文章及 13 条股票关联，状态为 `succeeded`；重启后同日任务返回 `already_completed`，没有再次访问新闻源。文章池仍为 7,344 篇，处理数不是新增数。预算暂停会校验冻结范围后续传页码，异常终止则保留已提交缓存并补试未完成页。

每次以运行日往前一个自然年为开始，以昨天为结束。例如 2026-10-15 六点展示窗口是 **2025-10-15 至 2026-10-14**。A 股和港股日线实际滚动保留“最近一年 + 起点前最近一个真实交易日”，用于一年价格回报的基准；额外一天指交易日，遇周末或长假向前找最近收盘。A 股同步保留该基准日的复权因子。A 股使用全市场按日接口，完整校验交易日历后只补未完成的交易日；股票停牌、未上市或缺失日期不伪造记录，源端 `NULL` 保留，不填 0。30 个自然日仅用于查找前置基准，不代表多保留 30 天行情。

A 股更新包括 `daily` 日线、`daily_basic` 每日估值、`adj_factor` 复权因子及 `sw_daily` 行业日线，让 K 线、PE/PB 和行业对照同步。只有四项和前置价格/因子的交易日覆盖全部验证完成，才在一个事务中清理旧日期并写入成功状态。日线按证券保留一年及之前最近一条真实价格，复权因子保留与价格对应的日期；每日估值和行业指数仍保留一年。旧版当天成功记录会因缺少前置基准标记而重新补齐。任何下载、权限、限流、日历或写库错误都会阻止清理旧数据。卖方预测、行业成员、股票资料及研究报告不在该 A 股清理范围；原始下载缓存也保留供复核。

港股全市场采用同一自然年窗口，按单股票范围查询。每股年度日线和 `market_data.hk_market_symbol_ranges` 覆盖记录在同一事务提交，范围必须与实际腾讯来源行数一致才可用于续传。首次查询起点前 30 个自然日，仅保存最近一条真实基准，不把查找区间计作年度覆盖。后续只补未覆盖范围；单股年窗验证完整且已有真实前置基准，或确认上市日在年窗内时，才逐股清理旧行情并保留最近一条基准，再压缩覆盖记录为当前年窗。其他股票失败不阻止已完整股票提交；空行情或失败股票只记入 `hk_market_symbol_attempts`，不伪造覆盖或触发该股清理。完整休市证明可记录零行范围。显式 pool 模式仍使用原 `hk_pool_symbol_ranges` / `hk_pool_symbol_baselines`，不与全市场运行成功状态混用。2026-10-19 年度窗口为 **2025-10-19 至 2026-10-18**；原投资池可用的前置基准为 **2025-10-17**。停牌、新上市或无交易日期不伪造价格。

2026-10-19 已执行两市场回补并核验：5,438 只 A 股各保留一条年度前基准及对应复权因子；港股投资池 28 只完成基准核验，其中 26 只有基准价格、2 只该时段没有行情。申洲国际及其 10 家 A 股关联公司的“一年”列均已返回真实计算值。

港股估值默认 `HK_VALUATION_SCOPE=all`，按当日核对的在市目录逐股读取历史指标，事务写入并校验实际交易日覆盖。同日跨名册 hash 复用已完成记录，全市场缓存位于 `HK-valuations/all/<采集日>/`。最多 3 个请求在途，PE、PB 及重试共用每秒至多发起一个请求的节流；429/403 停止新请求。已完成股票逐股清理一年窗口之前的估值；失败、源明确无数据或尚无本地价格时不删除旧值，已完成股票可续传。`hk_valuation_symbol_attempts` 记录逐股采集中、成功、源无数据、无本地行情和失败，重启会恢复断点。仅一个指标明确无数据时保留另一指标，不能把网络或格式错误当作无数据。估值使用独立 PostgreSQL 锁和运行表，A 股估值表不受影响。`HK_VALUATION_AUTO_UPDATE_ENABLED=false` 可单独关闭自动估值步骤。

`GET /api/health` 的 `data.marketAutoUpdate` 返回自动更新是否启用、`hkPriceScope`、下次运行时间（UTC ISO）、是否正在运行和本次进程的最后结果；`news` / `hkValuations` / `hkForecasts` 表示新闻、港股估值及港股 EPS 配置（各自的 `scope` 显示 `all` 或 `pool`），`lastResult` 下同名字段是各自当日结果，`lastResult.markets` 保留各市场价格结果，`marketStatus` 保留价格汇总状态。整体状态会反映任一步骤失败。详细历史结果可查各自的每日状态表。程序必须保持运行，PostgreSQL 和网络也需可用；电脑关闭期间不会采集。

### 卖方盈利预测

Tushare [`report_rc`](https://tushare.pro/document/2?doc_id=292) 的原始记录保存在 `market_data.sell_side_forecasts`，包含证券代码、券商、分析师、报告日期/标题、预测报告期、EPS、净利润、预测 PE 和评级。未提供的币种、基本/稀释/调整口径及原文链接保留未知，不由 GPT 补造。

```sh
# 近一年全 A 股研报预测，按自然月下载并入库；已有完整范围自动跳过。
npm run data:forecasts -- --start 20251014 --end 20261013 --mode sync
# 仅下载，或从缓存离线导入。
npm run data:forecasts -- --start 20251014 --end 20261013 --mode download
npm run data:forecasts -- --start 20251014 --end 20261013 --mode import
```

范围按**研报发布日期**筛选，包含周末；每篇报告不同预测年度是不同记录，不等于券商数量。分页读到空页后才缓存并事务写入，完成进度单独保存在 `market_data.forecast_sync_ranges`；权限、认证、限流或数据库错误会停止，并保留可重试状态。原始 gzip 缓存及进度位于 `backend/storage/market-data/forecasts/A/`，不会被提交或公开。

`GET /api/forecasts?ticker=002920.SZ&asOf=2026-10-14&windowDays=90` 仅读 PostgreSQL，无需 ChatGPT 登录，不会触发推理或重新下载。`asOf` 默认上海时区今日，`windowDays` 支持 30–365 天，默认包含截止日在内的最近 90 天。当前展示截止日所在年度及以后 `YYYYQ4` 年度预测；不会将半年度数字混进全年 EPS。

每家券商每个预测年度保留窗口内最新研报。明确的机构别名按固定映射统一，例如“中金/中金公司”，同时保留来源名称，不做模糊合并。最新值缺失或最新同日记录有冲突时排除该券商/年度，不回退到较早数字；零和负 EPS 按源值保留。最低/最高 EPS 保留所有并列券商，平均数和中位数由有效样本计算。顶部显示跨年度去重的有效券商数量，逐券商来源默认折叠；切换股票或研究日期会取消旧请求并清空旧样本。

页面使用“样本均值”表述，不能将其等同于完整市场一致预期。当前下载结果可能包含后续源修订，按发布日期过滤也不能保证严格还原当时数据库快照。接口数据本身没有原文链接时，展示报告标题、券商和日期供复核，不生成猜测链接。此 A 股研报采集仍使用上述手动命令；港股逐券商 EPS 的每日更新见下文。

需要重新抓取源端修订时，可在同步命令添加 `--refresh`。记录身份包含来源更新时间 `create_time`，同一报告的不同来源更新时间可同时保留；相同身份的数值修订采用 upsert。源端删除的旧记录不会被自动删除，因此本库保存采集观察，既不承诺源端当前快照，也不是不可变的完整历史版本库。

港股全部在市公司采用[经济通盈利预测页面](https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=00700)的逐证券商明细，不采纳页面综合预测行作为券商样本。该来源只提供各机构当前预测快照，日期是**券商更新日期**，不是研报发布日期；档案从首次实际采集日开始逐日积累，不能用今天的网页倒填过去一年的预测。`GET /api/forecasts?ticker=00700.HK` 复用同一展示接口，按研究截止日前最近成功快照读取；早于首次采集日显示尚无快照。最新成功快照明确为空时，不回退前一日旧预测。

原始 EPS、分／港仙／美仙等单位、财政年度标签、机构名、评级、更新日和原始 HTML 均留存。只在单位和币种明确时规范化为人民币元／港元／美元每股；“分”需同表人民币字段确认，不明币种不猜测。财政年结月份只在来源给出时保留。经济通的合股、拆细和红股调整说明不代表已确认基本／稀释或会计调整口径，页面明确保留该限制。

同机构同财政期只取窗口内最新更新；缺失或同日冲突不回退旧数。按财年、币种和来源 EPS 口径分组，港股机构按原名精确去重，不套用 A 股机构别名映射。前端显示最低／样本均值／最高、券商数量和折叠的逐券商明细，并提供真实来源链接、快照采集日和券商更新日。

```sh
# 独立采集或续传当天全部在市港股 EPS 快照。
# 经济通预测本身无 Token；刷新当日在市名册需要 TUSHARE_TOKEN。
npm run data:hk:forecasts
# 如需仅更新原投资池：
npm run data:hk:forecasts -- --scope pool
```

每日北京时间 06:00，港股行情步骤结束后并行启动估值与 EPS，各自独立更新；前面步骤已完成或失败都不跳过 EPS。默认 `HK_FORECAST_SCOPE=all` 使用当日经港交所与 Tushare 核对的在市公司名册；显式 `pool` 才限制原 28 只。全部股票会查询，但没有券商覆盖的公司不会生成预测值。前端区分尚未采集、正在采集、采集失败及已查询暂无覆盖。港股读取按股票选择截止日前最新成功快照，名册 hash 变化不会使原 28 只历史记录失效。

表为 `hk_sell_side_forecasts`、`hk_forecast_symbol_runs`、`hk_forecast_symbol_attempts` 和 `hk_forecast_update_runs`；全市场原始 gzip 缓存位于 `backend/storage/market-data/HK-forecasts/all/<采集日>/`，原投资池缓存仍保留名单 hash。以独立 PostgreSQL 锁和逐股事务记录进度，同一日跨名册 hash 复用成功快照；最多 3 个请求在途，共用每 2 秒至多发起一个请求的节流，重试同样受限，遇 429/403 停止新请求。首轮全量需要较长时间，可以断点续传。每只成功股票清理自身一年以前快照，失败不覆盖旧快照；跨上海午夜停止，避免把次日观察倒记到前日。`HK_FORECAST_AUTO_UPDATE_ENABLED=false` 可单独关闭自动 EPS 更新。

2026-10-19 首次采集全部 28 只港股成功，共保存 844 条机构／财年预测：人民币口径 606 条、港元 53 条、美元 185 条，其中负 EPS 49 条按原值保留。844 条均通过原始 HTML 重新解析核对；按研究截止日 2026-10-18 查询不会读入这些首次在 10 月 19 日采集的快照。审计记录在 `backend/storage/market-data/audits/hk-forecasts-20261019/verification.json`。

### 公司上下游与同行关系

关系行情表右侧的“1周差值”“6个月差值”按当前标的涨跌幅减去每家关联股涨跌幅计算，数值以%展示，正数表示当前标的跑赢。当前标的行各列显示两行数字：上方为当前分类筛选内有效差值的等权平均，下方为各去掉一个最大值和一个最小值后的等权平均（相同极值也只各去掉一条；有效数据不足 3 家时下方显示“—”）。切换全部、上游、同行、下游时重算。缺失、不可用或起止日期不一致的数据显示“—”并排除，悬停可看原因或有效样本数。差值使用已有数据库行情在前端实时计算，不另存字段，不调用 AI。

本机页面“AI识别上下游及同行”通过当前配置的 DeepSeek API 联网检索主营产品、上游供应链、同行可比与下游客户资料，检索以公司名称和业务词为主，避免股票代码及“A股／港股”把结果引向行情页；上市资格在结果核验时检查。再按上游、同行、下游分类识别约 10 家关联公司，最多 10 家，不为凑数编造，也不按类别固定配额。主体和关联公司均须为本地在市 A 股或港股；证券代码、名称与本次冻结的在市目录核对。点击才启动搜索与推理，普通读表和轮询不消耗推理。API Key 仅在后端 `.env`，沿用 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 及网络传输配置。

普通上市公司按资料中的简称、证券代码和业务依据识别，不要求提供工商法人全称；涉及子公司时才需说明其上市归属。首轮缺少某类关系时会专项补查；至少 6 家且某类占比达到 70% 时，也检查其他仅有 0—1 家的类别，即使已满 10 家仍会补查。不固定分类配额，业务处于终端或未核实到在市公司时可缺类，并由 AI 在缺口中说明原因。首轮少于 8 家时仍补证未通过的在市候选；全部补查共最多 8 次、并发不超过 4 个，取得新资料后完整重做一次，仍最多 10 家。补证失败或有效数量减少时保留首轮结果；不会拼接旧报告。首轮与最终数量、补证检索记录保存在任务审计中。

已有关系重新识别时，先把当前名单与资料提供给 AI 复核。保存时由后端默认保留旧公司及顺序；本轮未检索到、资料较少或排序变化都不构成删除理由。有空位才补新公司；换股需逐项给出旧公司、新公司、具体原因和本次有日期的来源，支持证券对应错误、关系终止、业务变化，或新项有更强直接业务依据的比较。满额名单发现缺失类别的直接业务公司、但 AI 未提供有效换股决定时，在同一任务时限内单独复核最多 3 项弱产业链证据的替换，仍逐项通过原有来源和理由校验；失败保留旧公司。无充分来源的换股不执行；未重新核验的旧公司保留原来源和核验日期。人工增删和分类优先，AI 保存时在同一数据库锁内重新读取人工操作，避免覆盖识别期间的修改。当前行的 `refresh_summary` 保存本次保留、新增、移除、未采纳数量及获准调整理由，页面研究说明可查看，不另存历史报告。

识别结果可以综合本次取得的正文或检索摘要，保留来源网址、标题、已知发布日期、读取时间及阅读范围。新结果的“资料摘要”明确标为 AI 归纳，不冒充原文引句；只有检索摘要时会单独标注。AI 推断的产业链位置关联会标注“未证实直接供客”，不能冒充采购或销售合同。缺少支持的条目单独排除，不让个别材料缺失阻断整批。页面显示当前已保存数量，点击每行“依据”可核对来源。AI 失败或空结果保留当前关系；非空成功结果整份替换，人工修正仍优先且最终总数不超过 10 家。

识别规则 `ah-relations-ai-v6-coverage-retain10` 优先保留当前公司名单，允许依据双方各自的具体业务或可靠可比名单识别同行，以及依据产品与业务衔接识别产业链位置，不要求同篇点名、逐字摘录或规模接近；券商按经纪、投行、资管等业务比较。上市主体以冻结证券目录核对，明显无法确认的主体映射仍保留为待核实候选。宣称直接供货、采购或合作时须有明确双方及日期的材料，否则降为产业链位置判断并说明未证实直接交易。即使结果为 0 家，也可展开“研究说明”查看本次缺口及候选排除原因。完整业务提示词位于 `backend/prompts/relations-ai.md`。

`POST /api/relations/research` 接受 `{ticker,asOf}`，立即返回 202 和持久化任务；`GET /api/relations/research?jobId=...` 查询进度，或传 `ticker/asOf` 恢复当日任务。当前关系内容仅写入 `market_data.company_relation_current`，主键为 `subject_ticker`，每股只有一行，`relations` 数组在数据库层限制为 1–10 家；每次成功先执行保留及有据调整，再使用 UPSERT 原子更新当前行及更新时间。`market_data.company_relation_ai_jobs` 仅保留任务状态、冻结清单、模型、来源审计、调整摘要与结果数量，不另存关系内容副本。迁移从旧数据中选一份已有完整结果，不跨版本合并，旧离线采集资料仅作为兼容历史保留。同一公司日期的运行任务去重，全局最多两个并行研究；长时间无心跳的任务标记中断。联网识别需将研究日期切回今日；当前记录已更新后不回放被替换的旧关系。局域网与本机均可启动任务，跨站网页不能启动任务。

本机页面点击“修改上下游”，可搜索本地 A 股或港股证券，添加公司、修改上游/同行/下游分类、填写备注或移除不准确关系。保存调用 `POST /api/relations/manual`，成功后重新读取数据库；依据显示“人工修改”，不伪造公开来源。已人工修改或移除的公司可“恢复自动”。该功能不依赖 AI 登录或推理额度，局域网和本机均可修改。

人工调整独立保存在 `market_data.company_relation_manual_subjects`（主体修订号）与 `company_relation_manual_events`（追加审计记录）中。人工覆盖优先于后续 AI 更新，移除记录不会被自动重新加入；新闻分类也按修正后的关联公司重新读取。人工修改与当前关系合计最多 10 家，超量在事务内拒绝，不悄悄丢弃尾项。

写入 JSON 包含 `ticker`、`asOf`、`expectedRevision`（GET 返回的 `meta.manualRevision` 字符串）和 `changes`；每项使用 `upsert`、`remove` 或 `restore`，`upsert` 另带 `relationType` 和可选 `rationale`。事务提交后才返回成功；修订号冲突返回 409，页面保留草稿并要求重新读取。`asOf` 为本次人工调整的生效日期，历史查询排除更晚生效的调整，实际写入时间单独保留。

关系采集默认以任务启动时冻结的全部在市 A 股为研究主体。初始化可传 `--subjects-file`，文件格式为 `[{"ticker":"00005.HK","name":"汇丰控股","industry":"银行"}]`（`industry` 可省略），仅研究选中的 A 股或港股主体；港股代码使用五位数字加 `.HK`。两种模式都冻结全部在市 A 股作为关联候选，每股目标仍为合计 10 家不同的 A 股企业，上游、同行、下游三类灵活分配；已核实的部分结果先入库，不足 10 家保持待补。研究截止日采用上海日期，任务进行期间不自动增删股票清单。

新增 PostgreSQL 表：

- `market_data.company_relations`：当前发布的公司关系。主体与关联代码唯一，排名 1–10，保存方向、证据类型、理由、实际业务法人、上市主体映射、来源 URL/日期/短摘录及核验时间。
- `market_data.company_relation_jobs`：冻结的证券名称、行业候选、任务状态、缺口、尝试次数和租约；`is_subject` 区分研究主体与仅供关联的候选，领取、统计和导入只处理选中主体，未选 A 股的原研究不会被新 run 覆盖。新研究任务刷新旧完整快照时，未满 10 家的草稿也在此保留。
- `market_data.company_relation_runs`：本次截止日、方法版本及冻结数量。属于长任务的元数据，不混用行情按日采集记录。

联网检索使用 Codex 会话及并行研究任务；以下命令只管理进度、验证结构与入库，不会自行搜索或调用项目的模型接口。检索规范和完整 JSON 字段见 `backend/prompts/company-relations.md`。缓存、批次领取记录与导入回执位于被 Git 忽略的 `backend/storage/company-relations/<runId>/`。

```sh
# 创建/幂等恢复任务；默认研究截止日为上海今日。
npm run data:relations -- --mode init --run-id relations-a-20261015-v1 --as-of 2026-10-15
# 可选：只研究清单内的 A/港股主体，关联对象仍限冻结 A 股。
npm run data:relations -- --mode init --run-id relations-scoped-20261019-v1 --as-of 2026-10-19 --subjects-file subjects.json
# 首批试点，之后省略tickers即可按代码领取尚未完成的股票。
npm run data:relations -- --mode claim --run-id relations-a-20261015-v1 --worker researcher-1 --limit 5 --tickers 002920.SZ,000338.SZ,601398.SH,600519.SH,600276.SH
# 会话将核实结果保存为单股JSON后导入；持有租约时传入相同worker。
npm run data:relations -- --mode import --file backend/storage/company-relations/relations-a-20261015-v1/research/002920.SZ.json --worker researcher-1
npm run data:relations -- --mode status --run-id relations-a-20261015-v1
# 完整待办/缺口详情；恢复工作时也可查看已保存的universe和research文件。
npm run data:relations -- --mode status --run-id relations-a-20261015-v1 --details
npm run data:relations -- --mode release --run-id relations-a-20261015-v1 --worker researcher-1
```

任务租约默认 30 分钟，过期可重新领取；导入与状态更新按股票在同一事务中完成，重复导入不增加重复公司。有效租约阻止其他工作者覆盖，较旧任务不能覆盖新任务。新任务的部分草稿不会替换旧任务完整的 10 家快照，待新任务补齐后一次发布。状态统计区分已发布关系与研究草稿，只有本次实际发布满 10 家才计完成。

`GET /api/relations` 优先读取每股唯一的 `company_relation_current`，不合并历史结果或从旧版本补齐当前缺少的公司。人工修改和移除最后生效，最终最多 10 家。请求日期早于当前记录时返回该日期无当前结果，不回放旧版本；尚未迁移的股票仅兼容读取一份旧结果。每条关系的核验日期及已知来源日期须不晚于研究截止日，仅展示在市 A/H 公司；磁盘上尚未校验导入的草稿不直接展示。缺少行情时仍显示公司名称、方向与依据，港股主体无行情时保留缺失，不补造价格。离线批量采集命令保留其独立发布流程。

行情对照首行固定显示当前研究标的，分类筛选后仍保留。A 股价格回报使用两端复权因子；港股主体读取本地港股日线与同日估值，以未复权收盘价计算区间涨跌幅，并在行内注明“未复权价格涨跌幅”，不调整分红、拆股等公司行动。`returnAdjustment` 区分 `qfq` / `none`，`returnBasis` 记录口径，缺历史区间继续返回空值和原因。收盘价均为未复权价格，A 股为人民币，港股按实际柜台为港元或美元，行内收盘价悬停可查看币种。表格主要数据为 14px，辅助文字为 12px，涨跌幅按红涨绿跌展示。

新领取结果携带 `leaseToken`，单股JSON须保留该代次（或导入时显式传 `--lease-token`），避免同名工作者重领后旧任务仍能提交；释放或标记失败也传同一token。`researchedAt` 记录实际核验完成时间，重放缓存不刷新该时间，过期证据不能覆盖新的复核。旧任务已有部分发布也会保留到新任务满10家；被替换的旧快照归档到任务记录，仍可查阅。

复核后需要调整已选满的10家公司时，导入命令可显式加 `--replace`，必须提交完整10家的结果；默认仍按增量合并，意外超量会回滚。该选项不会绕过证券、来源或租约校验。

为减少重复读取和模型输出，可使用共享证据目录及紧凑草稿。目录只索引与导入回执hash一致的已保存来源；检索命中仍须核对实际业务、法人和适用范围，复用时保留原 `accessedAt` 和实际读取范围。新读取来源在草稿的 `newSources` 字典中保存一次，每条关系以 `sourceIds` 引用，主体证据可放顶层 `subjectSourceIds`。程序展开证据字段，不推断交易或补造核验时间。

```sh
npm run data:relations:cache -- --mode index --run-id relations-a-20261015-v1
npm run data:relations:cache -- --mode find --run-id relations-a-20261015-v1 --ticker 000301.SZ --query EVA --limit 5
npm run data:relations:cache -- --mode compose --run-id relations-a-20261015-v1 --file drafts/000301.SZ.json --claim claims/原worker.json
```

`--file`、`--claim`、`--out` 的相对路径以本run目录为基准，compose默认写入 `research/<ticker>.json`。必须传入原领取记录，并在草稿显式保留原token及实际researchedAt；较旧或同时间不同内容的结果无法覆盖新缓存。展开后沿用原导入命令。自动接续采用3个新上下文研究子任务，每批10股，按业务组预读去重、每5股共享新证据，减少逐股汇报与全文输出。

已配置的聊天自动接续信息保存在本次任务目录 `automation.json`，每轮从数据库及缓存恢复，不重建股票清单。全量达到目标后停止；本地运行需要电脑、Codex应用和PostgreSQL保持可用。调度运行要求参见 [OpenAI Docs](https://learn.chatgpt.com/docs/automations?surface=app)。

`direct_business`、`technical_cooperation`、`industry_position`、`business_comparable` 分别表示直接业务、技术合作、产业链位置和具体业务可比。产业链位置不能冒充实际供应商或客户。子公司关系保留实际法人及控股映射依据，历史合作注明时间，不推定至今仍然有效。URL、字段和摘录通过校验只说明结构有效，关系语义仍由检索者核实。存在缺口时应继续报告部分完成，不能将建表或建队列视为全量研究完成。

可直接查询某股的当前已发布结果：

```sql
SELECT related_ticker, related_name, relation_type, evidence_type, rationale, sources
FROM market_data.company_relations
WHERE subject_ticker = '002920.SZ'
ORDER BY rank;
```

## 股票涨跌归因与恒生指数

K 线图下的“AI 涨跌归因”由本机手动启动，一次依次生成 1M、6M、1Y 三份报告。A 股沿用前复权及申万行业基准；港股使用现有未复权价格与恒生指数，明确不是含息总回报，拆合股及分派需要单独核验，美元柜台另标注未做汇率调整。收益由与图表共用的算法按共同首末交易日计算，超额为股票与指数涨跌幅的百分点差，模型不能修改数字。

恒指来自腾讯 `hkHSI`，保存在 `market_data.hk_index_daily`（指数代码和交易日唯一）。`npm run data:hk:index` 首次回填近一年；后续增量回取交叠区间并滚动保留一年。每天上海 06:00 与市场、资讯更新独立并行，只导入截至前一日的已收盘日线，不导入当天实时 K 线。`GET /api/market/prices` 港股可传 `benchmark=hsi`，不传时保持原无基准契约。

归因采用“个股新闻＋板块新闻→AI 总结”。分别按所选 1/6/12 个月日历起点至最后共同交易日检索两组新闻，不再把新闻窗口缩成个股有效交易日范围。A 股使用真实申万行业，港股生成时按需从东方财富公开公司资料读取明确行业（如腾讯“软件服务”），恒生指数仅是收益比较基准；行业不明时说明缺失。读取已有报告不会访问外部行业接口。

新闻可为实际取得的正文或搜索摘要，保留来源日期、链接、分类和阅读范围。AI 使用来源编号总结原因，不要求逐字抄写；程序校验来源绑定和日期，个别错误引用只剔除该项，不让整份报告失败。一组资料缺失仍可使用另一组并说明覆盖不足；有新闻但无法解释相对表现时可保存明确资料不足的总结。允许新闻支持的经营数据，不再用宽泛正则误判正常财务增长；仍不凭空估算事件对涨幅的贡献。日期未知仅作背景，区间外或未来材料不作区间驱动。

- `market_data.stock_return_attributions`：每只股票、每个周期一条最新报告，保存指标快照、数据指纹、正文、来源、模型及生成时间。成功原子覆盖，失败保留原内容，不读写 JSON 文件。
- `market_data.stock_return_attribution_jobs`：任务进度及冻结的行情输入，不保存报告历史副本。重复点击复用任务，三个周期串行、独立成功保存；部分失败可只重试失败周期。心跳超时标中断，必须手动重试，不自动再次推理。
- `GET /api/market/attribution?ticker=00700.HK&asOf=YYYY-MM-DD`：只读报告、各周期行情新鲜度及最新任务，不调用 AI。
- `POST /api/market/attribution/generate`：JSON `{ "ticker": "00700.HK" }`，默认生成三个周期；可传 `periods` 子集用于失败重试，返回 202 与任务编号。
- `GET /api/market/attribution/jobs/<jobId>`：只查询进度，不重新生成。历史日期只读，新增任务始终基于上海今日和数据库实际行情；没有足够共同行情时不推理。

行情变化后以数据指纹提示“归因待更新”，不会在每日采集后自动花费 AI 额度。刷新、切股、切周期只读取数据库；局域网与本机使用相同 AI 功能权限，均可读取和手动生成归因。数据库缺失或故障直接报错，无文件存储回退。

## 检查与依据

```bash
npm test
npm run build
```

测试使用可识别的隔离数据，不会调用真实 OpenAI。浏览器打开页面也不会自动付费生成。

订阅接入依据：[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[当前限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。

研究接口依据：[OpenAI web_search 文档](https://developers.openai.com/api/docs/guides/tools-web-search)、[Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs)、[默认模型文档](https://developers.openai.com/api/docs/models/gpt-5.6-terra)。

A 股卖方 EPS（Tushare `report_rc`）现随每日北京时间 06:00 调度独立更新，不受行情当天已完成影响。启动后补跑遗漏月份，重查最近 7 个自然日以接收迟到研报，成功后按报告日期滚动保留一年。使用 PostgreSQL advisory lock 防止重复进程并发采集；分页、断点与失败记录沿用 forecast_sync_ranges，失败不清理旧数据。健康状态的 aForecasts 字段显示是否启用；无需每天点击页面。

自选股票现由 PostgreSQL `market_data.user_watchlists` 保存，主键 `(owner_name,ticker)`，记录公司名称和加入时间。网页自选栏输入姓名后进入或切换；浏览器只记住姓名，名单从数据库读取。本机与局域网输入同一姓名读取相同自选；这是姓名分组，不是密码认证，同名共用且知晓姓名的人可读写该分组，不适合作为公开多人系统的身份验证。旧浏览器名单可显式导入当前姓名，合并去重，不删除本地备份；数据库读取或写入失败不以本地名单冒充成功。`GET /api/watchlist?owner=...` 读取，`POST /api/watchlist` 支持 add/remove/import，修改按姓名串行加锁，每人最多200只。后续每日AI更新可用 DISTINCT ticker 取所有人的自选并集，同一股票只生成一次；本次尚未启用自动AI生成。

自选涨跌归因每日自动更新：后端 `watchlist-attribution-runtime.mjs` 每分钟检查一次，上海时间06:00后，A股等当天行情任务成功，港股等当天逐股日线完成，再从所有姓名自选中取 DISTINCT ticker 串行生成1m/6m/1y。独立于全市场港股采集结束，不更新核心分歧和上下游。已有报告截止交易日不早于当前共同行情截止日时跳过，避免休市重复消费。`market_data.watchlist_attribution_runs` 按运行日/股票/周期/行情截止日保存状态、次数和job_id；成功不重复，每个键最多3次，失败至少间隔15分钟重试。跨进程锁和原归因服务全局锁防并发。各周期仍保存到stock_return_attributions，成功替换失败留旧。`WATCHLIST_ATTRIBUTION_AUTO_UPDATE_ENABLED=false` 可关闭该AI自动调用；服务关闭需等当前研究结束。GET `/api/watchlist/attributions` 查看后台状态，POST空JSON可立即检查并更新所有自选（允许使用当前已入库行情）。自动分支仍等待各股行情就绪，服务停机后按最新行情恢复，不补生成每个遗漏交易日的历史报告。
手动POST触发允许立即重试失败周期（仍受每天同一行情截止日最多3次限制），无需等待15分钟；后台定时重试仍有15分钟退避。未就绪或等待退避时总体状态为waiting，不将其显示为全部完成。失败密钥/余额/数据库配置会停止本轮后续股票，保护调用成本。

涨跌归因结构化输出恢复：保留原Responses JSON Schema约束和全部行情/引用校验；仅JSON解析、字段结构或不完整输出错误可在同一次研究内修复一次，复用原新闻搜索结果，不再次联网检索。完整Markdown JSON代码块可安全解包，不猜测缺失括号。输出不完整时修复请求额度由8000提升至12000，整体仍受原300秒上限限制；连续失败保留旧报告。成功修复元数据写入报告retrievalEvidence.formatRepair，不记录密钥或原返回正文。余额/权限/限流及证据错误不触发格式修复。

上下游与同行的“AI相对表现归因”：复用表格1周/6个月差值与均值计算，DeepSeek联网检索当前标的和最多10家已保存关联公司的公告、经营新闻，每个窗口逐公司检索，另对差距最大两家及反转公司追加最多3次检索；并发最多4，来源去重、日期过滤和公司/窗口公平分配，最多36条、约65000字符。一次生成all/upstream/peer/downstream非空范围各一段250–400字左右融合分析，页面只显示当前筛选范围，切换不推理。不得把产业链不同环节的涨幅直接解释为竞争力，原因必须绑定事件、作用路径和来源，缺口明确说明。JSON/引用结构问题最多修复一次，复用原资料，修复后继续完整校验。
结果在`market_data.company_relation_attributions`每股一行替换保存，任务及次数在`company_relation_attribution_jobs`；来源和数值快照随报告入库，任务结束清空临时快照，不积累报告副本。关系变化则旧分析标记待更新并隐藏正文；生成时名单已改变则不保存旧名单的新报告。读取只查库，不推理。
接口：GET `/api/relations/attribution?ticker=...&asOf=...`；POST `/api/relations/attribution/generate` JSON仅ticker；GET `/api/relations/attribution/jobs/{uuid}`；GET/POST `/api/relations/attribution/batch`查询/手动检查所有自选。普通历史查询不回放被覆盖的旧版本，历史日期禁用生成。
每日上海06:00后每分钟检查所有用户自选并集，先等A股日任务及涉及的港股逐股采集结束；明确无数据/失败不无限阻塞，缺期公司不比较。未变化的报告跳过，同一天自动最多成功两份（初次及一次行情补齐/名单变更），每个输入每日最多3次、自动失败重试间隔15分钟；手动可立即重试但仍受3次上限。全局单任务及数据库锁防止重复，心跳15秒、12分钟无心跳判中断；余额密钥权限错误停止后续股票。`RELATION_ATTRIBUTION_AUTO_UPDATE_ENABLED=false`关闭此项自动AI调用，手动仍可用。

相对归因v2输入显式区分meanGapPp（差值）与relatedMeanReturnPct（关联公司平均收益），校验weeklyDirection/halfYearDirection，避免把差值当收益再次比较。每段目标250–400可读字，股票代码与数字按词计；指导聚焦3家重点公司、4个原因、8条引用，完整比较名单及经验证的原因引用可保留；来源每公司每窗口优先保留一条，再填补其余名额。

稳定校验规则：篇幅250–400字仅为提示词中的编辑目标，不是失败或重试条件；有效分析略长时原文正常保存，仅记录presentation字数信息，不因此额外调用AI。JSON结构、公司范围、方向和引用仍严格校验；正文长度仍受通用结构解析12000字符安全上限保护。
