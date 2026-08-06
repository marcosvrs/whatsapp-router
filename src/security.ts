import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string | undefined, b: string): boolean {
  const bufA = Buffer.from(a ?? "");
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// WAHA signs each webhook's raw body with HMAC-SHA512 using this same secret
// and sends the result in X-Webhook-Hmac — verifying it confirms both that the
// request came from WAHA and that the body wasn't altered in transit.
export function validWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  return safeEqual(signature, expected);
}
