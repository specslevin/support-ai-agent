"""Telegram message and command handlers."""

from __future__ import annotations

import structlog
from aiogram import F, Router
from aiogram.filters import BaseFilter, Command, CommandObject, CommandStart
from aiogram.types import Message

from app.core.agent.orchestrator import SupportAgent
from app.core.ai.agent import AIAgent
from app.core.db.database import AsyncSessionLocal
from app.core.db.models import ChatHistory
from app.core.db.sync import sync_companies
from app.core.okdesk.service import OkdeskService

log = structlog.get_logger(__name__)

_TELEGRAM_TEXT_MAX = 4096


class _NotBuiltinCommandFilter(BaseFilter):
    """Allow `/статус` etc. while avoiding double-handling of /start and /status."""

    async def __call__(self, message: Message) -> bool:
        raw = (message.text or "").strip()
        if not raw.startswith("/"):
            return True
        head = raw.split(maxsplit=1)[0].lower()
        return head not in ("/start", "/status", "/ai", "/clear", "/sync")


def _clip(text: str, max_len: int = _TELEGRAM_TEXT_MAX) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 20] + "\n…(обрезано)"


def build_handlers_router(
    agent: SupportAgent,
    ai_agent: AIAgent | None = None,
    okdesk_service: OkdeskService | None = None,
) -> Router:
    router = Router(name="support_handlers")

    @router.message(CommandStart())
    async def cmd_start(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="start", user_id=uid, chat_id=message.chat.id)
        text = (
            "Привет! Я AI-помощник техподдержки GPSPOS.\n\n"
            "• Используй `/ai <вопрос>` — отправь запрос AI-ассистенту.\n"
            "  Пример: `/ai Найди компанию Ситиматик`\n"
            "  Пример: `/ai Статус объекта А123БВ`\n"
            "• `/clear` — очистить историю диалога.\n"
            "• `/status <ID или госномер>` — быстрая проверка статуса.\n"
            "• Либо просто напиши вопрос текстом."
        )
        await message.answer(_clip(text))
        log.info("telegram_out", kind="reply", command="start", user_id=uid, length=len(text))

    @router.message(Command("status"))
    async def cmd_status(message: Message, command: CommandObject) -> None:
        uid = message.from_user.id if message.from_user else 0
        arg = (command.args or "").strip()
        log.info(
            "telegram_in",
            kind="command",
            command="status",
            user_id=uid,
            chat_id=message.chat.id,
            has_arg=bool(arg),
        )
        if not arg:
            reply = "Использование: `/status <ID объекта или госномер>`"
            await message.answer(_clip(reply))
            log.info("telegram_out", kind="reply", command="status", user_id=uid, length=len(reply))
            return
        user_line = f"/статус {arg}"
        reply = await agent.process_message(user_line, uid)
        reply = _clip(reply)
        await message.answer(reply)
        log.info("telegram_out", kind="reply", command="status", user_id=uid, length=len(reply))

    @router.message(Command("ai"))
    async def cmd_ai(message: Message, command: CommandObject) -> None:
        uid = message.from_user.id if message.from_user else 0
        arg = (command.args or "").strip()
        log.info(
            "telegram_in",
            kind="command",
            command="ai",
            user_id=uid,
            chat_id=message.chat.id,
            has_arg=bool(arg),
        )

        if not arg:
            reply = "Напиши вопрос после `/ai`, например: `/ai Найди компанию Ситиматик`"
            await message.answer(_clip(reply))
            log.info("telegram_out", kind="reply", command="ai", user_id=uid, length=len(reply))
            return

        if ai_agent is None:
            reply = "AI-агент не настроен. Попробуй позже."
            await message.answer(_clip(reply))
            log.warning("ai_agent_not_configured", user_id=uid)
            return

        await message.answer("⏳ Думаю...")
        try:
            reply = await ai_agent.run(arg, str(uid))
            reply = _clip(reply)
            await message.answer(reply)
            log.info("telegram_out", kind="reply", command="ai", user_id=uid, length=len(reply))
        except Exception as e:
            log.exception("ai_agent_error", user_id=uid, error=str(e))
            await message.answer("❌ Произошла ошибка при обработке запроса. Попробуй ещё раз.")

    @router.message(Command("clear"))
    async def cmd_clear(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="clear", user_id=uid, chat_id=message.chat.id)

        try:
            async with AsyncSessionLocal() as session:
                from sqlalchemy import delete
                await session.execute(
                    delete(ChatHistory).where(ChatHistory.user_id == str(uid))
                )
                await session.commit()
            await message.answer("🗑 История диалога очищена.")
            log.info("telegram_out", kind="reply", command="clear", user_id=uid)
        except Exception as e:
            log.exception("clear_history_error", user_id=uid, error=str(e))
            await message.answer("❌ Ошибка при очистке истории.")

    @router.message(Command("sync"))
    async def cmd_sync(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        log.info("telegram_in", kind="command", command="sync", user_id=uid, chat_id=message.chat.id)

        if okdesk_service is None:
            await message.answer("❌ Сервис Okdesk не настроен.")
            return

        await message.answer("🔄 Синхронизация компаний из Okdesk...")
        try:
            count = await sync_companies(okdesk_service)
            await message.answer(f"✅ Синхронизировано {count} компаний.")
            log.info("telegram_out", kind="reply", command="sync", user_id=uid, count=count)
        except Exception as e:
            log.exception("sync_companies_error", user_id=uid, error=str(e))
            await message.answer("❌ Ошибка при синхронизации.")

    @router.message(F.text, _NotBuiltinCommandFilter())
    async def on_text(message: Message) -> None:
        uid = message.from_user.id if message.from_user else 0
        body = message.text or ""
        log.info("telegram_in", kind="text", user_id=uid, chat_id=message.chat.id, length=len(body))
        reply = await agent.process_message(body, uid)
        reply = _clip(reply)
        await message.answer(reply)
        log.info("telegram_out", kind="reply", user_id=uid, length=len(reply))

    return router
