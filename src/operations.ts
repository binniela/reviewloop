import type { Db } from "./db.js";

/** Operational denominators, not claims about review uplift or revenue attribution. */
export async function pilotFunnel(db: Db, propertyId: string, since: Date, until: Date) {
  const [row] = await db.query(
    `select
      (select count(*)::int from stays where property_id = $1 and status in ('in_house','checked_out')
        and arrival_date >= ($2::timestamptz at time zone p.timezone)::date and arrival_date < ($3::timestamptz at time zone p.timezone)::date) as stays,
      (select count(*)::int from stays s where s.property_id = $1 and (s.sms_opt_in or s.consented_at is not null)
        and coalesce(s.consent_phone, s.phone) is not null
        and not exists (select 1 from opt_outs o where o.phone = coalesce(s.consent_phone, s.phone))
        and s.arrival_date >= ($2::timestamptz at time zone p.timezone)::date and s.arrival_date < ($3::timestamptz at time zone p.timezone)::date) as textable_stays,
      (select count(*)::int from messages where property_id = $1 and direction = 'out' and kind <> 'alert'
        and created_at >= $2 and created_at < $3) as provider_accepted_messages,
      (select count(*)::int from messages m join sms_delivery_receipts r on r.provider_id = m.provider_id
        where m.property_id = $1 and m.direction = 'out' and m.kind <> 'alert' and r.status in ('delivered','read')
        and m.created_at >= $2 and m.created_at < $3) as delivered_sms,
      (select count(*)::int from messages m join sms_delivery_receipts r on r.provider_id = m.provider_id
        where m.property_id = $1 and m.direction = 'out' and m.kind <> 'alert' and r.status in ('undelivered','failed')
        and m.created_at >= $2 and m.created_at < $3) as failed_sms,
      (select count(*)::int from recovery_cases c join stays s on s.id = c.stay_id where s.property_id = $1
        and c.opened_at >= $2 and c.opened_at < $3 and c.resolved_at is null) as unresolved,
      (select count(*)::int from recovery_cases c join stays s on s.id = c.stay_id where s.property_id = $1
        and c.opened_at >= $2 and c.opened_at < $3 and c.guest_confirmed_at is not null) as guest_confirmed_resolutions,
      (select count(*)::int from messages where property_id = $1 and direction = 'in' and stay_id is null
        and classification is not null and created_at >= $2 and created_at < $3) as unmatched_inbound
     from properties p where p.id = $1`, [propertyId, since.toISOString(), until.toISOString()],
  );
  return row ?? null;
}
