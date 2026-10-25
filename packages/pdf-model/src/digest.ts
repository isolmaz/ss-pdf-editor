/**
 * The SHA-256 of a byte array as lowercase hex. It is a module of its own because the trust
 * stores need it too, and importing it from `source.ts` there makes the bundler move shell
 * modules out of the entry into extra preloaded chunks, which enlarges the first paint.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
