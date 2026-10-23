import { describe, it, expect } from 'vitest';
import { fitsHours } from '../src/modules/booking.service.js';
import { eligibleReward } from '../src/modules/wallet.service.js';
import { bookingInput, password, salonInput } from '../src/validators/index.js';
describe('business rules', () => {
  it('checks salon timezone rather than UTC weekday', () => {
    const hours = [{ day: 1, open: '09:00', close: '18:00', closed: false }];
    expect(
      fitsHours(
        new Date('2026-10-26T03:30:00Z'),
        new Date('2026-10-26T04:00:00Z'),
        'Asia/Kolkata',
        hours,
      ),
    ).toBe(true);
    expect(
      fitsHours(
        new Date('2026-10-26T02:00:00Z'),
        new Date('2026-10-26T03:00:00Z'),
        'Asia/Kolkata',
        hours,
      ),
    ).toBe(false);
  });
  it('rejects overnight intervals and closed days', () => {
    expect(
      fitsHours(
        new Date('2026-10-26T17:30:00Z'),
        new Date('2026-10-26T19:30:00Z'),
        'Asia/Kolkata',
        [{ day: 1, open: '00:00', close: '23:59' }],
      ),
    ).toBe(false);
  });
  it('only rewards an eligible externally paid first visit', () => {
    expect(eligibleReward(1, 30000, 20000, 'cash')).toBe(true);
    expect(eligibleReward(2, 30000, 20000, 'cash')).toBe(false);
    expect(eligibleReward(1, 30000, 20000, 'credit')).toBe(false);
    expect(eligibleReward(1, 10000, 20000, 'provider')).toBe(false);
    expect(eligibleReward(1, 0, 0, 'cash')).toBe(false);
  });
  it('rejects multibyte passwords exceeding bcrypt byte limit', () => {
    expect(password.safeParse('अ'.repeat(30)).success).toBe(false);
  });
  it('rejects role injection and duplicate booking services', () => {
    const input = {
      staffId: 'a'.repeat(24),
      start: '2026-10-26T10:00:00+05:30',
      items: [{ serviceId: 'b'.repeat(24) }, { serviceId: 'b'.repeat(24) }],
    };
    expect(bookingInput.safeParse(input).success).toBe(false);
    expect(
      bookingInput.safeParse({ ...input, items: [input.items[0]], role: 'owner' }).success,
    ).toBe(false);
  });
});
