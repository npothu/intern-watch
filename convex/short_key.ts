// Minimal synchronous SHA-1 for Convex runtimes where Node crypto is absent.
export function sha1HexSync(value: string): string {
  const data = new TextEncoder().encode(value);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const bitLength = data.length * 8;
  const withOne = new Uint8Array(data.length + 1);
  withOne.set(data);
  withOne[data.length] = 0x80;
  let paddedLength = withOne.length;
  while ((paddedLength * 8) % 512 !== 448) paddedLength++;
  const padded = new Uint8Array(paddedLength + 8);
  padded.set(withOne);
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength + 4, bitLength >>> 0, false);

  const words = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      words[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      const word = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (word << 1) | (word >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const hex = (value: number) => value.toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

function extractJobrightId(input: string): string | null {
  const match = input.match(/jobright\.ai\/jobs\/info\/([0-9a-f]{24})/i) ||
    input.match(/\bjr_id=([0-9a-f]{24})\b/i);
  return match ? match[1].toLowerCase() : null;
}

/** Keep manually supplied URLs in the same identity space as URL ingest. */
export function dedupInfoForUrl(
  canonical: string,
  raw?: string,
): { dedupKey: string; short: string } {
  const jobrightId = extractJobrightId(raw ?? canonical) || extractJobrightId(canonical);
  const dedupKey = jobrightId
    ? `jr:${jobrightId}`
    : `manual:${sha1HexSync(canonical)}`;
  return { dedupKey, short: sha1HexSync(dedupKey).slice(0, 12) };
}
