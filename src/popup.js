'use strict';
const button=document.getElementById('export'), status=document.getElementById('status');
button.onclick=async function(){
 button.disabled=true;status.textContent='正在导出，请查看页面右下角进度。关闭弹窗不会中断导出。';
 try {const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 const result=await chrome.tabs.sendMessage(tab.id,{__dsExportCmd:'export'});
 status.textContent=result.ok?'已导出，请查看浏览器下载记录。':result.error;
 }catch(e){status.textContent='请打开 DeepSeek 对话并刷新页面后重试。';}
 finally{button.disabled=false;}
};
