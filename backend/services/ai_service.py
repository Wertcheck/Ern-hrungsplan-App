"""Zentraler KI-Service: Provider-Wahl, Limits, Kontext, Streaming, Fallback, Usage."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

from ..ai.prompts import build_system_prompt
from ..ai.providers import registry
from ..ai.providers.base_provider import (
    BaseProvider,
    ProviderError,
    ProviderRequest,
    ProviderTimeout,
    StopEvent,
    TextDelta,
    ToolCall,
    UsageEvent,
)
from ..config.settings import Settings
from ..errors import ApiError
from ..schemas import ChatRequest
from ..security import redact
from .action_validator import TOOL_NAME, propose_actions_tool, validate_proposals
from .nutrition_context import render_context
from .rate_limiter import SlidingWindowLimiter
from .settings_store import AiSettings, SettingsStore
from .usage_ledger import UsageLedger

log = logging.getLogger(__name__)

SseEvent = tuple[str, dict]
ProviderFactory = Callable[[str, Settings], BaseProvider]


@dataclass
class Candidate:
    provider: str
    model: str


@dataclass
class _Run:
    meta_sent: bool = False
    output_started: bool = False
    tool_calls: list[ToolCall] = field(default_factory=list)
    in_tokens: int = 0
    out_tokens: int = 0
    cost: float = 0.0
    cost_known: bool = True
    got_usage: bool = False


class PreparedChat:
    def __init__(self, svc: "AiService", chat: ChatRequest, cfg: AiSettings, candidates: list[Candidate]):
        self.svc = svc
        self.chat = chat
        self.cfg = cfg
        self.candidates = candidates
        s = svc.settings
        hist = [{"role": m.role, "content": m.content} for m in chat.messages][-cfg.history_messages:]
        while hist and hist[0]["role"] != "user":
            hist.pop(0)
        self.messages = hist
        self.context_text = render_context(chat.context) if chat.context is not None else ""
        self.system = build_system_prompt(self.context_text or None)
        self.tools = [propose_actions_tool()] if (chat.tools_enabled and chat.context is not None) else []
        cap = min(cfg.max_output_tokens, s.max_output_tokens_cap)
        self.max_tokens = max(1, min(chat.max_output_tokens or cfg.max_output_tokens, cap))
        self.temperature = chat.temperature if chat.temperature is not None else cfg.temperature

    def _request(self, cand: Candidate) -> ProviderRequest:
        return ProviderRequest(
            model=cand.model,
            system=self.system,
            messages=self.messages,
            tools=self.tools,
            max_output_tokens=self.max_tokens,
            temperature=self.temperature,
            timeout_s=self.svc.settings.request_timeout_s,
        )

    def _meta(self, run: _Run, idx: int) -> list[SseEvent]:
        if run.meta_sent:
            return []
        run.meta_sent = True
        c = self.candidates[idx]
        return [("meta", {"provider": c.provider, "model": c.model, "fallback_used": idx > 0})]

    async def events(self) -> AsyncIterator[SseEvent]:
        svc = self.svc
        timeout = svc.settings.request_timeout_s
        run = _Run()
        error: ProviderError | None = None
        idx = 0
        try:
            for idx, cand in enumerate(self.candidates):
                usage = UsageEvent(0, 0)
                got = False
                attempt_tools: list[ToolCall] = []
                err: ProviderError | None = None
                try:
                    provider = svc.provider_factory(cand.provider, svc.settings)
                    async with aclosing(provider.stream(self._request(cand))) as stream:
                        it = stream.__aiter__()
                        while True:
                            try:
                                async with asyncio.timeout(timeout):
                                    ev = await it.__anext__()
                            except StopAsyncIteration:
                                break
                            except TimeoutError:
                                raise ProviderTimeout() from None
                            if isinstance(ev, TextDelta):
                                for e in self._meta(run, idx):
                                    yield e
                                run.output_started = True
                                yield ("delta", {"text": ev.text})
                            elif isinstance(ev, ToolCall):
                                run.output_started = True
                                attempt_tools.append(ev)
                            elif isinstance(ev, UsageEvent):
                                usage, got = ev, True
                            elif isinstance(ev, StopEvent):
                                pass
                except ProviderError as e:
                    err = e
                except Exception as e:  # unbekannt: keine Details nach aussen
                    log.error("Unerwarteter Fehler im Chat-Stream: %s", type(e).__name__)
                    err = ProviderError("Interner Fehler.", code="internal_error", retryable=False)
                finally:
                    # auch bei Abbruch/Client-Disconnect (synchron, daher cancel-sicher)
                    if got and (usage.input_tokens or usage.output_tokens):
                        cost = svc.ledger.record(cand.provider, cand.model, usage.input_tokens, usage.output_tokens)
                        run.got_usage = True
                        run.in_tokens += usage.input_tokens
                        run.out_tokens += usage.output_tokens
                        if cost is None:
                            run.cost_known = False
                        else:
                            run.cost += cost
                if err is None:
                    run.tool_calls.extend(attempt_tools)
                    break
                if not run.output_started and idx + 1 < len(self.candidates):
                    log.info("Fallback von %s auf %s (%s)", cand.provider, self.candidates[idx + 1].provider, err.code)
                    continue
                error = err
                break

            for e in self._meta(run, idx):
                yield e
            if run.tool_calls and error is None:
                proposals: list = []
                bad: list[dict] = []
                for tc in run.tool_calls:
                    if tc.name != TOOL_NAME:
                        bad.append({"type": "unknown", "reason": "Unbekanntes Werkzeug"})
                        continue
                    ok, rej = validate_proposals(tc.input.get("proposals") if isinstance(tc.input, dict) else None, self.chat.context)
                    proposals += ok
                    bad += rej
                if proposals or bad:
                    yield ("actions", {"proposals": proposals, "rejected": bad})
            if run.got_usage:
                yield ("usage", {
                    "input_tokens": run.in_tokens,
                    "output_tokens": run.out_tokens,
                    "cost_usd": round(run.cost, 6) if run.cost_known else None,
                    "cost_known": run.cost_known,
                })
            if error is not None:
                yield ("error", {"code": error.code, "message": redact(error.message), "retryable": error.retryable})
            yield ("done", {})
        finally:
            pass


class AiService:
    def __init__(self, settings: Settings, store: SettingsStore, ledger: UsageLedger,
                 limiter: SlidingWindowLimiter, provider_factory: ProviderFactory | None = None):
        self.settings = settings
        self.store = store
        self.ledger = ledger
        self.limiter = limiter
        self.provider_factory = provider_factory or registry.create_provider

    # ---------------------------------------------------------------- Hilfen
    def is_configured(self, name: str) -> bool:
        return registry.is_configured(name, self.settings)

    def resolve_model(self, name: str, cfg: AiSettings, override: str | None = None) -> str | None:
        if override:
            return override
        if name in ("openai", "anthropic"):
            return getattr(cfg.models, name) or self.settings.default_model(name)
        return self.settings.default_model(name)

    # ---------------------------------------------------------------- Chat
    def prepare(self, chat: ChatRequest, client_ip: str) -> PreparedChat:
        cfg = self.store.load()
        if not cfg.enabled:
            raise ApiError(403, "ai_disabled", "KI-Funktionen sind deaktiviert. Aktiviere sie in den KI-Einstellungen.")
        retry = self.limiter.check(client_ip)
        if retry is not None:
            raise ApiError(429, "rate_limited", "Zu viele Anfragen. Bitte kurz warten.", {"Retry-After": str(retry)})
        name = chat.provider or cfg.provider
        if not self.is_configured(name):
            raise ApiError(503, "provider_not_configured",
                           f"Anbieter '{name}' ist nicht konfiguriert (API-Schluessel in backend/.env eintragen).")
        model = self.resolve_model(name, cfg, chat.model)
        if not model:
            raise ApiError(503, "needs_model", f"Fuer '{name}' ist kein Modell gewaehlt. Bitte in den KI-Einstellungen ein Modell waehlen.")
        usage = self.ledger.month_summary(cfg.monthly_limit_usd)
        if cfg.block_on_limit and usage["limit_reached"]:
            raise ApiError(402, "cost_limit_reached", "Das monatliche Kostenlimit ist erreicht.")
        candidates = [Candidate(name, model)]
        fb = cfg.fallback_provider
        if cfg.auto_fallback and fb and fb != name and self.is_configured(fb):
            fb_model = self.resolve_model(fb, cfg)
            if fb_model:
                candidates.append(Candidate(fb, fb_model))
        return PreparedChat(self, chat, cfg, candidates)

    # ---------------------------------------------------------------- Admin
    def status(self) -> dict:
        cfg = self.store.load()
        active = cfg.provider
        model = self.resolve_model(active, cfg)
        return {
            "enabled": cfg.enabled,
            "provider": cfg.provider,
            "model": model,
            "needs_model": model is None,
            "providers": {
                "openai": {"configured": self.is_configured("openai"), "default_model": self.settings.default_model("openai")},
                "anthropic": {"configured": self.is_configured("anthropic"), "default_model": self.settings.default_model("anthropic")},
                "mock": {"configured": self.is_configured("mock")},
            },
            "fallback_provider": cfg.fallback_provider,
            "auto_fallback": cfg.auto_fallback,
            "usage": self.ledger.month_summary(cfg.monthly_limit_usd),
            "limits": {
                "max_history_cap": self.settings.max_history_cap,
                "max_output_tokens_cap": self.settings.max_output_tokens_cap,
                "rate_limit_per_min": self.settings.rate_limit_per_min,
            },
        }

    def usage(self) -> dict:
        cfg = self.store.load()
        return {**self.ledger.month_summary(cfg.monthly_limit_usd), "recent": self.ledger.recent(50)}

    async def list_models(self, name: str) -> dict:
        cfg = self.store.load()
        fallback_ids = [m for m in dict.fromkeys([self.settings.default_model(name), getattr(cfg.models, name, None)]) if m]
        configured = {"provider": name, "models": [{"id": m, "display_name": None} for m in fallback_ids],
                      "source": "configured"}
        if not self.is_configured(name):
            return {**configured, "error": "Kein API-Schluessel konfiguriert (backend/.env)."}
        try:
            async with asyncio.timeout(20):
                models = await self.provider_factory(name, self.settings).list_models()
            return {"provider": name, "models": [{"id": m.id, "display_name": m.display_name} for m in models],
                    "source": "live", "error": None}
        except ProviderError as e:
            return {**configured, "error": redact(e.message)}
        except TimeoutError:
            return {**configured, "error": "Zeitueberschreitung beim Abruf der Modellliste."}
        except Exception as e:
            log.error("Modellliste fehlgeschlagen: %s", type(e).__name__)
            return {**configured, "error": "Modellliste nicht abrufbar."}

    async def test(self, name: str) -> dict:
        t0 = time.perf_counter()

        def out(ok: bool, detail: str | None) -> dict:
            return {"ok": ok, "provider": name, "latency_ms": int((time.perf_counter() - t0) * 1000), "detail": detail}

        if not self.is_configured(name):
            return out(False, "Kein API-Schluessel konfiguriert (backend/.env)." if name != "mock" else "Mock-Provider ist nicht aktiviert.")
        try:
            async with asyncio.timeout(20):
                detail = await self.provider_factory(name, self.settings).ping()
            return out(True, detail)
        except ProviderError as e:
            return out(False, redact(e.message))
        except TimeoutError:
            return out(False, "Zeitueberschreitung.")
        except Exception as e:
            log.error("Verbindungstest fehlgeschlagen: %s", type(e).__name__)
            return out(False, "Verbindungstest fehlgeschlagen.")
