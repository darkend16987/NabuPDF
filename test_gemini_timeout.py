"""Gemini must never be able to hang the sidecar: every HTTP request has a ceiling.

The google-genai default is `timeout=None` (wait forever). `GeminiAgent._generate` is a
synchronous call made from inside an `async def` route, so a half-open connection (Wi-Fi
dropped mid-request) froze the whole sidecar until the app was killed — and /health is
only polled at startup, so nothing noticed. src/agents/gemini_agent.py now passes
`HttpOptions(timeout=GEMINI_HTTP_TIMEOUT_MS)` (docs/REVIEW-2026-10-01 S2).

Three things are pinned:
  1. wiring    - the client really is built with that timeout (a refactor that drops the
                 `http_options=` argument would pass every other test);
  2. unit      - the constant is MILLISECONDS in a sane range (the SDK's unit trap:
                 writing 120 for "seconds" gives 120 ms and fails every request);
  3. behaviour - against a local server that accepts the connection and never answers,
                 the call raises within the timeout instead of hanging. A control run
                 WITHOUT the option shows the same server really does hang, so the check
                 can fail.

No network, no API key. Plain-runner style (no pytest). ASCII-only console output.
"""

import socket
import threading
import time

from src.agents.gemini_agent import GEMINI_HTTP_TIMEOUT_MS, GeminiAgent


class _StallServer:
    """Accepts TCP connections, reads whatever arrives, and never sends a byte back."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self._conns = []
        self._stop = False
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        self.sock.settimeout(0.2)
        while not self._stop:
            try:
                c, _ = self.sock.accept()
            except OSError:
                continue
            self._conns.append(c)  # keep it open, say nothing

    def close(self):
        self._stop = True
        for c in self._conns:
            try:
                c.close()
            except OSError:
                pass
        self.sock.close()


def test_client_is_built_with_the_timeout():
    import google.genai as genai

    seen = {}

    class FakeClient:
        def __init__(self, **kw):
            seen.update(kw)

    real = genai.Client
    genai.Client = FakeClient
    try:
        GeminiAgent(api_key="k").client
        assert "http_options" in seen, "Client was built without http_options - the SDK default is NO timeout"
        assert seen["http_options"].timeout == GEMINI_HTTP_TIMEOUT_MS, "default agent lost its HTTP timeout"
        seen.clear()
        GeminiAgent(api_key="k", http_timeout_ms=4321).client
        assert seen["http_options"].timeout == 4321, "explicit http_timeout_ms was not passed through"
    finally:
        genai.Client = real


def test_timeout_constant_is_milliseconds_in_a_sane_range():
    assert isinstance(GEMINI_HTTP_TIMEOUT_MS, int)
    assert 10_000 <= GEMINI_HTTP_TIMEOUT_MS <= 600_000, (
        f"{GEMINI_HTTP_TIMEOUT_MS}: the SDK unit is milliseconds - 10 s..10 min expected"
    )


def _client_against(server: _StallServer, timeout_ms):
    import google.genai as genai
    from google.genai import types

    agent = GeminiAgent(api_key="k")
    opts = types.HttpOptions(base_url=f"http://127.0.0.1:{server.port}", timeout=timeout_ms)
    agent._client = genai.Client(api_key="k", http_options=opts)
    return agent


def test_a_stalled_connection_raises_instead_of_hanging():
    server = _StallServer()
    try:
        # configuration under test: the agent's own options, only the URL is swapped
        agent = GeminiAgent(api_key="k", http_timeout_ms=1500)
        import google.genai as genai

        opts = agent._http_options()
        opts.base_url = f"http://127.0.0.1:{server.port}"
        agent._client = genai.Client(api_key="k", http_options=opts)

        t0 = time.perf_counter()
        try:
            agent._generate("hello")
        except Exception:
            pass
        else:
            raise AssertionError("a server that never answers must not look like success")
        took = time.perf_counter() - t0
        assert took < 10.0, f"took {took:.1f}s to give up on a 1.5 s timeout"
    finally:
        server.close()


def test_control_without_a_timeout_the_same_server_really_hangs():
    """If this did not hang, the test above would prove nothing."""
    server = _StallServer()
    try:
        agent = _client_against(server, timeout_ms=None)
        done = threading.Event()

        def call():
            try:
                agent._generate("hello")
            except Exception:
                pass
            done.set()

        threading.Thread(target=call, daemon=True).start()
        assert not done.wait(4.0), "control failed: the call returned without any timeout configured"
    finally:
        server.close()


if __name__ == "__main__":
    import sys

    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as e:  # AssertionError or anything unexpected: both are a failure
            failed += 1
            print("FAIL", name, "-", type(e).__name__, e)
    print("All gemini-timeout tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
