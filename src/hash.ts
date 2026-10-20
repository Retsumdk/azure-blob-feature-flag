export function fnv1a32Hex(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i] as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function fnv1a32(data: Uint8Array): number {
  const hex = fnv1a32Hex(data);
  return Number.parseInt(hex, 16) >>> 0;
}

/**
 * Deterministic 0-99 bucket for a (flag, subject) pair.
 *
 * Salted with the flag key so one flag's rollout never correlates with
 * another's: subject "u-1" can be in the first 10% of flag A and the last
 * 10% of flag B, which is exactly what independent percentage rollouts need.
 */
export function bucketFor(flagKey: string, subjectId: string): number {
  const salted = new TextEncoder().encode(`${flagKey}::${subjectId}`);
  return fnv1a32(salted) % 100;
}

/**
 * Deterministic weighted variant selection: walks the variant weights using
 * a 0-99 bucket as the pointer. Returns the selected variant, or null when
 * the list is empty or every weight is zero.
 */
export function weightedSlot<T extends { readonly name: string; readonly weight: number }>(
  variants: readonly T[],
  bucket: number,
): T | null {
  const usable = variants.filter((v) => v.weight > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, v) => sum + v.weight, 0);
  let pointer = ((bucket % total) + total) % total;
  for (const variant of usable) {
    if (pointer < variant.weight) return variant;
    pointer -= variant.weight;
  }
  return usable[usable.length - 1] as T;
}
