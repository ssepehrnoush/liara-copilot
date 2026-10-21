// v2: online checkout through a payment gateway.
import crypto from 'node:crypto';

export function createPaymentSession(cart) {
  const apiKey = process.env.PAYMENT_API_KEY;
  if (!apiKey) {
    throw new Error('PAYMENT_API_KEY is not set: cannot create payment session');
  }
  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const sessionId = crypto.createHmac('sha256', apiKey).update(`${total}:${Date.now()}`).digest('hex').slice(0, 16);
  return { sessionId, total, gateway: process.env.PAYMENT_GATEWAY || 'sandbox' };
}
