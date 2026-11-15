from __future__ import annotations

import asyncio
import json
import logging

import pytest

from backend.ai.providers.base_provider import (
    ProviderError, ProviderUnavailable, StopEvent, TextDelta, ToolCall, UsageEvent,
)
from backend.config.settings import Settings
from backend.main import create_app
from backend.security import redact

from .conftest import CTX, SECRET, ScriptedProvider, chat_body, make_settings, parse_sse

ON_MOCK = {"enabled": True, "provider": "mock"}
MOCK = {"enable_mock_provider": True}


def events_of(client, body):
    r = client.post("/api/ai/chat", json=body)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    return parse_sse(r.text)


def names(evs):
    return [n for n, _ in evs]


# ------------------------------------------------------------------ Basics / Settings
def test_health(mk):
    c, _ = mk()
    assert c.get("/api/health").json() == {"ok": True}


def test_settings_defaults_ai_off(mk):
    c, _ = mk()
    s = c.get("/api/ai/settings").json()
    assert s == {"enabled": False, "provider": "anthropic", "models": {"openai": None, "anthropic": None},
                 "temperature": None, "max_output_tokens": 1024, "history_messages": 12, "monthly_limit_usd": None,
                 "block_on_limit": True, "fallback_provider": None, "auto_fallback": False}


def test_settings_partial_update_and_persist(mk, tmp_path):
    c, _ = mk()
    r = c.put("/api/ai/settings", json={"enabled": True, "models": {"openai": "gpt-x"}})
    assert r.status_code == 200 and r.json()["models"] == {"openai": "gpt-x", "anthropic": None}
    r = c.put("/api/ai/settings", json={"models": {"anthropic": "claude-opus-5-5"}, "temperature": 0.7})
    assert r.json()["models"] == {"openai": "gpt-x", "anthropic": "claude-opus-5-5"} and r.json()["enabled"] is True
    assert c.put("/api/ai/settings", json={"temperature": None}).json()["temperature"] is None
    assert (tmp_path / "data" / "ai_settings.json").exists()


@pytest.mark.parametrize("body", [
    {"unknown": 1}, {"temperature": 2.5}, {"temperature": -1}, {"max_output_tokens": 10}, {"max_output_tokens": 5000},
    {"history_messages": 1}, {"history_messages": 31}, {"monthly_limit_usd": -1}, {"provider": "gemini"},
    {"fallback_provider": "mock"}, {"enabled": None}, {"models": {"openai": "bad model!"}}, {"models": {"x": "y"}},
])
def test_settings_validation_422(mk, body):
    c, _ = mk()
    r = c.put("/api/ai/settings", json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_status_shape(mk):
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET})
    s = c.get("/api/ai/status").json()
    assert s["enabled"] is False and s["provider"] == "anthropic" and s["model"] == "claude-opus-5-5" and s["needs_model"] is False
    assert s["providers"] == {"openai": {"configured": False, "default_model": None},
                              "anthropic": {"configured": True, "default_model": "claude-opus-5-5"}, "mock": {"configured": False}}
    assert s["limits"] == {"max_history_cap": 30, "max_output_tokens_cap": 4096, "rate_limit_per_min": 20}
    assert s["usage"]["requests"] == 0 and s["usage"]["cost_known"] is True and s["usage"]["limit_reached"] is False
    assert s["fallback_provider"] is None and s["auto_fallback"] is False


def test_status_needs_model_for_openai(mk):
    c, _ = mk(ai={"provider": "openai"})
    s = c.get("/api/ai/status").json()
    assert s["model"] is None and s["needs_model"] is True


# ------------------------------------------------------------------ Secrets
def test_secrets_never_leak(mk, monkeypatch, caplog):
    monkeypatch.setenv("OPENAI_API_KEY", SECRET)
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET + "-b")
    caplog.set_level(logging.DEBUG)
    s = Settings(_env_file=None, data_dir="/tmp/nonexistent-x")
    assert SECRET not in repr(s) and SECRET not in str(s.model_dump())
    c, _ = mk(settings_kw={"openai_api_key": SECRET, "anthropic_api_key": SECRET + "-b"}, ai={"enabled": True, "provider": "openai"},
              providers={"openai": ScriptedProvider([TextDelta("x")]), "anthropic": ScriptedProvider([])})
    texts = []
    for path in ("/api/ai/status", "/api/ai/settings", "/api/ai/usage", "/api/health"):
        texts.append(c.get(path).text)
    texts.append(c.post("/api/ai/test", json={"provider": "openai"}).text)
    texts.append(c.get("/api/ai/models?provider=openai").text)
    texts.append(c.post("/api/ai/chat", json={"messages": []}).text)
    r = c.post("/api/ai/chat", json=chat_body(model="gpt-x"))
    texts.append(r.text)
    assert all(SECRET not in t for t in texts)
    assert SECRET not in caplog.text


def test_redact():
    for raw in ("key sk-abcdef123456", "sk-ant-api03-ABCDEF_123456", "Authorization: Bearer abc.def-123", "x-api-key: zzzz1234",
                "headers={'authorization': 'tok123456'}", "Bearer abcdefgh"):
        out = redact(raw)
        assert "[REDACTED]" in out
        for frag in ("abcdef123456", "ABCDEF_123456", "abc.def-123", "zzzz1234", "tok123456", "abcdefgh"):
            assert frag not in out
    assert redact("normaler Text") == "normaler Text"


def test_logging_redacts(caplog):
    create_app(make_settings(__import__("pathlib").Path("/tmp/x-nonexistent")))
    caplog.set_level(logging.INFO)
    logging.getLogger("backend.test").info("Fehler mit sk-proj-ABCDEFGH12345 und Bearer qwertz123")
    assert "ABCDEFGH12345" not in caplog.text and "qwertz123" not in caplog.text


def test_known_secret_redacted_in_provider_error(mk):
    c, _ = mk(settings_kw={"openai_api_key": SECRET}, ai={"enabled": True, "provider": "openai"},
              providers={"openai": ScriptedProvider([ProviderError(f"kaputt {SECRET}", code="provider_error")])})
    evs = events_of(c, chat_body(model="m"))
    assert SECRET not in json.dumps(evs)


# ------------------------------------------------------------------ Vorab-Fehler
def test_ai_disabled_403(mk):
    c, _ = mk()
    r = c.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 403 and r.json()["error"]["code"] == "ai_disabled"


def test_provider_not_configured_503(mk):
    c, _ = mk(ai={"enabled": True})
    r = c.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 503 and r.json()["error"]["code"] == "provider_not_configured"


def test_needs_model_503(mk):
    c, _ = mk(settings_kw={"openai_api_key": SECRET}, ai={"enabled": True, "provider": "openai"})
    r = c.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 503 and r.json()["error"]["code"] == "needs_model"


@pytest.mark.parametrize("body", [
    {"messages": []}, {"messages": [{"role": "assistant", "content": "x"}]},
    {"messages": [{"role": "user", "content": ""}]}, {"messages": [{"role": "user", "content": "x" * 8001}]},
    {"messages": [{"role": "user", "content": "x"}] * 61}, {"messages": [{"role": "user", "content": "x"}], "extra": 1},
    {"messages": [{"role": "system", "content": "x"}]}, {"messages": [{"role": "user", "content": "x"}], "temperature": 3},
    {"messages": [{"role": "user", "content": "x"}], "context": {"bogus": 1}},
])
def test_chat_422(mk, body):
    c, _ = mk(settings_kw=MOCK, ai=ON_MOCK)
    r = c.post("/api/ai/chat", json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    assert "x" * 50 not in r.text  # keine Eingabe-Echos


def test_422_error_has_no_input_echo(mk):
    c, _ = mk(settings_kw=MOCK, ai=ON_MOCK)
    r = c.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "GEHEIMER-TEXT"}], "context": {"bogus": 1}})
    assert "GEHEIMER-TEXT" not in r.text


def test_rate_limit_429(mk):
    c, _ = mk(settings_kw={**MOCK, "rate_limit_per_min": 2}, ai=ON_MOCK)
    for _i in range(2):
        assert c.post("/api/ai/chat", json=chat_body()).status_code == 200
    r = c.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited" and int(r.headers["Retry-After"]) >= 1


def test_unknown_route_envelope(mk):
    c, _ = mk()
    r = c.get("/api/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


# ------------------------------------------------------------------ SSE e2e (Mock)
def test_sse_order_text(mk):
    c, _ = mk(settings_kw=MOCK, ai=ON_MOCK)
    evs = events_of(c, chat_body("Hallo"))
    n = names(evs)
    assert n[0] == "meta" and n[-1] == "done" and n[-2] == "usage" and set(n[1:-2]) == {"delta"}
    assert evs[0][1] == {"provider": "mock", "model": "mock-1", "fallback_used": False}
    assert "".join(d["text"] for k, d in evs if k == "delta").startswith("Das ist eine Mock")
    u = dict(evs)["usage"]
    assert u["input_tokens"] > 0 and u["cost_usd"] is None and u["cost_known"] is False


def test_sse_actions_swap(mk):
    c, _ = mk(settings_kw=MOCK, ai=ON_MOCK)
    evs = events_of(c, chat_body("Bitte Tausch", context=CTX))
    n = names(evs)
    assert n[0] == "meta" and n.index("actions") < n.index("usage") < n.index("done") and "error" not in n
    a = dict(evs)["actions"]
    assert a["proposals"] == [{"type": "swap_meal", "date": "2026-01-05", "meal_id": "m1", "recipe_id": "r2", "reason": "Mock-Vorschlag"}]
    assert a["rejected"] == []


def test_sse_tools_disabled_no_tool(mk):
    c, _ = mk(settings_kw=MOCK, ai=ON_MOCK)
    assert "actions" not in names(events_of(c, chat_body("Tausch", context=CTX, tools_enabled=False)))


def test_sse_rejected_actions_reported(mk):
    call = ToolCall("propose_actions", {"proposals": [
        {"type": "swap_meal", "date": "2026-01-05", "meal_id": "ERFUNDEN", "recipe_id": "r2"},
        {"type": "exclude_food", "food_name": "Koriander"}]})
    p = ScriptedProvider([TextDelta("ok"), call, UsageEvent(5, 5), StopEvent("tool_use")])
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True}, providers={"anthropic": p})
    a = dict(events_of(c, chat_body(context=CTX)))["actions"]
    assert len(a["proposals"]) == 1 and a["rejected"][0]["type"] == "swap_meal"
    assert p.requests[0].tools and "propose_actions" == p.requests[0].tools[0].name


def test_sse_error_event_unavailable_then_done(mk):
    c, _ = mk(settings_kw=MOCK, ai=ON_MOCK)
    evs = events_of(c, chat_body("fehler"))
    assert names(evs) == ["meta", "error", "done"]
    e = evs[1][1]
    assert e["code"] == "provider_unavailable" and e["retryable"] is True


def test_sse_midstream_error_keeps_partial(mk):
    p = ScriptedProvider([UsageEvent(10, 0), TextDelta("Teil"), UsageEvent(10, 3), ProviderUnavailable()])
    c, ct = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True}, providers={"anthropic": p})
    evs = events_of(c, chat_body())
    assert names(evs) == ["meta", "delta", "usage", "error", "done"]
    assert ct.ledger.month_summary()["requests"] == 1  # Teil-Usage erfasst


def test_unknown_exception_is_internal_error(mk):
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True},
              providers={"anthropic": ScriptedProvider([RuntimeError(f"geheim {SECRET}")])})
    evs = events_of(c, chat_body())
    assert evs[-2][0] == "error" and evs[-2][1]["code"] == "internal_error" and SECRET not in json.dumps(evs)
    assert "geheim" not in json.dumps(evs)


def test_timeout_event(mk):
    c, _ = mk(settings_kw={**MOCK, "request_timeout_s": 0.2}, ai=ON_MOCK)
    evs = events_of(c, chat_body("langsam"))
    assert names(evs)[-2:] == ["error", "done"] and evs[-2][1]["code"] == "provider_timeout"
    assert "delta" in names(evs)  # Teilantwort bleibt erhalten


# ------------------------------------------------------------------ Provider-Wahl / Fallback / History
def test_provider_switch_via_settings(mk):
    a, o = ScriptedProvider([TextDelta("A")]), ScriptedProvider([TextDelta("O")])
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET, "openai_api_key": SECRET + "2", "openai_default_model": "gpt-test"},
              ai={"enabled": True, "provider": "anthropic"}, providers={"anthropic": a, "openai": o})
    assert events_of(c, chat_body())[0][1]["provider"] == "anthropic"
    c.put("/api/ai/settings", json={"provider": "openai"})
    meta = events_of(c, chat_body())[0][1]
    assert meta == {"provider": "openai", "model": "gpt-test", "fallback_used": False}
    assert len(a.requests) == 1 and len(o.requests) == 1
    c.put("/api/ai/settings", json={"models": {"openai": "gpt-chosen"}})
    assert events_of(c, chat_body())[0][1]["model"] == "gpt-chosen"
    assert events_of(c, chat_body(provider="anthropic", model="claude-x"))[0][1] == {"provider": "anthropic", "model": "claude-x", "fallback_used": False}


FAIL = lambda: ScriptedProvider([ProviderUnavailable()])  # noqa: E731


def _fb(mk, ai_extra, settings_extra=None, primary=None, secondary=None):
    p = primary or FAIL()
    s = secondary or ScriptedProvider([TextDelta("Ersatz"), UsageEvent(3, 3)])
    kw = {"anthropic_api_key": SECRET, "openai_api_key": SECRET + "2", "openai_default_model": "gpt-test", **(settings_extra or {})}
    c, ct = mk(settings_kw=kw, ai={"enabled": True, "provider": "anthropic", **ai_extra}, providers={"anthropic": p, "openai": s})
    return c, p, s, ct


def test_fallback_used_when_configured(mk):
    c, p, s, ct = _fb(mk, {"auto_fallback": True, "fallback_provider": "openai"})
    evs = events_of(c, chat_body())
    assert evs[0] == ("meta", {"provider": "openai", "model": "gpt-test", "fallback_used": True})
    assert "error" not in names(evs) and names(evs)[-1] == "done"
    assert s.requests and p.requests


@pytest.mark.parametrize("ai_extra,settings_extra", [
    ({"auto_fallback": False, "fallback_provider": "openai"}, None),
    ({"auto_fallback": True}, None),
    ({"auto_fallback": True, "fallback_provider": "openai"}, {"openai_api_key": ""}),
    ({"auto_fallback": True, "fallback_provider": "openai"}, {"openai_default_model": ""}),
])
def test_no_fallback_without_full_config(mk, ai_extra, settings_extra):
    c, p, s, _ = _fb(mk, ai_extra, settings_extra)
    evs = events_of(c, chat_body())
    assert names(evs) == ["meta", "error", "done"] and evs[0][1]["fallback_used"] is False and evs[0][1]["provider"] == "anthropic"
    assert s.requests == []


def test_no_fallback_after_text(mk):
    primary = ScriptedProvider([TextDelta("schon Text"), ProviderUnavailable()])
    c, p, s, _ = _fb(mk, {"auto_fallback": True, "fallback_provider": "openai"}, primary=primary)
    evs = events_of(c, chat_body())
    assert names(evs) == ["meta", "delta", "error", "done"] and s.requests == []


def test_history_trimmed_and_caps(mk):
    p = ScriptedProvider([TextDelta("x")])
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True, "history_messages": 4, "max_output_tokens": 300}, providers={"anthropic": p})
    msgs = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(9)]  # endet mit user
    r = c.post("/api/ai/chat", json={"messages": msgs, "max_output_tokens": 4000, "temperature": 0.4})
    assert r.status_code == 200
    rq = p.requests[0]
    assert [m["content"] for m in rq.messages] == ["m5", "m6", "m7", "m8"] or rq.messages[0]["role"] == "user"
    assert len(rq.messages) <= 4 and rq.messages[-1]["content"] == "m8"
    assert rq.max_output_tokens == 300 and rq.temperature == 0.4


# ------------------------------------------------------------------ Kosten
def priced_provider():
    return ScriptedProvider([TextDelta("x"), UsageEvent(1_000_000, 100_000), StopEvent("end_turn")])


def test_cost_known_price(mk):
    c, ct = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True}, providers={"anthropic": priced_provider()})
    u = dict(events_of(c, chat_body()))["usage"]
    assert u == {"input_tokens": 1_000_000, "output_tokens": 100_000, "cost_usd": 6.0, "cost_known": True}  # 4 + 2
    usage = c.get("/api/ai/usage").json()
    assert usage["cost_usd"] == 6.0 and usage["cost_known"] is True and usage["requests"] == 1
    assert usage["recent"][0]["cost_usd"] == 6.0 and set(usage["recent"][0]) == {"ts", "provider", "model", "input_tokens", "output_tokens", "cost_usd"}
    raw = (ct.settings.data_dir / "usage.jsonl").read_text()
    assert "content" not in raw and "Hallo" not in raw


def test_cost_unknown_price(mk):
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True}, providers={"anthropic": priced_provider()})
    u = dict(events_of(c, chat_body(model="claude-unbekannt-1")))["usage"]
    assert u["cost_usd"] is None and u["cost_known"] is False
    us = c.get("/api/ai/usage").json()
    assert us["cost_usd"] is None and us["cost_known"] is False and us["requests"] == 1 and us["input_tokens"] == 1_000_000


def test_haiku_over_100k_unknown(mk):
    _, ct = mk()
    assert ct.ledger.cost_for("anthropic", "claude-haiku-5-5", 50_000, 1000) is not None
    assert ct.ledger.cost_for("anthropic", "claude-haiku-5-5", 150_000, 1000) is None
    assert ct.ledger.cost_for("openai", "gpt-x", 1, 1) is None


def test_monthly_sum_and_limit_blocks_only_known(mk):
    c, ct = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True, "monthly_limit_usd": 5.0},
               providers={"anthropic": priced_provider()})
    assert c.post("/api/ai/chat", json=chat_body()).status_code == 200  # 6.0 USD verbraucht
    st = c.get("/api/ai/status").json()["usage"]
    assert st["limit_reached"] is True and st["limit_usd"] == 5.0 and st["cost_usd"] == 6.0
    r = c.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 402 and r.json()["error"]["code"] == "cost_limit_reached"
    c.put("/api/ai/settings", json={"block_on_limit": False})
    assert c.post("/api/ai/chat", json=chat_body()).status_code == 200
    assert ct.ledger.month_summary()["requests"] == 2


def test_limit_does_not_block_unknown_costs(mk):
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, ai={"enabled": True, "monthly_limit_usd": 0.5},
              providers={"anthropic": priced_provider()})
    for _i in range(2):
        assert c.post("/api/ai/chat", json=chat_body(model="claude-ohne-preis")).status_code == 200
    assert c.get("/api/ai/status").json()["usage"]["limit_reached"] is False


def test_month_boundary(tmp_path):
    from datetime import datetime, timezone
    from backend.services.usage_ledger import UsageLedger
    now = [datetime(2026, 10, 31, tzinfo=timezone.utc)]
    led = UsageLedger(tmp_path, make_settings(tmp_path).pricing_path, now=lambda: now[0])
    led.record("anthropic", "claude-opus-5-5", 1_000_000, 0)
    now[0] = datetime(2026, 11, 2, tzinfo=timezone.utc)
    led.record("anthropic", "claude-opus-5-5", 1_000_000, 0)
    assert led.month_summary()["month"] == "2026-11" and led.month_summary()["cost_usd"] == 4.0
    assert led.month_summary(month="2026-10")["requests"] == 1 and len(led.recent()) == 2


# ------------------------------------------------------------------ Admin: models/test
def test_models_configured_fallback_without_key(mk):
    c, _ = mk()
    r = c.get("/api/ai/models?provider=anthropic").json()
    assert r["source"] == "configured" and r["models"] == [{"id": "claude-opus-5-5", "display_name": None}] and r["error"]
    r = c.get("/api/ai/models?provider=openai").json()
    assert r["models"] == [] and r["source"] == "configured"
    assert c.get("/api/ai/models?provider=mock").status_code == 422
    assert c.get("/api/ai/models").status_code == 422


def test_models_live_and_error(mk):
    p = ScriptedProvider([])
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, providers={"anthropic": p})
    r = c.get("/api/ai/models?provider=anthropic").json()
    assert r == {"provider": "anthropic", "models": [{"id": "m-1", "display_name": "Model 1"}], "source": "live", "error": None}

    class Bad(ScriptedProvider):
        async def list_models(self):
            raise ProviderError(f"nein {SECRET} sk-abcdefgh12345")

    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, providers={"anthropic": Bad([])})
    r = c.get("/api/ai/models?provider=anthropic").json()
    assert r["source"] == "configured" and SECRET not in r["error"] and "abcdefgh12345" not in r["error"]


def test_test_endpoint(mk):
    c, _ = mk(settings_kw={"anthropic_api_key": SECRET}, providers={"anthropic": ScriptedProvider([])})
    r = c.post("/api/ai/test", json={"provider": "anthropic"}).json()
    assert r["ok"] is True and r["provider"] == "anthropic" and isinstance(r["latency_ms"], int)
    r = c.post("/api/ai/test", json={"provider": "openai"}).json()
    assert r["ok"] is False and "Schluessel" in r["detail"]
    assert c.post("/api/ai/test", json={"provider": "x"}).status_code == 422


# ------------------------------------------------------------------ HTTP-Haertung
def test_body_limit_413(mk):
    c, _ = mk(settings_kw={**MOCK, "max_body_bytes": 1000}, ai=ON_MOCK)
    r = c.post("/api/ai/chat", json=chat_body("x" * 2000))
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    # ohne Content-Length (chunked)
    def gen():
        yield b'{"messages": [{"role": "user", "content": "'
        yield b"x" * 2000
        yield b'"}]}'
    r = c.post("/api/ai/chat", content=gen(), headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert c.post("/api/ai/chat", json=chat_body("ok")).status_code == 200


def test_cors(mk):
    c, _ = mk()
    ok = c.options("/api/ai/status", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "PUT" in ok.headers["access-control-allow-methods"] and "DELETE" not in ok.headers["access-control-allow-methods"]
    bad = c.options("/api/ai/status", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers
    g = c.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in g.headers
    g = c.get("/api/health", headers={"Origin": "http://127.0.0.1:4173"})
    assert g.headers["access-control-allow-origin"] == "http://127.0.0.1:4173"


def test_trusted_host(mk):
    c, _ = mk()
    assert c.get("/api/health", headers={"host": "evil.example"}).status_code == 400
    assert c.get("/api/health", headers={"host": "127.0.0.1:8787"}).status_code == 200


# ------------------------------------------------------------------ Abbruch / Disconnect
async def test_service_cancel_closes_provider_and_records_usage(tmp_path):
    from backend.schemas import ChatRequest
    p = ScriptedProvider([UsageEvent(10, 2), TextDelta("a"), TextDelta("b"), ("sleep", 30), TextDelta("nie")])
    s = make_settings(tmp_path, anthropic_api_key=SECRET)
    app = create_app(s, lambda n, st: p)
    ct = app.state.container
    ct.store.update(__import__("backend.services.settings_store", fromlist=["x"]).AiSettingsUpdate(enabled=True))
    prepared = ct.service.prepare(ChatRequest.model_validate(chat_body()), "1.2.3.4")
    gen = prepared.events()
    seen = [await gen.__anext__(), await gen.__anext__()]
    assert [n for n, _ in seen] == ["meta", "delta"]
    await gen.aclose()
    assert p.closed and ct.ledger.month_summary()["input_tokens"] == 10


async def test_asgi_disconnect_closes_provider(tmp_path):
    p = ScriptedProvider([UsageEvent(7, 1), TextDelta("a"), ("sleep", 30), TextDelta("nie")])
    s = make_settings(tmp_path, anthropic_api_key=SECRET)
    app = create_app(s, lambda n, st: p)
    app.state.container.store.update(__import__("backend.services.settings_store", fromlist=["x"]).AiSettingsUpdate(enabled=True))
    body = json.dumps(chat_body()).encode()
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "path": "/api/ai/chat",
             "raw_path": b"/api/ai/chat", "query_string": b"", "scheme": "http", "server": ("testserver", 80),
             "client": ("9.9.9.9", 1), "root_path": "",
             "headers": [(b"host", b"testserver"), (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]}
    sent_first = asyncio.Event()
    state = {"n": 0}

    async def receive():
        state["n"] += 1
        if state["n"] == 1:
            return {"type": "http.request", "body": body, "more_body": False}
        await sent_first.wait()
        await asyncio.sleep(0.05)
        return {"type": "http.disconnect"}

    async def send(msg):
        if msg["type"] == "http.response.body" and msg.get("body"):
            sent_first.set()

    await asyncio.wait_for(app(scope, receive, send), timeout=5)
    assert p.closed
    assert app.state.container.ledger.month_summary()["input_tokens"] == 7
