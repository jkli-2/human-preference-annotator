const API_BASE = "https://human-preference-api.onrender.com/api";
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

function renderPair(pair) {
  currentPair = pair;
  annotatorId = pair.progress?.annotatorId || 'anonymous';
  document.getElementById('annotatorIdDisplay').innerText = `Annotator ID: ${annotatorId}`;

  document.getElementById('leftVideo').src = pair.left_clip;
  document.getElementById('rightVideo').src = pair.right_clip;

  document.getElementById('description').innerText = `Task: ${pair.description}`;
  document.getElementById('progress').innerText = `Progress: ${pair.progress.completed}/${pair.progress.total} pairs`;

  const leftVideo = document.getElementById('leftVideo');
  const rightVideo = document.getElementById('rightVideo');

  leftVideo.load();
  rightVideo.load();

  leftVideo.oncanplay = () => {
    if (rightVideo.readyState >= 3) { leftVideo.play(); rightVideo.play(); }
  };
  rightVideo.oncanplay = () => {
    if (leftVideo.readyState >= 3) { leftVideo.play(); rightVideo.play(); }
  };

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
    await fetch(`${API_BASE}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, pairId: currentPair.pair_id, response }),
    });
    loadNextPair();
}

window.onload = () => {
    loadNextPair();
    attachProgress("leftVideo", "leftProgress");
    attachProgress("rightVideo", "rightProgress");
};
