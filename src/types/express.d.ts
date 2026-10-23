import type { Types } from 'mongoose';
declare global {
  namespace Express {
    interface Request {
      actor: {
        id: string;
        role: 'owner' | 'staff' | 'customer';
        salon?: string;
        sessionId: string;
      };
    }
  }
}
export {};
