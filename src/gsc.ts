// Google Search Console client: service-account auth + the four REST calls the
// tools need. Deliberately NOT the `googleapis` meta-package — four endpoints
// don't justify its size, and a thin client keeps the request function
// injectable for tests and for the Walma MCP chassis.
//
// Auth (either works; JSON wins when both are set):
//   GSC_SERVICE_ACCOUNT_JSON  — the key as inline JSON (Key Vault / chassis path)
//   GSC_SERVICE_ACCOUNT_FILE  — path to the key file (local / CLI path)
//
// Scope is read-only by design: the server cannot change anything in
// Search Console.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { JWT } from "google-auth-library";

export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE = "https://searchconsole.googleapis.com/v1";

/** Minimal authorized-request signature — what tests and the chassis inject. */
export type RequestFn = (opts: {
  url: string;
  method: "GET" | "POST";
  data?: unknown;
}) => Promise<{ data: any }>;

export interface GscClient {
  listSites(): Promise<any>;
  queryAnalytics(site: string, body: Record<string, unknown>): Promise<any>;
  listSitemaps(site: string): Promise<any>;
  inspectUrl(body: Record<string, unknown>): Promise<any>;
}

function loadCredentials(): { client_email: string; private_key: string } {
  const inline = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error("GSC_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }
  let file = process.env.GSC_SERVICE_ACCOUNT_FILE;
  if (!file) {
    throw new Error("GSC_SERVICE_ACCOUNT_FILE is not set (or set GSC_SERVICE_ACCOUNT_JSON)");
  }
  if (file.startsWith("~")) file = file.replace(/^~/, homedir());
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Service account key not found: ${file}`);
  }
  return JSON.parse(raw);
}

/** Lazily constructed so importing the package never demands credentials. */
export function createDefaultRequestFn(): RequestFn {
  let jwt: JWT | null = null;
  return async (opts) => {
    if (!jwt) {
      const creds = loadCredentials();
      jwt = new JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
    }
    return jwt.request({ url: opts.url, method: opts.method, data: opts.data });
  };
}

export function createGscClient(request: RequestFn = createDefaultRequestFn()): GscClient {
  const enc = encodeURIComponent;
  return {
    listSites: () => request({ url: `${WEBMASTERS}/sites`, method: "GET" }).then(r => r.data),
    queryAnalytics: (site, body) =>
      request({
        url: `${WEBMASTERS}/sites/${enc(site)}/searchAnalytics/query`,
        method: "POST",
        data: body,
      }).then(r => r.data),
    listSitemaps: (site) =>
      request({ url: `${WEBMASTERS}/sites/${enc(site)}/sitemaps`, method: "GET" }).then(r => r.data),
    inspectUrl: (body) =>
      request({
        url: `${SEARCHCONSOLE}/urlInspection/index:inspect`,
        method: "POST",
        data: body,
      }).then(r => r.data),
  };
}
