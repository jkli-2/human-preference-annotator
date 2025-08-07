const urlParams = new URLSearchParams(window.location.search);
let annotatorId = urlParams.get('id') || prompt('Enter your ID');
localStorage.setItem('annotatorId', annotatorId);
document.getElementById('annotatorIdDisplay').innerText = `Annotator ID: ${annotatorId}`;

function logout() {
  localStorage.removeItem('annotatorId');
  window.location.href = window.location.pathname;
}

function goBack() {
  if (historyStack.length > 1) {
    historyStack.pop();
    const previous = historyStack.pop();
    currentPair = previous;
    loadNextPair(true);
  }
}

const historyStack = [];

let currentPair = null;

function updateProgress(video, bar) {
  const percentage = (video.currentTime / video.duration) * 100;
  bar.style.width = `${percentage}%`;
  if (percentage > 85) {
    document.getElementById('videoStatus').innerText = 'Video Replaying...';
  } else {
    document.getElementById('videoStatus').innerText = '\u00A0';
  }
}

function attachProgress(videoId, barId) {
  const video = document.getElementById(videoId);
  const bar = document.getElementById(barId);
  video.addEventListener('timeupdate', () => updateProgress(video, bar));
}

async function loadNextPair(backward = false) {
  const res = await fetch(`http://localhost:3000/api/clip-pairs?annotatorId=${annotatorId}`);
  const data = await res.json();

  if (!data) {
    document.getElementById('app').innerHTML = '<h2>All annotations complete. Thank you!</h2>';
    return;
  }

  if (!backward) historyStack.push(data);
  currentPair = backward ? historyStack.pop() : data;

  document.getElementById('leftVideo').src = currentPair.left_clip;
  document.getElementById('rightVideo').src = currentPair.right_clip;

  const leftVideo = document.getElementById('leftVideo');
  const rightVideo = document.getElementById('rightVideo');

  leftVideo.load();
  rightVideo.load();

  leftVideo.oncanplay = () => {
    if (rightVideo.readyState >= 3) {
      leftVideo.play();
      rightVideo.play();
    }
  };
  rightVideo.oncanplay = () => {
    if (leftVideo.readyState >= 3) {
      leftVideo.play();
      rightVideo.play();
    }
  };
  leftVideo.setAttribute("loop", "");
  rightVideo.setAttribute("loop", "");
  leftVideo.setAttribute("controls", "");
  rightVideo.setAttribute("controls", "");
  leftVideo.controls = true;
  rightVideo.controls = true;

  document.getElementById('description').innerText = `Task: ${currentPair.description}`;
  document.getElementById('progress').innerText = `Progress: ${currentPair.progress.completed}/${currentPair.progress.total} pairs`;
}

async function submitResponse(response) {
  await fetch('http://localhost:3000/api/annotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotatorId, pairId: currentPair.pair_id, response })
  });
  loadNextPair();
}

window.onload = () => {
  loadNextPair();
  attachProgress('leftVideo', 'leftProgress');
  attachProgress('rightVideo', 'rightProgress');
};