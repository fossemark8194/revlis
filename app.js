"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min = 0, max = 1) => Math.min(Math.max(value, min), max);
const smoothstep = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const escapeXML = value => String(value).replace(/[<>&"']/g, char => ({"<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&apos;"}[char]));
const formatTime = value => `${Math.floor((value || 0) / 60)}:${Math.floor(value || 0) % 60 < 10 ? "0" : ""}${Math.floor(value || 0) % 60}`;

const state = {
  route: "home",
  verify: { audioURL: "", document: null, coverURL: "" },
  editor: { audioURL: "", lines: [], cues: [], mode: "line", index: 0, holding: false },
  visualizer: { audioURL: "", document: null, cover: null, palette: ["#11244b", "#5d274b", "#0c5a60"], exporting: false, recorder: null }
};

const routes = { home: "", verify: "Проверка", editor: "Редактор", automatic: "Автоматическая синхронизация · Бета", visualizer: "Track Visualizer · Бета" };

function navigate(route) {
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

function createPreview(container, lyricsDocument, audioURL, coverURL = "") {
  if (!lyricsDocument) { container.innerHTML = '<div class="empty-state"><p>Добавьте TTML</p></div>'; return; }
  container.innerHTML = `
    <div class="apple-preview" style="--preview-image:url('${coverURL || "assets/revlis-1024.png"}')">
      <div class="preview-background"></div><div class="preview-dim"></div>
      <div class="preview-content">
        <div class="track-chip"><img src="${coverURL || "assets/revlis-1024.png"}" alt=""><div><strong>${lyricsDocument.title}</strong><span>${lyricsDocument.artist || "Исполнитель"}</span></div></div>
        <div class="lyrics-viewport"></div>
        <div class="player-bar"><audio controls src="${audioURL || ""}"></audio></div>
      </div>
    </div>`;
  const audio = $("audio", container);
  const viewport = $(".lyrics-viewport", container);
  const introDots = window.document.createElement("div"); introDots.className = "intro-dots"; introDots.textContent = "•••"; introDots.hidden = true; viewport.append(introDots);
  lyricsDocument.lines.forEach((line, lineIndex) => {
    const element = window.document.createElement("div");
    element.className = "lyric-line";
    element.dataset.line = lineIndex;
    if (lyricsDocument.mode === "word") {
      lyricsDocument.cues.filter(cue => cue.lineIndex === lineIndex).forEach(cue => {
        const span = window.document.createElement("span"); span.className = "word"; span.textContent = cue.text; span.dataset.word = cue.text; span.dataset.begin = cue.begin; span.dataset.end = cue.end; element.append(span);
      });
    } else element.textContent = line;
    viewport.append(element);
  });
  previewInstances.push({ container, viewport, audio, introDots, document: lyricsDocument });
}

const previewInstances = [];
function updatePreviews() {
  previewInstances.forEach(instance => {
    if (!instance.container.isConnected) return;
    const time = instance.audio.currentTime || 0;
    const focus = visualFocus(instance.document, time);
    const pause = instrumentalBreak(instance.document, time);
    instance.introDots.hidden = !pause;
    if (pause) {
      instance.introDots.style.top = `${50 + (pause.visualPosition - focus) * 20}%`;
      instance.introDots.style.setProperty("--fill", `${clamp((time - pause.start) / (pause.end - pause.start)) * 100}%`);
      instance.introDots.style.opacity = 1 - smoothstep((time - (pause.end - .45)) / .45);
    }
    $$(".lyric-line", instance.viewport).forEach(line => {
      const index = Number(line.dataset.line), distance = Math.abs(index - focus), emphasis = lineEmphasis(instance.document, index, time);
      const resting = distance < .75 ? .34 : distance < 1.75 ? .27 : .15;
      line.style.top = `${50 + (index - focus) * 20}%`;
      line.style.opacity = resting + (1 - resting) * emphasis;
      line.style.filter = `blur(${Math.max(distance - 1.35, 0) * 2}px)`;
      $$(".word", line).forEach(word => {
        const cue = { begin: Number(word.dataset.begin), end: Number(word.dataset.end) };
        word.style.setProperty("--fill", `${cueProgress(cue, time) * 100}%`);
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
function refreshVerify() { previewInstances.splice(0, previewInstances.length, ...previewInstances.filter(item => item.container !== $("#verifyPreview"))); createPreview($("#verifyPreview"), state.verify.document, state.verify.audioURL); }

const editorPlayer = $("#editorPlayer");
$("#editorAudio").addEventListener("change", event => useAudioFile(event.target, editorPlayer, (url, file) => {
  state.editor.audioURL = url; if (!$("#trackTitle").value) $("#trackTitle").value = file.name.replace(/\.[^.]+$/, "");
}));

function editorStage(name) {
  $$(".editor-stage").forEach(stage => stage.classList.toggle("active", stage.dataset.editorStage === name));
  const order = ["details", "sync", "export"], active = order.indexOf(name);
  $$(".editor-steps span").forEach((step, index) => step.classList.toggle("active", index === active));
}

function buildEditorCues() {
  const lines = $("#lyricsInput").value.split(/\n+/).map(line => line.trim()).filter(Boolean);
  state.editor.lines = lines; state.editor.index = 0;
  state.editor.cues = state.editor.mode === "line"
    ? lines.map((text, lineIndex) => ({ lineIndex, wordIndex: null, text, begin: null, end: null }))
    : lines.flatMap((line, lineIndex) => line.split(/\s+/).map((text, wordIndex) => ({ lineIndex, wordIndex, text, begin: null, end: null })));
  renderSyncList();
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
$("#resetSync").addEventListener("click", buildEditorCues);

function renderSyncList() {
  const list = $("#syncList"); list.innerHTML = "";
  state.editor.cues.forEach((cue, index) => {
    const row = document.createElement("div"); row.className = `sync-row ${index === state.editor.index ? "active" : ""} ${cue.end != null ? "done" : ""}`;
    row.innerHTML = `<small>${cue.begin == null ? "--" : `${cue.begin.toFixed(3)} — ${cue.end?.toFixed(3) || "…"}`}</small>${cue.text}`;
    row.addEventListener("click", () => { state.editor.index = index; if (cue.begin != null) editorPlayer.currentTime = cue.begin; renderSyncList(); }); list.append(row);
  });
  $("#syncCounter").textContent = `${state.editor.cues.filter(cue => cue.end != null).length} / ${state.editor.cues.length}`;
  list.querySelector(".active")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function isSyncScreen() { return state.route === "editor" && $('[data-editor-stage="sync"]').classList.contains("active"); }
window.addEventListener("keydown", event => {
  if (!isSyncScreen() || event.code !== "Space" || event.repeat || ["INPUT","TEXTAREA"].includes(document.activeElement.tagName)) return;
  event.preventDefault(); const cue = state.editor.cues[state.editor.index]; if (!cue) return;
  if (editorPlayer.paused) editorPlayer.play(); cue.begin = editorPlayer.currentTime; cue.end = null; state.editor.holding = true; renderSyncList();
});
window.addEventListener("keyup", event => {
  if (!isSyncScreen() || event.code !== "Space" || !state.editor.holding) return;
  event.preventDefault(); const cue = state.editor.cues[state.editor.index]; cue.end = Math.max(editorPlayer.currentTime, cue.begin + .01); state.editor.holding = false; state.editor.index = Math.min(state.editor.index + 1, state.editor.cues.length); renderSyncList();
});

function editorDocument() { return { title: $("#trackTitle").value || "Без названия", artist: $("#trackArtist").value, album: $("#trackAlbum").value, language: "ru", mode: state.editor.mode, lines: state.editor.lines, cues: state.editor.cues }; }
$("#toExport").addEventListener("click", () => {
  editorStage("export"); const container = $("#editorPreview"); previewInstances.splice(0, previewInstances.length, ...previewInstances.filter(item => item.container !== container)); createPreview(container, editorDocument(), state.editor.audioURL);
});

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
$("#vizAudio").addEventListener("change", event => useAudioFile(event.target, vizPlayer, (url, file) => { state.visualizer.audioURL = url; if (!$("#vizTitle").value) $("#vizTitle").value = file.name.replace(/\.[^.]+$/, ""); }));
$("#vizTTML").addEventListener("change", async event => { try { const { text } = await readTextFile(event.target); state.visualizer.document = parseTTML(text); $("#vizTitle").value ||= state.visualizer.document.title; $("#vizArtist").value ||= state.visualizer.document.artist; $("#vizStatus").textContent = "TTML загружен"; } catch(error) { $("#vizStatus").textContent = error.message; } });
$("#vizCover").addEventListener("change", event => {
  const file = event.target.files?.[0]; if (!file) return; const image = new Image(); image.onload = () => { state.visualizer.cover = image; state.visualizer.palette = samplePalette(image); }; image.src = URL.createObjectURL(file);
});

function samplePalette(image) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32; const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(image,0,0,32,32);
  return [[5,5],[26,6],[8,25],[25,25]].map(([x,y]) => { const d = ctx.getImageData(x,y,1,1).data; return `rgb(${Math.max(d[0],35)},${Math.max(d[1],35)},${Math.max(d[2],35)})`; });
}

function drawCover(ctx, image, x, y, size) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x,y,size,size,size*.025); ctx.clip();
  if (image) { const ratio = Math.max(size/image.width,size/image.height), w=image.width*ratio,h=image.height*ratio; ctx.drawImage(image,x+(size-w)/2,y+(size-h)/2,w,h); }
  else { ctx.fillStyle="rgba(255,255,255,.12)"; ctx.fillRect(x,y,size,size); }
  ctx.restore();
}

function drawVisualizer() {
  const ctx = vizContext, W = vizCanvas.width, H = vizCanvas.height, time = vizPlayer.currentTime || 0, phase = performance.now()/1000, palette = state.visualizer.palette;
  ctx.clearRect(0,0,W,H); const gradient = ctx.createLinearGradient(Math.sin(phase*.12)*W*.2,0,W,H+Math.cos(phase*.1)*H*.2); palette.forEach((color,index)=>gradient.addColorStop(index/(palette.length-1),color)); ctx.fillStyle=gradient; ctx.fillRect(0,0,W,H);
  if (state.visualizer.cover) { ctx.save(); ctx.globalAlpha=.28; ctx.filter=`blur(${W*.025}px) saturate(1.5)`; ctx.drawImage(state.visualizer.cover,-W*.05,-H*.15,W*1.1,H*1.3); ctx.restore(); }
  ctx.fillStyle="rgba(0,0,0,.28)"; ctx.fillRect(0,0,W,H);
  const coverSize=Math.min(W*.27,H*.48), left=W*.07, coverY=(H-coverSize)/2-H*.055; drawCover(ctx,state.visualizer.cover,left,coverY,coverSize);
  ctx.fillStyle="#fff"; ctx.font=`700 ${W*.021}px -apple-system`; ctx.fillText($("#vizTitle").value||"Название трека",left,coverY+coverSize+H*.06,coverSize);
  ctx.fillStyle="rgba(255,255,255,.64)"; ctx.font=`500 ${W*.014}px -apple-system`; ctx.fillText($("#vizArtist").value||"Исполнитель",left,coverY+coverSize+H*.092,coverSize);
  const barY=coverY+coverSize+H*.13; ctx.fillStyle="rgba(255,255,255,.22)"; ctx.fillRect(left,barY,coverSize,H*.005); ctx.fillStyle="rgba(255,255,255,.9)"; ctx.fillRect(left,barY,coverSize*clamp(time/(vizPlayer.duration||1)),H*.005);
  ctx.font=`600 ${W*.009}px ui-monospace`; ctx.fillStyle="rgba(255,255,255,.58)"; ctx.fillText(formatTime(time),left,barY+H*.035); ctx.textAlign="right"; ctx.fillText(formatTime(vizPlayer.duration),left+coverSize,barY+H*.035); ctx.textAlign="left";
  drawCanvasLyrics(ctx,state.visualizer.document,time,W*.46,W*.47,H); requestAnimationFrame(drawVisualizer);
}

function drawCanvasLyrics(ctx, document, time, x, width, height) {
  if (!document) return; const focus=visualFocus(document,time), slot=height*.132, center=height/2; ctx.font=`750 ${Math.min(width*.066,height*.055)}px -apple-system`; ctx.textBaseline="middle";
  const pause=instrumentalBreak(document,time); if(pause){const p=clamp((time-pause.start)/(pause.end-pause.start)),y=center+(pause.visualPosition-focus)*slot,measure=ctx.measureText("•••"),edge=Math.min(measure.width*.4,width*.08);ctx.save();ctx.globalAlpha=1-smoothstep((time-(pause.end-.45))/.45);ctx.fillStyle="rgba(255,255,255,.22)";ctx.fillText("•••",x,y);const gradient=ctx.createLinearGradient(x,y,x+measure.width+edge,y);gradient.addColorStop(0,"rgba(255,255,255,.94)");gradient.addColorStop(clamp(p-.18),"rgba(255,255,255,.94)");gradient.addColorStop(Math.max(clamp(p),.001),"rgba(255,255,255,0)");ctx.fillStyle=gradient;ctx.fillText("•••",x,y);ctx.restore();}
  document.lines.forEach((line,index)=>{ const distance=Math.abs(index-focus); if(distance>3)return; const emphasis=lineEmphasis(document,index,time),rest=distance<.75?.34:distance<1.75?.27:.15,alpha=rest+(1-rest)*emphasis,y=center+(index-focus)*slot; ctx.save(); ctx.globalAlpha=alpha; ctx.fillStyle="#fff";
    if(document.mode==="word") { let cursor=x; document.cues.filter(c=>c.lineIndex===index).forEach(cue=>{ const measure=ctx.measureText(cue.text),p=cueProgress(cue,time); ctx.globalAlpha=rest; ctx.fillText(cue.text,cursor,y); ctx.save(); ctx.beginPath(); ctx.rect(cursor,y-slot*.42,(measure.width+width*.02)*p,slot*.84); ctx.clip(); ctx.globalAlpha=.96*emphasis; ctx.fillText(cue.text,cursor,y); ctx.restore(); cursor+=measure.width+width*.025; }); }
    else ctx.fillText(line,x,y,width); ctx.restore(); });
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
