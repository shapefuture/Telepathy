// Temporary same-origin rescue page for a blob still registered by Telegram's WebKit process.
// It performs no Telegram login and never sends the blob anywhere until Upload is pressed.

export const RECOVERY_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Recover export</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{font:16px/1.5 system-ui;margin:24px;max-width:650px}button{font:inherit;padding:12px;margin:8px 8px 8px 0}pre{white-space:pre-wrap;word-break:break-word;background:#eee;padding:12px}.ok{background:#dfd}.bad{background:#fdd}</style></head>
<body><h1>ZIP recovery test</h1><p>Leave the original result window open. This separate window only tests access to its blob.</p>
<pre id="status">Requesting the original blob…</pre><div id="actions"></div><script>
"use strict";
var tg=window.Telegram&&Telegram.WebApp;if(tg){tg.ready();tg.expand()}
var status=document.getElementById("status"),actions=document.getElementById("actions"),recovered=null;
var url="blob:https://telepathy.wmobilas.workers.dev/d0723d91-dedc-4989-9e3a-22dddb9448a9";
function say(text,kind){status.textContent=text;status.className=kind||""}
function button(text,fn){var b=document.createElement("button");b.textContent=text;b.onclick=fn;actions.appendChild(b);return b}
fetch(url).then(async function(response){
 var blob=await response.blob();
 say("HTTP "+response.status+" · "+blob.size+" bytes · "+(blob.type||"unknown type"));
 if(blob.size!==23901116){say("The blob was readable but its size was "+blob.size+", not the expected 23,901,116 bytes. Nothing was uploaded.","bad");return}
 recovered=blob;
 var mod=await import("/export/export.js");
 await mod.saveRecovery(blob,"telegram-recovered-316090.zip",316090);
 say("SUCCESS: 23,901,116 bytes recovered and saved in IndexedDB. No Telegram sign-in is needed.","ok");
 button("Upload & download ZIP",function(){
  if(!confirm("Upload this recovered ZIP to tmpfiles and create a public download link?"))return;
  say("Uploading recovered ZIP…");
  mod.uploadTmpfiles(recovered,"telegram-recovered-316090.zip").then(function(link){
   say("Upload complete: "+link.downloadUrl,"ok");
   if(tg&&tg.downloadFile)tg.downloadFile({url:link.downloadUrl,file_name:"telegram-recovered-316090.zip"});
   else if(tg)tg.openLink(link.downloadUrl);else window.open(link.downloadUrl,"_blank","noopener");
  }).catch(function(e){say("Upload failed: "+e+". The IndexedDB copy is still saved.","bad")})
 });
 if(!tg)button("Download in this browser",function(){var a=document.createElement("a");a.href=URL.createObjectURL(recovered);a.download="telegram-recovered-316090.zip";a.click()});
}).catch(function(e){say("This window cannot access the original blob: "+e+". Keep the original window open.","bad")});
</script></body></html>`;
