# Миндальная связь: the product plan

Brings together the landing page (telepathy-landing), the map of 18 community and networking
platforms, reviewer feedback, and what's already in this repository. It is a priority order, not
a schedule.

## The idea in one line

**Every question gets an answer: from your community's memory, from its people, or from a
partner club. And everyone sees it happen.**

Today chats swallow questions, knowledge disappears into the scroll, and help depends on whether
the organiser happened to see a message. Миндальная связь turns a community into something that
**remembers everything, knows who to ask, and closes the loop**. It lives inside Telegram, where
people already are, and nobody has to move anywhere.

The landing page's three foundations ("сохранять своих, помогать больше, оставаться
независимыми") stay. The order changes: **help first** (it happens every day), **memory second**
(that's what makes help possible), **independence third** (the guarantee underneath).

## Five design laws

These apply to every screen and message.

1. **Silence is the default.** The bot speaks only when it is useful. In groups, no unprompted
   message unless it saves someone time.
2. **One message that lives.** A process never sends a stream of messages. One card is edited in
   place as things progress, like a parcel tracker that is alive. *This is the signature
   interaction of the whole product.*
3. **Talk, not commands.** Text and buttons are the interface. Commands remain for people who
   already know them, but nobody needs to learn them. A reaction is a button: ⭐ means "best
   answer", 🙏 means "thank you".
4. **Show people, not documents.** An answer from memory is a quote with a face, a name and a
   date: "Анна объясняла это в марте". People are the main asset, so the interface shows people.
5. **Every step ends with an obvious next one.** No dead ends, no "Ошибка", no "Ничего не
   найдено". Every failure becomes a suggestion.

**Feel.** Paper, ink and lime accents from the landing page, inside the Telegram theme with dark
mode. Spring physics, haptics at every state change, skeleton shimmer instead of spinners.
Element transitions: a request card in the list grows smoothly into its thread. The AI summary is
"written" live. Everything is reachable with one thumb.

## The main mechanism: «Нить» (the request thread)

Nearly everything below is built around it. A thread is a living card (a message in the bot, a
screen in the app) that goes through these states.

| State | What the person sees |
|---|---|
| 🔍 **Ищу** | "Ищу в памяти клуба…" with the typing indicator. Under a second later, the card has already started filling in. |
| 💡 **Нашёл в памяти** | A one-line summary, plus 2–3 quotes with faces, names and dates, and buttons **Это то, что нужно** / **Спросить людей** |
| 🙋 **Спрашиваю своих** | "Спросил 2 человека, которые в этом разбираются" with soft avatars, without revealing names until they agree |
| 🌉 **Мост** | "В клубе нет нужного эксперта. Спросить в клубах-партнёрах?" Partner clubs see only the request text, never the person. |
| 🤝 **Знакомство** | "Анна из «Клуба основателей» готова помочь." Contact details are opened only after both sides agree. |
| ✅ **Итог** | A few days later: "Помогло?" with three levels: **Получил контакт** · **Дали совет** · **Решил задачу** |
| 🙏 **Спасибо** | One tap: the helper gets a personal thank-you card, and with consent a short thank-you appears in the group |

**Under the hood** this is the existing missions (`worker/src/assist/missions.ts`), routing
(`worker/src/features.ts`), introductions with mutual consent (`worker/src/intros.ts`), federation
(`worker/src/federation/`), partner exchanges and the ledger (`worker/src/assist/ledger.ts`). The thread is one
unified face over them, so each person sees one story instead of four features.

## Step by step: every journey

### 1. A club owner connects the bot ("it just started working")

1. The owner adds the bot to the group. That is all the setup there is. *(Built: `worker/src/connect.ts`.)*
2. Two lines appear in the group: what the bot does, and how to delete your data. Nothing more.
3. The owner gets a private card: **"Хочешь, я прочитаю историю группы? Это займёт секунды."**
   with one button.
4. They tap it, sign in with their own Telegram, and a progress ring fills: "4 312 сообщений · 9
   секунд". *(Built: `worker/history/`, `worker/src/history.ts`.)*
5. **The wow moment.** A single card appears:
   - **"Вот что знает ваше сообщество":** the 5 main topics as chips;
   - **"Кто помогает чаще всех":** 3 faces;
   - **"Я нашёл 12 вопросов, на которые никто не ответил"** with a **Посмотреть** button.

   The owner gets value from data they already had, before doing anything.
6. Underneath is **⚙️ Настройки**: one card of toggles in plain language (greet newcomers ·
   suggest answers · ask the people who know · how long to keep messages). No commands.
7. If the owner taps on the forgotten questions, each becomes a thread the bot tries to close
   itself: from memory, then from people. Old debts become first wins.

### 2. A newcomer joins

1. The newcomer gets a private message (or a group greeting that deletes itself): one warm line
   plus **"Здесь чаще всего спрашивают про…"** with 3 tappable real questions from this group.
2. One question: **"Чем можешь помочь другим? / Что ищешь?"** with chips taken from the club's
   topics, and a skip option.
3. If someone shares an interest or a need: "Анна тоже дизайнер и ищет команду. Познакомить?"
   This is shown only when both have agreed to be discoverable, and only within the same club.

### 3. A member asks a question

1. **Privately:** they just type. **In a group:** they @mention the bot or reply to it.
2. A thread is created (see «Нить»). In a group the bot answers briefly and offers
   **Подробнее** as a link to a private chat. The group stays quiet.
3. If the answer helped: 👍 is the end, and that answer gets ranked higher next time.
4. If not: **Спросить людей.** One tap, and the thread moves to the next state.
5. If the same question is asked again in the group, the bot replies to it with a single line and
   a link to the best answer. Moderators no longer repeat themselves.

### 4. An expert receives a request ("help is respected, not exploited")

1. A short card: the request without the person's name, why the expert was chosen ("вы отвечали
   про налоги 6 раз"), and **Помогу** / **Не сейчас**.
2. **Не сейчас** carries no penalty and no explanation. After two refusals in a row the bot gently
   suggests **"Поставить паузу?"**
3. An availability switch in the profile, a cap on requests per week, quiet hours.
4. After helping, a thank-you card (with the asker's personal words if they wrote any), plus a
   quiet "Вы помогли 7 людям" in the profile.
5. For paid consultations (the paid mode already exists): a price on the expert's offer, shown
   before the introduction is made.

### 5. Two clubs connect into a «Союз» (an alliance)

1. In Пульт: **Пригласить клуб-партнёр** creates a link.
2. The other owner taps it and sees a card: who is inviting, how many members, the main topics,
   and what will cross between the clubs.
3. **What crosses** is chosen with a single three-step slider:
   - **Только запросы:** anonymous request text;
   - **Запросы и эксперты:** experts are visible as roles, not names;
   - **Полный мост:** the expert directory, where the experts themselves have agreed.
4. **Accept.** Both clubs see each other in Пульт as a new star in their «Созвездие».
5. Each club can pause or end the alliance at any moment with one tap.

### 6. A request crosses to a partner club

1. The thread offers **Спросить в клубах-партнёрах** and explains what will be shown: only the
   request text.
2. The request goes as an "envelope" (the existing federation mechanism). The partner club sees
   it in its own Пульт, or an expert who matches gets it directly if their club allows that.
3. **Помогу** → the asker agrees → contacts open. The thread shows: "Помощь пришла из «Клуба
   основателей»".
4. **The outcome credits both clubs** (the ledger already exists): "мы помогли 5 участникам
   партнёров, нам помогли 3 раза". Cooperation strengthens each club instead of drawing members
   away.

### 7. «Главное»: what needs my attention

The answer to the parent-chat feedback, built inside clubs first.

1. Once a day, at a time the person chooses, one card instead of hundreds of messages:
   - 📌 what concerns you: you were mentioned, asked a question, or have a deadline;
   - 💸 payments and fees, with an amount and a deadline;
   - 🗓 meetings and decisions taken;
   - 💬 what the group discussed, in three lines with links.
2. **Done** buttons next to the items. The card gets shorter as you go, and finishing it feels
   good.
3. If nothing needs you: **"Сегодня тихо. Ничего не требует твоего внимания ✨"**. The bot
   doesn't invent a reason to write.

### 8. Gatherings: before, during, after

1. The bot already detects events in messages. Add **Иду / Не иду** right on the event card,
   plus a reminder.
2. Before the gathering: **"Кто будет"**, with 3 people worth meeting and the reason why.
3. After it: **"Кого хотите увидеть снова?"** Contacts open only where the interest is mutual, so
   nobody learns about one-sided interest.
4. A recording or the materials attached to the event become part of the memory.

### 9. «Пульс»: the owner's weekly summary

1. On Monday the owner gets **one beautiful card as an image**: "14 вопросов · 11 решено ·
   среднее время ответа 2 ч · Анна помогла 4 раза · 3 вопроса ждут".
2. **Поделиться с группой** with one tap posts a celebratory version without private details,
   which recognises the people who helped and makes the club look alive.
3. Inside Пульт:
   - open and stuck requests;
   - time to first useful reply;
   - outcomes at all three levels;
   - expert load;
   - what members ask about that nobody in the club knows (gaps, already detected in
     `worker/src/assist/gaps.ts`). This doubles as a signal for which experts to invite.

### 10. «Ковчег»: independence as a guarantee, not a sales pitch

1. In Пульт: a quiet line **"Ковчег: ваше сообщество в безопасности"** with the date of the last
   copy. *(The continuity and Hydra mechanisms are already built: `docs/CONTINUITY.md`,
   `docs/HYDRA.md`.)*
2. **Забрать всё** gives the community's memory, members (with their consent), threads and
   outcomes in an open format.
3. **If the chat platform blocks you or you move:** members already have a way to stay in touch
   outside Telegram (the passport and portal). The owner taps **Позвать всех** and everyone gets
   the new address through every channel they have.
4. Members always have **"Что бот знает обо мне"**, with delete buttons for each part.

### 11. Your agent and the community

1. Through MCP and `/a2a` (the endpoint already exists), a member's personal AI assistant can ask
   the community on their behalf, with that member's permission.
2. Every action that matters, such as an introduction or sharing a contact, needs a person's
   confirmation. An agent only proposes.

### 12. The pilot: concierge in Пульт

1. The operator's desk becomes the manual routing console across 2–3 partner clubs: anything
   automation can't handle is routed by a person.
2. Every eligible request is recorded, including failures, so nothing inflates the numbers.
3. At the end of the pilot, each owner gets a «Пульс» for the period plus a single question:
   **"Продолжаем?"** That is the real test of willingness to pay.

## The Mini App: three spaces

| Tab | What's in it |
|---|---|
| **Спросить** | A search field that goes straight into a thread. Below it, live hints from the club's topics and recent good answers. Below that, **«Созвездие»**: the club as a living map of topics and people. Tap a topic to see what the club knows about it and who knows it. |
| **Нити** | My requests, requests I've been asked to help with, introductions. Each one is a living card with its status. |
| **Я** | My profile (what I can help with, what I'm looking for), «Главное», privacy («Что бот знает обо мне»), «Ковчег», and **Пульт** for admins. |

- **Several clubs:** a row of club chips at the top, with each club's own avatar and name in the
  header.
- **Motion:** a card in the list grows into its thread, status changes animate with springs and a
  light haptic, the AI summary types in live, and the thank-you card arrives as a small confetti
  burst of almonds 🌰.

## Language

Warm, short, "ты". Features are named after what they do for people:

| Was | Becomes |
|---|---|
| mission, desk | **Нить**, **Пульт** |
| routing | **Спросить знающих** |
| federation, partner | **Мост**, **Союз** |
| canonical | **Лучший ответ** |
| hints | **Подсказки** |
| continuity, hydra | **Ковчег** |
| visibility codes | *(hidden entirely)* |

## The landing page

- **First screen:** «Ваш клуб не обязан знать всё. Он должен знать, где найти помощь.» with the
  button **"Подключить за 1 касание"**, which leads straight to adding the bot.
- **Next:** a live demo of a thread: a card going through all the states on its own.
- **Then:** «Пульс» as proof, then «Союз» clubs, then «Ковчег» as the guarantee.
- **Fix the encoding:** one heading in the copied landing text («Изменения правил») arrived
  corrupted, which reviewers also noticed. The page lives in `telepathy-landing`, so it is fixed there.

## Build order (by priority)

1. **Нить and memory:**
   - the living card;
   - the answer card with faces;
   - **Спросить людей**;
   - the three-level outcome and 🙏;
   - the quiet rule for groups;
   - the settings card;
   - the new vocabulary;
   - the wow moment after history loads, including forgotten questions;
   - recording pilot metrics.
2. **The expert's side and «Пульс»:** request cards, availability, the cap, thank-you cards, the
   weekly summary as an image with "поделиться", and Пульт for owners.
3. **«Союз» and «Мост»:** invite links between clubs, the sharing slider, envelopes into partner
   clubs, two-sided credit, and the pilot console.
4. **The three-tab Mini App:** «Созвездие», threads, club chips, the Telegram theme, the motion
   system.
5. **«Главное»** and newcomer onboarding (questions as chips, introductions by shared interest).
6. **Gatherings:** "иду", "кто будет", mutual "хочу продолжить".
7. **«Ковчег» as a visible feature,** "Что бот знает обо мне", "Позвать всех".
8. **Later, when there is demand:** club subscriptions and paid consultations, MAX as a second
   channel, personal agents through MCP and `/a2a`.

**Not doing:** tokens and NFT access, crypto, XP and gamification, courses, a website builder,
replacing the chat, or a separate parent-chat product.

## Success is measured by outcomes

- **Leading indicators:** share of questions answered from memory · share of «Спросить людей»
  that end in a helpful reply · time to first useful answer · verified "Решил задачу" · expert
  response rate and load · partner club response rate · Пульс shares to groups · paid
  "Продолжаем?" decisions.
- **Later:** renewals, over membership cycles.

## Guardrails

- Clubs exchange requests, not member lists.
- Contacts are opened only with both sides' agreement.
- An expert can always say "не сейчас", and the bot never retaliates.
- Each club can pause or end an alliance at any moment with one tap.
- Every step across clubs is visible to the member and can be withdrawn.
- An agent proposes and a person decides.
- A newcomer is told in two lines what is stored and how to delete it.

## Status: what is built

The build order below is the plan. This section records what the repository does now, with the
code that does it. Each build step is one commit on this branch, with its tests.

| Step | Built | Where |
|---|---|---|
| 1. «Нить» and memory | The living card, answers with faces and months, «Спросить людей», three outcomes and 🙏, the quiet group rule, the settings card, the vocabulary, the wow card after an import with forgotten questions, `/pilot` | `worker/src/thread.ts`, `thread-card.ts`, `group-settings.ts`, `wow.ts` |
| 2. Expert side and «Пульс» | Why-you on invites, «Не сейчас» without penalty and a pause after two in a row, quiet hours, thank-you words, the Monday summary with share, `/pulse` | `intros.ts`, `pulse.ts`, `thread.ts` |
| 3. «Союз» and «Мост» | Invitations with the sharing level, pause/resume/end, bridged requests (text only), contacts on both yes, two-sided credit, operator `/bridges` | `alliance.ts` |
| 4. Three-tab Mini App | Спросить, Нити (the bot's own cards, pressed through the same handler), «Созвездие», club chips, Telegram theme, motion | `app-page.ts`, `app.ts` |
| 5. «Главное» and onboarding | The daily card with Done, the quiet day, newcomer questions and topics, a consent-based offer to ask | `glavnoe.ts`, `welcome.ts` |
| 6. Gatherings | «Иду», «Не иду», who's going with reasons, the reminder, the mutual "keep in touch" | `gather.ts` |
| 7. «Ковчег» | The status line from the daily copy, take everything, call everyone, «Что бот знает обо мне» | `ark.ts` |

### Not built, and why

- **Step 8, later when there is demand** (club subscriptions, MAX, personal agents over MCP and
  `/a2a`): the plan defers it, so it is not started. Paid consultations already exist in the
  capacity offers.
- **«Пульс» as an image:** the Worker has no raster library. The Monday card is text, and the
  Mini App draws the same numbers. Adding an image needs a rasteriser dependency, decided separately.
- **The AI summary typing in live:** the summary appears with its card. Live typing is a motion
  detail that is not built.
- **Telegram's group repeat hint** (a single line and a link to the best answer for a repeated
  question): the existing `/hints` covers it, still off by default.
- **The landing page** lives in `telepathy-landing`, not in this repository, so it is not changed here.
- **«Позвать всех»** sends Telegram messages only. There is no email path in this step.

### Before this release reaches production

Run `npm run db:migrate:remote`, which applies migrations 0016 to 0020. The new cron steps
(`thread_followup`, `pulse`, `bridges_expired`, `gather_remind`, `gather_after`) need nothing else.
Copies (the Ковчег line) appear once the existing escrow is configured.
