export function initRelationAttribution({getContext}){
 const panel=document.getElementById('relation-attribution'),text=document.getElementById('relative-analysis'),status=document.getElementById('relative-status'),sources=document.getElementById('relative-sources'),button=document.getElementById('relative-generate');
 let key='',scope='all',data=null,serial=0,timer=null,busy=false,controller=null;
 const names={all:'全部关联公司',upstream:'上游',peer:'同行',downstream:'下游'};
 const messages={fresh:'已保存',missing:'尚未生成',stale:'归因待更新',relations_changed:'名单已变化，归因待更新',unavailable:'比较数据尚未就绪'};
 const failure={DEEPSEEK_INSUFFICIENT_BALANCE:'AI余额不足',DEEPSEEK_INVALID_JSON:'AI格式修复失败',RELATIVE_INVALID_EVIDENCE:'引用校验未通过',RELATIVE_INVALID_SHAPE:'分析格式未通过校验',RELATIVE_NO_SOURCES:'联网未取得可靠资料',RELATIVE_INTERRUPTED:'任务已中断，可重试'};
 async function request(path,body,signal){const r=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:signal??AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)throw new Error(result.error?.message||'读取归因失败');return result.data;}
 function render(){
  const ctx=getContext();panel.hidden=false;
  const running=busy||data?.job?.status==='running';button.disabled=running||ctx.asOf!==new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  button.textContent=running?'正在联网分析…':data?.report?'更新相对归因':'生成相对归因';
  status.textContent=`${names[scope]} · ${running?'正在联网分析':messages[data?.freshness]||'等待读取'}`;
  sources.replaceChildren();
  const report=data?.report,analysis=report?.analyses?.[scope];
  if(data?.freshness==='relations_changed'){text.textContent='关联名单已变化，更新后再查看当前范围分析。';return;}
  if(!analysis){text.textContent=data?.reason||'该范围暂无已保存的相对归因。生成后将融合1周与6个月，解释具体公司之间的表现差异。';}
  else {
   text.textContent=analysis.text;
   const meta=document.createElement('p');meta.className='relative-meta';meta.textContent=`行情截止 ${report.snapshot.quoteDate} · 生成 ${new Date(report.generatedAt).toLocaleString('zh-CN')} · ${report.searchFailureCount?`${report.searchFailureCount}次检索失败，资料可能不全`:'联网公告与新闻分析'}`;sources.append(meta);
   const limits=[...analysis.limitations];
   for(const r of report.snapshot.relations.filter(r=>scope==='all'||r.type===scope))for(const p of ['w1','m6'])if(r.gaps[p].value===null)limits.push(`${r.name} ${p==='w1'?'1周':'6个月'}未参与比较：${r.gaps[p].reason}`);
   if(limits.length){const p=document.createElement('p');p.className='relative-meta';p.textContent=limits.join('；');sources.append(p);}
   const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看引用来源';details.append(summary);
   for(const source of report.sources.filter(s=>analysis.sourceIds.includes(s.id))){const p=document.createElement('p'),a=document.createElement('a');if(!/^https?:\/\//i.test(source.url))continue;a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=`${source.title} · ${source.publishedAt} · ${source.readingScope==='partial_text'?'部分正文':'搜索摘要'}`;p.append(a);details.append(p);}sources.append(details);
  }
  if(data?.job?.status==='failed'){const p=document.createElement('p');p.className='relative-error';p.textContent=`本次未完成：${failure[data.job.errorCode]||'分析失败'}，已保留原报告。`;sources.append(p);}
 }
 async function load(){
  const ctx=getContext(),thisKey=`${ctx.ticker}|${ctx.asOf}`,id=++serial;
  controller?.abort();controller=new AbortController();
  try{const result=await request(`/api/relations/attribution?ticker=${encodeURIComponent(ctx.ticker)}&asOf=${encodeURIComponent(ctx.asOf)}`,null,controller.signal);if(id!==serial||key!==thisKey)return;data=result;render();if(result.job?.status==='running')timer=setTimeout(()=>void load(),5000);}
  catch(e){if(id===serial&&e.name!=='AbortError'){status.textContent=e.message;}}
 }
 function sync(){const ctx=getContext(),next=`${ctx.ticker}|${ctx.asOf}`;if(next!==key){key=next;data=null;scope='all';busy=false;render();}clearTimeout(timer);void load();}
 button.addEventListener('click',async()=>{if(button.disabled)return;const ctx=getContext(),oldKey=key;busy=true;render();try{await request('/api/relations/attribution/generate',{ticker:ctx.ticker});if(oldKey===key){busy=false;await load();}}catch(e){if(oldKey===key){busy=false;render();status.textContent=e.message;}}});
 document.addEventListener('relation-comparison-filter',event=>{scope=event.detail.scope;render();});
 return {sync};
}
