const API_BASE = "http://localhost:3000/api";
// const API_BASE = "https://human-preference-api.onrender.com/api";
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");
if (!token) {
    document.body.innerHTML = "<h2>Invalid or missing token. Access denied.</h2>";
    throw new Error("Missing token");
}
localStorage.setItem("token", token);
const ATTN_TIMEOUT = 10000; // 10s
// Pause-sampling config: default 1000 ms; override via ?ps=NNN
const PAUSE_SAMPLE_MS = Math.max(200, Number(urlParams.get("ps") || 1000)); // clamp min 200ms

function logout() {
    localStorage.removeItem("token");
    window.location.href = window.location.pathname;
}

let currentPair = null;
let annotatorId = "";
let presentedTime = null;
let requireRegion = false;
let awaitingRegion = false;
let pendingChoice = null;
let decisionAtMs = null;
let regionTimeoutId = null;

// Pause-sampling (PS) lifecycle control
let psAbort = null; // AbortController used to fence all PS listeners
let psActive = false; // true while a PS session is in progress

function cancelPauseSampling() {
    // Abort all PS event listeners and reset flags/UI
    try {
        psAbort?.abort();
    } catch (_) {}
    psAbort = null;
    psActive = false;
    awaitingRegion = false;
    // remove any lingering overlays
    document.getElementById("multiOverlay")?.remove();
    document.getElementById("pointOverlay")?.remove();
}

// 3-step annotation state (Preference, Surprise, Attention)
const STEPS = { PREF: 0, SURPRISE: 1, ATTENTION: 2 };
const STEP_LABELS = ["Preference", "Surprise", "Attention"];
let step = STEPS.PREF;
let staged = null;

function ensureTopStepperEl() {
    let el = document.getElementById("stepper");
    if (!el) {
        const host = document.getElementById("topbar-center");
        el = document.createElement("div");
        el.id = "stepper";
        el.style.marginTop = "6px";
        host && host.appendChild(el);
    }
    return el;
}

function updateTopStepper(activeStepIdx = 0) {
    const el = ensureTopStepperEl();
    if (!el) return;

    const steps = STEP_LABELS.map((label, idx) => {
        const status = idx < activeStepIdx ? "done" : idx === activeStepIdx ? "active" : "todo";
        const circleBg =
            status === "done" ? "#2ecc71" : status === "active" ? "#2980b9" : "#d0d7de";
        const circleColor = status === "todo" ? "#555" : "#fff";
        const border = status === "todo" ? "1px solid #9aa4ae" : "1px solid transparent";
        const connectorColor = idx < activeStepIdx ? "#2ecc71" : "#d0d7de";

        return `
      <div style="position:relative; display:flex; align-items:center;">
        <div style="
          width:22px;height:22px;border-radius:999px;
          background:${circleBg}; color:${circleColor};
          display:flex;align-items:center;justify-content:center;
          font:600 12px system-ui; border:${border};
          box-shadow: ${status !== "todo" ? "0 0 0 2px rgba(0,0,0,0.06) inset" : "none"};
        ">${idx + 1}</div>
        <div style="margin-left:8px; min-width:88px; font:600 12px system-ui; color:#111;">
          ${label}
        </div>
        ${
            idx < STEP_LABELS.length - 1
                ? `<div style="flex:1;height:2px;background:${connectorColor};margin:0 14px 0 0;border-radius:2px;">\u00A0\u00A0</div>`
                : ``
        }
      </div>
    `;
    }).join("");

    el.innerHTML = `
    <div style="display:flex;align-items:center;gap:0; padding:6px 8px;">
      ${steps}
    </div>
  `;
}

function resetStepperForPair() {
    step = STEPS.PREF;
    staged = {
        preference: null,
        decisionAtMs: null,
        surpriseChoice: null,
        surprise: { left: null, right: null },
        attention: null,
        startedAt: Date.now(),
        stepT0: Date.now(),
        stepDurations: {},
    };
    renderStepUI();
    updateTopStepper(0);
}

function markStepAdvance(nextStep) {
    const now = Date.now();
    staged.stepDurations[step] = (staged.stepDurations[step] || 0) + (now - (staged.stepT0 || now));
    step = nextStep;
    staged.stepT0 = now;
    renderStepUI();
    updateTopStepper(nextStep);
}

function renderStepUI() {
    const notes = document.getElementById("notes");
    const buttons = document.getElementById("buttons");
    const chosen = staged?.preference;
    const stepName =
        step === STEPS.PREF
            ? "Step 1/3: Preference"
            : step === STEPS.SURPRISE
            ? "Step 2/3: Surprise"
            : "Step 3/3: Attention";
    notes.innerHTML =
        // `<p id="instructions"><strong>${stepName}</strong></p>` +
        step === STEPS.PREF
            ? `<p id="instructions">Choose the clip you prefer (ArrowLeft = Up, ArrowRight = Down, ArrowDown = Can't tell).</p>`
            : step === STEPS.SURPRISE
            ? `<p id="instructions">Rate how <em>surprising</em> each clip felt (1 = not at all, 5 = very). Hotkeys: 1-5 for Up, Q-T for Down.</p>`
            : `<p id="instructions">Mark the spot that drove your choice on the <b>${
                  chosen === "left" ? "Up" : "Down"
              }</b> clip. Press X to place (or click the video). Esc cancels.</p>`;

    if (step === STEPS.PREF) {
        buttons.innerHTML = `
      <button onclick="handleChoice('left')">Prefer Up</button>
      <button onclick="handleChoice('right')">Prefer Down</button>
      <button onclick="handleChoice('cant_tell')">Can't Tell</button>`;
    }

    // else if (step === STEPS.SURPRISE) {
    //     buttons.innerHTML = `
    //   <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    //     <div><div style="font-weight:600;margin-bottom:4px">Up clip</div>
    //       ${[1, 2, 3, 4, 5]
    //           .map((v) => `<button data-side="left" data-val="${v}" class="surBtn">${v}</button>`)
    //           .join(" ")}
    //       <span id="leftSurVal" style="margin-left:8px; margin-right: 18px;">${staged.surprise.left ?? "-"}</span>
    //     </div>
    //     <div><div style="font-weight:600;margin-bottom:4px">Down clip</div>
    //       ${[1, 2, 3, 4, 5]
    //           .map((v) => `<button data-side="right" data-val="${v}" class="surBtn">${v}</button>`)
    //           .join(" ")}
    //       <span id="rightSurVal" style="margin-left:8px; margin-right: 18px;">${staged.surprise.right ?? "-"}</span>
    //     </div>
    //     <div><button id="surpriseNext" disabled>Next</button></div>
    //   </div>`;
    //     buttons.querySelectorAll(".surBtn").forEach((b) => {
    //         b.addEventListener("click", () => {
    //             const side = b.dataset.side,
    //                 val = Number(b.dataset.val);
    //             staged.surprise[side] = val;
    //             document.getElementById(
    //                 side === "left" ? "leftSurVal" : "rightSurVal"
    //             ).textContent = val;
    //             buttons.querySelector("#surpriseNext").disabled = !(
    //                 staged.surprise.left && staged.surprise.right
    //             );
    //         });
    //     });
    //     buttons
    //         .querySelector("#surpriseNext")
    //         .addEventListener("click", () => markStepAdvance(STEPS.ATTENTION));
    // }
    else if (step === STEPS.SURPRISE) {
        buttons.innerHTML = `
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <button id="surL">Up surprised me more</button>
            <button id="surR">Down surprised me more</button>
            <button id="surNone">No surprising event</button>
            <button id="advToggle" style="margin-left:12px;display:none">Advanced 1-5</button>
            <div id="advWrap" style="display:none; width:100%; padding-top:6px;">
                <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
                <div><div style="font-weight:600;margin-bottom:4px">Up clip</div>
                    ${[1, 2, 3, 4, 5]
                        .map(
                            (v) =>
                                `<button data-side="left" data-val="${v}" class="surBtn">${v}</button>`
                        )
                        .join(" ")}
                    <span id="leftSurVal" style="margin-left:8px">${
                        staged.surprise.left ?? "—"
                    }</span>
                </div>
                <div><div style="font-weight:600;margin-bottom:4px">Down clip</div>
                    ${[1, 2, 3, 4, 5]
                        .map(
                            (v) =>
                                `<button data-side="right" data-val="${v}" class="surBtn">${v}</button>`
                        )
                        .join(" ")}
                    <span id="rightSurVal" style="margin-left:8px">${
                        staged.surprise.right ?? "—"
                    }</span>
                </div>
                </div>
            </div>
            <div style="flex:1"></div>
            <button id="surpriseNext" style="display:none" disabled>Next</button>
            </div>`;

        const canNext = () => !!staged.surpriseChoice; // binary choice required
        const updateNext = () => {
            const n = document.getElementById("surpriseNext");
            if (n) n.disabled = !canNext();
        };

        document.getElementById("surL").addEventListener("click", () => {
            staged.surpriseChoice = "left";
            // updateNext();
            markStepAdvance(STEPS.ATTENTION);
        });
        document.getElementById("surR").addEventListener("click", () => {
            staged.surpriseChoice = "right";
            // updateNext();
            markStepAdvance(STEPS.ATTENTION);
        });
        document.getElementById("surNone").addEventListener("click", () => {
            staged.surpriseChoice = "none";
            // updateNext();
            markStepAdvance(STEPS.ATTENTION);
        });

        const adv = document.getElementById("advWrap");
        document.getElementById("advToggle").addEventListener("click", () => {
            const open = adv.style.display !== "none";
            adv.style.display = open ? "none" : "block";
        });

        buttons.querySelectorAll(".surBtn").forEach((b) => {
            b.addEventListener("click", () => {
                const side = b.dataset.side,
                    val = Number(b.dataset.val);
                staged.surprise[side] = val;
                document.getElementById(
                    side === "left" ? "leftSurVal" : "rightSurVal"
                ).textContent = val;
            });
        });

        document.getElementById("surpriseNext").addEventListener("click", () => {
            if (canNext()) markStepAdvance(STEPS.ATTENTION);
        });
        // } else if (step === STEPS.ATTENTION) {
        //     buttons.innerHTML = `
        //   <button id="markPointBtn">Mark attention on ${chosen === "left" ? "Up" : "Down"} (X)</button>
        //   ${
        //       requireRegion && (chosen === "left" || chosen === "right")
        //           ? ""
        //           : '<button id="submitNoPoint">Submit without point</button>'
        //   }
        // `;
        //     const side = chosen;
        //     const go = () => {
        //         showPointOverlay(side, (pt) => {
        //             if (pt) {
        //                 staged.attention = {
        //                     type: "point",
        //                     side,
        //                     x: pt.x,
        //                     y: pt.y,
        //                     coordSpace: "normalised",
        //                     decisionAtMs: staged.decisionAtMs,
        //                 };
        //             } else {
        //                 staged.attention = {
        //                     type: "point",
        //                     side,
        //                     skipped: true,
        //                     decisionAtMs: staged.decisionAtMs,
        //                 };
        //             }
        //             submitStagedAnnotation();
        //         });
        //     };
        //     document.getElementById("markPointBtn").addEventListener("click", go);
        //     const skipBtn = document.getElementById("submitNoPoint");
        //     if (skipBtn)
        //         skipBtn.addEventListener("click", () => {
        //             staged.attention = null;
        //             submitStagedAnnotation();
        //         });
        //     if (requireRegion && (side === "left" || side === "right")) setTimeout(go, 50); // auto-open if required
        // }
    } else if (step === STEPS.ATTENTION) {
        const side = staged?.preference; // "left" | "right"
        const label = side === "left" ? "Up" : "Down";
        notes.innerHTML = `<p id="instructions">Replay in pause-sampling: we'll pause every <b>${PAUSE_SAMPLE_MS}ms</b>. Add <em>multiple</em> points at each stop, then press Space/Enter to continue.</p>`;
        buttons.innerHTML = `
      <button id="startPS">Start pause-sampling on ${label}</button>
      <button id="skipPS">Skip (no attention)</button>
    `;
        document.getElementById("startPS").addEventListener("click", () => {
            document.getElementById("startPS").disabled = true;
            document.getElementById("skipPS").disabled = true;
            startPauseSampling(side, (attention) => {
                staged.attention = attention;
                submitStagedAnnotation(); // auto-continue when done
            });
        });
        document.getElementById("skipPS").addEventListener("click", () => {
            staged.attention = null;
            submitStagedAnnotation();
        });
    }
}

function updateProgress(video, bar) {
    const percentage = (video.currentTime / video.duration) * 100;
    bar.style.width = `${percentage}%`;
    const vidProgressElm = document.getElementById("videoStatus");
    if (vidProgressElm && percentage > 85) {
        vidProgressElm.innerText = "Video Replaying...";
    } else {
        vidProgressElm.innerText = "\u00A0";
    }
}

function attachProgress(videoId, barId) {
    const video = document.getElementById(videoId);
    const bar = document.getElementById(barId);
    video.addEventListener("timeupdate", () => updateProgress(video, bar));
}

function showStartOverlay(onStart) {
    let overlay = document.getElementById("startOverlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "startOverlay";
        overlay.style =
            "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);z-index:9999;cursor:pointer;";
        overlay.innerHTML =
            '<div style="padding:12px 16px;background:#fff;border-radius:8px;font:600 14px system-ui;">Click or press Space to start playback</div>';
        document.body.appendChild(overlay);
    }
    const start = () => {
        overlay.removeEventListener("click", start);
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        onStart();
    };
    const onKey = (e) => {
        if (e.key === " " || e.code === "Space" || e.key === "Spacebar") {
            e.preventDefault();
            start();
        }
    };
    overlay.addEventListener("click", start, { once: true });
    window.addEventListener("keydown", onKey, { once: true });
}

function renderPair(pair) {
    currentPair = pair;
    annotatorId = pair.progress?.annotatorId || "anonymous";
    document.getElementById("annotatorIdDisplay").innerText = `Annotator ID: ${annotatorId}`;
    requireRegion = !!pair._meta?.requireRegion;

    document.getElementById("description").innerText =
        `Task: ${pair.description}` +
        (pair._meta?.isGold ? "  (GOLD)" : "") +
        (pair._meta?.isRepeat ? "  (REPEAT)" : "");
    document.getElementById(
        "progress"
    ).innerText = `Progress: ${pair.progress.completed}/${pair.progress.total} pairs`;

    const leftVideo = document.getElementById("leftVideo");
    const rightVideo = document.getElementById("rightVideo");

    // autoplay setup
    leftVideo.muted = true;
    rightVideo.muted = true;
    leftVideo.setAttribute("muted", "");
    rightVideo.setAttribute("muted", "");
    leftVideo.setAttribute("playsinline", "");
    rightVideo.setAttribute("playsinline", "");
    leftVideo.autoplay = true;
    rightVideo.autoplay = true;
    leftVideo.preload = "auto";
    rightVideo.preload = "auto";

    leftVideo.src = pair.left_clip;
    rightVideo.src = pair.right_clip;

    leftVideo.load();
    rightVideo.load();

    // try autoplay. If blocked, show overlay and start on user gesture.
    const tryAutoplay = async () => {
        try {
            await Promise.all([leftVideo.play(), rightVideo.play()]);
            presentedTime = new Date();
        } catch (e) {
            showStartOverlay(async () => {
                await Promise.allSettled([leftVideo.play(), rightVideo.play()]);
                presentedTime = new Date();
            });
        }
    };
    const maybeStart = () => {
        if (leftVideo.readyState >= 3 && rightVideo.readyState >= 3) {
            tryAutoplay();
            leftVideo.removeEventListener("canplay", maybeStart);
            rightVideo.removeEventListener("canplay", maybeStart);
        }
    };
    leftVideo.addEventListener("canplay", maybeStart);
    rightVideo.addEventListener("canplay", maybeStart);

    leftVideo.loop = true;
    rightVideo.loop = true;
    leftVideo.controls = true;
    rightVideo.controls = true;

    resetStepperForPair();
}

function getNormalisedCoords(evt, el) {
    const rect = el.getBoundingClientRect();
    const clientX = (evt.touches && evt.touches[0]?.clientX) ?? evt.clientX;
    const clientY = (evt.touches && evt.touches[0]?.clientY) ?? evt.clientY;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function showPointOverlay(side, onPick) {
    awaitingRegion = true;
    const video = document.getElementById(side === "left" ? "leftVideo" : "rightVideo");

    const wrap = video.parentElement;
    wrap.style.position = wrap.style.position || "relative";

    const overlay = document.createElement("div");
    overlay.id = "pointOverlay";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.cursor = "crosshair";
    overlay.style.zIndex = "10";
    overlay.style.background = "rgba(0,0,0,0.12)";
    overlay.style.backdropFilter = "blur(0px)";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Pick a point of attention");

    // crosshair
    const marker = document.createElement("div");
    marker.style.position = "absolute";
    marker.style.width = "14px";
    marker.style.height = "14px";
    marker.style.transform = "translate(-50%, -50%)";
    marker.style.pointerEvents = "none";
    marker.style.borderRadius = "50%";
    marker.style.border = "2px solid #fff";
    marker.style.boxShadow = "0 1px 2px rgba(0,0,0,.6)";
    overlay.appendChild(marker);

    // hint
    const hint = document.createElement("div");
    hint.textContent = "Click or tap to mark attention point (Esc to cancel)";
    hint.style.position = "absolute";
    hint.style.left = "50%";
    hint.style.bottom = "8px";
    hint.style.transform = "translateX(-50%)";
    hint.style.padding = "6px 10px";
    hint.style.background = "rgba(0,0,0,0.6)";
    hint.style.color = "#fff";
    hint.style.borderRadius = "6px";
    hint.style.font = "600 12px system-ui";
    overlay.appendChild(hint);

    let lastXY = null;
    const move = (evt) => {
        const { x, y } = getNormalisedCoords(evt, wrap);
        lastXY = { x, y };
        marker.style.left = `${x * 100}%`;
        marker.style.top = `${y * 100}%`;
    };

    const pick = (evt) => {
        evt.preventDefault();
        const ping = document.createElement("div");
        ping.style.position = "absolute";
        ping.style.left = marker.style.left;
        ping.style.top = marker.style.top;
        ping.style.width = "0px";
        ping.style.height = "0px";
        ping.style.border = "2px solid #fff";
        ping.style.borderRadius = "50%";
        ping.style.opacity = "0.9";
        ping.style.transform = "translate(-50%, -50%)";
        overlay.appendChild(ping);
        ping.animate(
            [
                { width: "0px", height: "0px", opacity: 0.9 },
                { width: "36px", height: "36px", opacity: 0.0 },
            ],
            { duration: 250, easing: "ease-out" }
        ).onfinish = () => ping.remove();

        cleanup();
        // Compute from the actual event in case there was no prior move.
        const { x, y } = getNormalisedCoords(evt, wrap);
        onPick({ x, y });
    };

    const cancel = () => {
        cleanup();
        onPick(null);
    };

    const onKey = (evt) => {
        if (evt.key === "Escape") {
            evt.preventDefault();
            cancel();
        }
    };

    // Attach listeners
    overlay.addEventListener("mousemove", move);
    overlay.addEventListener("touchmove", move, { passive: true });
    overlay.addEventListener("click", pick);
    overlay.addEventListener(
        "touchstart",
        (evt) => {
            move(evt);
        },
        { passive: true }
    );
    overlay.addEventListener(
        "touchend",
        (evt) => {
            pick(evt.changedTouches?.[0] ?? evt);
        },
        { passive: false }
    );
    window.addEventListener("keydown", onKey);

    wrap.appendChild(overlay);

    // Timeout failsafe
    if (regionTimeoutId) clearTimeout(regionTimeoutId);
    regionTimeoutId = setTimeout(() => {
        cancel();
    }, ATTN_TIMEOUT);

    function cleanup() {
        if (regionTimeoutId) {
            clearTimeout(regionTimeoutId);
            regionTimeoutId = null;
        }
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        awaitingRegion = false;
    }
}

/**
 * showMultiPointCollector(side, onDone)
 * - Lets user add multiple points on the chosen video frame.
 * - Toolbar: Add by click/tap; Z to undo last; C to clear; Space/Enter to continue (finish this stop).
 * - Returns array of {x,y} in normalised coords via onDone(points).
 */
function showMultiPointCollector(side, onDone) {
    awaitingRegion = true;
    const video = document.getElementById(side === "left" ? "leftVideo" : "rightVideo");
    const wrap = video.parentElement;
    wrap.style.position = wrap.style.position || "relative";

    const overlay = document.createElement("div");
    overlay.id = "multiOverlay";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.cursor = "crosshair";
    overlay.style.zIndex = "10";
    overlay.style.background = "rgba(0,0,0,0.10)";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Mark multiple points of interest");

    // Toolbar
    const bar = document.createElement("div");
    bar.style.position = "absolute";
    bar.style.left = "50%";
    bar.style.bottom = "8px";
    bar.style.transform = "translateX(-50%)";
    bar.style.padding = "6px 10px";
    bar.style.background = "rgba(0,0,0,0.65)";
    bar.style.color = "#fff";
    bar.style.borderRadius = "6px";
    bar.style.font = "600 12px system-ui";
    bar.textContent = "Click to add points | Z=Undo | C=Clear | Space/Enter=Next";
    overlay.appendChild(bar);

    const points = [];
    const markers = [];
    const addMarker = (x, y) => {
        const m = document.createElement("div");
        m.style.position = "absolute";
        m.style.left = `${x * 100}%`;
        m.style.top = `${y * 100}%`;
        m.style.transform = "translate(-50%, -50%)";
        m.style.width = "12px";
        m.style.height = "12px";
        m.style.borderRadius = "50%";
        m.style.border = "2px solid #fff";
        m.style.boxShadow = "0 1px 2px rgba(0,0,0,.6)";
        m.style.pointerEvents = "none";
        overlay.appendChild(m);
        markers.push(m);
    };

    const click = (evt) => {
        const { x, y } = getNormalisedCoords(evt, wrap);
        points.push({ x, y });
        addMarker(x, y);
    };
    const undo = () => {
        points.pop();
        const m = markers.pop();
        if (m) m.remove();
    };
    const clearAll = () => {
        points.length = 0;
        while (markers.length) markers.pop().remove();
    };
    const finish = () => {
        cleanup();
        onDone(points.slice());
    };
    const onKey = (e) => {
        if (e.key === "z" || e.key === "Z") {
            e.preventDefault();
            undo();
        } else if (e.key === "c" || e.key === "C") {
            e.preventDefault();
            clearAll();
        } else if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            finish();
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish();
        }
    };

    overlay.addEventListener("click", click);
    window.addEventListener("keydown", onKey);
    wrap.appendChild(overlay);

    function cleanup() {
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        awaitingRegion = false;
    }
}

/**
 * startPauseSampling(side, onDone)
 * Replays the chosen side from t=0, pauses at every PAUSE_SAMPLE_MS boundary,
 * opens multi-point collector, resumes automatically, and completes at end.
 * Calls onDone({ type:"pause-sampling", side, samples, decisionAtMs }) at the end.
 */
function startPauseSampling(side, onDone) {
    const chosenVideo = document.getElementById(side === "left" ? "leftVideo" : "rightVideo");
    const otherVideo = document.getElementById(side === "left" ? "rightVideo" : "leftVideo");

    // Focus UI on the chosen video
    otherVideo.pause();
    otherVideo.controls = false;
    chosenVideo.controls = false;
    chosenVideo.loop = false;
    chosenVideo.currentTime = 0;
    chosenVideo.muted = true; // keep muted to avoid audio rules

    const durationMs = () => Math.floor((chosenVideo.duration || 0) * 1000);
    const nextBreaks = [];
    const step = Math.max(200, PAUSE_SAMPLE_MS);
    const dur = durationMs();
    for (let t = step; t < dur + 50; t += step) nextBreaks.push(t);

    const samples = []; // { tsMs, points: [{x,y}] }
    let currentIdx = 0;
    let armed = false; // armed to pause on or past next break

    const ensurePlaying = async () => {
        try {
            await chosenVideo.play();
        } catch (_) {
            /* ignore */
        }
    };

    const pauseAndCollect = (tsMs) => {
        chosenVideo.pause();
        showMultiPointCollector(side, (points) => {
            samples.push({ tsMs, points: points || [] });
            currentIdx += 1;
            if (currentIdx >= nextBreaks.length) {
                // Finished all pauses; wait for video end or push last segment if needed
                // If video already at/near end, submit now
                if (chosenVideo.ended || chosenVideo.duration - chosenVideo.currentTime < 0.05) {
                    finish();
                } else {
                    // Resume to end, then finish in "ended" handler
                    ensurePlaying();
                }
            } else {
                armed = true;
                ensurePlaying();
            }
        });
    };

    const onTime = () => {
        if (!armed || currentIdx >= nextBreaks.length) return;
        const nowMs = Math.floor(chosenVideo.currentTime * 1000);
        const target = nextBreaks[currentIdx];
        if (nowMs >= target) {
            armed = false;
            pauseAndCollect(target);
        }
    };

    const finish = () => {
        chosenVideo.removeEventListener("timeupdate", onTime);
        chosenVideo.removeEventListener("ended", finish);
        // Construct attention payload
        const attention = {
            type: "pause-sampling",
            side,
            coordSpace: "normalised",
            samples,
            decisionAtMs: staged?.decisionAtMs ?? null,
        };
        onDone(attention);
    };

    chosenVideo.addEventListener("timeupdate", onTime);
    chosenVideo.addEventListener("ended", finish);

    // Kick-off
    armed = true;
    ensurePlaying();
}

function handleChoice(response) {
    const leftVideo = document.getElementById("leftVideo");
    const rightVideo = document.getElementById("rightVideo");
    const chosenVideo = response === "left" ? leftVideo : response === "right" ? rightVideo : null;

    pendingChoice = response;
    decisionAtMs = chosenVideo ? Math.round(chosenVideo.currentTime * 1000) : null;

    if (!staged) resetStepperForPair();
    staged.preference = response;
    staged.decisionAtMs = decisionAtMs;

    if (response === "cant_tell") {
        // Skip Surprise/Attention when annotator can't tell
        staged.surprise = { left: null, right: null };
        staged.attention = null;
        submitStagedAnnotation();
        return;
    }
    markStepAdvance(STEPS.SURPRISE);
}

async function loadNextPair() {
    const res = await fetch(`${API_BASE}/clip-pairs?token=${token}`);
    if (!res.ok) {
        if (res.status === 403) {
            document.getElementById("app").innerHTML =
                "<h2>Invalid token. Please check your link or contact the administrator.</h2>";
        } else {
            document.getElementById("app").innerHTML =
                "<h2>Server error. Please try again later.</h2>";
        }
        return;
    }

    const data = await res.json();
    if (!data) {
        document.getElementById("app").innerHTML = "<h2>All annotations complete. Thank you!</h2>";
        return;
    }
    renderPair(data);
}

// For compatibility
async function submitResponse(response, attention) {
    const now = new Date();
    const responseTimeMs = presentedTime ? now - presentedTime : undefined;
    await fetch(`${API_BASE}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token,
            pairId: currentPair.pair_id,
            response,
            surpriseChoice: staged.surpriseChoice,
            left: { url: currentPair.left_clip },
            right: { url: currentPair.right_clip },
            presentedTime,
            responseTimeMs,
            isGold: currentPair._meta?.isGold || false,
            isRepeat: currentPair._meta?.isRepeat || false,
            repeatOf: currentPair._meta?.repeatOf,
            attention,
        }),
    });
    loadNextPair();
}

window.onload = () => {
    loadNextPair();
    attachProgress("leftVideo", "leftProgress");
    attachProgress("rightVideo", "rightProgress");
};

async function submitStagedAnnotation() {
    // close current step timing
    if (staged) {
        const now = Date.now();
        staged.stepDurations[step] =
            (staged.stepDurations[step] || 0) + (now - (staged.stepT0 || now));
    }

    const response = staged.preference;
    const attention = staged.attention; // may be null
    const surprise = staged.surprise;
    const stageDurations = staged.stepDurations;

    const nowDate = new Date();
    const responseTimeMs = presentedTime ? nowDate - presentedTime : undefined;

    await fetch(`${API_BASE}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token,
            pairId: currentPair.pair_id,
            response, // "left" | "right" | "cant_tell"
            surpriseChoice: staged.surpriseChoice,
            left: { url: currentPair.left_clip, surprise: surprise?.left ?? null },
            right: { url: currentPair.right_clip, surprise: surprise?.right ?? null },
            presentedTime,
            responseTimeMs,
            isGold: currentPair._meta?.isGold || false,
            isRepeat: currentPair._meta?.isRepeat || false,
            repeatOf: currentPair._meta?.repeatOf,
            attention,
            stageDurations, // optional; backend can ignore
        }),
    });
    loadNextPair();
}

// Keyboard shortcuts: LEFT prefer left, RIGHT prefer right, DOWN means can't tell
(function setupKeyboardShortcuts() {
    const isTextInput = (el) =>
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    window.addEventListener(
        "keydown",
        (e) => {
            if (e.repeat) return;
            if (isTextInput(document.activeElement) || e.isComposing) return;
            if (awaitingRegion) return;

            if (step === undefined || step === STEPS.PREF) {
                if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    handleChoice("left");
                } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    handleChoice("right");
                } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    handleChoice("cant_tell");
                }
            } else if (step === STEPS.SURPRISE) {
                const leftMap = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
                const rightMap = { q: 1, w: 2, e: 3, r: 4, t: 5, Q: 1, W: 2, E: 3, R: 4, T: 5 };

                if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    staged.surpriseChoice = "left";
                    markStepAdvance(STEPS.ATTENTION);
                    return;
                } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    staged.surpriseChoice = "right";
                    markStepAdvance(STEPS.ATTENTION);
                    return;
                } else if (e.key === "n" || e.key === "N") {
                    e.preventDefault();
                    staged.surpriseChoice = "none";
                    markStepAdvance(STEPS.ATTENTION);
                    return;
                } else if (leftMap[e.key] != null) {
                    staged.surprise.left = leftMap[e.key];
                    const s = document.getElementById("leftSurVal");
                    if (s) s.textContent = staged.surprise.left;
                } else if (rightMap[e.key] != null) {
                    staged.surprise.right = rightMap[e.key];
                    const s = document.getElementById("rightSurVal");
                    if (s) s.textContent = staged.surprise.right;
                } else if (e.key === "Enter") {
                    // fall through to next if we have a choice
                }

                const nextBtn = document.getElementById("surpriseNext");
                const canNext = !!staged.surpriseChoice;
                if (nextBtn) nextBtn.disabled = !canNext;
                if (canNext && e.key === "Enter") {
                    e.preventDefault();
                    markStepAdvance(STEPS.ATTENTION);
                }
            } else if (step === STEPS.ATTENTION) {
                if (e.key === "x" || e.key === "X") {
                    e.preventDefault();
                    const btn = document.getElementById("markPointBtn");
                    if (btn) btn.click();
                } else if (e.key === "Enter") {
                    const skip = document.getElementById("submitNoPoint");
                    if (skip) {
                        e.preventDefault();
                        skip.click();
                    }
                }
            }
        },
        { passive: false }
    );
})();
