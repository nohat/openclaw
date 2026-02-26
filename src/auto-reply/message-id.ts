/**
 * Branded type for canonical message ids. Only creatable via asTrimmedMessageId
 * (untrusted input) or messageIdFromTrustedSource (numeric/API ids). Ensures no
 * defensive trim in the middle of the pipeline.
 */
export type TrimmedMessageId = string & { readonly __brand: unique symbol };

/**
 * Normalize untrusted input (client payload, caller string, store read). Trims
 * once at the boundary; returns undefined if empty after trim.
 */
export function asTrimmedMessageId(value: string): TrimmedMessageId | undefined {
  const t = value.trim();
  return (t ? t : undefined) as TrimmedMessageId | undefined;
}

/**
 * Use when the value is already known to have no spaces (e.g. String(number),
 * API snowflake, protocol message id). No trim.
 */
export function messageIdFromTrustedSource(s: string): TrimmedMessageId {
  return s as TrimmedMessageId;
}
