const API_BASE = "http://localhost:3000/api";
// const API_BASE = "https://human-preference-api.onrender.com/api";
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");
if (!token) {
    document.body.innerHTML = "<h2>Invalid or missing token. Access denied.</h2>";
    throw new Error("Missing token");
}
localStorage.setItem("token", token);

let reviewMode = false;
let completedPairs = [];
let reviewIndex = 0;

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
  let overlay = document.getElementById('startOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'startOverlay';
    overlay.style = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);z-index:9999;cursor:pointer;';
    overlay.innerHTML = '<div style="padding:12px 16px;background:#fff;border-radius:8px;font:600 14px system-ui;">Click or press Space to start playback</div>';
    document.body.appendChild(overlay);
  }
  const start = () => {
    overlay.removeEventListener('click', start);
    window.removeEventListener('keydown', onKey);
    overlay.remove();
    onStart();
  };
  const onKey = (e) => {
    if (e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar') {
      e.preventDefault();
      start();
    }
  };
  overlay.addEventListener('click', start, { once: true });
  window.addEventListener('keydown', onKey, { once: true });
}

function renderPair(pair) {
    currentPair = pair;
    annotatorId = pair.progress?.annotatorId || 'anonymous';
    document.getElementById('annotatorIdDisplay').innerText = `Annotator ID: ${annotatorId}`;
    requireRegion = !!pair._meta?.requireRegion;

    document.getElementById('description').innerText = `Task: ${pair.description}`+
    (pair._meta?.isGold ? "  (GOLD)" : "") +
    (pair._meta?.isRepeat ? "  (REPEAT)" : "");
    document.getElementById('progress').innerText = `Progress: ${pair.progress.completed}/${pair.progress.total} pairs`;

    const leftVideo = document.getElementById('leftVideo');
    const rightVideo = document.getElementById('rightVideo');

    // autoplay setup
    leftVideo.muted = true;
    rightVideo.muted = true;
    leftVideo.setAttribute('muted', '');
    rightVideo.setAttribute('muted', '');
    leftVideo.setAttribute('playsinline', '');
    rightVideo.setAttribute('playsinline', '');
    leftVideo.autoplay = true;
    rightVideo.autoplay = true;
    leftVideo.preload = 'auto';
    rightVideo.preload = 'auto';

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
        leftVideo.removeEventListener('canplay', maybeStart);
        rightVideo.removeEventListener('canplay', maybeStart);
      }
    };
    leftVideo.addEventListener('canplay', maybeStart);
    rightVideo.addEventListener('canplay', maybeStart);

    leftVideo.loop = true;
    rightVideo.loop = true;
    leftVideo.controls = true;
    rightVideo.controls = true;
}

function mapGridIndex(idx) {
    const i = Math.max(1, Math.min(9, idx)) - 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    const w = 1/3, h = 1/3;
    const x = col * w, y = row * h;
    return { row, col, rect: { x, y, w, h } };
}

function showGridOverlay(side, onPick) {
    awaitingRegion = true;
    const video = document.getElementById(side === 'left' ? 'leftVideo' : 'rightVideo');

    let overlay = document.getElementById('gridOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gridOverlay';
        overlay.style.position = 'absolute';
        overlay.style.inset = '0';
        overlay.style.display = 'grid';
        overlay.style.gridTemplateColumns = 'repeat(3, 1fr)';
        overlay.style.gridTemplateRows = 'repeat(3, 1fr)';
        overlay.style.gap = '2px';
        overlay.style.background = 'rgba(0,0,0,0.15)';
        overlay.style.pointerEvents = 'auto';
        overlay.style.zIndex = '10';
    } else {
        overlay.innerHTML = '';
    }

    const wrap = video.parentElement;
    wrap.style.position = 'relative';
    wrap.appendChild(overlay);
    overlay.innerHTML = '';
    for (let k = 1; k <= 9; k++) {
        const cell = document.createElement('div');
        cell.dataset.idx = String(k);
        cell.style.border = '1px solid rgba(255,255,255,0.7)';
        cell.style.background = 'rgba(255,255,255,0.05)';
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', () => {
        onPick(k);
        overlay.remove();
        }, { once: true });
        overlay.appendChild(cell);
    }
    // Failsafe: auto-submit after 1.2s if no pick
    regionTimeoutId = setTimeout(() => {
        overlay.remove();
        onPick(null);
    }, 1200);
}

function handleChoice(response) {
    const leftVideo = document.getElementById('leftVideo');
    const rightVideo = document.getElementById('rightVideo');

    const chosenVideo = (response === 'left') ? leftVideo
                        : (response === 'right') ? rightVideo
                        : null;
    pendingChoice = response;
    decisionAtMs = chosenVideo ? Math.round(chosenVideo.currentTime * 1000) : null;

    if (requireRegion && (response === 'left' || response === 'right')) {
        showGridOverlay(response, (idx) => {
        if (regionTimeoutId) { clearTimeout(regionTimeoutId); regionTimeoutId = null; }
        let attention = undefined;
        if (idx) {
            const { row, col, rect } = mapGridIndex(idx);
            attention = {
            side: response,
            gridIndex: idx,
            row, col,
            rect,
            decisionAtMs
            };
        }
        awaitingRegion = false;
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
    const responseTimeMs = presentedTime ? (now - presentedTime) : undefined;
    await fetch(`${API_BASE}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token,
            pairId: currentPair.pair_id,
            response,
            left:  { url: currentPair.left_clip  },
            right: { url: currentPair.right_clip },
            presentedTime,
            responseTimeMs,
            isGold: currentPair._meta?.isGold || false,
            isRepeat: currentPair._meta?.isRepeat || false,
            repeatOf: currentPair._meta?.repeatOf,
            attention
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
  const isTextInput = el =>
    el &&
    (el.tagName === 'INPUT' ||
     el.tagName === 'TEXTAREA' ||
     el.isContentEditable);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (isTextInput(document.activeElement) || e.isComposing) return;
    // If overlay is up, capture 1..9 as region pick
    if (awaitingRegion) {
        if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key, 10);
        const { row, col, rect } = mapGridIndex(idx);
        const attention = { side: pendingChoice, gridIndex: idx, row, col, rect, decisionAtMs };
        awaitingRegion = false;
        if (regionTimeoutId) { clearTimeout(regionTimeoutId); regionTimeoutId = null; }
        submitResponse(pendingChoice, attention);
        }
        return;
    }
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
    //   if (typeof submitResponse === 'function') submitResponse('left');
        handleChoice('left');
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        // if (typeof submitResponse === 'function') submitResponse('right');
        handleChoice('right');
    }  else if (e.key === 'ArrowDown') {
        e.preventDefault();
        // if (typeof submitResponse === 'function') submitResponse('cant_tell');
        handleChoice('cant_tell');
    }
  }, { passive: false });
})();
