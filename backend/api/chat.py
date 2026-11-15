"""POST /api/ai/chat als Server-Sent-Events."""

from __future__ import annotations

import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..schemas import ChatRequest

router = APIRouter(prefix="/api/ai")


def sse(name: str, data: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(body: ChatRequest, request: Request):
    svc = request.app.state.container.service
    ip = request.client.host if request.client else "unknown"
    prepared = svc.prepare(body, ip)  # wirft ApiError (JSON) vor dem Stream

    async def gen():
        events = prepared.events()
        try:
            async for name, data in events:
                yield sse(name, data)
        finally:
            await events.aclose()  # schliesst bei Disconnect den Provider-Stream

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
