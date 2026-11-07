import assert from "node:assert/strict";
import test from "node:test";
import { findAlbumArtwork as cachedAlbumArtwork } from "./artwork";
const findAlbumArtwork: typeof cachedAlbumArtwork = (artist, album, id) => cachedAlbumArtwork(artist, album, id, null);
import nextConfig from "../../../web/next.config";

const groupId = "8e8a594f-2175-38c7-a871-abb68ec363e7";

test("browser policy permits the keyless archive and redirected image origins", async () => {
  const headers = await nextConfig.headers!();
  const csp = headers[0]!.headers.find((header) => header.key === "Content-Security-Policy")!.value;
  const images = csp.split("; ").find((directive) => directive.startsWith("img-src "))!.split(" ");
  for (const host of ["https://coverartarchive.org", "https://archive.org", "https://*.archive.org"]) {
    assert.ok(images.includes(host), `${host} must not be blocked by the browser`);
  }
});

test("keyless album lookup verifies artist/title and returns only approved HTTPS archive covers", async (t) => {
  let matches = 0;
  let archiveCalls = 0;
  let status = 200;
  let image = "http://archive.org/download/fixture/cover-500.jpg";
  let approved = true;
  let front = true;
  let correctMatch = true;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (url.hostname === "musicbrainz.org") {
      matches++;
      assert.equal(url.pathname, "/ws/2/release-group");
      assert.ok(new Headers(init?.headers).get("user-agent")?.includes("Mint"));
      assert.equal(url.searchParams.get("fmt"), "json");
      return Response.json({ "release-groups": [
        { id: groupId, title: "Another album", score: 100, "artist-credit": [{ name: "Miles Davis" }] },
        { id: groupId, title: "Kind of Blue", score: 100, "artist-credit": [{ name: "Wrong artist" }] },
        ...(correctMatch ? [{ id: groupId, title: "Kind of Blue", score: 100, "artist-credit": [{ name: "Miles Davis", artist: { name: "Miles Davis" } }] }] : []),
      ] });
    }
    assert.equal(url.hostname, "coverartarchive.org", "must never request Plex or the local library");
    assert.equal(url.pathname, `/release-group/${groupId}`);
    archiveCalls++;
    return Response.json({ images: [{ approved, front, thumbnails: { "500": image } }] }, { status });
  });
  assert.equal(await findAlbumArtwork("Miles Davis", "Kind of Blue"), "https://archive.org/download/fixture/cover-500.jpg");
  assert.equal(matches, 1);
  assert.equal(archiveCalls, 1);
  correctMatch = false;
  assert.equal(await findAlbumArtwork("Miles Davis", "Kind of Blue"), null, "wrong artists/albums must not be used");
  assert.equal(archiveCalls, 1);
  approved = false;
  assert.equal(await findAlbumArtwork("unused", "unused", groupId), null);
  approved = true;
  front = false;
  assert.equal(await findAlbumArtwork("unused", "unused", groupId), null);
  front = true;
  status = 404;
  assert.equal(await findAlbumArtwork("unused", "unused", groupId), null);
  status = 503;
  await assert.rejects(findAlbumArtwork("unused", "unused", groupId), /503/, "outages must not be cached as missing artwork");
  status = 200;
  image = "https://untrusted.test/cover.jpg";
  await assert.rejects(findAlbumArtwork("unused", "unused", groupId), /unsupported image URL/);
  image = "http://127.0.0.1/secret";
  await assert.rejects(findAlbumArtwork("unused", "unused", groupId), /unsupported image URL/);
  await assert.rejects(findAlbumArtwork("unused", "unused", "../invalid"), /Invalid MusicBrainz/);
});
