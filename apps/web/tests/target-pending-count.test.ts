import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

function run(source: string, server = false) {
  execFileSync(process.execPath, [
    ...(server ? ["--conditions=react-server"] : []),
    "--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", source,
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "pipe",
    timeout: 30_000,
  });
}

test("pending-count gateway uses canonical credentials, rejects non-admin sessions and never fabricates zero", () => {
  run(`
    import assert from "node:assert/strict";
    const { GET } = await import("./src/app/api/admin/access-requests/pending-count/route.ts");
    process.env.MINT_TARGET_API_URL = "https://api.fixture.test/trpc";
    process.env.MINT_TARGET_WEB_ORIGIN = "https://web.fixture.test";
    process.env.MINT_TARGET_GATEWAY_TOKEN = "A".repeat(43);
    const admin = { id: "00000000-0000-4000-8000-000000000001",
      email: "admin@fixture.test", name: "Admin", role: "admin", status: "active" };
    let user = admin;
    let count = 7;
    let failure = "";
    let expectedCookie = "mint_session=fixture-browser-session-token";
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const endpoint = new URL(String(url));
      calls.push(endpoint.pathname);
      assert.equal(init.method, "GET");
      assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "error");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("cookie"), expectedCookie);
      assert.equal(headers.get("x-mint-gateway-token"), "A".repeat(43));
      assert.equal(headers.get("x-user-role"), null);
      assert.equal(headers.get("authorization"), null);
      if (endpoint.pathname === "/trpc/accounts.session") return Response.json({ result: { data: user } });
      assert.equal(endpoint.pathname, "/trpc/accounts.pendingAccessRequestCount");
      assert.equal(endpoint.search, "");
      if (failure === "revoked") return Response.json({
        error: { code: -32003, message: "private-upstream-connection", data: { code: "FORBIDDEN" } },
      });
      if (failure) throw new Error("private-upstream-connection");
      return Response.json({ result: { data: count } });
    };
    const request = (cookie = "mint_session=fixture-browser-session-token") =>
      new Request("https://web.fixture.test/api/admin/access-requests/pending-count?pending=99&role=admin", {
        headers: { cookie, "x-user-role": "admin", authorization: "untrusted-client-input" },
      });
    const check = async (status, body, req = request()) => {
      const response = await GET(req);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await response.json(), body);
    };
    await check(200, 7);
    count = 0;
    await check(200, 0);
    for (const principal of [null, { ...admin, role: "user" }, { ...admin, status: "disabled" }]) {
      user = principal;
      calls.length = 0;
      await check(principal ? 403 : 401, { error: principal ? "Forbidden." : "Unauthorized." });
      assert.deepEqual(calls, ["/trpc/accounts.session"]);
    }
    user = null;
    expectedCookie = null;
    await check(401, { error: "Unauthorized." },
      new Request("https://web.fixture.test/api/admin/access-requests/pending-count", {
        headers: { "x-user-role": "admin" },
      }));
    expectedCookie = "mint_session=fixture-browser-session-token";
    user = admin;
    const logs = [];
    console.error = (...args) => logs.push(args);
    for (const invalid of [-1, 0.5, "7", null, Number.MAX_SAFE_INTEGER + 1]) {
      count = invalid;
      await check(502, { error: "Target API unavailable." });
    }
    for (const mode of ["network", "revoked"]) {
      failure = mode;
      await check(502, { error: "Target API unavailable." });
    }
    failure = "";
    await check(401, { error: "Invalid browser session." }, request("mint_session=bad!"));
    await check(401, { error: "Invalid browser session." },
      request("mint_session=fixture-browser-session-token; mint_session=fixture-browser-session-token"));
    delete process.env.MINT_TARGET_API_URL;
    await check(503, { error: "Target API unavailable." });
    assert.ok(logs.length);
    assert.ok(logs.every(([message]) => ["TargetApiRequestError", "TargetApiConfigurationError"].includes(message)));
  `, true);
});

test("app shell uses the target count only for admins and keeps target collections honestly unavailable", () => {
  run(`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as React from "react";
    globalThis.React = React;
    const module = (name, namedExports) => mock.module(new URL(name, import.meta.url), { namedExports });
    const component = () => null;
    mock.module("@mint/core/db", { namedExports: { getDb: () => { legacyDb++; return {}; } } });
    module("./src/components/app/acquisition-alerts.tsx", { AcquisitionAlerts: component });
    module("./src/components/app/sidebar-nav.tsx", {
      MobileNav: component, PendingRequestsProvider: component, SettingsLink: component, SidebarNav: component,
    });
    module("./src/components/app/player.tsx", {
      MusicStage: component, PlayerBar: component, PlayerProvider: component, SearchShortcut: component,
    });
    module("./src/components/logo.tsx", { Logo: component });
    module("./src/components/ui/toast.tsx", { ToastProvider: component });
    let user = { id: "fixture-admin", name: "Admin", role: "admin", status: "active" };
    module("./src/lib/auth.ts", { requireUser: async () => user });
    let legacyCount = 0, legacyDb = 0, legacyCollections = 0, targetCount = 0;
    module("./src/lib/data.ts", { getPendingCount: async () => { legacyCount++; return 3; } });
    module("./src/lib/music-store.ts", {
      listCollections: async () => { legacyCollections++; return { collections: [] }; },
    });
    let enabled = true, failure = false;
    module("./src/lib/target-auth.ts", {
      targetAuthenticationEnabled: () => enabled,
      targetAuthentication: async () => ({
        sdk: { accounts: { pendingAccessRequestCount: async ({ signal }) => {
          assert.ok(signal instanceof AbortSignal);
          targetCount++;
          if (failure) throw new Error("private-upstream-connection");
          return 8;
        } } },
        signal: new AbortController().signal,
      }),
    });
    const { default: Layout } = await import("./src/app/app/layout.tsx");
    const props = [];
    function collect(element) {
      if (!element || typeof element !== "object") return;
      if (element.props) {
        props.push(element.props);
        React.Children.forEach(element.props.children, collect);
      }
    }
    async function layout() {
      props.length = 0;
      collect(await Layout({ children: null }));
      return props;
    }
    await layout();
    assert.equal(targetCount, 1);
    assert.ok(props.some(p => p.initial === 8 && p.enabled === true));
    assert.equal(props.filter(p => p.pendingRequests === 8).length, 2);
    assert.ok(props.some(p => p.playlistsError === true && p.playlistsUnavailable === true && p.playlists.length === 0));
    assert.equal(legacyDb + legacyCollections + legacyCount, 0);
    failure = true;
    const logs = [];
    console.error = (...args) => logs.push(args);
    await layout();
    assert.equal(props.filter(p => p.pendingRequests === null).length, 2);
    assert.deepEqual(logs, [["TargetPendingRequestsUnavailable"]]);
    user = { ...user, role: "user" };
    const previousCount = targetCount;
    await layout();
    assert.equal(targetCount, previousCount);
    assert.ok(props.some(p => p.enabled === false));
    assert.equal(legacyDb + legacyCollections + legacyCount, 0);
    user = { ...user, role: "admin" };
    enabled = false;
    await layout();
    assert.equal(legacyDb, 1);
    assert.equal(legacyCollections, 1);
    assert.equal(legacyCount, 1);
    assert.equal(props.filter(p => p.pendingRequests === 3).length, 2);
  `);
});

test("target pending counts refresh visibly, share state, recover on retry and discard cancelled responses", () => {
  run(`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as React from "react";
    const values = [];
    let index = 0, effect;
    mock.module("react", { defaultExport: { ...React }, namedExports: {
      ...React,
      useState: initial => {
        const key = index++;
        if (!(key in values)) values[key] = initial;
        return [values[key], next => { values[key] = typeof next === "function" ? next(values[key]) : next; }];
      },
      useEffect: callback => { effect = callback; },
    } });
    let path = "/app", query = "";
    mock.module("next/navigation", { namedExports: {
      usePathname: () => path, useSearchParams: () => new URLSearchParams(query), useRouter: () => ({ refresh() {} }),
    } });
    const { PendingRequestsProvider } = await import("./src/components/app/sidebar-nav.tsx");
    const doc = new EventTarget();
    doc.visibilityState = "visible";
    globalThis.document = doc;
    const win = new EventTarget();
    let interval, cleared = 0;
    win.setInterval = (callback, ms) => { assert.equal(ms, 5000); interval = callback; return 1; };
    win.clearInterval = () => { cleared++; };
    globalThis.window = win;
    let calls = 0, value = 9, failure = false, deferred;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, "/api/admin/access-requests/pending-count");
      assert.equal(init.cache, "no-store");
      assert.equal(init.credentials, "same-origin");
      assert.ok(init.signal instanceof AbortSignal);
      if (deferred) return await deferred;
      return failure ? new Response(null, { status: 403 }) : Response.json(value);
    };
    let initial = 4;
    const render = (enabled = true) => {
      index = 0;
      return PendingRequestsProvider({ enabled, initial, children: null }).props.value;
    };
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
    assert.equal(render().pending, 4);
    let cleanup = effect();
    await flush();
    assert.equal(render().pending, 9);
    value = 0;
    interval();
    await flush();
    assert.equal(render().pending, 0);
    failure = true;
    win.dispatchEvent(new Event("focus"));
    await flush();
    assert.equal(render().pending, null);
    failure = false;
    value = "9";
    interval();
    await flush();
    assert.equal(render().pending, null);
    value = 2;
    render().retry();
    cleanup();
    render();
    cleanup = effect();
    await flush();
    assert.equal(render().pending, 2);
    doc.visibilityState = "hidden";
    const before = calls;
    interval();
    win.dispatchEvent(new Event("focus"));
    await flush();
    assert.equal(calls, before);
    doc.visibilityState = "visible";
    value = 6;
    doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(render().pending, 6);
    initial = 5;
    render();
    assert.equal(render().pending, 5, "router refresh seeds the new server count without remounting playback");
    let resolve;
    deferred = new Promise(done => { resolve = done; });
    interval();
    interval();
    assert.equal(calls, before + 2, "coalesce concurrent refreshes");
    cleanup();
    resolve(Response.json(99));
    await flush();
    assert.equal(render().pending, 5, "unmounted response cannot overwrite state");
    deferred = undefined;
    path = "/app/manage";
    query = "tab=requests";
    render();
    cleanup = effect();
    await flush();
    const activeCalls = calls;
    cleanup();
    interval();
    await flush();
    assert.ok(cleared >= 3);
    assert.equal(render(false), null);
    assert.equal(effect(), undefined, "members and legacy mode do not poll");
    assert.equal(calls, activeCalls);
  `);
});

test("sidebar and Settings show the same target count or accessible failure with retry, not legacy events", () => {
  run(`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    globalThis.React = React;
    let path = "/app", legacySubscriptions = 0;
    mock.module("next/navigation", { namedExports: {
      usePathname: () => path, useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {} }),
    } });
    mock.module(new URL("./src/components/realtime.tsx", import.meta.url), { namedExports: {
      useRealtime: () => { legacySubscriptions++; },
    } });
    const { PendingRequestsProvider, SidebarNav, SettingsLink } = await import("./src/components/app/sidebar-nav.tsx");
    const render = (pending, enabled = true) => renderToStaticMarkup(React.createElement(PendingRequestsProvider,
      { enabled, initial: pending },
      React.createElement(SidebarNav, { isAdmin: true, pendingRequests: pending, playlistsError: true }),
      React.createElement(SettingsLink, { name: "Admin", pendingRequests: pending })));
    let html = render(7);
    assert.match(html, /Admin portal \\(7 pending\\)/);
    assert.match(html, /Settings \\(7 pending in Admin portal\\)/);
    assert.equal(legacySubscriptions, 0);
    html = render(null);
    assert.match(html, /Admin portal \\(pending requests unavailable\\)/);
    assert.match(html, /Settings \\(pending requests unavailable\\)/);
    assert.match(html, /Retry loading pending requests/);
    assert.match(html, /Playlists couldn’t refresh/);
    assert.doesNotMatch(html, /Your playlists will appear here/);
    assert.equal(legacySubscriptions, 0);
    path = "/app/manage";
    html = render(null);
    assert.match(html, /Members \\(pending requests unavailable\\)/);
    assert.match(html, /Retry loading pending requests/);
    assert.equal((html.match(/aria-label="Retry loading pending requests"/g) ?? []).length, 2,
      "one sidebar retry and one mobile Settings retry, never one per admin group");
    html = render(0);
    assert.doesNotMatch(html, /pending requests unavailable|Retry loading pending requests/);
    render(3, false);
    assert.equal(legacySubscriptions, 1, "legacy mode retains its realtime subscription");
  `);
});

test("target sidebar never refreshes or displays legacy collections even when legacy data is supplied", () => {
  run(`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    globalThis.React = React;
    const effects = [];
    mock.module("react", { defaultExport: { ...React }, namedExports: {
      ...React, useEffect: callback => { effects.push(callback); },
    } });
    mock.module("next/navigation", { namedExports: {
      usePathname: () => "/app", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {} }),
    } });
    mock.module("next/link", { defaultExport: ({ href, children, ...props }) =>
      React.createElement("a", { href, ...props }, children) });
    const { SidebarNav } = await import("./src/components/app/sidebar-nav.tsx");
    let requests = 0, timers = 0;
    globalThis.fetch = async (url) => {
      assert.equal(url, "/api/music/collections");
      requests++;
      return Response.json({ collections: [] });
    };
    const win = new EventTarget();
    win.setInterval = () => { timers++; return 1; };
    win.clearInterval = () => {};
    globalThis.window = win;
    const doc = new EventTarget();
    doc.visibilityState = "visible";
    globalThis.document = doc;
    const props = { isAdmin: false, pendingRequests: 0, playlistsUnavailable: true,
      playlists: [{ id: "legacy", title: "Legacy private playlist", artworkUrl: null,
        smart: false, role: "owner", pinned: false }] };
    const html = renderToStaticMarkup(React.createElement(SidebarNav, props));
    assert.match(html, /Playlists are unavailable/);
    assert.match(html, /Retry loading playlists/);
    assert.doesNotMatch(html, /Legacy private playlist|Your playlists will appear here/);
    assert.equal(effects.length, 1);
    assert.equal(effects.pop()(), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
    assert.equal(timers, 0);
    renderToStaticMarkup(React.createElement(SidebarNav, { ...props, playlistsUnavailable: false }));
    const cleanup = effects.pop()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, "legacy mode retains its collection refresh");
    assert.equal(timers, 1);
    cleanup();
  `);
});
