import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { explore } from "./explorer.js";

function loadEnvFile(envPath = path.join(process.cwd(), ".env")) {
  const envExists = existsSync(envPath);
  console.log(`[env] looking for .env at ${envPath} -> ${envExists ? "found" : "not found"}`);
  if (!envExists) return;

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;
    const existingValue = process.env[key];
    if (existingValue !== undefined && existingValue !== "") {
      console.log(`[env] skip ${key} because it already exists in process.env`);
      continue;
    }
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    console.log(`[env] loaded ${key}=${value ? "(set)" : "(empty)"}`);
  }
}

loadEnvFile();
console.log(`[env] OPENAI_API_KEY present=${Boolean(process.env.OPENAI_API_KEY)}`);
console.log(`[env] OPENAI_MODEL=${process.env.OPENAI_MODEL ?? "<unset>"}`);
console.log(`[env] OPENAI_ENDPOINT=${process.env.OPENAI_ENDPOINT ?? "<unset>"}`);

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const [key, maybeValue] = current.slice(2).split("=");
    if (maybeValue !== undefined) {
      args[key] = maybeValue;
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = String(args.url ?? "https://example.com");
  const steps = Number(args.steps ?? 20);
  const seed = args.seed ? String(args.seed) : undefined;
  const headless = args.headless === undefined ? true : String(args.headless) !== "false";
  const llmEnabled = args.llm === undefined ? false : String(args.llm) !== "false";
  const llmVisionRaw = args["llm-vision"] ? String(args["llm-vision"]) : "always";
  const llmVision = llmVisionRaw === "on-navigation" ? "on-navigation" : "always";
  const llmConversation = args["llm-conversation"] === undefined ? true : String(args["llm-conversation"]) !== "false";

  const logs = await explore({
    url,
    steps,
    seed,
    headless,
    timeoutMs: 30000,
    waitAfterActionMs: 300,
    maxInputsPerPage: 8,
    llmEnabled,
    llmVision,
    llmConversation,
    llmApiKey: args.apiKey ? String(args.apiKey) : process.env.OPENAI_API_KEY,
    llmModel: args.model ? String(args.model) : process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    llmEndpoint: args.endpoint ? String(args.endpoint) : process.env.OPENAI_ENDPOINT,
    // 新增选项
    anomalyDetection: args["anomaly-detection"] === undefined ? true : String(args["anomaly-detection"]) !== "false",
    maxBacktrack: Number(args["max-backtrack"] ?? 3),
    domSnapshot: args["dom-snapshot"] === undefined ? true : String(args["dom-snapshot"]) !== "false",
    snapshotDir: args["snapshot-dir"] ? String(args["snapshot-dir"]) : undefined,
  });

  console.log(JSON.stringify({ url, steps, seed, llmEnabled, llmVision, logs }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
