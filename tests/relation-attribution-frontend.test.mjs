import test from 'node:test';import assert from 'node:assert/strict';
import {initRelationAttribution} from '../frontend/src/features/relation-attribution.js';
class Element{constructor(){this.children=[];this.listeners={};this.textContent='';this.disabled=false;}append(...nodes){this.children.push(...nodes)}replaceChildren(...nodes){this.children=nodes}addEventListener(k,fn){this.listeners[k]=fn}}
test('category filter only switches saved prose/sources, never requests AI; changed relationships hide old text',async t=>{
 const original={document:globalThis.document,fetch:globalThis.fetch};t.after(()=>{globalThis.document=original.document;globalThis.fetch=original.fetch});
 const elements=Object.fromEntries(['relation-attribution','relative-analysis','relative-status','relative-sources','relative-generate'].map(k=>[k,new Element()]));const listeners={};globalThis.document={getElementById:k=>elements[k],createElement:()=>new Element(),addEventListener:(k,fn)=>listeners[k]=fn};
 const calls=[];let freshness='fresh';globalThis.fetch=async(url,opts)=>{calls.push([url,opts]);return Response.json({data:{freshness,report:{analyses:{all:{text:'全部融合原因',sourceIds:['s1'],limitations:[]},peer:{text:'同行融合原因',sourceIds:['s2'],limitations:[]}},sources:[{id:'s1',url:'https://example.com/a',title:'全部来源'},{id:'s2',url:'https://example.com/b',title:'同行来源'}],snapshot:{quoteDate:'2026-10-28',relations:[]},generatedAt:new Date().toISOString()}}})};
 const ui=initRelationAttribution({getContext:()=>({ticker:'002920.SZ',asOf:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())})});
 ui.sync();await new Promise(setImmediate);assert.equal(elements['relative-analysis'].textContent,'全部融合原因');const n=calls.length;
 listeners['relation-comparison-filter']({detail:{scope:'peer'}});assert.equal(elements['relative-analysis'].textContent,'同行融合原因');assert.equal(calls.length,n);
 freshness='relations_changed';ui.sync();await new Promise(setImmediate);assert.match(elements['relative-analysis'].textContent,/名单已变化/);assert.ok(calls.every(([,o])=>o.method==='GET'));
});
