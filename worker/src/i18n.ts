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

/** Russian plural by the number: 1 раз, 2 раза, 5 раз (the one/few/many forms). */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const EN = {
  // general
  dontKnowYou: "We haven't met yet 🙂 Write something in a community group I'm in, then come back.",
  privateOnly: "This works in a private chat with me — message me there 🙂",
  tooMany: "Too many requests. Please wait a minute.",
  notAvailable: "Not available.",
  saved: "Saved.",
  yes: "yes",
  no: "no",
  on: "on",
  off: "off",
  start: "👋 Hi! I'm the Миндальная Связь assistant.\n\n" +
    "🔎 <b>I find answers.</b> Type a question — I search everything discussed in your groups and show where it came up.\n" +
    "🤝 <b>I find people.</b> No answer? I ask those ready to help. Contacts open only when you both agree.\n" +
    "📅 <b>I keep you posted.</b> What's new and what's coming up.\n\n" +
    "Try it now: type “who can recommend an accountant for a sole trader?”.\n\n",
  help: "<b>How to use me</b>\n\n" +
    "💬 <b>Ask.</b> Just type your question. I'll find the answer in your groups and show where it was discussed.\n" +
    "🙋 <b>Help others.</b> Tell me what you know well — I'll call on you only when a request fits.\n" +
    "🗞 <b>What's new.</b> /catchup — the highlights from your groups; /events — upcoming meetups.\n\n" +
    "<blockquote expandable>All commands\n" +
    "/intro — find someone who can help\n" +
    "/help <i>what you need</i> — pass a request to the club's team\n" +
    "/requests — your requests\n" +
    "/skills — skills and topics you help with\n" +
    "/optin and /optout — whether you can be called on for help\n" +
    "/open on | off — be offered projects\n" +
    "/introduce — introductions on request\n" +
    "/jobs — what people ask in your groups (group admins)\n" +
    "/digest on | off — a daily digest\n" +
    "/language ru — по-русски\n" +
    "/privacy — what I keep\n" +
    "/forget_me — delete everything about you</blockquote>",
  privacy:
    "<b>Telepathy privacy notice</b>\n" +
    "• I keep only groups an owner has enabled. Each one shows a notice.\n" +
    "• Answers quote messages verbatim with a link, only from groups you can read.\n" +
    "• Nobody can call you for help until you turn it on yourself (/optin).\n" +
    "<blockquote expandable>More details\n" +
    "• Your Telegram ID is kept so I can message you. Your username and phone number are not stored. Your name shows in answers only if you turn it on (/name on).\n" +
    "• An AI summary is written when the club has it switched on. It gets your question and the found messages, without authors or links; phone numbers and emails are removed from them.\n" +
    "• Data is stored in Cloudflare D1. PDF, Word and PowerPoint files are turned into text on GitHub's servers, and the files themselves are not kept there.\n" +
    "• An introduction happens only when you both agree; contacts open after that.\n" +
    "• Hiring offers (/open) and introductions on request (/introduce) stay off until you turn them on. The /introduce line is matched only against requests and is never shown. Turning off “Can call me for help” also turns off /open, /introduce and /rounds, and deletes the /introduce line.\n" +
    "• Group admins see only counts of request kinds (/jobs), never who asked.\n" +
    "• Answer feedback (👍/👎) is private and only improves ranking.\n" +
    "• Full history is kept. /forget_me deletes your messages, your profile, your /open and /introduce settings, and stops collection. Reply /forget to one of your messages in a group to delete only that one.</blockquote>",
  languageSet: "Language set to English.",
  languageUsage: "Usage: <code>/language en</code> or <code>/language ru</code>",

  // owner commands in groups
  visibilityMust: (list: string) => `Visibility must be one of: ${list}`,
  whereMember: "💡 <b>Where things work</b>\n" +
    "Here, in private — everything.\n" +
    "In a group — just /ask <i>question</i> (I answer from that group) and /forget as a reply to your own message to delete it.",
  whereOwner: "\n\n🛠 <b>For the owner</b>\n" +
    "Here: /status — is all well, /desk — your console for help requests, /sources — connected groups.\n" +
    "In a group where you're admin: /enable — connect, /disable — disconnect, /welcome — greet newcomers, /hints — hints, /routing — ask the experts when nothing is found.",
  adminGuide: (title: string) =>
    `✅ <b>“${title}” is connected.</b> Only you see this.\n\n` +
    "Members can now ask me about anything discussed here — in the group with /ask, or privately.\n\n" +
    "<b>What you can set in the group</b>\n" +
    "/welcome on|off — greet newcomers (on now)\n" +
    "/hints on|off — point to earlier answers to repeated questions\n" +
    "/routing on|off — ask the experts about questions unanswered for 4 hours\n" +
    "/retention 365 — keep only the last year (0 — everything)\n" +
    "/disable — disconnect the group\n\n" +
    "As a reply: /canonical — best answer, /notevent — not an event.\n" +
    "Past messages and help: here, in private — /app and /help.",
  welcomeDm: (title: string) =>
    `👋 Hi! I'm the assistant of <b>${title}</b>.\n\n` +
    "I'll help you find your way around this community and find anything that was ever discussed here. And if needed, I'll find the person who knows the answer.\n\n" +
    "Just type your question — or tap <b>App</b> at the bottom left. All commands: /help.",
  welcomeGroup: (name: string) =>
    `👋 ${name}, welcome! I'll help you find anything that was ever discussed here, and if needed, the person who knows the answer. Start a private chat with me to begin.`,
  welcomeButton: "Start a chat",
  connected: () =>
    "✨ I'm connected to this group. Anyone here can now ask me about anything discussed in it — /ask right here, or privately. " +
    "To search, I keep the group's messages: /privacy in a private chat with me explains how, and /forget_me deletes your data.",
  guideInGroup: (name: string) => `${name}, your settings and the button to load past messages are waiting in a private chat with me.`,
  guideButton: "⚙️ Open settings",
  askToConnect: "👋 Hi! I help this group find anything that was ever discussed here — and the person who knows the answer. To start, a group admin taps the button.",
  connectButton: "✨ Connect",
  onlyAdminsConnect: "Only a group admin can connect me.",
  whereGroupAdmin: "\n\n🛠 <b>Run a community?</b>\nAdd me to your group — that's the whole setup.",
  historyOffer: (button: boolean) =>
    "\n\n📜 <b>Older messages</b>\nRight now I only know what's written from today on. " +
    (button ? "Tap the button below and I'll load the group's past messages too — it takes a few seconds, then I finish in the background." : "To load the group's past messages too, open the app → Console → History."),
  historyButton: "📜 Load past messages",
  historyAuto: "\n\n📜 <b>Older messages</b>\nI'm loading the group's past messages by myself through your Telegram MCP server. I'll message you when they're all searchable.",
  historyMcpFailed: (title: string, button: boolean) =>
    `📜 I couldn't read the history of <b>${title}</b> through your Telegram MCP server (it kept failing for 10 minutes). Check its key and that it's running. ` +
    (button ? "Or load it from the app with the button below." : "Or load it from the app → Desk → History."),
  historyRemind: (title: string, read: number, button: boolean) =>
    `📜 Reading the history of <b>${title}</b> stopped before the start of the chat (${read} messages read). ` +
    (button ? "Tap the button to finish it — it takes a few seconds." : "Open the app → Desk → History to finish it — it takes a few seconds."),
  historyDone: (title: string, n: number) => `✅ The history of <b>${title}</b> is loaded: ${n} past messages are now searchable.`,
  welcomeUsage: "Usage: /welcome on or /welcome off (owner, in an enabled group).",
  welcomeOn: "Welcome is <b>on</b>: new members get a short intro from me, privately when Telegram allows it.",
  welcomeOff: "Welcome is <b>off</b> in this group.",
  disabled: "Telepathy stopped collecting this chat. Existing messages are excluded from all answers.",
  retentionUsage: "Usage: /retention &lt;days 1..3650&gt; to purge older messages, or /retention 0 to keep full history.",
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
  askUsage: "Usage: <code>/ask your question</code>, for example <code>/ask who built the club's site?</code>",
  askPrompt: "What do you want to know? Send the question as your next message and I'll search your groups.",
  aiNote: "✨ AI summary. Check it against the quotes below.",
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
  profileTitle: "👤 <b>Your profile</b> · only you see this",
  pDigest: "Daily digest",
  pDiscoverable: "🙋 Can call me for help",
  pAvailable: "⏸ Introductions",
  pReminders: "Reminders",
  pCollection: "💾 Keep my messages",
  pLanguage: "🌐 Language",
  pStopped: "stopped",
  pSkills: "🙋 I can help with",
  noneYet: "none yet",
  suggested: "suggested",
  bDigestOn: "🗞 Digest on",
  bDigestOff: "🗞 Digest off",
  bDiscoverOn: "🙋 Call me for help",
  bDiscoverOff: "🙋 Don't call me",
  bResume: "▶️ Resume",
  bPause: "⏸ Pause",
  bRemindersOn: "Reminders on",
  bRemindersOff: "Reminders off",
  pNoSkills: "nothing yet — tap “What I can help with”",
  pName: "🪪 Name in answers",
  pGoing: "on",
  pPaused: "paused",
  pOpenLine: "💼 Offer projects",
  bHelpWith: "✏️ What I can help with",
  bHelpMe: "🙋 I can help too",
  bMore: "⚙️ More",
  bBack: "← Back",
  bTeam: "📨 Pass to the club's team",
  bioPrompt: "What else can you help with? Write one line — e.g. “sole-trader taxes, accounting” — or send a link to your profile. I'll find the skills and add them.",
  alreadySet: "Already set that way.",
  bEvents: "📅 Upcoming events",
  moreTitle: "⚙️ <b>More</b>",
  moreNote: "Delete everything: /forget_me.",
  promptCancelled: "Cancelled.",

  // digest & consent
  digestState: (on: boolean, hour: number) =>
    `🗞 <b>Daily digest</b>: <b>${on ? "on" : "off"}</b>.\nThe highlights from groups you can read, at ${hour}:00 local time.`,
  digestOn: (hour: number) => `Digest on: every day at ${hour}:00 local time — the highlights from your groups.`,
  digestAlready: (on: boolean): string => (on ? "The digest is already on." : "The digest is already off."),
  digestOff: "Daily digest turned off.",
  optin: "Done: you can now be called on for help. Nobody sees your name until you accept a specific request.\nWhat can you help with? Send one line, e.g. “accounting for sole traders”.",
  optinAlready: (labels: string) =>
    labels ? `You can already be called on for help: <b>${labels}</b>. Add a topic by sending it in a line. Pause: /optout.` : "You can already be called on for help. What can you help with? Send one line.",
  optout: "You're no longer called on for help. Invitations you already got can still be answered.",
  optoutCleared: "Projects, introductions on request and introduction rounds are off too, and the introductions line is deleted. Turn any of them on again to get it back.",
  optoutAlready: "You're not being called on for help already.",

  // skills & experts
  skillsTitle: "<b>Skills</b>",
  unknownSkill: "Unknown skill. See /skills all.",
  skillAdded: (label: string, discoverable: boolean) =>
    `Added <b>${label}</b>.${discoverable ? "" : " You won't be called on for help yet — turn it on with /optin."}`,
  skillAlready: (label: string) => `<b>${label}</b> is already on your profile.`,
  skillRemoved: "Removed.",
  skillNotOnProfile: "That skill wasn't on your profile.",
  bioUsage: "Send me a link to your site or profile, or write a few lines about yourself after <code>/bio</code>. I'll add the skills I find. I don't keep the page or the text, only the skills.",
  bioAdded: (list: string, known: number) => `Added to your skills: <b>${list}</b>.${known ? ` ${known} you already had.` : ""}\nChange anything in /skills. I don't keep the page or the text.`,
  bioKnown: "Everything I found is already on your profile.",
  bioNone: "I couldn't find skills in that. Try pasting a few lines about what you do.",
  bioShort: "That's too short to read skills from. Send a link or a few lines about what you do.",
  bioBlocked: "That site doesn't let me read it (LinkedIn never does). Copy the About and Experience text and send it as <code>/bio …your text…</code>.",
  bioBadUrl: "I can read public web pages that start with https://. Send one of those, or paste the text.",
  bioFailed: "I couldn't open that page. Paste the text instead: <code>/bio …your text…</code>.",
  bioBusy: "One moment, then try again.",
  yourSkills: (list: string) => `<b>Your skills</b>\n${list}\n\n<code>/skills add …</code> · <code>/skills remove …</code> · /skills all · /bio`,
  expertUsage: "Tell me a topic, e.g. <code>/expert tax advice</code> (see /skills all).",
  expertCount: (n: number, labels: string) =>
    `<b>${n}</b> helper(s) ready now for <i>${labels}</i>.\n` +
    (n ? "Use <code>/intro …</code> to ask for help." : "Try a broader topic, or ask in the community."),

  // introductions
  introUsage: "Describe what you need in a sentence, e.g.\n<code>/intro need an accountant for a 3-person startup</code>\n\nOnly people who can help see your text, <b>without your name</b>.",
  introPrompt: "Who are you looking for? Write one line — e.g. “an accountant for a three-person startup”. Only people who can help see it, <b>without your name</b>.",
  introCreated: (labels: string) =>
    `✅ Request sent: <i>${labels}</i>. The best-matching helper got an anonymous invitation. The answer comes here. Valid for 72 hours.`,
  introNoMatch: (labels: string) =>
    `Nobody who helps with <i>${labels}</i> can take it right now. I've kept your request for two weeks and will tell you here as soon as someone can help.`,
  introWaiting: "Nobody answered this time. The request is waiting: I'll tell you as soon as someone who can help appears.",
  waitingFound: (labels: string) => `🙋 Someone who can help with <i>${labels}</i> turned up. The invitation went out anonymously. I'll tell you when they reply.`,
  askPickTopic: "Pick a topic and I'll find someone in your community who offered to help with it.",
  askNoHelpers: "Nobody in your community has offered help with anything yet, so there's no one to ask. Pass the request to the club's team, and I'll let you know if someone appears.",
  introNoSkill: "I couldn't tell what to look for. Name the area, e.g. <code>/intro accountant for a small startup</code>. All topics: /skills all.",
  introCap: (n: number, cap: number) => `You already have ${n} open requests this week (limit ${cap}). Cancel one in /requests or wait for an answer.`,
  introClosedNoMatch: "There's no one left to ask. The request is closed. Rephrase it, or pass it to the club's team.",
  introInvite: (labels: string, need: string, why: string) =>
    `<b>Request for help</b>\nSomeone in the community needs help with: <i>${labels}</i>\n\n<blockquote>${need}</blockquote>\n` +
    (why ? `${why}\n` : "") +
    "Your name stays hidden until you accept and they confirm. Valid for 72 hours.",
  bAccept: "Accept",
  bDecline: "Not now",
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
  introAcceptedToRequester: (quote: string) => `<b>Good news:</b> someone accepted your request for help.\n${quote}\nConfirm to open contacts.`,
  introAcceptedReply: "Thanks! The requester will now be asked to confirm. Nothing is shared yet.",
  introDeclinedReply: "Declined. Nobody is told who you are.",
  introConnectedReq: "<b>You're connected.</b> Their contact:",
  introConnectedCand: (quote: string) => `<b>You're connected.</b> The requester confirmed.\n${quote}\nTheir contact:`,
  introConfirmedReply: "Confirmed. Contacts have been shared with both of you.",
  introCancelledNotice: "An introduction you were part of was cancelled. Nothing was shared.",
  introCancelledReply: "Cancelled.",
  introCompletedReply: "Thanks for the feedback! It is private and only improves future matching.",
  introReminder: "Reminder: a request for help is waiting for your answer. If you can't help, just ignore it — it expires by itself.",
  done: "Done.",
  noRequests: "You have no open requests.",
  requestStatus: (text: string, status: string) =>
    `<blockquote>${text}</blockquote>Status: ${status === "matching" ? "looking for someone who can help" : status === "waiting" ? "waiting for someone who can help" : status}`,
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
  routingOn: "Asking helpers is <b>on</b>: questions with no reply after 4 hours go privately to at most two opted-in helpers who can read this group.",
  routingOff: "Asking the experts is off.",
  routePing: (labels: string, snippet: string, link: string) =>
    `<b>A question in your group is waiting for an answer</b> (<i>${labels}</i>):\n<blockquote>${snippet}</blockquote>\n${link}\n\nYou get this because you agreed to help. Stop these: /pings off`,
  openQuestion: "open the question",
  pingsUsage: "Usage: /pings on or /pings off",
  pingsOn: "You'll get occasional pings about unanswered questions in your skills.",
  pingsOff: "No more pings about unanswered questions.",
  catchupUsage: "Usage: <code>/catchup</code>, <code>/catchup 12h</code> or <code>/catchup 3d</code>",
  catchupNothing: "Nothing new in your groups since then.",
  canonicalSet: "⭐ Marked as the best answer. It will rank first for this topic.",
  canonicalSuperseded: (n: number) => `⭐ Marked as the best answer. ${n} older best answer(s) are now labelled outdated.`,
  canonicalTag: "⭐ best answer",
  outdatedTag: "⚠️ outdated",
  suggestSkill: (label: string) =>
    `You've answered several questions about <b>${label}</b>. Add it to your skills? Only you can see this suggestion, and nothing changes unless you accept.`,
  suggestSkillUnmet: (label: string, n: number) =>
    `Questions about <b>${label}</b> came up ${n} times this month and nobody was there to answer. You've answered similar ones: add it to your skills? Only you see this, and nothing changes without your say.`,
  bAddSkill: "Add skill",
  bNoThanks: "No thanks",
  suggestAdded: "Added to your skills.",
  suggestDismissed: "OK, I won't suggest it again.",
  eventsTitle: "<b>Upcoming events</b>",
  eventsNone: "No upcoming events are announced in your groups yet.",
  eventsIcs: "Calendar file for these events:",
  eventHidden: "Hidden from /events.",
  appButton: "Open app",
  // «Нить»: the living request card (one message, edited in place)
  memberAnon: "Member",
  threadSearching: "🔍 Searching the community's memory…",
  threadMemoryHead: "💡 Found in the community's memory",
  threadMemoryAsk: "Is this what you need?",
  threadNothing: "Nothing in the community's memory on this yet. You can ask the people who know it.",
  threadAsking: (n: number) => `🙋 Asked ${n} people who know this. I'll write here as soon as someone replies.`,
  threadNoMatch: "⏳ Nobody has answered yet. I'm still looking and will write here as soon as someone who can help appears.",
  threadCancelled: "Request cancelled.",
  threadExpired: "This request expired. You can ask again.",
  threadCandidate: (who: string) => `🤝 ${who} is ready to help. Confirm to open the contacts.`,
  threadConnected: "🤝 You're connected. The contacts are open.",
  threadFollowup: "Did it help? Pick how it went.",
  threadFollowupAsk: "Did it help? Pick how it went, it takes a second.",
  threadClosed: (label: string) => `✅ Outcome: ${label}`,
  threadThanked: "🙏 Thanks sent.",
  threadStopped: "This request is closed.",
  threadSolvedToast: "Glad it helped!",
  threadNotThatToast: "Thanks, noted.",
  threadThanksSent: "Thanks sent.",
  thanksReceived: (q: string, n: number) => `🙏 Someone thanked you for helping with “${q}”. You've helped ${n} people so far.`,
  outcomeContactLabel: "got the contact",
  outcomeAdviceLabel: "got advice",
  outcomeSolvedLabel: "solved",
  bOutcomeContact: "📇 Got the contact",
  bOutcomeAdvice: "💬 Got advice",
  bOutcomeSolved: "✅ Solved it",
  bThatsIt: "✅ That's it",
  bAskPeople: "🙋 Ask people",
  bNotThat: "👎 Not that",
  bThanks: "🙏 Thank them",
  bCancelAsk: "✖ Cancel request",
  bOpenPrivately: "💬 Open in private",
  threadGroupFound: (n: number) => `💡 Found ${n} answer(s) in the community's memory. I sent them to you privately.`,
  threadGroupNothing: "🔍 Nothing in the memory yet. I sent the next steps to you privately.",
  // Wow moment after a history import, and forgotten questions
  wowTopics: "What your community talks about",
  wowHelpers: "Who helps most",
  wowForgotten: (n: number) => `I found ${n} question(s) nobody answered`,
  wowNoneForgotten: "Every question found an answer. Lovely.",
  wowForgottenHead: "Questions without an answer. Tap one and I'll look for it.",
  bLook: "Look",
  bAnswerIt: "Answer it",
  // Pilot metrics (owner)
  pilotTitle: "Pilot: how requests go",
  pilotAll: "Requests",
  pilotMemory: "Answered from memory",
  pilotAsked: "Asked people",
  pilotConnected: "Connected",
  pilotSolved: "Outcomes: solved / advice / contact",
  pilotSpeed: "Median time to the first answer",
  pilotNone: "No requests yet.",
  // Group settings card
  settingsTitle: "⚙️ Settings for this group",
  setHints: "Answer repeated questions",
  setRouting: "Ask people who know when nothing is found",
  setWelcome: "Welcome newcomers",
  setRetention: (days: number) => (days ? `Keeping messages for ${days} days` : "Keeping all messages (change with /retention)"),
  // Showing a first name on answer cards (off by default)
  nameOn: "Your first name will show on answer cards now.",
  nameOff: "Your name is hidden again: you're a face in the crowd 🙂",
  bNameOn: "🪪 Show my name",
  bNameOff: "🪪 Hide my name",
  nameUsage: "Use <code>/name on</code> to show your first name on answer cards, or <code>/name off</code> to hide it.",
  // Expert side (journey 4): why you, pauses, quiet hours, thank-you words
  introWhy: (label: string, n: number) => `Why you: you've answered about <i>${label}</i> ${n} time(s).`,
  pauseSuggest: "You've said not now twice in a row. Want a pause? Requests stop until you switch them back on.",
  bKeepOn: "Keep as it is",
  pQuiet: "Quiet hours",
  bQuietOn: "🌙 Quiet 22:00–08:00",
  bQuietOff: "🌙 Turn quiet hours off",
  pHelped: (n: number) => `You've helped ${n} people`,
  thanksAsk: "Write a few words for them. They'll see them. Or tap “No words”.",
  bNoWords: "No words, just thanks",
  thanksWithWords: (q: string, words: string, n: number) => `🙏 Someone thanked you for helping with “${q}”: “${words}”. You've helped ${n} people so far.`,
  // Пульс: the weekly summary of one group (journey 9)
  pulseTitle: (group: string) => `<b>Pulse · ${group}</b> — last week`,
  pulseQuestions: (n: number) => `Questions: <b>${n}</b>`,
  pulseAnswered: (n: number) => `Answered: <b>${n}</b>`,
  pulseWaiting: (n: number) => `Waiting for an answer: <b>${n}</b>`,
  pulseSpeed: (h: string) => `Median time to the first answer: <b>${h}</b>`,
  pulseTop: (name: string, n: number) => `Helps most: <b>${name}</b> (${n})`,
  pulseQuiet: "A quiet week. Nothing needs your attention ✨",
  pulseNoHelp: "Nobody has answered yet this week.",
  bPulseShare: "📣 Share with the group",
  pulseShared: "Shared with the group.",
  pulseShare: (group: string, q: number, a: number, helper: string) => `🌰 Last week in ${group}: ${q} question(s), ${a} answered. Thank you, ${helper}!`,
  pulseNone: "No groups to show a pulse for yet.",
  // Союз and Мост (journeys 5 and 6)
  levelRequests: "Only requests",
  levelExperts: "Requests and experts",
  levelFull: "Full bridge",
  levelRequestsWhat: "only the text of a request crosses. No names, no contacts.",
  levelExpertsWhat: "experts see requests as roles (“a tax expert”), never by name.",
  levelFullWhat: "experts who agreed to be found are listed for the asker too.",
  unionCardTitle: (club: string, members: number) => `<b>${club}</b> invites you to an alliance. The club has ${members} member(s).`,
  unionCardTopics: (topics: string) => `They talk about: ${topics}`,
  unionWhatCrosses: "What crosses, if you accept:",
  unionGone: "This invitation is no longer valid.",
  unionNoClub: "Connect the bot to your group first. Then your club can join an alliance.",
  unionSame: "That's your own club.",
  unionExists: "You already have an alliance with this club.",
  unionAccepted: (partner: string, level: string) => `🌉 “${partner}” accepted the alliance (${level}).`,
  unionJoined: (inviter: string, level: string) => `🌉 You're allied with “${inviter}” (${level}). Requests cross both ways.`,
  unionNotice: (status: string): string => (status === "paused" ? "🌉 The alliance is paused. Nothing crosses until it's resumed." : status === "ended" ? "🌉 The alliance has ended. Nothing crosses any more." : "🌉 The alliance is on again."),
  unionTitle: "<b>🌉 Alliances</b>",
  unionNone: "No alliances yet. Invite a partner club: pick your club and what crosses.",
  unionPickClub: "Which of your clubs invites?",
  unionInviteSent: (link: string) => `Send this link to the other club's owner. It works once, for 7 days:\n${link}`,
  unionInviteCode: (code: string) => `Open the bot and send <code>/start u${code}</code> to the other club's owner.`,
  unionRow: (mine: string, other: string, level: string, status: string) => `${mine} ↔ ${other} · ${level} · ${status}`,
  unionCredit: (helped: number, received: number) => `Helped: ${helped} · helped by: ${received}`,
  unionStatusActive: "active",
  unionStatusPaused: "paused",
  unionStatusEnded: "ended",
  bUnionPause: "⏸ Pause",
  bUnionResume: "▶️ Resume",
  bUnionEnd: "✖ End alliance",
  bInviteFrom: (club: string) => `➕ Invite a club from “${club}”`,
  bridgeConfirm: "Ask partner clubs? They see only the text of your request, never your name or contact. A contact opens only if you and the helper both agree.",
  bBridgeGo: "🌉 Ask partner clubs",
  bBridge: "🌉 Ask partner clubs",
  bridgeNone: "There are no partner clubs you can ask yet.",
  bridgeAsk: (from: string, q: string) => `🌉 A request from partner club “${from}”:\n<blockquote>${q}</blockquote>\nAnyone who can answer it can say so.`,
  bridgeHelp: (to: string) => `🤝 Help came from “${to}”. Open the contact?`,
  bOpenContact: "🤝 Open the contact",
  bridgeConnected: (to: string) => `🤝 You're connected through “${to}”. Their contact is below.`,
  bridgeConnectedHelper: "🤝 The asker agreed to connect. Their contact is below.",
  bridgeThanksHelper: "Thanks. The asker will see that you can help, and you'll both be connected if they say yes.",
  bridgeGone: "This request is no longer open.",
  bridgeTaken: "Someone from that club already took it.",
  bridgeStatusOpen: "open",
  bridgeStatusHelper: "help found",
  bridgeStatusConnected: "connected",
  bridgeStatusClosed: "closed",
  bridgeStatusExpired: "no answer",
  threadBridgeOpen: (to: string) => `🌉 Asked “${to}”. I'll write here as soon as someone there replies.`,
  threadBridgeConnected: (to: string) => `🤝 You're connected through “${to}”. Did it help?`,
  threadBridgeExpired: (to: string) => `🌉 Nobody in “${to}” has replied yet.`,
  threadBridgeClosed: "🌉 Closed: the partner club helped.",
  threadBridgeEnded: "🌉 This request is closed.",
  bHelpfulBridge: "✅ It helped",
  // Operator console for bridges
  bridgesTitle: "<b>Bridges (operator)</b>",
  bridgesNone: "No bridges yet.",
  bResend: "🔁 Send to the club again",
  bCloseBridge: "✖ Close",
  bridgeClosedByOperator: "Closed.",
  bridgeSent: "Sent to the club.",
  bHelpIt: "🙋 I can help",
  // «Главное»: the daily card (journey 7)
  glavTitle: "What matters",
  glavNeed: "📌 Waiting for you",
  glavOwnQ: "❓ Your question, still unanswered",
  glavPay: "💸 Money, with a deadline",
  glavMeet: "🗓 Meetings and decisions",
  glavTalk: "💬 What the club talked about",
  glavQuiet: "Quiet today. Nothing needs your attention ✨",
  bDone: "✓ Done",
  // Newcomer onboarding (journey 2)
  onbQuestions: "People here often ask about:",
  onbPick: "What can you help others with? Or what are you looking for? Tap one, or skip.",
  onbPrivacy: "What I keep: messages from this group, while it's connected.\nTo delete everything: /forget_me.",
  bSkip: "Skip",
  onbSaved: (label: string) => `Noted: ${label}. If someone needs this, I'll let you know.`,
  onbMatch: (label: string) => `Someone here knows ${label} well. Shall I ask them, with their consent? An introduction happens only if they agree.`,
  bAskThem: "🙋 Ask",
  // Gatherings (journey 8)
  gatherGo: "✅ I'm going",
  gatherNo: "🤷 Not this time",
  gatherWhoBtn: "👥 Who's going",
  gatherSaved: "Noted. I'll remind you two hours before.",
  gatherNobody: "Nobody has said they're going yet.",
  gatherWhoHead: (n: number) => `Going: ${n}.`,
  gatherSharedSkill: (label: string) => `you both know ${label}`,
  gatherAlsoGoing: "also going",
  gatherWhoLine: (who: string, why: string) => `• ${who} — ${why}`,
  gatherGone: "This one has changed. Open /events again.",
  gatherWantSaved: "Noted. If they want it too, I'll let you both know.",
  gatherMutual: "🤝 You both want to keep in touch. Contacts below.",
  gatherMutualHere: "🤝 It's mutual. I've sent you each other's contact.",
  gatherRemind: (title: string) => `⏰ In about two hours: ${title}. You said you're going.`,
  gatherAfterAsk: (title: string) => `How was ${title}? Who would you like to see again? It opens only if they want it too.`,
  // Ковчег (journey 10)
  arkNotSet: "Ковчег: copies aren't set up yet. The operator can connect them.",
  arkSafe: (date: string) => `Ковчег: your community is safe. Last copy: ${date}.`,
  arkNoCopy: "Ковчег: set up, but no copy has been made yet.",
  arkCall: (url: string) => `The community has moved. Here is the new address: ${url}`,
  bArkTake: "📦 Take everything",
  bArkCall: "📣 Call everyone",
  arkMoveUsage: "Usage: <code>/move https://new-address</code>. Everyone in your clubs is told the new address when you tap “Call everyone”.",
  arkMoveBad: "That isn't a secure address. Use one that starts with https://.",
  arkMoveSet: (url: string) => `New address saved: ${url}`, // the caller escapes it
  arkNoMoveUrl: "Set the new address first with /move.",
  arkCalled: (n: number) => `Telling ${n} people.`,
  arkTaken: (n: number) => `Exported ${n} messages from your clubs.`,
  knowsTitle: "<b>What I know about you</b>",
  knowsMessages: (n: number) => `Messages you wrote, kept: <b>${n}</b>`,
  knowsSkills: (n: number) => `Skills on your profile: <b>${n}</b>`,
  knowsThreads: (n: number) => `Requests you opened: <b>${n}</b>`,
  knowsRsvps: (n: number) => `Gatherings you answered for: <b>${n}</b>`,
  knowsIntros: (n: number) => `Introductions and requests: <b>${n}</b>`,
  knowsHowTo: "Each line above can be removed with its button. Your messages go with /forget_me.",
  bKnowSkills: "🗑 Remove my skills",
  bKnowThreads: "🗑 Remove my requests",
  bKnowRsvps: "🗑 Remove my gatherings",
  knowsDone: "Removed.",
};

export type Messages = typeof EN;

const RU: Messages = {
  dontKnowYou: "Мы пока не знакомы 🙂 Напишите что-нибудь в группе сообщества, где я есть, — и возвращайтесь.",
  privateOnly: "Это работает в личном чате со мной — напишите мне туда 🙂",
  tooMany: "Слишком много запросов. Подождите минуту.",
  notAvailable: "Недоступно.",
  saved: "Сохранено.",
  yes: "да",
  no: "нет",
  on: "вкл",
  off: "выкл",
  start: "👋 Здравствуйте! Я — помощник «Миндальной Связи».\n\n" +
    "🔎 <b>Найду ответ.</b> Напишите вопрос — поищу во всём, что обсуждали в ваших группах, и покажу, где это было.\n" +
    "🤝 <b>Найду человека.</b> Если ответа нет — спрошу тех, кто готов помочь. Контакты открываются, только если согласны оба.\n" +
    "📅 <b>Не дам пропустить важное.</b> Что нового и какие встречи впереди.\n\n" +
    "Попробуйте прямо сейчас: напишите «кто посоветует бухгалтера для ИП?».\n\n",
  help: "<b>Как пользоваться</b>\n\n" +
    "💬 <b>Спросить.</b> Просто напишите вопрос. Я найду ответ в ваших группах и покажу, где его обсуждали.\n" +
    "🙋 <b>Помогать.</b> Расскажите, в чём разбираетесь, — позову вас, только когда запрос подходит.\n" +
    "🗞 <b>Что нового.</b> /catchup — главное из групп, /events — ближайшие встречи.\n\n" +
    "<blockquote expandable>Все команды\n" +
    "/intro — найти того, кто поможет\n" +
    "/help <i>что нужно</i> — передать запрос команде клуба\n" +
    "/requests — ваши запросы\n" +
    "/skills — навыки и темы, с которыми помогаете\n" +
    "/optin и /optout — звать вас на помощь или нет\n" +
    "/open on | off — предлагать проекты\n" +
    "/introduce — знакомства по запросу\n" +
    "/jobs — что спрашивают в группах (для админов групп)\n" +
    "/digest on | off — сводка каждый день\n" +
    "/language en — English\n" +
    "/privacy — что я храню\n" +
    "/forget_me — удалить всё обо мне</blockquote>",
  privacy:
    "<b>Миндальная Связь: конфиденциальность</b>\n" +
    "• Сохраняю только группы, которые подключил владелец. В каждой есть уведомление.\n" +
    "• Ответы — дословные цитаты со ссылкой, только из групп, которые вы можете читать.\n" +
    "• Вас не зовут на помощь, пока вы сами не включите это (/optin).\n" +
    "<blockquote expandable>Подробнее\n" +
    "• Сохраняется ваш Telegram-ID — чтобы я мог писать вам. Юзернейм и телефон не сохраняются. Имя видно в ответах, только если вы сами его включили (/name on).\n" +
    "• Пересказ ответа пишет ИИ, если он подключён в клубе. Ему уходят ваш вопрос и найденные сообщения — без авторов и ссылок; телефоны и почту из них убираю.\n" +
    "• Данные хранятся в Cloudflare D1. Файлы PDF, Word и PowerPoint переводятся в текст на серверах GitHub, сами файлы там не хранятся.\n" +
    "• Знакомство происходит, только когда согласны оба; контакты открываются после этого.\n" +
    "• Предложение проектов (/open) и знакомства по запросу (/introduce) выключены, пока вы их не включите. Строка из /introduce сверяется только с запросами и никому не показывается. Если выключить «Звать меня на помощь», проекты, знакомства по запросу и круги (/rounds) тоже выключаются, а строка из /introduce удаляется.\n" +
    "• Администраторы групп видят только количество запросов по видам (/jobs), но не того, кто спрашивал.\n" +
    "• Оценки ответов (👍/👎) приватны и только улучшают поиск.\n" +
    "• История хранится полностью. /forget_me удаляет ваши сообщения, профиль и настройки /open и /introduce и останавливает сбор. Ответьте /forget на своё сообщение в группе, чтобы удалить только его.</blockquote>",
  languageSet: "Язык интерфейса: русский.",
  languageUsage: "Использование: <code>/language ru</code> или <code>/language en</code>",

  visibilityMust: (list: string) => `Видимость должна быть одной из: ${list}`,
  whereMember: "💡 <b>Где что работает</b>\n" +
    "В личке — всё.\n" +
    "В группе — только /ask <i>вопрос</i> (отвечу из этой группы) и /forget ответом на своё сообщение, чтобы его удалить.",
  whereOwner: "\n\n🛠 <b>Для владельца</b>\n" +
    "Здесь: /status — всё ли в порядке, /desk — ваш пульт: просьбы о помощи, /sources — подключённые группы.\n" +
    "В группе, где вы админ: /enable — подключить, /disable — отключить, /welcome — приветствие новичков, /hints — подсказки, /routing — спрашивать тех, кто помогает, если ответа нет.",
  adminGuide: (title: string) =>
    `✅ <b>«${title}» подключена.</b> Это видите только вы.\n\n` +
    "Теперь участники могут спрашивать меня о том, что здесь обсуждали, — в группе через /ask или в личке.\n\n" +
    "<b>Что можно настроить в группе</b>\n" +
    "/welcome on|off — приветствовать новичков (сейчас включено)\n" +
    "/hints on|off — подсказывать прошлые ответы на повторные вопросы\n" +
    "/routing on|off — спрашивать знающих о вопросах без ответа 4 часа\n" +
    "/retention 365 — хранить только последний год (0 — всё)\n" +
    "/disable — отключить группу\n\n" +
    "Ответом на сообщение: /canonical — лучший ответ, /notevent — это не событие.\n" +
    "Старые сообщения и помощь — здесь, в личке: /app и /help.",
  welcomeDm: (title: string) =>
    `👋 Здравствуйте! Я помощник сообщества <b>${title}</b>.\n\n` +
    "Помогу сориентироваться в сообществе и найти всё, что здесь когда-либо обсуждали. А если нужно — найду человека, который знает ответ.\n\n" +
    "Просто напишите вопрос — или нажмите <b>Приложение</b> внизу слева. Все команды — /help.",
  welcomeGroup: (name: string) =>
    `👋 ${name}, добро пожаловать! Я помогу найти всё, что здесь когда-либо обсуждали, а если нужно — человека, который знает ответ. Откройте личный чат со мной, чтобы начать.`,
  welcomeButton: "Начать",
  connected: () =>
    "✨ Я подключился к этой группе. Теперь любой участник может спросить меня о том, что здесь обсуждали, — /ask прямо здесь или в личке. " +
    "Чтобы искать, я сохраняю сообщения группы: как именно — /privacy в личке со мной, удалить свои данные — /forget_me.",
  guideInGroup: (name: string) => `${name}, настройки и кнопка для загрузки старых сообщений ждут вас в личке у меня.`,
  guideButton: "⚙️ Открыть настройки",
  askToConnect: "👋 Привет! Я помогаю найти всё, что здесь когда-либо обсуждали, — и человека, который знает ответ. Чтобы начать, админ группы нажимает кнопку.",
  connectButton: "✨ Подключить",
  onlyAdminsConnect: "Подключить меня может только админ группы.",
  whereGroupAdmin: "\n\n🛠 <b>Ведёшь сообщество?</b>\nДобавь меня в свою группу — это вся настройка.",
  historyOffer: (button: boolean) =>
    "\n\n📜 <b>Старые сообщения</b>\nСейчас я знаю только то, что напишут начиная с сегодня. " +
    (button ? "Нажмите кнопку ниже — и я загружу прошлые сообщения группы. Это займёт несколько секунд, остальное сделаю в фоне." : "Чтобы я загрузил и прошлые сообщения группы, откройте приложение → Пульт → История."),
  historyButton: "📜 Загрузить старые сообщения",
  historyAuto: "\n\n📜 <b>Старые сообщения</b>\nЗагружаю прошлые сообщения группы через ваш Telegram MCP-сервер. Сообщу, когда всё можно будет найти.",
  historyMcpFailed: (title: string, button: boolean) =>
    `📜 Не получилось прочитать историю <b>${title}</b> через ваш Telegram MCP-сервер (10 минут подряд ошибки). Проверьте ключ и что сервер работает. ` +
    (button ? "Или загрузите её из приложения кнопкой ниже." : "Или загрузите её из приложения → Пульт → История."),
  historyRemind: (title: string, read: number, button: boolean) =>
    `📜 Чтение истории <b>${title}</b> остановилось раньше начала чата (прочитано ${read} сообщений). ` +
    (button ? "Нажмите кнопку, чтобы дочитать, — это займёт несколько секунд." : "Откройте приложение → Пульт → История, чтобы дочитать, — это займёт несколько секунд."),
  historyDone: (title: string, n: number) => `✅ История <b>${title}</b> загружена: ${n} прошлых сообщений теперь можно найти.`,
  welcomeUsage: "Использование: /welcome on или /welcome off (владелец, в подключённой группе).",
  welcomeOn: "Приветствие <b>включено</b>: новые участники получат от меня короткое интро — лично, когда Telegram это позволяет.",
  welcomeOff: "Приветствие в этой группе <b>выключено</b>.",
  disabled: "Миндальная Связь больше не сохраняет этот чат. Уже сохранённые сообщения исключены из всех ответов.",
  retentionUsage: "Использование: /retention &lt;дни 1..3650&gt; — удалять старые сообщения, или /retention 0 — хранить всю историю.",
  retentionKeepAll: "История будет храниться полностью. Ничего не удаляется автоматически.",
  retentionSet: (days: number) => `Срок хранения: ${days} дн. Более старые сообщения удаляются ежедневно.`,
  removed: "Удалено из «Миндальной Связи».",
  nothingStored: "Для этого сообщения ничего не сохранено.",
  hintsUsage: "Использование: /hints on или /hints off (владелец, в подключённой группе).",
  hintsOn: "Подсказки <b>включены</b>: если кто-то задаст вопрос, на который в группе уже отвечали, я один раз отвечу ссылкой на прошлый ответ.",
  hintsOff: "Подсказки выключены.",
  hint: (link: string) => `💡 Похоже, здесь уже отвечали на это: ${link}`,
  earlierAnswer: "прошлое обсуждение",

  askUsage: "Напишите вопрос после <code>/ask</code>, например: <code>/ask кто делал сайт клуба?</code>",
  askPrompt: "Что хотите узнать? Напишите вопрос следующим сообщением — я поищу ответ в ваших группах.",
  aiNote: "✨ Пересказ от ИИ. Сверьте с цитатами ниже.",
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

  profileTitle: "👤 <b>Ваш профиль</b> · видите только вы",
  pDigest: "🗞 Сводка каждый день",
  pDiscoverable: "🙋 Звать меня на помощь",
  pAvailable: "⏸ Знакомства",
  pReminders: "🔔 Напоминания",
  pCollection: "💾 Сохранять мои сообщения",
  pLanguage: "🌐 Язык",
  pStopped: "остановлен",
  pSkills: "🙋 Помогаю с",
  noneYet: "пока нет",
  suggested: "предложено",
  bDigestOn: "🗞 Включить сводку",
  bDigestOff: "🗞 Выключить сводку",
  bDiscoverOn: "🙋 Звать меня на помощь",
  bDiscoverOff: "🙋 Не звать меня",
  bResume: "▶️ Продолжить",
  bPause: "⏸ Пауза",
  bRemindersOn: "🔔 Включить напоминания",
  bRemindersOff: "🔔 Выключить напоминания",
  pNoSkills: "пока ничего — нажмите «С чем помогаю»",
  pName: "🪪 Имя в ответах",
  pGoing: "идут",
  pPaused: "на паузе",
  pOpenLine: "💼 Предлагать проекты",
  bHelpWith: "✏️ С чем помогаю",
  bHelpMe: "🙋 Я тоже могу помогать",
  bMore: "⚙️ Ещё",
  bBack: "← Назад",
  bTeam: "📨 Передать команде клуба",
  moreTitle: "⚙️ <b>Ещё</b>",
  moreNote: "Удалить все данные: /forget_me.",
  promptCancelled: "Отменено.",
  bioPrompt: "С чем ещё можете помочь? Напишите одной строкой — например: «налоги для ИП, бухгалтерия» — или пришлите ссылку на свой профиль. Найду навыки и добавлю их.",
  alreadySet: "Уже так.",
  bEvents: "📅 Ближайшие встречи",

  digestState: (on: boolean, hour: number) =>
    `🗞 <b>Сводка каждый день</b>: <b>${on ? "включена" : "выключена"}</b>.\nГлавное из групп, которые вы можете читать, — в ${hour}:00 по местному времени.`,
  digestOn: (hour: number) => `Сводка включена: каждый день в ${hour}:00 по местному времени — главное из ваших групп.`,
  digestOff: "Сводка выключена.",
  digestAlready: (on: boolean): string => (on ? "Сводка уже включена." : "Сводка уже выключена."),
  optin: "Готово: теперь вас могут позвать на помощь. Имя никто не увидит, пока вы сами не согласитесь на конкретный запрос.\nС чем можете помочь? Напишите одной строкой, например: «бухгалтерия для ИП».",
  optinAlready: (labels: string) =>
    labels
      ? `Вас уже могут позвать на помощь: <b>${labels}</b>. Добавить тему — напишите её одной строкой. Пауза — /optout.`
      : "Вас уже могут позвать на помощь. С чем можете помочь? Напишите одной строкой.",
  optout: "Вас больше не зовут на помощь. Уже полученные приглашения можно принять или отклонить.",
  optoutCleared: "Проекты, знакомства по запросу и круги знакомств тоже выключены, а строка знакомств удалена. Чтобы вернуть что-то из этого, включите это заново.",
  optoutAlready: "Вас и так не зовут на помощь.",

  skillsTitle: "<b>Навыки</b>",
  unknownSkill: "Неизвестный навык. Список: /skills all.",
  skillAdded: (label: string, discoverable: boolean) =>
    `Добавлено: <b>${label}</b>.${discoverable ? "" : " Звать вас на помощь пока не будут: включите — /optin."}`,
  skillAlready: (label: string) => `«${label}» уже в вашем профиле.`,
  skillRemoved: "Удалено.",
  skillNotOnProfile: "Этого навыка не было в профиле.",
  bioUsage: "Пришлите ссылку на сайт или профиль — или напишите пару строк о себе после <code>/bio</code>. Я добавлю найденные навыки. Страницу и текст не храним, остаются только навыки.",
  bioAdded: (list: string, known: number) => `Добавлено в ваши навыки: <b>${list}</b>.${known ? ` Ещё ${known} уже были.` : ""}\nПоправить можно в /skills. Страницу и текст не храним.`,
  bioKnown: "Всё, что нашёл, уже есть в вашем профиле.",
  bioNone: "Навыков в этом не нашлось. Попробуйте вставить пару строк о том, чем вы занимаетесь.",
  bioShort: "Слишком коротко, чтобы найти навыки. Пришлите ссылку или пару строк о том, чем вы занимаетесь.",
  bioBlocked: "Этот сайт не даёт прочитать страницу (LinkedIn не даёт никогда). Скопируйте текст из «О себе» и «Опыт» и пришлите так: <code>/bio …ваш текст…</code>.",
  bioBadUrl: "Читаю только открытые страницы, которые начинаются с https://. Пришлите такую ссылку или вставьте текст.",
  bioFailed: "Не получилось открыть страницу. Вставьте текст: <code>/bio …ваш текст…</code>.",
  bioBusy: "Секунду, и попробуйте ещё раз.",
  yourSkills: (list: string) => `<b>Ваши навыки</b>\n${list}\n\n<code>/skills add …</code> · <code>/skills remove …</code> · /skills all · /bio`,
  expertUsage: "Назовите тему, например <code>/expert налоги</code> (все темы: /skills all).",
  expertCount: (n: number, labels: string) =>
    `Сейчас готовы помочь по теме: <b>${n}</b> (<i>${labels}</i>).\n` +
    (n ? "Чтобы попросить помощи: <code>/intro …</code>" : "Попробуйте тему шире или спросите в клубе."),

  introUsage: "Опишите одной фразой, что вам нужно, — например: <code>/intro нужен бухгалтер для стартапа из 3 человек</code>\n\nТекст увидят только те, кто может помочь, <b>без вашего имени</b>.",
  introPrompt: "Кого ищете? Напишите одной строкой — например: «бухгалтер для стартапа из трёх человек». Текст увидят только те, кто может помочь, <b>без вашего имени</b>.",
  introCreated: (labels: string) =>
    `✅ Запрос отправлен: <i>${labels}</i>. Анонимное приглашение получил тот, кто подходит лучше всего. Ответ придёт сюда. Срок — 72 часа.`,
  introNoMatch: (labels: string) =>
    `Сейчас никто из тех, кто помогает с «${labels}», не может взяться. Запрос сохранён на две недели: как только такой человек появится, сообщу сюда.`,
  introWaiting: "На этот раз никто не откликнулся. Запрос ждёт: сообщу, как только появится тот, кто может помочь.",
  waitingFound: (labels: string) => `🙋 Нашёлся тот, кто может помочь с «${labels}». Приглашение отправлено анонимно. Сообщу, как только будет ответ.`,
  askPickTopic: "Выберите тему — найду в клубе того, кто готов помогать в ней.",
  askNoHelpers: "Пока никто в клубе не отметил, с чем готов помогать, так что спросить некого. Передайте запрос команде клуба — и я сообщу, если кто-то появится.",
  introNoSkill: "Не поняли, с чем помочь. Назовите тему, например: <code>/intro бухгалтер для небольшого стартапа</code>. Все темы — /skills all.",
  introCap: (n: number, cap: number) => `У вас уже ${n} открытых запроса на этой неделе (лимит ${cap}). Отмените один в /requests или дождитесь ответа.`,
  introClosedNoMatch: "Больше никого не осталось, кого можно спросить. Запрос закрыт — переформулируйте его или передайте команде клуба.",
  introInvite: (labels: string, need: string, why: string) =>
    `<b>Просьба о помощи</b>\nВ клубе нужна помощь: <i>${labels}</i>\n\n<blockquote>${need}</blockquote>\n` +
    (why ? `${why}\n` : "") +
    "Ваше имя не увидят, пока вы не согласитесь и автор запроса не подтвердит. Срок — 72 часа.",
  bAccept: "Принять",
  bDecline: "Не сейчас",
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
  introAcceptedToRequester: (quote: string) => `<b>Хорошая новость:</b> на вашу просьбу откликнулись.\n${quote}\nПодтвердите, чтобы открыть контакты.`,
  introAcceptedReply: "Спасибо! Теперь автор запроса должен подтвердить. Пока ничего не передано.",
  introDeclinedReply: "Отклонено. Никто не узнает, кто вы.",
  introConnectedReq: "<b>Вы на связи.</b> Контакт:",
  introConnectedCand: (quote: string) => `<b>Вы на связи.</b> Автор запроса подтвердил.\n${quote}\nКонтакт автора:`,
  introConfirmedReply: "Подтверждено. Контакты отправлены вам обоим.",
  introCancelledNotice: "Знакомство, в котором вы участвовали, отменено. Ничего не было передано.",
  introCancelledReply: "Отменено.",
  introCompletedReply: "Спасибо за отзыв! Он приватен и только улучшает подбор.",
  introReminder: "Напоминание: просьба о помощи ждёт ответа. Если не можете — просто проигнорируйте: она истечёт сама.",
  done: "Готово.",
  noRequests: "У вас нет открытых запросов.",
  requestStatus: (text: string, status: string) =>
    `<blockquote>${text}</blockquote>Статус: ${status === "matching" ? "ищем того, кто поможет" : status === "open" ? "открыт" : status === "waiting" ? "ждём, кто поможет" : status}`,
  requestCancelled: "Запрос отменён.",
  alreadyClosed: "Уже закрыт.",

  forgetConfirm: "<b>Удалить ваши данные?</b>\nУдалим все ваши сохранённые сообщения, навыки и открытые запросы, а новые сообщения перестанем сохранять. Отменить нельзя.",
  bForgetYes: "Да, удалить всё",
  deleted: "Удалено.",
  nothingDeleted: "Ничего не удалено.",
  forgetDone: (p: number, s: number, i: number) =>
    `Готово: удалено сообщений — ${p}, навыков — ${s}, запросов — ${i}. Новые сообщения сохраняться не будут. /resume_collection — снова сохранять.`,
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
  routingOn: "Спрашивать тех, кто помогает, <b>включено</b>: вопросы без ответа через 4 часа приватно отправляются не больше чем двум из них — тех, кто согласился и может читать эту группу.",
  routingOff: "Спрашивание знающих выключено.",
  routePing: (labels: string, snippet: string, link: string) =>
    `<b>Вопрос в вашей группе ждёт ответа</b> (<i>${labels}</i>):\n<blockquote>${snippet}</blockquote>\n${link}\n\nВы получили это, потому что согласились помогать. Отключить: /pings off`,
  openQuestion: "открыть вопрос",
  pingsUsage: "Использование: /pings on или /pings off",
  pingsOn: "Иногда буду присылать вопросы без ответа по вашим навыкам.",
  pingsOff: "Больше не буду присылать вопросы без ответа.",
  catchupUsage: "Использование: <code>/catchup</code>, <code>/catchup 12h</code> или <code>/catchup 3d</code>",
  catchupNothing: "С тех пор в ваших группах ничего нового.",
  canonicalSet: "⭐ Отмечено как лучший ответ. Он будет первым по этой теме.",
  canonicalSuperseded: (n: number) => `⭐ Отмечено как лучший ответ. Старых лучших ответов помечено устаревшими: ${n}.`,
  canonicalTag: "⭐ лучший ответ",
  outdatedTag: "⚠️ устарело",
  suggestSkill: (label: string) =>
    `Вы ответили на несколько вопросов по теме <b>${label}</b>. Добавить её в ваши навыки? Это предложение видите только вы, и ничего не изменится без вашего согласия.`,
  suggestSkillUnmet: (label: string, n: number) =>
    `По теме <b>${label}</b> за месяц спрашивали ${n} ${ruPlural(n, "раз", "раза", "раз")}, и ответить было некому. Вы уже отвечали на похожие вопросы: добавить тему в ваши навыки? Это видите только вы, и без вашего согласия ничего не меняется.`,
  bAddSkill: "Добавить навык",
  bNoThanks: "Нет, спасибо",
  suggestAdded: "Добавлено в ваши навыки.",
  suggestDismissed: "Хорошо, больше не предложу.",
  eventsTitle: "<b>Ближайшие события</b>",
  eventsNone: "Ближайших встреч в ваших группах пока не объявлено.",
  eventsIcs: "Файл календаря с этими событиями:",
  eventHidden: "Скрыто из /events.",
  appButton: "Открыть приложение",
  // «Нить»: живая карточка запроса (одно сообщение, которое правится на месте)
  memberAnon: "Участник",
  threadSearching: "🔍 Ищу в памяти клуба…",
  threadMemoryHead: "💡 Нашлось в памяти клуба",
  threadMemoryAsk: "Это то, что нужно?",
  threadNothing: "В памяти клуба пока ничего нет. Можно спросить тех, кто в этом разбирается.",
  threadAsking: (n: number) => `🙋 Спросили ${n} чел. из тех, кто помогает. Сообщу сюда, как только кто-то откликнется.`,
  threadNoMatch: "⏳ Пока никто не откликнулся. Продолжаю искать и сообщу сюда, как только появится тот, кто может помочь.",
  threadCancelled: "Запрос отменён.",
  threadExpired: "Срок запроса истёк. Можно спросить ещё раз.",
  threadCandidate: (who: string) => `🤝 ${who} готов помочь. Подтвердите, чтобы открыть контакты.`,
  threadConnected: "🤝 Вы на связи. Контакты открыты.",
  threadFollowup: "Помогло? Выберите, как получилось.",
  threadFollowupAsk: "Ну что, помогло? Выберите, как получилось — это секунда.",
  threadClosed: (label: string) => `✅ Итог: ${label}`,
  threadThanked: "🙏 Спасибо отправлено.",
  threadStopped: "Этот запрос закрыт.",
  threadSolvedToast: "Рад, что помогло!",
  threadNotThatToast: "Спасибо, учту.",
  threadThanksSent: "Спасибо отправлено.",
  thanksReceived: (q: string, n: number) =>
    `🙏 Вас поблагодарили за помощь с вопросом «${q}». Вы уже помогли ${n === 1 ? "одному человеку" : `${n} людям`}.`,
  outcomeContactLabel: "контакт получен",
  outcomeAdviceLabel: "дали совет",
  outcomeSolvedLabel: "задача решена",
  bOutcomeContact: "📇 Контакт получен",
  bOutcomeAdvice: "💬 Дали совет",
  bOutcomeSolved: "✅ Задача решена",
  bThatsIt: "✅ Это то, что нужно",
  bAskPeople: "🙋 Спросить людей",
  bNotThat: "👎 Не то",
  bThanks: "🙏 Спасибо",
  bCancelAsk: "✖ Отменить запрос",
  bOpenPrivately: "💬 Открыть в личке",
  threadGroupFound: (n: number) => `💡 Нашлось ответов в памяти клуба: ${n}. Отправлено вам в личку.`,
  threadGroupNothing: "🔍 В памяти пока пусто. Следующие шаги — в личке.",
  // Wow moment после загрузки истории, и вопросы без ответа
  wowTopics: "О чём говорит ваше сообщество",
  wowHelpers: "Кто помогает чаще всех",
  wowForgotten: (n: number) => `Нашлось ${n} ${ruPlural(n, "вопрос", "вопроса", "вопросов")} без ответа`,
  wowNoneForgotten: "На все вопросы нашлись ответы. Здорово!",
  wowForgottenHead: "Вопросы без ответа. Нажмите на один — поищу ответ.",
  bLook: "Посмотреть",
  bAnswerIt: "Ответить",
  // Пилот: показатели для владельца
  pilotTitle: "Пилот: как идут запросы",
  pilotAll: "Запросов",
  pilotMemory: "Ответ из памяти",
  pilotAsked: "Спросили людей",
  pilotConnected: "Связались",
  pilotSolved: "Итоги: решил / совет / контакт",
  pilotSpeed: "Медианное время до первого ответа",
  pilotNone: "Запросов пока нет.",
  // Карточка настроек группы
  settingsTitle: "⚙️ Настройки группы",
  setHints: "Отвечать на повторные вопросы",
  setRouting: "Спрашивать знающих, если ответа нет",
  setWelcome: "Приветствовать новичков",
  setRetention: (days: number) => (days ? `Храню сообщения ${days} дн.` : "Храню всю историю (изменить: /retention 90)"),
  // Имя в карточках ответов (по умолчанию скрыто)
  nameOn: "Теперь в ответах будет видно ваше имя.",
  nameOff: "Имя скрыто: вы снова участник в толпе 🙂",
  bNameOn: "🪪 Показывать моё имя",
  bNameOff: "🪪 Скрыть моё имя",
  nameUsage: "Напишите <code>/name on</code>, чтобы в ответах видели ваше имя, или <code>/name off</code>, чтобы скрыть.",
  // Сторона эксперта (путь 4): почему ты, паузы, тихие часы, слова благодарности
  introWhy: (label: string, n: number) => `Почему вам: вы отвечали про «${label}» ${n} ${ruPlural(n, "раз", "раза", "раз")}.`,
  pauseSuggest: "Вы дважды подряд ответили «Не сейчас». Поставить паузу? Запросы перестанут приходить, пока вы сами не включите их снова.",
  bKeepOn: "Оставить как есть",
  pQuiet: "Тихие часы",
  bQuietOn: "🌙 Тихо с 22:00 до 08:00",
  bQuietOff: "🌙 Выключить тихие часы",
  pHelped: (n: number) => `Помогли людям: ${n}`,
  thanksAsk: "Напишите пару слов — автор запроса их увидит. Или нажмите «Без слов».",
  bNoWords: "Без слов, просто спасибо",
  thanksWithWords: (q: string, words: string, n: number) =>
    `🙏 Вас поблагодарили за помощь с вопросом «${q}»: «${words}». Вы уже помогли ${n === 1 ? "одному человеку" : `${n} людям`}.`,
  // Пульс: еженедельная сводка по одной группе (путь 9)
  pulseTitle: (group: string) => `<b>Пульс · ${group}</b> — за неделю`,
  pulseQuestions: (n: number) => `Вопросов: <b>${n}</b>`,
  pulseAnswered: (n: number) => `Получили ответ: <b>${n}</b>`,
  pulseWaiting: (n: number) => `Ждут ответа: <b>${n}</b>`,
  pulseSpeed: (h: string) => `Среднее время до первого ответа: <b>${h}</b>`,
  pulseTop: (name: string, n: number) => `Больше всех помогает: <b>${name}</b> (${n})`,
  pulseQuiet: "Тихая неделя. Ничего не требует твоего внимания ✨",
  pulseNoHelp: "На этой неделе ответов пока не было.",
  bPulseShare: "📣 Поделиться с группой",
  pulseShared: "Отправлено в группу.",
  pulseShare: (group: string, q: number, a: number, helper: string) => `🌰 За неделю в «${group}»: вопросов ${q}, ответили на ${a}. Спасибо, ${helper}!`,
  pulseNone: "Пока нет групп, по которым можно показать пульс.",
  // Союз и Мост (пути 5 и 6)
  levelRequests: "Только запросы",
  levelExperts: "Запросы и эксперты",
  levelFull: "Полный мост",
  levelRequestsWhat: "перетекает только текст запроса. Ни имён, ни контактов.",
  levelExpertsWhat: "эксперты видны как роли («эксперт по налогам»), без имён.",
  levelFullWhat: "эксперты, которые согласились, видны и автору запроса в каталоге.",
  unionCardTitle: (club: string, members: number) => `<b>${club}</b> приглашает в Союз. В клубе ${members} чел.`,
  unionCardTopics: (topics: string) => `Говорят о: ${topics}`,
  unionWhatCrosses: "Что перетечёт, если принять:",
  unionGone: "Это приглашение уже не действует.",
  unionNoClub: "Сначала подключите бота к своей группе — тогда у вашего клуба будет место в Союзе.",
  unionSame: "Это ваш собственный клуб.",
  unionExists: "Союз с этим клубом уже есть.",
  unionAccepted: (partner: string, level: string) => `🌉 «${partner}» принял Союз (${level}).`,
  unionJoined: (inviter: string, level: string) => `🌉 Союз с «${inviter}» открыт (${level}). Запросы идут в обе стороны.`,
  unionNotice: (status: string): string => (status === "paused" ? "🌉 Союз на паузе. Ничего не перетекает, пока его не включат снова." : status === "ended" ? "🌉 Союз завершён. Ничего больше не перетекает." : "🌉 Союз снова работает."),
  unionTitle: "<b>🌉 Союзы</b>",
  unionNone: "Союзов пока нет. Пригласите клуб-партнёр: выберите свой клуб и то, что перетекает.",
  unionPickClub: "Какой из ваших клубов приглашает?",
  unionInviteSent: (link: string) => `Отправь эту ссылку владельцу другого клуба. Она работает один раз, 7 дней:\n${link}`,
  unionInviteCode: (code: string) => `Открыть бота и отправить владельцу другого клуба: <code>/start u${code}</code>`,
  unionRow: (mine: string, other: string, level: string, status: string) => `${mine} ↔ ${other} · ${level} · ${status}`,
  unionCredit: (helped: number, received: number) => `Вы помогли: ${helped} · вам помогли: ${received}`,
  unionStatusActive: "работает",
  unionStatusPaused: "на паузе",
  unionStatusEnded: "завершён",
  bUnionPause: "⏸ Пауза",
  bUnionResume: "▶️ Возобновить",
  bUnionEnd: "✖ Завершить Союз",
  bInviteFrom: (club: string) => `➕ Пригласить из «${club}»`,
  bridgeConfirm: "Спросить клубы-партнёры? Они увидят только текст запроса — ни имени, ни контакта. Контакт откроется, только если вы и помогающий оба согласны.",
  bBridgeGo: "🌉 Спросить клубы-партнёры",
  bBridge: "🌉 Спросить клубы-партнёры",
  bridgeNone: "Пока нет клубов-партнёров, у которых можно спросить.",
  bridgeAsk: (from: string, q: string) => `🌉 Запрос из клуба-партнёра «${from}»:\n<blockquote>${q}</blockquote>\nКто может ответить, может сказать об этом.`,
  bridgeHelp: (to: string) => `🤝 Помощь пришла из «${to}». Открыть контакт?`,
  bOpenContact: "🤝 Открыть контакт",
  bridgeConnected: (to: string) => `🤝 Вы на связи через «${to}». Контакт помогающего ниже.`,
  bridgeConnectedHelper: "🤝 Автор запроса подтвердил. Его контакт ниже.",
  bridgeThanksHelper: "Спасибо. Автор увидит, что вы можете помочь, и вы свяжетесь, если он тоже согласится.",
  bridgeGone: "Этот запрос уже не открыт.",
  bridgeTaken: "Кто-то из того клуба уже взялся.",
  bridgeStatusOpen: "открыт",
  bridgeStatusHelper: "помощь найдена",
  bridgeStatusConnected: "на связи",
  bridgeStatusClosed: "закрыт",
  bridgeStatusExpired: "без ответа",
  threadBridgeOpen: (to: string) => `🌉 Спросили в «${to}». Сообщу сюда, как только там откликнутся.`,
  threadBridgeConnected: (to: string) => `🤝 Вы на связи через «${to}». Помогло?`,
  threadBridgeExpired: (to: string) => `🌉 В «${to}» пока никто не откликнулся.`,
  threadBridgeClosed: "🌉 Закрыто: помогли в клубе-партнёре.",
  threadBridgeEnded: "🌉 Этот запрос закрыт.",
  bHelpfulBridge: "✅ Помогло",
  // Пульт оператора: мосты
  bridgesTitle: "<b>Мосты (оператор)</b>",
  bridgesNone: "Мостов пока нет.",
  bResend: "🔁 Отправить клубу ещё раз",
  bCloseBridge: "✖ Закрыть",
  bridgeClosedByOperator: "Закрыто.",
  bridgeSent: "Отправлено клубу.",
  bHelpIt: "🙋 Помогу",
  // «Главное»: ежедневная карточка (путь 7)
  glavTitle: "Главное",
  glavNeed: "📌 Ждёт вас",
  glavOwnQ: "❓ Ваш вопрос без ответа",
  glavPay: "💸 Деньги и сроки",
  glavMeet: "🗓 Встречи и решения",
  glavTalk: "💬 О чём говорил клуб",
  glavQuiet: "Сегодня тихо. Ничего не требует твоего внимания ✨",
  bDone: "✓ Готово",
  // Знакомство с новичком (путь 2)
  onbQuestions: "Здесь часто спрашивают про:",
  onbPick: "Чем можете помочь другим? Или что ищете? Нажмите одно или пропустите.",
  onbPrivacy: "Что я храню: сообщения этой группы, пока она подключена.\nУдалить всё: /forget_me.",
  bSkip: "Пропустить",
  onbSaved: (label: string) => `Записано: ${label}. Если кому-то это понадобится, сообщу.`,
  onbMatch: (label: string) => `Здесь есть человек, который хорошо разбирается в «${label}». Спросить его? Знакомство — только если он согласится.`,
  bAskThem: "🙋 Спросить",
  // Встречи (путь 8)
  gatherGo: "✅ Иду",
  gatherNo: "🤷 Не в этот раз",
  gatherWhoBtn: "👥 Кто будет",
  gatherSaved: "Записано. Напомню за два часа.",
  gatherNobody: "Пока никто не написал, что придёт.",
  gatherWhoHead: (n: number) => `Придут: ${n}.`,
  gatherSharedSkill: (label: string) => `вы оба про «${label}»`,
  gatherAlsoGoing: "тоже идёт",
  gatherWhoLine: (who: string, why: string) => `• ${who} — ${why}`,
  gatherGone: "Это уже не актуально. Откройте /events заново.",
  gatherWantSaved: "Записано. Если и он захочет — сообщу вам обоим.",
  gatherMutual: "🤝 Вы оба хотите оставаться на связи. Контакты ниже.",
  gatherMutualHere: "🤝 Взаимно! Контакты отправлены вам обоим.",
  gatherRemind: (title: string) => `⏰ Примерно через два часа: ${title}. Вы отметили, что идёте.`,
  gatherAfterAsk: (title: string) => `Как прошло «${title}»? Кого хотите увидеть снова? Контакт откроется, только если и он захочет.`,
  // Ковчег (путь 10)
  arkNotSet: "Ковчег: копии ещё не настроены. Оператор может их подключить.",
  arkSafe: (date: string) => `Ковчег: ваше сообщество в безопасности. Последняя копия: ${date}.`,
  arkNoCopy: "Ковчег: настроен, но копия ещё не создавалась.",
  arkCall: (url: string) => `Сообщество переехало. Новый адрес: ${url}`,
  bArkTake: "📦 Забрать всё",
  bArkCall: "📣 Позвать всех",
  arkMoveUsage: "Использование: <code>/move https://новый-адрес</code>. Когда нажмёте «Позвать всех», все в ваших клубах узнают новый адрес.",
  arkMoveBad: "Это не безопасный адрес. Нужен адрес, который начинается с https://.",
  arkMoveSet: (url: string) => `Новый адрес сохранён: ${url}`, // the caller escapes it
  arkNoMoveUrl: "Сначала укажите новый адрес через /move.",
  arkCalled: (n: number) => `Сообщаю ${n} людям.`,
  arkTaken: (n: number) => `Выгружено сообщений из ваших клубов: ${n}.`,
  knowsTitle: "<b>Что я знаю о вас</b>",
  knowsMessages: (n: number) => `Сообщения, которые вы написали и которые я сохранил: <b>${n}</b>`,
  knowsSkills: (n: number) => `Навыков в профиле: <b>${n}</b>`,
  knowsThreads: (n: number) => `Запросов, которые вы открыли: <b>${n}</b>`,
  knowsRsvps: (n: number) => `Встреч, на которые вы ответили: <b>${n}</b>`,
  knowsIntros: (n: number) => `Знакомств и запросов на знакомство: <b>${n}</b>`,
  knowsHowTo: "Каждую строку можно убрать её кнопкой. Ваши сообщения удаляются через /forget_me.",
  bKnowSkills: "🗑 Убрать мои навыки",
  bKnowThreads: "🗑 Убрать мои запросы",
  bKnowRsvps: "🗑 Убрать мои встречи",
  knowsDone: "Удалено.",
};

export const MESSAGES: Record<Lang, Messages> = { en: EN, ru: RU };
export const T = (lang: Lang): Messages => MESSAGES[lang];
