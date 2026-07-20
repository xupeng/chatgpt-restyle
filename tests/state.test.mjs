import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = path.join(root, "scripts", "common-macos.sh");
const injector = path.join(root, "scripts", "injector.mjs");

test("state is written with mode 0600 and unsafe permissions are rejected", (context) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-restyle-state-"));
  context.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    NODE="$2"
    CHATGPT_EXE=/bin/echo
    ensure_state_root
    write_state 54321 123 "Mon Jan 1 00:00:00 2024" "com.xupeng.chatgpt-restyle.54321" 456 "Mon Jan 1 00:00:00 2024"
    state_file_is_safe
    test "$(/usr/bin/stat -f '%Lp' "$STATE_PATH")" = 600
    /bin/chmod 644 "$STATE_PATH"
    ! state_file_is_safe
  `, "test", common, process.execPath], {
    encoding: "utf8",
    env: { ...process.env, HOME: temporaryHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(
    path.join(temporaryHome, "Library/Application Support/ChatGPTRestyle/state.json"),
    "utf8",
  ));
  assert.equal(state.port, 54321);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.node, process.execPath);
  assert.equal(state.injectorLabel, "com.xupeng.chatgpt-restyle.54321");
  assert.equal(state.chatgptPid, 456);
  assert.equal(state.chatgptExe, "/bin/echo");
  assert.deepEqual(
    Object.keys(state).filter((key) => key.toLowerCase().includes("legacy")),
    [],
  );
});

test("launchd labels are scoped to ChatGPT Restyle and the exact port", () => {
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    test "$(injector_label_for_port 54321)" = "com.xupeng.chatgpt-restyle.54321"
    test "$(injector_label_for_port 54322)" = "com.xupeng.chatgpt-restyle.54322"
  `, "test", common], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("legacy state can stop without a label while schema 2 requires one", (context) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-restyle-legacy-state-"));
  context.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));
  const stateRoot = path.join(temporaryHome, "Library/Application Support/ChatGPTRestyle");
  const statePath = path.join(stateRoot, "state.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const state = {
    schemaVersion: 1,
    injectorPid: 2147483647,
    injectorStartedAt: "Mon Jan 1 00:00:00 2024",
    node: process.execPath,
    injector,
    port: 54321,
  };
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const run = () => spawnSync("/bin/bash", ["-c", `
    source "$1"
    NODE="$2"
    stop_recorded_injector
  `, "test", common, process.execPath], {
    encoding: "utf8",
    env: { ...process.env, HOME: temporaryHome },
  });

  const legacyResult = run();
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  fs.writeFileSync(statePath, JSON.stringify({ ...state, schemaVersion: 2 }), { mode: 0o600 });
  const malformedCurrentResult = run();
  assert.notEqual(malformedCurrentResult.status, 0);
  assert.match(malformedCurrentResult.stderr, /injectorLabel/);
});

test("injector identity matching includes PID start time, paths, and exact port", async (context) => {
  const psProbe = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (psProbe.status !== 0) {
    context.skip("managed sandbox does not permit process-table inspection");
    return;
  }
  const child = spawn(process.execPath, [injector, "--watch", "--port", "54322"], {
    stdio: "ignore",
  });
  context.after(() => { try { child.kill("SIGTERM"); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    CHATGPT_EXE=/bin/echo
    started="$(process_started_at "$2")"
    recorded_injector_matches "$2" "$started" "$3" "$4" 54322
    ! recorded_injector_matches "$2" "$started" "$3" "$4" 54323
    ! recorded_injector_matches "$2" "wrong start" "$3" "$4" 54322
  `, "test", common, String(child.pid), process.execPath, injector], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  child.kill("SIGTERM");
});

test("CDP listener resolution returns its owning ChatGPT main process", () => {
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    listener_pids() { printf '300\\n301\\n'; }
    process_parent_pid() {
      case "$1" in
        300|301) printf '200\\n' ;;
        200) printf '100\\n' ;;
        100) printf '1\\n' ;;
        *) return 1 ;;
      esac
    }
    pid_is_chatgpt_executable() { [ "$1" -eq 100 ]; }
    test "$(chatgpt_pid_for_port 54321)" = 100
    port_belongs_to_chatgpt 54321
  `, "test", common], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("CDP listener resolution rejects listeners owned by different ChatGPT instances", () => {
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    listener_pids() { printf '300\\n301\\n'; }
    process_parent_pid() {
      case "$1" in
        300) printf '100\\n' ;;
        301) printf '101\\n' ;;
        100|101) printf '1\\n' ;;
        *) return 1 ;;
      esac
    }
    pid_is_chatgpt_executable() { [ "$1" -eq 100 ] || [ "$1" -eq 101 ]; }
    ! chatgpt_pid_for_port 54321
    ! port_belongs_to_chatgpt 54321
  `, "test", common], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("launchd removal wait does not accept a lingering submitted job", () => {
  const result = spawnSync("/bin/bash", ["-c", `
    source "$1"
    checks=0
    job_is_submitted() {
      checks=$((checks + 1))
      [ "$checks" -lt 3 ]
    }
    wait_for_job_removal com.example.test
    [ "$checks" -ge 3 ]
  `, "test", common], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("watcher exits and removes its state after the recorded ChatGPT process exits", async (context) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-restyle-watch-exit-"));
  const stateRoot = path.join(temporaryHome, "Library/Application Support/ChatGPTRestyle");
  const statePath = path.join(stateRoot, "state.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const chatgptProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const child = spawn(process.execPath, [
    injector,
    "--watch",
    "--port",
    "54324",
    "--chatgpt-pid",
    String(chatgptProcess.pid),
  ], {
    env: { ...process.env, HOME: temporaryHome },
    stdio: "ignore",
  });
  context.after(() => {
    try { child.kill("SIGTERM"); } catch {}
    try { chatgptProcess.kill("SIGKILL"); } catch {}
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });
  fs.writeFileSync(
    statePath,
    JSON.stringify({ injectorPid: child.pid, port: 54324 }),
    { mode: 0o600 },
  );
  chatgptProcess.kill("SIGTERM");

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("watcher did not exit")), 8000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(statePath), false);
});
