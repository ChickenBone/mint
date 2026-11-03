/* Mint's browser adapter for the pinned Plexamp 4.13.2 UI. No native DSP or premium feature emulation. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const originalStorage = window.localStorage;
  const prefix = `mint:plexamp:${window.mintMember.id}:`;
  const memberKeys = () => Array.from({ length: originalStorage.length }, (_, i) => originalStorage.key(i))
    .filter((key) => key?.startsWith(prefix));
  const storage = {
    getItem: (key) => originalStorage.getItem(prefix + key),
    setItem: (key, value) => originalStorage.setItem(prefix + key, value),
    removeItem: (key) => originalStorage.removeItem(prefix + key),
    clear: () => memberKeys().forEach((key) => originalStorage.removeItem(key)),
    key: (index) => memberKeys()[index]?.slice(prefix.length) ?? null,
    get length() { return memberKeys().length; },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: new Proxy(storage, {
    ownKeys: () => memberKeys().map((key) => key.slice(prefix.length)),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && storage.getItem(key) !== null
      ? { configurable: true, enumerable: true, value: storage.getItem(key), writable: true } : undefined,
    get: (target, key, receiver) => Reflect.has(target, key) ? Reflect.get(target, key, receiver)
      : typeof key === "string" ? storage.getItem(key) ?? undefined : undefined,
    set: (_target, key, value) => { storage.setItem(String(key), String(value)); return true; },
    deleteProperty: (_target, key) => { storage.removeItem(String(key)); return true; },
  }) });
  const initial = {
    "user:token": "mint-session", "user:id": 1, "user:name": window.mintMember.name,
    "player:identifier": "local", "server:identifier": "mint", "server:library": "/library/sections/1",
    "settings:showFullScreenPlayerOnPlay": false,
  };
  for (const [key, value] of Object.entries(initial)) {
    storage.setItem(`@Plexamp:${key}`, `${typeof value === "number" ? "N" : typeof value === "boolean" ? "B" : "S"}${value}`);
  }
  if (window.mintEmbedded) storage.setItem("@Plexamp:settings:theme", "Sdark");
  // Queues stay per tab; never restore another member's or a stale playback state.
  storage.removeItem("@Plexamp:state");
  window.playerIdentifier = "local";
  let audio;
  let metadataClass;
  let browserController;
  let queueSequence = 0;

  function report(message) {
    const alert = document.getElementById("mint-player-error");
    alert.textContent = message;
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.onclick = () => { alert.hidden = true; };
    alert.appendChild(dismiss);
    alert.hidden = false;
    window.mintShell?.error(message);
  }

  async function signOut() {
    const response = await nativeFetch("/listen/api/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) {
      report("Mint could not sign you out. Return to Mint and try again.");
      throw new Error("Mint sign-out failed");
    }
    audio?.stop();
    storage.clear();
    if (window.mintEmbedded) window.parent.location.assign("/");
    else location.assign("/");
  }

  async function loadTracks(key) {
    const url = new URL(`/listen/api/server${key}`, location.origin);
    url.searchParams.set("X-Plex-Container-Size", "500");
    const tracks = [];
    let offset = 0;
    let total;
    do {
      url.searchParams.set("X-Plex-Container-Start", String(offset));
      const response = await window.fetch(url);
      if (!response.ok) throw new Error("Unable to load the selected tracks. Check your connection and membership.");
      const result = (await response.json()).MediaContainer;
      const page = result.Metadata ?? [];
      total = result.totalSize ?? page.length;
      if (!page.length && offset < total) throw new Error("The library changed while loading. Select the music again.");
      tracks.push(...page);
      offset += page.length;
    } while (offset < total);
    return tracks;
  }
  const queueTracks = (tracks) => tracks.filter((track) => track.type === "track")
    .map((track) => ({ ...track, playQueueItemID: String(++queueSequence) }));
  function shuffled(items) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  const playlist = () => ({
    MediaContainer: {
      size: audio?.queue.length ?? 0, totalSize: audio?.queue.length ?? 0,
      playQueueID: "1", playQueueVersion: audio?.version ?? 1, playQueueTotalCount: audio?.queue.length ?? 0,
      playQueueSelectedItemID: audio?.queue[audio.index]?.playQueueItemID, playQueueSelectedItemOffset: audio?.index ?? 0,
      playQueueShuffled: audio?.shuffle ?? false, playQueueAllowShuffle: true, playQueueAllowRepeat: true,
      playQueueAllowSkipNext: true, playQueueAllowSkipPrevious: true, identifier: "com.plexapp.plugins.library",
      Metadata: audio?.queue ?? [],
    },
  });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input, location.href);
    if (url.origin === location.origin && url.pathname === "/listen/settings") return Response.json({});
    if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user/settings") {
      const key = `cloud:${url.searchParams.get("key")}`;
      if ((init?.method ?? "get").toLowerCase() === "post") {
        const value = new URLSearchParams(init.body).get("value");
        const data = JSON.parse(value);
        if (data.version !== 1 || !Array.isArray(data.data)) throw new Error("Invalid member-local player data");
        storage.setItem(key, JSON.stringify(data));
        return Response.json(data);
      }
      return Response.json(JSON.parse(storage.getItem(key) ?? '{"version":1,"data":[]}'));
    }
    if (url.hostname === "plex.tv" && url.pathname === "/api/v2/shared_sources/received") return Response.json([]);
    if (url.pathname.startsWith("/listen/api/server/playQueues/") && url.origin === location.origin) {
      const endpoint = url.pathname.slice("/listen/api/server".length);
      const method = (init?.method ?? "get").toLowerCase();
      if (method === "get" && endpoint === "/playQueues/1") return Response.json(playlist());
      if (!audio) return Response.json({ error: "Start playback before changing the queue" }, { status: 409 });
      try {
        audio.cancelTransition();
        const selected = audio.queue[audio.index];
        const item = /^\/playQueues\/1\/items\/(\d+)(\/move)?$/.exec(endpoint);
        if (method === "put" && endpoint === "/playQueues/1" && url.searchParams.has("uri")) {
          const uri = url.searchParams.get("uri");
          const directory = uri.indexOf("/directory/");
          const key = directory >= 0 ? decodeURIComponent(uri.slice(directory + 11)) : uri.slice(uri.indexOf("/library/"));
          if (!/^\/(?:library\/metadata\/|playlists\/)/.test(key)) throw new Error("This item cannot be added to the browser queue");
          const additions = queueTracks(await loadTracks(key));
          if (!additions.length) throw new Error("No downloaded tracks are available to add");
          const after = url.searchParams.get("after");
          const index = after ? audio.queue.findIndex((track) => track.playQueueItemID === after) + 1
            : url.searchParams.get("next") === "1" ? audio.index + 1 : audio.queue.length;
          audio.queue.splice(index, 0, ...additions);
        } else if (method === "delete" && endpoint === "/playQueues/1/items") {
          audio.queue = selected ? [selected] : [];
          audio.index = 0;
        } else if (item && ((method === "delete" && !item[2]) || (method === "put" && item[2]))) {
          const index = audio.queue.findIndex((track) => track.playQueueItemID === item[1]);
          if (index < 0) throw new Error("This queue item is no longer available");
          const [removed] = audio.queue.splice(index, 1);
          if (item[2]) {
            const after = url.searchParams.get("after");
            audio.queue.splice(after === "-1" ? 0 : audio.queue.findIndex((track) => track.playQueueItemID === after) + 1, 0, removed);
          } else if (selected === removed) {
            audio.version++;
            if (audio.queue.length) await audio.select(Math.min(index, audio.queue.length - 1), 0, audio.element.paused);
            else audio.stop();
          }
        } else return Response.json({ error: "This queue operation is not supported" }, { status: 405 });
        if (selected && audio.queue.includes(selected)) audio.index = audio.queue.indexOf(selected);
        audio.version++;
        audio.update();
        return Response.json(playlist());
      } catch (error) {
        report(error.message);
        return Response.json({ error: error.message }, { status: 400 });
      }
    }
    if (url.origin !== location.origin) {
      if (url.hostname === "sonos.plex.tv") return new Response('<MediaContainer size="0"/>');
      if (url.hostname === "plex.tv" || url.hostname === "www.plex.tv") {
        return nativeFetch(`/listen/api/cloud${url.pathname}${url.search}`, { ...init, credentials: "same-origin" });
      }
      // Plexamp telemetry, external discovery and native services are not part of this adapter.
      throw new Error("External Plexamp service is disabled in Mint");
    }
    if (url.pathname.startsWith("/listen/api/")) {
      const response = await nativeFetch(url, { ...init, credentials: "same-origin" });
      if (response.status === 401) {
        audio?.stop();
        report("Your Mint session has ended or membership is no longer approved. Sign in again.");
      }
      return response;
    }
    return nativeFetch(input, init);
  };

  class BrowserAudio {
    constructor(app) {
      this.app = app;
      this.queue = [];
      this.index = 0;
      this.version = 1;
      this.repeat = 0;
      this.shuffle = false;
      this.devices = [];
      this.state = { volume: 100, state: "stopped" };
      this.elements = [0, 1].map((index) => {
        const element = document.createElement("audio");
        element.preload = "metadata";
        element.id = index === 0 ? "mint-browser-audio" : "mint-browser-standby";
        document.body.appendChild(element);
        for (const name of ["playing", "pause", "timeupdate", "durationchange", "volumechange", "waiting", "seeked"]) {
          element.addEventListener(name, () => {
            if (element === this.element) {
              this.update();
              if (name === "timeupdate") void this.transition().catch((error) => report(error.message));
            }
          });
        }
        element.addEventListener("ended", () => {
          if (element === this.element) void this.next(true).catch((error) => report(error.message));
        });
        element.addEventListener("error", () => {
          if (element !== this.element) { this.prepared = undefined; return report("The next track could not preload. Playback will try it normally at the end of this song."); }
          this.pause();
          report("This track could not play. Check its file mapping, permissions and browser codec support.");
          this.update();
        });
        return element;
      });
      this.element = this.elements[0];
      this.dsp = window.MintBrowserDSP ? new window.MintBrowserDSP(this.elements, report) : null;
      audio = this;
      this.visibility = setInterval(() => {
        void nativeFetch("/listen/api/server/identity", { cache: "no-store" }).then((response) => {
          if (!response.ok) {
            this.stop();
            report(response.status === 401 ? "Playback access has expired. Return to Mint and sign in again." : "Mint could not verify playback access. Check your connection and try again.");
          }
        }).catch(() => {
          this.stop();
          report("Mint is unreachable. Playback has stopped; check your connection.");
        });
      }, 15000);
      window.addEventListener("pagehide", () => { clearInterval(this.visibility); this.stop(); });
    }
    async initialize() {}
    enableStateUpdates() {}
    disableStateUpdates() {}
    getState() { return this.state; }
    findActiveDevice() { return null; }
    async refreshDevices() {}
    setRate(rate) { for (const element of this.elements) element.playbackRate = rate; }
    setVolume(volume) { for (const element of this.elements) element.volume = Math.max(0, Math.min(1, volume / 100)); this.update(); }
    cancelTransition() {
      clearTimeout(this.fadeTimer);
      this.transitioning = false;
      this.prepared = undefined;
      for (const element of this.elements) if (element !== this.element) {
        element.pause(); element.removeAttribute("src"); element.load();
      }
      this.dsp?.select(this.element);
    }
    async pause() { this.playGeneration = (this.playGeneration ?? 0) + 1; this.cancelTransition(); this.element.pause(); this.update(); }
    async resume() {
      if (!this.element.getAttribute("src") && this.queue[this.index]) return this.select(this.index);
      try { await this.dsp?.initialize(); await this.element.play(); document.getElementById("mint-player-error").hidden = true; }
      catch (error) {
        report(error.name === "NotAllowedError" ? "Your browser needs a tap to start audio. Press Play again." : "Unable to start audio. Check the track and your connection.");
        throw error;
      }
    }
    stop() { this.playGeneration = (this.playGeneration ?? 0) + 1; this.cancelTransition(); this.element.pause(); this.element.removeAttribute("src"); this.element.load(); this.state.state = "stopped"; this.update(); }
    seekTo(ms) { this.cancelTransition(); if (Number.isFinite(ms)) this.element.currentTime = Math.max(0, ms / 1000); this.update(); }
    setRepeatMode(mode) { this.cancelTransition(); this.repeat = mode; this.update(); }
    setShuffle(value) {
      const current = this.queue[this.index];
      this.cancelTransition();
      this.shuffle = Boolean(value);
      this.queue = value ? [...this.queue.slice(0, this.index + 1), ...shuffled(this.queue.slice(this.index + 1))]
        : this.queue.slice().sort((a, b) => Number(a.playQueueItemID) - Number(b.playQueueItemID));
      this.index = Math.max(0, this.queue.indexOf(current));
      this.version++; this.update();
    }
    async transition() {
      const seconds = this.dsp?.settings.crossfade ?? 0;
      const remaining = this.element.duration - this.element.currentTime;
      if (!seconds || this.transitioning || this.element.paused || this.repeat === 1 ||
          !Number.isFinite(remaining) || remaining <= 0 || remaining > seconds + 5) return;
      const index = this.index + 1 < this.queue.length ? this.index + 1 : this.repeat === 2 ? 0 : -1;
      if (index < 0 || index === this.index) return;
      const next = this.queue[index], standby = this.elements.find((element) => element !== this.element);
      if (this.prepared !== next.playQueueItemID) {
        standby.src = `/listen/api/audio/${next.ratingKey}`; standby.preload = "auto"; standby.load();
        this.prepared = next.playQueueItemID;
      }
      if (remaining > seconds || standby.readyState < 3) return;
      this.transitioning = true;
      const from = this.element;
      try {
        await this.dsp.initialize();
        await standby.play();
        if (!this.transitioning || this.element !== from || this.element.paused || this.queue[index] !== next) {
          standby.pause(); return;
        }
        const duration = Math.min(seconds, remaining, (standby.duration || seconds * 2) / 2);
        this.dsp.fade(from, standby, duration);
        this.element = standby; this.index = index; this.prepared = undefined;
        this.update();
        this.fadeTimer = setTimeout(() => {
          from.pause(); from.removeAttribute("src"); from.load();
          this.transitioning = false; this.dsp.select(this.element); this.update();
        }, duration * 1000);
      } catch (error) {
        standby.pause(); this.transitioning = false; this.dsp.select(this.element);
        throw new Error(`Smooth transition failed: ${error.message}`);
      }
    }
    async next(ended = false) {
      if (ended && this.repeat === 1) return this.select(this.index);
      let index = this.index + 1;
      if (index >= this.queue.length) {
        if (this.repeat === 2) index = 0;
        else return this.stop();
      }
      await this.select(index);
    }
    async previous() {
      if (this.element.currentTime > 3) return this.seekTo(0);
      await this.select(Math.max(0, this.index - 1));
    }
    async select(index, offset = 0, paused = false) {
      if (!this.queue[index]) return;
      this.cancelTransition();
      this.index = index;
      this.element.src = `/listen/api/audio/${this.queue[index].ratingKey}`;
      if (offset > 0) this.element.currentTime = offset / 1000;
      this.state.state = paused ? "paused" : "buffering";
      this.update();
      if (!paused) await this.resume();
      this.update();
    }
    update() {
      const track = this.queue[this.index];
      this.state = {
        ...this.state, source: "local", playQueueSource: "mint", playQueueID: this.queue.length ? "1" : undefined,
        playQueueVersion: this.version, playQueueItemID: track?.playQueueItemID,
        state: this.element.getAttribute("src") ? (this.element.paused ? "paused" : "playing") : "stopped",
        time: Math.round(this.element.currentTime * 1000) || 0,
        duration: Number.isFinite(this.element.duration) ? Math.round(this.element.duration * 1000) : track?.duration ?? 0,
        volume: this.element.volume * 100, rate: this.element.playbackRate, repeat: this.repeat, shuffle: this.shuffle,
        controllable: true, key: track?.key, machineIdentifier: "mint", playQueueIndex: this.index,
      };
      this.onStateChanged?.(this.state);
      window.mintShell?.update();
      if ("mediaSession" in navigator && track) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title, artist: track.grandparentTitle, album: track.parentTitle,
          artwork: track.thumb ? [{ src: track.thumb }] : [],
        });
        navigator.mediaSession.playbackState = this.state.state === "playing" ? "playing" : "paused";
        const duration = this.state.duration / 1000, position = this.state.time / 1000;
        if (navigator.mediaSession.setPositionState && duration > 0 && position >= 0 && position <= duration) {
          navigator.mediaSession.setPositionState({ duration, position, playbackRate: this.element.playbackRate });
        }
      }
    }
  }

  window.mintPlexamp = {
    install(require, factories) {
      const application = factories[15779];
      factories[15779] = (module, exports, req) => {
        application(module, exports, req);
        exports.default.prototype.signOut = signOut;
      };
      const telemetry = factories[14782];
      factories[14782] = (module, exports, req) => {
        telemetry(module, exports, req);
        const start = exports.startBugsnag;
        exports.startBugsnag = (client) => start({ start: (options) => client.start({
          ...options, autoTrackSessions: false, enabledReleaseStages: [], enabledBreadcrumbTypes: [], logger: null,
        }) });
      };
      const discovery = factories[95126];
      factories[95126] = (module, exports, req) => {
        discovery(module, exports, req);
        const initialize = exports.default.prototype.initialize;
        exports.default.prototype.initialize = async function (...args) {
          const result = await initialize.apply(this, args);
          const device = this.findDevice("mint");
          if (device) {
            await device.runConnectionTesting();
            await device.fetchLibrariesAndFeaturesFromServer();
          }
          return result;
        };
      };
      const platform = factories[73369];
      factories[73369] = (module, exports, req) => {
        platform(module, exports, req);
        exports.appRootUrl = exports.default.appRootUrl = () => new URL("/listen/", location.origin).href;
      };
      factories[70383] = (_module, exports) => {
        exports.__esModule = true;
        exports.EqualizerFrequencies = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        exports.default = BrowserAudio;
      };
      factories[3010] = (_module, exports, req) => {
        const Base = req(16785).default;
        metadataClass = req(60626).default;
        class BrowserController extends Base {
          constructor(...args) { super(...args); this.source = "local"; }
          async initialize(app) {
            this.app = app;
            browserController = this;
            app.audioController.onStateChanged = () => this.emit();
            if ("mediaSession" in navigator) {
              const actions = { play: () => this.doResume(), pause: () => this.doPause(),
                nexttrack: () => this.doNextTrack(), previoustrack: () => this.doPreviousTrack(),
                seekto: (detail) => this.doSeekTo(detail.seekTime * 1000) };
              for (const [name, handler] of Object.entries(actions)) navigator.mediaSession.setActionHandler(name, handler);
            }
          }
          local() { return true; }
          useTransientToken() { return false; }
          async connect() { return true; }
          async disconnect() {}
          async reconnect() {}
          event() {
            const raw = audio.queue[audio.index];
            return { state: audio.state, track: raw ? new metadataClass({ ...raw, source: "mint" }) : undefined };
          }
          emit() { this.notifyObservers(this.event(), this.eventCounter); }
          async doPoll() { return this.event(); }
          async doPlay(item, started) {
            const generation = audio.playGeneration = (audio.playGeneration ?? 0) + 1;
            try {
              let key = item.containerKey || item.key;
              if (!key && typeof item.uri === "string") {
                const directory = /^library:\/\/[^/]+\/directory\/(.+)$/.exec(item.uri);
                if (directory) {
                  try { key = decodeURIComponent(directory[1]); }
                  catch { throw new Error("This library selection has an invalid encoded key"); }
                }
              }
              if (!key || !key.startsWith("/")) throw new Error("This library item has no playable tracks");
              if (/^\/library\/sections\/1(?:\/all)?(?:\?|$)/.test(key)) {
                const library = new URL(key.replace(/^\/library\/sections\/1(?=\?|$)/, "/library/sections/1/all"), location.origin);
                library.searchParams.set("type", "10");
                key = library.pathname + library.search;
              }
              if (key.startsWith("/playQueues/")) {
                await this.doResume(); started?.(true); this.emit(); return true;
              }
              if (key.includes("/children") && key.includes("/ar_")) key = key.replace("/children", "/allLeaves");
              let result = await loadTracks(key);
              const selected = result[0];
              const selectedKey = item.key ?? (result.length === 1 && selected?.type === "track" ? selected.key : undefined);
              if (!item.containerKey && /^\/library\/metadata\/[^/?]+$/.test(key) && result.length === 1 && selected?.type === "track" && selected.parentKey) {
                result = await loadTracks(`${selected.parentKey}/children`);
              }
              const tracks = queueTracks(result);
              if (generation !== audio.playGeneration) { started?.(false); return false; }
              if (!tracks.length) throw new Error("No downloaded tracks are available for this selection");
              audio.queue = item.shuffle ? shuffled(tracks) : tracks;
              audio.version++;
              audio.shuffle = Boolean(item.shuffle);
              const found = item.shuffle ? -1 : audio.queue.findIndex((track) => track.key === selectedKey);
              await audio.select(found < 0 ? 0 : found, item.offset ?? 0, item.paused ?? false);
              started?.(true);
              this.emit();
              return true;
            } catch (error) { report(error.message); started?.(false); return false; }
          }
          async doPause() { await audio.pause(); }
          async doResume() { await audio.resume(); return true; }
          async doStop() { audio.stop(); }
          async doNextTrack() { await audio.next(); }
          async doPreviousTrack() { await audio.previous(); }
          async doSkipToTrack(track) {
            const index = audio.queue.findIndex((item) => track.playQueueItemID
              ? item.playQueueItemID === String(track.playQueueItemID) : item.key === track.key || item.ratingKey === track.ratingKey);
            if (index >= 0) await audio.select(index);
          }
          async doSeekTo(ms) { audio.seekTo(ms); }
          async doSetVolume(volume) { audio.setVolume(volume); }
          async doSetRate(rate) { audio.setRate(rate); }
          async doSetRepeatMode(mode) { audio.setRepeatMode(mode); }
          async doSetShuffle(shuffle) { audio.setShuffle(shuffle); }
          async doRefreshPlayQueue() { this.emit(); }
        }
        exports.__esModule = true;
        exports.default = BrowserController;
      };
      window.mintShell?.install(require, factories, { getAudio: () => audio, getController: () => browserController });
    },
  };
})();
