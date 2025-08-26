// const API_BASE = "http://localhost:3000/api";
const API_BASE = "https://human-preference-api.onrender.com/api";
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");
if (!token) {
    document.body.innerHTML = "<h2>Invalid or missing token. Access denied.</h2>";
    throw new Error("Missing token");
}
localStorage.setItem("token", token);
const ATTN_TIMEOUT = 10000; // 10s

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

function handleChoice(response) {
    const leftVideo = document.getElementById("leftVideo");
    const rightVideo = document.getElementById("rightVideo");

    const chosenVideo = response === "left" ? leftVideo : response === "right" ? rightVideo : null;

    pendingChoice = response;
    decisionAtMs = chosenVideo ? Math.round(chosenVideo.currentTime * 1000) : null;

    if (requireRegion && (response === "left" || response === "right")) {
        showPointOverlay(response, (pt) => {
            let attention = undefined;
            if (pt) {
                attention = {
                    type: "point",
                    side: response,
                    x: pt.x,
                    y: pt.y,
                    coordSpace: "normalised",
                    decisionAtMs,
                };
            } else {
                attention = {
                    type: "point",
                    side: response,
                    skipped: true,
                    decisionAtMs,
                };
            }
            submitResponse(pendingChoice, attention);
        });
        return;
    }
    // No attention requested
    submitResponse(response, undefined);
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
        },
        { passive: false }
    );
})();
