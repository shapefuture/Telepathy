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
  dontKnowYou: "We haven't met yet 🙂 Write something in a community group I'm in, then come back.",
  privateOnly: "This works in a private chat with me — message me there 🙂",
  tooMany: "Too many requests. Please wait a minute.",
  notAvailable: "Not available.",
  saved: "Saved.",
  yes: "yes",
  no: "no",
  on: "on",
  off: "off",
  start: "👋 Hi! I'm the Миндальная связь assistant.\n\n" +
    "🔎 <b>I find answers.</b> Just type a question — I'll search everything discussed in your groups and show where it was.\n" +
    "🤝 <b>I find people.</b> No answer? I'll point you to someone who knows. Introductions only if you both agree.\n" +
    "📅 <b>I keep you posted.</b> What's new and what's coming up.\n\n" +
    "Easiest in the app: the <b>Menu</b> button, bottom left.\n\n",
  help: "<b>How to use me</b>\n\n" +
    "🔎 <b>Ask</b>\nJust type your question here.\nIn a group: /ask <i>question</i> — I'll answer from that group.\n\n" +
    "🤝 <b>Find a person</b>\n/intro <i>what you need</i> — I'll find who can help\n/help <i>what you need</i> — ask the community team for help\n/requests — your requests\n\n" +
    "📅 <b>Stay in the loop</b>\n/catchup — what's new\n/events — upcoming meetups\n/digest on — a daily summary\n\n" +
    "🙂 <b>About you</b>\n/profile — settings\n/skills — what you're good at\n/optin — let people find you as an expert\n/language ru — по-русски\n\n" +
    "🔒 <b>Privacy</b>\n/privacy — what I keep\n/forget_me — delete everything about you",
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
    "I'll help you find your way around this community and find anything that was ever discussed here. And if needed, I'll find the person who knows the answer to your question.\n\n" +
    "Just type your question — or tap <b>Menu</b> at the bottom left to open the app. All commands: /help.",
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
  askUsage: "Usage: <code>/ask your question</code>",
  aiNote: "AI summary — check it against the sources below.",
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
  introInvite: (labels: string, need: string, why: string) =>
    `<b>Introduction request</b>\nA community member is looking for help with: <i>${labels}</i>\n\n<blockquote>${need}</blockquote>\n` +
    (why ? `${why}\n` : "") +
    "Your identity stays private unless you accept <b>and</b> they confirm. This invitation expires in 72 hours.",
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
  routingOn: "Asking the experts is <b>on</b>: questions with no reply after 4 hours are sent privately to up to 2 opted-in experts who can read this group.",
  routingOff: "Asking the experts is off.",
  routePing: (labels: string, snippet: string, link: string) =>
    `<b>A question in your group is waiting for an answer</b> (<i>${labels}</i>):\n<blockquote>${snippet}</blockquote>\n${link}\n\nYou get this because you opted in as an expert. Stop these: /pings off`,
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
  bAddSkill: "Add skill",
  bNoThanks: "No thanks",
  suggestAdded: "Added to your skills.",
  suggestDismissed: "OK, I won't suggest it again.",
  eventsTitle: "<b>Upcoming events</b>",
  eventsNone: "No upcoming events found in your groups.",
  eventsIcs: "Calendar file for these events:",
  eventHidden: "Hidden from /events.",
  appButton: "Open app",
  // «Нить»: the living request card (one message, edited in place)
  memberAnon: "Member",
  threadSearching: "🔍 Searching the community's memory…",
  threadMemoryHead: "💡 Found in the community's memory",
  threadMemoryAsk: "Is this what you need?",
  threadNothing: "Nothing in the community's memory on this yet. Ask the people who know it?",
  threadAsking: (n: number) => `🙋 Asked ${n} people who know this. I'll write here as soon as someone replies.`,
  threadNoMatch: "No one suitable has taken it yet. I'll keep looking and write here.",
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
};

export type Messages = typeof EN;

const RU: Messages = {
  dontKnowYou: "Мы пока не знакомы 🙂 Напиши что-нибудь в группе сообщества, где я есть, — и возвращайся.",
  privateOnly: "Это работает в личном чате со мной — напиши мне туда 🙂",
  tooMany: "Слишком много запросов. Подождите минуту.",
  notAvailable: "Недоступно.",
  saved: "Сохранено.",
  yes: "да",
  no: "нет",
  on: "вкл",
  off: "выкл",
  start: "👋 Привет! Я — помощник «Миндальной связи».\n\n" +
    "🔎 <b>Найду ответ.</b> Просто напиши вопрос — поищу во всём, что обсуждали в твоих группах, и покажу, где это было.\n" +
    "🤝 <b>Найду человека.</b> Если ответа нет — подскажу, кто в сообществе разбирается. Познакомлю, только если вы оба согласны.\n" +
    "📅 <b>Не дам пропустить важное.</b> Что нового и какие встречи впереди.\n\n" +
    "Удобнее всего — в приложении: кнопка <b>Меню</b> слева внизу.\n\n",
  help: "<b>Как пользоваться</b>\n\n" +
    "🔎 <b>Спросить</b>\nПросто напиши вопрос сюда.\nВ группе: /ask <i>вопрос</i> — отвечу из этой группы.\n\n" +
    "🤝 <b>Найти человека</b>\n/intro <i>что нужно</i> — найду, кто поможет\n/help <i>что нужно</i> — попросить помощи у команды сообщества\n/requests — твои запросы\n\n" +
    "📅 <b>Быть в курсе</b>\n/catchup — что нового\n/events — ближайшие встречи\n/digest on — сводка раз в день\n\n" +
    "🙂 <b>О тебе</b>\n/profile — настройки\n/skills — что ты умеешь\n/optin — разрешить находить тебя как эксперта\n/language en — English\n\n" +
    "🔒 <b>Приватность</b>\n/privacy — что я храню\n/forget_me — удалить всё о тебе",
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
  whereMember: "💡 <b>Где что работает</b>\n" +
    "Здесь, в личке, — всё.\n" +
    "В группе — только /ask <i>вопрос</i> (отвечу из этой группы) и /forget ответом на своё сообщение, чтобы его удалить.",
  whereOwner: "\n\n🛠 <b>Для владельца</b>\n" +
    "Здесь: /status — всё ли в порядке, /desk — твой пульт: просьбы о помощи, /sources — подключённые группы.\n" +
    "В группе, где ты админ: /enable — подключить, /disable — отключить, /welcome — приветствие новичков, /hints — подсказки, /routing — спрашивать знающих, если ответа нет.",
  adminGuide: (title: string) =>
    `✅ <b>«${title}» подключена.</b> Это видишь только ты.\n\n` +
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
    `👋 Привет! Я помощник сообщества <b>${title}</b>.\n\n` +
    "Я помогу тебе ориентироваться в этом сообществе и найти любую информацию, которая когда-то обсуждалась. А если потребуется — найду человека, который знает ответ на твой вопрос.\n\n" +
    "Просто напиши мне вопрос — или нажми <b>Меню</b> слева внизу, чтобы открыть приложение. Все команды — /help.",
  welcomeGroup: (name: string) =>
    `👋 ${name}, добро пожаловать! Я помогу найти любую информацию, которая здесь когда-то обсуждалась, а если потребуется — человека, который знает ответ. Создай личный чат со мной, чтобы начать.`,
  welcomeButton: "Начать",
  connected: () =>
    "✨ Я подключился к этой группе. Теперь любой участник может спросить меня о том, что здесь обсуждали, — /ask прямо здесь или в личке. " +
    "Чтобы искать, я сохраняю сообщения группы: как именно — /privacy в личке со мной, удалить свои данные — /forget_me.",
  guideInGroup: (name: string) => `${name}, настройки и кнопка для загрузки старых сообщений ждут тебя у меня в личке.`,
  guideButton: "⚙️ Открыть настройки",
  askToConnect: "👋 Привет! Я помогаю найти всё, что здесь когда-либо обсуждали, — и человека, который знает ответ. Чтобы начать, админ группы нажимает кнопку.",
  connectButton: "✨ Подключить",
  onlyAdminsConnect: "Подключить меня может только админ группы.",
  whereGroupAdmin: "\n\n🛠 <b>Ведёшь сообщество?</b>\nДобавь меня в свою группу — это вся настройка.",
  historyOffer: (button: boolean) =>
    "\n\n📜 <b>Старые сообщения</b>\nСейчас я знаю только то, что напишут начиная с сегодня. " +
    (button ? "Нажми кнопку ниже — и я загружу прошлые сообщения группы. Это займёт несколько секунд, остальное я сделаю сам в фоне." : "Чтобы я загрузил и прошлые сообщения группы, открой приложение → Пульт → История."),
  historyButton: "📜 Загрузить старые сообщения",
  historyAuto: "\n\n📜 <b>Старые сообщения</b>\nЗагружаю прошлые сообщения группы сам — через твой Telegram MCP-сервер. Напишу, когда всё можно будет найти.",
  historyMcpFailed: (title: string, button: boolean) =>
    `📜 Не получилось прочитать историю <b>${title}</b> через твой Telegram MCP-сервер (10 минут подряд ошибки). Проверь ключ и что сервер работает. ` +
    (button ? "Или загрузи её из приложения кнопкой ниже." : "Или загрузи её из приложения → Пульт → История."),
  historyRemind: (title: string, read: number, button: boolean) =>
    `📜 Чтение истории <b>${title}</b> остановилось раньше начала чата (прочитано ${read} сообщений). ` +
    (button ? "Нажми кнопку, чтобы дочитать, — это займёт несколько секунд." : "Открой приложение → Пульт → История, чтобы дочитать, — это займёт несколько секунд."),
  historyDone: (title: string, n: number) => `✅ История <b>${title}</b> загружена: ${n} прошлых сообщений теперь можно найти.`,
  welcomeUsage: "Использование: /welcome on или /welcome off (владелец, в подключённой группе).",
  welcomeOn: "Приветствие <b>включено</b>: новые участники получат от меня короткое интро — лично, когда Telegram это позволяет.",
  welcomeOff: "Приветствие в этой группе <b>выключено</b>.",
  disabled: "Миндальная связь больше не сохраняет этот чат. Уже сохранённые сообщения исключены из всех ответов.",
  retentionUsage: "Использование: /retention &lt;дни 1..3650&gt; — удалять старые сообщения, или /retention 0 — хранить всю историю.",
  retentionKeepAll: "История будет храниться полностью. Ничего не удаляется автоматически.",
  retentionSet: (days: number) => `Срок хранения: ${days} дн. Более старые сообщения удаляются ежедневно.`,
  removed: "Удалено из «Миндальной связи».",
  nothingStored: "Для этого сообщения ничего не сохранено.",
  hintsUsage: "Использование: /hints on или /hints off (владелец, в подключённой группе).",
  hintsOn: "Подсказки <b>включены</b>: если кто-то задаст вопрос, на который в группе уже отвечали, я один раз отвечу ссылкой на прошлый ответ.",
  hintsOff: "Подсказки выключены.",
  hint: (link: string) => `💡 Похоже, здесь уже отвечали на это: ${link}`,
  earlierAnswer: "прошлое обсуждение",

  askUsage: "Напиши вопрос после <code>/ask</code> — или просто отправь его мне в личку.",
  aiNote: "Кратко от ИИ — сверься с источниками ниже.",
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
  introInvite: (labels: string, need: string, why: string) =>
    `<b>Запрос на знакомство</b>\nУчастнику сообщества нужна помощь: <i>${labels}</i>\n\n<blockquote>${need}</blockquote>\n` +
    (why ? `${why}\n` : "") +
    "Вы останетесь анонимны, пока не примете запрос <b>и</b> автор не подтвердит. Приглашение действует 72 часа.",
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
  routingOn: "Спрашивание знающих <b>включено</b>: вопросы без ответа через 4 часа приватно отправляются максимум 2 экспертам, которые согласились и могут читать эту группу.",
  routingOff: "Спрашивание знающих выключено.",
  routePing: (labels: string, snippet: string, link: string) =>
    `<b>Вопрос в вашей группе ждёт ответа</b> (<i>${labels}</i>):\n<blockquote>${snippet}</blockquote>\n${link}\n\nВы получили это, потому что согласились быть экспертом. Отключить: /pings off`,
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
  bAddSkill: "Добавить навык",
  bNoThanks: "Нет, спасибо",
  suggestAdded: "Добавлено в ваши навыки.",
  suggestDismissed: "Хорошо, больше не предложу.",
  eventsTitle: "<b>Ближайшие события</b>",
  eventsNone: "В ваших группах не найдено предстоящих событий.",
  eventsIcs: "Файл календаря с этими событиями:",
  eventHidden: "Скрыто из /events.",
  appButton: "Открыть приложение",
  // «Нить»: живая карточка запроса (одно сообщение, которое правится на месте)
  memberAnon: "Участник",
  threadSearching: "🔍 Ищу в памяти клуба…",
  threadMemoryHead: "💡 Нашёл в памяти клуба",
  threadMemoryAsk: "Это то, что нужно?",
  threadNothing: "В памяти клуба пока ничего нет. Спросить тех, кто в этом разбирается?",
  threadAsking: (n: number) => `🙋 Спросил ${n} чел., которые в этом разбираются. Напишу сюда, как только кто-то откликнется.`,
  threadNoMatch: "Пока никто подходящий не взялся. Я продолжу искать и напишу сюда.",
  threadCancelled: "Запрос отменён.",
  threadExpired: "Срок запроса истёк. Можно спросить ещё раз.",
  threadCandidate: (who: string) => `🤝 ${who} готов помочь. Подтверди, чтобы открыть контакты.`,
  threadConnected: "🤝 Вы на связи. Контакты открыты.",
  threadFollowup: "Помогло? Выбери, как вышло.",
  threadFollowupAsk: "Ну что, помогло? Выбери, как вышло, — это секунда.",
  threadClosed: (label: string) => `✅ Итог: ${label}`,
  threadThanked: "🙏 Спасибо отправлено.",
  threadStopped: "Этот запрос закрыт.",
  threadSolvedToast: "Рад, что помогло!",
  threadNotThatToast: "Спасибо, учту.",
  threadThanksSent: "Спасибо отправлено.",
  thanksReceived: (q: string, n: number) => `🙏 Тебя поблагодарили за помощь с вопросом «${q}». Ты уже помог ${n} людям.`,
  outcomeContactLabel: "получил контакт",
  outcomeAdviceLabel: "дали совет",
  outcomeSolvedLabel: "решил задачу",
  bOutcomeContact: "📇 Получил контакт",
  bOutcomeAdvice: "💬 Дали совет",
  bOutcomeSolved: "✅ Решил задачу",
  bThatsIt: "✅ Это то, что нужно",
  bAskPeople: "🙋 Спросить людей",
  bNotThat: "👎 Не то",
  bThanks: "🙏 Спасибо",
  bCancelAsk: "✖ Отменить запрос",
  bOpenPrivately: "💬 Открыть в личке",
  threadGroupFound: (n: number) => `💡 Нашёл ответов в памяти клуба: ${n}. Отправил тебе в личку.`,
  threadGroupNothing: "🔍 В памяти пока пусто. Следующие шаги отправил тебе в личку.",
  // Wow moment после загрузки истории, и вопросы без ответа
  wowTopics: "О чём говорит ваше сообщество",
  wowHelpers: "Кто помогает чаще всех",
  wowForgotten: (n: number) => `Я нашёл ${n} вопросов, на которые никто не ответил`,
  wowNoneForgotten: "На все вопросы нашлись ответы. Здорово!",
  wowForgottenHead: "Вопросы без ответа. Нажми на один — я поищу ответ.",
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
  nameOn: "Теперь в ответах будет видно твоё имя.",
  nameOff: "Имя скрыто: ты снова участник в толпе 🙂",
  bNameOn: "🪪 Показывать моё имя",
  bNameOff: "🪪 Скрыть моё имя",
  nameUsage: "Напиши <code>/name on</code>, чтобы в ответах видели твоё имя, или <code>/name off</code>, чтобы скрыть.",
  // Сторона эксперта (путь 4): почему ты, паузы, тихие часы, слова благодарности
  introWhy: (label: string, n: number) => `Почему вам: вы отвечали про «${label}» ${n} раз.`,
  pauseSuggest: "Ты дважды подряд ответил «Не сейчас». Поставить паузу? Запросы перестанут приходить, пока ты сам не включишь их снова.",
  bKeepOn: "Оставить как есть",
  pQuiet: "Тихие часы",
  bQuietOn: "🌙 Тихо с 22:00 до 08:00",
  bQuietOff: "🌙 Выключить тихие часы",
  pHelped: (n: number) => `Ты помог ${n} людям`,
  thanksAsk: "Напиши пару слов для него — он их увидит. Или нажми «Без слов».",
  bNoWords: "Без слов, просто спасибо",
  thanksWithWords: (q: string, words: string, n: number) => `🙏 Тебя поблагодарили за помощь с вопросом «${q}»: «${words}». Ты уже помог ${n} людям.`,
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
  unionNoClub: "Сначала подключи бота к своей группе — тогда у твоего клуба будет место в Союзе.",
  unionSame: "Это твой собственный клуб.",
  unionExists: "Союз с этим клубом уже есть.",
  unionAccepted: (partner: string, level: string) => `🌉 «${partner}» принял Союз (${level}).`,
  unionJoined: (inviter: string, level: string) => `🌉 Союз с «${inviter}» открыт (${level}). Запросы идут в обе стороны.`,
  unionNotice: (status: string): string => (status === "paused" ? "🌉 Союз на паузе. Ничего не перетекает, пока его не включат снова." : status === "ended" ? "🌉 Союз завершён. Ничего больше не перетекает." : "🌉 Союз снова работает."),
  unionTitle: "<b>🌉 Союзы</b>",
  unionNone: "Союзов пока нет. Пригласи клуб-партнёр: выбери свой клуб и что перетекает.",
  unionPickClub: "Какой из твоих клубов приглашает?",
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
  bridgeConfirm: "Спросить клубы-партнёры? Они увидят только текст твоего запроса — не твоё имя и не контакт. Контакт откроется, только если ты и помощник оба согласны.",
  bBridgeGo: "🌉 Спросить клубы-партнёры",
  bBridge: "🌉 Спросить клубы-партнёры",
  bridgeNone: "Пока нет клубов-партнёров, у которых можно спросить.",
  bridgeAsk: (from: string, q: string) => `🌉 Запрос из клуба-партнёра «${from}»:\n<blockquote>${q}</blockquote>\nКто может ответить, может сказать об этом.`,
  bridgeHelp: (to: string) => `🤝 Помощь пришла из «${to}». Открыть контакт?`,
  bOpenContact: "🤝 Открыть контакт",
  bridgeConnected: (to: string) => `🤝 Ты на связи через «${to}». Контакт помощника ниже.`,
  bridgeConnectedHelper: "🤝 Автор запроса подтвердил. Его контакт ниже.",
  bridgeThanksHelper: "Спасибо. Автор увидит, что ты можешь помочь, и вы свяжетесь, если он тоже согласится.",
  bridgeGone: "Этот запрос уже не открыт.",
  bridgeTaken: "Кто-то из того клуба уже взялся.",
  bridgeStatusOpen: "открыт",
  bridgeStatusHelper: "помощь найдена",
  bridgeStatusConnected: "на связи",
  bridgeStatusClosed: "закрыт",
  bridgeStatusExpired: "без ответа",
  threadBridgeOpen: (to: string) => `🌉 Спросил в «${to}». Напишу сюда, как только там откликнутся.`,
  threadBridgeConnected: (to: string) => `🤝 Ты на связи через «${to}». Помогло?`,
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
  glavNeed: "📌 Ждёт тебя",
  glavOwnQ: "❓ Твой вопрос без ответа",
  glavPay: "💸 Деньги и сроки",
  glavMeet: "🗓 Встречи и решения",
  glavTalk: "💬 О чём говорил клуб",
  glavQuiet: "Сегодня тихо. Ничего не требует твоего внимания ✨",
  bDone: "✓ Готово",
  // Знакомство с новичком (путь 2)
  onbQuestions: "Здесь часто спрашивают про:",
  onbPick: "Чем можешь помочь другим? Или что ищешь? Нажми одно или пропусти.",
  onbPrivacy: "Что я храню: сообщения этой группы, пока она подключена.\nУдалить всё: /forget_me.",
  bSkip: "Пропустить",
  onbSaved: (label: string) => `Записал: ${label}. Если кому-то это понадобится, я дам знать.`,
  onbMatch: (label: string) => `Здесь есть человек, который хорошо разбирается в «${label}». Спросить его? Знакомство — только если он согласится.`,
  bAskThem: "🙋 Спросить",
};

export const MESSAGES: Record<Lang, Messages> = { en: EN, ru: RU };
export const T = (lang: Lang): Messages => MESSAGES[lang];
