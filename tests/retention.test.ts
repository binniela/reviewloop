import { describe, expect, it } from "vitest";
import { testDb } from "./helpers.js";
import { purgeGuestPii } from "../src/retention.js";

describe("guest PII retention", () => {
  it("redacts old departed stays and messages while keeping STOP suppression", async () => {
    const db = await testDb();
    const [stay] = await db.query<{ id: string }>(`insert into stays
      (property_id, confirmation, guest_first_name, guest_last_name, email, phone, sms_opt_in, room, arrival_date, departure_date, status, state_hash)
      values ('sunset', 'old', 'Ana', 'Guest', 'ana@example.com', '+16265550101', true, '101', '2024-01-01', '2024-01-03', 'checked_out', 'hash') returning id::text`);
    await db.query(`insert into messages (property_id, stay_id, direction, channel, kind, from_addr, to_addr, body)
      values ('sunset', $1, 'in', 'sms', 'inbound', '+16265550101', '+16265550000', 'Private complaint')`, [stay!.id]);
    await db.query("insert into opt_outs (phone) values ('+16265550101')");
    await purgeGuestPii(db, new Date("2026-10-14T00:00:00Z"));
    expect((await db.query<{ phone: string | null }>("select phone from stays where id = $1", [stay!.id]))[0]?.phone).toBeNull();
    expect((await db.query<{ body: string }>("select body from messages where stay_id = $1", [stay!.id]))[0]?.body).toBe("[redacted]");
    expect(await db.query("select phone from opt_outs where phone = '+16265550101'")).toHaveLength(1);
    await db.close();
  });
});
