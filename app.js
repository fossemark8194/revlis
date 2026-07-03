"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min = 0, max = 1) => Math.min(Math.max(value, min), max);
const smoothstep = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const escapeXML = value => String(value).replace(/[<>&"']/g, char => ({"<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&apos;"}[char]));
const escapeHTML = value => String(value).replace(/[<>&"']/g, char => ({"<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&#39;"}[char]));
const formatTime = value => `${Math.floor((value || 0) / 60)}:${Math.floor(value || 0) % 60 < 10 ? "0" : ""}${Math.floor(value || 0) % 60}`;

const state = {
  route: "home",
  verify: { audioURL: "", document: null, coverURL: "", previewAudio: null, selectedCue: 0, showsPreview: true },
  editor: { audioURL: "", lines: [], cues: [], mode: "line", index: 0, holding: false, previewAudio: null, selectedEdit: 0, showsPreview: true },
  visualizer: { audioURL: "", document: null, cover: null, palette: ["#11244b", "#5d274b", "#0c5a60"], exporting: false, recorder: null }
};

const routes = { home: "", verify: "Проверка", editor: "Редактор", automatic: "Автоматическая синхронизация · Бета", visualizer: "Track Visualizer · Бета" };

function navigate(route) {
  document.querySelectorAll("audio").forEach(audio => audio.pause());
  state.route = route;
  $$(".screen").forEach(screen => screen.classList.remove("active"));
  $(`#${route}Screen`).classList.add("active");
  $(".app-header").hidden = route === "home";
  $("#sectionLabel").textContent = routes[route];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$('[data-route]').forEach(button => button.addEventListener("click", () => navigate(button.dataset.route)));
$("#homeButton").addEventListener("click", () => navigate("home"));

function parseTime(value) {
  if (!value) return null;
  const clean = value.trim().replace(/s$/, "");
  const parts = clean.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseTTML(source) {
  const xml = new DOMParser().parseFromString(source, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Некорректный XML");
  const nodes = [...xml.getElementsByTagNameNS("*", "p")];
  const lines = [];
  const cues = [];
  let wordMode = false;
  nodes.forEach((paragraph, lineIndex) => {
    const spans = [...paragraph.getElementsByTagNameNS("*", "span")].filter(span => span.hasAttribute("begin") && span.hasAttribute("end"));
    if (spans.length) {
      wordMode = true;
      const words = spans.map(span => span.textContent.trim()).filter(Boolean);
      lines.push(words.join(" "));
      spans.forEach((span, wordIndex) => cues.push({ lineIndex, wordIndex, text: span.textContent.trim(), begin: parseTime(span.getAttribute("begin")), end: parseTime(span.getAttribute("end")) }));
    } else {
      const text = paragraph.textContent.replace(/\s+/g, " ").trim();
      if (!text) return;
      const actualIndex = lines.length;
      lines.push(text);
      cues.push({ lineIndex: actualIndex, wordIndex: null, text, begin: parseTime(paragraph.getAttribute("begin")), end: parseTime(paragraph.getAttribute("end")) });
    }
  });
  if (!lines.length || !cues.some(cue => cue.begin != null && cue.end != null)) throw new Error("В TTML нет корректных таймингов");
  const title = xml.getElementsByTagNameNS("*", "title")[0]?.textContent.trim() || "Без названия";
  const artist = xml.getElementsByTagNameNS("*", "name")[0]?.textContent.trim() || "";
  return { title, artist, language: xml.documentElement.getAttribute("xml:lang") || "ru", mode: wordMode ? "word" : "line", lines, cues };
}

function lineBounds(document) {
  if (!document) return [];
  return document.lines.map((_, lineIndex) => {
    const cues = document.cues.filter(cue => cue.lineIndex === lineIndex && cue.begin != null && cue.end != null);
    return cues.length ? { lineIndex, begin: Math.min(...cues.map(cue => cue.begin)), end: Math.max(...cues.map(cue => cue.end)) } : null;
  }).filter(Boolean).sort((a, b) => a.begin - b.begin);
}

function instrumentalBreak(document, time) {
  const bounds = lineBounds(document);
  if (!bounds.length) return null;
  if (bounds[0].begin >= 10 && time < bounds[0].begin) return { start: 0, end: bounds[0].begin, visualPosition: -1, nextLine: bounds[0].lineIndex };
  for (let index = 1; index < bounds.length; index++) {
    const previous = bounds[index - 1], next = bounds[index];
    if (next.begin - previous.end >= 10 && time >= previous.end && time < next.begin) {
      return { start: previous.end, end: next.begin, visualPosition: (previous.lineIndex + next.lineIndex) / 2, previousLine: previous.lineIndex, nextLine: next.lineIndex };
    }
  }
  return null;
}

function visualFocus(document, time) {
  const bounds = lineBounds(document);
  if (!bounds.length) return 0;
  const pause = instrumentalBreak(document, time);
  if (pause) {
    if (pause.previousLine != null && time < pause.start + .68) return pause.previousLine + (pause.visualPosition - pause.previousLine) * smoothstep((time - pause.start) / .68);
    if (time > pause.end - .72) return pause.visualPosition + (pause.nextLine - pause.visualPosition) * smoothstep((time - (pause.end - .72)) / .72);
    return pause.visualPosition;
  }
  if (time < bounds[0].begin) return bounds[0].lineIndex;
  for (let index = 1; index < bounds.length; index++) {
    const previous = bounds[index - 1], next = bounds[index];
    if (time < next.begin) {
      const duration = Math.min(.68, Math.max(next.begin - previous.end, .42));
      if (time < next.begin - duration) return previous.lineIndex;
      return previous.lineIndex + (next.lineIndex - previous.lineIndex) * smoothstep((time - (next.begin - duration)) / duration);
    }
  }
  return bounds.at(-1).lineIndex;
}

function lineEmphasis(document, lineIndex, time) {
  const bound = lineBounds(document).find(item => item.lineIndex === lineIndex);
  if (!bound) return 0;
  if (time < bound.begin) return smoothstep((time - (bound.begin - .16)) / .16);
  if (time <= bound.end) return 1;
  return 1 - smoothstep((time - bound.end) / .62);
}

function cueProgress(cue, time) {
  if (cue.begin == null || cue.end == null || cue.end <= cue.begin) return 0;
  const early = cue.begin - Math.min(.035, (cue.end - cue.begin) * .22);
  return clamp((time - early) / (cue.end - early));
}

function wordLayer(text, className) {
  return `<span class="word-layer ${className}">${[...text].map((character, index) => `<i data-letter="${index}">${escapeHTML(character)}</i>`).join("")}</span>`;
}

function playerMarkup(audioURL) {
  return `<div class="preview-player"><button class="preview-toggle" aria-label="Воспроизвести">▶</button><div class="preview-timeline"><input class="preview-seek" type="range" min="0" max="1" step="0.001" value="0"><div class="time-row"><time class="preview-time">0:00</time><time class="preview-duration">0:00</time></div></div><audio src="${escapeHTML(audioURL || "")}"></audio></div>`;
}

function createPreview(container, lyricsDocument, audioURL, coverURL = "") {
  if (!lyricsDocument) { container.innerHTML = '<div class="empty-state"><p>Добавьте TTML</p></div>'; return; }
  container.innerHTML = `
    <div class="apple-preview" style="--preview-image:url('${coverURL || "assets/revlis-1024.png"}')">
      <div class="preview-background"></div><div class="preview-dim"></div>
      <div class="preview-content">
        <div class="track-chip"><img src="${coverURL || "assets/revlis-1024.png"}" alt=""><div><strong>${escapeHTML(lyricsDocument.title)}</strong><span>${escapeHTML(lyricsDocument.artist || "Исполнитель")}</span></div></div>
        <div class="lyrics-viewport"></div>
        <div class="player-bar">${playerMarkup(audioURL)}</div>
      </div>
    </div>`;
  const audio = $("audio", container), toggle = $(".preview-toggle", container), seek = $(".preview-seek", container);
  toggle.addEventListener("click", () => audio.paused ? audio.play() : audio.pause());
  seek.addEventListener("input", () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) * audio.duration; });
  const viewport = $(".lyrics-viewport", container), stack = window.document.createElement("div");
  stack.className = "lyrics-stack"; viewport.append(stack);
  lyricsDocument.lines.forEach((line, lineIndex) => {
    const element = window.document.createElement("div");
    element.className = "lyric-line";
    element.dataset.line = lineIndex;
    if (lyricsDocument.mode === "word") {
      lyricsDocument.cues.filter(cue => cue.lineIndex === lineIndex).forEach(cue => {
        const span = window.document.createElement("span"); span.className = "word"; span.dataset.begin = cue.begin; span.dataset.end = cue.end;
        span.innerHTML = `${wordLayer(cue.text, "rest")}${wordLayer(cue.text, "fill")}`; element.append(span);
      });
    } else element.textContent = line;
    stack.append(element);
  });
  $$(".lyric-line", stack).forEach(line => line.addEventListener("click", () => {
    const cues = lyricsDocument.cues.filter(cue => cue.lineIndex === Number(line.dataset.line) && cue.begin != null);
    if (cues.length) { audio.currentTime = Math.min(...cues.map(cue => cue.begin)); audio.play(); }
  }));
  const instance = { container, viewport, stack, audio, toggle, seek, focusLine: null, document: lyricsDocument };
  previewInstances.push(instance);
  return instance;
}

const previewInstances = [];
function updatePreviews() {
  previewInstances.forEach(instance => {
    if (!instance.container.isConnected) return;
    const time = instance.audio.currentTime || 0;
    instance.toggle.textContent = instance.audio.paused ? "▶" : "Ⅱ";
    instance.seek.value = instance.audio.duration ? time / instance.audio.duration : 0;
    $(".preview-time", instance.container).textContent = formatTime(time);
    $(".preview-duration", instance.container).textContent = formatTime(instance.audio.duration);
    if(instance.audio===state.verify.previewAudio){
      $("#verifyPlay").textContent=instance.audio.paused?"▶":"Ⅱ";$("#verifySeek").value=instance.audio.duration?time/instance.audio.duration:0;$("#verifyTime").textContent=`${formatTime(time)} / ${formatTime(instance.audio.duration)}`;
      if(!instance.audio.paused){const activeIndex=instance.document.cues.findIndex(cue=>cue.begin!=null&&cue.end!=null&&time>=cue.begin&&time<=cue.end);if(activeIndex>=0&&activeIndex!==state.verify.selectedCue){state.verify.selectedCue=activeIndex;renderVerifyTiming();}}
    }
    if(instance.audio===state.editor.previewAudio){
      $("#exportPlay").textContent=instance.audio.paused?"▶ Воспроизвести":"Ⅱ Пауза";$("#exportSeek").value=instance.audio.duration?time/instance.audio.duration:0;$("#exportTime").textContent=`${formatTime(time)} / ${formatTime(instance.audio.duration)}`;
      if(!instance.audio.paused){const activeIndex=instance.document.cues.findIndex(cue=>cue.begin!=null&&cue.end!=null&&time>=cue.begin&&time<=cue.end);if(activeIndex>=0&&activeIndex!==state.editor.selectedEdit){state.editor.selectedEdit=activeIndex;renderEditorTiming();}}
    }
    const previewBounds=lineBounds(instance.document),activeBound=previewBounds.find(bound => time>=bound.begin&&time<=bound.end);
    if(activeBound&&activeBound.lineIndex!==instance.focusLine&&instance.viewport.clientHeight>0){
      instance.focusLine = activeBound.lineIndex;
      const activeLine = $(`.lyric-line[data-line="${activeBound.lineIndex}"]`, instance.stack);
      if (activeLine) instance.stack.style.transform = `translateY(${instance.viewport.clientHeight / 2 - activeLine.offsetTop - activeLine.offsetHeight / 2}px)`;
    }
    $$(".lyric-line", instance.stack).forEach(line => {
      const index=Number(line.dataset.line),emphasis=lineEmphasis(instance.document,index,time),bound=previewBounds.find(item=>item.lineIndex===index);
      if (instance.document.mode === "line") {
        const opacity = !bound ? .30 : time >= bound.begin && time <= bound.end ? 1 : time > bound.end ? .94 : .30;
        line.style.color = `rgba(255,255,255,${opacity})`;
      }
      $$(".word", line).forEach(word => {
        const cue = { begin: Number(word.dataset.begin), end: Number(word.dataset.end) }, progress = cueProgress(cue, time);
        word.style.setProperty("--front", `${progress * 155}%`);
        const restingOpacity = .30 + ((time > cue.end ? .94 : .38) - .30) * emphasis;
        $(".word-layer.rest", word).style.color = `rgba(255,255,255,${restingOpacity})`;
        $(".word-layer.fill", word).style.opacity = emphasis;
        const duration = cue.end - cue.begin, letters = $$("i", word), count = letters.length;
        letters.forEach(letter => {
          let wave = 0;
          if (duration >= 1.8 && time >= cue.begin && time <= cue.end && count) {
            const rawProgress=clamp((time-cue.begin)/duration),strength = clamp((duration - 1.8) / 1), position = count === 1 ? .5 : Number(letter.dataset.letter) / (count - 1);
            const distance = Math.abs(position - (rawProgress * 1.34 - .17));
            wave = distance < .46 ? smoothstep(Math.cos((distance/.46)*Math.PI/2))*strength : 0;
          }
          letter.style.setProperty("--wave", wave.toFixed(4));
        });
      });
    });
  });
  requestAnimationFrame(updatePreviews);
}
requestAnimationFrame(updatePreviews);

async function readTextFile(input) {
  const file = input.files?.[0];
  if (!file) throw new Error("Файл не выбран");
  return { file, text: await file.text() };
}

function useAudioFile(input, audio, callback) {
  const file = input.files?.[0]; if (!file) return;
  const url = URL.createObjectURL(file); audio.src = url; audio.load(); callback?.(url, file);
}

$("#verifyAudio").addEventListener("change", event => {
  const dummy = document.createElement("audio");
  useAudioFile(event.target, dummy, url => { state.verify.audioURL = url; $("#verifyStatus").textContent = event.target.files[0].name; refreshVerify(); });
});
$("#verifyTTML").addEventListener("change", async event => {
  try { const { text } = await readTextFile(event.target); state.verify.document = parseTTML(text); $("#verifyStatus").textContent = "TTML загружен"; refreshVerify(); }
  catch (error) { $("#verifyStatus").textContent = error.message; }
});
function refreshVerify() {
  const container=$("#verifyPreview"), ready=Boolean(state.verify.document&&state.verify.audioURL);
  previewInstances.splice(0,previewInstances.length,...previewInstances.filter(item=>item.container!==container));
  $(".verify-layout").classList.toggle("reviewing",ready); container.hidden=!ready; $("#verifyLoadedControls").hidden=!ready;
  if(!ready){container.innerHTML="";return;}
  const instance=createPreview(container,state.verify.document,state.verify.audioURL,state.verify.coverURL);state.verify.previewAudio=instance.audio;
  $("#verifyTrackTitle").textContent=state.verify.document.title;$("#verifyTrackArtist").textContent=state.verify.document.artist||"Исполнитель";
  $("#verifyCode").textContent=buildTTML(state.verify.document);renderVerifyTiming();
}

function renderVerifyTiming(){
  const cues=state.verify.document?.cues||[],index=clamp(state.verify.selectedCue,0,Math.max(cues.length-1,0)),cue=cues[index];state.verify.selectedCue=index;
  $("#verifyCueCounter").textContent=cues.length?`${index+1} / ${cues.length}`:"0 / 0";$("#verifyCueText").textContent=cue?.text||"Фрагмент не выбран";
}
function setVerifyView(showsPreview){state.verify.showsPreview=showsPreview;$("#verifyPreview").hidden=!showsPreview;$("#verifyCode").hidden=showsPreview;$("#verifyShowPreview").classList.toggle("active",showsPreview);$("#verifyShowCode").classList.toggle("active",!showsPreview);if(showsPreview){const instance=previewInstances.find(item=>item.container===$("#verifyPreview"));if(instance)instance.focusLine=null;}else $("#verifyCode").textContent=buildTTML(state.verify.document);}
$("#verifyShowPreview").addEventListener("click",()=>setVerifyView(true));$("#verifyShowCode").addEventListener("click",()=>setVerifyView(false));
$("#verifyPlay").addEventListener("click",()=>{const audio=state.verify.previewAudio;if(audio)audio.paused?audio.play():audio.pause();});
$("#verifyStop").addEventListener("click",()=>{const audio=state.verify.previewAudio;if(audio){audio.pause();audio.currentTime=0;}});
$("#verifySeek").addEventListener("input",event=>{const audio=state.verify.previewAudio;if(audio&&Number.isFinite(audio.duration))audio.currentTime=Number(event.target.value)*audio.duration;});
$("#verifyPreviousCue").addEventListener("click",()=>selectVerifyCue(-1));$("#verifyNextCue").addEventListener("click",()=>selectVerifyCue(1));
function selectVerifyCue(direction){const cues=state.verify.document?.cues||[];if(!cues.length)return;state.verify.selectedCue=clamp(state.verify.selectedCue+direction,0,cues.length-1);const cue=cues[state.verify.selectedCue];if(cue.begin!=null&&state.verify.previewAudio)state.verify.previewAudio.currentTime=cue.begin;renderVerifyTiming();}
$$('[data-verify-field]').forEach(button=>button.addEventListener("click",()=>{const cue=state.verify.document?.cues[state.verify.selectedCue];if(!cue)return;const delta=Number(button.dataset.delta),begin=cue.begin??0,end=cue.end??begin+.03,limit=state.verify.previewAudio?.duration||Number.MAX_SAFE_INTEGER;switch(button.dataset.verifyField){case"begin":cue.begin=Math.min(Math.max(begin+delta,0),end-.03);break;case"end":cue.end=Math.max(Math.min(end+delta,limit),begin+.03);break;default:{const length=end-begin,next=Math.min(Math.max(begin+delta,0),Math.max(limit-length,0));cue.begin=next;cue.end=next+length;}}$("#verifyCode").textContent=buildTTML(state.verify.document);renderVerifyTiming();}));
$("#verifySave").addEventListener("click",()=>{if(state.verify.document)downloadBlob(new Blob([buildTTML(state.verify.document)],{type:"application/ttml+xml"}),`${state.verify.document.title||"lyrics"}-edited.ttml`);});
$("#verifyResetFiles").addEventListener("click",()=>{state.verify.previewAudio?.pause();state.verify={audioURL:"",document:null,coverURL:"",previewAudio:null,selectedCue:0,showsPreview:true};$("#verifyAudio").value="";$("#verifyTTML").value="";$("#verifyStatus").textContent="Добавьте аудио и TTML.";setVerifyView(true);refreshVerify();});

const editorPlayer = $("#editorPlayer");
$("#editorAudio").addEventListener("change", event => useAudioFile(event.target, editorPlayer, (url, file) => {
  state.editor.audioURL = url; $("#syncFileName").textContent = file.name; if (!$("#trackTitle").value) $("#trackTitle").value = file.name.replace(/\.[^.]+$/, "");
}));

$("#syncPlay").addEventListener("click", () => editorPlayer.paused ? editorPlayer.play() : editorPlayer.pause());
$("#syncSeek").addEventListener("input", event => { if (Number.isFinite(editorPlayer.duration)) editorPlayer.currentTime = Number(event.target.value) * editorPlayer.duration; });
$("#syncRate").addEventListener("input", event => { editorPlayer.playbackRate = Number(event.target.value); $("#syncRateValue").textContent = `${Number(event.target.value).toFixed(2)}x`; });

function updateSyncPlayer() {
  $("#syncPlay").textContent = editorPlayer.paused ? "▶" : "Ⅱ";
  $("#syncSeek").value = editorPlayer.duration ? editorPlayer.currentTime / editorPlayer.duration : 0;
  $("#syncCurrentTime").textContent = formatTime(editorPlayer.currentTime);
  $("#syncDuration").textContent = formatTime(editorPlayer.duration);
  requestAnimationFrame(updateSyncPlayer);
}
requestAnimationFrame(updateSyncPlayer);

function editorStage(name) {
  if (name !== "sync") editorPlayer.pause();
  if (name !== "export") $("#editorPreview audio")?.pause();
  $$(".editor-stage").forEach(stage => stage.classList.toggle("active", stage.dataset.editorStage === name));
  const order = ["details", "sync", "export"], active = order.indexOf(name);
  $$(".editor-steps span").forEach((step, index) => step.classList.toggle("active", index === active));
  if(name==="sync")$("#syncKeyboardSink").focus({preventScroll:true});
}

function buildEditorCues() {
  const lines = $("#lyricsInput").value.split(/\n+/).map(line => line.trim()).filter(Boolean);
  state.editor.lines = lines; state.editor.index = 0;
  state.editor.cues = state.editor.mode === "line"
    ? lines.map((text, lineIndex) => ({ lineIndex, wordIndex: null, text, begin: null, end: null }))
    : lines.flatMap((line, lineIndex) => line.split(/\s+/).map((text, wordIndex) => ({ lineIndex, wordIndex, text, begin: null, end: null })));
  renderSyncList();
  $("#syncMessage").textContent = "";
}

$("#toSync").addEventListener("click", () => {
  if (!state.editor.audioURL || !$("#lyricsInput").value.trim()) { $("#editorStatus").textContent = "Добавьте аудио и текст"; return; }
  buildEditorCues(); editorStage("sync");
});
$("#backToDetails").addEventListener("click", () => editorStage("details"));
$("#backToSync").addEventListener("click", () => editorStage("sync"));
$$('[data-sync-mode]').forEach(button => button.addEventListener("click", () => {
  state.editor.mode = button.dataset.syncMode; $$('[data-sync-mode]').forEach(item => item.classList.toggle("active", item === button)); buildEditorCues();
}));
$("#resetSync").addEventListener("click", () => {
  editorPlayer.pause(); editorPlayer.currentTime = 0; state.editor.holding = false; state.editor.index = 0;
  state.editor.cues.forEach(cue => { cue.begin = null; cue.end = null; });
  $("#syncMessage").textContent = "Все тайминги сброшены. Начните с первого фрагмента"; renderSyncList();
});
$("#resetCue").addEventListener("click", () => {
  if (!state.editor.cues.length) return;
  let index = Math.min(state.editor.index, state.editor.cues.length - 1);
  if (state.editor.cues[index].begin == null && index > 0) index -= 1;
  const cue = state.editor.cues[index], previousBegin = cue.begin; cue.begin = null; cue.end = null; state.editor.index = index; state.editor.holding = false;
  if (Number.isFinite(previousBegin)) editorPlayer.currentTime = previousBegin;
  $("#syncMessage").textContent = `${state.editor.mode === "word" ? "Слово" : "Строка"} готова к повторной синхронизации`; renderSyncList();
});

function renderSyncList() {
  const list = $("#syncList"); list.innerHTML = "";
  if (state.editor.mode === "word") {
    state.editor.lines.forEach((line, lineIndex) => {
      const group=document.createElement("div"); group.className="sync-word-line"; group.innerHTML=`<small>${escapeHTML(line)}</small><div class="sync-words"></div>`;
      state.editor.cues.forEach((cue,index)=>{if(cue.lineIndex!==lineIndex)return;const word=document.createElement("button");word.className=`sync-word ${index===state.editor.index?"active":""} ${cue.end!=null?"done":""}`;word.textContent=cue.text;word.title=cue.begin==null?"Без тайминга":`${cue.begin.toFixed(3)} — ${cue.end.toFixed(3)}`;word.addEventListener("click",()=>{state.editor.index=index;if(cue.begin!=null)editorPlayer.currentTime=cue.begin;$("#syncMessage").textContent="";renderSyncList();});$(".sync-words",group).append(word);});
      list.append(group);
    });
  } else {
    state.editor.cues.forEach((cue, index) => {
      const row = document.createElement("div"); row.className = `sync-row ${index === state.editor.index ? "active" : ""} ${cue.end != null ? "done" : ""}`;
      row.innerHTML = `<small>${cue.begin == null ? "--" : `${cue.begin.toFixed(3)} — ${cue.end?.toFixed(3) || "…"}`}</small>${escapeHTML(cue.text)}`;
      row.addEventListener("click", () => { state.editor.index = index; if (cue.begin != null) editorPlayer.currentTime = cue.begin; $("#syncMessage").textContent = ""; renderSyncList(); }); list.append(row);
    });
  }
  $("#syncCounter").textContent = `${state.editor.cues.filter(cue => cue.end != null).length} / ${state.editor.cues.length}`;
  $("#resetCueLabel").textContent = state.editor.mode === "word" ? "Слово" : "Строка";
  $("#spaceHintTitle").textContent = state.editor.index >= state.editor.cues.length ? "Синхронизация завершена" : state.editor.holding ? "Отпустите пробел в конце" : "Удерживайте пробел";
  list.querySelector(".active")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function isSyncScreen() { return state.route === "editor" && $('[data-editor-stage="sync"]').classList.contains("active"); }
function isTextEditing(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !["range", "button", "checkbox", "radio"].includes(element.type);
}
function consumeSyncSpace(event) {
  const isSpace=event.code==="Space"||event.key===" "||event.key==="Spacebar";
  if (!isSyncScreen() || !isSpace || isTextEditing(event.target)) return false;
  event.preventDefault(); event.stopPropagation();
  return true;
}
window.addEventListener("keydown", event => {
  if (!consumeSyncSpace(event) || event.repeat) return;
  const cue = state.editor.cues[state.editor.index]; if (!cue) return;
  if (editorPlayer.paused) editorPlayer.play(); cue.begin = editorPlayer.currentTime; cue.end = null; state.editor.holding = true;
}, true);
window.addEventListener("keypress",event=>{if(isSyncScreen()&&(event.code==="Space"||event.key===" "||event.key==="Spacebar")){event.preventDefault();event.stopPropagation();}},true);
window.addEventListener("keyup", event => {
  if (!consumeSyncSpace(event)) return;
  if (!state.editor.holding) return;
  const cue = state.editor.cues[state.editor.index]; cue.end = Math.max(editorPlayer.currentTime, cue.begin + .01); state.editor.holding = false; state.editor.index = Math.min(state.editor.index + 1, state.editor.cues.length); renderSyncList();
}, true);

function editorDocument() { return { title: $("#trackTitle").value || "Без названия", artist: $("#trackArtist").value, album: $("#trackAlbum").value, language: "ru", mode: state.editor.mode, lines: state.editor.lines, cues: state.editor.cues }; }
$("#toExport").addEventListener("click", () => {
  editorPlayer.pause();state.editor.selectedEdit=Math.max(state.editor.cues.findIndex(cue=>cue.end!=null),0);editorStage("export");refreshEditorPreview();renderEditorExport();
});

function refreshEditorPreview(time=0,shouldPlay=false){const container=$("#editorPreview");previewInstances.splice(0,previewInstances.length,...previewInstances.filter(item=>item.container!==container));const instance=createPreview(container,editorDocument(),state.editor.audioURL);state.editor.previewAudio=instance.audio;instance.audio.addEventListener("loadedmetadata",()=>{instance.audio.currentTime=Math.min(time,instance.audio.duration||time);if(shouldPlay)instance.audio.play();},{once:true});}
function renderEditorExport(){const document=editorDocument();$("#exportTrack").textContent=document.title;$("#exportArtist").textContent=document.artist||"—";$("#exportMode").textContent=document.mode==="word"?"Пословно":"Построчно";$("#exportCount").textContent=document.cues.length;$("#editorCode").textContent=buildTTML(document);renderEditorTiming();}
function renderEditorTiming(){const cues=state.editor.cues,index=clamp(state.editor.selectedEdit,0,Math.max(cues.length-1,0)),cue=cues[index];state.editor.selectedEdit=index;$("#exportCueCounter").textContent=cues.length?`${index+1} / ${cues.length}`:"0 / 0";$("#exportCueText").textContent=cue?.text||"Фрагмент не выбран";}
function setEditorExportView(showsPreview){state.editor.showsPreview=showsPreview;$("#editorPreview").hidden=!showsPreview;$("#editorCode").hidden=showsPreview;$("#editorShowPreview").classList.toggle("active",showsPreview);$("#editorShowCode").classList.toggle("active",!showsPreview);if(showsPreview){const instance=previewInstances.find(item=>item.container===$("#editorPreview"));if(instance)instance.focusLine=null;}else $("#editorCode").textContent=buildTTML(editorDocument());}
$("#editorShowPreview").addEventListener("click",()=>setEditorExportView(true));$("#editorShowCode").addEventListener("click",()=>setEditorExportView(false));
$("#exportPlay").addEventListener("click",()=>{const audio=state.editor.previewAudio;if(audio)audio.paused?audio.play():audio.pause();});$("#exportStop").addEventListener("click",()=>{const audio=state.editor.previewAudio;if(audio){audio.pause();audio.currentTime=0;}});$("#exportSeek").addEventListener("input",event=>{const audio=state.editor.previewAudio;if(audio&&Number.isFinite(audio.duration))audio.currentTime=Number(event.target.value)*audio.duration;});
$("#exportPreviousCue").addEventListener("click",()=>selectEditorCue(-1));$("#exportNextCue").addEventListener("click",()=>selectEditorCue(1));
function selectEditorCue(direction){if(!state.editor.cues.length)return;state.editor.selectedEdit=clamp(state.editor.selectedEdit+direction,0,state.editor.cues.length-1);const cue=state.editor.cues[state.editor.selectedEdit];if(cue.begin!=null&&state.editor.previewAudio)state.editor.previewAudio.currentTime=cue.begin;renderEditorTiming();}
$$('[data-export-field]').forEach(button=>button.addEventListener("click",()=>{const cue=state.editor.cues[state.editor.selectedEdit];if(!cue)return;const delta=Number(button.dataset.delta),begin=cue.begin??0,end=cue.end??begin+.03,limit=state.editor.previewAudio?.duration||Number.MAX_SAFE_INTEGER;switch(button.dataset.exportField){case"begin":cue.begin=Math.min(Math.max(begin+delta,0),end-.03);break;case"end":cue.end=Math.max(Math.min(end+delta,limit),begin+.03);break;default:{const length=end-begin,next=Math.min(Math.max(begin+delta,0),Math.max(limit-length,0));cue.begin=next;cue.end=next+length;}}const time=state.editor.previewAudio?.currentTime||0,playing=state.editor.previewAudio?!state.editor.previewAudio.paused:false;state.editor.previewAudio?.pause();refreshEditorPreview(time,playing);renderEditorExport();}));

function timecode(value) { const h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = (value % 60).toFixed(3).padStart(6,"0"); return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${s}`; }
function buildTTML(document) {
  const paragraphs = document.lines.map((line, lineIndex) => {
    const cues = document.cues.filter(cue => cue.lineIndex === lineIndex && cue.begin != null && cue.end != null);
    if (document.mode === "word") {
      if (!cues.length) return "";
      return `      <p begin="${timecode(cues[0].begin)}" end="${timecode(cues.at(-1).end)}">${cues.map(cue => `<span begin="${timecode(cue.begin)}" end="${timecode(cue.end)}">${escapeXML(cue.text)}</span>`).join(" ")}</p>`;
    }
    const cue = cues[0]; return cue ? `      <p begin="${timecode(cue.begin)}" end="${timecode(cue.end)}">${escapeXML(line)}</p>` : "";
  }).filter(Boolean).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="${document.language}">\n  <head><metadata><ttm:title>${escapeXML(document.title)}</ttm:title><ttm:agent xml:id="voice1" type="person"><ttm:name>${escapeXML(document.artist)}</ttm:name></ttm:agent></metadata></head>\n  <body><div>\n${paragraphs}\n  </div></body>\n</tt>`;
}
function downloadBlob(blob, name) { const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 5000); }
$("#downloadTTML").addEventListener("click", () => downloadBlob(new Blob([buildTTML(editorDocument())], { type: "application/ttml+xml" }), `${$("#trackTitle").value || "lyrics"}.ttml`));

const vizPlayer = $("#vizPlayer"), vizCanvas = $("#visualizerCanvas"), vizContext = vizCanvas.getContext("2d");
$("#vizPlay").addEventListener("click",()=>vizPlayer.paused?vizPlayer.play():vizPlayer.pause());
$("#vizSeek").addEventListener("input",event=>{if(Number.isFinite(vizPlayer.duration))vizPlayer.currentTime=Number(event.target.value)*vizPlayer.duration;});
$("#vizAudio").addEventListener("change", event => useAudioFile(event.target, vizPlayer, (url, file) => { state.visualizer.audioURL = url; if (!$("#vizTitle").value) $("#vizTitle").value = file.name.replace(/\.[^.]+$/, ""); }));
$("#vizTTML").addEventListener("change", async event => { try { const { text } = await readTextFile(event.target); state.visualizer.document = parseTTML(text); $("#vizTitle").value ||= state.visualizer.document.title; $("#vizArtist").value ||= state.visualizer.document.artist; $("#vizStatus").textContent = "TTML загружен"; } catch(error) { $("#vizStatus").textContent = error.message; } });
$("#vizCover").addEventListener("change", event => {
  const file = event.target.files?.[0]; if (!file) return; const image = new Image(); image.onload = () => { state.visualizer.cover = image; state.visualizer.palette = samplePalette(image); }; image.src = URL.createObjectURL(file);
});

function samplePalette(image) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32; const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(image,0,0,32,32);
  return [[4,5],[25,6],[7,25],[25,25]].map(([x,y]) => { const d = ctx.getImageData(x,y,1,1).data,[r,g,b]=boostPaletteColor(d[0],d[1],d[2]);return `rgb(${r},${g},${b})`; });
}

function boostPaletteColor(r,g,b){const max=Math.max(r,g,b)/255,min=Math.min(r,g,b)/255,brightness=clamp(max*1.08,.28,.92),sourceSaturation=max?1-min/max:0,saturation=Math.max(sourceSaturation,.66),scale=max?brightness/max:1;let nr=r/255*scale,ng=g/255*scale,nb=b/255*scale;const peak=Math.max(nr,ng,nb),floor=peak*(1-saturation),oldFloor=Math.min(nr,ng,nb),range=Math.max(peak-oldFloor,.001);nr=floor+(nr-oldFloor)/range*(peak-floor);ng=floor+(ng-oldFloor)/range*(peak-floor);nb=floor+(nb-oldFloor)/range*(peak-floor);return[nr,ng,nb].map(value=>Math.round(clamp(value)*255));}
function colorAlpha(color,alpha){if(color.startsWith("#")){const hex=color.slice(1),value=hex.length===3?hex.split("").map(x=>x+x).join(""):hex;return `rgba(${parseInt(value.slice(0,2),16)},${parseInt(value.slice(2,4),16)},${parseInt(value.slice(4,6),16)},${alpha})`;}const values=color.match(/[\d.]+/g)||[0,0,0];return `rgba(${values[0]},${values[1]},${values[2]},${alpha})`;}
function drawAspectFill(ctx,image,x,y,width,height,scale=1,offsetX=0,offsetY=0){const ratio=Math.max(width/image.width,height/image.height)*scale,w=image.width*ratio,h=image.height*ratio;ctx.drawImage(image,x+(width-w)/2+offsetX,y+(height-h)/2+offsetY,w,h);}

function drawCover(ctx, image, x, y, size) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x,y,size,size,size*.025); ctx.clip();
  if (image) { const ratio = Math.max(size/image.width,size/image.height), w=image.width*ratio,h=image.height*ratio; ctx.drawImage(image,x+(size-w)/2,y+(size-h)/2,w,h); }
  else { ctx.fillStyle="rgba(255,255,255,.12)"; ctx.fillRect(x,y,size,size); }
  ctx.restore();
}

function drawVisualizer() {
  const ctx = vizContext, W = vizCanvas.width, H = vizCanvas.height, time = vizPlayer.currentTime || 0, phase = performance.now()/1000, palette = state.visualizer.palette;
  $("#vizPlay").textContent=vizPlayer.paused?"▶":"Ⅱ";$("#vizSeek").value=vizPlayer.duration?time/vizPlayer.duration:0;$("#vizCurrentTime").textContent=formatTime(time);$("#vizDuration").textContent=formatTime(vizPlayer.duration);
  ctx.clearRect(0,0,W,H);const gradient=ctx.createLinearGradient((.04+.16*Math.sin(phase*.16))*W,(.08+.12*Math.cos(phase*.13))*H,(.94+.06*Math.cos(phase*.11))*W,(.90+.08*Math.sin(phase*.15))*H);palette.forEach((color,index)=>gradient.addColorStop(index/(palette.length-1),color));ctx.fillStyle=gradient;ctx.fillRect(0,0,W,H);
  if(state.visualizer.cover){ctx.save();ctx.globalAlpha=.60;ctx.filter=`blur(${W*.056}px) saturate(1.62) contrast(1.1)`;drawAspectFill(ctx,state.visualizer.cover,0,0,W,H,1.31+.035*Math.sin(phase*.17),34/1280*W*Math.sin(phase*.14),28/720*H*Math.cos(phase*.12));ctx.restore();}
  ctx.save();ctx.globalCompositeOperation="screen";const glow=ctx.createLinearGradient(.08*W,(.5+.28*Math.sin(phase*.12))*H,.92*W,(.5+.28*Math.cos(phase*.10))*H);glow.addColorStop(0,colorAlpha(palette.at(-1),.52));glow.addColorStop(.5,"rgba(0,0,0,0)");glow.addColorStop(1,colorAlpha(palette[0],.42));ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);ctx.restore();
  ctx.fillStyle="rgba(0,0,0,.30)"; ctx.fillRect(0,0,W,H);
  const coverSize=Math.min(W*.27,H*.48), left=W*.07, coverY=(H-coverSize)/2-H*.055; drawCover(ctx,state.visualizer.cover,left,coverY,coverSize);
  ctx.fillStyle="#fff"; ctx.font=`700 ${W*.021}px -apple-system`; ctx.fillText($("#vizTitle").value||"Название трека",left,coverY+coverSize+H*.06,coverSize);
  ctx.fillStyle="rgba(255,255,255,.64)"; ctx.font=`500 ${W*.014}px -apple-system`; ctx.fillText($("#vizArtist").value||"Исполнитель",left,coverY+coverSize+H*.092,coverSize);
  const barY=coverY+coverSize+H*.13; ctx.fillStyle="rgba(255,255,255,.22)"; ctx.fillRect(left,barY,coverSize,H*.005); ctx.fillStyle="rgba(255,255,255,.9)"; ctx.fillRect(left,barY,coverSize*clamp(time/(vizPlayer.duration||1)),H*.005);
  ctx.font=`600 ${W*.009}px ui-monospace`; ctx.fillStyle="rgba(255,255,255,.58)"; ctx.fillText(formatTime(time),left,barY+H*.035); ctx.textAlign="right"; ctx.fillText(formatTime(vizPlayer.duration),left+coverSize,barY+H*.035); ctx.textAlign="left";
  drawCanvasLyrics(ctx,state.visualizer.document,time,W*.46,W*.47,H); requestAnimationFrame(drawVisualizer);
}

function drawCanvasLyrics(ctx, document, time, x, width, height) {
  if (!document) return; const focus=visualFocus(document,time), slot=height*.132, center=height/2; ctx.font=`750 ${Math.min(width*.066,height*.055)}px -apple-system`; ctx.textBaseline="middle";
  const pause=instrumentalBreak(document,time);if(pause){const p=clamp((time-pause.start)/(pause.end-pause.start)),y=center+(pause.visualPosition-focus)*slot,measure=ctx.measureText("•••"),edge=Math.min(Math.max(measure.width*.34,16),72),front=x+(measure.width+edge)*p;ctx.save();ctx.globalAlpha=1-smoothstep((time-(pause.end-.45))/.45);ctx.fillStyle="rgba(255,255,255,.22)";ctx.fillText("•••",x,y);const gradient=ctx.createLinearGradient(front-edge,y,front,y);gradient.addColorStop(0,"rgba(255,255,255,.90)");gradient.addColorStop(1,"rgba(255,255,255,0)");ctx.fillStyle=gradient;ctx.fillText("•••",x,y);ctx.restore();}
  document.lines.forEach((line,index)=>{ const distance=Math.abs(index-focus); if(distance>3)return; const emphasis=lineEmphasis(document,index,time),rest=distance<.75?.34:distance<1.75?.27:.16,alpha=rest+(1-rest)*emphasis,y=center+(index-focus)*slot; ctx.save();ctx.filter=`blur(${Math.max(distance-1.35,0)*2.4}px)`;ctx.globalAlpha=alpha;ctx.fillStyle="#fff";
    if(document.mode==="word") { let cursor=x,lineY=y;document.cues.filter(c=>c.lineIndex===index).forEach(cue=>{const wordWidth=ctx.measureText(cue.text).width;if(cursor+wordWidth>x+width&&cursor>x){cursor=x;lineY+=Math.min(width*.066,height*.055)*1.18;}cursor+=drawCanvasWord(ctx,cue,time,cursor,lineY,rest,emphasis)+width*.025;}); }
    else drawWrappedCanvasLine(ctx,line,x,y,width,Math.min(width*.066,height*.055)*1.18,3);ctx.restore(); });
}

function drawWrappedCanvasLine(ctx,text,x,y,width,lineHeight,maxLines){const words=text.split(/\s+/),lines=[];let current="";for(const word of words){const candidate=current?`${current} ${word}`:word;if(ctx.measureText(candidate).width<=width||!current)current=candidate;else{lines.push(current);current=word;if(lines.length===maxLines-1)break;}}if(current&&lines.length<maxLines)lines.push(current);const startY=y-(lines.length-1)*lineHeight/2;lines.forEach((line,index)=>ctx.fillText(line,x,startY+index*lineHeight));}

function drawCanvasWord(ctx, cue, time, x, y, resting, emphasis) {
  const characters=[...cue.text], widths=characters.map(character=>ctx.measureText(character).width), total=widths.reduce((sum,value)=>sum+value,0), progress=cueProgress(cue,time), duration=cue.end-cue.begin;
  const edge=Math.min(Math.max(total*.55,22),78), front=x+(total+edge)*progress, gradient=ctx.createLinearGradient(front-edge,y,front,y);
  gradient.addColorStop(0,"rgba(255,255,255,.94)"); gradient.addColorStop(1,"rgba(255,255,255,0)");
  let cursor=x;
  characters.forEach((character,index)=>{
    let wave=0;
    if(duration>=1.8&&time>=cue.begin&&time<=cue.end&&characters.length){const rawProgress=clamp((time-cue.begin)/duration),strength=clamp((duration-1.8)/1),position=characters.length===1?.5:index/(characters.length-1),distance=Math.abs(position-(rawProgress*1.34-.17));wave=distance<.46?smoothstep(Math.cos((distance/.46)*Math.PI/2))*strength:0;}
    const lift=wave*ctx.measureText("M").actualBoundingBoxAscent*.16, scale=1+wave*.07;
    ctx.save(); ctx.translate(cursor,y-lift); ctx.scale(scale,scale); ctx.globalAlpha=resting; ctx.fillStyle="#fff"; ctx.fillText(character,0,0); ctx.globalAlpha=emphasis; ctx.fillStyle=gradient; ctx.fillText(character,0,0); ctx.restore();
    cursor+=widths[index];
  });
  return total;
}
requestAnimationFrame(drawVisualizer);

const exportDialog=$("#videoExportDialog");
$("#openVideoExport").addEventListener("click",()=>exportDialog.showModal());
$("#cancelWebExport").addEventListener("click",()=>{ if(state.visualizer.exporting) cancelBrowserExport(); });
$("#startWebExport").addEventListener("click",startBrowserExport);

async function startBrowserExport() {
  if(!state.visualizer.audioURL||!state.visualizer.document){$("#vizStatus").textContent="Добавьте аудио и TTML";exportDialog.close();return;}
  const [width,height]=$("#webVideoResolution").value.split("x").map(Number),fps=Number($("#webVideoFPS").value); vizCanvas.width=width;vizCanvas.height=height;
  const canvasStream=vizCanvas.captureStream(fps); let stream=new MediaStream(canvasStream.getVideoTracks()); state.visualizer.exportStream=stream; state.visualizer.exportCancelled=false;
  try { const AudioContextClass=window.AudioContext||window.webkitAudioContext; state.visualizer.audioContext ||= new AudioContextClass(); state.visualizer.audioSource ||= state.visualizer.audioContext.createMediaElementSource(vizPlayer); state.visualizer.audioDestination ||= state.visualizer.audioContext.createMediaStreamDestination(); if(!state.visualizer.audioExportConnected){state.visualizer.audioSource.connect(state.visualizer.audioDestination);state.visualizer.audioExportConnected=true;} if(!state.visualizer.audioMonitorConnected){state.visualizer.audioSource.connect(state.visualizer.audioContext.destination);state.visualizer.audioMonitorConnected=true;} state.visualizer.audioDestination.stream.getAudioTracks().forEach(track=>stream.addTrack(track)); await state.visualizer.audioContext.resume(); } catch(error) { $("#vizStatus").textContent="Браузер экспортирует видео без аудио"; }
  const mime=["video/mp4;codecs=h264,aac","video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus"].find(type=>MediaRecorder.isTypeSupported(type))||"video/webm";
  const chunks=[]; let recorder; try{recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:width>=2560?18000000:10000000});}catch(error){$("#vizStatus").textContent="Этот браузер не поддерживает экспорт видео";cleanupBrowserExport();return;} state.visualizer.recorder=recorder;state.visualizer.exporting=true;
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);}; recorder.onstop=()=>{ if(chunks.length&&!state.visualizer.exportCancelled){const ext=mime.includes("mp4")?"mp4":"webm";downloadBlob(new Blob(chunks,{type:mime}),`${$("#vizTitle").value||"revlis"}-visualizer.${ext}`);} cleanupBrowserExport(); };
  vizPlayer.pause();vizPlayer.currentTime=0;recorder.start(1000);await vizPlayer.play();
  const update=()=>{if(!state.visualizer.exporting)return;$("#webExportProgress").value=clamp(vizPlayer.currentTime/(vizPlayer.duration||1));if(vizPlayer.ended)recorder.stop();else requestAnimationFrame(update);};requestAnimationFrame(update);
}
function cancelBrowserExport(){state.visualizer.exportCancelled=true;state.visualizer.recorder?.stop();vizPlayer.pause();$("#vizStatus").textContent="Экспорт отменён";}
function cleanupBrowserExport(){state.visualizer.exportStream?.getTracks().forEach(track=>track.stop());state.visualizer.exportStream=null;state.visualizer.exporting=false;state.visualizer.recorder=null;$("#webExportProgress").value=0;exportDialog.close();vizCanvas.width=1280;vizCanvas.height=720;}

navigate("home");
