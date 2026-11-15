"""Status/Einstellungen/Modelle/Test/Usage."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request

from ..schemas import TestRequest
from ..services.settings_store import AiSettingsUpdate

router = APIRouter(prefix="/api/ai")


def _c(request: Request):
    return request.app.state.container


@router.get("/status")
async def status(request: Request) -> dict:
    return _c(request).service.status()


@router.get("/settings")
async def get_settings(request: Request) -> dict:
    return _c(request).store.load().model_dump()


@router.put("/settings")
async def put_settings(patch: AiSettingsUpdate, request: Request) -> dict:
    return _c(request).store.update(patch).model_dump()


@router.get("/models")
async def models(request: Request, provider: Literal["openai", "anthropic"] = Query(...)) -> dict:
    return await _c(request).service.list_models(provider)


@router.post("/test")
async def test(body: TestRequest, request: Request) -> dict:
    return await _c(request).service.test(body.provider)


@router.get("/usage")
async def usage(request: Request) -> dict:
    return _c(request).service.usage()
