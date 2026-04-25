import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const configDir = path.join(os.homedir(), ".config", "jot");
export const configPath = path.join(configDir, "settings.json");

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { instances: [] };
  }
}

export function saveConfig(config) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function getInstance(name) {
  const config = loadConfig();
  const instance = config.instances.find((i) => i.name === name);
  if (!instance) {
    const err = new Error(`Unknown instance: ${name}`);
    err.code = "UNKNOWN_INSTANCE";
    throw err;
  }
  return instance;
}

export async function request(instance, method, endpoint, body, opts = {}) {
  const url = `${instance.baseUrl.replace(/\/$/, "")}${endpoint}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const options = {
    method,
    headers: {},
    signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
  };
  if (instance.token) options.headers.Authorization = `Bearer ${instance.token}`;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      const err = new Error(`Request timeout after ${timeoutMs}ms: ${method} ${endpoint}`);
      err.code = "REQUEST_TIMEOUT";
      throw err;
    }
    throw e;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const msg =
      payload.error ||
      (payload.errors && payload.errors.join(", ")) ||
      `HTTP ${response.status}`;
    const err = new Error(`Error ${response.status}: ${msg}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export function isShareInstance(instance) {
  return Boolean(instance.shareId && !instance.token);
}
