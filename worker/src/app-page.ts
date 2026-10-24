// Mini App page: plain HTML + inline JS, no build step, no third-party code except Telegram's
// WebApp script. Text is inserted with textContent; the only HTML we render (digest, privacy)
// is our own server output, passed through a strict tag allowlist first.
// The JS below avoids backticks so it can live inside this template string.

export const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Telepathy</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--bg2:var(--tg-theme-secondary-bg-color,#f2f3f5);--tx:var(--tg-theme-text-color,#111);
--hint:var(--tg-theme-hint-color,#888);--link:var(--tg-theme-link-color,#2a7ae2);--btn:var(--tg-theme-button-color,#2a7ae2);
--btx:var(--tg-theme-button-text-color,#fff);--sec:var(--tg-theme-section-bg-color,var(--bg));--danger:var(--tg-theme-destructive-text-color,#d33);--r:12px}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg2);color:var(--tx);font:15px/1.4 -apple-system,system-ui,Roboto,sans-serif}
main{padding:12px 12px 84px;max-width:720px;margin:0 auto}h1{font-size:20px;margin:6px 4px 12px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--hint);margin:18px 6px 6px;font-weight:600}
.card{background:var(--sec);border-radius:var(--r);padding:12px 14px;margin:8px 0}.row{display:flex;gap:8px;align-items:center}.grow{flex:1;min-width:0}
.muted{color:var(--hint);font-size:13px}.pill{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:var(--bg2);color:var(--hint);margin-right:4px}
.pill.ok{color:#1a7f37}.pill.warn{color:#b26a00}.q{border-left:3px solid var(--btn);padding:2px 10px;margin:8px 0;white-space:pre-wrap;word-break:break-word}
button,.btn{font:inherit;border:0;border-radius:10px;padding:9px 14px;background:var(--btn);color:var(--btx);cursor:pointer}
button.sec{background:var(--bg2);color:var(--tx)}button.link{background:none;color:var(--link);padding:6px 4px}button.danger{background:none;color:var(--danger)}
button:disabled{opacity:.5}.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
input,textarea,select{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid #8883;background:var(--bg);color:var(--tx)}
textarea{min-height:86px;resize:vertical}.chips{display:flex;gap:6px;overflow-x:auto;padding:4px 0}.chip{white-space:nowrap;padding:6px 12px;border-radius:99px;background:var(--sec);color:var(--tx);font-size:13px}
.chip.on{background:var(--btn);color:var(--btx)}.chip a{color:inherit;text-decoration:none;margin-left:6px;font-weight:600}input[type=checkbox]{accent-color:var(--btn);width:20px;height:20px}.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.stat .card{text-align:center;margin:0;cursor:pointer}.stat b{display:block;font-size:22px}
nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:var(--sec);border-top:1px solid #8882;padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;background:none;color:var(--hint);border-radius:0;padding:8px 2px 10px;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:2px}
nav button.on{color:var(--btn)}.sw{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #8881}.sw:last-child{border:0}
.tl{margin:8px 0 0 4px;border-left:2px solid #8883;padding-left:10px}.tl div{font-size:13px;margin:3px 0}.badge{background:var(--danger);color:#fff;border-radius:99px;font-size:10px;padding:0 5px;margin-left:2px}
.sub{display:flex;gap:6px;margin:4px 0 8px;overflow-x:auto}pre{white-space:pre-wrap;word-break:break-all;font-size:11px;max-height:140px;overflow:auto;background:var(--bg2);padding:8px;border-radius:8px}
.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#000c;color:#fff;padding:8px 14px;border-radius:10px;font-size:14px;z-index:9;max-width:90%}
.empty{text-align:center;color:var(--hint);padding:24px 8px}blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #8884}a{color:var(--link)}
</style></head><body><main id="main"><p class="empty">…</p></main><nav id="nav"></nav>
<script>
"use strict";
var tg=window.Telegram&&Telegram.WebApp;if(tg){tg.ready();tg.expand();}
var H={"x-telegram-init-data":tg?tg.initData:"","content-type":"application/json"};
var ver=function(v){return tg&&tg.isVersionAtLeast&&tg.isVersionAtLeast(v)};
var L={en:{home:"Home",ask:"Ask",req:"Requests",ev:"Events",me:"Me",desk:"Desk",hi:"Hi! What do you need?",askPh:"Ask your groups…",search:"Search",
needHelp:"Need help with something?",newReq:"New request",reqPh:"What do you need? One or two sentences, without contacts or links.",create:"Continue",
open:"open requests",offers:"offers for you",inv:"intro invitations",catch:"What's new",c12:"12 h",c3:"3 days",cLast:"Since last time",nothingNew:"Nothing new.",
next:"Coming up",noEv:"No upcoming events in your groups.",ics:"Send calendar file to chat",sent:"Sent to your chat.",allGroups:"All groups",anyTime:"Any time",
withFile:"With files",noRes:"No answer found.",fixed:"Corrected:",helpful:"Helpful",notHelpful:"Not helpful",wrong:"Wrong source",thx:"Thanks!",
toReq:"Didn't help? Turn it into a request",draft:"Draft",draftNote:"If you confirm, I search your groups first and the community operator can see this summary. Nothing leaves this community without your separate permission.",
confirm:"Confirm",cancel:"Cancel",solved:"Solved",more:"I still need help",toDesk:"Send to the operator desk",fromGroups:"From your groups",
pv:"Ask partner communities",allow:"Allow sharing",inside:"Keep it inside",pvTitle:"Partners would receive only",pvNot:"Not your name, Telegram account, groups or messages. Valid 14 days; withdraw any time.",
partnersL:"Partners",blocked:"Your summary contains contacts or links. Cancel it and write a new request without them.",choose:"Choose and share my contact",noThanks:"No, thanks",
chooseQ:"Your Telegram contact goes to this partner's helper so they can reach you. Nothing else is shared. Continue?",terms:"Terms",useful:"Useful",notUseful:"Not useful",
rateQ:"Was the help useful?",history:"History",noReq:"No requests yet.",intros:"Introductions",accept:"Accept",decline:"Decline",confirmIntro:"Confirm",helped:"It helped",
noresp:"It didn't happen",invite:"Someone asks for your help",waiting:"Waiting for your confirmation",settings:"Settings",digest:"Daily digest",discoverable:"Discoverable as expert",
available:"Available for introductions",reminders:"Reminders",routing:"Pings about unanswered questions",lang:"Language",skills:"Your skills",addSkill:"Add a skill…",
privacy:"Privacy",forget:"Delete all my data",forgetQ:"Delete your stored messages, skills and requests, and stop storing new ones? This can't be undone.",
forgotten:"Deleted.",needs:"Open intro requests",withdraw:"Withdraw",dReq:"Requests",dIn:"From partners",dOff:"Offers",dIns:"Insights",hits:"local matches",
mayShare:"may ask partners",caseT:"Case type",manual:"Carry by hand",copy:"Copy",copied:"Copied",markSent:"Marked sent",addOffer:"Publish an offer",
skill:"Skill",slots:"Slots",mode:"Terms",price:"Price, e.g. 49.90EUR",desc:"Description",publish:"Publish",used:"used",report:"Stages",gaps:"Unserved needs (5+ members)",
gapAct:"Create capacity",dismiss:"Dismiss",ledger:"Ledger (+ = partner owes you)",health:"Health",fedOff:"Partner gateway is off.",contact:"Contact",
openApp:"Open this from the Telepathy bot.",err:"Something went wrong. Try again.",empty:"Nothing here.",
pass:"Passport",passWhy:"Stay connected to your community even if this chat changes or Telegram is unavailable. You choose what you receive; nothing is turned on without you.",
passKeep:"Keep my connection",lvl_protected:"Protected: you can log in and be reached without Telegram.",lvl_login_only:"You can log in without Telegram, but critical notices have no verified route yet.",
lvl_not_yet_protected:"Not yet protected: add and verify an email.",lvl_not_enrolled:"Not set up yet.",places:"Official places",noPlaces:"Not published yet.",emails:"Email addresses",
addEmail:"Add email",emailPh:"you@example.com",codePh:"6-digit code",verify:"Verify",codeSent:"We sent a code to that address.",mailOff:"Email sending isn't configured by the community yet.",
recov:"Recovery codes",recovWhy:"One-time codes to log in without Telegram or email. Store them somewhere safe; they're shown only once.",recovMake:"Create recovery codes",left:"left",
receive:"What you receive",t_critical:"Critical notices (address changes, outages)",t_events:"Events",t_requests:"Updates on my requests",t_news:"Community news",t_commercial:"Offers from the community",t_partner_offers:"Offers from partner communities",
member:"Membership",noMember:"No current membership on record. Your subscriptions stay yours either way.",passFor:"Membership pass for a partner",makePass:"Create pass",passNote:"Valid 7 days, only for this partner, under a pseudonym. Copy it and give it to the partner.",
portal:"Open the portal (works without Telegram)",export:"Download my data",delPass:"Delete my passport",delPassQ:"Delete your addresses, subscriptions and recovery codes? Your addresses stay blocked from future messages.",remove:"Remove"},
ru:{home:"Главная",ask:"Поиск",req:"Запросы",ev:"События",me:"Профиль",desk:"Пульт",hi:"Привет! Что нужно?",askPh:"Спросите свои группы…",search:"Искать",
needHelp:"Нужна помощь?",newReq:"Новый запрос",reqPh:"Что нужно? Одно-два предложения, без контактов и ссылок.",create:"Дальше",
open:"открытых запросов",offers:"предложений вам",inv:"приглашений",catch:"Что нового",c12:"12 ч",c3:"3 дня",cLast:"С прошлого раза",nothingNew:"Ничего нового.",
next:"Скоро",noEv:"В ваших группах нет предстоящих событий.",ics:"Прислать файл календаря",sent:"Отправлено в чат.",allGroups:"Все группы",anyTime:"За всё время",
withFile:"С файлами",noRes:"Ответ не найден.",fixed:"Исправлено:",helpful:"Помогло",notHelpful:"Не помогло",wrong:"Не тот источник",thx:"Спасибо!",
toReq:"Не помогло? Создайте запрос",draft:"Черновик",draftNote:"Если подтвердите, я сначала поищу в ваших группах, а оператор сообщества увидит это описание. Без вашего отдельного разрешения ничего не уходит за пределы сообщества.",
confirm:"Подтвердить",cancel:"Отмена",solved:"Решено",more:"Нужна ещё помощь",toDesk:"Передать оператору",fromGroups:"Из ваших групп",
pv:"Спросить партнёров",allow:"Разрешить",inside:"Оставить внутри",pvTitle:"Партнёры получат только",pvNot:"Без вашего имени, аккаунта Telegram, групп и сообщений. Действует 14 дней; отозвать можно в любой момент.",
partnersL:"Партнёры",blocked:"В описании есть контакты или ссылки. Отмените запрос и создайте новый без них.",choose:"Выбрать и передать контакт",noThanks:"Нет, спасибо",
chooseQ:"Ваш контакт в Telegram получит специалист этого партнёра, чтобы связаться с вами. Больше ничего не передаётся. Продолжить?",terms:"Условия",useful:"Полезно",notUseful:"Бесполезно",
rateQ:"Помощь была полезной?",history:"История",noReq:"Запросов пока нет.",intros:"Знакомства",accept:"Принять",decline:"Отклонить",confirmIntro:"Подтвердить",helped:"Помогло",
noresp:"Не состоялось",invite:"Вас просят помочь",waiting:"Ждёт вашего подтверждения",settings:"Настройки",digest:"Ежедневная сводка",discoverable:"Видимость как эксперта",
available:"Доступен для знакомств",reminders:"Напоминания",routing:"Вопросы без ответа",lang:"Язык",skills:"Ваши навыки",addSkill:"Добавить навык…",
privacy:"Конфиденциальность",forget:"Удалить все мои данные",forgetQ:"Удалить ваши сообщения, навыки и запросы и больше не сохранять новые? Это необратимо.",
forgotten:"Удалено.",needs:"Открытые запросы на знакомство",withdraw:"Снять",dReq:"Запросы",dIn:"От партнёров",dOff:"Предложения",dIns:"Аналитика",hits:"совпадений",
mayShare:"можно спросить партнёров",caseT:"Тип случая",manual:"Передать вручную",copy:"Копировать",copied:"Скопировано",markSent:"Отправлено",addOffer:"Опубликовать предложение",
skill:"Навык",slots:"Мест",mode:"Условия",price:"Цена, напр. 49.90EUR",desc:"Описание",publish:"Опубликовать",used:"занято",report:"Этапы",gaps:"Неудовлетворённые запросы (5+)",
gapAct:"Создать предложение",dismiss:"Скрыть",ledger:"Учёт (+ = партнёр должен вам)",health:"Состояние",fedOff:"Шлюз партнёров выключен.",contact:"Контакт",
openApp:"Откройте это из бота Telepathy.",err:"Что-то пошло не так. Попробуйте ещё раз.",empty:"Здесь пусто.",
pass:"Паспорт",passWhy:"Оставайтесь на связи с сообществом, даже если чат изменится или Telegram будет недоступен. Вы сами выбираете, что получать; без вас ничего не включается.",
passKeep:"Сохранить связь",lvl_protected:"Защищено: вы можете войти и получать сообщения без Telegram.",lvl_login_only:"Вы можете войти без Telegram, но для важных уведомлений ещё нет проверенного канала.",
lvl_not_yet_protected:"Пока не защищено: добавьте и подтвердите email.",lvl_not_enrolled:"Ещё не настроено.",places:"Официальные адреса",noPlaces:"Пока не опубликованы.",emails:"Адреса email",
addEmail:"Добавить email",emailPh:"you@example.com",codePh:"Код из 6 цифр",verify:"Подтвердить",codeSent:"Мы отправили код на этот адрес.",mailOff:"Сообщество ещё не настроило отправку писем.",
recov:"Коды восстановления",recovWhy:"Одноразовые коды для входа без Telegram и email. Сохраните их в надёжном месте; они показываются один раз.",recovMake:"Создать коды",left:"осталось",
receive:"Что вы получаете",t_critical:"Важные уведомления (смена адреса, сбои)",t_events:"События",t_requests:"Новости по моим запросам",t_news:"Новости сообщества",t_commercial:"Предложения сообщества",t_partner_offers:"Предложения партнёрских сообществ",
member:"Членство",noMember:"Текущее членство не подтверждено. Ваши подписки остаются вашими в любом случае.",passFor:"Пропуск для партнёра",makePass:"Создать пропуск",passNote:"Действует 7 дней, только для этого партнёра, под псевдонимом. Скопируйте и передайте партнёру.",
portal:"Открыть портал (работает без Telegram)",export:"Скачать мои данные",delPass:"Удалить паспорт",delPassQ:"Удалить ваши адреса, подписки и коды восстановления? Адреса останутся заблокированными для будущих рассылок.",remove:"Удалить"}};
var S={lang:"en",me:null,tab:"home",sub:"req",draft:null,local:{},prefill:""};
var t=function(k){return (L[S.lang]||L.en)[k]||L.en[k]||k};
var main=document.getElementById("main"),nav=document.getElementById("nav");
function h(tag,attrs){var e=document.createElement(tag);attrs=attrs||{};for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;
 if(k==="text")e.textContent=v;else if(k==="cls")e.className=v;else if(k.slice(0,2)==="on")e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?"":v)}
 for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null||c===false)continue;if(Array.isArray(c))c.forEach(function(x){if(x)e.append(x)});else e.append(typeof c==="string"?document.createTextNode(c):c)}return e}
function haptic(kind){try{if(tg&&tg.HapticFeedback){kind==="tap"?tg.HapticFeedback.selectionChanged():tg.HapticFeedback.notificationOccurred(kind)}}catch(e){}}
function toast(msg){if(!msg)return;var d=h("div",{cls:"toast",text:msg});document.body.append(d);setTimeout(function(){d.remove()},2600)}
function ask(msg){return new Promise(function(res){if(ver("6.2"))tg.showConfirm(msg,function(ok){res(!!ok)});else res(window.confirm(msg))})}
function openUrl(u){if(!u)return;if(tg&&/^https:\\/\\/t\\.me\\//.test(u))tg.openTelegramLink(u);else if(tg)tg.openLink(u);else window.open(u,"_blank")}
function api(method,path,body){return fetch("/app/api/"+path,{method:method,headers:H,body:body?JSON.stringify(body):undefined}).then(function(r){
 return r.json().catch(function(){return {}}).then(function(j){if(!r.ok&&r.status!==400){var e=new Error(j.error||("HTTP "+r.status));e.status=r.status;throw e}return j})})}
var get=function(p){return api("GET",p)},post=function(p,b){return api("POST",p,b||{})};
// Only our own server HTML reaches here (digest, privacy); still, allow just a few safe tags.
var OK={B:1,I:1,U:1,S:1,A:1,CODE:1,PRE:1,BLOCKQUOTE:1,BR:1,EM:1,STRONG:1};
function safe(html){var doc=new DOMParser().parseFromString("<div>"+(html||"")+"</div>","text/html");var out=h("div",{style:"white-space:pre-wrap"});
 (function walk(src,dst){src.childNodes.forEach(function(n){if(n.nodeType===3){dst.append(n.textContent);return}if(n.nodeType!==1)return;
  if(!OK[n.tagName]){walk(n,dst);return}var e=document.createElement(n.tagName);if(n.tagName==="A"){var href=n.getAttribute("href")||"";
  if(/^(https:|tg:)/.test(href)){e.href="#";e.addEventListener("click",function(ev){ev.preventDefault();openUrl(href)})}}walk(n,e);dst.append(e)})})(doc.body.firstChild,out);return out}
function busy(btn,p){if(btn)btn.disabled=true;return p.catch(function(e){toast(e.status===429?"⏳":t("err"));throw e}).finally(function(){if(btn)btn.disabled=false})}
function card(){var a=[].slice.call(arguments);return h.apply(null,["div",{cls:"card"}].concat(a))}
function section(title){return h("h2",{text:title})}
function empty(msg){return h("p",{cls:"empty",text:msg||t("empty")})}
function setMain(nodes){main.replaceChildren.apply(main,[].concat(nodes));window.scrollTo(0,0)}

// ---- navigation ----
var ICONS={home:["M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"],ask:["M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0","M20 20l-4-4"],
 req:["M3 13h5l2 3h4l2-3h5","M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"],ev:["M4 5h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z","M3 10h18","M8 3v4","M16 3v4"],
 me:["M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0","M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"],desk:["M3 8h18v12H3z","M8 8V5h8v3","M3 13h18"],pass:["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z","M9 12l2 2 4-4"]};
function icon(name){var NS="http://www.w3.org/2000/svg";var svg=document.createElementNS(NS,"svg");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("width","22");svg.setAttribute("height","22");
 svg.setAttribute("fill","none");svg.setAttribute("stroke","currentColor");svg.setAttribute("stroke-width","1.8");svg.setAttribute("stroke-linecap","round");svg.setAttribute("stroke-linejoin","round");
 ICONS[name].forEach(function(d){var p=document.createElementNS(NS,"path");p.setAttribute("d",d);svg.append(p)});return svg}
var TABS=[["home"],["ask"],["req"],["pass"],["me"]];
function renderNav(){var tabs=TABS.slice();if(S.me&&S.me.owner)tabs.push(["desk"]);nav.replaceChildren.apply(nav,tabs.map(function(x){
 var badge=x[0]==="req"&&S.me?(S.me.counts.offers+S.me.counts.invites):0;
 return h("button",{cls:S.tab===x[0]?"on":"",onclick:function(){haptic("tap");go(x[0])}},icon(x[0]),h("span",null,t(x[0]),badge?h("span",{cls:"badge",text:String(badge)}):null))}))}
function go(tab){S.tab=tab;renderNav();hideMain();if(tg&&tg.BackButton)tg.BackButton.hide();({home:home,ask:askView,req:reqView,ev:events,me:meView,desk:desk,pass:passport})[tab]()}
var mainCb=null;function hideMain(){if(tg&&tg.MainButton){if(mainCb)tg.MainButton.offClick(mainCb);tg.MainButton.hide()}mainCb=null}
function mainButton(text,fn){if(!tg||!tg.MainButton||!ver("6.1"))return false;hideMain();mainCb=fn;tg.MainButton.setText(text);tg.MainButton.onClick(fn);tg.MainButton.show();return true}
function refreshMe(){return get("me").then(function(m){S.me=m;renderNav();return m})}

// ---- home ----
function home(){var q=h("input",{placeholder:t("askPh"),enterkeyhint:"search"});q.addEventListener("keydown",function(e){if(e.key==="Enter"){S.prefill=q.value;go("ask")}});
 var c=S.me.counts;var dig=h("div");
 var stats=h("div",{cls:"stat"},[[c.requests,"open"],[c.offers,"offers"],[c.invites,"inv"]].map(function(x){return h("div",{cls:"card",onclick:function(){go("req")}},h("b",{text:String(x[0])}),h("span",{cls:"muted",text:t(x[1])}))}));
 var catchBtns=h("div",{cls:"chips"},[["12h","c12"],["3d","c3"],["","cLast"]].map(function(x){return h("button",{cls:"chip",onclick:function(e){busy(e.target,get("catchup?window="+x[0])).then(function(r){dig.replaceChildren(r.html?safe(r.html):empty(t("nothingNew")))})}},t(x[1]))}));
 var evs=h("div");
 setMain([h("h1",{text:S.me.label}),card(h("div",{cls:"muted",text:t("hi")}),h("div",{cls:"row",style:"margin-top:8px"},h("div",{cls:"grow"},q),h("button",{onclick:function(){S.prefill=q.value;go("ask")}},t("search")))),
  card(h("div",{cls:"row"},h("div",{cls:"grow"},h("b",{text:t("needHelp")})),h("button",{onclick:function(){S.newReq=true;go("req")}},t("newReq")))),stats,
  section(t("catch")),catchBtns,dig,section(t("next")),evs]);
 get("events").then(function(list){evs.replaceChildren.apply(evs,list.length?list.slice(0,3).map(eventCard):[empty(t("noEv"))])})}

// ---- ask ----
var F={group:"",since:"",file:false},groups=null;
function askView(){var q=h("input",{placeholder:t("askPh"),value:S.prefill||"",enterkeyhint:"search"});S.prefill="";var res=h("div");
 var chips=h("div",{cls:"chips"});function drawChips(){chips.replaceChildren();var sel=h("select",{cls:"chip",style:"width:auto",onchange:function(e){F.group=e.target.value}},
   h("option",{value:"",text:t("allGroups")}),(groups||[]).map(function(g){return h("option",{value:g.id,text:g.title,selected:F.group===g.id})}));
  chips.append(sel);[["","anyTime"],["7d","7d"],["30d","30d"],["365d","365d"]].forEach(function(x){chips.append(h("button",{cls:"chip"+(F.since===x[0]?" on":""),onclick:function(){F.since=x[0];drawChips()}},x[1]==="anyTime"?t("anyTime"):x[1]))});
  chips.append(h("button",{cls:"chip"+(F.file?" on":""),onclick:function(){F.file=!F.file;drawChips()}},"📎 "+t("withFile")))}
 if(!groups)get("groups").then(function(g){groups=g;drawChips()});drawChips();
 function run(){if(!q.value.trim())return;res.replaceChildren(h("p",{cls:"muted",text:"…"}));
  busy(null,post("ask",{q:q.value,group:F.group,since:F.since,file:F.file})).then(function(a){res.replaceChildren(answerView(a,q.value))}).catch(function(){res.replaceChildren()})}
 q.addEventListener("keydown",function(e){if(e.key==="Enter")run()});
 setMain([h("div",{cls:"row"},h("div",{cls:"grow"},q),h("button",{onclick:run},t("search"))),chips,res]);if(q.value)run();else q.focus()}
function quoteCard(x,i,answerId){var meta=[(x.event_at||"").slice(0,10),x.label,x.tag==="canonical"?"⭐":x.tag==="outdated"?"⚠️":null].filter(Boolean).join(" · ");
 return h("div",{cls:"q"},x.text,h("div",{cls:"muted row"},h("span",{cls:"grow",text:meta}),x.url?h("button",{cls:"link",onclick:function(){openUrl(x.url)}},"↗"):null,
  answerId?h("button",{cls:"link",title:t("wrong"),onclick:function(e){vote(answerId,"bad"+i,e.target)}},"⚑"):null))}
function vote(id,action,btn){busy(btn,post("vote",{answerId:id,action:action})).then(function(){haptic("success");toast(t("thx"))})}
function answerView(a,q){var box=h("div");if(a.status!=="answered"){box.append(card(h("div",{text:a.noAnswer||t("noRes")}),h("div",{cls:"btns"},h("button",{onclick:function(){S.newReq=true;S.prefill=q;go("req")}},t("toReq")))));return box}
 if(a.fixes&&a.fixes.length)box.append(h("p",{cls:"muted",text:t("fixed")+" "+a.fixes.map(function(f){return f[0]+" → "+f[1]}).join(", ")}));
 box.append(card(a.quotes.map(function(x,i){return quoteCard(x,i,a.answerId)}),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){vote(a.answerId,"up",e.target)}},"👍 "+t("helpful")),
  h("button",{cls:"sec",onclick:function(e){vote(a.answerId,"down",e.target)}},"👎 "+t("notHelpful")),h("button",{cls:"link",onclick:function(){S.newReq=true;S.prefill=q;go("req")}},t("toReq")))));return box}

// ---- requests ----
function reqView(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));var form=newReqForm();setMain([h("h1",{text:t("req")}),form,box]);
 get("requests").then(function(r){var parts=[];
  if(r.intros.length){parts.push(section(t("intros")));r.intros.forEach(function(i){parts.push(introCard(i))})}
  parts.push(section(t("req")));if(!r.missions.length)parts.push(empty(t("noReq")));r.missions.forEach(function(m){parts.push(missionCard(m))});
  if(r.needs.length){parts.push(section(t("needs")));r.needs.forEach(function(n){parts.push(card(h("div",{text:n.text}),h("div",{cls:"btns"},h("button",{cls:"danger",onclick:function(e){busy(e.target,post("needs/"+n.id+"/cancel")).then(reqView)}},t("cancel")))))})}
  box.replaceChildren.apply(box,parts)})}
function newReqForm(){var open=!!S.newReq;S.newReq=false;var ta=h("textarea",{placeholder:t("reqPh"),maxlength:"500"});ta.value=S.prefill||"";S.prefill="";
 var body=h("div",{style:open?"":"display:none"},ta,h("div",{cls:"btns"},h("button",{onclick:function(e){submit(e.target)}},t("create"))));
 function submit(btn){busy(btn,post("requests",{text:ta.value})).then(function(r){if(!r.ok){toast(r.msg);return}haptic("success");hideMain();body.replaceChildren(draftCard(r))})}
 if(open){setTimeout(function(){ta.focus()},50);mainButton(t("create"),function(){submit(null)})}
 return card(h("div",{cls:"row"},h("b",{cls:"grow",text:t("newReq")}),h("button",{cls:"sec",onclick:function(){body.style.display=body.style.display?"":"none";if(!body.style.display)ta.focus()}},"＋")),body)}
function draftCard(r){var c=h("div",null,h("span",{cls:"pill",text:t("draft")+" · "+r.job}),h("div",{cls:"q",text:r.summary}),h("p",{cls:"muted",text:t("draftNote")}));
 c.append(h("div",{cls:"btns"},h("button",{onclick:function(e){act(r.id,"ok",e.target,c)}},t("confirm")),h("button",{cls:"sec",onclick:function(e){act(r.id,"x",e.target,c)}},t("cancel"))));return c}
function act(id,a,btn,place){return busy(btn,post("requests/"+id+"/"+a)).then(function(r){if(r.msg)toast(r.msg);
 if(a==="ok"&&r.ok&&place){haptic("success");place.replaceChildren(localResult(id,r));refreshMe();return}
 if(a==="pv"&&place){place.replaceChildren(previewView(id,r));return}if(r.ok)haptic("success");refreshMe();reqView()})}
function localResult(id,r){var c=h("div");if(r.answered){c.append(h("b",{text:t("fromGroups")}),r.quotes.map(function(x,i){return quoteCard(x,i,r.answerId)}),
  h("div",{cls:"btns"},h("button",{onclick:function(e){act(id,"solved",e.target)}},t("solved")),h("button",{cls:"sec",onclick:function(e){act(id,"more",e.target)}},t("more"))))}
 else c.append(h("p",{text:t("noRes")}),h("div",{cls:"btns"},h("button",{onclick:function(e){act(id,"more",e.target)}},t("toDesk")),h("button",{cls:"sec",onclick:function(e){act(id,"x",e.target)}},t("cancel"))));return c}
function previewView(id,r){if(r.blocked)return h("p",{text:t("blocked")});if(!r.preview)return h("p",{cls:"muted",text:r.msg||t("empty")});var p=r.preview;
 return h("div",null,h("b",{text:t("pvTitle")}),h("div",{cls:"muted",text:p.job}),h("div",{cls:"q",text:p.summary}),h("p",{cls:"muted",text:t("pvNot")}),
  h("div",{cls:"muted",text:t("partnersL")+": "+p.partners.join(", ")}),h("div",{cls:"btns"},h("button",{onclick:function(e){act(id,"allow",e.target)}},t("allow")),h("button",{cls:"sec",onclick:function(e){act(id,"in",e.target)}},t("inside"))))}
var LABEL={ok:"confirm",x:"cancel",solved:"solved",more:"more",pv:"pv"};
function missionCard(m){var place=h("div");var cls=/delivered|committed|closed|satisfied|evaluated/.test(m.status)?"pill ok":/offers_available|delivered/.test(m.status)?"pill warn":"pill";
 var hist=h("div",{cls:"tl",style:"display:none"},m.history.map(function(x){return h("div",null,h("span",{cls:"muted",text:x.at.slice(0,16).replace("T"," ")+"  "}),x.label)}));
 var btns=h("div",{cls:"btns"});m.actions.forEach(function(a){if(a==="rate"){btns.append(h("span",{cls:"muted grow",text:t("rateQ")}),
   h("button",{onclick:function(e){busy(e.target,post("requests/"+m.id+"/rate",{useful:true})).then(function(r){toast(r.msg);reqView()})}},t("useful")),
   h("button",{cls:"sec",onclick:function(e){busy(e.target,post("requests/"+m.id+"/rate",{useful:false})).then(function(r){toast(r.msg);reqView()})}},t("notUseful")));return}
  btns.append(h("button",{cls:a==="x"?"danger":a==="ok"||a==="solved"?"":"sec",onclick:function(e){if(a==="x"){ask(t("cancel")+"?").then(function(ok){if(ok)act(m.id,a,e.target,place)})}else act(m.id,a,e.target,place)}},t(LABEL[a]||a)))});
 return card(h("div",{cls:"row"},h("span",{cls:cls,text:m.statusLabel}),h("span",{cls:"muted grow",text:m.job}),h("button",{cls:"link",onclick:function(){hist.style.display=hist.style.display?"":"none"}},t("history"))),
  h("div",{cls:"q",text:m.summary}),m.offers.map(function(o){return offerCard(o)}),place,hist,btns)}
function offerCard(o){var terms=o.terms&&o.terms.mode?o.terms.mode+(o.terms.price?" · "+(o.terms.price.amount_minor/100).toFixed(2)+" "+o.terms.price.currency:""):"";
 return h("div",{cls:"card",style:"background:var(--bg2)"},h("b",{text:o.brand}),h("div",{text:o.summary}),h("div",{cls:"muted",text:t("terms")+": "+terms}),
  h("div",{cls:"btns"},h("button",{onclick:function(e){ask(t("chooseQ")).then(function(ok){if(ok)busy(e.target,post("offers/"+o.id,{yes:true})).then(function(r){toast(r.msg);haptic("success");refreshMe();reqView()})})}},t("choose")),
  h("button",{cls:"sec",onclick:function(e){busy(e.target,post("offers/"+o.id,{yes:false})).then(function(r){toast(r.msg);refreshMe();reqView()})}},t("noThanks"))))}
var IA={accept:"accept",decline:"decline",confirm:"confirmIntro",cancel:"cancel",helpful:"helped",noresp:"noresp"};
function introCard(i){return card(h("b",{text:i.role==="candidate"&&i.status==="invited"?t("invite"):i.status==="accepted"?t("waiting"):i.status.replace(/_/g," ")}),
 i.text?h("div",{cls:"q",text:i.text}):null,h("div",{cls:"btns"},i.actions.map(function(a){return h("button",{cls:a==="decline"||a==="cancel"?"sec":"",onclick:function(e){
  busy(e.target,post("intros/"+i.id,{action:a})).then(function(r){toast(r.msg);refreshMe();reqView()})}},t(IA[a]))})))}

// ---- events ----
function eventCard(e){var d=new Date(e.starts_at);var when=d.toLocaleString(S.lang==="ru"?"ru-RU":"en-GB",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
 return card(h("div",{cls:"row"},h("div",{cls:"grow"},h("div",{cls:"muted",text:when}),h("div",{text:e.title})),e.url?h("button",{cls:"link",onclick:function(){openUrl(e.url)}},"↗"):null))}
function events(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));setMain([h("h1",{text:t("ev")}),box]);
 get("events").then(function(list){box.replaceChildren.apply(box,list.length?list.map(eventCard).concat([h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,post("events/ics")).then(function(){toast(t("sent"))})}},"📅 "+t("ics")))]):[empty(t("noEv"))])})}

// ---- passport (continuity) ----
function passport(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));setMain([h("h1",{text:t("pass")}),box]);
 get("passport").then(function(d){var p=d.protection;var out=[];
  if(!p.enrolled){var picks={};var list=h("div",null,d.topics.map(function(tp){var c=h("input",{type:"checkbox",style:"width:auto"});c.addEventListener("change",function(){picks[tp]=c.checked});return h("label",{cls:"sw"},h("span",{text:t("t_"+tp)}),c)}));
   out.push(card(h("p",{text:t("passWhy")}),list,h("div",{cls:"btns"},h("button",{onclick:function(e){busy(e.target,post("passport/enrol",{topics:Object.keys(picks).filter(function(k){return picks[k]})})).then(function(){haptic("success");passport()})}},t("passKeep")))));
   box.replaceChildren.apply(box,out);return}
  out.push(card(h("b",{cls:p.level==="protected"?"pill ok":"pill warn",text:t("lvl_"+p.level)})));
  out.push(section(t("places")),card(d.destinations.length?d.destinations.map(function(x){return h("div",{cls:"row"},h("span",{cls:"muted",text:x.role+" · "+x.kind}),h("button",{cls:"link grow",style:"text-align:left",onclick:function(){openUrl(x.url)}},x.url))}):h("p",{cls:"muted",text:t("noPlaces")}),
   d.manifestVersion?h("div",{cls:"muted",text:"v"+d.manifestVersion+" ✓"}):null));
  var em=h("input",{type:"email",placeholder:t("emailPh"),autocomplete:"email"});var code=h("input",{inputmode:"numeric",placeholder:t("codePh"),style:"display:none"});var reg=null;var emsg=h("p",{cls:"muted"});
  var emBtn=h("button",{onclick:function(e){if(!reg){busy(e.target,post("passport/email",{email:em.value})).then(function(r){if(!r.ok){toast(r.reason||t("err"));return}reg=r.registration;code.style.display="";emBtn.textContent=t("verify");emsg.textContent=r.sent==="disabled"?t("mailOff"):t("codeSent")})}
   else busy(e.target,post("passport/email/verify",{registration:reg,code:code.value})).then(function(r){if(r.ok){haptic("success");passport()}else toast(t("err"))})}},t("addEmail"));
  out.push(section(t("emails")),card(p.emails.map(function(x){return h("div",{cls:"row"},h("span",{cls:"grow",text:x.address}),h("span",{cls:x.status==="verified"?"pill ok":"pill warn",text:x.status}),
   h("button",{cls:"danger",onclick:function(e){busy(e.target,post("passport/revoke",{registration:x.id})).then(passport)}},t("remove")))}),em,code,h("div",{cls:"btns"},emBtn),emsg));
  var rc=h("div");out.push(section(t("recov")),card(h("p",{cls:"muted",text:t("recovWhy")}),h("div",{cls:"muted",text:p.recoveryCodes+" "+t("left")}),rc,h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){
   busy(e.target,post("passport/recovery")).then(function(r){rc.replaceChildren(h("pre",{text:r.codes.join("\\n")}),h("button",{cls:"sec",onclick:function(){navigator.clipboard&&navigator.clipboard.writeText(r.codes.join("\\n")).then(function(){toast(t("copied"))})}},t("copy")))})}},t("recovMake")))));
  out.push(section(t("receive")),card(d.topics.map(function(tp){var c=h("input",{type:"checkbox",style:"width:auto"});c.checked=p.topics[tp]==="following";c.addEventListener("change",function(){haptic("tap");post("passport/topic",{topic:tp,on:c.checked})});return h("label",{cls:"sw"},h("span",{text:t("t_"+tp)}),c)})));
  out.push(section(t("member")),card(d.memberships.length?d.memberships.map(function(x){return h("div",{text:x.tier+" · "+x.expires_at.slice(0,10)})}):h("p",{cls:"muted",text:t("noMember")})));
  if(d.partners.length&&d.memberships.length){var sel=h("select",null,d.partners.map(function(x){return h("option",{value:x.id,text:x.label})}));var po=h("div");
   out.push(section(t("passFor")),card(h("p",{cls:"muted",text:t("passNote")}),sel,h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,post("passport/pass",{audience:sel.value})).then(function(r){if(!r.ok){toast(r.reason);return}var j=JSON.stringify(r.pass);
    po.replaceChildren(h("pre",{text:j}),h("button",{cls:"sec",onclick:function(){navigator.clipboard&&navigator.clipboard.writeText(j).then(function(){toast(t("copied"))})}},t("copy")))})}},t("makePass"))),po))}
  out.push(card(d.portal?h("button",{cls:"link",onclick:function(){openUrl(d.portal)}},t("portal")+" ↗"):null,h("button",{cls:"link",onclick:function(){get("passport/export").then(function(x){var s2=JSON.stringify(x,null,1);out2.replaceChildren(h("pre",{text:s2}))})}},t("export")),
   h("div",{cls:"btns"},h("button",{cls:"danger",onclick:function(e){ask(t("delPassQ")).then(function(ok){if(ok)busy(e.target,post("passport/forget",{confirm:"forget"})).then(passport)})}},t("delPass")))));
  var out2=h("div");out.push(out2);box.replaceChildren.apply(box,out)}).catch(function(){box.replaceChildren(empty(t("empty")))})}

// ---- me ----
var allSkills=null;
function meView(){var m=S.me;var sw=h("div",null,["digest","discoverable","available","reminders","routing"].map(function(f){var c=h("input",{type:"checkbox",style:"width:auto"});c.checked=!!m.flags[f];
  c.addEventListener("change",function(){haptic("tap");var b={};b[f]=c.checked;post("settings",b).then(refreshMe)});return h("label",{cls:"sw"},h("span",{text:t(f)}),c)}),
  h("div",{cls:"sw"},h("span",{text:t("lang")}),h("div",{cls:"chips"},["en","ru"].map(function(l){return h("button",{cls:"chip"+(S.lang===l?" on":""),onclick:function(){post("settings",{lang:l}).then(function(){S.lang=l;refreshMe().then(function(){go("me")})})}},l==="en"?"English":"Русский")}))));
 var sk=h("div",{cls:"chips",style:"flex-wrap:wrap"},m.skillLabels.map(function(s){return h("span",{cls:"chip on"},s.label+" ",h("a",{href:"#",onclick:function(e){e.preventDefault();post("skills",{code:s.code,on:false}).then(refreshMe).then(meView)}},"×"))}));
 var add=h("input",{placeholder:t("addSkill"),list:"skl"});var dl=h("datalist",{id:"skl"});
 function loadSkills(){if(allSkills){dl.replaceChildren.apply(dl,allSkills.map(function(s){return h("option",{value:s.label})}));return}get("skills").then(function(x){allSkills=x;loadSkills()})}loadSkills();
 add.addEventListener("change",function(){var s=(allSkills||[]).find(function(x){return x.label===add.value})||{code:add.value};post("skills",{code:s.code,on:true}).then(function(r){if(r.ok){haptic("success");refreshMe().then(meView)}else toast(t("err"))})});
 var priv=h("div");
 setMain([h("h1",{text:t("me")}),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(){go("ev")}},"📅 "+t("ev"))),section(t("settings")),card(sw),section(t("skills")),card(sk,add,dl),section(t("privacy")),
  card(h("button",{cls:"link",onclick:function(){get("privacy").then(function(r){priv.replaceChildren(safe(r.html))})}},t("privacy")+" ›"),priv,
   h("div",{cls:"btns"},h("button",{cls:"danger",onclick:function(e){ask(t("forgetQ")).then(function(ok){if(ok)busy(e.target,post("forget",{confirm:"forget"})).then(function(){toast(t("forgotten"));refreshMe().then(meView)})})}},t("forget"))))])}

// ---- desk (owners) ----
function desk(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));var subs=h("div",{cls:"sub"});
 setMain([h("h1",{text:t("desk")}),subs,box]);
 get("desk").then(function(d){function draw(){subs.replaceChildren.apply(subs,[["req","dReq",d.missions.length],["in","dIn",d.inbound.length+d.manual.length],["off","dOff",d.offers.length],["ins","dIns",d.gaps.length]].map(function(x){
   return h("button",{cls:"chip"+(S.sub===x[0]?" on":""),onclick:function(){S.sub=x[0];draw()}},t(x[1])+(x[2]?" · "+x[2]:""))}));
  box.replaceChildren.apply(box,({req:deskReq,in:deskIn,off:deskOff,ins:deskIns})[S.sub](d))}draw()})}
function deskDo(path,btn){return busy(btn,post("desk/"+path)).then(function(r){toast(r.msg);if(r.ok)haptic("success");desk()})}
function deskReq(d){if(!d.missions.length)return [empty()];return d.missions.map(function(m){
 var sel=h("select",{style:"width:auto;padding:4px 8px",onchange:function(e){post("desk/tag/"+m.id,{case_type:e.target.value}).then(function(){toast("✓")})}},h("option",{value:"",text:t("caseT")}),
  d.caseTypes.map(function(c){return h("option",{value:c,text:c.replace(/_/g," "),selected:m.case_type===c})}));
 return card(h("div",{cls:"row"},h("b",{text:"#"+m.short}),h("span",{cls:"pill",text:m.statusLabel}),h("span",{cls:"muted grow",text:m.job})),h("div",{cls:"q",text:m.summary}),
  h("div",{cls:"muted",text:m.hits+" "+t("hits")+(m.external?" · ✅ "+t("mayShare"):"")}),h("div",{cls:"btns"},m.actions.map(function(a){
   return h("button",{cls:a.act==="np"?"danger":a.act==="a"||a.act==="dv"?"":"sec",onclick:function(e){var go2=function(){deskDo("mission/"+m.id+"/"+a.act+(a.extra?"/"+a.extra:""),e.target)};a.act==="np"?ask(a.label+"?").then(function(ok){if(ok)go2()}):go2()}},a.label)})),h("div",{cls:"btns"},sel))})}
function deskIn(d){var out=[];if(!d.federation)out.push(h("p",{cls:"muted",text:t("fedOff")}));
 d.inbound.forEach(function(x){out.push(card(h("div",{cls:"row"},h("b",{cls:"grow",text:x.partner}),h("span",{cls:"pill",text:x.state})),h("div",{cls:"muted",text:x.job}),h("div",{cls:"q",text:x.summary}),
  x.contact?h("div",null,t("contact")+": ",h("a",{href:"#",onclick:function(e){e.preventDefault();openUrl(x.contact.split(" ")[0])}},x.contact.split(" ")[1]||x.contact.split(" ")[0])):null,
  h("div",{cls:"btns"},x.actions.map(function(a){return h("button",{cls:a.act==="d"||a.act==="r"?"sec":"",onclick:function(e){deskDo("exchange/"+x.id+"/"+a.act+(a.extra?"/"+a.extra:""),e.target)}},a.label)}))))});
 d.manual.forEach(function(x){out.push(card(h("b",{text:t("manual")+" → "+x.partner}),h("pre",{text:x.body}),h("div",{cls:"btns"},
  h("button",{cls:"sec",onclick:function(){navigator.clipboard&&navigator.clipboard.writeText(x.body).then(function(){toast(t("copied"))})}},t("copy")),
  h("button",{onclick:function(e){deskDo("exchange/"+x.id+"/s",e.target)}},t("markSent")))))});
 return out.length?out:[empty()]}
function deskOff(d){var out=d.offers.map(function(o){return card(h("div",{cls:"row"},h("b",{cls:"grow",text:o.description}),h("span",{cls:"pill",text:o.status})),
  h("div",{cls:"muted",text:o.job+" · "+o.reserved+"/"+o.total+" "+t("used")+" · "+o.mode+(o.price?" · "+o.price:"")}),
  o.status==="published"?h("div",{cls:"btns"},h("button",{cls:"danger",onclick:function(e){deskDo("offer/"+o.id+"/withdraw",e.target)}},t("withdraw"))):null)});
 var job=h("select",null,h("option",{value:"general",text:"general"}),d.skills.map(function(s){return h("option",{value:s.code,text:s.label})}));
 var slots=h("input",{type:"number",min:"1",max:"1000",value:"3"});var mode=h("select",null,d.modes.map(function(m){return h("option",{value:m,text:m})}));
 var price=h("input",{placeholder:t("price"),style:"display:none"});mode.addEventListener("change",function(){price.style.display=mode.value==="paid"?"":"none"});
 var desc=h("input",{placeholder:t("desc"),maxlength:"200"});
 out.unshift(card(h("b",{text:t("addOffer")}),h("div",{cls:"muted",text:t("skill")}),job,h("div",{cls:"row",style:"margin-top:6px"},h("div",{cls:"grow"},h("div",{cls:"muted",text:t("slots")}),slots),h("div",{cls:"grow"},h("div",{cls:"muted",text:t("mode")}),mode)),
  price,h("div",{style:"margin-top:6px"},desc),h("div",{cls:"btns"},h("button",{onclick:function(e){busy(e.target,post("desk/offer",{job:job.value,slots:Number(slots.value),mode:mode.value,price:price.value,description:desc.value})).then(function(r){
   if(r.ok){haptic("success");desk()}else toast(r.msg||t("err"))})}},t("publish")))));return out}
function deskIns(d){var r=d.report;var out=[section(t("report")),card(r.stages.length?r.stages.map(function(s){return h("div",{cls:"row"},h("span",{cls:"grow",text:s.label}),h("b",{text:String(s.n)}))}):empty(),
  h("div",{cls:"muted",style:"margin-top:6px",text:"👍 "+r.useful+" · 👎 "+r.notUseful}))];
 out.push(section(t("gaps")));if(!d.gaps.length)out.push(empty());d.gaps.forEach(function(g){out.push(card(h("div",{cls:"row"},h("b",{cls:"grow",text:g.label}),h("span",{cls:"pill warn",text:g.bucket})),
  h("div",{cls:"btns"},h("button",{onclick:function(e){S.sub="off";deskDo("gap/"+g.job+"/off",e.target)}},t("gapAct")),h("button",{cls:"sec",onclick:function(e){deskDo("gap/"+g.job+"/dis",e.target)}},t("dismiss")))))});
 out.push(section(t("ledger")),card(d.ledger.length?d.ledger.map(function(x){return h("div",{cls:"row"},h("span",{cls:"grow",text:x.partner}),h("b",{text:x.amount}))}):empty()));
 out.push(section(t("health")),card(Object.keys(d.health).map(function(k){return h("div",{cls:"row"},h("span",{cls:"grow muted",text:k}),h("span",{text:String(d.health[k])}))})));return out}

// ---- start ----
refreshMe().then(function(m){S.lang=m.lang;var sp=m.startParam||"";if(!sp&&location.hash)sp=location.hash.slice(1);var tab=({ask:"ask",help:"req",requests:"req",events:"ev",profile:"me",desk:"desk",passport:"pass"})[sp]||"home";
 if(sp==="help")S.newReq=true;if(tab==="desk"&&!m.owner)tab="home";go(tab)}).catch(function(){main.replaceChildren(empty(L.en.openApp+" / "+L.ru.openApp))});
</script></body></html>`;
