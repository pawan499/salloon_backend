import type { ClientSession } from 'mongoose';
import { AuditLog, Customer, Staff } from '../models/index.js';
import { assert } from '../utils/core.js';
export type Actor = Express.Request['actor'];
export async function customerAccess(actor: Actor, customerId?: string, session?: ClientSession) {
  const filter =
    actor.role === 'customer'
      ? { salon: actor.salon, user: actor.id, ...(customerId ? { _id: customerId } : {}) }
      : { _id: customerId, salon: actor.salon };
  const customer = await Customer.findOne(filter).session(session || null);
  assert(customer, 404, 'Customer not found');
  return customer;
}
export async function bookingAccess(actor: Actor, booking: any, session?: ClientSession) {
  assert(booking && booking.salon.toString() === actor.salon, 404, 'Booking not found');
  if (actor.role === 'customer') await customerAccess(actor, booking.customer.toString(), session);
  if (actor.role === 'staff') {
    const staff = await Staff.findOne({ user: actor.id, salon: actor.salon, active: true }).session(
      session || null,
    );
    assert(
      staff && staff.id === booking.staff.toString(),
      403,
      'Booking assigned to another staff member',
    );
  }
}
export async function audit(
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  session: ClientSession,
  reason?: string,
) {
  await AuditLog.create(
    [{ salon: actor.salon, actor: actor.id, action, entity, entityId, reason }],
    { session },
  );
}
