import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chooseRequestMatch, choiceFromDecision, decisionChoices, identityFromVideo, matchMissingRequest, requestMatchMessage, videoMatchesRequest,
  type CatalogRecording, type CatalogVideo } from "../src/lib/request-match";

const recording: CatalogRecording = { id: "11111111-1111-4111-8111-111111111111", title: "First Light", artist: "Mint Fixture", album: "Example Sessions", durationSec: 181 };
const audio: CatalogVideo = { id: "audio000001", title: "Mint Fixture - First Light (Official Audio)", channel: "Mint Fixture", durationSec: 176, rank: 9 };
const vevo: CatalogVideo = { ...audio, id: "vevo0000001", title: "Mint Fixture - First Light (Audio)", channel: "MintFixtureVEVO", rank: 0 };
const topic: CatalogVideo = { ...audio, id: "topic000001", title: "First Light", channel: "Mint Fixture - Topic", rank: 1 };
const lyric: CatalogVideo = { ...audio, id: "lyric000001", title: "Mint Fixture - First Light (Official Lyric Video)", channel: "Fictional Lyric Channel", durationSec: 181, viewCount: 500, rank: 0 };
const video: CatalogVideo = { ...vevo, id: "video000001", title: "Mint Fixture - First Light (Official Music Video)", durationSec: 242 };
const query = "Mint Fixture First Light";

function chosenId(videos: CatalogVideo[]) {
  const choice = chooseRequestMatch(query, [recording], videos);
  return choice?.kind === "recording" ? choice.videoId : choice?.kind === "video" ? choice.video.id : null;
}

test("web uses the worker's priority and accepts 181/176 only with studio audio evidence", () => {
  assert.equal(chosenId([video, lyric, topic, vevo, audio]), audio.id);
  assert.equal(chosenId([video, lyric, topic, vevo]), vevo.id);
  assert.equal(chosenId([video, lyric, topic]), topic.id);
  assert.equal(chosenId([video, lyric]), lyric.id);
  assert.equal(videoMatchesRequest(recording, audio), true);
  assert.equal(videoMatchesRequest(recording, { ...audio, title: "Mint Fixture - First Light Official Audio" }), true);
  assert.equal(videoMatchesRequest(recording, { ...audio, durationSec: 173 }), false);
  assert.equal(chosenId([{ ...audio, durationSec: 173 }]), null, "must not bypass known recording duration via video-only fallback");
});

test("web accepts typographic artist/title separators in automatic and pinned audio, not other recordings", () => {
  for (const separator of ["\u2013", "\u2014"]) {
    const candidate = { ...audio, title: `Mint Fixture ${separator} First Light (Official Audio)` };
    assert.equal(chosenId([candidate]), audio.id);
    assert.equal(videoMatchesRequest(recording, candidate, true), true);
    assert.equal(videoMatchesRequest(recording, { ...candidate, title: `Other Artist ${separator} First Light (Official Audio)` }, true), false);
    assert.equal(videoMatchesRequest(recording, { ...candidate, title: `Mint Fixture ${separator} Other Song (Official Audio)` }, true), false);
    assert.equal(chosenId([{ ...candidate, title: `${candidate.title} (Live)` }]), null);
    assert.equal(chosenId([{ ...candidate, title: `Mint Fixture ${separator} First Light (Official Music Video)`, durationSec: 181 }]), null);
  }
});

test("music videos, bare VEVO uploads, previews and alternate versions never win, including pins", () => {
  for (const item of [video, { ...video, durationSec: 181 }, { ...vevo, title: "Mint Fixture - First Light" },
    { ...audio, title: `${audio.title} (Preview)` }, { ...audio, title: `${audio.title} (Remix)` },
    { ...audio, title: `${audio.title} (Cover)` }, { ...audio, title: `${audio.title} (Live)` },
    { ...audio, title: `${audio.title} (Visualizer)` }, { ...audio, title: `${audio.title} (Sped Up)` },
    { ...audio, title: `${audio.title} (Intro)` }]) {
    assert.equal(videoMatchesRequest(recording, item), false);
    assert.equal(chosenId([item]), null);
    assert.equal(choiceFromDecision(`rec:${recording.id}|vid:${item.id}`, [recording], [item]), null);
    assert.equal(choiceFromDecision(`vid:${item.id}`, [], [item]), null);
  }
});

test("lyric fallback uses validated views, not provider relevance; ties remain ambiguous", () => {
  const most = { ...lyric, id: "views000001", viewCount: 9999, rank: 9 };
  assert.equal(chosenId([lyric, most]), most.id);
  assert.equal(chosenId([{ ...lyric, title: "Mint Fixture - First Light Lyrics" }]), lyric.id);
  assert.equal(chosenId([{ ...lyric, title: "Mint Fixture - First Light (Official Lyrics Video)" }]), lyric.id);
  assert.equal(chosenId([{ ...lyric, viewCount: undefined }]), null);
  assert.equal(chosenId([{ ...lyric, viewCount: -1 }]), null);
  assert.equal(chosenId([{ ...lyric, durationSec: 176 }]), null);
  assert.equal(chosenId([lyric, { ...lyric, id: "tie00000001" }]), null);
  assert.equal(chosenId([audio, { ...audio, id: "tie00000001", rank: 0 }]), null);
});

test("artist, collaboration, missing metadata and catalog recording ambiguity remain guarded", () => {
  // Another channel's official-audio upload needs the recording length to agree.
  assert.equal(videoMatchesRequest({ ...recording, durationSec: null }, { ...audio, channel: "Other Artist" }), false);
  assert.equal(videoMatchesRequest(recording, { ...audio, channel: "Other Artist", durationSec: 173 }), false);
  assert.equal(videoMatchesRequest(recording, { ...audio, title: "Other Artist - First Light (Official Audio)" }), false);
  assert.equal(videoMatchesRequest(recording, { ...audio, durationSec: null }), false);
  assert.equal(videoMatchesRequest({ ...recording, durationSec: null }, audio), true);
  assert.equal(videoMatchesRequest({ ...recording, artist: "Mint Fixture / Amber Example" }, topic), true);
  assert.equal(videoMatchesRequest({ ...recording, artist: "Mint Fixture & Amber Example" }, { ...topic, channel: "Amber Example - Topic" }), false);
  assert.equal(chooseRequestMatch(query, [recording, { ...recording, id: "22222222-2222-4222-8222-222222222222" }], [audio]), null);
  assert.equal(chooseRequestMatch(query, [recording, { ...recording, id: "22222222-2222-4222-8222-222222222222" }], null), null);
  const choice = chooseRequestMatch(query, [recording], null);
  assert.ok(choice?.kind === "recording" && choice.videoId === null);
  assert.equal(chooseRequestMatch("First Light", [recording], null), null);
  assert.equal(chooseRequestMatch(`${query} Unrelated`, [recording], [audio]), null);
  assert.equal(chooseRequestMatch("Mint Fixture & Amber Example First Light", [
    { ...recording, artist: "Mint Fixture & Wrong Guest" },
  ], null), null);
  assert.equal(chooseRequestMatch(`${query} (Live)`, [recording], null), null);
  assert.equal(chooseRequestMatch(`${query} (Remix)`, [recording], [audio]), null);
  assert.equal(chooseRequestMatch("Mint Fixture & Amber Example First Light (Live)", [], [topic]), null);
  assert.equal(chooseRequestMatch("Mint Fixture & Amber Example First Light", [], [
    { ...lyric, title: "Mint Fixture & Wrong Guest - First Light (Lyrics)" },
  ]), null);
  assert.equal(chooseRequestMatch("Mint Fixture & Amber Example First Light", [], [
    { ...lyric, title: "Mint Fixture - First Light (feat. Wrong Guest) (Lyrics)" },
  ]), null);
});

test("unknown catalog duration and explicit pins use the same bounded source policy", () => {
  const unknown = { ...recording, durationSec: null };
  for (const candidate of [audio, vevo]) {
    assert.equal(videoMatchesRequest(unknown, candidate), true);
    assert.ok(chooseRequestMatch(query, [unknown], [candidate]));
  }
  assert.equal(chooseRequestMatch(query, [unknown], [topic]), null);
  assert.equal(chooseRequestMatch(query, [unknown], [lyric]), null);
  assert.equal(chooseRequestMatch(query, [], [lyric]), null);
  const label = { ...audio, channel: "Fictional Label" };
  assert.equal(videoMatchesRequest({ ...recording, durationSec: null }, label), false);
  assert.equal(videoMatchesRequest(recording, label, true), true);
  assert.ok(chooseRequestMatch(query, [recording], [label], null, true));
  assert.equal(chooseRequestMatch("Mint Fixture Other Song", [], [label], 181, true), null);
  assert.equal(chooseRequestMatch(query, [recording], [{ ...label, title: "Mint Fixture - Other Song (Official Audio)" }], null, true), null);
  assert.equal(videoMatchesRequest(recording, { ...audio, title: "Mint Fixture - First Light [Audio]" }), true);
  assert.equal(videoMatchesRequest({ ...recording, title: "Lyrics to Go" }, { ...topic, title: "Lyrics to Go" }), true);
});

test("web matches complete multi-artist credits without accepting an unrequested guest", () => {
  const duet = { ...recording, artist: "Mint Fixture and Amber Example" };
  const candidate = { ...vevo, title: "Mint Fixture, Amber Example - First Light (Audio)" };
  assert.equal(videoMatchesRequest(duet, candidate), true);
  assert.ok(chooseRequestMatch("Mint Fixture and Amber Example First Light", [duet], [candidate]));
  assert.equal(videoMatchesRequest(duet, { ...candidate, title: "Mint Fixture, Wrong Guest - First Light (Audio)" }), false);
  assert.equal(videoMatchesRequest(recording, candidate), false);
});

test("web searches lazily stop after official/VEVO, Topic, or lyric rounds and deduplicate details", () => {
  execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { getDb, closeDb } from "@mint/core/db";
    import { encrypt } from "@mint/core/crypto";
    import { searchLinkedYouTube } from "./src/lib/youtube-search.ts";
    import { requestAudioCandidates } from "./src/lib/request-match.ts";
    process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    const db = getDb();
    globalThis.__mintRedis = {eval:async()=>0};
    db.query.youtubeAccounts.findFirst = async () => ({ expiresAt: new Date(Date.now()+3600000), accessTokenEnc: encrypt("fixture") });
    const recording = ${JSON.stringify(recording)};
    const source = ${JSON.stringify(audio)}, topic = ${JSON.stringify(topic)}, lyric = ${JSON.stringify(lyric)}, video = ${JSON.stringify(video)};
    for (const [pool, expected, length, rounds] of [
      [[source], 1, 181, null], [[{...source, title: "Mint Fixture - First Light (Audio)", channel: "MintFixtureVEVO"}], 1, 181, null],
      [[topic], 2, 181, null], [[topic], 5, null, null], [[lyric], 3, 181, null], [[video], 5, 181, null], [[], 5, 181, null],
      [[video, topic, lyric], 2, 181, [[video],[video,topic],[lyric]]]
    ]) {
      let searches = 0, details = 0;
      const seen = new Set();
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://www.googleapis.com");
        if (url.pathname.endsWith("/search")) {
          searches++;
          return Response.json({ items: (rounds?.[searches-1] ?? pool).map(v => ({id:{videoId:v.id}})) });
        }
        details++;
        const ids = url.searchParams.get("id").split(",");
        for (const id of ids) { assert.ok(!seen.has(id)); seen.add(id); }
        return Response.json({ items: pool.filter(v => ids.includes(v.id)).map(v => ({
          id:v.id, snippet:{title:v.title,channelTitle:v.channel}, contentDetails:{duration:"PT"+v.durationSec+"S"},
          statistics:{viewCount:String(v.viewCount ?? 100)}
        })) });
      };
      await searchLinkedYouTube("member", ${JSON.stringify(query)}, candidates =>
        requestAudioCandidates(${JSON.stringify(query)}, [{...recording,durationSec:length}], candidates));
      assert.equal(searches, expected);
      assert.equal(details, rounds ? 2 : pool.length ? 1 : 0, "details are fetched only for newly seen IDs");
    }
    for (const failAtDetails of [false,true])for (const failure of ["quota", "throttle", "server", "network", "malformed","invalid-json","auth"]) {
      for (const includeEligible of [true,false]) {
        let searches=0,paused=0;
        globalThis.__mintRedis={eval:async()=>0,setex:async()=>{paused++;}};
        globalThis.fetch=async input=>{
          const url=new URL(input);
          if (url.pathname.endsWith("/search")) {
            searches++;
            if(searches===1 && includeEligible)return Response.json({items:[{id:{videoId:lyric.id}}]});
            if(failAtDetails)return Response.json({items:[{id:{videoId:"new00000001"}}]});
          }
          if(url.pathname.endsWith("/search") || searches>1 || !includeEligible){
            if(failure==="network")throw new Error("offline");
            if(failure==="malformed")return Response.json({bad:"shape"});
            if(failure==="invalid-json")return new Response("{invalid-json");
            return new Response(failure==="auth"?"permission refused":"quotaExceeded",
              {status:failure==="auth"?401:failure==="quota"?403:failure==="throttle"?429:503});
          }
          return Response.json({items:[{id:lyric.id,snippet:{title:lyric.title,channelTitle:lyric.channel},
            contentDetails:{duration:"PT181S"},statistics:{viewCount:"500"}}]});
        };
        const run=()=>searchLinkedYouTube("member",${JSON.stringify(query)},candidates=>
          requestAudioCandidates(${JSON.stringify(query)},[recording],candidates));
        if(failure==="auth")await assert.rejects(run(),error=>error.status===401,"revoked access cannot reuse earlier results");
        else if(includeEligible) {
          const found=await run();
          assert.equal(found[0].id,lyric.id,"eligible earlier lyric survives later provider failure");
          assert.equal(searches,2);
        } else await assert.rejects(run(),error=>error.status===503,"no earlier source means retryable provider failure");
        if(["quota","throttle"].includes(failure))assert.equal(paused,1);
      }
    }
    let calls=0, cooldown=300;
    globalThis.__mintRedis={eval:async()=>cooldown,setex:async(_key,seconds)=>{cooldown=seconds;}};
    globalThis.fetch=async()=>{calls++;return new Response("quotaExceeded",{status:429});};
    const search=()=>searchLinkedYouTube("member",${JSON.stringify(query)},candidates=>
      requestAudioCandidates(${JSON.stringify(query)},[recording],candidates));
    await assert.rejects(search(),/quota|budget/);
    assert.equal(calls,0,"a cooldown polls Redis without contacting Google");
    cooldown=0;
    await assert.rejects(search(),/busy/);
    assert.equal(calls,1);
    assert.equal(cooldown,300);
    await assert.rejects(search(),/quota|budget/);
    assert.equal(calls,1,"quota rejection prevents subsequent provider calls");
    await closeDb();
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("authorized web metadata matching checks active membership without Google credentials or quota", () => {
  execFileSync(process.execPath, ["--conditions=react-server", "--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    import * as scraper from "@mint/core/youtube-scrape";
    process.env.YOUTUBE_SCRAPE_AUTHORIZED="true";
    let active=true, denied=false, searches=0, reads=0, providerCalls=0, accountReads=0, searchSignal, videoSignal;
    const source=${JSON.stringify(audio)};
    const db={query:{
      users:{findFirst:async()=>({status:active?"active":"disabled"})},
      youtubeAccounts:{findFirst:async()=>{accountReads++;throw new Error("OAuth must not be used");}}
    }};
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module("@mint/core/youtube-scrape",{namedExports:{...scraper,
      searchYoutubeScraped:async(_query,options)=>{
        searches++;searchSignal=options.signal;if(denied)throw new scraper.YoutubeScrapeAccessError();
        assert.equal(options.eligible([source])[0].id,source.id);return [source];
      },
      readYoutubeScrapeVideo:async(_id,options)=>{
        reads++;videoSignal=options.signal;
        if(options.signal?.aborted)throw options.signal.reason;
        if(denied)throw new scraper.YoutubeScrapeAccessError();return source;
      }
    }});
    globalThis.fetch=async()=>{providerCalls++;throw new Error("Unexpected Google, OAuth or media request");};
    const {searchLinkedYouTube,linkedYouTubeVideo}=await import("./src/lib/youtube-search.ts");
    const find=(signal)=>searchLinkedYouTube("member","Mint Fixture First Light",videos=>videos,signal);
    const deadline=new AbortController();
    assert.equal((await find(deadline.signal))[0].id,source.id);
    assert.equal((await linkedYouTubeVideo("member",source.id,deadline.signal)).id,source.id);
    assert.equal(searchSignal,deadline.signal);assert.equal(videoSignal,deadline.signal);
    deadline.abort();
    await assert.rejects(linkedYouTubeVideo("member",source.id,deadline.signal),error=>error.status===503 && /took too long/.test(error.message));
    active=false;
    await assert.rejects(find(),error=>error.status===403);
    await assert.rejects(linkedYouTubeVideo("member",source.id),error=>error.status===403);
    active=true;denied=true;
    await assert.rejects(find(),error=>error.status===503 && /refused/.test(error.message));
    await assert.rejects(linkedYouTubeVideo("member",source.id),error=>error.status===503 && /refused/.test(error.message));
    assert.equal(searches,2);assert.equal(reads,3);
    assert.equal(accountReads,0);assert.equal(providerCalls,0);
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("web requests verify automatic scraped choices and try another eligible source, but never replace a pin", () => {
  execFileSync(process.execPath, ["--conditions=react-server", "--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    process.env.YOUTUBE_SCRAPE_AUTHORIZED="true";
    const first={...${JSON.stringify(audio)},viewCount:200};
    const second={...first,id:"audio000002",viewCount:100,rank:1};
    const checked=[],inserted=[];
    let alreadyVerified=false,changedMetadata=false;
    const tx={execute:async()=>{},
      select:()=>({from:()=>({where:()=>({limit:()=>({for:async()=>[]}),orderBy:()=>({limit:()=>({for:async()=>[]})})})})}),
      insert:()=>({values:values=>({
        returning:async()=>{inserted.push(values);return [{...values,id:"fixture",stage:"queued"}];},
        onConflictDoNothing:async()=>{}
      })})};
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>({transaction:async fn=>fn(tx)})}});
    mock.module("@mint/core/matching-db",{namedExports:{getMatchingDecision:async()=>({enabled:false,apiKey:null})}});
    mock.module(new URL("./src/lib/music-requests.ts",import.meta.url),{namedExports:{youtubeSource:source=>source?first.id:null}});
    mock.module(new URL("./src/lib/youtube-search.ts",import.meta.url),{namedExports:{
      searchLinkedYouTube:async()=>changedMetadata?[first]:alreadyVerified?[{...second,watchVerified:true}]:[first,second],
      linkedYouTubeVideo:async(_user,id)=>{
        checked.push(id);if(changedMetadata)return {...first,durationSec:180};
        return id===first.id?null:second;
      }
    }});
    globalThis.fetch=async()=>{throw new Error("No live provider access permitted");};
    const fetcher=async()=>Response.json({recordings:changedMetadata?[{
      id:"11111111-1111-4111-8111-111111111111",title:"First Light",length:181000,
      "artist-credit":[{name:"Mint Fixture"}]
    }]:[]});
    const {resolveAndRequest}=await import("./src/lib/resolve-request.ts");
    assert.equal((await resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher)).trackId,"fixture");
    assert.deepEqual(checked,[first.id,second.id]);
    assert.equal(inserted[0].youtubeVideoId,second.id);
    checked.length=0;
    alreadyVerified=true;
    assert.equal((await resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher)).trackId,"fixture");
    assert.deepEqual(checked,[],"a completed watch check is reused even if a later search round was rate limited");
    assert.equal(inserted[1].youtubeVideoId,second.id);
    await assert.rejects(resolveAndRequest("member",${JSON.stringify(query)},"https://youtu.be/audio000001",fetcher),/Pinned source metadata is unavailable/);
    assert.deepEqual(checked,[first.id],"an explicit pin never falls back to another source");
    assert.equal(inserted.length,2);
    changedMetadata=true;
    await assert.rejects(resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher,{
      accept:choice=>choice.kind==="video"&&choice.video.durationSec===181
    }),error=>error.status===409);
    assert.equal(inserted.length,2,"chart-style fallback uses the verified watch duration, not stale search metadata");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("web diagnostics distinguish no candidates, unsafe versions, identity, duration and missing metadata", () => {
  assert.match(requestMatchMessage(query, [recording], []), /no source candidates/);
  assert.match(requestMatchMessage(query, [recording], [video]), /music videos are not allowed/);
  assert.match(requestMatchMessage(query, [recording], [{ ...audio, title: `${audio.title} (Live)` }]), /different versions/);
  assert.match(requestMatchMessage(query, [recording], [{ ...audio, title: "Wrong Artist - Other Song" }]), /identity mismatch/);
  assert.match(requestMatchMessage(query, [recording], [{ ...audio, durationSec: 242 }]), /duration mismatch/);
  assert.match(requestMatchMessage(query, [recording], [{ ...audio, durationSec: null }]), /missing length evidence/);
  assert.match(requestMatchMessage(query, [], [{ ...audio, durationSec: null }]), /missing length evidence/);
});

test("web request orchestration survives catalog outage only with independent safe audio evidence", () => {
  execFileSync(process.execPath, ["--conditions=react-server", "--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    let source=${JSON.stringify(audio)},writes=0,catalog="down";
    const tx={execute:async()=>{},
      select:()=>({from:()=>({where:()=>({limit:()=>({for:async()=>[]}),orderBy:()=>({limit:()=>({for:async()=>[]})})})})}),
      insert:()=>({values:values=>({
        returning:async()=>{writes++;return [{...values,id:"fixture",stage:"queued"}];},
        onConflictDoNothing:async()=>{}
      })})};
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>({transaction:async fn=>fn(tx)})}});
    mock.module("@mint/core/matching-db",{namedExports:{getMatchingDecision:async()=>({enabled:false,apiKey:null})}});
    mock.module(new URL("./src/lib/music-requests.ts",import.meta.url),{namedExports:{youtubeSource:()=>null}});
    mock.module(new URL("./src/lib/youtube-search.ts",import.meta.url),{namedExports:{
      searchLinkedYouTube:async()=>[source],linkedYouTubeVideo:async()=>source
    }});
    globalThis.fetch=async()=>{throw new Error("No live provider access permitted");};
    const {resolveAndRequest}=await import("./src/lib/resolve-request.ts");
    let lookups=0;
    const fetcher=async()=>{
      lookups++;
      if(catalog==="late"&&lookups===1)return Response.json({recordings:[]});
      if(catalog==="down"||catalog==="late")return new Response("unavailable",{status:503});
      if(catalog==="malformed")return Response.json({invalid:true});
      return Response.json({recordings:[{
        id:"11111111-1111-4111-8111-111111111111",title:"First Light",length:181000,video:true,
        "artist-credit":[{name:"Mint Fixture"}]
      }]});
    };
    assert.equal((await resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher)).trackId,"fixture");
    assert.equal(writes,1,"independent official audio can progress without catalog service");
    source=${JSON.stringify(lyric)};
    await assert.rejects(resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher),
      error=>error.status===503,"catalog outage plus insufficient evidence is retryable, not no-source");
    assert.equal(writes,1);
    for(catalog of ["late","malformed"]){
      lookups=0;
      await assert.rejects(resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher),
        error=>error.status===503,"invalid or failed enrichment is unavailable metadata, not absence");
      assert.equal(writes,1);
    }
    catalog="video-only";
    await assert.rejects(resolveAndRequest("member",${JSON.stringify(query)},undefined,fetcher),
      /missing length evidence/,"video:true catalog length cannot authorize a lyric source");
    assert.equal(writes,1,"unconfirmed sources never queue success-shaped requests");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("remote claims enforce the same unknown-duration and stored-pin audio policy", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    import * as core from "@mint/core";
    import * as redis from "@mint/core/redis";
    const patches=[];
    let expected=null, candidate=${JSON.stringify(audio)}, accountJoins=0;
    process.env.YOUTUBE_SCRAPE_AUTHORIZED="true";
    const chain={from(){return this},innerJoin(table){if(table===database.schema.youtubeAccounts)accountJoins++;return this;},
      where(){return this},limit:async()=>[{userId:"member"}]};
    const db={$count:async()=>0,execute:async()=>({rows:[{id:"track"}]}),select:()=>chain,
      query:{tracks:{findFirst:async()=>({id:"track",title:"First Light",artist:"Mint Fixture",durationSec:expected,youtubeVideoId:candidate.id})}},
      update:()=>({set:patch=>({where:async()=>{patches.push(patch);}})})};
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module("@mint/core",{namedExports:{...core,publish:async()=>{},toTrackView:track=>track}});
    mock.module("@mint/core/redis",{namedExports:{...redis,getRedis:()=>({})}});
    mock.module("@mint/core/crypto",{namedExports:{randomToken:()=>"fixture",signToken:()=>"fixture"}});
    mock.module("next/server",{namedExports:{NextResponse:class extends Response{}}});
    mock.module(new URL("./src/lib/agent.ts",import.meta.url),{namedExports:{
      MAX_WORKER_CONCURRENCY:1,authenticateAgent:async()=>({worker:{id:"worker",status:"active"}}),
      limitWorker:async()=>null,hubUrl:()=>"https://hub.fixture",
      agentError:(status,message)=>Response.json({error:message},{status})
    }});
    mock.module(new URL("./src/lib/youtube-search.ts",import.meta.url),{namedExports:{linkedYouTubeVideo:async()=>candidate}});
    const {POST}=await import("./src/app/api/agent/v1/claim/route.ts");
    const run=()=>POST(new Request("https://mint.fixture/api/agent/v1/claim",{method:"POST"}));
    for (const source of [${JSON.stringify(audio)},${JSON.stringify(vevo)}]) {
      expected=null;candidate=source;
      assert.equal((await run()).status,200);
    }
    candidate={...${JSON.stringify(audio)},channel:"Fictional Label"};expected=181;
    assert.equal((await run()).status,200,"stored label-channel audio pins retain the explicit-pin exception");
    candidate=${JSON.stringify(lyric)};expected=181;
    assert.equal((await run()).status,200,"a persisted supporting official length survives remote lyric validation");
    for(const [source,duration] of [
      [{...${JSON.stringify(audio)},channel:"Fictional Label"},null],
      [${JSON.stringify(topic)},null],[${JSON.stringify(lyric)},null],[${JSON.stringify(video)},181],
      [{...${JSON.stringify(audio)},title:"Other Artist - Other Song (Official Audio)"},181]
    ]) {
      candidate=source;expected=duration;
      assert.equal((await run()).status,204);
      assert.equal(patches.at(-1).stage,"failed");
    }
    assert.equal(accountJoins,0,"authorized public metadata only requires an approved owner");
    process.env.YOUTUBE_SCRAPE_AUTHORIZED="false";
    candidate=${JSON.stringify(audio)};expected=181;
    assert.equal((await run()).status,200);
    assert.equal(accountJoins,1,"legacy Data API mode still requires a linked owner");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("video-only identification requires query identity and rejects music-video fallback", () => {
  const choice = chooseRequestMatch(query, [], [video, audio]);
  assert.ok(choice?.kind === "video" && choice.video.id === audio.id);
  assert.equal(chooseRequestMatch(query, [], [video]), null);
  assert.equal(chooseRequestMatch("Mint Fixture Other Song", [], [audio]), null);
  assert.equal(chooseRequestMatch("Mint Fixture First Light Unrelated", [], [audio]), null);
  assert.equal(chooseRequestMatch(query, [], [audio], 200), null);
  assert.deepEqual(identityFromVideo(audio), { artist: "Mint Fixture", title: "First Light" });
  assert.deepEqual(identityFromVideo({ ...audio, title: "First Light (Official Audio)", channel: "MintFixtureVEVO" }), { artist: "MintFixture", title: "First Light" });
});

test("AI choices are filtered before and after the model, including invented or lower-tier IDs", async () => {
  const pool = [video, lyric, topic, vevo, audio];
  const safeValue = `rec:${recording.id}|vid:${audio.id}`;
  assert.deepEqual(decisionChoices(query, [recording], pool).map((choice) => choice.value), [safeValue, "none"]);
  const run = (choice: string, confidence = 0.9, probability = 0.85) => matchMissingRequest({
    query, recordings: [recording], videos: pool, model: { enabled: true, apiKey: "fixture-not-a-key" },
    fetcher: async (_url, init) => {
      const offered = JSON.parse(String(init?.body)).questions[0].choices.map((item: { value: string }) => item.value);
      assert.deepEqual(offered, [safeValue, "none"]);
      return Response.json({ answers: [{ name: "recording", choice, confidence,
        probabilities: [{ value: choice, probability }, { value: choice === "none" ? safeValue : "none", probability: 0.1 }] }] });
    },
  });
  for (const unsafe of [`vid:${video.id}`, `vid:${lyric.id}`, `vid:${topic.id}`, "vid:invented001"]) {
    const result = await run(unsafe);
    assert.ok(result?.kind === "recording" && result.videoId === audio.id);
  }
  assert.equal((await run(safeValue))?.kind, "recording");
  assert.equal(await run("none"), null);
  assert.equal(await run(safeValue, 0.4), null);
  const unavailable = await matchMissingRequest({ query, recordings: [recording], videos: pool, model: { enabled: true, apiKey: "fixture" },
    fetcher: async () => { throw new Error("offline"); } });
  assert.equal(unavailable?.kind, "recording");
});
