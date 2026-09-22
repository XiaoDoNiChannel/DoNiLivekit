"""FastAPI resource lifecycle."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Awaitable, Callable


def create_lifespan(
    initialize: Callable[[], None],
    start_background_tasks: Callable[[], Awaitable[None]],
    stop_background_tasks: Callable[[], Awaitable[None]],
):
    @asynccontextmanager
    async def lifespan(_app):
        initialize()
        await start_background_tasks()
        try:
            yield
        finally:
            await stop_background_tasks()

    return lifespan
