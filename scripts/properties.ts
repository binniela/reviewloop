// Create or update properties from a JSON file: npm run properties -- config/properties.json
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { migrate, openFromEnv } from "../src/db.js";
import { propertyInput, saveProperty } from "../src/propertyInput.js";

// Load .env if present (Node 20.12+).
try {
  process.loadEnvFile();
} catch {}

const schema = z.array(propertyInput);

const file = process.argv[2];
if (!file) throw new Error("usage: npm run properties -- <file.json>");
const props = schema.parse(JSON.parse(await readFile(file, "utf8")));
const db = await openFromEnv();
await migrate(db);
for (const p of props) {
  await saveProperty(db, p).catch((err: Error) => {
    throw new Error(`${p.id}: ${err.message}`);
  });
  console.log(`saved ${p.id}`);
}
await db.close();
