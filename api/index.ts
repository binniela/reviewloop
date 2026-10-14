// Vercel entry: every non-static request is rewritten here (see vercel.json). Static files in
// public/ (icons, manifest, service worker) are served by Vercel's CDN before this runs.
import { handle } from "hono/vercel";
import { buildDeps, createApp } from "../src/boot.js";

const app = createApp(await buildDeps());
const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
