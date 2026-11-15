"""Redaction von Geheimnissen fuer Logs und Fehlertexte."""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable

_REDACTED = "[REDACTED]"

_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{4,}")
_SK_ANT = re.compile(r"sk-ant-[A-Za-z0-9_\-]{4,}")
_SK = re.compile(r"sk-[A-Za-z0-9_\-]{6,}")
_HEADER = re.compile(
    r"(?i)\b(x-api-key|api[_-]?key|authorization|proxy-authorization)(\s*[\"']?\s*[:=]\s*[\"']?)[^\s,;\"'}]+"
)

_known_secrets: set[str] = set()


def set_known_secrets(values: Iterable[str]) -> None:
    """Registriert exakte Geheimnis-Werte (nie ausgegeben), die zusaetzlich geschwaerzt werden."""
    _known_secrets.clear()
    for v in values:
        if v and len(v.strip()) >= 4:
            _known_secrets.add(v.strip())


def redact(text: object) -> str:
    s = text if isinstance(text, str) else str(text)
    for secret in sorted(_known_secrets, key=len, reverse=True):
        s = s.replace(secret, _REDACTED)
    s = _BEARER.sub(_REDACTED, s)
    s = _SK_ANT.sub(_REDACTED, s)
    s = _SK.sub(_REDACTED, s)
    s = _HEADER.sub(lambda m: f"{m.group(1)}{m.group(2)}{_REDACTED}", s)
    return s


_factory_installed = False


def install_log_redaction() -> None:
    """Wickelt die LogRecord-Factory: jede Lognachricht wird vor der Ausgabe geschwaerzt."""
    global _factory_installed
    if _factory_installed:
        return
    old = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        record = old(*args, **kwargs)
        try:
            msg = record.getMessage()
        except Exception:
            msg = str(record.msg)
        clean = redact(msg)
        if clean != msg:  # nur anfassen, wenn etwas geschwaerzt wurde (Formatter wie uvicorn brauchen args)
            record.msg = clean
            record.args = ()
        return record

    logging.setLogRecordFactory(factory)
    _factory_installed = True
