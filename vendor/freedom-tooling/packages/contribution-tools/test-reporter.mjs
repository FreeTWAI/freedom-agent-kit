import { createFailureDiagnosticEmitter } from './test-failure-diagnostic.mjs';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { writeSync } from 'node:fs';
import { artifactPath, parseJson, readBounded, sha256 } from './io.mjs';


const PROGRESS_SCHEMA = 'freedom.test-file-progress/v1';
const PROGRESS_MAX_BYTES = 1_048_576, PROGRESS_MAX_LINE = 2048, PROGRESS_MAX_FILES = 512, PROGRESS_MAX_FAILURES = 64;
// The longest test process is one hosted four-partition runtime fragment (suite-runner PARTITION_BUDGET_MS).
const PROGRESS_MAX_ELAPSED_MS = 1_200_000;
const FAILURE_TYPES = ['testCodeFailure','hookFailed','testTimeoutFailure','cancelledByParent','testAborted','subtestsFailed','unknown'];
const caseDigest = (d,file) => createHash('sha256').update(JSON.stringify([file,d.details.type,d.line,d.column,d.nesting,d.testNumber,d.testId,d.parentId])).digest('hex');
const PROGRESS_COUNTS = ['tests','passed','failed','cancelled','skipped','todo','suites'];
const validCounts = c => c && typeof c==='object' && !Array.isArray(c)
  && Object.keys(c).length===PROGRESS_COUNTS.length && PROGRESS_COUNTS.every(k=>Number.isSafeInteger(c[k])&&c[k]>=0&&c[k]<=20_000)
  && c.tests===['passed','failed','cancelled','skipped','todo'].reduce((n,k)=>n+c[k],0);
function progressPath(path) { artifactPath(path); if (!/\.test\.(?:ts|mjs)$/.test(path)) throw Error('invalid_progress_path'); return path; }
/** Parent validates every byte before emitting a fresh, closed diagnostic. These
 * candidate-process records never participate in final result admission. */
export function createProgressDecoder(expectedSources, emit) {
  const expected=new Map(expectedSources.map(({path,source_sha256,source_lines})=>[progressPath(path),{source_sha256,source_lines}]));
  if(expected.size!==expectedSources.length||expected.size>PROGRESS_MAX_FILES||[...expected.values()].some(d=>! /^[a-f0-9]{64}$/.test(d.source_sha256)||(d.source_lines!==undefined&&(!Number.isSafeInteger(d.source_lines)||d.source_lines<1))))throw Error('invalid_progress_selection');
  const started=new Set(),completed=new Set(),failures=new Set();let bytes=0,records=0,completedFailures=0,pending=Buffer.alloc(0),invalid=false,exhausted=false;
  function record(line){
    if(++records>PROGRESS_MAX_FILES*2+PROGRESS_MAX_FAILURES){invalid=true;exhausted=true;return;}
    try{
      const r=parseJson(line,{maxBytes:PROGRESS_MAX_LINE,maxDepth:3,maxNodes:32});
      const failed=r.event==='failed_case';
      const keys=failed?['schema','event','path','source_sha256','elapsed_ms','case_sha256','failure_type',...(Object.hasOwn(r,'source_line')?['source_line']:[])]:r.event==='started'?['schema','event','path','source_sha256','elapsed_ms']:['schema','event','path','source_sha256','elapsed_ms','counts'];
      if(Object.keys(r).length!==keys.length||!keys.every(k=>Object.hasOwn(r,k))||r.schema!==PROGRESS_SCHEMA||!['started','completed','failed_case'].includes(r.event)
        ||!expected.has(r.path)||expected.get(r.path).source_sha256!==r.source_sha256||!Number.isSafeInteger(r.elapsed_ms)||r.elapsed_ms<0||r.elapsed_ms>PROGRESS_MAX_ELAPSED_MS
        ||(r.event==='started'?started.has(r.path):!started.has(r.path)||completed.has(r.path)||(!failed&&!validCounts(r.counts)))
        ||(failed&&(!/^[a-f0-9]{64}$(?![\s\S])/.test(r.case_sha256)||failures.has(r.case_sha256)||failures.size>=PROGRESS_MAX_FAILURES||!FAILURE_TYPES.includes(r.failure_type)
          ||(Object.hasOwn(r,'source_line')&&(!Number.isSafeInteger(r.source_line)||r.source_line<1||expected.get(r.path).source_lines===undefined||r.source_line>expected.get(r.path).source_lines)))))throw Error();
      (failed?failures:r.event==='started'?started:completed).add(failed?r.case_sha256:r.path);
      if(r.event==='completed')completedFailures+=r.counts.failed+r.counts.cancelled;
      // Reconstruct rather than relay parsed bytes or unknown candidate fields.
      emit({schema:PROGRESS_SCHEMA,event:r.event,path:r.path,source_sha256:r.source_sha256,elapsed_ms:r.elapsed_ms,
        ...(failed?{case_sha256:r.case_sha256,failure_type:r.failure_type,...(Object.hasOwn(r,'source_line')?{source_line:r.source_line}:{})}:r.event==='completed'?{counts:Object.fromEntries(PROGRESS_COUNTS.map(k=>[k,r.counts[k]]))}:{})});
    }catch{invalid=true;}
  }
  return Object.freeze({
    push(chunk){if(exhausted)return;bytes+=chunk.length;if(bytes>PROGRESS_MAX_BYTES){invalid=true;exhausted=true;pending=Buffer.alloc(0);return;}
      pending=Buffer.concat([pending,chunk]);let newline;
      while(!exhausted&&(newline=pending.indexOf(10))!==-1){const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);if(line.length>PROGRESS_MAX_LINE){invalid=true;continue;}record(line);}
      if(pending.length>PROGRESS_MAX_LINE){invalid=true;exhausted=true;pending=Buffer.alloc(0);}
    },
    finish(){return {schema:'freedom.test-file-progress-summary/v1',selected_count:expected.size,started_count:started.size,completed_count:completed.size,incomplete:invalid||pending.length>0||completed.size!==expected.size||failures.size!==completedFailures};},
  });
}
async function fileProgress() {
  const epoch=performance.now();let selected;
  try{
    if(typeof process.env.FREEDOM_TEST_PROGRESS_FILES!=='string')return ()=>{};
    const paths=parseJson(process.env.FREEDOM_TEST_PROGRESS_FILES,{maxBytes:131_072,maxDepth:2,maxNodes:514});
    if(!Array.isArray(paths)||paths.length>PROGRESS_MAX_FILES||new Set(paths).size!==paths.length)throw Error();
    selected=new Map();let total=0;
    for(const path of paths){progressPath(path);const bytes=await readBounded(process.cwd(),path);total+=bytes.length;if(total>32_000_000)throw Error();selected.set(path,{digest:sha256(bytes),lines:bytes.toString('utf8').split('\n').length});}
  }catch{return ()=>{};}
  const started=new Set(),completed=new Set();let records=0,total=0,failureCount=0,disabled=false;
  return event=>{
    if(disabled)return;
    const d=event.data,path=typeof d?.file==='string'?relative(process.cwd(),d.file):'';
    if(!selected.has(path))return;
    const start=event.type==='test:dequeue'&&d.entryFile===undefined&&d.nesting===0;
    const complete=event.type==='test:summary'&&started.has(path);
    const failed=event.type==='test:fail'&&d.details?.type==='test'&&d.skip===undefined&&d.todo===undefined&&started.has(path)&&!completed.has(path);
    if(failed&&failureCount++>=PROGRESS_MAX_FAILURES)return;
    if((!start&&!complete&&!failed)||(start&&started.has(path))||(complete&&completed.has(path)))return;
    const counts=complete?Object.fromEntries(PROGRESS_COUNTS.map(k=>[k,d.counts?.[k]])):undefined;
    if(complete&&!validCounts(counts))return;
    if(!failed)(start?started:completed).add(path);
    const type=d.details?.error?.failureType;
    const sourceLine=Number.isSafeInteger(d.line)&&d.line>=1&&d.line<=selected.get(path).lines?d.line:undefined;
    const value={schema:PROGRESS_SCHEMA,event:failed?'failed_case':start?'started':'completed',path,source_sha256:selected.get(path).digest,elapsed_ms:Math.min(PROGRESS_MAX_ELAPSED_MS,Math.max(0,Math.floor(performance.now()-epoch))),
      ...(failed?{case_sha256:caseDigest(d,path),failure_type:FAILURE_TYPES.includes(type)?type:'unknown',...(sourceLine!==undefined?{source_line:sourceLine}:{})}:complete?{counts}:{})};
    const line=JSON.stringify(value)+'\n';total+=Buffer.byteLength(line);
    if(++records>PROGRESS_MAX_FILES*2+PROGRESS_MAX_FAILURES||total>PROGRESS_MAX_BYTES){disabled=true;return;}
    try{writeSync(3,line);}catch{disabled=true;}
  };
}

async function failureDiagnostics() {
  try {
    const paths=parseJson(process.env.FREEDOM_TEST_PROGRESS_FILES,{maxBytes:131072,maxDepth:2,maxNodes:514});
    if(!Array.isArray(paths)||paths.length>512)return ()=>{};
    const sources=[];
    for(const path of ['tests/runtime/model-broker-bridge-adversarial.test.ts','tests/runtime/media-verify.test.ts','tests/runtime/credential-ingest-process.test.ts','tests/runtime/credential-ingest-adversarial.test.ts','tests/runtime/member-model-settings-process.test.ts','tests/runtime/credential-ingest-rate-budget.test.ts']) {
      if(!paths.includes(path))continue;
      const bytes=await readBounded(process.cwd(),path);
      sources.push({path,source_sha256:sha256(bytes),source_lines:bytes.toString('utf8').split('\n').length});
    }
    return createFailureDiagnosticEmitter(sources,line=>writeSync(4,line),caseDigest);
  }catch{return ()=>{};}
}

// Structured events avoid accidental TAP/stdout confusion, not hostile-code
// spoofing: this reporter and the tests still run in a candidate-controlled
// local checkout. Never promote these records to authenticated host observations.
export default async function* report(source) {
  const files = [], cases = [], suites = [];
  const progress = await fileProgress();
  const failureDiagnostic = await failureDiagnostics();
  for await (const event of source) {
    progress(event);
    failureDiagnostic(event);
    if (['test:pass', 'test:fail'].includes(event.type) && ['test', 'suite'].includes(event.data.details?.type)) {
      const d = event.data;
      const file = typeof d.file === 'string' ? relative(process.cwd(), d.file) : '';
      const status = d.skip !== undefined ? 'skipped' : d.todo !== undefined ? 'todo' : event.type === 'test:pass' ? 'passed'
        : ['cancelledByParent', 'testAborted', 'testTimeoutFailure'].includes(d.details.error?.failureType) ? 'cancelled' : 'failed';
      // Locations and runner identifiers, never test names, assertion text,
      // exception messages, stdout, database URLs or ambient environment.
      (d.details.type === 'suite' ? suites : cases).push({ file, case_sha256: caseDigest(d,file), status });
    }
    if (event.type !== 'test:summary') continue;
    const { file, counts, success } = event.data;
    if (file) files.push({ file: relative(process.cwd(), file), counts, success });
    else yield JSON.stringify({ counts, success, files, cases, suites }) + '\n';
  }
}
