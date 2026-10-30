# ima 本地资料采集

当前只采集用户指定的「彭博社➕国际投行研报」。目录、原文下载状态和来源标识保存到现有 `company_research` PostgreSQL 数据库的 `research_data` schema；原文件保存在 `backend/storage/research-data/ima/files/`，数据库 `local_path` 相对于 `backend/storage/research-data/ima/`。文件按 SHA-256 定位，标题和文件夹保留在数据库中。不会调用 AI，不会修改现有网页研究生成流程。

凭证从 `~/.config/ima/client_id` 和 `~/.config/ima/api_key` 读取；目录权限为 0700，文件为 0600。只发送到 `https://ima.qq.com` 的官方 API，不进入命令参数、日志、数据库或项目代码。下载使用 API 返回的媒体临时访问地址和限定请求头，不保存该临时地址。仅自动下载腾讯 COS 的 HTTPS 原文件；网页链接、需客户端访问的内容和其他来源记录为未取得，不能视为已下载。

在项目根目录执行：

```sh
# 下载所有可获取的历史原文件，并持续登记完整目录；默认 3 个下载工人。
node --env-file=.env scripts/sync-ima-library.mjs
# 只查看当前库内状态，不调用 ima。
node --env-file=.env scripts/sync-ima-library.mjs --mode status
# 仅继续目录遍历。
node --env-file=.env scripts/sync-ima-library.mjs --mode catalog
# 续传并重试此前临时网络/目录错误。明确不可访问的文件不自动重复尝试。
node --env-file=.env scripts/sync-ima-library.mjs --retry-errors
```

数据库 advisory lock 阻止同库重复启动。每页目录记录与分页游标在同一事务提交；下载采用临时文件、字节数检查、SHA-256 校验和原子落盘。已成功的文件不重复下载，异常退出后可重跑续传。每个接口最多重试三次，限流等待 30 秒。原文件下载失败与目录缺失分别记录。达到默认 15 GiB 剩余空间边界时保存进度并停止，不能把停止当成下载完成。

官方 API 实测业务码 `220021` 表示「资料获取次数已达上限，请明天再尝试」。原文和目录分页接口均实测返回过该错误。此时立即保存进度并停止相应任务，相关文件保持待下载，不能标记为永久不可访问；也不通过更换凭证或其他入口绕过额度。接口没有披露具体每日额度或精确恢复时间。当目录仍有额度时可用 `--mode catalog` 独立同步；目录同样达到日上限后须等待恢复。默认 API 调用间隔为 2 秒；目录 HTTP 403 曾在稍后相同请求中恢复成功，没有明确鉴权/权限错误时最多等待 60 秒重试两次，持续拒绝则停止。

表：

- `ima_libraries`：库信息与整体状态。供应商报告的内容数与本次枚举的文件数不是同一口径。
- `ima_folders`：文件夹、分页游标、遍历状态与错误。
- `ima_documents`：文档身份、标题、下载状态、原文件相对路径、大小、摘要哈希、文本处理状态。
- `ima_document_pages`：已取得的逐页文本和提取方法。普通 UTF-8 文本在下载时直接入库；PDF 的批量 OCR 尚未执行，`text_status=pending` 表示原文件已有或待下载，尚未生成可用于检索的正文。前期两份样本的 OCR 单独标注为 `ocr_sample`。
- `ima_sync_runs`：每次运行状态、心跳、开始和结束时间。

2026-10-22 启动的单次原文后台作业为 `com.panwen.company-research.ima-download`，已因额度停止。仅目录作业为 `com.panwen.company-research.ima-catalog`，也已达到日上限并停止。配置分别放在存储目录的 `download-once.plist` 和 `catalog-once.plist`，通过 launchd 立即启动，未设置周期运行、明日自动续传或登录自动运行。日志在 `~/Library/Logs/company-research/ima-download.log` 和 `ima-catalog.log`，安全状态快照在存储目录的 `status.json`。应用关闭后目录进程仍可运行，电脑休眠或断网会影响同步。

完整性检查应分别核对目录遍历是否结束、原文件下载成功数量、未取得数量、逐文件哈希和可用空间。`complete_with_unavailable` 只表示本次已遍历的任务处理结束，不能声称每份资料均已取得。此采集也不构成供应商在某时点的不可变全量快照。
