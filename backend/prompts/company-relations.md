# 离线公司关系研究（a-relations-v1）

## 流程

目录D为 `backend/storage/company-relations/<runId>`。读D/universe.json和原claim，沿用runId/asOf/methodVersion及冻结名称。默认研究全部在市A股；`--subjects-file` 用 `[{ticker,name,industry?}]` 选择A/五位`.HK`主体。只做isSubject=true（库中is_subject）；关联限冻结在市A股，新run不影响未选主体。

每股上/同行/下游合计10家，比例不限、多角色计一家（其余写notes），排除自身/重复品牌子公司。不足先存并入库partial/gaps，不凑数；先覆盖未处理主体，再补缺口，无行情留空。每轮3批×10股，最多3代理，`fork_turns="none"` 只传项目路径、原claim、worker提示词。按claim顺序保存，5股/整批报代码/阻塞并导入、重建目录；进度只计数据库入库/满10/缺口/失败数。

## 证据口径

优先近期年报/半年报/招股书/公告、双方官网正文；核对身份、业务和方向，分类/标题/搜索摘要/URL/目录仅用于发现候选。先定位关键词/页码，通常输出两段必要正文；短摘录或准确摘要即可，同版充分证据不重读。

- upstream供主体产品/技术/服务；downstream使用主体产品/技术/服务；peer仅business_comparable（公开可比名单/具体业务重叠，非仅同业）。
- 上下游证据：direct_business明确供采/客户/服务；technical_cooperation明确研发合作并说明方向；industry_position须双方业务并注明“产业链位置关联，未证实直接供客”。
- 保留历史/定点/试验/量产阶段，授信非放贷；多元业务限定比较范围。金融按经营关系核实，不凭股东/存款/同业或融资需求推定上下游，类别可零并写缺口。
- 子公司用actualEntity记实际法人，listedMappingBasis/sources证明与relatedTicker上市主体的控制映射；排除剥离业务，勿凭集团/同名推定。publishedAt≤asOf，未知日期不单独证明当前交易。

## 契约与提交

校验器：`backend/market-data/relations-store.mjs:validateResearch`。必需字段：

- 顶层：runId,ticker,asOf,methodVersion,researchedAt,leaseToken,relations（0–10项）,gaps（字符串数组）。
- 关系：relatedTicker,relatedName,relationType,evidenceType,rationale,actualEntity,listedMappingBasis,notes,sources。
- 来源：url,title,publishedAt,excerpt,accessedAt,readingScope。正文HTTP(S) URL；publishedAt为YYYY-MM-DD/null；readingScope为实际full_text/partial_text。

researchedAt为实际核验完成时间，accessedAt为原读取时间，均含时区ISO；复用/重放不刷新时间/范围，旧结果不覆盖新核验。leaseToken原样取claim，import/fail/release用原worker及同代次，勿借新token。程序写verifiedAt；结构通过不代表事实正确，检索者负责语义核实/行业抽查。

恢复缓存后用data:relations:cache的index建目录、find按ticker/产品服务找证据；仅复用成功回执hash匹配资料，仍核对归属/业务/控制关系。同版复核可沿用，新事实另查。紧凑草稿D/drafts/CODE.json用sourceIds替代关系sources；顶层subjectSourceIds放主体证据、newSources字典放完整新来源，每源一次。

compose命令见worker提示词，输出D/research/CODE.json后由原持有者执行：

```sh
npm run data:relations -- --mode import --worker WORKER --file backend/storage/company-relations/ID/research/CODE.json
```

compose仅展开校验，不补事实/时间/token。同run默认增量且总数≤10，`--replace`须完整10家。失败保留gaps，由持有者以原worker/token执行fail/release；fail须tickers及error-code（如network_error/insufficient_evidence），不报成功。
