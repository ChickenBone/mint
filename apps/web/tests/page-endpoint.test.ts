import assert from "node:assert/strict";
import test from "node:test";
import { endpointOnPage } from "../src/lib/page-endpoint";

const phone = { protocol: "http:", hostname: "macbook-pro" };

test("a phone keeps API and websocket calls on the page host", () => {
  assert.equal(endpointOnPage("ws://localhost:3001/ws", phone), "ws://macbook-pro:3001/ws");
  assert.equal(endpointOnPage("http://127.0.0.1:3000", phone), "http://macbook-pro:3000");
  assert.equal(endpointOnPage("ws://localhost:3001/ws", { protocol: "https:", hostname: "macbook-pro" }), "wss://macbook-pro:3001/ws");
});

test("loopback pages and public endpoints stay on their configured host", () => {
  assert.equal(endpointOnPage("ws://localhost:3001/ws", { protocol: "http:", hostname: "localhost" }), "ws://localhost:3001/ws");
  assert.equal(endpointOnPage("wss://mint.example.com/ws", phone), "wss://mint.example.com/ws");
});
