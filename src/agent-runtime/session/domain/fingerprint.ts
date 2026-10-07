/** 64-bit FNV-1a over UTF-16 code units, hex. Identity check only, not security. */
export function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}
