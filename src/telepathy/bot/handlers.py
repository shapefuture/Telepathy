"""Telegram handlers (P03, P06, P08, P09, P11-07).

Rules enforced here:
  * group messages are ingested only for chats an owner explicitly enabled
  * member features are answered only in private chat, using the verified Telegram ID
  * the bot never replies in groups except to owner admin commands
"""

from __future__ import annotations

import html
import json
import logging
import sqlite3
import time as _time
from collections import defaultdict, deque
from typing import Any

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType, ParseMode
from aiogram.filters import Command, CommandObject
from aiogram.types import (
    CallbackQuery,
    ChatMemberUpdated,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LinkPreviewOptions,
    Message,
)

from telepathy.config import Settings
from telepathy.domain.experts import match_skills, resolve_skill, taxonomy
from telepathy.domain.types import Role, Visibility, utcnow
from telepathy.ingest import documents
from telepathy.ingest.normalize import citation_uri, normalize_message
from telepathy.ingest.service import (
    IngestOutcome,
    disable_source,
    enable_source,
    get_enabled_source,
    ingest,
    message_row_id,
    remove_message,
)
from telepathy.ops.status import collect_status
from telepathy.retrieval.answer import answer, render_html
from telepathy.services import data_rights, intros
from telepathy.storage import acl, experts, jobs, outbox
from telepathy.storage.db import audit

log = logging.getLogger(__name__)
router = Router(name="telepathy")

GROUP_TYPES = {ChatType.GROUP, ChatType.SUPERGROUP}
PRIVATE = F.chat.type == ChatType.PRIVATE
IN_GROUP = F.chat.type.in_(GROUP_TYPES)
NO_PREVIEW = LinkPreviewOptions(is_disabled=True)
HTML = ParseMode.HTML

PRIVACY_NOTICE = (
    "<b>Telepathy privacy notice</b>\n"
    "• Only groups an owner explicitly enabled are stored. Each group shows a notice.\n"
    "• Your name, username and phone number are not stored; you get a random internal ID.\n"
    "• Answers quote messages verbatim with a link, only from groups you can read.\n"
    "• Nothing is sent to external AI services.\n"
    "• You are not discoverable as an expert unless you run /optin yourself.\n"
    "• Introductions need both people to agree before any contact is shared.\n"
    "• /forget_me deletes your stored messages and profile and stops collection.\n"
    "• Messages are deleted automatically after the retention period."
)
HELP = (
    "<b>Search</b>\n/ask <i>question</i> — cited answers from your groups\n\n"
    "<b>Experts &amp; introductions</b>\n"
    "/intro <i>what you need</i> — ask for a consent-based introduction\n"
    "/expert <i>topic</i> — how many opted-in experts match\n"
    "/requests — your open requests\n\n"
    "<b>Your profile</b>\n/profile — view and change settings\n"
    "/optin · /optout — expert discoverability\n"
    "/skills — list yours · /skills add <i>skill</i> · /skills remove <i>skill</i>\n"
    "/skills all — the skill list\n\n"
    "<b>Your data</b>\n/privacy · /forget_me · /resume_collection"
)
ENABLED_NOTICE = (
    "Telepathy is now <b>collecting</b> this chat (visibility: {vis}, retention: {days} days). "
    "Members can search it privately via /ask in a DM with the bot. "
    "DM the bot /privacy for details or /forget_me to delete your data."
)


class RateLimiter:
    """Per-user sliding window, in memory (resets on restart, which is fine)."""

    def __init__(self) -> None:
        self.hits: dict[int, deque[float]] = defaultdict(deque)

    def allow(self, user_id: int, per_minute: int) -> bool:
        now = _time.monotonic()
        q = self.hits[user_id]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= per_minute:
            return False
        q.append(now)
        return True


limiter = RateLimiter()


def _kb(rows: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows
        ]
    )


def _is_owner(settings: Settings, user_id: int | None) -> bool:
    return user_id is not None and user_id in settings.owner_telegram_ids


async def _is_chat_admin(message: Message) -> bool:
    if message.from_user is None or message.bot is None:
        return False
    cm = await message.bot.get_chat_member(message.chat.id, message.from_user.id)
    return cm.status in (ChatMemberStatus.CREATOR, ChatMemberStatus.ADMINISTRATOR)


def _owner_member_id(conn: sqlite3.Connection, settings: Settings, tg_id: int) -> str:
    mid = acl.upsert_member(conn, settings.community_id, tg_id)
    conn.execute("UPDATE members SET role=? WHERE id=?", (Role.OWNER.value, mid))
    return mid


async def _member(
    message: Message, conn: sqlite3.Connection, settings: Settings
) -> acl.Member | None:
    if message.from_user is None:
        return None
    m = acl.get_member_by_telegram(conn, settings.community_id, message.from_user.id)
    if m is None and _is_owner(settings, message.from_user.id):
        _owner_member_id(conn, settings, message.from_user.id)
        m = acl.get_member_by_telegram(conn, settings.community_id, message.from_user.id)
    if m is None or m.removed:
        await message.answer(
            "I don't know you yet. Post a message in an enabled community "
            "group first, then try again."
        )
        return None
    return m


async def _rate_ok(message: Message, settings: Settings) -> bool:
    assert message.from_user is not None
    if limiter.allow(message.from_user.id, settings.ask_rate_per_minute):
        return True
    await message.answer("Too many requests. Please wait a minute.")
    return False


# ---- Owner commands (groups) -------------------------------------------------------------


async def _owner_in_group(message: Message, settings: Settings) -> bool:
    # Two independent checks: configured community owner AND current chat admin.
    return _is_owner(
        settings, message.from_user.id if message.from_user else None
    ) and await _is_chat_admin(message)


@router.message(Command("enable"), IN_GROUP)
async def cmd_enable(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    if not await _owner_in_group(message, settings):
        return  # silent: do not advertise admin commands to non-owners
    arg = (command.args or Visibility.MEMBER_CONSENTED.value).strip().upper()
    try:
        vis = Visibility(arg)
    except ValueError:
        await message.reply(
            "Visibility must be one of: PUBLIC_APPROVED, MEMBER_CONSENTED, INTERNAL_RESTRICTED"
        )
        return
    if vis is Visibility.PRIVATE_UNKNOWN:
        await message.reply("PRIVATE_UNKNOWN sources cannot be enabled.")
        return
    assert message.from_user is not None
    owner_id = _owner_member_id(conn, settings, message.from_user.id)
    sid = enable_source(
        conn,
        settings.community_id,
        message.chat.id,
        visibility=vis,
        enabled_by_member_id=owner_id,
        title=message.chat.title,
        public_username=message.chat.username,
    )
    conn.execute("UPDATE sources SET retention_days=? WHERE id=?", (settings.retention_days, sid))
    await message.reply(
        ENABLED_NOTICE.format(vis=vis.value, days=settings.retention_days), parse_mode=HTML
    )


@router.message(Command("disable"), IN_GROUP)
async def cmd_disable(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    if not await _owner_in_group(message, settings):
        return
    assert message.from_user is not None
    owner_id = _owner_member_id(conn, settings, message.from_user.id)
    if disable_source(conn, settings.community_id, message.chat.id, actor_member_id=owner_id):
        await message.reply(
            "Telepathy stopped collecting this chat. Existing messages are "
            "excluded from all answers."
        )


@router.message(Command("retention"), IN_GROUP)
async def cmd_retention(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    if not await _owner_in_group(message, settings):
        return
    src = get_enabled_source(conn, settings.community_id, "telegram", message.chat.id)
    try:
        days = int((command.args or "").strip())
    except ValueError:
        days = 0
    if src is None or not 1 <= days <= 3650:
        await message.reply("Usage: /retention <days 1..3650> in an enabled chat.")
        return
    conn.execute("UPDATE sources SET retention_days=? WHERE id=?", (days, src.id))
    assert message.from_user is not None
    audit(
        conn,
        "source.retention",
        actor_member_id=_owner_member_id(conn, settings, message.from_user.id),
        subject=src.id,
        detail_json=json.dumps({"days": days}),
    )
    await message.reply(f"Retention set to {days} days. Older messages are purged nightly.")


@router.message(Command("forget"), IN_GROUP)
async def cmd_forget_message(
    message: Message, conn: sqlite3.Connection, settings: Settings
) -> None:
    """Reply to a message with /forget (owner) or to your own message (author)."""
    target = message.reply_to_message
    if target is None or message.from_user is None:
        return
    src = get_enabled_source(conn, settings.community_id, "telegram", message.chat.id)
    if src is None:
        return
    is_author = target.from_user is not None and target.from_user.id == message.from_user.id
    if not (is_author or await _owner_in_group(message, settings)):
        return
    actor = acl.get_member_by_telegram(conn, settings.community_id, message.from_user.id)
    ok = remove_message(
        conn,
        src.id,
        str(target.message_id),
        actor_member_id=actor.id if actor else None,
        reason="author_request" if is_author else "owner_request",
    )
    await message.reply("Removed from Telepathy." if ok else "Nothing stored for that message.")


# ---- General (private chat) --------------------------------------------------------------


@router.message(Command("start"), PRIVATE)
async def cmd_start(message: Message) -> None:
    await message.answer(
        "Hi! I search your community's enabled groups and answer with cited "
        "quotes, and I can introduce you to opted-in experts.\n\n" + HELP,
        parse_mode=HTML,
    )


@router.message(Command("help"), PRIVATE)
async def cmd_help(message: Message) -> None:
    await message.answer(HELP, parse_mode=HTML)


@router.message(Command("privacy"), PRIVATE)
async def cmd_privacy(message: Message) -> None:
    await message.answer(PRIVACY_NOTICE, parse_mode=HTML)


@router.message(Command("ask"), PRIVATE)
async def cmd_ask(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    if message.from_user is None or not await _rate_ok(message, settings):
        return
    # Identity comes from Telegram's signed update, never from the message text.
    ctx = acl.access_context(conn, settings.community_id, message.from_user.id)
    if ctx is None:
        await message.answer("I don't know you yet. Post in an enabled community group first.")
        return
    ans = answer(conn, ctx, command.args or "")
    await message.answer(
        render_html(ans, settings.timezone), parse_mode=HTML, link_preview_options=NO_PREVIEW
    )


@router.message(
    Command("ask", "intro", "expert", "profile", "optin", "skills", "forget_me"), IN_GROUP
)
async def cmd_private_only_in_group(message: Message) -> None:
    # Answering in a group could reveal restricted evidence or profile data.
    await message.reply("Please send that command to me in a private chat.")


# ---- Expert profile ----------------------------------------------------------------------


def _profile_text(p: experts.Profile) -> tuple[str, InlineKeyboardMarkup]:
    tax = taxonomy()
    skills = (
        ", ".join(
            f"{tax[c].en}{'' if st == 'confirmed' else ' (suggested)'}"
            for c, st in p.skills
            if c in tax
        )
        or "none yet"
    )
    text = (
        "<b>Your profile</b> (only you see this)\n"
        f"Discoverable as expert: <b>{'yes' if p.discoverable else 'no'}</b>\n"
        f"Available for introductions: <b>{'yes' if p.available else 'no'}</b>\n"
        f"Reminders: <b>{'on' if p.reminders else 'off'}</b>\n"
        f"Message collection: <b>{'stopped' if p.collection_opt_out else 'on'}</b>\n"
        f"Skills: {html.escape(skills)}\n\n"
        "Add skills with <code>/skills add accounting</code>."
    )
    kb = _kb(
        [
            [
                (
                    "Stop being discoverable" if p.discoverable else "Become discoverable",
                    f"p:disc:{0 if p.discoverable else 1}",
                )
            ],
            [
                (
                    "Pause introductions" if p.available else "Resume introductions",
                    f"p:avail:{0 if p.available else 1}",
                ),
                (
                    "Reminders off" if p.reminders else "Reminders on",
                    f"p:rem:{0 if p.reminders else 1}",
                ),
            ],
        ]
    )
    return text, kb


@router.message(Command("profile"), PRIVATE)
async def cmd_profile(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    text, kb = _profile_text(experts.get_profile(conn, m.id))
    await message.answer(text, parse_mode=HTML, reply_markup=kb)


@router.message(Command("optin"), PRIVATE)
async def cmd_optin(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    experts.set_discovery(conn, m.id, True, utcnow())
    await message.answer(
        "You're now discoverable for introductions <b>in the skills you list</b>. Nobody sees "
        "your identity unless you accept a specific request and the requester confirms.\n"
        "Add skills: <code>/skills add python</code> · undo anytime: /optout",
        parse_mode=HTML,
    )


@router.message(Command("optout"), PRIVATE)
async def cmd_optout(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    experts.set_discovery(conn, m.id, False, utcnow())
    await message.answer("You're no longer discoverable. Pending invitations stay answerable.")


@router.message(Command("skills"), PRIVATE)
async def cmd_skills(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    args = (command.args or "").strip()
    verb, _, rest = args.partition(" ")
    tax = taxonomy()
    if verb == "all":
        lines = [f"<code>{s.code}</code> {html.escape(s.label())}" for s in tax.values()]
        # Telegram caps messages at 4096 chars: send in pages.
        for i in range(0, len(lines), 35):
            head = "<b>Skills</b>\n" if i == 0 else ""
            await message.answer(head + "\n".join(lines[i : i + 35]), parse_mode=HTML)
        return
    if verb in ("add", "remove") and rest:
        code = resolve_skill(rest)
        if code is None:
            await message.answer("Unknown skill. See /skills all.")
            return
        if verb == "add":
            experts.add_skill(conn, m.id, code, utcnow())
            note = (
                ""
                if experts.get_profile(conn, m.id).discoverable
                else " You're not discoverable yet — run /optin when ready."
            )
            await message.answer(
                f"Added <b>{html.escape(tax[code].label())}</b>.{note}", parse_mode=HTML
            )
        else:
            ok = experts.remove_skill(conn, m.id, code, utcnow())
            await message.answer("Removed." if ok else "That skill wasn't on your profile.")
        return
    p = experts.get_profile(conn, m.id)
    listed = (
        "\n".join(
            f"• {html.escape(tax[c].label())}"
            for c, st in p.skills
            if st == "confirmed" and c in tax
        )
        or "none yet"
    )
    await message.answer(
        f"<b>Your skills</b>\n{listed}\n\n<code>/skills add …</code> · "
        "<code>/skills remove …</code> · /skills all",
        parse_mode=HTML,
    )


# ---- Expert search & introductions -------------------------------------------------------


@router.message(Command("expert"), PRIVATE)
async def cmd_expert(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    m = await _member(message, conn, settings)
    if m is None or not await _rate_ok(message, settings):
        return
    codes = match_skills(command.args or "")
    if not codes:
        await message.answer(
            "Tell me a topic, e.g. <code>/expert tax advice</code> (see /skills all).",
            parse_mode=HTML,
        )
        return
    n = len(experts.eligible_candidates(conn, settings.community_id, m.id, codes, utcnow()))
    labels = ", ".join(taxonomy()[c].en for c in codes)
    # Identities are never listed: discovery happens only through consented intros.
    await message.answer(
        f"<b>{n}</b> opted-in, available member(s) match <i>{html.escape(labels)}</i>.\n"
        + (
            "Use <code>/intro …</code> to request an introduction."
            if n
            else "Try a broader topic, or ask in the community."
        ),
        parse_mode=HTML,
    )


@router.message(Command("intro"), PRIVATE)
async def cmd_intro(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    m = await _member(message, conn, settings)
    if m is None or not await _rate_ok(message, settings):
        return
    text = (command.args or "").strip()
    if len(text) < 10:
        await message.answer(
            "Describe what you need in a sentence, e.g.\n"
            "<code>/intro need an accountant for a 3-person startup</code>\n\n"
            "Your text is shown to matching experts <b>without your name</b>.",
            parse_mode=HTML,
        )
        return
    try:
        res = intros.request_intro(conn, settings.community_id, m.id, text, utcnow())
    except intros.IntroError as exc:
        await message.answer(str(exc), parse_mode=HTML)
        return
    labels = ", ".join(taxonomy()[c].en for c in res.skills)
    if res.intro_id:
        await message.answer(
            f"Request created (<i>{html.escape(labels)}</i>). I've invited the best-matching "
            "available expert anonymously. You'll be asked to confirm before any contact is "
            "shared. Invitations expire after 72h; I'll try up to 3 experts.",
            parse_mode=HTML,
        )
    else:
        await message.answer(
            f"No opted-in, available expert matches <i>{html.escape(labels)}"
            "</i> right now. Try again later or ask in the community.",
            parse_mode=HTML,
        )


@router.message(Command("requests"), PRIVATE)
async def cmd_requests(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    rows = intros.open_needs(conn, m.id)
    if not rows:
        await message.answer("You have no open requests.")
        return
    for r in rows:
        await message.answer(
            f"<blockquote>{html.escape(r['description'])}</blockquote>Status: {r['status']}",
            parse_mode=HTML,
            reply_markup=_kb([[("Cancel request", f"n:{r['id']}:cancel")]]),
        )


# ---- Data rights -------------------------------------------------------------------------


@router.message(Command("forget_me"), PRIVATE)
async def cmd_forget_me(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    await message.answer(
        "<b>Delete my data?</b>\nThis removes all your stored messages, skills, consents and "
        "open introductions, and stops storing your future messages. It cannot be undone.",
        parse_mode=HTML,
        reply_markup=_kb([[("Yes, delete everything", "fm:yes"), ("Cancel", "fm:no")]]),
    )


@router.message(Command("resume_collection"), PRIVATE)
async def cmd_resume(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    m = await _member(message, conn, settings)
    if m is None:
        return
    data_rights.resume_collection(conn, m.id)
    await message.answer("Your new messages in enabled groups will be stored again.")


# ---- Owner commands (private) ------------------------------------------------------------


@router.message(Command("status"), PRIVATE)
async def cmd_status(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    if not _is_owner(settings, message.from_user.id if message.from_user else None):
        return
    st = collect_status(conn, settings)
    lines = [f"{html.escape(k)}: <b>{html.escape(str(v))}</b>" for k, v in st.items()]
    await message.answer("<b>Status</b>\n" + "\n".join(lines), parse_mode=HTML)


@router.message(Command("uncertain"), PRIVATE)
async def cmd_uncertain(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    if not _is_owner(settings, message.from_user.id if message.from_user else None):
        return
    rows = conn.execute(
        "SELECT id, kind, target, idempotency_key, updated_at FROM effect_intents "
        "WHERE state='uncertain' ORDER BY updated_at LIMIT 20"
    ).fetchall()
    if not rows:
        await message.answer("No uncertain sends.")
        return
    for r in rows:
        await message.answer(
            f"<code>{r['id']}</code> {html.escape(r['idempotency_key'])} → {r['target']} "
            f"({r['updated_at']})\nDid it arrive?",
            parse_mode=HTML,
            reply_markup=_kb(
                [[("Delivered", f"u:{r['id']}:1"), ("Not delivered", f"u:{r['id']}:0")]]
            ),
        )


@router.message(Command("sources"), PRIVATE)
async def cmd_sources(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    if not _is_owner(settings, message.from_user.id if message.from_user else None):
        return
    rows = conn.execute(
        "SELECT title, external_ref, visibility, enabled, retention_days, "
        "(SELECT COUNT(*) FROM messages m WHERE m.source_id = s.id AND m.removed_at IS NULL) AS n "
        "FROM sources s WHERE community_id=? ORDER BY enabled DESC, title",
        (settings.community_id,),
    ).fetchall()
    lines = [
        f"{'✅' if r['enabled'] else '⏸'} {html.escape(r['title'] or r['external_ref'])} · "
        f"{r['visibility']} · {r['retention_days']}d · {r['n']} msgs"
        for r in rows
    ]
    await message.answer("<b>Sources</b>\n" + ("\n".join(lines) or "none"), parse_mode=HTML)


@router.message(Command("digest_now"), PRIVATE)
async def cmd_digest_now(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    if not _is_owner(settings, message.from_user.id if message.from_user else None):
        return
    now = utcnow()
    jobs.enqueue(
        conn,
        "digest",
        f"digest:{settings.community_id}:manual:{int(now.timestamp())}",
        {"manual": True},
        now=now,
    )
    await message.answer("Digest queued; it arrives within a few seconds.")


# ---- Callbacks ---------------------------------------------------------------------------


@router.callback_query(F.data.startswith("i:"))
async def cb_intro(cb: CallbackQuery, conn: sqlite3.Connection, settings: Settings) -> None:
    _, intro_id, action = (cb.data or "::").split(":", 2)
    m = acl.get_member_by_telegram(conn, settings.community_id, cb.from_user.id)
    reply = "Not available." if m is None else intros.act(conn, intro_id, m.id, action, utcnow())
    await cb.answer(reply[:190], show_alert=len(reply) > 60)
    if isinstance(cb.message, Message):
        await cb.message.edit_reply_markup(reply_markup=None)


@router.callback_query(F.data.startswith("n:"))
async def cb_need(cb: CallbackQuery, conn: sqlite3.Connection, settings: Settings) -> None:
    _, need_id, _action = (cb.data or "::").split(":", 2)
    m = acl.get_member_by_telegram(conn, settings.community_id, cb.from_user.id)
    ok = m is not None and intros.cancel_need(conn, m.id, need_id, utcnow())
    await cb.answer("Request cancelled." if ok else "Already closed.")
    if isinstance(cb.message, Message):
        await cb.message.edit_reply_markup(reply_markup=None)


@router.callback_query(F.data.startswith("p:"))
async def cb_profile(cb: CallbackQuery, conn: sqlite3.Connection, settings: Settings) -> None:
    _, flag, val = (cb.data or "::").split(":", 2)
    m = acl.get_member_by_telegram(conn, settings.community_id, cb.from_user.id)
    if m is None:
        await cb.answer("Not available.")
        return
    on = val == "1"
    if flag == "disc":
        experts.set_discovery(conn, m.id, on, utcnow())
    elif flag == "avail":
        experts.set_flag(conn, m.id, "available", on)
    elif flag == "rem":
        experts.set_flag(conn, m.id, "reminders_opt_in", on)
    text, kb = _profile_text(experts.get_profile(conn, m.id))
    await cb.answer("Saved.")
    if isinstance(cb.message, Message):
        await cb.message.edit_text(text, parse_mode=HTML, reply_markup=kb)


@router.callback_query(F.data.startswith("fm:"))
async def cb_forget(cb: CallbackQuery, conn: sqlite3.Connection, settings: Settings) -> None:
    m = acl.get_member_by_telegram(conn, settings.community_id, cb.from_user.id)
    if cb.data != "fm:yes" or m is None:
        await cb.answer("Nothing deleted.")
    else:
        rep = data_rights.forget_member(conn, m.id, utcnow())
        await cb.answer("Deleted.")
        if isinstance(cb.message, Message):
            await cb.message.answer(
                f"Done: {rep.messages} message(s), {rep.skills} skill(s) and "
                f"{rep.intros_cancelled} introduction(s) removed. Your future messages won't be "
                "stored. /resume_collection undoes the collection stop."
            )
    if isinstance(cb.message, Message):
        await cb.message.edit_reply_markup(reply_markup=None)


@router.callback_query(F.data.startswith("u:"))
async def cb_uncertain(cb: CallbackQuery, conn: sqlite3.Connection, settings: Settings) -> None:
    if not _is_owner(settings, cb.from_user.id):
        await cb.answer()
        return
    _, eid, delivered = (cb.data or "::").split(":", 2)
    ok = outbox.reconcile(
        conn, eid, delivered=delivered == "1", now=utcnow(), note=f"operator {cb.from_user.id}"
    )
    await cb.answer("Recorded." if ok else "Already resolved.")
    if isinstance(cb.message, Message):
        await cb.message.edit_reply_markup(reply_markup=None)


# ---- Ingestion ---------------------------------------------------------------------------


def _dump(message: Message) -> dict[str, Any]:
    data: dict[str, Any] = message.model_dump(mode="json", by_alias=True, exclude_none=True)
    return data


async def _ingest(
    message: Message, conn: sqlite3.Connection, settings: Settings, event_update: Any = None
) -> None:
    try:
        nm = normalize_message(_dump(message))
    except (KeyError, ValueError):
        log.warning("unparseable message in chat %s", message.chat.id)
        return
    update_id = getattr(event_update, "update_id", None)
    outcome = ingest(conn, settings.community_id, nm, update_id=update_id)
    if (
        outcome is IngestOutcome.STORED
        and nm.media_kind == "document"
        and nm.media_file_id
        and documents.is_supported(nm.file_name, nm.file_size)
    ):
        src = get_enabled_source(conn, settings.community_id, nm.platform, nm.chat_id)
        row_id = message_row_id(conn, src.id, str(nm.message_id)) if src else None
        if src and row_id:
            jobs.enqueue(
                conn,
                "doc.ingest",
                f"doc:{row_id}",
                {
                    "source_id": src.id,
                    "message_row_id": row_id,
                    "file_id": nm.media_file_id,
                    "file_name": nm.file_name,
                    "event_at": nm.event_at,
                    "citation_uri": citation_uri(
                        nm.chat_id, nm.message_id, src.public_username, nm.topic_id
                    ),
                },
                now=utcnow(),
            )


@router.message(IN_GROUP)
async def on_group_message(
    message: Message, conn: sqlite3.Connection, settings: Settings, event_update: Any = None
) -> None:
    await _ingest(message, conn, settings, event_update)


@router.edited_message(IN_GROUP)
async def on_group_edit(
    message: Message, conn: sqlite3.Connection, settings: Settings, event_update: Any = None
) -> None:
    await _ingest(message, conn, settings, event_update)


@router.my_chat_member()
async def on_bot_membership(
    event: ChatMemberUpdated, conn: sqlite3.Connection, settings: Settings
) -> None:
    """Bot removed from a group = lost approval: stop ingest, hide its evidence."""
    removed = event.new_chat_member.status in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED)
    if removed and disable_source(
        conn, settings.community_id, event.chat.id, actor_member_id="system"
    ):
        log.warning("bot removed from chat %s; source disabled", event.chat.id)


@router.chat_member()
async def on_chat_member(
    event: ChatMemberUpdated, conn: sqlite3.Connection, settings: Settings
) -> None:
    """Leaving or being removed from a group revokes read access to it (C06)."""
    src = get_enabled_source(conn, settings.community_id, "telegram", event.chat.id)
    if src is None:
        return
    member = acl.get_member_by_telegram(conn, settings.community_id, event.new_chat_member.user.id)
    if member is None:
        return
    if event.new_chat_member.status in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED):
        acl.revoke_source_access(conn, src.id, member.id)
    elif event.new_chat_member.status in (
        ChatMemberStatus.MEMBER,
        ChatMemberStatus.ADMINISTRATOR,
        ChatMemberStatus.CREATOR,
    ):
        acl.grant_source_access(conn, src.id, member.id, "chat_member")
