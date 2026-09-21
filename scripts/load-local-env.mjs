import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Local entry points deliberately prefer the saved file over inherited shell values.
Object.assign(process.env, parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8")));
