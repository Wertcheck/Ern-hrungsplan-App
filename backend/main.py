"""FastAPI-App (lokal, 127.0.0.1). create_app() ist fuer Tests parametrierbar."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api import ai_admin, chat, health
from .config.settings import Settings
from .container import Container
from .errors import ApiError
from .security import install_log_redaction, set_known_secrets
from .services.ai_service import AiService, ProviderFactory
from .services.rate_limiter import SlidingWindowLimiter
from .services.settings_store import SettingsStore
from .services.usage_ledger import UsageLedger

log = logging.getLogger(__name__)


class BodyLimitMiddleware:
    """Begrenzt Request-Bodies (413). Puffert max. max_body_bytes."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max = max_bytes

    async def _reject(self, send):
        body = b'{"error":{"code":"payload_too_large","message":"Anfrage zu gross."}}'
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            return await self.app(scope, receive, send)
        for k, v in scope["headers"]:
            if k == b"content-length":
                try:
                    if int(v) > self.max:
                        return await self._reject(send)
                except ValueError:
                    return await self._reject(send)
        chunks: list[bytes] = []
        total = 0
        while True:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                return
            total += len(msg.get("body", b""))
            if total > self.max:
                return await self._reject(send)
            chunks.append(msg.get("body", b""))
            if not msg.get("more_body"):
                break
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()  # danach: echte Disconnect-Signale

        await self.app(scope, replay, send)


def create_app(settings: Settings | None = None, provider_factory: ProviderFactory | None = None) -> FastAPI:
    settings = settings or Settings()
    install_log_redaction()
    set_known_secrets(settings.secret_values())

    store = SettingsStore(settings.data_dir, settings.max_output_tokens_cap, settings.max_history_cap)
    ledger = UsageLedger(settings.data_dir, settings.pricing_path)
    limiter = SlidingWindowLimiter(settings.rate_limit_per_min)
    service = AiService(settings, store, ledger, limiter, provider_factory)

    app = FastAPI(title="Ernaehrungsplan KI-Backend", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.container = Container(settings, store, ledger, service)

    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_body_bytes)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse(exc.body(), status_code=exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        details = [{"loc": [str(x) for x in e["loc"]], "msg": str(e["msg"])[:200]} for e in exc.errors()]
        return JSONResponse({"error": {"code": "validation_error", "message": "Ungueltige Anfrage.", "details": details}},
                            status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, f"http_{exc.status_code}")
        return JSONResponse({"error": {"code": code, "message": "Anfrage nicht moeglich."}}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unknown(_: Request, exc: Exception):
        log.error("Unbehandelter Fehler: %s", type(exc).__name__)
        return JSONResponse({"error": {"code": "internal_error", "message": "Interner Fehler."}}, status_code=500)

    app.include_router(health.router)
    app.include_router(ai_admin.router)
    app.include_router(chat.router)
    return app


app = create_app()
