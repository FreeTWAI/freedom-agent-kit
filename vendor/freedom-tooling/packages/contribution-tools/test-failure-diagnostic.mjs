import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson } from './io.mjs';

const PATHS = ['tests/runtime/model-broker-bridge-adversarial.test.ts','tests/runtime/media-verify.test.ts','tests/runtime/credential-ingest-process.test.ts','tests/runtime/credential-ingest-adversarial.test.ts','tests/runtime/member-model-settings-process.test.ts','tests/runtime/credential-ingest-rate-budget.test.ts'];
const SCHEMA = 'freedom.test-failure-diagnostic/v1';
const MAX_BYTES = 262144, MAX_LINE = 2048, MAX_RECORDS = 64;
const NAMES = ['AssertionError','TypeError','Error','unknown'];
const CODES = ['ERR_ASSERTION','ERR_TEST_FAILURE','unknown'];
const CLASSES = ['sql_wait_not_observed','asset_read_not_reached','expiry_assertion','assertion_failed','fetch_failed','custody_outcome_unconfirmed','operation_timeout','unknown'];
const hash = v => typeof v==='string' && /^[a-f0-9]{64}$(?![\s\S])/.test(v);
const exact = (v,keys) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const comparisonValue = v => typeof v==='boolean' || Number.isSafeInteger(v)&&Math.abs(v)<=20000;
const INGEST_PHASES=['browser_context','issue','navigation_blank','navigation_submit','navigation_wait','screenshot','key_fill','consent_check','submit_click','ack_wait','broker_wait','owner_read','owner_assert','page_close'];
const INGEST_STATES=['not_seen','request','response','failed'];
const validIngest=d=>exact(d,['phase','prepare_state','prepare_status','secret_state','secret_status','custody'])
  &&['not_checked','absent','one_active','multiple_active','unavailable'].includes(d.custody)&&INGEST_PHASES.includes(d.phase)&&INGEST_STATES.includes(d.prepare_state)&&INGEST_STATES.includes(d.secret_state)
  &&[d.prepare_status,d.secret_status].every(v=>v===null||Number.isInteger(v)&&v>=100&&v<=599);
/** Fixture-only bounded annotations. Never replace the original Error/TimeoutError. */
export function createIngestBrowserDiagnostic(){
 const state={phase:'browser_context',prepare_state:'not_seen',prepare_status:null,secret_state:'not_seen',secret_status:null,custody:'not_checked'};
 return Object.freeze({phase(value){if(INGEST_PHASES.includes(value))state.phase=value;},
  observe(kind,event,status=null){if(!['prepare','secret'].includes(kind)||!INGEST_STATES.includes(event)||!(status===null||Number.isInteger(status)&&status>=100&&status<=599))return;
   state[kind+'_state']=event;if(status!==null)state[kind+'_status']=status;},
  custody(value){if(['absent','one_active','multiple_active','unavailable'].includes(value))state.custody=value;},
  annotate(error){try{if(error&&typeof error==='object')Object.defineProperty(error,'freedom_ingest',{value:{...state},enumerable:true,configurable:true});}catch{}return error;}
 });
}
function sourcesMap(sources) {
  return new Map(sources.filter(s=>PATHS.includes(s.path)).map(s=>[s.path,s]));
}
function detail(error) {
  const chain=[];for(let e=error;e&&chain.length<4;e=e.cause)chain.push(e);
  const actual=chain.find(e=>e.code==='ERR_ASSERTION')??chain.find(e=>NAMES.includes(e.name))??{};
  const message=typeof actual.message==='string'&&actual.message.length<=8192?actual.message:'';
  const message_class=['Actual SQL wait was not observed','Actual SQL wait not observed'].includes(message)?'sql_wait_not_observed'
    :message==='actual asset read must reach the trusted port before deadline'?'asset_read_not_reached'
    :actual.code==='ERR_ASSERTION'&&/assert\(\s*expires\s*>\s*Date\.now\(\)\s*\)/.test(message)?'expiry_assertion'
    :actual.code==='ERR_ASSERTION'&&actual.expected==='committed'?'custody_outcome_unconfirmed'
    :chain.some(e=>e.name==='TimeoutError')?'operation_timeout'
    :actual.code==='ERR_ASSERTION'?'assertion_failed':message==='fetch failed'?'fetch_failed':'unknown';
  const ingest=chain.map(e=>e.freedom_ingest).find(validIngest);
  return {error_name:NAMES.includes(actual.name)?actual.name:'unknown',error_code:CODES.includes(actual.code)?actual.code:'unknown',message_class,...(ingest?{ingest:{...ingest}}:{}),
    ...(chain.some(e=>e.code==='UND_ERR_SOCKET')?{cause_code:'UND_ERR_SOCKET'}:{}),
    ...(actual.code==='ERR_ASSERTION'&&comparisonValue(actual.actual)&&comparisonValue(actual.expected)?{comparison:{actual:actual.actual,expected:actual.expected}}:{})};
}
function validDetail(d) {
  return exact(d,['error_name','error_code','message_class',...(Object.hasOwn(d??{},'cause_code')?['cause_code']:[]),...(Object.hasOwn(d??{},'comparison')?['comparison']:[]),...(Object.hasOwn(d??{},'ingest')?['ingest']:[])])
    &&NAMES.includes(d.error_name)&&CODES.includes(d.error_code)&&CLASSES.includes(d.message_class)
    &&(!Object.hasOwn(d,'ingest')||validIngest(d.ingest))
    &&(!Object.hasOwn(d,'cause_code')||d.cause_code==='UND_ERR_SOCKET')
    &&(!Object.hasOwn(d,'comparison')||d.error_code==='ERR_ASSERTION'&&exact(d.comparison,['actual','expected'])&&comparisonValue(d.comparison.actual)&&comparisonValue(d.comparison.expected));
}
// Inspect a bounded stack only for this exact selected, source-hashed file.
// Other file names, paths, messages, columns and stack text never leave the child.
// A helper failure may yield the same-file caller line, not the helper assertion.
function failureSourceLine(error,path,source,fallback) {
  const absolute=resolve(process.cwd(),path),prefixes=[absolute,pathToFileURL(absolute).href];
  const chain=[];for(let e=error;e&&chain.length<4;e=e.cause)chain.push(e);
  for(const e of chain.reverse()) {
    if(typeof e.stack!=='string'||e.stack.length>8192)continue;
    for(const frame of e.stack.split('\n').slice(1,25)) {
      if(!/^\s+at /.test(frame))continue;
      for(const prefix of prefixes) {
        const start=frame.indexOf(prefix+':');if(start<0)continue;
        const before=frame.slice(0,start);
        if(!/^(?:\s+at |\s+at [^()\r\n]*\()$/.test(before))continue;
        const match=/^([1-9][0-9]{0,6}):[1-9][0-9]{0,6}\)?$/.exec(frame.slice(start+prefix.length+1));
        const line=match?Number(match[1]):0;
        if(line>=1&&line<=source.source_lines)return line;
      }
    }
  }
  return Number.isSafeInteger(fallback)&&fallback>=1&&fallback<=source.source_lines?fallback:undefined;
}
/** No raw messages, names, stack, env, bodies or object actual/expected values. */
export function createFailureDiagnosticEmitter(sources,write,caseDigest) {
  const selected=sourcesMap(sources);let records=0,bytes=0;
  return event=>{try{
    const d=event.data,path=typeof d?.file==='string'?relative(process.cwd(),d.file):'';
    if(event.type!=='test:fail'||d.details?.type!=='test'||d.skip!==undefined||d.todo!==undefined||!selected.has(path)||records>=MAX_RECORDS)return;
    const source=selected.get(path),source_line=failureSourceLine(d.details.error,path,source,d.line);
    const value={schema:SCHEMA,path,source_sha256:source.source_sha256,case_sha256:caseDigest(d,path),...(source_line!==undefined?{source_line}:{}),detail:detail(d.details.error)};
    const line=JSON.stringify(value)+'\n',size=Buffer.byteLength(line);if(size>MAX_LINE||bytes+size>MAX_BYTES)return;
    bytes+=size;records++;write(line);
  }catch{/* Diagnostic failure has no influence on the primary report. */}};
}
export function createFailureDiagnosticDecoder(sources,emit) {
  const selected=sourcesMap(sources),seen=new Set();let pending=Buffer.alloc(0),bytes=0,disabled=false;
  return Object.freeze({push(chunk){if(disabled)return;bytes+=chunk.length;if(bytes>MAX_BYTES){disabled=true;pending=Buffer.alloc(0);return;}
    pending=Buffer.concat([pending,chunk]);let end;
    while((end=pending.indexOf(10))!==-1){const line=pending.subarray(0,end);pending=pending.subarray(end+1);try{
      if(line.length>MAX_LINE||seen.size>=MAX_RECORDS)continue;
      const r=parseJson(line,{maxBytes:MAX_LINE,maxDepth:4,maxNodes:32}),source=selected.get(r.path);
      if(!source||!exact(r,['schema','path','source_sha256','case_sha256','detail',...(Object.hasOwn(r,'source_line')?['source_line']:[])])||r.schema!==SCHEMA||r.source_sha256!==source.source_sha256||!hash(r.case_sha256)||seen.has(r.case_sha256)||!validDetail(r.detail)
        ||Object.hasOwn(r,'source_line')&&(!Number.isSafeInteger(r.source_line)||r.source_line<1||!Number.isSafeInteger(source.source_lines)||r.source_line>source.source_lines))continue;
      seen.add(r.case_sha256);emit({schema:SCHEMA,path:r.path,source_sha256:r.source_sha256,case_sha256:r.case_sha256,...(Object.hasOwn(r,'source_line')?{source_line:r.source_line}:{}),detail:{error_name:r.detail.error_name,error_code:r.detail.error_code,message_class:r.detail.message_class,...(r.detail.ingest?{ingest:{...r.detail.ingest}}:{}),...(r.detail.cause_code?{cause_code:r.detail.cause_code}:{}),...(r.detail.comparison?{comparison:{actual:r.detail.comparison.actual,expected:r.detail.comparison.expected}}:{})}});
    }catch{/* Invalid untrusted sideband is discarded. */}}
    if(pending.length>MAX_LINE){disabled=true;pending=Buffer.alloc(0);}
  }});
}
