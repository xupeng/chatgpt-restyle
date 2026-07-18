import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = path.join(root, "scripts", "common-macos.sh");

function withConfig(t, contents) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-restyle-port-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  if (contents !== null) fs.writeFileSync(path.join(projectRoot, ".env"), contents);
  return projectRoot;
}

function runPortScript(projectRoot, body) {
  return spawnSync("/bin/bash", ["-c", `
    source "$1"
    PROJECT_ROOT="$2"
    PORT_CONFIG_PATH="$PROJECT_ROOT/.env"
    ${body}
  `, "test", common, projectRoot], { encoding: "utf8" });
}

test("random ports stay in the IANA dynamic range and are not constant", () => {
  const output = execFileSync("/bin/bash", ["-c", `
    source "$1"
    for _ in $(/usr/bin/jot 12 1); do generate_random_port; done
  `, "test", common], { encoding: "utf8" });
  const ports = output.trim().split(/\s+/).map(Number);
  assert.equal(ports.length, 12);
  assert.ok(ports.every((port) => port >= 49152 && port <= 65535));
  assert.ok(new Set(ports).size > 1, "port selection must not be a fixed value");
});

test("uses a configured port while ignoring comments, blanks, and unrelated keys", (t) => {
  const projectRoot = withConfig(t, `
# Local settings
OTHER_SETTING=value

  CHATGPT_RESTYLE_PORT = 054321
`);
  const result = runPortScript(projectRoot, `
    port_is_available() { return 0; }
    load_port_config
    select_cdp_port
    printf '%s %s' "$SELECTED_CDP_PORT_SOURCE" "$SELECTED_CDP_PORT"
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "configured 54321");
});

test("uses a random port when the config file or key is absent", (t) => {
  for (const contents of [null, "OTHER_SETTING=value\n"]) {
    const projectRoot = withConfig(t, contents);
    const result = runPortScript(projectRoot, `
      generate_random_port() { printf '60000\\n'; }
      load_port_config
      select_cdp_port
      printf '%s %s' "$SELECTED_CDP_PORT_SOURCE" "$SELECTED_CDP_PORT"
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "random 60000");
  }
});

for (const [name, contents] of [
  ["empty", "CHATGPT_RESTYLE_PORT=\n"],
  ["non-integer", "CHATGPT_RESTYLE_PORT=abc\n"],
  ["below range", "CHATGPT_RESTYLE_PORT=1023\n"],
  ["above range", "CHATGPT_RESTYLE_PORT=65536\n"],
  ["duplicate", "CHATGPT_RESTYLE_PORT=54321\nCHATGPT_RESTYLE_PORT=54322\n"],
]) {
  test(`rejects ${name} fixed-port configuration`, (t) => {
    const result = runPortScript(withConfig(t, contents), "load_port_config");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CHATGPT_RESTYLE_PORT/);
  });
}

test("rejects an occupied configured port without falling back to random", (t) => {
  const projectRoot = withConfig(t, "CHATGPT_RESTYLE_PORT=54321\n");
  const result = runPortScript(projectRoot, `
    port_is_available() { return 1; }
    generate_random_port() { printf '60000\\n'; }
    load_port_config
    select_cdp_port
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /54321.*已被占用/);
  assert.doesNotMatch(result.stdout, /60000/);
});
