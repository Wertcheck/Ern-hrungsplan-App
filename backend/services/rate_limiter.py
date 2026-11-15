"""Sliding-Window-Rate-Limit pro Client-IP (in-memory)."""

from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_s: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def check(self, key: str) -> int | None:
        """None = erlaubt (Treffer wird gezaehlt); sonst Sekunden bis zum naechsten freien Slot."""
        if self.limit <= 0:
            return None
        now = self._clock()
        if len(self._hits) > 1000:
            for k in [k for k, q in self._hits.items() if not q or now - q[-1] >= self.window_s]:
                del self._hits[k]
        q = self._hits.setdefault(key, deque())
        while q and now - q[0] >= self.window_s:
            q.popleft()
        if len(q) >= self.limit:
            return max(1, math.ceil(self.window_s - (now - q[0])))
        q.append(now)
        return None
