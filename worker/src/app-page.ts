// Mini App page: plain HTML + inline JS, no build step, no third-party code except Telegram's
// WebApp script and two Google Fonts. Text is inserted with textContent; the only HTML we render
// (digest, privacy) is our own server output, passed through a strict tag allowlist first. The
// doodles are constant SVG strings in this file. The JS avoids backticks, "${" and backslashes so
// it can live inside this template string (a test parses it).
// Look follows the landing (shapefuture/telepathy-landing): paper, ink borders with hard offset
// shadows, Oswald headings, lime marks, orange underlines, tilted pastel blobs, the landing art.

export const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Миндальная связь</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800;900&family=Oswald:wght@500;600;700&display=swap">
<style>
:root{--paper:#faf8f2;--card:#fffdf8;--ink:#111110;--line:#111110;--sh:#111110;--mute:#5c5a55;--pri:#843cff;--lime:#dfff45;--lav:#e9dfff;--blue:#44bdf4;--orange:#ff893b;--mint:#68e6b3;
--t-lilac:#edd9fa;--t-sky:#c5eaff;--t-lime:#e5ff83;--t-apricot:#ffd091;--t-mint:#d7f9e8;--t-peach:#ffddab;--t-sand:#f4f1d8;--danger:#d93a3f;--edge:#11111022;
--r:18px;--blob:25px 38px 22px 31px;--fd:"Oswald","Arial Narrow",sans-serif;--fb:"Manrope","Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
[data-theme=dark]{--paper:#13120f;--card:#1d1b18;--ink:#f6f2e8;--line:#f6f2e8;--sh:#000;--mute:#b2ada2;--lav:#2d2546;
--t-lilac:#34264a;--t-sky:#16334a;--t-lime:#36420f;--t-apricot:#4a3214;--t-mint:#143a2a;--t-peach:#47301a;--t-sand:#35321f;--edge:#f6f2e826;--danger:#ff7a7e}
*{box-sizing:border-box}html,body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 var(--fb);-webkit-font-smoothing:antialiased}
main{padding:10px 16px 116px;max-width:720px;margin:0 auto;overflow-x:clip}
h1{font:600 36px/1.03 var(--fd);letter-spacing:-.025em;margin:8px 0 12px}h1 .small{display:block;font-size:.72em;margin-top:8px;line-height:1.1}
h2{font:600 24px/1.1 var(--fd);letter-spacing:-.02em;margin:26px 0 12px;display:table;position:relative;isolation:isolate}
h2:after{content:"";position:absolute;left:0;right:-4px;bottom:-5px;height:5px;border-radius:70% 20% 45% 30%;background:var(--pri);transform:rotate(-1.5deg);opacity:.85}
h2.mint:after{background:var(--mint)}h2.orange:after{background:var(--orange)}
mark{background:var(--lime);color:#111110;border-radius:14px 6px 18px 8px;padding:0 7px 3px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.under{position:relative;display:inline-block;isolation:isolate}.under:after{content:"";position:absolute;left:0;right:-3px;bottom:2px;height:8px;border-radius:70% 20% 45% 30%;background:var(--orange);z-index:-1;transform:rotate(-3deg)}
.top{display:flex;align-items:center;gap:10px;margin:4px 0 6px}.logo{display:flex;align-items:center;gap:7px;font:900 19px/.9 var(--fb);letter-spacing:-1px}
.sun{font-size:30px;font-weight:500;line-height:1;display:inline-block;animation:spin-in 1.4s cubic-bezier(.2,.8,.2,1) both}
.top .grow{flex:1}.tagchip{font-size:12px;font-weight:700;background:var(--lav);border:1.5px solid var(--line);border-radius:30px;padding:5px 11px;max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eyebrow{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;margin:6px 0 4px}
.card{background:var(--card);border:2px solid var(--line);border-radius:var(--r);box-shadow:4px 5px 0 var(--sh);padding:16px;margin:14px 0;position:relative}
.c-lav,.c-lime,.c-pink,.c-sky,.c-sun,.c-mint,.c-peach,.c-sand{border-radius:var(--blob);border-color:transparent;box-shadow:none}
.c-lav{background:var(--lav)}.c-lime{background:var(--t-lime)}.c-pink{background:var(--t-lilac)}.c-sky{background:var(--t-sky)}.c-sun{background:var(--t-apricot)}.c-mint{background:var(--t-mint)}.c-peach{background:var(--t-peach)}.c-sand{background:var(--t-sand)}
.c-bold{background:var(--lime);color:#111110;border:2px solid var(--line);box-shadow:5px 6px 0 var(--sh);border-radius:var(--blob)}
.tilt-l{transform:rotate(-1deg)}.tilt-r{transform:rotate(1deg)}
.row{display:flex;gap:12px;align-items:center}.grow{flex:1;min-width:0}.muted{color:var(--mute);font-size:13px}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:30px;border:1.5px solid var(--line);background:var(--lav);color:var(--ink);margin-right:4px}
.pill.ok{background:var(--t-mint)}.pill.warn{background:var(--t-apricot)}.pill.bad{background:var(--t-lilac)}
.q{border:1.5px solid var(--line);background:var(--lav);border-radius:14px 6px 18px 8px;padding:10px 12px;margin:10px 0;white-space:pre-wrap;word-break:break-word}
button,.btn{font:800 14px/1.2 var(--fb);border:2px solid var(--line);border-radius:16px;padding:12px 18px;background:var(--pri);color:#fff;cursor:pointer;display:inline-flex;align-items:center;gap:10px;box-shadow:3px 4px 0 var(--sh);transition:transform .18s,box-shadow .18s}
button:active{transform:translate(2px,2px);box-shadow:0 0 0 var(--sh)}button.sec{background:var(--card);color:var(--ink)}button.dark{background:var(--ink);color:var(--paper)}button.lime{background:var(--lime);color:#111110}
button.link,button.danger{background:none;border:0;box-shadow:none;padding:6px 2px}button.link{color:var(--pri);text-decoration:underline;text-underline-offset:3px}button.danger{color:var(--danger)}
button:disabled{opacity:.5}.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;align-items:center}.arrow{font-size:20px;line-height:1}
input,textarea,select{font:inherit;width:100%;padding:12px 14px;border-radius:14px;border:2px solid var(--line);background:var(--card);color:var(--ink);margin:5px 0}
input:focus,textarea:focus,select:focus{outline:3px solid var(--pri);outline-offset:2px}textarea{min-height:90px;resize:vertical}
.search{display:flex;align-items:center;background:var(--card);border:2px solid var(--line);border-radius:20px;box-shadow:4px 5px 0 var(--sh);padding:5px 5px 5px 14px;margin:12px 0}
.search input{border:0;margin:0;padding:9px 4px;background:none}.search input:focus{outline:none}.search button{padding:0;width:44px;height:44px;justify-content:center;flex:none;border-radius:14px;box-shadow:none}
.chips{display:flex;gap:8px;overflow-x:auto;padding:4px 2px 6px}.chip{white-space:nowrap;padding:8px 14px;border-radius:30px;background:var(--lav);color:var(--ink);font-size:13px;font-weight:700;border:1.5px solid var(--line);box-shadow:none}
.chip:nth-child(3n+2){background:var(--t-mint)}.chip:nth-child(3n+3){background:var(--t-peach)}.chip.on{background:var(--lime);color:#111110}.chip a{color:inherit;text-decoration:none;margin-left:6px;font-weight:800}
input[type=checkbox]{appearance:none;-webkit-appearance:none;width:48px;height:28px;border-radius:30px;background:var(--card);border:2px solid var(--line);position:relative;flex:none;margin:0;padding:0;cursor:pointer}
input[type=checkbox]:after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--ink);transition:left .18s}
input[type=checkbox]:checked{background:var(--lime)}input[type=checkbox]:checked:after{left:22px;background:#111110}
.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}.stat .card{margin:0;cursor:pointer;padding:14px 10px}.stat .card:nth-child(2){transform:rotate(1.2deg)}.stat .card:nth-child(odd){transform:rotate(-1deg)}
.stat b{display:block;font:600 34px/1 var(--fd);margin-bottom:6px;border-bottom:2px solid currentColor;padding-bottom:6px;width:max-content}
nav{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));display:flex;gap:2px;background:var(--card);border:2px solid var(--line);border-radius:20px;padding:6px;box-shadow:4px 5px 0 var(--sh);max-width:700px;margin:0 auto;z-index:5}
nav button{flex:1;background:none;color:var(--ink);border:0;box-shadow:none;border-radius:14px;padding:7px 2px;font-size:11px;font-weight:700;display:flex;flex-direction:column;align-items:center;gap:2px}
nav button.on{background:var(--lime);color:#111110}nav button:active{transform:none}
.sw{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1.5px dashed var(--edge)}.sw:last-child{border:0}
.tl{margin:10px 0 0 4px;border-left:2px dashed var(--edge);padding-left:10px}.tl div{font-size:13px;margin:3px 0}.badge{background:var(--orange);color:#111110;border:1.5px solid var(--line);border-radius:99px;font-size:10px;font-weight:800;padding:0 5px;margin-left:2px}
.sub{display:flex;gap:8px;margin:4px 0 8px;overflow-x:auto}pre{white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:160px;overflow:auto;background:var(--lav);border:1.5px solid var(--line);padding:10px;border-radius:12px}
.toast{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);background:var(--ink);color:var(--paper);padding:11px 18px;border-radius:16px;font-size:14px;font-weight:700;z-index:9;max-width:90%;animation:pop .35s cubic-bezier(.2,.8,.2,1) both}
.empty{text-align:center;color:var(--mute);padding:18px 8px}blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--pri)}a{color:var(--pri)}
.art{display:block;width:100%;height:auto;border-radius:16px;mix-blend-mode:multiply}[data-theme=dark] .art{mix-blend-mode:normal;border:2px solid var(--line)}
.art-sm{width:112px;flex:none}.c-bold .art-sm{width:92px;transform:rotate(4deg)}.hero-art{margin:6px -4px 4px}
.band{display:flex;align-items:center;justify-content:center;gap:16px;background:#111110;color:#dfff45;font:600 20px/1.1 var(--fd);text-transform:uppercase;letter-spacing:.01em;padding:12px 10px;margin:18px -20px 6px;transform:rotate(-1.5deg)}
[data-theme=dark] .band{background:#000;border-block:2px solid #dfff45}
.tile-ico{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex:none;border:2px solid var(--line);background:var(--card)}
.meter{display:flex;gap:8px;margin:10px 0}.meter i{width:28px;height:28px;border-radius:50%;border:2px solid #111110;background:#fffdf8;display:block}.meter i.on{background:#111110}
.big{font:600 25px/1.08 var(--fd);letter-spacing:-.02em}.code{font:700 17px/1.3 ui-monospace,monospace;letter-spacing:1px;word-break:break-all}
.sticker{display:inline-block;background:var(--lime);color:#111110;border:2px solid #111110;border-radius:50% 40% 45% 15%;padding:9px 14px;font-weight:900;font-size:14px;transform:rotate(-7deg);animation:sticker-pop 1s both;cursor:pointer}
.steps{display:grid;gap:12px;margin:12px 0}.step{display:flex;gap:14px;align-items:flex-start;padding:16px;border-radius:var(--blob);background:var(--t-lilac)}
.step:nth-child(2){background:var(--t-sky)}.step:nth-child(3){background:var(--t-lime)}.step:nth-child(4){background:var(--t-apricot)}
.step b{font:500 30px/1 var(--fd);border-bottom:2px solid currentColor;padding-bottom:6px;opacity:.85}.step h3{font:600 18px/1.15 var(--fd);margin:0 0 4px}.step p{margin:0;font-size:13px}
.note{font:800 13px/1.15 var(--fb);text-transform:uppercase;transform:rotate(-6deg);text-align:center;max-width:150px;margin:0 auto}
#main>*{animation:rise .55s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0)*45ms)}
@keyframes rise{from{opacity:0;transform:translateY(14px) rotate(-.6deg)}}
@keyframes pop{from{opacity:0;transform:translate(-50%,10px) scale(.92)}}
@keyframes spin-in{from{transform:rotate(-110deg) scale(.5)}to{transform:rotate(0) scale(1)}}
@keyframes sticker-pop{0%,30%{opacity:0;transform:rotate(-14deg) scale(.6)}70%{opacity:1;transform:rotate(-4deg) scale(1.08)}100%{transform:rotate(-7deg) scale(1)}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style></head><body><main id="main"><p class="empty">…</p></main><nav id="nav"></nav>
<script>
"use strict";
var tg=window.Telegram&&Telegram.WebApp;if(tg){tg.ready();tg.expand();}
// Light by default whatever Telegram's theme is; dark only if the person chose it in Profile.
function getTheme(){try{return localStorage.getItem("theme")==="dark"?"dark":"light"}catch(e){return "light"}}
function applyTheme(th){if(th==="dark")document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");
 try{if(tg&&tg.isVersionAtLeast&&tg.isVersionAtLeast("6.1")){var bg=th==="dark"?"#13120f":"#faf8f2";tg.setHeaderColor(bg);tg.setBackgroundColor(bg)}
  if(tg&&tg.isVersionAtLeast&&tg.isVersionAtLeast("7.10")&&tg.setBottomBarColor)tg.setBottomBarColor(th==="dark"?"#13120f":"#faf8f2")}catch(e){}}
applyTheme(getTheme());
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
err:"Something went wrong. Try again.",empty:"Nothing here.",
pass:"Passport",passWhy:"Stay connected to your community even if this chat changes or Telegram is unavailable. You choose what you receive; nothing is turned on without you.",
passKeep:"Keep my connection",lvl_protected:"Protected: you can log in and be reached without Telegram.",lvl_login_only:"You can log in without Telegram, but critical notices have no verified route yet.",
lvl_not_yet_protected:"Not yet protected: add and verify an email.",lvl_not_enrolled:"Not set up yet.",places:"Official places",noPlaces:"Not published yet.",emails:"Email addresses",
addEmail:"Add email",emailPh:"you@example.com",codePh:"6-digit code",verify:"Verify",codeSent:"We sent a code to that address.",mailOff:"Email sending isn't configured by the community yet.",
recov:"Recovery codes",recovWhy:"One-time codes to log in without Telegram or email. Store them somewhere safe; they're shown only once.",recovMake:"Create recovery codes",left:"left",
receive:"What you receive",t_critical:"Critical notices (address changes, outages)",t_events:"Events",t_requests:"Updates on my requests",t_news:"Community news",t_commercial:"Offers from the community",t_partner_offers:"Offers from partner communities",
member:"Membership",noMember:"No current membership on record. Your subscriptions stay yours either way.",passFor:"Membership pass for a partner",makePass:"Create pass",passNote:"Valid 7 days, only for this partner, under a pseudonym. Copy it and give it to the partner.",
portal:"Open the portal (works without Telegram)",export:"Download my data",delPass:"Delete my passport",delPassQ:"Delete your addresses, subscriptions and recovery codes? Your addresses stay blocked from future messages.",remove:"Remove",darkMode:"Dark theme",openAppT:"Open it from the bot",openApp:"This app works inside Telegram. Open the bot's chat and tap the menu button at the bottom left.",notMemberT:"Almost there",notMember:"The bot doesn't know you yet. Write any message in a community group where the bot is switched on, then open the app again.",errT:"Couldn't load",closeApp:"Close",brand:"Миндальная связь",eyebrow:"Your community",homeA:"Ask",homeB:"your people.",homeC:"Find answers together.",band1:"Your people.",band2:"Shared work.",howTitle:"How it works",note:"Less stress. More care for people.",st1h:"You ask",st1p:"“Where's the recording of the meetup?”",st2h:"We search everything",st2p:"Messages, materials and events in your groups.",st3h:"An answer, or the right people",st3p:"If the groups don't know, the request goes to people who can help.",st4h:"You get help fast",st4p:"“Thanks! Exactly what I needed.”",totpTitle:"Authenticator app",totpGo:"Set up",b_active:"together",b_pending:"waiting",heroA:"Your community is ",heroB:"bigger than a chat.",tagline:"Your people. Your rules.",helpSub:"Describe it in a sentence. We'll find people and answers.",paths:"Independent ways to reach you",pathsGoal:"Aim for 3: if one breaks, the others still reach you.",reachUs:"How we reach you",addPath:"Add a way to reach you",suggest:"Suggested next",ntfyHow:"Install the ntfy app and subscribe to this private topic. Then enter the code we send there.",ntfyAdd:"ntfy app",matrixAdd:"Add Matrix",smsAdd:"Add SMS",codeFrom:"Code from the new path",confirmCode:"Confirm",pushPortal:"Browser notifications are set up in the portal",loginWays:"Log in without Telegram",yourId:"Your passport id",totpAdd:"Add an authenticator app",totpKey:"Or enter this key:",totpOk:"Authenticator added.",moreInPortal:"Device key, printed recovery card and guardians are in the portal",buddy:"Buddy",buddyWhy:"Someone who passes critical notices to you, and you to them.",buddyName:"How your buddy knows you",buddyInvite:"Create invite code",buddyCode:"Buddy's code",buddyAccept:"Accept code",buddyGive:"Give this code to your buddy:",end:"End",k_email:"Email",k_telegram:"Telegram",k_webpush:"Browser",k_ntfy:"ntfy",k_matrix:"Matrix",k_sms:"SMS",s_email:"another email",s_webpush:"browser notifications",s_ntfy:"the ntfy app",s_matrix:"Matrix",s_sms:"SMS",s_buddy:"a buddy",s_recovery_card:"a printed recovery card",st_verified:"working",st_pending:"waiting for code",h_failing:"not working",h_dead:"gone",linked:"linked"},
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
err:"Что-то пошло не так. Попробуйте ещё раз.",empty:"Здесь пусто.",
pass:"Паспорт",passWhy:"Оставайтесь на связи с сообществом, даже если чат изменится или Telegram будет недоступен. Вы сами выбираете, что получать; без вас ничего не включается.",
passKeep:"Сохранить связь",lvl_protected:"Защищено: вы можете войти и получать сообщения без Telegram.",lvl_login_only:"Вы можете войти без Telegram, но для важных уведомлений ещё нет проверенного канала.",
lvl_not_yet_protected:"Пока не защищено: добавьте и подтвердите email.",lvl_not_enrolled:"Ещё не настроено.",places:"Официальные адреса",noPlaces:"Пока не опубликованы.",emails:"Адреса email",
addEmail:"Добавить email",emailPh:"you@example.com",codePh:"Код из 6 цифр",verify:"Подтвердить",codeSent:"Мы отправили код на этот адрес.",mailOff:"Сообщество ещё не настроило отправку писем.",
recov:"Коды восстановления",recovWhy:"Одноразовые коды для входа без Telegram и email. Сохраните их в надёжном месте; они показываются один раз.",recovMake:"Создать коды",left:"осталось",
receive:"Что вы получаете",t_critical:"Важные уведомления (смена адреса, сбои)",t_events:"События",t_requests:"Новости по моим запросам",t_news:"Новости сообщества",t_commercial:"Предложения сообщества",t_partner_offers:"Предложения партнёрских сообществ",
member:"Членство",noMember:"Текущее членство не подтверждено. Ваши подписки остаются вашими в любом случае.",passFor:"Пропуск для партнёра",makePass:"Создать пропуск",passNote:"Действует 7 дней, только для этого партнёра, под псевдонимом. Скопируйте и передайте партнёру.",
portal:"Открыть портал (работает без Telegram)",export:"Скачать мои данные",delPass:"Удалить паспорт",delPassQ:"Удалить ваши адреса, подписки и коды восстановления? Адреса останутся заблокированными для будущих рассылок.",remove:"Удалить",darkMode:"Тёмная тема",openAppT:"Откройте из бота",openApp:"Приложение работает внутри Telegram. Откройте чат с ботом и нажмите кнопку меню слева внизу.",notMemberT:"Почти готово",notMember:"Бот вас ещё не знает. Напишите любое сообщение в группе сообщества, где бот включён, и откройте приложение снова.",errT:"Не удалось загрузить",closeApp:"Закрыть",brand:"Миндальная связь",eyebrow:"Ваше сообщество",homeA:"Спросите",homeB:"своих.",homeC:"Найдём ответ вместе.",band1:"Свои люди.",band2:"Общее дело.",howTitle:"Как это работает",note:"Меньше стресса. Больше заботы о людях.",st1h:"Вы задаёте вопрос",st1p:"«Где найти запись встречи?»",st2h:"Ищем по всей базе",st2p:"Сообщения, материалы и события ваших групп.",st3h:"Отвечаем или подключаем людей",st3p:"Если в группах ответа нет, запрос уходит тем, кто может помочь.",st4h:"Вы быстро получаете помощь",st4p:"«Спасибо! Именно то, что нужно.»",totpTitle:"Приложение-аутентификатор",totpGo:"Подключить",b_active:"вместе",b_pending:"ждём ответа",heroA:"Ваше сообщество ",heroB:"больше, чем чат.",tagline:"Ваши люди. Ваши правила.",helpSub:"Опишите одним предложением. Найдём людей и ответы.",paths:"Независимых путей к вам",pathsGoal:"Цель — 3: если один сломается, остальные дотянутся.",reachUs:"Как мы до вас дотянемся",addPath:"Добавить путь",suggest:"Советуем дальше",ntfyHow:"Установите приложение ntfy и подпишитесь на эту личную тему. Потом введите код, который туда придёт.",ntfyAdd:"Приложение ntfy",matrixAdd:"Добавить Matrix",smsAdd:"Добавить SMS",codeFrom:"Код из нового канала",confirmCode:"Подтвердить",pushPortal:"Уведомления в браузере — настраиваются в портале",loginWays:"Вход без Telegram",yourId:"Ваш ID паспорта",totpAdd:"Подключить приложение-аутентификатор",totpKey:"Или введите ключ:",totpOk:"Аутентификатор подключён.",moreInPortal:"Ключ устройства, печатная карточка и хранители — в портале",buddy:"Напарник",buddyWhy:"Человек, который передаст вам важное — а вы ему.",buddyName:"Как вас знает напарник",buddyInvite:"Создать код приглашения",buddyCode:"Код напарника",buddyAccept:"Принять код",buddyGive:"Передайте этот код напарнику:",end:"Завершить",k_email:"Почта",k_telegram:"Telegram",k_webpush:"Браузер",k_ntfy:"ntfy",k_matrix:"Matrix",k_sms:"SMS",s_email:"ещё одну почту",s_webpush:"уведомления в браузере",s_ntfy:"приложение ntfy",s_matrix:"Matrix",s_sms:"SMS",s_buddy:"напарника",s_recovery_card:"печатную карточку",st_verified:"работает",st_pending:"ждёт код",h_failing:"не работает",h_dead:"отключён",linked:"привязан"}};
var S={lang:"ru",me:null,tab:"home",sub:"req",draft:null,local:{},prefill:""};
var t=function(k){return (L[S.lang]||L.en)[k]||L.en[k]||k};
var NL=String.fromCharCode(10);
var main=document.getElementById("main"),nav=document.getElementById("nav");
function h(tag,attrs){var e=document.createElement(tag);attrs=attrs||{};for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;
 if(k==="text")e.textContent=v;else if(k==="cls")e.className=v;else if(k.slice(0,2)==="on")e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?"":v)}
 for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null||c===false)continue;if(Array.isArray(c))c.forEach(function(x){if(x)e.append(x)});else e.append(typeof c==="string"?document.createTextNode(c):c)}return e}
function haptic(kind){try{if(tg&&tg.HapticFeedback){kind==="tap"?tg.HapticFeedback.selectionChanged():tg.HapticFeedback.notificationOccurred(kind)}}catch(e){}}
function toast(msg){if(!msg)return;var d=h("div",{cls:"toast",text:msg});document.body.append(d);setTimeout(function(){d.remove()},2600)}
function ask(msg){return new Promise(function(res){if(ver("6.2"))tg.showConfirm(msg,function(ok){res(!!ok)});else res(window.confirm(msg))})}
function openUrl(u){if(!u)return;if(tg&&u.indexOf("https://t.me/")===0)tg.openTelegramLink(u);else if(tg)tg.openLink(u);else window.open(u,"_blank")}
function api(method,path,body){return fetch("/app/api/"+path,{method:method,headers:H,body:body?JSON.stringify(body):undefined}).then(function(r){
 return r.json().catch(function(){return {}}).then(function(j){if(!r.ok&&r.status!==400){var e=new Error(j.error||("HTTP "+r.status));e.status=r.status;throw e}return j})})}
var get=function(p){return api("GET",p)},post=function(p,b){return api("POST",p,b||{})};
// Only our own server HTML reaches here (digest, privacy); still, allow just a few safe tags.
var OK={B:1,I:1,U:1,S:1,A:1,CODE:1,PRE:1,BLOCKQUOTE:1,BR:1,EM:1,STRONG:1};
function safe(html){var doc=new DOMParser().parseFromString("<div>"+(html||"")+"</div>","text/html");var out=h("div",{style:"white-space:pre-wrap"});
 (function walk(src,dst){src.childNodes.forEach(function(n){if(n.nodeType===3){dst.append(n.textContent);return}if(n.nodeType!==1)return;
  if(!OK[n.tagName]){walk(n,dst);return}var e=document.createElement(n.tagName);if(n.tagName==="A"){var href=n.getAttribute("href")||"";
  if(href.indexOf("https:")===0||href.indexOf("tg:")===0){e.href="#";e.addEventListener("click",function(ev){ev.preventDefault();openUrl(href)})}}walk(n,e);dst.append(e)})})(doc.body.firstChild,out);return out}
function busy(btn,p){if(btn)btn.disabled=true;return p.catch(function(e){toast(e.status===429?"⏳":t("err"));throw e}).finally(function(){if(btn)btn.disabled=false})}
function card(){var a=[].slice.call(arguments);return h.apply(null,["div",{cls:"card"}].concat(a))}
function tint(color){var a=[].slice.call(arguments,1);return h.apply(null,["div",{cls:"card c-"+color}].concat(a))}
var secN=0;function section(title){secN++;return h("h2",{cls:["","mint","orange"][secN%3],text:title})}
function art(name,cls){return h("img",{src:"/art/"+name+".webp",cls:"art "+(cls||""),alt:"",loading:"lazy",decoding:"async"})}
function empty(msg){return h("div",{cls:"empty"},svgEl(CAT,"width:88px;margin:0 auto 6px;display:block"),h("div",{text:msg||t("empty")}))}
function setMain(nodes){secN=0;var list=[topbar()].concat(nodes).filter(Boolean);list.forEach(function(n,i){if(n.style)n.style.setProperty("--i",String(Math.min(i,12)))});main.replaceChildren.apply(main,list);window.scrollTo(0,0)}
function copy(text){if(navigator.clipboard)navigator.clipboard.writeText(text).then(function(){toast(t("copied"))})}

// ---- doodles (constant SVG, drawn for this app) ----
var SPARK='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 1.5c1.1 6.2 4.3 9.4 10.5 10.5-6.2 1.1-9.4 4.3-10.5 10.5C10.9 16.3 7.7 13.1 1.5 12 7.7 10.9 10.9 7.7 12 1.5z" fill="FILL" stroke="#16141A" stroke-width="1.6" stroke-linejoin="round"/></svg>';
var CAT='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 104" fill="none" stroke="#16141A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'+
 '<path d="M88 86c18 0 26-12 22-26" stroke-width="13"/><path d="M88 86c18 0 26-12 22-26" stroke="#FF9F43" stroke-width="7"/>'+
 '<path d="M28 100c-6-26 6-46 32-46s38 20 32 46z" fill="#FF9F43"/><path d="M44 74c4 3 10 3 14 0M66 74c4 3 10 3 14 0" stroke-width="2.4"/>'+
 '<path d="M33 30 29 8l18 11z" fill="#FF9F43"/><path d="M83 30l4-22-18 11z" fill="#FF9F43"/><circle cx="58" cy="40" r="25" fill="#FF9F43"/>'+
 '<path d="M52 18l2 7M58 16v8M64 18l-2 7" stroke-width="2.4"/><path d="M46 40q4-5 8 0M62 40q4-5 8 0" stroke-width="2.6"/>'+
 '<path d="M56 47h4l-2 3z" fill="#16141A" stroke-width="2"/><path d="M58 50q-2 5-6 3M58 50q2 5 6 3" stroke-width="2.2"/>'+
 '<circle cx="44" cy="49" r="4" fill="#FFB3C7" stroke="none"/><circle cx="72" cy="49" r="4" fill="#FFB3C7" stroke="none"/>'+
 '<path d="M30 44h10M31 51l9-3M86 44H76M85 51l-9-3" stroke-width="2"/></svg>';
var LOGO='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22"><path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="12" r="3.4" fill="#E3FA7A" stroke="currentColor" stroke-width="2"/></svg>';
function svgEl(markup,style){var d=h("span",{style:"display:inline-block;line-height:0;"+(style||"")});
 var s=document.importNode(new DOMParser().parseFromString(markup,"image/svg+xml").documentElement,true);s.setAttribute("width","100%");d.append(s);return d}
function spark(color,pos){var d=svgEl(SPARK.replace("FILL",color||"#E3FA7A"),"position:absolute;width:18px;"+pos);return d}
function topbar(){return h("div",{cls:"top"},h("div",{cls:"logo"},h("span",{cls:"sun"},"✻"),h("span",{text:(S.me&&S.me.brand)||t("brand")})),h("div",{cls:"grow"}),S.me?h("div",{cls:"tagchip",text:S.me.label}):null)}

// ---- navigation ----
var ICONS={home:["M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"],ask:["M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0","M20 20l-4-4"],
 req:["M3 13h5l2 3h4l2-3h5","M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"],ev:["M4 5h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z","M3 10h18","M8 3v4","M16 3v4"],
 me:["M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0","M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"],desk:["M3 8h18v12H3z","M8 8V5h8v3","M3 13h18"],pass:["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z","M9 12l2 2 4-4"]};
function icon(name){var NS="http://www.w3.org/2000/svg";var svg=document.createElementNS(NS,"svg");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("width","22");svg.setAttribute("height","22");
 svg.setAttribute("fill","none");svg.setAttribute("stroke","currentColor");svg.setAttribute("stroke-width","2");svg.setAttribute("stroke-linecap","round");svg.setAttribute("stroke-linejoin","round");
 ICONS[name].forEach(function(d){var p=document.createElementNS(NS,"path");p.setAttribute("d",d);svg.append(p)});return svg}
var TABS=[["home"],["ask"],["req"],["pass"],["me"]];
function renderNav(){var tabs=TABS.slice();if(S.me&&S.me.owner)tabs.push(["desk"]);nav.replaceChildren.apply(nav,tabs.map(function(x){
 var badge=x[0]==="req"&&S.me?(S.me.counts.offers+S.me.counts.invites):0;
 return h("button",{cls:S.tab===x[0]?"on":"",onclick:function(){haptic("tap");go(x[0])}},icon(x[0]),h("span",null,t(x[0]),badge?h("span",{cls:"badge",text:String(badge)}):null))}))}
function go(tab){S.tab=tab;renderNav();hideMain();if(tg&&tg.BackButton)tg.BackButton.hide();({home:home,ask:askView,req:reqView,ev:events,me:meView,desk:desk,pass:passport})[tab]()}
var mainCb=null;function hideMain(){if(tg&&tg.MainButton){if(mainCb)tg.MainButton.offClick(mainCb);tg.MainButton.hide()}mainCb=null}
function mainButton(text,fn){if(!tg||!tg.MainButton||!ver("6.1"))return false;hideMain();mainCb=fn;tg.MainButton.setText(text);tg.MainButton.onClick(fn);tg.MainButton.show();return true}
function refreshMe(){return get("me").then(function(m){S.me=m;renderNav();return m})}
function searchBar(value,onGo){var q=h("input",{placeholder:t("askPh"),enterkeyhint:"search",value:value||""});q.addEventListener("keydown",function(e){if(e.key==="Enter")onGo(q.value)});
 var b=h("button",{"aria-label":t("search"),onclick:function(){onGo(q.value)}},"→");return {el:h("div",{cls:"search"},q,b),input:q}}

// ---- home ----
function home(){var sb=searchBar("",function(v){S.prefill=v;go("ask")});
 var c=S.me.counts;var dig=h("div");
 var tiles=h("div",{cls:"stat"},[[c.requests,"open","c-sky"],[c.offers,"offers","c-lime"],[c.invites,"inv","c-pink"]].map(function(x){return h("div",{cls:"card "+x[2],onclick:function(){go("req")}},h("b",{text:String(x[0])}),h("span",{style:"font-size:13px;font-weight:600",text:t(x[1])}))}));
 var help=h("div",{cls:"card c-bold tilt-l"},h("div",{cls:"row"},h("div",{cls:"grow"},h("div",{cls:"big",text:t("needHelp")}),h("div",{style:"font-size:13px;margin-top:4px",text:t("helpSub")})),art("helper","art-sm")),
  h("div",{cls:"btns"},h("button",{onclick:function(){S.newReq=true;go("req")}},t("newReq"),h("span",{cls:"arrow"},"→"))));
 var catchBtns=h("div",{cls:"chips"},[["12h","c12"],["3d","c3"],["","cLast"]].map(function(x){return h("button",{cls:"chip",onclick:function(e){busy(e.target,get("catchup?window="+x[0])).then(function(r){dig.replaceChildren(r.html?card(safe(r.html)):empty(t("nothingNew")))})}},t(x[1]))}));
 var evs=h("div");
 setMain([h("div",{cls:"eyebrow",text:t("eyebrow")}),h("h1",null,t("homeA")," ",h("span",{cls:"under"},t("homeB")),h("span",{cls:"small"},h("mark",null,t("homeC")))),sb.el,
  h("div",{cls:"hero-art"},art("portal")),h("div",{cls:"band"},h("span",null,t("band1")),h("span",{style:"font-size:1.4em"},"✻"),h("span",null,t("band2"))),
  help,tiles,section(t("catch")),catchBtns,dig,section(t("next")),evs]);
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
 res.append(h("div",{cls:"hero-art"},art("lounge")));
 setMain([h("h1",null,h("span",{cls:"under"},t("ask"))),h("div",{cls:"search"},q,h("button",{"aria-label":t("search"),onclick:run},"→")),chips,res]);if(q.value)run();else q.focus()}
function quoteCard(x,i,answerId){var meta=[(x.event_at||"").slice(0,10),x.label,x.tag==="canonical"?"⭐":x.tag==="outdated"?"⚠️":null].filter(Boolean).join(" · ");
 return h("div",{cls:"q"},x.text,h("div",{cls:"muted row"},h("span",{cls:"grow",text:meta}),x.url?h("button",{cls:"link",onclick:function(){openUrl(x.url)}},"↗"):null,
  answerId?h("button",{cls:"link",title:t("wrong"),onclick:function(e){vote(answerId,"bad"+i,e.target)}},"⚑"):null))}
function vote(id,action,btn){busy(btn,post("vote",{answerId:id,action:action})).then(function(){haptic("success");toast(t("thx"))})}
function answerView(a,q){var box=h("div");if(a.status!=="answered"){box.append(card(art("lost","art-sm"),h("div",{style:"margin-top:8px",text:a.noAnswer||t("noRes")}),h("div",{cls:"btns"},h("button",{onclick:function(){S.newReq=true;S.prefill=q;go("req")}},t("toReq")))));return box}
 if(a.fixes&&a.fixes.length)box.append(h("p",{cls:"muted",text:t("fixed")+" "+a.fixes.map(function(f){return f[0]+" → "+f[1]}).join(", ")}));
 box.append(card(a.quotes.map(function(x,i){return quoteCard(x,i,a.answerId)}),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){vote(a.answerId,"up",e.target)}},"👍 "+t("helpful")),
  h("button",{cls:"sec",onclick:function(e){vote(a.answerId,"down",e.target)}},"👎 "+t("notHelpful")),h("button",{cls:"link",onclick:function(){S.newReq=true;S.prefill=q;go("req")}},t("toReq")))));return box}

// ---- requests ----
function reqView(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));var form=newReqForm();setMain([h("h1",null,h("span",{cls:"under"},t("req"))),form,box]);
 get("requests").then(function(r){var parts=[];
  if(r.intros.length){parts.push(section(t("intros")));r.intros.forEach(function(i){parts.push(introCard(i))})}
  if(r.missions.length)parts.push(section(t("req")));else parts.push(howItWorks());r.missions.forEach(function(m){parts.push(missionCard(m))});
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

function howItWorks(){return h("div",null,h("div",{cls:"row",style:"align-items:center"},h("div",{cls:"grow"},h("div",{cls:"big",text:t("howTitle")})),h("div",{cls:"note",text:t("note")})),
 h("div",{cls:"steps"},[1,2,3,4].map(function(i){return h("div",{cls:"step"},h("b",{text:"0"+i}),h("div",null,h("h3",{text:t("st"+i+"h")}),h("p",{text:t("st"+i+"p")})))})))}

// ---- events ----
function eventCard(e){var d=new Date(e.starts_at);var when=d.toLocaleString(S.lang==="ru"?"ru-RU":"en-GB",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
 return card(h("div",{cls:"row"},h("div",{cls:"grow"},h("div",{cls:"muted",text:when}),h("div",{text:e.title})),e.url?h("button",{cls:"link",onclick:function(){openUrl(e.url)}},"↗"):null))}
function events(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));setMain([h("h1",null,h("span",{cls:"under"},t("ev"))),box]);
 get("events").then(function(list){box.replaceChildren.apply(box,list.length?list.map(eventCard).concat([h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,post("events/ics")).then(function(){toast(t("sent"))})}},"📅 "+t("ics")))]):[empty(t("noEv"))])})}

// ---- passport: continuity + every independent way to reach and log in (Hydra) ----
var HEADICO={email:"✉️",telegram:"✈️",webpush:"🔔",ntfy:"📣",matrix:"🟩",sms:"💬"};
function headRow(kind,label,status,health,onRemove){var st=health&&health!=="ok"?t("h_"+health):t("st_"+status);
 return h("div",{cls:"sw"},h("div",{cls:"tile-ico"},HEADICO[kind]||"•"),h("div",{cls:"grow"},h("b",{text:t("k_"+kind)}),h("div",{cls:"muted",style:"word-break:break-all",text:label})),
  h("span",{cls:"pill "+(health&&health!=="ok"?"bad":status==="verified"||status==="linked"?"ok":"warn"),text:status==="linked"?t("linked"):st}),
  onRemove?h("button",{cls:"danger","aria-label":t("remove"),onclick:onRemove},"✕"):null)}
function passport(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));setMain([h("h1",null,h("span",{cls:"under"},t("pass"))),box]);
 get("passport").then(function(d){var p=d.protection;var out=[];
  if(!p.enrolled){var picks={};var list=h("div",null,d.topics.map(function(tp){var c=h("input",{type:"checkbox"});c.addEventListener("change",function(){picks[tp]=c.checked});return h("label",{cls:"sw"},h("span",{text:t("t_"+tp)}),c)}));
   out.push(h("div",{cls:"card c-lav"},h("div",{cls:"row"},h("p",{cls:"grow",style:"font-weight:600;margin:0",text:t("passWhy")}),art("freedom","art-sm"))),card(list,h("div",{cls:"btns"},h("button",{onclick:function(e){busy(e.target,post("passport/enrol",{topics:Object.keys(picks).filter(function(k){return picks[k]})})).then(function(){haptic("success");passport()})}},t("passKeep")+" →"))));
   box.replaceChildren.apply(box,out);return}
  get("passport/h/hydra").then(function(y){draw(d,y)}).catch(function(){draw(d,null)})}).catch(function(){box.replaceChildren(empty(t("empty")))});
 function draw(d,y){var p=d.protection;var out=[];var n=y?y.independent:0;
  // status hero
  var meter=h("div",{cls:"meter"},[0,1,2].map(function(i){return h("i",{cls:i<n?"on":""})}));
  out.push(h("div",{cls:"card c-bold"+(p.level==="protected"?"":" tilt-l"),style:p.level==="protected"&&n>=3?"background:var(--t-mint);color:var(--ink)":p.level==="protected"?"":"background:var(--t-apricot);color:var(--ink)"},
   h("div",{cls:"big",text:t("lvl_"+p.level)}),y?h("div",{style:"margin-top:8px;font-weight:600",text:t("paths")+": "+n}):null,y?meter:null,y?h("div",{cls:"muted",style:"color:var(--ink);opacity:.75",text:t("pathsGoal")}):null,
   y?h("div",{style:"margin-top:8px"},h("span",{cls:"muted",style:"color:var(--ink)",text:t("yourId")+" "}),h("span",{cls:"sticker",text:y.handle,onclick:function(){copy(y.handle)}})):null));
  // heads
  var rows=[];if(y&&y.telegram)rows.push(headRow("telegram","",  "linked"));
  ((y&&y.heads)||p.emails.map(function(e){return {id:e.id,channel:"email",address:e.address,status:e.status,health:"ok"}})).forEach(function(x){
   rows.push(headRow(x.channel,x.address,x.status,x.health,function(e){busy(e.target,post("passport/revoke",{registration:x.id})).then(passport)}))});
  out.push(section(t("reachUs")),card(rows.length?rows:h("p",{cls:"muted",text:t("empty")})));
  // add a path
  out.push(section(t("addPath")),addPath(d,y));
  // login heads
  var rc=h("div");var tq=h("div");
  out.push(section(t("loginWays")),card(
   h("div",{cls:"row"},h("div",{cls:"tile-ico"},"🔑"),h("div",{cls:"grow"},h("b",{text:t("recov")}),h("div",{cls:"muted",text:p.recoveryCodes+" "+t("left")}))),
   h("p",{cls:"muted",text:t("recovWhy")}),rc,h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){
    busy(e.target,post("passport/recovery")).then(function(r){rc.replaceChildren(h("pre",{text:r.codes.join(NL)}),h("button",{cls:"sec",onclick:function(){copy(r.codes.join(NL))}},t("copy")))})}},t("recovMake"))),
   y?h("div",{style:"margin-top:14px"},h("div",{cls:"row"},h("div",{cls:"tile-ico"},"⏱️"),h("div",{cls:"grow"},h("b",{text:t("totpTitle")}),(y.factors||[]).filter(function(f){return f.kind==="totp"}).length?h("div",{cls:"muted",text:"✓ "+t("totpOk")}):null)),
    tq,h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,post("passport/h/totp",{label:"Telegram"})).then(function(r){if(!r.ok){toast(r.reason||t("err"));return}var code=h("input",{inputmode:"numeric",placeholder:t("codePh")});
     tq.replaceChildren(h("img",{src:r.qr,alt:"QR",width:"180",style:"display:block;margin:8px 0;border-radius:12px;border:1.5px solid var(--ink)"}),h("div",{cls:"muted",text:t("totpKey")}),h("div",{cls:"code",text:r.secret,onclick:function(){copy(r.secret)}}),code,
      h("div",{cls:"btns"},h("button",{onclick:function(ev){busy(ev.target,post("passport/h/totp/confirm",{id:r.id,code:code.value})).then(function(x){if(x.ok){haptic("success");toast(t("totpOk"));passport()}else toast(t("err"))})}},t("confirmCode"))))})}},t("totpGo")))):null,
   d.portal?h("div",{cls:"btns"},h("button",{cls:"link",onclick:function(){openUrl(d.portal)}},t("moreInPortal")+" ↗")):null));
  // buddy
  if(y){var bl=h("input",{placeholder:t("buddyName"),maxlength:"60"});var bc=h("input",{placeholder:t("buddyCode")});var bo=h("div");
   out.push(section(t("buddy")),tint("pink",h("p",{style:"margin-top:0",text:t("buddyWhy")}),(y.buddies||[]).map(function(b){return h("div",{cls:"sw"},h("span",{cls:"grow",text:"🤝 "+b.name}),h("span",{cls:"pill",text:t("b_"+b.status)}),h("button",{cls:"danger",onclick:function(e){busy(e.target,post("passport/h/buddy/end",{id:b.id})).then(passport)}},t("end")))}),
    bl,h("div",{cls:"btns"},h("button",{cls:"dark",onclick:function(e){busy(e.target,post("passport/h/buddy/invite",{label:bl.value})).then(function(r){if(!r.ok){toast(r.reason||t("err"));return}bo.replaceChildren(h("div",{cls:"muted",style:"color:var(--ink)",text:t("buddyGive")}),h("div",{cls:"code",text:r.code,onclick:function(){copy(r.code)}}))})}},t("buddyInvite"))),
    bc,h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,post("passport/h/buddy/accept",{code:bc.value,label:bl.value})).then(function(r){if(r.ok){haptic("success");passport()}else toast(t("err"))})}},t("buddyAccept"))),bo))}
  // topics, places, membership, pass, data
  out.push(section(t("receive")),card(d.topics.map(function(tp){var c=h("input",{type:"checkbox"});c.checked=p.topics[tp]==="following";c.addEventListener("change",function(){haptic("tap");post("passport/topic",{topic:tp,on:c.checked})});return h("label",{cls:"sw"},h("span",{text:t("t_"+tp)}),c)})));
  out.push(section(t("places")),tint("sky",d.destinations.length?d.destinations.map(function(x){return h("div",{cls:"row",style:"margin:4px 0"},h("span",{cls:"pill",text:(x.role==="primary"?"★ ":"")+x.kind}),h("button",{cls:"link grow",style:"text-align:left;word-break:break-all",onclick:function(){openUrl(x.url)}},x.url))}):h("p",{cls:"muted",text:t("noPlaces")}),
   d.manifestVersion?h("div",{cls:"muted",style:"color:var(--ink)",text:"v"+d.manifestVersion+" ✓"}):null));
  out.push(section(t("member")),card(d.memberships.length?d.memberships.map(function(x){return h("div",null,h("span",{cls:"pill ok",text:x.tier}),x.expires_at.slice(0,10))}):h("p",{cls:"muted",text:t("noMember")})));
  if(d.partners.length&&d.memberships.length){var sel=h("select",null,d.partners.map(function(x){return h("option",{value:x.id,text:x.label})}));var po=h("div");
   out.push(section(t("passFor")),card(h("p",{cls:"muted",text:t("passNote")}),sel,h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,post("passport/pass",{audience:sel.value})).then(function(r){if(!r.ok){toast(r.reason);return}var j=JSON.stringify(r.pass);
    po.replaceChildren(h("pre",{text:j}),h("button",{cls:"sec",onclick:function(){copy(j)}},t("copy")))})}},t("makePass"))),po))}
  var out2=h("div");
  out.push(card(d.portal?h("button",{cls:"link",onclick:function(){openUrl(d.portal)}},t("portal")+" ↗"):null,h("button",{cls:"link",onclick:function(){get("passport/export").then(function(x){out2.replaceChildren(h("pre",{text:JSON.stringify(x,null,1)}))})}},t("export")),
   h("div",{cls:"btns"},h("button",{cls:"danger",onclick:function(e){ask(t("delPassQ")).then(function(ok){if(ok)busy(e.target,post("passport/forget",{confirm:"forget"})).then(passport)})}},t("delPass")))),out2);
  box.replaceChildren.apply(box,out)}}
function addPath(d,y){var msg=h("p",{cls:"muted"});var pend=null;var code=h("input",{inputmode:"numeric",placeholder:t("codeFrom"),style:"display:none"});
 var confirmB=h("button",{style:"display:none",onclick:function(e){busy(e.target,post(pend.email?"passport/email/verify":"passport/h/head/verify",{registration:pend.id,code:code.value})).then(function(r){if(r.ok){haptic("success");passport()}else toast(t("err"))})}},t("confirmCode"));
 function started(r,isEmail){if(!r.ok){toast(r.reason||t("err"));return}pend={id:r.registration,email:isEmail};code.style.display="";confirmB.style.display="";if(!msg.textContent)msg.textContent=r.sent==="disabled"?t("mailOff"):t("codeSent")}
 var av=(y&&y.available)||[];var c=card();
 if(y&&y.suggested&&y.suggested.length)c.append(h("div",{cls:"row",style:"flex-wrap:wrap;gap:6px;margin-bottom:8px"},h("b",{text:t("suggest")+":"}),y.suggested.map(function(s){return h("span",{cls:"pill",style:"background:var(--lime)",text:t("s_"+s.kind)})})));
 var em=h("input",{type:"email",placeholder:t("emailPh"),autocomplete:"email"});
 c.append(h("div",{cls:"row"},h("div",{cls:"tile-ico"},"✉️"),h("div",{cls:"grow"},em)),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){msg.textContent="";busy(e.target,post("passport/email",{email:em.value})).then(function(r){started(r,true)})}},t("addEmail"))));
 if(av.indexOf("ntfy")>=0)c.append(h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){busy(e.target,get("passport/h/ntfy-topic")).then(function(tp){msg.replaceChildren(t("ntfyHow")+" ",h("span",{cls:"code",text:tp.topic,onclick:function(){copy(tp.topic)}}));
  return post("passport/h/head",{kind:"ntfy",address:tp.topic}).then(function(r){started(r,false)})})}},"📣 "+t("ntfyAdd"))));
 if(av.indexOf("matrix")>=0){var mx=h("input",{placeholder:"@you:matrix.org"});c.append(h("div",{cls:"row"},h("div",{cls:"tile-ico"},"🟩"),h("div",{cls:"grow"},mx)),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){msg.textContent="";busy(e.target,post("passport/h/head",{kind:"matrix",address:mx.value})).then(function(r){started(r,false)})}},t("matrixAdd"))))}
 if(av.indexOf("sms")>=0){var ph=h("input",{type:"tel",placeholder:"+15551234567"});c.append(h("div",{cls:"row"},h("div",{cls:"tile-ico"},"💬"),h("div",{cls:"grow"},ph)),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(e){msg.textContent="";busy(e.target,post("passport/h/head",{kind:"sms",address:ph.value})).then(function(r){started(r,false)})}},t("smsAdd"))))}
 if(av.indexOf("webpush")>=0&&d.portal)c.append(h("div",{cls:"btns"},h("button",{cls:"link",onclick:function(){openUrl(d.portal)}},"🔔 "+t("pushPortal")+" ↗")));
 c.append(code,h("div",{cls:"btns"},confirmB),msg);return c}

// ---- me ----
var allSkills=null;
function meView(){var m=S.me;var sw=h("div",null,["digest","discoverable","available","reminders","routing"].map(function(f){var c=h("input",{type:"checkbox"});c.checked=!!m.flags[f];
  c.addEventListener("change",function(){haptic("tap");var b={};b[f]=c.checked;post("settings",b).then(refreshMe)});return h("label",{cls:"sw"},h("span",{text:t(f)}),c)}),
  (function(){var c=h("input",{type:"checkbox"});c.checked=getTheme()==="dark";c.addEventListener("change",function(){haptic("tap");var th=c.checked?"dark":"light";try{localStorage.setItem("theme",th)}catch(e){}applyTheme(th)});return h("label",{cls:"sw"},h("span",{text:t("darkMode")}),c)})(),
  h("div",{cls:"sw"},h("span",{text:t("lang")}),h("div",{cls:"chips"},["en","ru"].map(function(l){return h("button",{cls:"chip"+(S.lang===l?" on":""),onclick:function(){post("settings",{lang:l}).then(function(){S.lang=l;refreshMe().then(function(){go("me")})})}},l==="en"?"English":"Русский")}))));
 var sk=h("div",{cls:"chips",style:"flex-wrap:wrap"},m.skillLabels.map(function(s){return h("span",{cls:"chip on"},s.label+" ",h("a",{href:"#",onclick:function(e){e.preventDefault();post("skills",{code:s.code,on:false}).then(refreshMe).then(meView)}},"×"))}));
 var add=h("input",{placeholder:t("addSkill"),list:"skl"});var dl=h("datalist",{id:"skl"});
 function loadSkills(){if(allSkills){dl.replaceChildren.apply(dl,allSkills.map(function(s){return h("option",{value:s.label})}));return}get("skills").then(function(x){allSkills=x;loadSkills()})}loadSkills();
 add.addEventListener("change",function(){var s=(allSkills||[]).find(function(x){return x.label===add.value})||{code:add.value};post("skills",{code:s.code,on:true}).then(function(r){if(r.ok){haptic("success");refreshMe().then(meView)}else toast(t("err"))})});
 var priv=h("div");
 setMain([h("div",{cls:"row"},h("h1",{cls:"grow"},h("span",{cls:"under"},t("me"))),art("people","art-sm")),h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(){go("ev")}},"📅 "+t("ev"))),section(t("settings")),card(sw),section(t("skills")),card(sk,add,dl),section(t("privacy")),
  card(h("button",{cls:"link",onclick:function(){get("privacy").then(function(r){priv.replaceChildren(safe(r.html))})}},t("privacy")+" ›"),priv,
   h("div",{cls:"btns"},h("button",{cls:"danger",onclick:function(e){ask(t("forgetQ")).then(function(ok){if(ok)busy(e.target,post("forget",{confirm:"forget"})).then(function(){toast(t("forgotten"));refreshMe().then(meView)})})}},t("forget"))))])}

// ---- desk (owners) ----
function desk(){var box=h("div",null,h("p",{cls:"muted",text:"…"}));var subs=h("div",{cls:"sub"});
 setMain([h("div",{cls:"row"},h("h1",{cls:"grow"},h("span",{cls:"under"},t("desk"))),art("overload","art-sm")),subs,box]);
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
 if(sp==="help")S.newReq=true;if(tab==="desk"&&!m.owner)tab="home";go(tab)}).catch(function(e){var lc=(tg&&tg.initDataUnsafe&&tg.initDataUnsafe.user&&tg.initDataUnsafe.user.language_code)||"";S.lang="ru";void lc;
 var k=!tg||!tg.initData||e.status===401?"openApp":e.status===403?"notMember":"err";
 main.replaceChildren(topbar(),h("div",{cls:"card c-lav"},h("div",{cls:"row"},h("div",{cls:"grow"},h("div",{cls:"big",text:t(k+"T")}),h("p",{style:"margin:8px 0 0",text:t(k)})),art("lost","art-sm")),
  tg&&tg.close?h("div",{cls:"btns"},h("button",{cls:"sec",onclick:function(){tg.close()}},t("closeApp"))):null))});
</script></body></html>`;
