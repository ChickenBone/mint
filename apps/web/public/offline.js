/* Only explicit downloads are read here; authenticated pages are never cached. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const audio = $("audio");
  let db, songs = [], collections = [], queue = [], originalQueue = [], index = -1, url, grant, shuffle = false, repeat = false;
  const selectedSongs = () => {
    const collection = collections.find((collection) => collection.id === $("collection").value);
    if (!collection) return songs;
    const available = new Map(songs.map((song) => [song.id, song]));
    return collection.trackIds.map((id) => available.get(id)).filter(Boolean);
  };
  const fail = (error) => { $("error").textContent = error instanceof Error ? error.message : String(error); };
  const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const transaction = (stores, mode, run) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("Offline storage failed."));
    run(tx, (value) => { result = value; });
  });
  const read = (store, key) => transaction([store], "readonly", (tx, done) => {
    const request = key ? tx.objectStore(store).get(key) : tx.objectStore(store).getAll();
    request.onsuccess = () => done(request.result);
  });
  const clear = async () => {
    audio.pause(); audio.removeAttribute("src"); audio.load();
    if (url) URL.revokeObjectURL(url);
    await transaction(["songs", "settings", "collections"], "readwrite", (tx) => { tx.objectStore("songs").clear(); tx.objectStore("settings").clear(); tx.objectStore("collections").clear(); });
    for (const key of Object.keys(localStorage)) if (key.startsWith("mint:player:")) localStorage.removeItem(key);
    songs = []; collections = []; queue = []; index = -1; render(); $("player").hidden = true; $("status").textContent = "Downloads removed from this device.";
  };
  const valid = () => {
    if (!grant || grant.expiresAt <= Date.now()) {
      audio.pause(); audio.removeAttribute("src"); audio.load();
      throw new Error("Offline access expired. Reconnect and open Downloads to renew it.");
    }
  };
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel("mint-access");
    channel.onmessage = (event) => {
      if (event.data?.type === "sign-out") { grant = null; try { valid(); } catch (error) { fail(error); } }
    };
  }
  async function play(at) {
    valid();
    if (!queue[at]) throw new Error("Choose a saved song.");
    index = at;
    if (url) URL.revokeObjectURL(url);
    const song = queue[index];
    url = URL.createObjectURL(song.blob); audio.src = url;
    $("title").textContent = song.item.title; $("artist").textContent = song.item.artist || "";
    $("error").textContent = "";
    if ("mediaSession" in navigator && "MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: song.item.title, artist: song.item.artist, album: song.item.album });
    }
    await audio.play();
  }
  const next = async () => {
    if (index + 1 < queue.length) await play(index + 1);
    else if (repeat && queue.length) await play(0);
    else audio.pause();
  };
  function render() {
    const query = $("search").value.trim().toLowerCase(), list = $("songs");
    list.replaceChildren();
    const shown = selectedSongs().filter((song) => `${song.item.title} ${song.item.artist} ${song.item.album}`.toLowerCase().includes(query));
    for (const [position, song] of shown.entries()) {
      const li = document.createElement("li"), button = document.createElement("button"), details = document.createElement("div");
      const title = document.createElement("strong"), subtitle = document.createElement("span");
      title.textContent = song.item.title; subtitle.textContent = `${song.item.artist || ""}${song.item.album ? ` · ${song.item.album}` : ""}`;
      details.append(title, subtitle); button.textContent = "Play"; button.setAttribute("aria-label", `Play ${song.item.title}`);
      button.onclick = () => {
        queue = shown.map((song) => ({ ...song })); originalQueue = queue.slice();
        if (shuffle) { const current = queue.splice(position, 1)[0]; for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; } queue.unshift(current); }
        void play(shuffle ? 0 : position).catch(fail);
      };
      li.append(details, button); list.append(li);
    }
  }
  async function verify() {
    if (!navigator.onLine || !grant) return;
    let response;
    try { response = await fetch("/api/player/offline", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) }); }
    catch (error) { console.warn("Offline access could not refresh; using the unexpired device grant", error); return; }
    if (response.status === 401) { await clear(); throw new Error("Listening access ended. Sign in again."); }
    if (!response.ok) throw new Error("Mint could not renew offline access. Your existing expiry still applies.");
    const fresh = await response.json();
    if (fresh.memberId !== grant.memberId) { await clear(); throw new Error("The signed-in account changed. Downloads were removed."); }
    if (!Number.isFinite(fresh.expiresAt) || typeof fresh.token !== "string") throw new Error("Mint returned an invalid offline grant.");
    grant = fresh;
    await transaction(["settings"], "readwrite", (tx) => {
      const request = tx.objectStore("settings").get("active");
      request.onsuccess = () => { if (request.result?.grant.memberId === fresh.memberId) tx.objectStore("settings").put({ ...request.result, grant: fresh }, "active"); };
    });
  }
  $("search").oninput = render;
  $("collection").onchange = render;
  $("clear").onclick = () => { if (confirm("Remove every downloaded song from this device? Server originals stay untouched.")) void clear().catch(fail); };
  $("toggle").onclick = () => { try { valid(); void (index < 0 ? play(0) : audio.paused ? audio.play() : Promise.resolve(audio.pause())).catch(fail); } catch (error) { fail(error); } };
  $("previous").onclick = () => { if (audio.currentTime > 3) audio.currentTime = 0; else void play(Math.max(0, index - 1)).catch(fail); };
  $("next").onclick = () => { void next().catch(fail); };
  $("shuffle").onclick = () => {
    shuffle = !shuffle; $("shuffle").setAttribute("aria-pressed", String(shuffle));
    if (index >= 0) {
      const current = queue[index];
      if (shuffle) {
        const rest = queue.slice(index + 1);
        for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
        queue = [...queue.slice(0, index + 1), ...rest];
      } else queue = originalQueue.slice();
      index = queue.indexOf(current);
    }
  };
  $("repeat").onclick = () => { repeat = !repeat; $("repeat").setAttribute("aria-pressed", String(repeat)); };
  $("volume").oninput = () => { audio.volume = Number($("volume").value) / 100; };
  $("seek").onchange = () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number($("seek").value) / 1000 * audio.duration; };
  audio.onplaying = () => { $("toggle").textContent = "Pause"; if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; };
  audio.onpause = () => { $("toggle").textContent = "Play"; if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; };
  audio.ontimeupdate = () => {
    try { valid(); } catch (error) { fail(error); }
    $("seek").value = Number.isFinite(audio.duration) && audio.duration ? String(Math.round(audio.currentTime / audio.duration * 1000)) : "0";
    $("time").textContent = time(audio.currentTime);
  };
  audio.onended = () => { void next().catch(fail); };
  audio.onerror = () => fail(new Error("This downloaded format cannot play in this browser. Reconnect and try a compatible version."));
  if ("mediaSession" in navigator) {
    for (const [action, handler] of Object.entries({
      play: () => { try { valid(); void audio.play().catch(fail); } catch (error) { fail(error); } },
      pause: () => audio.pause(), nexttrack: () => { void next().catch(fail); },
      previoustrack: () => { void play(Math.max(0, index - 1)).catch(fail); },
      seekto: (details) => { if (details.seekTime !== undefined) audio.currentTime = details.seekTime; },
    })) try { navigator.mediaSession.setActionHandler(action, handler); } catch (error) { console.warn("Media action unavailable", action, error); }
  }
  void (async () => {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("mint-offline-v1", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("songs")) request.result.createObjectStore("songs", { keyPath: "id" });
        if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
        if (!request.result.objectStoreNames.contains("collections")) request.result.createObjectStore("collections", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const settings = await read("settings", "active");
    grant = settings?.grant;
    if (!grant) { $("status").textContent = "No account has enabled downloads. Connect to Mint and save some music first."; return; }
    await verify();
    valid();
    songs = (await read("songs")).filter((song) => song.memberId === grant.memberId); queue = songs.slice(); originalQueue = queue.slice();
    collections = (await read("collections")).filter((collection) => collection.memberId === grant.memberId);
    for (const collection of collections) {
      const option = document.createElement("option"); option.value = collection.id; option.textContent = collection.title; $("collection").append(option);
    }
    $("status").textContent = `${songs.length} songs saved · access valid until ${new Date(grant.expiresAt).toLocaleString()}`;
    $("player").hidden = !songs.length; render();
    window.addEventListener("online", () => { void verify().catch(fail); });
    setInterval(() => { try { valid(); } catch (error) { fail(error); } void verify().catch(fail); }, 30000);
  })().catch(fail);
})();
