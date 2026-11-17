(function () {
'use strict';
var CHANNEL = 'DS_EXPORT_V1';
var state = {records: [], busy: false};
var button, logs;
function refreshStatus() {}
  function upsertRecord(record) {
    if (!record || !record.id) return;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === record.id) {
        state.records[i] = record;
        return;
      }
    }
    state.records.push(record);
    if (state.records.length > 400) state.records.splice(0, state.records.length - 400);
  }

  window.addEventListener('message', function (event) {
    // 只认本窗口的消息（不同浏览器里 event.source 与 window 的严格相等性有差异，放宽一点）
    if (event.source && event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.__dsExport !== CHANNEL) return;

    if (data.type === 'record' && data.record) {
      upsertRecord(data.record);
      refreshStatus();
    } else if (data.type === 'begin' && data.record) {
      upsertRecord(data.record);
      refreshStatus();
    } else if (data.type === 'dump' && Array.isArray(data.records)) {
      state.records = data.records.slice();
      refreshStatus();
    }
  });

  function askForDump() {
    try {
      window.postMessage({ __dsExportReq: 'dump' }, window.location.origin);
    } catch (e) { /* ignore */ }
  }


function log(text) { if (logs) { logs.textContent += text + '\n'; logs.scrollTop = logs.scrollHeight; } }
async function runExport() {
 if (state.busy) return {ok:false, error:'正在导出，请稍候'};
 state.busy = true; button.disabled = true; logs.textContent = '';
 try {
  var result = await window.DSExportCore.runExport({scope:'current', records:state.records,
   exports:'chat', mode:'chat', includeRaw:false, includeThinking:false, includeCapture:false,
   domFallback:true, autoScroll:true, onLog:function(level, text) {log(text);} });
  var blob = new Blob([result.text], {type:'text/markdown;charset=utf-8'});
  var url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = result.textFilename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);}, 5000);
  log('已导出：' + result.textFilename);
  if (result.summary.incomplete) log('完整性尚未确认，请抽查开头、结尾和中间轮次。');
  return {ok:true, filename:result.textFilename, summary:result.summary};
 } catch(e) {log('导出失败：' + e.message); return {ok:false,error:e.message};}
 finally {state.busy=false; button.disabled=false;}
}
function boot() {
 var host=document.createElement('div'); host.id='ds-export-host';
 var shadow=host.attachShadow({mode:'open'});
 shadow.innerHTML='<style>:host{position:fixed;right:20px;bottom:20px;z-index:2147483647;font:14px/1.6 sans-serif}details{width:300px;background:#fff;color:#222;border:1px solid #ddd;border-radius:12px;padding:14px;box-shadow:0 4px 24px #0002}summary{cursor:pointer;font-weight:bold}button{width:100%;padding:10px;background:#4d6bfe;color:white;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.5}p{font-size:12px;color:#666}pre{font:12px/1.5 sans-serif;white-space:pre-wrap;max-height:160px;overflow:auto}</style><details><summary>导出对话 · 精简版</summary><p>保存当前对话的轮次、发言人与正文。有真实发言时间时一并标注。已自动开启页面兜底与滚动加载。</p><button>导出当前会话</button><p>导出期间请勿切换会话。</p><pre></pre></details>';
 document.body.appendChild(host); button=shadow.querySelector('button'); logs=shadow.querySelector('pre');
 button.addEventListener('click',runExport);
 chrome.runtime.onMessage.addListener(function(msg,sender,reply){
  if (msg.__dsExportCmd==='ping') {reply({ok:!!window.DSExportCore});return;}
  if (msg.__dsExportCmd==='export') {shadow.querySelector('details').open=true;runExport().then(reply);return true;}
 });
 askForDump();setTimeout(askForDump,800);setTimeout(askForDump,2500);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
