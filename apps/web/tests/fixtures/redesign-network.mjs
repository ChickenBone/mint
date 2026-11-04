// Test-only adapter, loaded explicitly by the isolated screenshot server, never by Mint.
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (process.env.MINT_REDESIGN_FIXTURE === "true" && url.hostname === "musicbrainz.org") {
    return original(`http://127.0.0.1:3088/test/recordings${url.search}`, init);
  }
  return original(input, init);
};
