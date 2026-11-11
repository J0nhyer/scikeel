/** Diagnostic trace. The desktop runtime wrote these through Rust; the Web
 *  client keeps them in the developer console only. */
export function logDebug(message: string): void {
  if (import.meta.env.DEV) console.debug(message);
}
