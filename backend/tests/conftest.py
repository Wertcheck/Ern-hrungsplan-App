from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.ai.providers.base_provider import BaseProvider, ModelInfo
from backend.config.settings import Settings
from backend.main import create_app

SECRET = "test-secret-123"

CTX = {
    "profile": {"goal": "abnehmen", "kcal_target": 2000},
    "restrictions": [{"allergen": "Erdnuss", "severity": "allergy"}],
    "excluded_foods": ["Pilze"],
    "plan": {"kcal_target": 2000, "days": [{"date": "2026-01-05", "total_kcal": 1900, "meals": [
        {"meal_id": "m1", "slot": "fruehstueck", "recipe_id": "r1", "recipe_name": "Haferbrei", "factor": 1, "kcal": 400}]}]},
    "recipe_catalog": [
        {"id": "r1", "name": "Haferbrei", "slots": ["fruehstueck"], "kcal": 400},
        {"id": "r2", "name": "Omelett", "slots": ["fruehstueck"], "kcal": 350}],
    "food_catalog": ["Haferflocken", "Milch", "Ei"],
}


def make_settings(tmp_path, **kw) -> Settings:
    return Settings(_env_file=None, data_dir=tmp_path / "data", **kw)


class ScriptedProvider(BaseProvider):
    """script: Liste aus Events, Exceptions (werden geworfen) oder ("sleep", sek)."""

    name = "scripted"

    def __init__(self, script):
        self.script = script
        self.closed = False
        self.requests = []

    @classmethod
    def is_configured(cls, settings):
        return True

    @classmethod
    def from_settings(cls, settings):
        raise NotImplementedError

    async def stream(self, request):
        import asyncio
        self.requests.append(request)
        try:
            for item in self.script:
                if isinstance(item, BaseException):
                    raise item
                if isinstance(item, tuple) and item[0] == "sleep":
                    await asyncio.sleep(item[1])
                else:
                    yield item
        finally:
            self.closed = True

    async def list_models(self):
        return [ModelInfo("m-1", "Model 1")]

    async def ping(self):
        return None


def factory_for(**providers):
    return lambda name, settings: providers[name]


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        assert lines[0].startswith("event: ") and lines[1].startswith("data: "), block
        out.append((lines[0][7:], json.loads(lines[1][6:])))
    return out


@pytest.fixture
def mk(tmp_path):
    def _mk(settings_kw=None, ai=None, providers=None):
        s = make_settings(tmp_path, **(settings_kw or {}))
        app = create_app(s, factory_for(**providers) if providers else None)
        client = TestClient(app)
        if ai:
            r = client.put("/api/ai/settings", json=ai)
            assert r.status_code == 200, r.text
        return client, app.state.container
    return _mk


def chat_body(text="Hallo", **extra):
    return {"messages": [{"role": "user", "content": text}], **extra}


def ns(**kw):
    return SimpleNamespace(**kw)
