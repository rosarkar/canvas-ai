/**
 * Suppress one specific, harmless boot warning that `@solana/web3.js`'s
 * `bigint-buffer` dependency prints when its optional native binding isn't
 * compiled: "bigint: Failed to load bindings, pure JS will be used …".
 *
 * The pure-JS fallback is correct and fast enough for our use; the line is pure
 * noise that reads like an error to a judge watching a live demo terminal. We
 * filter exactly that message and pass everything else through untouched.
 *
 * Import this FIRST in any entrypoint (before Solana modules load).
 */
const origErr = process.stderr.write.bind(process.stderr);
const origOut = process.stdout.write.bind(process.stdout);

function makeFilter(orig: typeof process.stderr.write) {
  return ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string" && chunk.includes("bigint: Failed to load bindings")) {
      return true; // swallow just this line
    }
    return (orig as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

process.stderr.write = makeFilter(origErr);
process.stdout.write = makeFilter(origOut);
