import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayload,
  earlyPayloadFor,
  isValidCdpPageTarget,
  parseArgs,
  processIsAlive,
  removeOwnedState,
  stateBelongsToWatcher,
  statusOf,
  validatedDebuggerUrl,
} from "../scripts/injector.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const port = 54321;
const validTarget = {
  id: "page-ABC_123",
  type: "page",
  url: "app://-/index.html",
  webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-ABC_123`,
};

test("accepts only loopback app page targets with matching IDs", () => {
  assert.equal(isValidCdpPageTarget(validTarget, port), true);
  assert.equal(validatedDebuggerUrl(validTarget, port), validTarget.webSocketDebuggerUrl);
  assert.equal(isValidCdpPageTarget({ ...validTarget, url: "https://example.com" }, port), false);
  assert.equal(isValidCdpPageTarget({ ...validTarget, url: "app://unexpected/index.html" }, port), false);
  assert.equal(
    isValidCdpPageTarget({ ...validTarget, url: "app://-/index.html?initialRoute=%2Fold" }, port),
    false,
  );
  assert.equal(isValidCdpPageTarget({ ...validTarget, type: "worker" }, port), false);
  assert.equal(isValidCdpPageTarget({ ...validTarget, id: "different" }, port), false);
});

test("rejects non-loopback, credentials, queries, and wrong ports", () => {
  const rejected = [
    `ws://0.0.0.0:${port}/devtools/page/page-ABC_123`,
    `ws://192.168.1.2:${port}/devtools/page/page-ABC_123`,
    `ws://user:pass@127.0.0.1:${port}/devtools/page/page-ABC_123`,
    `ws://127.0.0.1:${port + 1}/devtools/page/page-ABC_123`,
    `ws://127.0.0.1:${port}/devtools/page/page-ABC_123?token=x`,
  ];
  for (const webSocketDebuggerUrl of rejected) {
    assert.equal(isValidCdpPageTarget({ ...validTarget, webSocketDebuggerUrl }, port), false);
  }
});

test("parses a single mode and valid dynamic port", () => {
  assert.deepEqual(parseArgs(["--status", "--port", String(port)]), {
    mode: "status",
    port,
    timeoutMs: 15000,
    chatgptPid: null,
    fontEnabled: true,
    zoomEnabled: true,
  });
  assert.deepEqual(
    parseArgs([
      "--once",
      "--port",
      String(port),
      "--font-enabled",
      "false",
      "--zoom-enabled",
      "true",
    ]),
    {
      mode: "once",
      port,
      timeoutMs: 15000,
      chatgptPid: null,
      fontEnabled: false,
      zoomEnabled: true,
    },
  );
  assert.throws(
    () => parseArgs(["--once", "--port", String(port), "--font-enabled", "1"]),
    /font-enabled/,
  );
  assert.throws(
    () => parseArgs(["--once", "--port", String(port), "--zoom-enabled", "TRUE"]),
    /zoom-enabled/,
  );
  assert.throws(() => parseArgs(["--status", "--port", "80"]), /valid --port/);
  assert.throws(() => parseArgs(["--port", String(port)]), /Choose/);
  assert.throws(
    () => parseArgs(["--status", "--once", "--port", String(port)]),
    /exactly one mode/,
  );
});

test("accepts a ChatGPT PID only for watcher mode", () => {
  assert.deepEqual(parseArgs(["--watch", "--port", String(port), "--chatgpt-pid", "123"]), {
    mode: "watch",
    port,
    timeoutMs: 15000,
    chatgptPid: 123,
    fontEnabled: true,
    zoomEnabled: true,
  });
  assert.throws(
    () => parseArgs(["--status", "--port", String(port), "--chatgpt-pid", "123"]),
    /only valid with --watch/,
  );
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(-1), false);
});

test("early payload waits for both current ChatGPT shell markers", () => {
  const payload = earlyPayloadFor("window.__installed = true", "revision-1");
  assert.match(payload, /main\[data-app-shell-main-surface\]/);
  assert.doesNotMatch(payload, /main\.main-surface/);
  assert.match(payload, /aside\.app-shell-left-panel/);
  assert.match(payload, /MutationObserver/);
  assert.match(payload, /revision-1/);
});

test("payload revision includes both feature switches", async () => {
  const bothEnabled = await buildPayload({ fontEnabled: true, zoomEnabled: true });
  const fontDisabled = await buildPayload({ fontEnabled: false, zoomEnabled: true });
  const zoomDisabled = await buildPayload({ fontEnabled: true, zoomEnabled: false });

  assert.notEqual(bothEnabled.revision, fontDisabled.revision);
  assert.notEqual(bothEnabled.revision, zoomDisabled.revision);
  for (const built of [bothEnabled, fontDisabled, zoomDisabled]) {
    assert.doesNotMatch(
      built.payload,
      /__CHATGPT_RESTYLE_(?:FONT|ZOOM)_ENABLED_JSON__/,
    );
  }
});

test("status reports the current content zoom and defaults to 100 when absent", async () => {
  const statusSession = (state) => ({
    evaluate(expression) {
      return vm.runInNewContext(expression, {
        window: { __CHATGPT_CHAT_TYPOGRAPHY_STATE__: state },
        document: {
          querySelector() { return {}; },
          querySelectorAll() { return []; },
        },
      });
    },
  });

  const installed = await statusOf(statusSession({
    contentZoomPercent: 130,
    fontEnabled: true,
    zoomEnabled: false,
    fontAvailable: true,
    nativeFontFamily: "system-ui",
    version: "revision-1",
  }));
  assert.equal(installed.contentZoomPercent, 130);
  assert.equal(installed.installed, true);
  assert.equal(installed.fontEnabled, true);
  assert.equal(installed.zoomEnabled, false);

  const fontDisabled = await statusOf(statusSession({
    contentZoomPercent: 120,
    fontEnabled: false,
    zoomEnabled: true,
    fontAvailable: true,
  }));
  assert.equal(fontDisabled.fontAvailable, null);

  const absent = await statusOf(statusSession(undefined));
  assert.equal(absent.contentZoomPercent, 100);
  assert.equal(absent.installed, false);
  assert.equal(absent.fontEnabled, false);
  assert.equal(absent.zoomEnabled, false);
});

test("removes runtime state only when it belongs to the exiting watcher", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-restyle-watcher-"));
  const statePath = path.join(temporary, "state.json");
  const pid = 43210;
  try {
    assert.equal(stateBelongsToWatcher({ injectorPid: pid, port }, pid, port), true);
    assert.equal(stateBelongsToWatcher({ injectorPid: pid + 1, port }, pid, port), false);

    await fs.writeFile(statePath, JSON.stringify({ injectorPid: pid + 1, port }), { mode: 0o600 });
    assert.equal(await removeOwnedState(statePath, pid, port), false);
    await fs.access(statePath);

    await fs.writeFile(statePath, JSON.stringify({ injectorPid: pid, port }), { mode: 0o600 });
    assert.equal(await removeOwnedState(statePath, pid, port), true);
    await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
