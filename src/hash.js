// Hashes identify duplicate PDF uploads (source_sha256) and give each row a
// stable body fingerprint (body_sha256).

// crypto.subtle only exists in a secure context, so a plain-http deployment --
// which is a real target for this app, see docs/safari-http-notes.md -- has no
// SHA-256. FNV-1a is not cryptographic, but these hashes are only used for
// equality checks, and the prefix makes the weaker digest visible in exports.
export async function sha256(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return fnv1a32(bytes);
}

export function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}
