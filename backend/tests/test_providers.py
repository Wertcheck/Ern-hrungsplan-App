from __future__ import annotations

import anthropic
import httpx
import openai
import pytest

from backend.ai.providers import registry
from backend.ai.providers.anthropic_provider import AnthropicProvider, rejects_sampling_params
from backend.ai.providers.base_provider import (
    AuthError, BadRequestError, ProviderRefusal, ProviderRequest, ProviderTimeout, ProviderUnavailable,
    RateLimitError, StopEvent, TextDelta, ToolCall, ToolSpec, UsageEvent,
)
from backend.ai.providers.openai_provider import OpenAIProvider

from .conftest import ns

REQ = httpx.Request("POST", "http://x")


def resp(status):
    return httpx.Response(status, request=REQ)


def req(model="claude-opus-5-5", **kw):
    return ProviderRequest(model=model, system="sys", messages=[{"role": "user", "content": "hi"}], **kw)


async def collect(gen):
    return [e async for e in gen]


class Awaitable:
    def __init__(self, items):
        self.items = items

    def __await__(self):
        async def _f():
            return self
        return _f().__await__()

    async def __aiter__(self):
        for i in self.items:
            yield i


# ------------------------------------------------------------ Anthropic fakes
class FakeAStream:
    def __init__(self, events, final, enter_exc=None):
        self.events, self.final, self.enter_exc, self.closed = events, final, enter_exc, False

    async def __aenter__(self):
        if self.enter_exc:
            raise self.enter_exc
        return self

    async def __aexit__(self, *a):
        self.closed = True

    async def __aiter__(self):
        for e in self.events:
            yield e

    async def get_final_message(self):
        return self.final


class FakeAClient:
    def __init__(self, behaviours, models=None):
        self.behaviours, self.calls = list(behaviours), []
        self.messages = ns(stream=self._stream)
        self.models = ns(list=lambda **kw: Awaitable(models or []))

    def _stream(self, **kw):
        self.calls.append(kw)
        return self.behaviours.pop(0)


def usage(i=0, o=0):
    return ns(input_tokens=i, output_tokens=o)


def a_events(*texts):
    ev = [ns(type="message_start", message=ns(usage=usage(11, 1)))]
    ev += [ns(type="content_block_delta", delta=ns(type="text_delta", text=t)) for t in texts]
    ev.append(ns(type="message_delta", usage=usage(0, 7), delta=ns(stop_reason="end_turn")))
    return ev


def a_final(content=(), stop="end_turn", i=11, o=7):
    return ns(content=list(content), usage=usage(i, o), stop_reason=stop)


async def test_anthropic_text_usage_stop():
    c = FakeAClient([FakeAStream(a_events("Hal", "lo"), a_final())])
    ev = await collect(AnthropicProvider(client=c).stream(req()))
    assert [e.text for e in ev if isinstance(e, TextDelta)] == ["Hal", "lo"]
    usages = [e for e in ev if isinstance(e, UsageEvent)]
    assert usages[-1] == UsageEvent(11, 7)
    assert ev[-1] == StopEvent("end_turn")
    kw = c.calls[0]
    assert kw["model"] == "claude-opus-5-5" and kw["max_tokens"] == 1024 and "temperature" not in kw
    assert "tool_choice" not in kw and "thinking" not in kw


async def test_anthropic_tool_call_and_spec():
    tool = ns(type="tool_use", name="propose_actions", input={"proposals": []}, id="t1")
    c = FakeAClient([FakeAStream([], a_final([tool], "tool_use"))])
    spec = ToolSpec("propose_actions", "d", {"type": "object", "properties": {}})
    ev = await collect(AnthropicProvider(client=c).stream(req(tools=[spec])))
    assert ToolCall("propose_actions", {"proposals": []}, "t1") in ev
    assert ev[-1] == StopEvent("tool_use")
    assert c.calls[0]["tools"][0]["input_schema"] == spec.parameters


async def test_anthropic_refusal():
    c = FakeAClient([FakeAStream([], a_final(stop="refusal"))])
    with pytest.raises(ProviderRefusal):
        await collect(AnthropicProvider(client=c).stream(req()))


@pytest.mark.parametrize("model,expected", [
    ("claude-opus-5-5", True), ("claude-sonnet-5-5", True), ("claude-haiku-5-5", True), ("claude-fable-5-2", True),
    ("claude-opus-4-8", True), ("claude-sonnet-4-6", True), ("claude-opus-4-5", False),
    ("claude-sonnet-4-20250514", False), ("claude-3-5-sonnet-20241022", False)])
def test_sampling_rule(model, expected):
    assert rejects_sampling_params(model) is expected


async def test_anthropic_temperature_only_for_old_models():
    c = FakeAClient([FakeAStream([], a_final()), FakeAStream([], a_final())])
    p = AnthropicProvider(client=c)
    await collect(p.stream(req("claude-opus-5-5", temperature=0.5)))
    await collect(p.stream(req("claude-opus-4-5", temperature=0.5)))
    assert "temperature" not in c.calls[0] and c.calls[1]["temperature"] == 0.5


async def test_anthropic_temperature_retry_once():
    bad = anthropic.BadRequestError("x", response=resp(400), body=None)
    bad.message = "temperature: not supported"
    c = FakeAClient([FakeAStream([], None, enter_exc=bad), FakeAStream(a_events("ok"), a_final())])
    ev = await collect(AnthropicProvider(client=c).stream(req("claude-opus-4-5", temperature=0.3)))
    assert len(c.calls) == 2 and "temperature" not in c.calls[1] and any(isinstance(e, TextDelta) for e in ev)
    # zweiter Fehler wird nicht erneut wiederholt
    c2 = FakeAClient([FakeAStream([], None, enter_exc=bad), FakeAStream([], None, enter_exc=bad)])
    with pytest.raises(BadRequestError):
        await collect(AnthropicProvider(client=c2).stream(req("claude-opus-4-5", temperature=0.3)))
    assert len(c2.calls) == 2


@pytest.mark.parametrize("exc,cls,retry", [
    (anthropic.AuthenticationError("x", response=resp(401), body=None), AuthError, False),
    (anthropic.RateLimitError("x", response=resp(429), body=None), RateLimitError, True),
    (anthropic.InternalServerError("x", response=resp(529), body=None), ProviderUnavailable, True),
    (anthropic.APITimeoutError(request=REQ), ProviderTimeout, True),
    (anthropic.APIConnectionError(request=REQ), ProviderUnavailable, True),
    (anthropic.BadRequestError("zu lang", response=resp(400), body=None), BadRequestError, False),
])
async def test_anthropic_error_mapping(exc, cls, retry):
    c = FakeAClient([FakeAStream([], None, enter_exc=exc)])
    with pytest.raises(cls) as ei:
        await collect(AnthropicProvider(client=c).stream(req()))
    assert ei.value.retryable is retry


async def test_anthropic_cancel_closes_stream():
    s = FakeAStream(a_events("a", "b", "c"), a_final())
    gen = AnthropicProvider(client=FakeAClient([s])).stream(req())
    async for e in gen:
        if isinstance(e, TextDelta):
            break
    await gen.aclose()
    assert s.closed


async def test_anthropic_list_models_and_ping():
    c = FakeAClient([], models=[ns(id="claude-a", display_name="A"), ns(id="claude-b", display_name="B")])
    p = AnthropicProvider(client=c)
    assert [(m.id, m.display_name) for m in await p.list_models()] == [("claude-a", "A"), ("claude-b", "B")]
    assert await p.ping() is None


# ------------------------------------------------------------ OpenAI fakes
class FakeOStream:
    def __init__(self, chunks):
        self.chunks, self.closed = chunks, False

    async def __aiter__(self):
        for c in self.chunks:
            yield c

    async def close(self):
        self.closed = True


class FakeOClient:
    def __init__(self, behaviours, models=()):
        self.behaviours, self.calls = list(behaviours), []
        self.chat = ns(completions=ns(create=self._create))
        self.models = ns(list=lambda **kw: Awaitable(list(models)))

    async def _create(self, **kw):
        self.calls.append(kw)
        b = self.behaviours.pop(0)
        if isinstance(b, BaseException):
            raise b
        return b


def chunk(content=None, tool_calls=None, finish=None, usage=None, refusal=None, choices=True):
    ch = [ns(delta=ns(content=content, tool_calls=tool_calls, refusal=refusal), finish_reason=finish)] if choices else []
    return ns(choices=ch, usage=usage)


def tc(index, id=None, name=None, args=None):
    return ns(index=index, id=id, function=ns(name=name, arguments=args))


async def test_openai_text_usage_kwargs():
    s = FakeOStream([chunk("Hal"), chunk("lo"), chunk(finish="stop"),
                     chunk(choices=False, usage=ns(prompt_tokens=9, completion_tokens=4))])
    c = FakeOClient([s])
    ev = await collect(OpenAIProvider(client=c).stream(req("any-model", max_output_tokens=500, temperature=0.2)))
    assert [e.text for e in ev if isinstance(e, TextDelta)] == ["Hal", "lo"]
    assert UsageEvent(9, 4) in ev and ev[-1] == StopEvent("stop")
    kw = c.calls[0]
    assert kw["stream"] is True and kw["stream_options"] == {"include_usage": True}
    assert kw["max_completion_tokens"] == 500 and "max_tokens" not in kw and kw["temperature"] == 0.2
    assert kw["messages"][0] == {"role": "system", "content": "sys"}
    assert s.closed


async def test_openai_tool_call_accumulation():
    s = FakeOStream([
        chunk(tool_calls=[tc(0, "c1", "propose_actions", '{"proposals": [{"ty')]),
        chunk(tool_calls=[tc(0, None, None, 'pe": "exclude_food", "food_name": "X"}]}')]),
        chunk(finish="tool_calls")])
    spec = ToolSpec("propose_actions", "d", {"type": "object"})
    c = FakeOClient([s])
    ev = await collect(OpenAIProvider(client=c).stream(req("m", tools=[spec])))
    calls = [e for e in ev if isinstance(e, ToolCall)]
    assert calls == [ToolCall("propose_actions", {"proposals": [{"type": "exclude_food", "food_name": "X"}]}, "c1")]
    assert c.calls[0]["tools"][0]["function"]["name"] == "propose_actions"
    assert ev[-1] == StopEvent("tool_calls")


async def test_openai_refusal_content_filter():
    c = FakeOClient([FakeOStream([chunk("x", finish="content_filter")])])
    with pytest.raises(ProviderRefusal):
        await collect(OpenAIProvider(client=c).stream(req("m")))


async def test_openai_temperature_retry():
    bad = openai.BadRequestError("x", response=resp(400), body=None)
    bad.message = "Unsupported value: 'temperature' does not support 0.3"
    c = FakeOClient([bad, FakeOStream([chunk("ok", finish="stop")])])
    ev = await collect(OpenAIProvider(client=c).stream(req("m", temperature=0.3)))
    assert len(c.calls) == 2 and "temperature" not in c.calls[1] and any(isinstance(e, TextDelta) for e in ev)


@pytest.mark.parametrize("exc,cls,retry", [
    (openai.AuthenticationError("x", response=resp(401), body=None), AuthError, False),
    (openai.RateLimitError("x", response=resp(429), body=None), RateLimitError, True),
    (openai.RateLimitError("insufficient_quota", response=resp(429), body=None), RateLimitError, False),
    (openai.InternalServerError("x", response=resp(503), body=None), ProviderUnavailable, True),
    (openai.APITimeoutError(request=REQ), ProviderTimeout, True),
    (openai.APIConnectionError(request=REQ), ProviderUnavailable, True),
    (openai.BadRequestError("nope", response=resp(400), body=None), BadRequestError, False),
])
async def test_openai_error_mapping(exc, cls, retry):
    c = FakeOClient([exc])
    with pytest.raises(cls) as ei:
        await collect(OpenAIProvider(client=c).stream(req("m")))
    assert ei.value.retryable is retry


async def test_openai_midstream_error_mapped():
    class Boom(FakeOStream):
        async def __aiter__(self):
            yield chunk("a")
            raise openai.APIConnectionError(request=REQ)

    s = Boom([])
    with pytest.raises(ProviderUnavailable):
        await collect(OpenAIProvider(client=FakeOClient([s])).stream(req("m")))
    assert s.closed


async def test_openai_cancel_closes_stream():
    s = FakeOStream([chunk("a"), chunk("b"), chunk("c")])
    gen = OpenAIProvider(client=FakeOClient([s])).stream(req("m"))
    async for e in gen:
        break
    await gen.aclose()
    assert s.closed


async def test_openai_list_models_filters_non_chat():
    c = FakeOClient([], models=[ns(id="gpt-x"), ns(id="text-embedding-z"), ns(id="gpt-y")])
    ids = [m.id for m in await OpenAIProvider(client=c).list_models()]
    assert ids == ["gpt-x", "gpt-y"]


def test_registry():
    assert set(registry.PROVIDERS) == {"openai", "anthropic", "mock"}
