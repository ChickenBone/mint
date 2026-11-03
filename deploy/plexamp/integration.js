/* Integration seams are pinned to Plexamp 4.13.2; Mint owns chrome, not the music UI. */
(() => {
  const channel = "mint-player-v2";
  const origin = location.origin;
  const send = (payload) => window.parent.postMessage({ channel, ...payload }, origin);
  const itemKey = /^\/(?:library\/metadata\/[A-Za-z0-9_,=-]+(?:\/(?:children|allLeaves))?|playlists\/(?:liked|[0-9a-f-]{36})(?:\/items)?)$/;
  let root, tabNavigation, adapter, ready = false, lastPoint, contextEvent, pendingMenu;
  let lastUpdate = 0, updateTimer;
  const metadata = (item) => item && itemKey.test(item.key) && ["track", "album", "artist", "playlist"].includes(item.type) ? {
    key: item.key, ratingKey: String(item.ratingKey ?? ""), title: String(item.title ?? "").slice(0, 1000), type: item.type,
    artist: item.grandparentTitle ?? item.parentTitle, album: item.parentTitle,
    thumb: item.thumb, parentKey: item.parentKey, grandparentKey: item.grandparentKey,
    queueId: item.playQueueItemID ? String(item.playQueueItemID) : undefined,
  } : null;
  const announce = () => {
    const audio = adapter?.getAudio();
    if (!audio || !root || !tabNavigation) return;
    if (!ready) { ready = true; send({ type: "ready" }); }
    const offset = Math.max(0, audio.index - 20);
    send({ type: "state", state: {
      playing: !audio.element.paused && Boolean(audio.element.getAttribute("src")),
      time: audio.state.time ?? 0, duration: audio.state.duration ?? 0,
      volume: audio.state.volume ?? 100, shuffle: audio.shuffle, repeat: audio.repeat,
      track: metadata(audio.queue[audio.index]), queue: audio.queue.slice(offset, offset + 1000).map(metadata).filter(Boolean),
      queueTotal: audio.queue.length, queueOffset: offset,
    } });
  };
  function navigate(view) {
    const native = adapter.require(88680).default;
    if (view === "now-playing") return native.navigate("Player");
    if (native.currentRoute()?.name === "Player") native.pop();
    tabNavigation.navigate(view === "home" ? "Discover" : view === "library" ? "Library" : "Search");
  }
  async function command(data) {
    const audio = adapter.getAudio(), controller = adapter.getController();
    if (!ready || !audio || !controller) throw new Error("The music engine is still starting. Try again in a moment.");
    switch (data.action) {
      case "state": break;
      case "navigate":
        if (!["home", "library", "search", "now-playing"].includes(data.view)) throw new Error("Invalid music view");
        navigate(data.view);
        break;
      case "toggle": if (audio.element.getAttribute("src")) await (audio.element.paused ? controller.doResume() : controller.doPause()); break;
      case "next": await controller.doNextTrack(); break;
      case "previous": await controller.doPreviousTrack(); break;
      case "volume": case "seek":
        if (!Number.isFinite(data.value) || data.value < 0 || data.value > (data.action === "volume" ? 100 : audio.state.duration)) throw new Error("Invalid playback value");
        if (data.action === "volume") await controller.doSetVolume(data.value);
        else await controller.doSeekTo(data.value);
        break;
      case "shuffle": await controller.doSetShuffle(!audio.shuffle); break;
      case "repeat": await controller.doSetRepeatMode((audio.repeat + 1) % 3); break;
      case "play": case "add-to-queue": case "next-in-queue": case "browse": {
        const item = data.item;
        if (!item || typeof item.key !== "string" || item.key.length > 20_000 || !itemKey.test(item.key) ||
            typeof item.title !== "string" || item.title.length > 1000 ||
            !["track", "album", "artist", "playlist"].includes(item.type)) throw new Error("Invalid music selection");
        const Metadata = adapter.require(60626).default;
        const native = new Metadata({ key: item.key, ratingKey: item.ratingKey, type: item.type, title: item.title,
          grandparentTitle: item.artist, parentTitle: item.album, source: "mint" });
        if (data.action === "browse") {
          navigate("library");
          adapter.require(88680).default.navigate("Browser", { item: native, key: native.fullKey() });
        } else if (data.action === "play") {
          const containerKey = item.type === "album" && !item.key.endsWith("/children") ? `${item.key}/children`
            : item.type === "artist" ? item.key.replace(/\/children$/, "") + "/allLeaves" : item.type === "playlist" ? item.key : undefined;
          await root.player.play({ key: item.key, containerKey, source: "mint" });
        } else {
          if (!audio.queue.length || !audio.element.getAttribute("src")) throw new Error("Play a song before adding to the queue.");
          await root.player.addToPlayQueue(native, data.action === "next-in-queue");
        }
        break;
      }
      case "skip": case "remove": {
        if (!/^\d+$/.test(data.queueId ?? "")) throw new Error("Invalid queue item");
        const item = root.player.playQueue.find((track) => String(track.playQueueItemID) === data.queueId);
        if (!item) throw new Error("That queue item is no longer available.");
        if (data.action === "skip") await root.player.skipToTrack(item);
        else await root.player.removeFromPlayQueue(item);
        break;
      }
      case "clear": await root.player.clearPlayQueue(); break;
      default: throw new Error("This action is not available in Mint.");
    }
    announce();
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== origin || event.source !== window.parent || event.data?.channel !== channel ||
        event.data?.type !== "command" || !event.data.command || typeof event.data.id !== "string" || event.data.id.length > 80) return;
    void command(event.data.command).then(() => send({ type: "result", id: event.data.id, ok: true }))
      .catch((error) => send({ type: "result", id: event.data.id, ok: false, message: error.message }));
  });
  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest?.("input,textarea,[contenteditable=true]")) return;
    const rect = event.target.getBoundingClientRect?.();
    lastPoint = { x: event.clientX || rect?.x || 16, y: event.clientY || rect?.bottom || 16 };
    contextEvent = event;
    queueMicrotask(() => { contextEvent = undefined; });
  }, true);
  document.addEventListener("pointerdown", (event) => {
    lastPoint = { x: event.clientX, y: event.clientY };
    send({ type: "dismiss-menu" });
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send({ type: "dismiss-menu" });
    if (event.target.closest?.("input,textarea,[contenteditable=true]") || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === "Space" && event.target === document.body) {
      event.preventDefault();
      void command({ action: "toggle" }).catch((error) => send({ type: "error", message: error.message }));
    }
  });
  window.mintShell = {
    update(force = false) {
      const delay = 500 - (Date.now() - lastUpdate);
      if (force || delay <= 0) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
        lastUpdate = Date.now();
        announce();
      } else if (!updateTimer) {
        updateTimer = setTimeout(() => {
          updateTimer = undefined;
          lastUpdate = Date.now();
          announce();
        }, delay);
      }
    },
    error(message) { send({ type: "error", message }); },
    install(require, factories, api) {
      for (const id of [43662, 5713, 76167, 75415, 67981, 52626, 2121, 53593, 72003, 87279]) {
        if (typeof factories[id] !== "function") throw new Error("Plexamp integration changed. This version needs an adapter update.");
      }
      adapter = { ...api, require };
      const palette = factories[67981];
      factories[67981] = (module, exports, req) => {
        palette(module, exports, req);
        const image = exports.computeImageUrl;
        exports.computeImageUrl = (source, thumb, ...args) => {
          for (let depth = 0; depth < 3 && typeof thumb === "string" && thumb.startsWith("/photo/:/transcode?"); depth++) {
            thumb = new URL(thumb, origin).searchParams.get("url");
          }
          return image(source, thumb, ...args);
        };
        exports.extractPalette = async () => ["#3fe0a0", "#121614", "#1a1f1d", "#232a27"];
        exports.pickBestGradientColors = () => ["#121614", "#121614"];
        exports.pickBestCircularGradientColors = () => ["#121614", "#121614", "#121614", "#121614"];
        exports.pickTwoAccentColors = () => ["#f2f5f325", "#3fe0a0"];
        exports.getSolidBackgroundColor = () => "#121614";
      };
      const discovery = factories[52626];
      factories[52626] = (module, exports, req) => {
        discovery(module, exports, req);
        const hubs = exports.useCombinedHubs;
        exports.useCombinedHubs = () => hubs().filter((hub) => hub.type !== "station" &&
          !(hub.hubIdentifier === "music.recent.plays" && !hub.items.length));
      };
      for (const id of [2121, 53593]) factories[id] = (_module, exports) => { exports.__esModule = true; exports.default = () => null; };
      const iconButton = factories[72003];
      factories[72003] = (module, exports, req) => {
        iconButton(module, exports, req);
        const original = exports.default;
        exports.default = (props) => ["download", "add-files", "add-to-playlist", "home-add"].includes(props.icon)
          ? null : req(96540).createElement(original, props);
      };
      const layout = factories[87279];
      factories[87279] = (module, exports, req) => {
        layout(module, exports, req);
        exports.default.MINI_PLAYER_HEIGHT = 0;
      };
      const store = factories[43662];
      factories[43662] = (module, exports, req) => {
        store(module, exports, req);
        exports.default = class extends exports.default { constructor(...args) { super(...args); root = this; } };
      };
      const theme = factories[5713];
      factories[5713] = (module, exports, req) => {
        theme(module, exports, req);
        exports.default = class extends exports.default {
          constructor(...args) {
            super(...args);
            const palette = {
              textColor: "#f2f5f3", lightTextColor: "#a3ada8", faintTextColor: "#7d8883", superfaintTextColor: "#7d8883",
              background: "#121614", pureBackground: "#0a0d0c", backgroundColorOverlay: "#121614",
              menuOverlay: "#1a1f1d", textFieldBackground: "#1a1f1d", bottomBorderColor: "#2a322f",
              seekBarPastNormalColor: "#3fe0a0", seekBarPastHoverColor: "#5cf0b4", seekBarFutureNormalColor: "#2a322f",
              playerProgressBarColor: "#3fe0a0", playerProgressBarColorPast: "#3fe0a0",
              playerProgressBarBackgroundColor: "#2a322f", miniPlayerProgressBarColor: "#3fe0a0",
              bottomBarBackgroundColor: "#121614", bottomBarNavIconFocused: "#3fe0a0",
              bottomBarNavIconUnfocused: "#a3ada8", modalBackgroundColor: "#1a1f1d",
              modalTextColor: "#f2f5f3", modalBottomBorderColor: "#2a322f", focusHighlight: "#232a27",
            };
            for (const style of [this.darkStyle, this.blackStyle, this.lightStyle, this.whiteStyle]) Object.assign(style, palette);
            Object.assign(this.style, palette);
            this.setNavigationTheme();
          }
        };
      };
      const tabs = factories[75415];
      factories[75415] = (module, exports, req) => {
        tabs(module, exports, req);
        const original = exports.default;
        exports.default = Object.assign((props) => {
          tabNavigation = props.navigation;
          setTimeout(announce, 0);
          return null;
        }, original);
      };
      const menu = factories[76167];
      factories[76167] = (module, exports, req) => {
        menu(module, exports, req);
        exports.default = class extends exports.default {
          constructor(...args) {
            super(...args);
            this.popup = (item) => {
              const selected = metadata(item);
              if (!selected) return send({ type: "error", message: "This native Plexamp action is not available in Mint. Use Mint's account and playback controls." });
              contextEvent?.preventDefault();
              if (pendingMenu) {
                if (selected.type === "track") pendingMenu.item = selected;
                return;
              }
              pendingMenu = { type: "menu", item: selected, point: lastPoint ?? { x: innerWidth / 2, y: innerHeight / 2 } };
              queueMicrotask(() => { send(pendingMenu); pendingMenu = undefined; });
            };
          }
        };
      };
      try {
        const parentStyle = window.parent.getComputedStyle(window.parent.document.body);
        document.documentElement.style.setProperty("--mint-font", parentStyle.fontFamily);
        const fonts = [];
        for (const sheet of window.parent.document.styleSheets) {
          if (sheet.href && new URL(sheet.href).origin !== origin) continue;
          for (const rule of sheet.cssRules) if (rule.type === CSSRule.FONT_FACE_RULE && /Figtree/i.test(rule.cssText)) {
            fonts.push(rule.cssText.replace(/url\(["']?([^)"']+)["']?\)/g, (_match, url) => `url("${new URL(url, sheet.href || location.origin).href}")`));
          }
        }
        const style = document.createElement("style");
        style.textContent = fonts.join("\n");
        document.head.appendChild(style);
      } catch (error) { console.warn("Mint player font could not be shared", error.message); }
    },
  };
})();
