// Interface texts in English and Russian (P13-04).
// `RU` is typed as `Messages`, so a key missing in either language fails `tsc`.

export type Lang = "en" | "ru";

/** Pick a language from Telegram's language_code (e.g. "ru", "uk", "en-US"). */
// Interface language for anyone who hasn't chosen one (/language or the Mini App). Set once per
// deployment from the defaultLang() var ("ru" in wrangler.jsonc); the Telegram app language is ignored.
let defaultLanguage: Lang = "ru";
export const defaultLang = (): Lang => defaultLanguage;
export function setDefaultLang(v?: string): void {
  if (v === "en" || v === "ru") defaultLanguage = v;
}

/** Language for someone who hasn't chosen one. */
export function langFromCode(_code?: string): Lang {
  return defaultLanguage;
}

const EN = {
  // general
  dontKnowYou: "I don't know you yet. Post a message in an enabled community group first, then try again.",
  privateOnly: "Please send that command to me in a private chat.",
  tooMany: "Too many requests. Please wait a minute.",
  notAvailable: "Not available.",
  saved: "Saved.",
  yes: "yes",
  no: "no",
  on: "on",
  off: "off",
  start: "Hi! I search your community's enabled groups and answer with cited quotes, and I can introduce you to opted-in experts.\n\n",
  help:
    "<b>Search</b>\n/ask <i>question</i> — cited answers from your groups (typos and RU/EN spelling tolerated). In a group, /ask searches only that group.\n\n" +
    "<b>Experts &amp; introductions</b>\n/intro <i>what you need</i> — consent-based introduction\n" +
    "/expert <i>topic</i> — how many opted-in experts match\n/requests — your open requests\n\n" +
    "<b>Your profile</b>\n/profile — view and change settings\n/digest on · /digest off — daily digest (opt-in)\n" +
    "/optin · /optout — expert discoverability\n/skills · /skills add <i>skill</i> · /skills remove <i>skill</i> · /skills all\n" +
    "/language en · /language ru — interface language\n/catchup — what's new since last time · /events — upcoming events · /pings on|off\n" +
    "Search filters: <code>in:group since:2026-01-01 has:file</code>\n\n" +
    "<b>Get help</b>\n/help <i>what you need</i> — a request the operator desk follows through; nothing leaves the community without your permission\n/requests · /cancel — your open requests\n\n" +
    "<b>Your data</b>\n/privacy · /forget_me · /resume_collection",
  privacy:
    "<b>Telepathy privacy notice</b>\n" +
    "• Only groups an owner explicitly enabled are stored. Each group shows a notice.\n" +
    "• Your name, username and phone number are not stored; you get a random internal ID.\n" +
    "• Answers quote messages verbatim with a link, only from groups you can read.\n" +
    "• Data is stored in Cloudflare D1. Nothing is sent to AI services. PDF, Word and PowerPoint files are converted to text on GitHub's servers and not kept there.\n" +
    "• You are not discoverable as an expert unless you run /optin yourself.\n" +
    "• Introductions need both people to agree before any contact is shared.\n" +
    "• Answer feedback (👍/👎) is private and only improves ranking.\n" +
    "• Full history is kept. /forget_me deletes your messages and profile and stops collection; reply /forget to one of your messages in the group to delete it.",
  languageSet: "Language set to English.",
  languageUsage: "Usage: <code>/language en</code> or <code>/language ru</code>",

  // owner commands in groups
  visibilityMust: (list: string) => `Visibility must be one of: ${list}`,
  enabled: (vis: string) =>
    `Telepathy is now <b>collecting</b> this chat (visibility: ${vis}, full history kept). ` +
    "Members can search it with /ask, here or in a DM with the bot. DM the bot /privacy for details or /forget_me to delete your data.",
  disabled: "Telepathy stopped collecting this chat. Existing messages are excluded from all answers.",
  retentionUsage: "Usage: /retention <days 1..3650> to purge older messages, or /retention 0 to keep full history.",
  retentionKeepAll: "Full history will be kept. Nothing is purged automatically.",
  retentionSet: (days: number) => `Retention set to ${days} days. Older messages are purged daily.`,
  removed: "Removed from Telepathy.",
  nothingStored: "Nothing stored for that message.",
  hintsUsage: "Usage: /hints on or /hints off (owner, in an enabled group).",
  hintsOn: "Hints are <b>on</b>: when someone asks a question this group has answered before, I'll reply once with a link to the earlier answer.",
  hintsOff: "Hints are off.",
  hint: (link: string) => `💡 This may have been answered here before: ${link}`,
  earlierAnswer: "earlier thread",

  // search
  askUsage: "Usage: <code>/ask your question</code>",
  noAccess: "I don't have any community sources you're allowed to read yet. Post in an enabled group first, or ask an admin.",
  insufficient: "<b>No reliable answer found</b> in sources you can access.\nTry different wording, or ask the community directly.",
  insufficientGroup: "<b>No reliable answer found</b> in this group.\nTry different wording.",
  found: (n: number) => `<b>Found ${n} relevant message(s)</b> — quoted verbatim, please check the source:`,
  foundGroup: (n: number) => `<b>Found ${n} relevant message(s) in this group</b> — quoted verbatim:`,
  alsoSearched: (s: string) => `<i>Also searched: ${s}</i>`,
  source: "source",
  sourceUnavailable: "source link unavailable",
  fbHelpful: "👍 Helpful",
  fbNotHelpful: "👎 Not helpful",
  fbWrong: (i: number) => `✗ ${i} wrong source`,
  fbThanks: "Thanks! Feedback is private and only improves ranking.",
  fbAlready: "Already recorded.",

  // profile
  profileTitle: "<b>Your profile</b> (only you see this)",
  pDigest: "Daily digest",
  pDiscoverable: "Discoverable as expert",
  pAvailable: "Available for introductions",
  pReminders: "Reminders",
  pCollection: "Message collection",
  pLanguage: "Language",
  pStopped: "stopped",
  pSkills: "Skills",
  noneYet: "none yet",
  suggested: "suggested",
  addSkillHint: "Add skills with <code>/skills add accounting</code>.",
  bDigestOn: "Digest on",
  bDigestOff: "Digest off",
  bDiscoverOn: "Become discoverable",
  bDiscoverOff: "Stop being discoverable",
  bResume: "Resume introductions",
  bPause: "Pause introductions",
  bRemindersOn: "Reminders on",
  bRemindersOff: "Reminders off",

  // digest & consent
  digestState: (on: boolean) => `Daily digest is <b>${on ? "on" : "off"}</b>. Change with <code>/digest on</code> or <code>/digest off</code>.`,
  digestOn: (hour: number) => `You'll get a daily digest (${hour}:00 local) covering the groups you can read.`,
  digestOff: "Daily digest turned off.",
  optin: "You're now discoverable for introductions <b>in the skills you list</b>. Nobody sees your identity unless you accept a specific request and the requester confirms.\nAdd skills: <code>/skills add python</code> · undo anytime: /optout",
  optout: "You're no longer discoverable. Pending invitations stay answerable.",

  // skills & experts
  skillsTitle: "<b>Skills</b>",
  unknownSkill: "Unknown skill. See /skills all.",
  skillAdded: (label: string, discoverable: boolean) =>
    `Added <b>${label}</b>.${discoverable ? "" : " You're not discoverable yet — run /optin when ready."}`,
  skillRemoved: "Removed.",
  skillNotOnProfile: "That skill wasn't on your profile.",
  yourSkills: (list: string) => `<b>Your skills</b>\n${list}\n\n<code>/skills add …</code> · <code>/skills remove …</code> · /skills all`,
  expertUsage: "Tell me a topic, e.g. <code>/expert tax advice</code> (see /skills all).",
  expertCount: (n: number, labels: string) =>
    `<b>${n}</b> opted-in, available member(s) match <i>${labels}</i>.\n` +
    (n ? "Use <code>/intro …</code> to request an introduction." : "Try a broader topic, or ask in the community."),

  // introductions
  introUsage: "Describe what you need in a sentence, e.g.\n<code>/intro need an accountant for a 3-person startup</code>\n\nYour text is shown to matching experts <b>without your name</b>.",
  introCreated: (labels: string) =>
    `Request created (<i>${labels}</i>). I've invited the best-matching available expert anonymously. You'll be asked to confirm before any contact is shared. Invitations expire after 72h; I'll try up to 3 experts.`,
  introNoMatch: (labels: string) => `No opted-in, available expert matches <i>${labels}</i> right now. Try again later or ask in the community.`,
  introNoSkill: "I couldn't match that to a skill. Try naming the area, e.g. <code>/intro accountant for a small startup</code>, or see /skills all.",
  introCap: (n: number, cap: number) => `You already have ${n} open requests this week (limit ${cap}). Cancel one with /requests or wait.`,
  introClosedNoMatch: "No available expert accepted your request this time, so it is closed. You can try again later or ask in the community.",
  introInvite: (labels: string, need: string) =>
    `<b>Introduction request</b>\nA community member is looking for help with: <i>${labels}</i>\n\n<blockquote>${need}</blockquote>\n` +
    "Your identity stays private unless you accept <b>and</b> they confirm. This invitation expires in 72 hours.",
  bAccept: "Accept",
  bDecline: "Decline",
  bConfirm: "Confirm & exchange contacts",
  bCancel: "Cancel",
  bHelped: "It helped",
  bDidntHappen: "Didn't happen",
  bCancelRequest: "Cancel request",
  unknownAction: "Unknown action.",
  introGone: "This introduction no longer exists.",
  notYours: "This introduction is not yours.",
  inviteExpired: "This invitation has expired.",
  alreadyHandledOrNA: "Already handled, or no longer available.",
  alreadyHandled: "Already handled.",
  introAcceptedToRequester: (quote: string) => `<b>Good news:</b> an expert accepted your introduction request.\n${quote}\nConfirm to exchange contacts with them.`,
  introAcceptedReply: "Thanks! The requester will now be asked to confirm. Nothing is shared yet.",
  introDeclinedReply: "Declined. Nobody is told who you are.",
  introConnectedReq: "<b>You're connected.</b> Here is the expert's contact:",
  introConnectedCand: (quote: string) => `<b>You're connected.</b> The requester confirmed.\n${quote}\nTheir contact:`,
  introConfirmedReply: "Confirmed. Contacts have been shared with both of you.",
  introCancelledNotice: "An introduction you were part of was cancelled. Nothing was shared.",
  introCancelledReply: "Cancelled.",
  introCompletedReply: "Thanks for the feedback! It is private and only improves future matching.",
  introReminder: "Reminder: an introduction request is waiting for your answer. Ignore this if you're not interested; it expires automatically.",
  done: "Done.",
  noRequests: "You have no open requests.",
  requestStatus: (text: string, status: string) => `<blockquote>${text}</blockquote>Status: ${status === "matching" ? "looking for an expert" : status}`,
  requestCancelled: "Request cancelled.",
  alreadyClosed: "Already closed.",

  // data rights
  forgetConfirm: "<b>Delete my data?</b>\nThis removes all your stored messages, skills and open introductions, and stops storing your future messages. It cannot be undone.",
  bForgetYes: "Yes, delete everything",
  deleted: "Deleted.",
  nothingDeleted: "Nothing deleted.",
  forgetDone: (p: number, s: number, i: number) =>
    `Done: ${p} message(s), ${s} skill(s) and ${i} introduction(s) removed. Your future messages won't be stored. /resume_collection undoes the collection stop.`,
  resumeOk: "Your new messages in enabled groups will be stored again.",

  // digest
  dTitle: (day: string) => `<b>Daily digest · ${day}</b>`,
  dNew: (n: number) => `${n} new message(s):`,
  dUntitled: "Untitled group",
  dOpen: (n: number) => `<b>Open questions (${n})</b>`,
  dOpenLink: "open",
  dAnswered: (n: number) => `<b>Answered questions (${n})</b>`,
  dReplies: (n: number) => `${n} repl${n === 1 ? "y" : "ies"}`,
  dThread: "thread",
  dDocs: "<b>New documents</b>",
  dFooter: "<i>Quotes are verbatim; follow links for context. Turn off: /digest off</i>",

  // owner tools
  statusTitle: "<b>Status</b>",
  sourcesTitle: "<b>Sources</b>",
  fullHistory: "full history",
  noUncertain: "No uncertain sends.",
  didArrive: "Did it arrive?",
  bDelivered: "Delivered",
  bNotDelivered: "Not delivered",
  recorded: "Recorded.",
  alreadyResolved: "Already resolved.",

  // v2.1b
  routingUsage: "Usage: /routing on or /routing off (owner, in an enabled group).",
  routingOn: "Routing is <b>on</b>: questions with no reply after 4 hours are sent privately to up to 2 opted-in experts who can read this group.",
  routingOff: "Routing is off.",
  routePing: (labels: string, snippet: string, link: string) =>
    `<b>A question in your group is waiting for an answer</b> (<i>${labels}</i>):\n<blockquote>${snippet}</blockquote>\n${link}\n\nYou get this because you opted in as an expert. Stop these: /pings off`,
  openQuestion: "open the question",
  pingsUsage: "Usage: /pings on or /pings off",
  pingsOn: "You'll get occasional pings about unanswered questions in your skills.",
  pingsOff: "No more pings about unanswered questions.",
  catchupUsage: "Usage: <code>/catchup</code>, <code>/catchup 12h</code> or <code>/catchup 3d</code>",
  catchupNothing: "Nothing new in your groups since then.",
  canonicalSet: "⭐ Marked as the canonical answer. It will rank first for this topic.",
  canonicalSuperseded: (n: number) => `⭐ Marked as the canonical answer. ${n} older canonical answer(s) are now labelled outdated.`,
  canonicalTag: "⭐ canonical",
  outdatedTag: "⚠️ outdated",
  suggestSkill: (label: string) =>
    `You've answered several questions about <b>${label}</b>. Add it to your skills? Only you can see this suggestion, and nothing changes unless you accept.`,
  bAddSkill: "Add skill",
  bNoThanks: "No thanks",
  suggestAdded: "Added to your skills.",
  suggestDismissed: "OK, I won't suggest it again.",
  eventsTitle: "<b>Upcoming events</b>",
  eventsNone: "No upcoming events found in your groups.",
  eventsIcs: "Calendar file for these events:",
  eventHidden: "Hidden from /events.",
  appButton: "Open app",
};

export type Messages = typeof EN;

const RU: Messages = {
  dontKnowYou: "Я вас пока не знаю. Сначала напишите сообщение в одной из подключённых групп сообщества, затем попробуйте снова.",
  privateOnly: "Пожалуйста, отправьте эту команду мне в личном чате.",
  tooMany: "Слишком много запросов. Подождите минуту.",
  notAvailable: "Недоступно.",
  saved: "Сохранено.",
  yes: "да",
  no: "нет",
  on: "вкл",
  off: "выкл",
  start: "Привет! Я ищу по подключённым группам сообщества и отвечаю цитатами со ссылками, а ещё могу познакомить вас с экспертами, которые на это согласились.\n\n",
  help:
    "<b>Поиск</b>\n/ask <i>вопрос</i> — ответы с цитатами из ваших групп (понимаю опечатки и латиницу/кириллицу). В группе /ask ищет только по этой группе.\n\n" +
    "<b>Эксперты и знакомства</b>\n/intro <i>что вам нужно</i> — знакомство только с согласия обеих сторон\n" +
    "/expert <i>тема</i> — сколько экспертов подходит\n/requests — ваши открытые запросы\n\n" +
    "<b>Ваш профиль</b>\n/profile — настройки\n/digest on · /digest off — ежедневная сводка (по желанию)\n" +
    "/optin · /optout — видимость как эксперта\n/skills · /skills add <i>навык</i> · /skills remove <i>навык</i> · /skills all\n" +
    "/language ru · /language en — язык интерфейса\n/catchup — что нового · /events — ближайшие события · /pings on|off\n" +
    "Фильтры поиска: <code>in:группа since:2026-01-01 has:file</code>\n\n" +
    "<b>Помощь</b>\n/help <i>что нужно</i> — запрос, который ведёт оператор; без вашего разрешения ничего не уходит за пределы сообщества\n/requests · /cancel — открытые запросы\n\n" +
    "<b>Ваши данные</b>\n/privacy · /forget_me · /resume_collection",
  privacy:
    "<b>Миндальная связь: конфиденциальность</b>\n" +
    "• Сохраняются только группы, которые явно подключил владелец. В каждой такой группе есть уведомление.\n" +
    "• Ваше имя, юзернейм и телефон не сохраняются; у вас случайный внутренний ID.\n" +
    "• Ответы — дословные цитаты со ссылкой, только из групп, которые вы можете читать.\n" +
    "• Данные хранятся в Cloudflare D1. Ничего не отправляется в ИИ-сервисы. Файлы PDF, Word и PowerPoint превращаются в текст на серверах GitHub и там не хранятся.\n" +
    "• Вас не видно как эксперта, пока вы сами не выполните /optin.\n" +
    "• Для знакомства нужно согласие обоих, прежде чем кто-то получит контакт.\n" +
    "• Оценки ответов (👍/👎) приватны и только улучшают поиск.\n" +
    "• История хранится полностью. /forget_me удаляет ваши сообщения и профиль и останавливает сбор; ответьте /forget на своё сообщение в группе, чтобы удалить его.",
  languageSet: "Язык интерфейса: русский.",
  languageUsage: "Использование: <code>/language ru</code> или <code>/language en</code>",

  visibilityMust: (list: string) => `Видимость должна быть одной из: ${list}`,
  enabled: (vis: string) =>
    `Миндальная связь теперь <b>сохраняет</b> этот чат (видимость: ${vis}, история хранится полностью). ` +
    "Участники могут искать по нему через /ask здесь или в личке с ботом. Подробности — /privacy в личке с ботом, удалить свои данные — /forget_me.",
  disabled: "Миндальная связь больше не сохраняет этот чат. Уже сохранённые сообщения исключены из всех ответов.",
  retentionUsage: "Использование: /retention <дни 1..3650> — удалять старые сообщения, или /retention 0 — хранить всю историю.",
  retentionKeepAll: "История будет храниться полностью. Ничего не удаляется автоматически.",
  retentionSet: (days: number) => `Срок хранения: ${days} дн. Более старые сообщения удаляются ежедневно.`,
  removed: "Удалено из «Миндальной связи».",
  nothingStored: "Для этого сообщения ничего не сохранено.",
  hintsUsage: "Использование: /hints on или /hints off (владелец, в подключённой группе).",
  hintsOn: "Подсказки <b>включены</b>: если кто-то задаст вопрос, на который в группе уже отвечали, я один раз отвечу ссылкой на прошлый ответ.",
  hintsOff: "Подсказки выключены.",
  hint: (link: string) => `💡 Похоже, здесь уже отвечали на это: ${link}`,
  earlierAnswer: "прошлое обсуждение",

  askUsage: "Использование: <code>/ask ваш вопрос</code>",
  noAccess: "Пока нет источников, которые вам разрешено читать. Сначала напишите в подключённой группе или обратитесь к админу.",
  insufficient: "<b>Надёжного ответа не нашлось</b> в доступных вам источниках.\nПопробуйте переформулировать или спросите в сообществе.",
  insufficientGroup: "<b>Надёжного ответа не нашлось</b> в этой группе.\nПопробуйте переформулировать.",
  found: (n: number) => `<b>Найдено сообщений: ${n}</b> — дословные цитаты, проверьте источник:`,
  foundGroup: (n: number) => `<b>Найдено сообщений в этой группе: ${n}</b> — дословные цитаты:`,
  alsoSearched: (s: string) => `<i>Также искал: ${s}</i>`,
  source: "источник",
  sourceUnavailable: "ссылка недоступна",
  fbHelpful: "👍 Полезно",
  fbNotHelpful: "👎 Не помогло",
  fbWrong: (i: number) => `✗ ${i} не тот источник`,
  fbThanks: "Спасибо! Оценка приватна и только улучшает поиск.",
  fbAlready: "Уже учтено.",

  profileTitle: "<b>Ваш профиль</b> (видите только вы)",
  pDigest: "Ежедневная сводка",
  pDiscoverable: "Видимость как эксперта",
  pAvailable: "Доступен для знакомств",
  pReminders: "Напоминания",
  pCollection: "Сбор сообщений",
  pLanguage: "Язык",
  pStopped: "остановлен",
  pSkills: "Навыки",
  noneYet: "пока нет",
  suggested: "предложено",
  addSkillHint: "Добавить навык: <code>/skills add бухгалтерия</code>.",
  bDigestOn: "Включить сводку",
  bDigestOff: "Выключить сводку",
  bDiscoverOn: "Стать видимым",
  bDiscoverOff: "Скрыть меня",
  bResume: "Возобновить знакомства",
  bPause: "Пауза в знакомствах",
  bRemindersOn: "Включить напоминания",
  bRemindersOff: "Выключить напоминания",

  digestState: (on: boolean) => `Ежедневная сводка <b>${on ? "включена" : "выключена"}</b>. Изменить: <code>/digest on</code> или <code>/digest off</code>.`,
  digestOn: (hour: number) => `Вы будете получать ежедневную сводку (в ${hour}:00 по местному времени) по группам, которые вы можете читать.`,
  digestOff: "Ежедневная сводка выключена.",
  optin: "Теперь вас можно найти для знакомств <b>по навыкам, которые вы укажете</b>. Никто не узнает, кто вы, пока вы не примете конкретный запрос и автор его не подтвердит.\nДобавить навык: <code>/skills add python</code> · отменить: /optout",
  optout: "Вас больше не видно как эксперта. На уже полученные приглашения можно ответить.",

  skillsTitle: "<b>Навыки</b>",
  unknownSkill: "Неизвестный навык. Список: /skills all.",
  skillAdded: (label: string, discoverable: boolean) =>
    `Добавлено: <b>${label}</b>.${discoverable ? "" : " Вас пока не видно — выполните /optin, когда будете готовы."}`,
  skillRemoved: "Удалено.",
  skillNotOnProfile: "Этого навыка не было в профиле.",
  yourSkills: (list: string) => `<b>Ваши навыки</b>\n${list}\n\n<code>/skills add …</code> · <code>/skills remove …</code> · /skills all`,
  expertUsage: "Назовите тему, например <code>/expert налоги</code> (список: /skills all).",
  expertCount: (n: number, labels: string) =>
    `Подходит участников, согласных на знакомства: <b>${n}</b> (<i>${labels}</i>).\n` +
    (n ? "Чтобы запросить знакомство: <code>/intro …</code>" : "Попробуйте тему шире или спросите в сообществе."),

  introUsage: "Опишите одним предложением, что вам нужно, например:\n<code>/intro нужен бухгалтер для стартапа из 3 человек</code>\n\nВаш текст увидят подходящие эксперты, <b>но не ваше имя</b>.",
  introCreated: (labels: string) =>
    `Запрос создан (<i>${labels}</i>). Я анонимно пригласил самого подходящего эксперта. Перед обменом контактами вас попросят подтвердить. Приглашение действует 72 часа; я попробую до 3 экспертов.`,
  introNoMatch: (labels: string) => `Сейчас нет доступных экспертов по теме <i>${labels}</i>. Попробуйте позже или спросите в сообществе.`,
  introNoSkill: "Не удалось сопоставить запрос с навыком. Назовите область, например <code>/intro бухгалтер для небольшого стартапа</code>, или посмотрите /skills all.",
  introCap: (n: number, cap: number) => `У вас уже ${n} открытых запроса на этой неделе (лимит ${cap}). Отмените один через /requests или подождите.`,
  introClosedNoMatch: "На этот раз ни один эксперт не принял запрос, поэтому он закрыт. Попробуйте позже или спросите в сообществе.",
  introInvite: (labels: string, need: string) =>
    `<b>Запрос на знакомство</b>\nУчастнику сообщества нужна помощь: <i>${labels}</i>\n\n<blockquote>${need}</blockquote>\n` +
    "Вы останетесь анонимны, пока не примете запрос <b>и</b> автор не подтвердит. Приглашение действует 72 часа.",
  bAccept: "Принять",
  bDecline: "Отклонить",
  bConfirm: "Подтвердить и обменяться контактами",
  bCancel: "Отмена",
  bHelped: "Помогло",
  bDidntHappen: "Не состоялось",
  bCancelRequest: "Отменить запрос",
  unknownAction: "Неизвестное действие.",
  introGone: "Этого знакомства больше нет.",
  notYours: "Это знакомство не ваше.",
  inviteExpired: "Срок приглашения истёк.",
  alreadyHandledOrNA: "Уже обработано или недоступно.",
  alreadyHandled: "Уже обработано.",
  introAcceptedToRequester: (quote: string) => `<b>Хорошая новость:</b> эксперт принял ваш запрос на знакомство.\n${quote}\nПодтвердите, чтобы обменяться контактами.`,
  introAcceptedReply: "Спасибо! Теперь автор запроса должен подтвердить. Пока ничего не передано.",
  introDeclinedReply: "Отклонено. Никто не узнает, кто вы.",
  introConnectedReq: "<b>Вы на связи.</b> Контакт эксперта:",
  introConnectedCand: (quote: string) => `<b>Вы на связи.</b> Автор запроса подтвердил.\n${quote}\nЕго контакт:`,
  introConfirmedReply: "Подтверждено. Контакты отправлены вам обоим.",
  introCancelledNotice: "Знакомство, в котором вы участвовали, отменено. Ничего не было передано.",
  introCancelledReply: "Отменено.",
  introCompletedReply: "Спасибо за отзыв! Он приватен и только улучшает подбор.",
  introReminder: "Напоминание: запрос на знакомство ждёт вашего ответа. Если неинтересно — просто проигнорируйте, он истечёт сам.",
  done: "Готово.",
  noRequests: "У вас нет открытых запросов.",
  requestStatus: (text: string, status: string) =>
    `<blockquote>${text}</blockquote>Статус: ${status === "matching" ? "ищу эксперта" : status === "open" ? "открыт" : status}`,
  requestCancelled: "Запрос отменён.",
  alreadyClosed: "Уже закрыт.",

  forgetConfirm: "<b>Удалить мои данные?</b>\nБудут удалены все ваши сохранённые сообщения, навыки и открытые знакомства, а новые сообщения перестанут сохраняться. Отменить нельзя.",
  bForgetYes: "Да, удалить всё",
  deleted: "Удалено.",
  nothingDeleted: "Ничего не удалено.",
  forgetDone: (p: number, s: number, i: number) =>
    `Готово: удалено сообщений — ${p}, навыков — ${s}, знакомств — ${i}. Новые сообщения сохраняться не будут. /resume_collection снова включит сбор.`,
  resumeOk: "Ваши новые сообщения в подключённых группах снова будут сохраняться.",

  dTitle: (day: string) => `<b>Сводка за день · ${day}</b>`,
  dNew: (n: number) => `Новых сообщений: ${n}`,
  dUntitled: "Группа без названия",
  dOpen: (n: number) => `<b>Открытые вопросы (${n})</b>`,
  dOpenLink: "открыть",
  dAnswered: (n: number) => `<b>Вопросы с ответами (${n})</b>`,
  dReplies: (n: number) => `ответов: ${n}`,
  dThread: "обсуждение",
  dDocs: "<b>Новые документы</b>",
  dFooter: "<i>Цитаты дословные; подробности — по ссылкам. Отключить: /digest off</i>",

  statusTitle: "<b>Состояние</b>",
  sourcesTitle: "<b>Источники</b>",
  fullHistory: "вся история",
  noUncertain: "Нет отправок с неизвестным статусом.",
  didArrive: "Сообщение дошло?",
  bDelivered: "Дошло",
  bNotDelivered: "Не дошло",
  recorded: "Записано.",
  alreadyResolved: "Уже решено.",

  routingUsage: "Использование: /routing on или /routing off (владелец, в подключённой группе).",
  routingOn: "Маршрутизация <b>включена</b>: вопросы без ответа через 4 часа приватно отправляются максимум 2 экспертам, которые согласились и могут читать эту группу.",
  routingOff: "Маршрутизация выключена.",
  routePing: (labels: string, snippet: string, link: string) =>
    `<b>Вопрос в вашей группе ждёт ответа</b> (<i>${labels}</i>):\n<blockquote>${snippet}</blockquote>\n${link}\n\nВы получили это, потому что согласились быть экспертом. Отключить: /pings off`,
  openQuestion: "открыть вопрос",
  pingsUsage: "Использование: /pings on или /pings off",
  pingsOn: "Иногда буду присылать вопросы без ответа по вашим навыкам.",
  pingsOff: "Больше не буду присылать вопросы без ответа.",
  catchupUsage: "Использование: <code>/catchup</code>, <code>/catchup 12h</code> или <code>/catchup 3d</code>",
  catchupNothing: "С тех пор в ваших группах ничего нового.",
  canonicalSet: "⭐ Отмечено как основной ответ. Он будет первым по этой теме.",
  canonicalSuperseded: (n: number) => `⭐ Отмечено как основной ответ. Старых основных ответов помечено устаревшими: ${n}.`,
  canonicalTag: "⭐ основной ответ",
  outdatedTag: "⚠️ устарело",
  suggestSkill: (label: string) =>
    `Вы ответили на несколько вопросов по теме <b>${label}</b>. Добавить её в ваши навыки? Это предложение видите только вы, и ничего не изменится без вашего согласия.`,
  bAddSkill: "Добавить навык",
  bNoThanks: "Нет, спасибо",
  suggestAdded: "Добавлено в ваши навыки.",
  suggestDismissed: "Хорошо, больше не предложу.",
  eventsTitle: "<b>Ближайшие события</b>",
  eventsNone: "В ваших группах не найдено предстоящих событий.",
  eventsIcs: "Файл календаря с этими событиями:",
  eventHidden: "Скрыто из /events.",
  appButton: "Открыть приложение",
};

export const MESSAGES: Record<Lang, Messages> = { en: EN, ru: RU };
export const T = (lang: Lang): Messages => MESSAGES[lang];
