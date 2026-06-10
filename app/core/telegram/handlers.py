"""Telegram message and command handlers."""

from __future__ import annotations

import structlog
from aiogram import F, Router
from aiogram.filters import BaseFilter, Command, CommandObject, CommandStart
from aiogram.types import Message
from sqlalchemy import delete, select

from app.core.ai.agent import AIAgent
from app.core.db.database import AsyncSessionLocal
from app.core.db.models import ChatHistory
from app.core.db.sync import sync_companies
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

_TELEGRAM_TEXT_MAX = 4096
_HISTORY_DEFAULT = 10
_HISTORY_MAX = 30


class _NotBuiltinCommandFilter(BaseFilter):
    """Pass plain text and unknown slash commands; block known command names."""

    async def __call__(self, message: Message) -> bool:
        raw = (message.text or "").strip()
        if not raw.startswith("/"):
            return True
        head = raw.split(maxsplit=1)[0].lower()
        return head not in ("/start", "/status", "/ai", "/clear", "/sync", "/история", "/history")


def _clip(text: str, max_len: int = _TELEGRAM_TEXT_MAX) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 20] + "\n…(обрезано)"


async def _run_ai(ai_agent: AIAgent, message: Message, query: str) -> None:
    uid = message.from_user.id if message.from_user else 0
    await message.answer("⏳ Думаю...")
    try:
        reply = await ai_agent.run(query, str(uid))
    except Exception as e:
        log.exception("ai_agent_error", user_id=uid, error=str(e))
        reply = "❌ Произошла ошибка при обработке запроса. Попробуй ещё раз."
    await message.answer(_clip(reply))
    log.info("telegram_out", kind="reply", user_id=uid, length=len(reply))


def build_handlers_router(
    ai_agent: AIAgent | None = None,
    okdesk_service: OkdeskService | None = None,
) -> Router:
    router = Router(name="support_handlers")

    @router.message(CommandStart())
    async def cmd_start(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="start", user_id=uid)
        text = (
            "Привет! Я AI-помощник техподдержки GPSPOS.\n\n"
            "Просто напиши вопрос — я отвечу, используя Okdesk и GPSPOS.\n\n"
            "Примеры:\n"
            "• Покажи последние заявки Россети\n"
            "• Статус объекта А123БВ156\n"
            "• Найди компанию Ситиматик и покажи заявки\n\n"
            "Команды:\n"
            "• /clear — очистить историю диалога\n"
            "• /история [N] — последние N сообщений диалога\n"
            "• /sync — синхронизировать компании из Okdesk\n"
            "• /status <госномер> — быстрая проверка статуса"
        )
        await message.answer(_clip(text))

    @router.message(Command("status"))
    async def cmd_status(message: Message, command: CommandObject) -> None:
        uid = message.from_user.id if message.from_user else 0
        arg = (command.args or "").strip()
        log.info("telegram_in", kind="command", command="status", user_id=uid, has_arg=bool(arg))
        if not arg:
            await message.answer("Использование: `/status <ID объекта или госномер>`")
            return
        if ai_agent is None:
            await message.answer("❌ AI-агент не настроен.")
            return
        await _run_ai(ai_agent, message, f"Проверь статус объекта {arg}")

    @router.message(Command("ai"))
    async def cmd_ai(message: Message, command: CommandObject) -> None:
        uid = message.from_user.id if message.from_user else 0
        arg = (command.args or "").strip()
        log.info("telegram_in", kind="command", command="ai", user_id=uid)
        if not arg:
            await message.answer("Напиши вопрос после `/ai` или просто текстом.")
            return
        if ai_agent is None:
            await message.answer("❌ AI-агент не настроен.")
            return
        await _run_ai(ai_agent, message, arg)

    @router.message(Command("история", "history"))
    async def cmd_history(message: Message, command: CommandObject) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="история", user_id=uid)

        raw_n = (command.args or "").strip()
        n = _HISTORY_DEFAULT
        if raw_n.isdigit():
            n = min(int(raw_n), _HISTORY_MAX)

        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(ChatHistory)
                .where(ChatHistory.user_id == str(uid))
                .order_by(ChatHistory.timestamp.desc())
                .limit(n)
            )
            rows = list(reversed(result.scalars().all()))

        if not rows:
            await message.answer("История диалога пуста.")
            return

        lines = [f"📋 *Последние {len(rows)} сообщений:*\n"]
        for row in rows:
            prefix = "👤" if row.role == "user" else "🤖"
            content = (row.content or "").strip()
            if len(content) > 300:
                content = content[:300] + "…"
            lines.append(f"{prefix} {content}")

        await message.answer(_clip("\n\n".join(lines)), parse_mode="Markdown")

    @router.message(Command("clear"))
    async def cmd_clear(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="clear", user_id=uid)
        try:
            async with AsyncSessionLocal() as session:
                await session.execute(
                    delete(ChatHistory).where(ChatHistory.user_id == str(uid))
                )
                await session.commit()
            await message.answer("🗑 История диалога очищена.")
        except Exception as e:
            log.exception("clear_history_error", user_id=uid, error=str(e))
            await message.answer("❌ Ошибка при очистке истории.")

    @router.message(Command("sync"))
    async def cmd_sync(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="sync", user_id=uid)
        if okdesk_service is None:
            await message.answer("❌ Сервис Okdesk не настроен.")
            return
        await message.answer("🔄 Синхронизация компаний из Okdesk...")
        try:
            count = await sync_companies(okdesk_service)
            await message.answer(f"✅ Синхронизировано {count} компаний.")
        except Exception as e:
            log.exception("sync_companies_error", user_id=uid, error=str(e))
            await message.answer("❌ Ошибка при синхронизации.")

    @router.message(F.text, _NotBuiltinCommandFilter())
    async def on_text(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        body = message.text or ""
        log.info("telegram_in", kind="text", user_id=uid, length=len(body))
        if ai_agent is None:
            await message.answer("❌ AI-агент не настроен.")
            return
        await _run_ai(ai_agent, message, body)

    return router
