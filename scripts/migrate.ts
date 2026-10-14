import { migrate, openFromEnv } from "../src/db.js";

const db = await openFromEnv();
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
await db.close();
