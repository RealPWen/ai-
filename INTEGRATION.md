# 公司投研看板：TideOS 接入

本模块包含静态前端、Node HTTP API 和 PostgreSQL。保留在线 AI 生成、自选与笔记时，API 必须常驻。TideOS 只启动批处理命令、接收 stdout、排班和代理看板，不 import 本模块，也不承担常驻服务监管。

修改前源码已保存在 Git 标签 `pre-tideos-20261030`（提交 `4da92a1`）。本次适配位于 `tideos-integration` 分支；原工作目录和原服务无需切换。

## 1. 部署前准备

需要 Node.js 22.21+、npm、PostgreSQL；本地验证使用 Node.js 24.19.0。Node 依赖通过锁文件安装：

```sh
npm ci
npm run build
```

仅 IMA PDF/OCR 功能需要 Python 3.10+、`python -m pip install -r requirements.txt`，以及包含 `eng`、`chi_sim` 语言数据的 Tesseract。设置 `IMA_PYTHON` 和 `IMA_TESSERACT` 为目标机可执行文件路径，或使用 PATH。`IMA_RESEARCH_ENABLED=false` 可关闭该可选功能。Windows 使用 `BACKEND_HTTP_TRANSPORT=native`；可选 curl 传输仅适用于已有 `/usr/bin/curl` 的 macOS/Linux。

从 `.env.tideos.example` 复制为 `.env.tideos`，或者由服务管理器/TideOS 注入同名环境变量。配置文件不提交 Git。系统已有的同名环境变量优先；不要注入空凭证覆盖文件兜底值。

| 配置 | 作用 |
| --- | --- |
| `DATABASE_URL` | 专用 PostgreSQL 数据库连接串；只在服务端使用 |
| `TUSHARE_TOKEN` | A 股更新、港股在市证券目录等采集 |
| `AI_PROVIDER=deepseek`、`DEEPSEEK_API_KEY` | 在线和批量 AI 归因；批处理不依赖交互登录 |
| `COMPANY_RESEARCH_DATA_ROOT` | 所有本地缓存/状态/报告文件的统一数据根；建议绝对路径，如 `D:/TideOS/data_hub/company_research` |
| `COMPANY_RESEARCH_TIDEOS=true` | 强制关闭全部三套内部定时器，即使其他自动更新开关是 true |
| `COMPANY_RESEARCH_BASE_PATH` | 看板路径前缀，默认 `/company-research` |
| `COMPANY_RESEARCH_PUBLIC_ORIGIN` | TideOS 实际公开 origin，例如 `https://research.example.com`，不含路径 |
| `BACKEND_PORT`、`FRONTEND_PORT` | 常驻 API 和网页代理端口，默认 8000、8765；冲突时分别调整 |
| `IMA_OPENAPI_CLIENTID`、`IMA_OPENAPI_APIKEY` | 可选 IMA 凭证；不要依赖开发者家目录里的凭证文件 |

数据根未设置时仍使用原 `backend/storage/`，保持原本机工作方式。相对配置路径以项目目录为基准，不依赖 TideOS 的工作目录。PostgreSQL 中的数据不因设置数据根而搬迁；已有文件也不会自动迁移。首次切换前停止旧写入进程，复制所需 `backend/storage/` 内容到新数据根，过滤 `._*` 和 `.DS_Store`；不要复制旧登录凭证，除非明确需要原 ChatGPT 兼容模式。

## 2. 数据库迁移与已有数据

GitHub 保存源码和建表 SQL，不包含行情、报告、姓名自选、笔记或原始研报。要保留已有内容，另行迁移当前 PostgreSQL 数据库。使用专用空目标数据库，避免覆盖 TideOS 其他模块的库。

在源机器执行（连接凭证由环境或 PostgreSQL 标准配置提供）：

```sh
pg_dump --format=custom --no-owner --no-acl --file=company-research.dump company_research
```

在目标机器创建专用数据库后恢复：

```sh
createdb company_research
pg_restore --no-owner --no-acl --dbname=company_research company-research.dump
```

备份文件走受控文件传输，不提交 Git。核对传输前后的文件字节数与 SHA-256；不能只检查 HTTP 200 或“文件非空”。连接远程数据库时使用相应 `PGHOST`、`PGPORT`、`PGUSER` 等配置。若选择从空库开始，采集和各服务会创建各自的表，但不会恢复已有自选、笔记和 AI 报告；全量回填可能很久，首次初始化安排在终端完成，不加入网页 stage 白名单。

## 3. 看板常驻进程

Windows：

```bat
start_board.cmd
```

macOS/Linux：

```sh
npm run tideos:board
```

该启动器固定设置 TideOS 模式及三项 `*_AUTO_UPDATE_ENABLED=false`，启动 API 和网页两个子进程，并把两者的 stdout/stderr 汇入自己的 stdout。任一子进程退出，启动器会结束另一进程并以非零退出；收到停止信号时先终止两个子进程，10 秒后强制收尾。不要把它配置成 TideOS 的日常管线。

由目标机现有的服务管理器监管这个启动器：开机启动、运行失败重启、明确工作目录及环境变量、收集日志。Windows 可通过既有服务工具或任务计划程序的开机任务及失败重启设置部署；按任务树停止，避免只停止外层 `cmd.exe`。TideOS 不负责拉起这个服务。端口占用会使启动失败，由监管器及日志暴露问题。部署到新目录不会自动改动开发机已有 launchd 服务。

`start_board.cmd`、`npm run tideos:board` 默认读取 `.env.tideos`，不会读取开发机 `.env`。普通 `npm run backend` 在未启用 TideOS 模式时保持原行为。

## 4. 反向代理与鉴权

把整个 `/company-research/` 前缀代理到服务器的 `http://127.0.0.1:8765/company-research/`，**保留路径前缀**。入口 `/company-research` 会 307 跳转至带斜杠地址；静态资源、自选、笔记及 AI 接口都留在这个前缀里，不占用 TideOS 根 `/api/`。页面使用 hash 导航，无需按 Cookie 猜测根路径属于哪个应用。

代理契约：

- iframe 地址使用同源 `/company-research/`，不要向远程浏览器提供 `localhost` 地址。
- TideOS 对该前缀的 HTML、静态资源和 API 统一执行现有登录鉴权。模块的“姓名”只是数据分组，不是身份验证。
- 只代理到固定本机上游，禁止浏览器参数决定目标地址；上游端口不要直接暴露到公网。
- Host 可保留已配置的公开域名，也可改为 `127.0.0.1:8765`；保留浏览器 Origin。模块仅对本机代理连接放行显式配置的公开 origin，不信任任意转发头。
- 浏览器请求使用 `same-origin` 凭证，让 TideOS 的登录 Cookie 能参与鉴权。模块的网页代理不会把 Cookie 或 Authorization 转发给内部研究 API。
- 生成请求可能持续数分钟，外层代理超时至少 420 秒；只读请求保留短超时。
- 外层代理连接失败时，为 iframe 返回明确的 502 说明页，例如“投研看板服务未启动，请联系维护者检查服务日志”；不要只返回空白。内部 API 不可用时模块会返回可读 JSON 错误。

只读健康检查地址：`/company-research/api/health`。它不触发数据采集或 AI；数据库详细就绪情况用下一节 `check` 命令检查。

## 5. 单次批处理、stdout 与退出码

由 TideOS 直接调用 Node，不通过 shell 拼接参数，不调用 `npm run data:worker`。下列四个 stage 是允许接入网页的固定集合：

| stage | 固定命令（项目目录下执行） | 行为 |
| --- | --- | --- |
| `check` | `node scripts/tideos-run.mjs --check-only` | 只检查数据库连接与基础表；不迁移、不采集、不调用 AI |
| `update` | `node scripts/tideos-run.mjs --stage update` | 当日行情、估值、EPS、恒指、资讯，按现有配置执行一次 |
| `watchlist-attribution` | `node scripts/tideos-run.mjs --stage watchlist-attribution` | 对所有姓名的自选并集执行一次涨跌归因检查/更新 |
| `relation-attribution` | `node scripts/tideos-run.mjs --stage relation-attribution` | 对自选并集执行一次上下游与同行相对归因检查/更新 |

以上命令由 TideOS 注入凭证。独立终端可用 `npm run tideos:check` 或 `npm run tideos:run -- --stage update`，它们会读取 `.env.tideos`。两项 attribution stage 会实际调用付费 AI，沿用原来的行情就绪、当前结果复用、次数上限、数据库锁和失败重试间隔；不会因为关掉内部调度而跳过单次任务，也不会启动后台定时器。不要在未配置目标库与凭证时运行真实更新作验收。

stdout 为逐行 UTF-8 JSON，包含 `stage_started`、业务进度、`stage_finished` / `stage_failed`。正常路径等待任务结束并关闭资源后自然退出；配置或上游错误只输出安全错误码。TideOS 仍应合并 stderr，以捕获 Node 启动/依赖错误。环境设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8` 用于可选 Python 子进程。

| 退出码 | TideOS 展示语义 |
| --- | --- |
| `0` | 成功，或当前数据已完成无需重复执行 |
| `1` | 配置、运行或资源关闭错误，需检查日志 |
| `2` | 业务未全部完成；可能是部分完成或阶段失败，以 JSON status/明细为准 |
| `3` | 其他进程正在运行，或行情尚未就绪；显示等待/跳过，不当作崩溃 |
| `130` | 操作者或监管器中断；保留已完成产物，后续按状态恢复 |

旧 `scripts/update-daily-data.mjs` 的兼容退出码为：0 成功/已完成，1 配置或异常，2 其他业务状态。TideOS 应统一使用上述新入口，避免混用语义。

建议每天上海 06:00 触发 `update`，完成后安排两项归因；返回 3 或 2 时依据原因安排后续重试，自动失败重试至少间隔 15 分钟，避免持续付费失败。各 stage 独立运行，不要求看板 HTTP 服务在线。超过 TideOS 的三小时阈值被终止时，采集和报告已有的数据库检查点会保留，后续运行复用已完成部分；不要给长时间首次回填添加网页按钮。

## 6. TideOS 宿主接线

本仓库不包含 TideOS 主程序，下面是宿主侧需要完成的接线，不能仅部署本仓库就视为已经接好。

固定命令表示例（`NODE_BIN` 为已确认的 Node 可执行文件路径）：

```python
_CR_STAGES = {
    "check": ("只读自检", ["scripts/tideos-run.mjs", "--check-only"]),
    "update": ("每日数据", ["scripts/tideos-run.mjs", "--stage", "update"]),
    "watchlist-attribution": ("自选涨跌归因", ["scripts/tideos-run.mjs", "--stage", "watchlist-attribution"]),
    "relation-attribution": ("自选相对归因", ["scripts/tideos-run.mjs", "--stage", "relation-attribution"]),
}
# stage 只查表；未知值拒绝。argv 不含来自网页的任意字符串。
label, args = _CR_STAGES[stage]
proc = subprocess.Popen(
    [NODE_BIN, *args], cwd=CR_DIR, env=_cr_env(), shell=False,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, encoding="utf-8", errors="replace",
)
```

`_cr_env()` 必须设置 `COMPANY_RESEARCH_TIDEOS=true`、统一数据根和 UTF-8 环境；传递数据库、数据源、AI 凭证和采集范围。凭证只在非空时注入。此示例不读取 `.env.tideos`，宿主须提供完整环境；如果明确采用文件兜底，把固定的 `--env-file-if-exists=<模块绝对路径>/.env.tideos` 加在 Node 参数最前面。

按原指南逐项核对：

1. 模块目录及数据根常量。
2. `ui/company_research_schedule.json`。
3. `_lifespan` 中加载排班文件。
4. `_lifespan` 中调用 `_apply_cr_schedule()`。
5. 默认排班配置。
6. 七项进程、日志、锁、SSE、运行、停止、最近运行状态。
7. **把 `_cr_sse_queues` 加到 `_sse_gen` 的回收名单。**
8. 上述固定 stage 白名单。
9. 子进程环境及非空凭证注入。
10. 起进程、逐行读 stdout、按退出码收尾。
11. 触发前调用 `_reap_stale_run`。
12. 排班移除旧 job 并添加新 job。
13. trigger/stop/status/logs/stream/schedule(GET+POST)/state 路由。
14. 导航、iframe、日志/任务状态界面及前缀反向代理。

沿用宿主 `Asia/Shanghai`、`misfire_grace_time=7200`、`coalesce=True`。`state` 只读取状态，不触发生成。数据库初始化、大规模研究重新采集、清空数据等操作不加入 stage 表。

## 7. 验证与回退

```sh
npm test
npm run build
npm run tideos:check
```

最后一条需要目标机数据库配置。新增自动测试覆盖关闭调度、单次执行与资源关闭、退出码、子路径代理、公开 Origin 白名单、Cookie 策略、Windows 文件替换重试及 Python 环境传递；实际 Windows 运行、TideOS 的登录代理和宿主 14 处接线仍须在目标环境验收。

回退时先停止新版本服务，再切回 `pre-tideos-20261030` 并按原部署配置启动。原分支会恢复旧的内部调度方式，须同时停用 TideOS 为本模块配置的排班，避免双重运行。源码回退不会回滚 PostgreSQL 数据；数据库恢复使用单独备份。数据根切换也不会自动迁移文件。
