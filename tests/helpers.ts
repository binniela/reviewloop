import { migrate, openPglite, type Db } from "../src/db.js";

export async function testDb(): Promise<Db> {
  const db = await openPglite();
  await migrate(db);
  await db.query(
    `insert into properties (id, name, timezone, google_place_id, google_location, voice_notes, signoff)
     values ('sunset', 'Sunset Inn', 'America/Los_Angeles', 'PLACE123', 'accounts/1/locations/2',
             'Warm and plain-spoken, family-run motel near the freeway.', 'Raj, General Manager')`,
  );
  return db;
}

export const DEPARTURES_CSV = `Confirmation,Guest Name,Email,Phone,SMS Opt In,Room,Source,Arrival,Departure,Status,Check Out Time
10001,"PATEL, ANITA",anita@example.com,(626) 555-0101,Y,104,Booking.com,10/10/2026,10/13/2026,Checked Out,10:42 AM
10002,"Lee, Marcus",marcus@example.com,626-555-0102,N,210,Direct,10/11/2026,10/13/2026,Checked Out,
10003,"Gomez, Ana",,6265550103,Y,118,Expedia,10/12/2026,10/13/2026,Checked Out,9:05 AM
`;
