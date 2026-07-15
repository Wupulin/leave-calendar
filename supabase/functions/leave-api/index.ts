import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const allowedOrigins = new Set([
  'https://wupulin.github.io',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'null'
]);

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://wupulin.github.io',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
}
function reply(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors(req) });
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function session(req: Request) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const tokenHash = await sha256(token);
  const { data: row } = await db.from('member_sessions').select('id,member_id,expires_at,revoked_at').eq('token_hash', tokenHash).maybeSingle();
  if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) return null;
  const { data: member } = await db.from('members').select('id,name,unit,is_admin,is_active').eq('id', row.member_id).maybeSingle();
  if (!member?.is_active) return null;
  await db.from('member_sessions').update({ last_used_at: new Date().toISOString() }).eq('id', row.id);
  return { token, row, member };
}
async function audit(actor: string | null, action: string, type: string, id: string | null, before: unknown = null, after: unknown = null) {
  await db.from('audit_logs').insert({ actor_member_id: actor, action, entity_type: type, entity_id: id, before_data: before, after_data: after });
}
function addDays(date: string, amount: number) {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10);
}
const holidays = new Set(['2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-27','2026-04-03','2026-04-06','2026-05-01','2026-06-19','2026-09-25','2026-09-28','2026-10-09','2026-10-26','2026-12-25']);
function isHoliday(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.has(date);
}
function isHolidayAdjacent(date: string) {
  return !isHoliday(date) && (isHoliday(addDays(date, -1)) || isHoliday(addDays(date, 1)));
}
function longLeaveDates(startDate: string, leaveDays: number) {
  const dates: string[] = [];
  let date = startDate, workdays = 0, guard = 0;
  while (workdays < leaveDays && guard < 40) {
    dates.push(date);
    if (!isHoliday(date)) workdays += 1;
    date = addDays(date, 1);
    guard += 1;
  }
  return dates;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return reply(req, { error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'members') {
      const { data, error } = await db.from('members').select('id,name,unit').eq('is_active', true).order('name');
      if (error) throw error;
      return reply(req, { members: data });
    }
    if (action === 'login') {
      const pin = String(body.pin || '');
      if (!/^\d{5}$/.test(pin)) return reply(req, { error: 'invalid_login' }, 401);
      const { data: verified, error: verifyError } = await db.rpc('verify_member_pin', { p_member_id: body.memberId, p_pin: pin });
      if (verifyError) throw verifyError;
      const member = verified?.[0];
      if (!member?.is_active) return reply(req, { error: 'invalid_login' }, 401);
      const token = randomToken(), tokenHash = await sha256(token), expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      await db.from('member_sessions').delete().eq('member_id', member.id).lt('expires_at', new Date().toISOString());
      const { error } = await db.from('member_sessions').insert({ member_id: member.id, token_hash: tokenHash, expires_at: expires });
      if (error) throw error;
      await audit(member.id, 'login', 'session', null);
      return reply(req, { token, expiresAt: expires, member: { id: member.id, name: member.name, unit: member.unit, isAdmin: member.is_admin } });
    }

    const auth = await session(req);
    if (!auth) return reply(req, { error: 'unauthorized' }, 401);
    const actor = auth.member;

    if (action === 'state') {
      const [{ data: members }, { data: settings }, { data: bookings }] = await Promise.all([
        db.from('members').select('id,name,unit,is_admin,is_active').eq('is_active', true).order('name'),
        db.from('phase_settings').select('*').eq('id', 1).single(),
        db.from('bookings').select('id,member_id,booking_date,phase,long_leave_block_id,status,admin_adjusted').neq('status', 'cancelled')
      ]);
      return reply(req, { members, settings, bookings, currentMember: actor });
    }
    if (action === 'logout') {
      await db.from('member_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', auth.row.id);
      await audit(actor.id, 'logout', 'session', auth.row.id);
      return reply(req, { ok: true });
    }
    if (action === 'change-pin') {
      const currentPin = String(body.currentPin || ''), newPin = String(body.newPin || '');
      if (!/^\d{5}$/.test(newPin)) return reply(req, { error: 'invalid_new_pin' }, 400);
      const { data: verified } = await db.rpc('verify_member_pin', { p_member_id: actor.id, p_pin: currentPin });
      if (!verified?.length) return reply(req, { error: 'invalid_current_pin' }, 403);
      const { error: pinError } = await db.rpc('set_member_pin', { p_member_id: actor.id, p_new_pin: newPin });
      if (pinError) throw pinError;
      await audit(actor.id, 'change_pin', 'member', actor.id);
      return reply(req, { ok: true });
    }
    if (action === 'reserve') {
      const targetId = actor.is_admin && body.memberId ? String(body.memberId) : actor.id;
      const phase = Number(body.phase), date = String(body.date || '');
      if (![1, 2, 3].includes(phase) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(req, { error: 'invalid_booking' }, 400);
      const { data: targetMember } = await db.from('members').select('id,unit,is_active').eq('id', targetId).maybeSingle();
      if (!targetMember?.is_active) return reply(req, { error: 'member_not_found' }, 404);
      if (phase !== 3 && !['ICU', '病房'].includes(targetMember.unit)) return reply(req, { error: 'unit_long_leave_only' }, 403);
      if (phase === 3 && !['ICU', '病房', '小夜', '大夜'].includes(targetMember.unit)) return reply(req, { error: 'blank_unit_no_long_leave' }, 403);
      const longLeaveDays = Math.min(7, Math.max(1, Number(body.longLeaveDays || 7)));
      const dates = phase === 3 ? longLeaveDates(date, longLeaveDays) : [date];
      const { data: existing } = await db.from('bookings').select('id').eq('member_id', targetId).in('booking_date', dates).neq('status', 'cancelled');
      if (existing?.length) return reply(req, { error: 'booking_conflict' }, 409);
      if (!actor.is_admin && phase !== 3) {
        const { data: settings } = await db.from('phase_settings').select('booking_month,phase1_member_limit,phase1_other_limit,phase2_member_limit').eq('id', 1).single();
        const monthStart = String(settings?.booking_month || '').slice(0, 10);
        const monthPrefix = monthStart.slice(0, 7);
        if (!date.startsWith(monthPrefix)) return reply(req, { error: 'invalid_booking' }, 400);
        const monthEnd = new Date(`${monthStart}T12:00:00Z`);
        monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
        const { count: monthCount } = await db.from('bookings').select('id', { count: 'exact', head: true }).eq('member_id', targetId).neq('status', 'cancelled').in('phase', [1, 2]).gte('booking_date', monthStart).lt('booking_date', monthEnd.toISOString().slice(0, 10));
        if ((monthCount || 0) >= Number(settings?.phase2_member_limit || 0)) return reply(req, { error: 'monthly_leave_limit' }, 403);
        if (phase === 1) {
          const { data: phase1Rows } = await db.from('bookings').select('booking_date').eq('member_id', targetId).neq('status', 'cancelled').eq('phase', 1).gte('booking_date', monthStart).lt('booking_date', monthEnd.toISOString().slice(0, 10));
          const targetIsAdjacent = isHolidayAdjacent(date);
          const phase1KindCount = (phase1Rows || []).filter((row: any) => isHolidayAdjacent(String(row.booking_date).slice(0, 10)) === targetIsAdjacent).length;
          const limit = targetIsAdjacent ? Number(settings?.phase1_member_limit || 0) : Number(settings?.phase1_other_limit || 0);
          if (phase1KindCount >= limit) return reply(req, { error: targetIsAdjacent ? 'phase1_holiday_limit' : 'phase1_other_limit' }, 403);
        }
      }
      const block = phase === 3 ? crypto.randomUUID() : null;
      const rows = dates.map(booking_date => ({ member_id: targetId, booking_date, phase, long_leave_block_id: block, created_by: actor.id, admin_adjusted: actor.is_admin && targetId !== actor.id }));
      const { data, error } = await db.from('bookings').insert(rows).select('id');
      if (error) throw error;
      await audit(actor.id, 'create_booking', 'booking', block || data?.[0]?.id || null, null, { memberId: targetId, dates, phase });
      return reply(req, { ok: true, blockId: block });
    }
    if (action === 'cancel') {
      const id = String(body.bookingId || '');
      const { data: booking } = await db.from('bookings').select('*').eq('id', id).maybeSingle();
      if (!booking) return reply(req, { error: 'not_found' }, 404);
      if (!actor.is_admin && booking.member_id !== actor.id) return reply(req, { error: 'forbidden' }, 403);
      let query = db.from('bookings').update({ status: 'cancelled' });
      query = booking.phase === 3 ? query.eq('long_leave_block_id', booking.long_leave_block_id) : query.eq('id', booking.id);
      const { error } = await query;
      if (error) throw error;
      await audit(actor.id, 'cancel_booking', 'booking', booking.long_leave_block_id || booking.id, booking, null);
      return reply(req, { ok: true });
    }
    if (action === 'reset-pin') {
      if (!actor.is_admin) return reply(req, { error: 'forbidden' }, 403);
      const id = String(body.memberId || '');
      const { error } = await db.rpc('set_member_pin', { p_member_id: id, p_new_pin: '00000' });
      if (error) throw error;
      await audit(actor.id, 'reset_pin', 'member', id);
      return reply(req, { ok: true });
    }
    if (action === 'clear-bookings') {
      if (!actor.is_admin) return reply(req, { error: 'forbidden' }, 403);
      const month = String(body.month || '');
      if (!/^\d{4}-\d{2}$/.test(month)) return reply(req, { error: 'invalid_month' }, 400);
      const monthStart = `${month}-01`;
      const monthEnd = new Date(`${monthStart}T12:00:00Z`);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      const { error } = await db.from('bookings').update({ status: 'cancelled' }).neq('status', 'cancelled').gte('booking_date', monthStart).lt('booking_date', monthEnd.toISOString().slice(0, 10));
      if (error) throw error;
      await audit(actor.id, 'clear_bookings', 'booking', null, null, { scope: 'month', month });
      return reply(req, { ok: true });
    }
    if (action === 'save-admin') {
      if (!actor.is_admin) return reply(req, { error: 'forbidden' }, 403);
      const settings = body.settings || {}, members = Array.isArray(body.members) ? body.members : [];
      if (!members.length || members.filter((m: any) => m.isAdmin).length !== 1) return reply(req, { error: 'single_admin_required' }, 400);
      const activeIds = members.map((m: any) => String(m.id || '')).filter((id: string) => /^[0-9a-f-]{36}$/i.test(id));
      if (activeIds.length) await db.from('members').update({ is_active: false }).not('id', 'in', `(${activeIds.join(',')})`);
      await db.from('members').update({ is_admin: false }).eq('is_admin', true);
      for (const item of members) {
        const requestedUnit = String(item.unit ?? '');
        const values = { name: String(item.name || '').trim(), unit: ['ICU','病房','小夜','大夜',''].includes(requestedUnit) ? requestedUnit : '', is_admin: !!item.isAdmin, is_active: true };
        if (!values.name) continue;
        if (/^[0-9a-f-]{36}$/i.test(String(item.id || ''))) {
          const { error } = await db.from('members').update(values).eq('id', item.id); if (error) throw error;
        } else {
          const { error } = await db.from('members').insert({ ...values, pin_hash: await (async()=>{const { data, error }=await db.rpc('hash_pin',{p_pin:'00000'});if(error)throw error;return data})() }); if (error) throw error;
        }
      }
      const row = {
        id: 1,
        booking_month: `${settings.bookingMonth}-01`, phase1_end: settings.p1End,
        phase2_start: settings.p2Start, phase2_end: settings.p2End,
        phase3_start: settings.p3Start, phase3_end: settings.p3End,
        long_leave_start_month: `${settings.longStart}-01`, long_leave_end_month: `${settings.longEnd}-01`,
        phase1_member_limit: Number(settings.p1Max), phase1_other_limit: Number(settings.p1OtherMax), phase2_member_limit: Number(settings.p2Max),
        icu_daily_limit: Number(settings.icuMax), ward_daily_limit: Number(settings.wardMax),
        long_leave_daily_limit: 1, updated_by: actor.id
      };
      const { error } = await db.from('phase_settings').upsert(row); if (error) throw error;
      await audit(actor.id, 'save_admin_settings', 'phase_settings', '1', null, row);
      return reply(req, { ok: true });
    }
    return reply(req, { error: 'unknown_action' }, 400);
  } catch (error) {
    console.error(error);
    return reply(req, { error: 'server_error' }, 500);
  }
});
