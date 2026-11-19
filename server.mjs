import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const MODEL_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);
const MANUAL = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function readText(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.text !== "string") return null;
  const text = payload.text.trim();
  return text ? text : null;
}

function readModel(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const draft = typeof parsed.draft === "string" ? parsed.draft.trim() : "";
  if (!TOPICS.has(parsed.topic) || !draft) return null;
  return { topic: parsed.topic, draft };
}

async function handleTriage(request, response) {
  const text = readText(await readBody(request));
  if (!text) return json(response, 400, { status: "invalid_input" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const accepted = readModel(await classify(text, { signal: controller.signal }));
    if (!accepted) return json(response, 200, MANUAL);
    return json(response, 200, { status: "ready", topic: accepted.topic, draft: accepted.draft });
  } catch {
    return json(response, 200, MANUAL);
  } finally {
    clearTimeout(timer);
  }
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    if (!response.headersSent) json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
