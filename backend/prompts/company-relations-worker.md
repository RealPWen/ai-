# 单批公司关系研究

读原claim、同run的universe及 `company-relations.md` 的“证据口径”“契约与提交”。沿用冻结runId/asOf/methodVersion/名称，仅做claim主体（isSubject=true）；主体可A/港股，关联限冻结在市A股。按claim顺序逐股目标10家，不足先存partial/gaps，不凑数、不造行情。

先复用证据，只为缺失/变化事实联网读必要正文；目录命中不证明关系。业务方向、同行、合作阶段、法人映射、来源日期按主规范核实。

```sh
npm run data:relations:cache -- --mode find --run-id ID --ticker CODE --query 产品或服务
npm run data:relations:cache -- --mode compose --run-id ID --file drafts/CODE.json --claim claims/WORKER.json
```

逐股草稿存本run的drafts/CODE.json，字段按主规范：sources改sourceIds，顶层subjectSourceIds/newSources复用来源；researchedAt用实际核验时间，原accessedAt/范围不变，leaseToken原样取claim，勿补时间/借代次。

research/CODE.json及时交原worker持有者按主规范import；草稿不算入库。不得写DB、改schema/实现或调用项目密钥/付费模型API。每5股/整批仅报代码/阻塞，持有者导入并重建index；失败保留缺口/错误，由持有者原租约fail/release。
