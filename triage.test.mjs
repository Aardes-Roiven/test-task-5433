import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const manual = { status: "manual_review", topic: null, draft: null };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 3000;
  let lastError = new Error("server did not start");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const reply = await fetch(`${base}/`);
      if (reply.status === 200) {
        return {
          base,
          async stop() {
            child.kill();
            await once(child, "exit");
          },
        };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  child.kill();
  throw lastError;
}

async function triage(base, body, headers = { "Content-Type": "application/json" }) {
  const reply = await fetch(`${base}/api/triage`, { method: "POST", headers, body });
  return { status: reply.status, body: await reply.json() };
}

let server;

test.before(async () => {
  server = await startServer();
});

test.after(async () => {
  await server.stop();
});

test("ordinary text becomes a topic and a draft", async () => {
  const result = await triage(server.base, JSON.stringify({ text: "Где моя доставка?" }));
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["draft", "status", "topic"]);
  assert.equal(result.body.status, "ready");
  assert.equal(result.body.topic, "delivery");
  assert.equal(result.body.draft, "Спасибо за обращение. Уточним детали заявки.");
});

test("empty, blank, missing and broken input is rejected", async () => {
  const cases = [
    JSON.stringify({ text: "" }),
    JSON.stringify({ text: "   " }),
    JSON.stringify({}),
    JSON.stringify({ text: 12 }),
    "not json",
  ];
  for (const body of cases) {
    const result = await triage(server.base, body);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { status: "invalid_input" });
  }
});

test("timeout, model error and unusable output stay on manual review", async () => {
  const cases = ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"];
  for (const text of cases) {
    const started = Date.now();
    const result = await triage(server.base, JSON.stringify({ text }));
    assert.equal(result.status, 200, text);
    assert.deepEqual(result.body, manual, text);
    if (text === "[timeout]") assert.ok(Date.now() - started < 1000);
  }
});
