# 通用公司投研看板前端

前端只负责展示、交互和调用你提供的后端服务。后端负责 Tushare/GPT 调用、存储、研究分析和财务计算。本项目未实现这些后端功能。API Key 仅存放在项目根目录的 `.env`，前端不会读取或打包该文件。

## 目录

```text
frontend/                    前端源码
  index.html                 页面结构
  styles.css                 桌面页面样式
  config.js                  是否启用接口、服务地址、超时配置
  src/
    main.js                  页面初始化、状态、加载和取消旧请求
    api/
      client.js              唯一 HTTP 请求入口
      endpoints.js           后端路径和请求参数配置，默认全部留空
    services/
      research-service.js    按模块加载数据，不依赖 DOM
      adapters.js            后端 JSON → 前端展示模型
    views/
      research-view.js       展示数据，不调用接口、不计算 EPS/估值
    data/
      companies.js           初始标的列表、证券代码校验与通用研究问题
    features/
      notes.js               按证券代码分开保存与导出浏览器笔记
      company-session.js     当前标的及请求生命周期
scripts/build.mjs            将 frontend/ 复制为 dist/
tests/api.test.mjs           请求、取消、错误和数据适配验证
dist/                        自动生成的预览/发布文件，不在这里改源码
```

## 本地使用

需要 Node.js（建议 20+）和 Python 3，不需要安装前端依赖。

```bash
npm test
npm run dev
```

打开 `http://127.0.0.1:8765/`。如果该端口的现有预览已经运行，只需执行 `npm run build` 后刷新网页，不要重复启动服务。

源码修改后执行 `npm run build` 并刷新。当前没有热更新。

## 标的与模板

页面是一套通用桌面模板，德赛西威仅是默认选中的示例标的。点击左侧公司名称或顶部“切换股票”，可选预置公司，也可输入任意证券代码和可选名称。代码格式应与后端约定一致，前端保留交易所后缀及前导零，不自动猜测交易所，也不验证股票是否实际存在。公司名称搜索暂未实现。

- `frontend/config.js` 的 `companyConfig.defaultTicker` 控制默认标的。
- `frontend/src/data/companies.js` 的 `companyOptions` 只配置初始选择列表，不存放公司专用的研究结论。
- 页面标题、导航公司、公司介绍、研究模块和笔记都跟随当前标的。
- 切换后取消上一公司的请求、清空旧数据显示，再用新 `ticker` 加载所有模块。接口未配置时展示通用问题和空数据。
- URL 的 `ticker` / `company` 参数保留当前选择，刷新或分享本地链接可恢复标的。
- 未来可以由股票列表 / 搜索接口提供选择项；现有资料、行情、分歧、EPS、band、事件模块均使用当前证券代码请求。

## 后端准备好后的接入位置

1. 在 `frontend/config.js` 填写 `baseUrl` 并设置 `enabled: true`。
2. 在 `frontend/src/api/endpoints.js` 配置已完成模块的实际路径和参数。没完成的模块继续保持 `null`。
3. 根据实际响应修改 `frontend/src/services/adapters.js` 中对应的映射函数。
4. 执行 `npm test`、`npm run build`，刷新并检查真实数据。

默认 `enabled: false`，因此页面不会访问任何后端接口。只完成一个模块也可以单独接入，不影响其余占位模块。

例如下面是接口配置方式示例，并非要求你的后端采用这个地址：

```js
// config.js
export const apiConfig = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8000/api',
  timeoutMs: 12000,
  credentials: 'omit',
};

// endpoints.js 中只配置已有的模块
quote: ({ ticker }) => ({
  path: '/your-quote-route',
  query: { stock_code: ticker },
}),
```

`main.js` 提供参数 `ticker`、`period`（`1m`/`6m`/`1y`）、`category`（全部/公司/同行/上游/下游/政策）。路径函数负责翻译为后端需要的参数名；不会自动向每个接口附加这些参数。

跨域访问需要后端允许前端的实际 Origin。当前请求不携带 Cookie；若后续使用会话 Cookie，再按认证设计调整 `credentials` 和后端 CORS。不要把 Tushare/OpenAI Key 写入任何前端文件。

## 展示模型（不是强制后端契约）

路径可自由设计，返回 JSON 也可自由设计；通过 `adapters.js` 映射即可。当前默认适配器支持直接 JSON 或 `{ "data": ... }` 包装。业务失败码等规则需根据你的接口设计在适配层补充。

| 模块 | 当前前端展示模型 |
| --- | --- |
| `profile` | `{ name, ticker, description, businesses: [], sourceUrl }` |
| `quote` | `{ price, currency, asOf, peTtm, pb }`，数字可以为 `null` |
| `prices` | `[{ date, close }]`，按日期从早到晚，保持一致的价格口径 |
| `debates` | `[{ title, summary, metrics: [], perspectives: [], sources: [], asOf }]` |
| `forecasts` | `[{ fiscalYear, low, consensus, high, sampleSize, source, asOf, currency, basis }]` |
| `bands` | `{ peTtm: { points: [{ date, value }], asOf, source }, pb: { points: [{ date, value }], asOf, source } }` |
| `events` | `[{ title, category, publishedAt, summary, impact, verification, source, sourceUrl, readingScope }]` |

分歧 `perspectives` 项为 `{ author, date, text }`。`sources` 项为 `{ title, author, date, url, readingScope, qualityLabel }`，雪球标签等由后端提供。

EPS 的 `low/high` 项为 `{ value, broker, reportDate }`，`consensus` 为 `{ value }`。这是一张后端已汇总的情景表；前端不会自己从逐券商数据计算一致预期。其他来源字段可随着接口设计扩展映射。

当前估值区只预留历史曲线展示。分位线、倍数价格带与完整 band 的口径和计算由后端确定，前端后续据返回结构增加展示，不会将已有曲线冒充完整 band。

## 状态及现有功能

- 未配置：保留当前待接入页面，不请求网络。
- 加载中：对应模块提示获取状态。
- 空结果：明确接口返回空数据，不补模拟数值。
- HTTP/超时/连接/JSON/映射失败：对应模块显示失败原因，不影响其他模块。
- 快速切换区间或分类：取消前一次请求，忽略过时结果。
- 研究笔记按证券代码分别保存，兼容读取原德赛西威笔记；暂未接入后端保存。

前端代码中的数据引用使用文本节点与 HTTP(S) 来源链接，不直接执行后端返回的 HTML。
