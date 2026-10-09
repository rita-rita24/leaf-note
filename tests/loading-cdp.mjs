import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
async function fileExists(file) {
  if (!file) return false;
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(
    "Chrome/Chromium executable not found. Set CHROME_BIN to the browser path.",
  );
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function requestJson(port, pathName, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathName, method },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForDevTools(port, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await requestJson(port, "/json/version");
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("Timed out waiting for Chrome DevTools");
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => this._onMessage(event));
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`Browser connection closed during ${pending.method}`),
        );
      }
      this.pending.clear();
      for (const waiters of this.eventWaiters.values()) {
        for (const waiter of waiters)
          waiter.reject(
            new Error("Browser connection closed while waiting for an event"),
          );
      }
      this.eventWaiters.clear();
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  _onMessage(event) {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error)
        pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result || {});
      return;
    }
    if (msg.method && this.eventWaiters.has(msg.method)) {
      const waiters = this.eventWaiters.get(msg.method);
      this.eventWaiters.delete(msg.method);
      waiters.forEach((resolve) => resolve(msg.params || {}));
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error(`Browser connection is not open for ${method}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const remove = () => {
        const remaining = (this.eventWaiters.get(method) || []).filter(
          (waiter) => waiter !== wrapped,
        );
        if (remaining.length) this.eventWaiters.set(method, remaining);
        else this.eventWaiters.delete(method);
      };
      const timeout = setTimeout(() => {
        remove();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const wrapped = (params) => {
        clearTimeout(timeout);
        remove();
        resolve(params);
      };
      wrapped.reject = (error) => {
        clearTimeout(timeout);
        remove();
        reject(error);
      };
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(wrapped);
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function launchBrowser({ profilePath = null } = {}) {
  const chromeBin = await findChrome();
  const port = await getFreePort();
  const userDataDir =
    profilePath || (await mkdtemp(path.join(os.tmpdir(), "leafnote-test-")));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-sync",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "about:blank",
  ];
  const proc = spawn(chromeBin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  proc.on("exit", (code, signal) => {
    if (code && code !== 0)
      console.error(`Chrome exited with ${code || signal}: ${stderr}`);
  });
  const browser = { proc, port, userDataDir, ownsProfile: !profilePath };
  try {
    await waitForDevTools(port);
    return browser;
  } catch (error) {
    await stopBrowser(browser);
    throw new Error(`Chrome failed to start: ${error.message}\n${stderr}`, {
      cause: error,
    });
  }
}

function isProcessExited(proc) {
  return !proc || proc.exitCode !== null || proc.signalCode !== null;
}

function waitForProcessExit(proc, timeoutMs = 5000) {
  if (isProcessExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("exit", onExit);
    if (isProcessExited(proc)) finish(true);
  });
}

async function stopBrowser(browser) {
  const proc = browser?.proc;
  if (proc && !isProcessExited(proc)) {
    try {
      proc.kill("SIGTERM");
    } catch {}
    const stopped = await waitForProcessExit(proc, 5000);
    if (!stopped && !isProcessExited(proc)) {
      try {
        proc.kill("SIGKILL");
      } catch {}
      await waitForProcessExit(proc, 5000);
    }
  }
  if (browser?.ownsProfile && browser.userDataDir) {
    await rm(browser.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

async function waitForReady(client, readyExpression, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const ready = await evaluate(client, readyExpression);
      if (ready) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("LeafNote test API did not become ready");
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text;
    throw new Error(text);
  }
  return result.result?.value;
}

export {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
};
