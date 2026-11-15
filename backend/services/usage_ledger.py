"""Nutzungs-/Kostenprotokoll als JSONL. Speichert nie Nachrichteninhalte."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UsageLedger:
    def __init__(self, data_dir: Path, pricing_path: Path, now: Callable[[], datetime] = _utcnow):
        self.path = Path(data_dir) / "usage.jsonl"
        self.pricing_path = Path(pricing_path)
        self._now = now
        self._lock = threading.Lock()

    # ---- Preise
    def _pricing(self) -> dict:
        try:
            return json.loads(self.pricing_path.read_text(encoding="utf-8")).get("per_million_tokens", {})
        except (OSError, ValueError):
            return {}

    def cost_for(self, provider: str, model: str, input_tokens: int, output_tokens: int) -> float | None:
        entry = self._pricing().get(f"{provider}:{model}")
        if not isinstance(entry, dict):
            return None
        try:
            cap = entry.get("max_prompt_tokens")
            if cap is not None and input_tokens > cap:
                return None
            return round(input_tokens / 1e6 * float(entry["input"]) + output_tokens / 1e6 * float(entry["output"]), 6)
        except (KeyError, TypeError, ValueError):
            return None

    # ---- Schreiben/Lesen
    def record(self, provider: str, model: str, input_tokens: int, output_tokens: int) -> float | None:
        cost = self.cost_for(provider, model, input_tokens, output_tokens)
        row = {
            "ts": self._now().isoformat(timespec="seconds"),
            "provider": provider,
            "model": model,
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "cost_usd": cost,
        }
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return cost

    def _rows(self) -> list[dict]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        rows = []
        for ln in lines:
            try:
                r = json.loads(ln)
                if isinstance(r, dict) and isinstance(r.get("ts"), str):
                    rows.append(r)
            except ValueError:
                continue
        return rows

    def month_summary(self, limit_usd: float | None = None, month: str | None = None) -> dict:
        month = month or self._now().strftime("%Y-%m")
        rows = [r for r in self._rows() if r["ts"][:7] == month]
        priced = [r["cost_usd"] for r in rows if isinstance(r.get("cost_usd"), (int, float))]
        unpriced = len(rows) - len(priced)
        cost_usd = round(sum(priced), 6) if priced else (None if unpriced else 0.0)
        return {
            "month": month,
            "requests": len(rows),
            "input_tokens": sum(int(r.get("input_tokens") or 0) for r in rows),
            "output_tokens": sum(int(r.get("output_tokens") or 0) for r in rows),
            "cost_usd": cost_usd,
            "cost_known": unpriced == 0,
            "limit_usd": limit_usd,
            # Limit gilt nur auf Basis bekannter Kosten.
            "limit_reached": bool(limit_usd is not None and cost_usd is not None and cost_usd >= limit_usd),
        }

    def recent(self, n: int = 50) -> list[dict]:
        keys = ("ts", "provider", "model", "input_tokens", "output_tokens", "cost_usd")
        rows = self._rows()[-n:]
        return [{k: r.get(k) for k in keys} for r in reversed(rows)]
