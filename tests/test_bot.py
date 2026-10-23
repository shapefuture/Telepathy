"""Handler-level tests through aiogram's real dispatcher with a fake Telegram session."""

from __future__ import annotations

import asyncio
import itertools
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.methods import (
    AnswerCallbackQuery,
    EditMessageReplyMarkup,
    EditMessageText,
    GetChat,
    GetChatMember,
    SendMessage,
    TelegramMethod,
)
from aiogram.types import (
    ChatFullInfo,
    ChatMemberAdministrator,
    ChatMemberMember,
    Message,
    Update,
    User,
)

from telepathy.bot import handlers
from telepathy.bot.handlers import router
from telepathy.bot.notifier import make_sender
from telepathy.config import Settings
from telepathy.domain.types import utcnow
from telepathy.storage import outbox

OWNER = 1000
GROUP = -1001234
_upd = itertools.count(1)
_msg = itertools.count(100)


class FakeSession(BaseSession):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[TelegramMethod[Any]] = []
        self.admins = {OWNER}

    async def close(self) -> None:
        pass

    async def stream_content(self, *a: Any, **k: Any):  # type: ignore[override]
        yield b""

    async def make_request(self, bot: Bot, method: TelegramMethod[Any], timeout: int | None = None):
        self.calls.append(method)
        if isinstance(method, SendMessage):
            return Message.model_validate(
                {
                    "message_id": next(_msg),
                    "date": 1760000000,
                    "chat": {"id": method.chat_id, "type": "private"},
                    "text": method.text,
                }
            )
        if isinstance(method, GetChatMember):
            user = User(id=method.user_id, is_bot=False, first_name="U")
            if method.user_id in self.admins:
                return ChatMemberAdministrator.model_construct(status="administrator", user=user)
            return ChatMemberMember.model_construct(status="member", user=user)
        if isinstance(method, GetChat):
            return ChatFullInfo.model_construct(
                id=method.chat_id,
                type="private",
                first_name="Expert",
                last_name=None,
                username="expert_user",
            )
        if isinstance(method, AnswerCallbackQuery | EditMessageReplyMarkup | EditMessageText):
            return True
        raise AssertionError(f"unexpected call {type(method).__name__}")

    def texts(self, chat_id: int | None = None) -> list[str]:
        return [
            c.text
            for c in self.calls
            if isinstance(c, SendMessage) and (chat_id is None or c.chat_id == chat_id)
        ]


@pytest.fixture
def env(conn, tmp_path):
    handlers.limiter.hits.clear()
    s = Settings(
        bot_token="123:ABC",
        db_path=tmp_path / "x.db",
        owner_telegram_ids=frozenset({OWNER}),
        community_id="c1",
        community_label="T",
        timezone=ZoneInfo("Asia/Jerusalem"),
    )
    session = FakeSession()
    bot = Bot("123:ABC", session=session)
    dp = Dispatcher()
    dp["conn"] = conn
    dp["settings"] = s
    router._parent_router = None  # module-level router: re-attach per test dispatcher
    dp.include_router(router)
    return conn, bot, dp, session


def feed(dp: Dispatcher, bot: Bot, **update: Any) -> None:
    asyncio.run(dp.feed_update(bot, Update.model_validate({"update_id": next(_upd), **update})))


def group_msg(user: int, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "message": {
            "message_id": next(_msg),
            "date": 1760000000,
            "chat": {"id": GROUP, "type": "supergroup", "title": "G"},
            "from": {"id": user, "is_bot": False, "first_name": "N"},
            "text": text,
            **extra,
        }
    }


def dm(user: int, text: str) -> dict[str, Any]:
    return {
        "message": {
            "message_id": next(_msg),
            "date": 1760000000,
            "chat": {"id": user, "type": "private"},
            "from": {"id": user, "is_bot": False, "first_name": "N"},
            "text": text,
            "entities": [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}],
        }
    }


def press(user: int, data: str) -> dict[str, Any]:
    return {
        "callback_query": {
            "id": str(next(_upd)),
            "chat_instance": "x",
            "data": data,
            "from": {"id": user, "is_bot": False, "first_name": "N"},
            "message": {
                "message_id": 1,
                "date": 1760000000,
                "chat": {"id": user, "type": "private"},
                "text": "x",
            },
        }
    }


def cmd(user: int, text: str) -> dict[str, Any]:
    m = group_msg(user, text)
    m["message"]["entities"] = [
        {"type": "bot_command", "offset": 0, "length": len(text.split()[0])}
    ]
    return m


def test_non_owner_cannot_enable_and_unlisted_chat_is_ignored(env):
    conn, bot, dp, session = env
    feed(dp, bot, **group_msg(5, "hello before enable"))
    feed(dp, bot, **cmd(5, "/enable"))
    assert conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
    assert session.texts() == []  # silent to non-owners


def test_enable_ingest_and_ask(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    assert "collecting" in session.texts(GROUP)[0]
    feed(dp, bot, **group_msg(5, "The meetup venue is Hall B on Rothschild"))
    feed(dp, bot, **dm(5, "/ask where is the meetup venue?"))
    reply = session.texts(5)[-1]
    assert "Hall B" in reply and "t.me/c/1234/" in reply
    feed(dp, bot, **dm(77, "/ask venue"))  # stranger
    assert "don't know you" in session.texts(77)[-1]


def test_ask_in_group_redirects_to_dm(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **cmd(5, "/ask venue?"))
    assert "private chat" in session.texts(GROUP)[-1]


def test_intro_flow_through_bot(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **group_msg(5, "hi"))  # requester
    feed(dp, bot, **group_msg(6, "hey"))  # expert
    feed(dp, bot, **dm(6, "/optin"))
    feed(dp, bot, **dm(6, "/skills add accounting"))
    feed(dp, bot, **dm(5, "/expert accounting"))
    assert "<b>1</b>" in session.texts(5)[-1]
    feed(dp, bot, **dm(5, "/intro need an accountant for my startup"))
    assert "invited" in session.texts(5)[-1]

    sender = make_sender(bot)

    def drain() -> None:
        for eid in outbox.pending_ids(conn):
            asyncio.run(outbox.dispatch(conn, eid, sender, now=utcnow))

    drain()
    invite = [c for c in session.calls if isinstance(c, SendMessage) and c.chat_id == 6][-1]
    data = invite.reply_markup.inline_keyboard[0][0].callback_data
    assert data.endswith(":acc")
    feed(dp, bot, **press(5, data))  # requester can't accept on the expert's behalf
    feed(dp, bot, **press(6, data))
    drain()
    confirm = [c for c in session.calls if isinstance(c, SendMessage) and c.chat_id == 5][-1]
    assert "expert_user" not in confirm.text  # nothing revealed yet
    feed(dp, bot, **press(5, confirm.reply_markup.inline_keyboard[0][0].callback_data))
    drain()
    assert any("@expert_user" in t for t in session.texts(5))


def test_forget_me_via_bot(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **group_msg(5, "personal story about my visa"))
    feed(dp, bot, **dm(5, "/forget_me"))
    feed(dp, bot, **press(5, "fm:yes"))
    assert conn.execute("SELECT COUNT(*) FROM excerpts WHERE valid_to IS NULL").fetchone()[0] == 0
    feed(dp, bot, **group_msg(5, "new message"))
    assert conn.execute("SELECT COUNT(*) FROM messages WHERE removed_at IS NULL").fetchone()[0] == 0


def test_author_can_forget_own_message_in_group(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    original = group_msg(5, "oops wrong chat")
    feed(dp, bot, **original)
    reply = cmd(5, "/forget")
    reply["message"]["reply_to_message"] = original["message"]
    feed(dp, bot, **reply)
    assert "Removed" in session.texts(GROUP)[-1]
    assert conn.execute("SELECT COUNT(*) FROM excerpts WHERE valid_to IS NULL").fetchone()[0] == 0


def test_owner_status_and_non_owner_denied(env):
    conn, bot, dp, session = env
    feed(dp, bot, **dm(OWNER, "/status"))
    assert "enabled sources" in session.texts(OWNER)[-1]
    feed(dp, bot, **dm(5, "/status"))
    assert session.texts(5) == []


def test_ask_rate_limit(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **group_msg(5, "x"))
    for _ in range(11):
        feed(dp, bot, **dm(5, "/ask something here"))
    assert "Too many" in session.texts(5)[-1]


def test_skills_all_is_paged_under_telegram_limit(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **group_msg(5, "hi"))
    feed(dp, bot, **dm(5, "/skills all"))
    pages = session.texts(5)
    assert len(pages) >= 3 and all(len(t) < 4096 for t in pages)


def test_bot_removed_from_group_disables_source(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    user = {"id": 999, "is_bot": True, "first_name": "Bot"}
    feed(
        dp,
        bot,
        my_chat_member={
            "chat": {"id": GROUP, "type": "supergroup", "title": "G"},
            "from": {"id": OWNER, "is_bot": False, "first_name": "O"},
            "date": 1760000000,
            "old_chat_member": {"status": "member", "user": user},
            "new_chat_member": {"status": "left", "user": user},
        },
    )
    assert conn.execute("SELECT enabled FROM sources").fetchone()[0] == 0


def test_open_database_seeds_owners(tmp_path):
    from telepathy.bot.app import open_database

    s = Settings(
        bot_token="1:x",
        db_path=tmp_path / "o.db",
        owner_telegram_ids=frozenset({7}),
        community_id="c9",
        community_label="T",
        timezone=ZoneInfo("UTC"),
    )
    c = open_database(s)
    assert c.execute("SELECT role FROM members WHERE telegram_user_id='7'").fetchone()[0] == "owner"
    c.close()
    c = open_database(s)  # idempotent restart
    assert c.execute("SELECT COUNT(*) FROM members").fetchone()[0] == 1


def test_digest_command_toggles_opt_in(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **group_msg(5, "hello group"))
    feed(dp, bot, **dm(5, "/digest on"))
    assert (
        conn.execute("SELECT digest_opt_in FROM members WHERE telegram_user_id='5'").fetchone()[0]
        == 1
    )
    feed(dp, bot, **dm(5, "/digest"))
    assert "<b>on</b>" in session.texts(5)[-1]
    feed(dp, bot, **dm(5, "/digest off"))
    assert (
        conn.execute("SELECT digest_opt_in FROM members WHERE telegram_user_id='5'").fetchone()[0]
        == 0
    )


def test_retention_zero_means_keep_all(env):
    conn, bot, dp, session = env
    feed(dp, bot, **cmd(OWNER, "/enable"))
    feed(dp, bot, **group_msg(5, "x"))
    reply = cmd(OWNER, "/retention 0")
    feed(dp, bot, **reply)
    assert "Full history will be kept" in session.texts(GROUP)[-1]
    assert conn.execute("SELECT retention_days FROM sources").fetchone()[0] == 0
