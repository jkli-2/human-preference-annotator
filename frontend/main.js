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

async function submitResponse(response) {
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
            repeatOf: currentPair._meta?.repeatOf
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

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (typeof submitResponse === 'function') submitResponse('left');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (typeof submitResponse === 'function') submitResponse('right');
    }  else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (typeof submitResponse === 'function') submitResponse('cant_tell');
    }
  }, { passive: false });
})();
