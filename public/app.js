const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const browseTrigger = document.getElementById('browseTrigger');

const uploadSection = document.getElementById('uploadSection');
const renderSection = document.getElementById('renderSection');
const resultSection = document.getElementById('resultSection');

const activeFileName = document.getElementById('activeFileName');
const renderStatus = document.getElementById('renderStatus');
const percentDisplay = document.getElementById('percentDisplay');
const progressBar = document.getElementById('progressBar');
const stageDisplay = document.getElementById('stageDisplay');
const frameDisplay = document.getElementById('frameDisplay');
const logContainer = document.getElementById('logContainer');
const logToggle = document.getElementById('logToggle');

const videoPlayer = document.getElementById('videoPlayer');
const downloadOriginalBtn = document.getElementById('downloadOriginalBtn');
const downloadMergedBtn = document.getElementById('downloadMergedBtn');
const fileSizeDisplay = document.getElementById('fileSizeDisplay');
const mergedSizeDisplay = document.getElementById('mergedSizeDisplay');
const tabOriginal = document.getElementById('tabOriginal');
const tabMerged = document.getElementById('tabMerged');
const renderAnotherBtn = document.getElementById('renderAnotherBtn');

// Audio merger elements
const audioDropArea = document.getElementById('audioDropArea');
const audioFileInput = document.getElementById('audioFileInput');
const audioFileNameDisplay = document.getElementById('audioFileNameDisplay');
const mergeAudioBtn = document.getElementById('mergeAudioBtn');
const mergeStatus = document.getElementById('mergeStatus');

let activeEventSource = null;
let currentJobId = null;
let currentJobData = null;
let selectedAudioFile = null;

// AUTO-PURGE: When tab is closed or refreshed, wipe server files immediately!
window.addEventListener('beforeunload', () => {
  if (currentJobId) {
    navigator.sendBeacon('/api/cleanup/' + currentJobId);
  }
});

window.addEventListener('pagehide', () => {
  if (currentJobId) {
    navigator.sendBeacon('/api/cleanup/' + currentJobId);
  }
});

// Trigger file browse
browseTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

// Drag & drop handlers for ZIP
['dragenter', 'dragover'].forEach(name => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach(name => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  });
});

dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0 && files[0].name.endsWith('.zip')) {
    handleUpload(files[0]);
  } else {
    alert('Please upload a valid .zip file!');
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleUpload(fileInput.files[0]);
  }
});

// Log Drawer Toggle
let logOpen = true;
logToggle.addEventListener('click', () => {
  logOpen = !logOpen;
  logContainer.style.display = logOpen ? 'block' : 'none';
  logToggle.querySelector('.toggle-icon').textContent = logOpen ? '▼' : '▶';
});

// Upload and listen to SSE
async function handleUpload(file) {
  // If there was a previous job, clean it up
  if (currentJobId) {
    fetch('/api/cleanup/' + currentJobId, { method: 'POST' }).catch(() => {});
  }

  uploadSection.className = 'section-hidden';
  renderSection.className = 'section-active';
  resultSection.className = 'section-hidden';

  activeFileName.textContent = file.name;
  renderStatus.textContent = 'Uploading ephemeral package...';
  percentDisplay.textContent = '0%';
  progressBar.style.width = '0%';
  stageDisplay.textContent = 'Uploading...';
  frameDisplay.textContent = '-- / --';
  logContainer.innerHTML = '<div class="log-line text-muted">Starting ephemeral 8-Core session...</div>';

  selectedAudioFile = null;
  audioFileInput.value = '';
  audioFileNameDisplay.innerHTML = 'Drop audio file here or <span class="highlight">browse</span>';
  mergeAudioBtn.disabled = true;
  mergeStatus.textContent = '';
  tabMerged.style.display = 'none';
  downloadMergedBtn.style.display = 'none';
  tabOriginal.className = 'video-tab-btn active';

  const formData = new FormData();
  formData.append('projectZip', file);

  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Upload failed');
    }

    currentJobId = data.jobId;
    listenToProgress(data.jobId);
  } catch (err) {
    renderStatus.textContent = 'Failed to start render';
    stageDisplay.textContent = err.message;
    alert('Upload error: ' + err.message);
  }
}

function listenToProgress(jobId) {
  if (activeEventSource) {
    activeEventSource.close();
  }

  activeEventSource = new EventSource('/api/progress/' + jobId);

  activeEventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    currentJobData = data;

    if (data.status) {
      renderStatus.textContent = data.status.toUpperCase();
    }
    if (data.stage) {
      stageDisplay.textContent = data.stage;
    }
    if (data.progress !== undefined) {
      percentDisplay.textContent = data.progress + '%';
      progressBar.style.width = data.progress + '%';
    }
    if (data.framesRendered && data.totalFrames) {
      frameDisplay.textContent = `${data.framesRendered} / ${data.totalFrames}`;
    }

    if (data.newLog) {
      appendLog(data.newLog);
    } else if (data.logs && data.logs.length > 0 && logContainer.children.length <= 1) {
      logContainer.innerHTML = '';
      data.logs.forEach(appendLog);
    }

    if (data.status === 'completed') {
      activeEventSource.close();
      showResult(data);
    } else if (data.status === 'failed') {
      activeEventSource.close();
      renderStatus.textContent = 'Error: ' + (data.error || 'Failed');
      stageDisplay.textContent = 'Rendering terminated with error.';
    }
  };
}

function appendLog(line) {
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = line;
  logContainer.appendChild(div);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function showResult(job) {
  renderSection.className = 'section-hidden';
  resultSection.className = 'section-active';

  setVideoSource(job.videoPath);

  downloadOriginalBtn.href = job.downloadUrl;
  fileSizeDisplay.textContent = job.fileSizeMb || '--';
}

function setVideoSource(url) {
  videoPlayer.src = url + '?t=' + Date.now();
  videoPlayer.load();
  videoPlayer.play().catch(() => {});
}

// Switch tabs between original and merged video
tabOriginal.addEventListener('click', () => {
  if (currentJobData) {
    tabOriginal.className = 'video-tab-btn active';
    tabMerged.className = 'video-tab-btn';
    setVideoSource(currentJobData.videoPath);
  }
});

tabMerged.addEventListener('click', () => {
  if (currentJobData?.mergedVideoPath) {
    tabMerged.className = 'video-tab-btn active';
    tabOriginal.className = 'video-tab-btn';
    setVideoSource(currentJobData.mergedVideoPath);
  }
});

// Audio Drag & Drop
['dragenter', 'dragover'].forEach(name => {
  audioDropArea.addEventListener(name, (e) => {
    e.preventDefault();
    audioDropArea.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach(name => {
  audioDropArea.addEventListener(name, (e) => {
    e.preventDefault();
    audioDropArea.classList.remove('drag-over');
  });
});

audioDropArea.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    selectAudio(files[0]);
  }
});

audioFileInput.addEventListener('change', () => {
  if (audioFileInput.files.length > 0) {
    selectAudio(audioFileInput.files[0]);
  }
});

function selectAudio(file) {
  selectedAudioFile = file;
  audioFileNameDisplay.innerHTML = `🎵 <strong>${file.name}</strong> (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
  mergeAudioBtn.disabled = false;
  mergeStatus.textContent = 'Audio ready to merge';
}

// Audio Merge Trigger
mergeAudioBtn.addEventListener('click', async () => {
  if (!selectedAudioFile || !currentJobId) return;

  mergeAudioBtn.disabled = true;
  mergeStatus.textContent = 'Merging audio with FFmpeg...';

  const mode = document.querySelector('input[name="audioMode"]:checked')?.value || 'mix';
  const formData = new FormData();
  formData.append('audio', selectedAudioFile);
  formData.append('mode', mode);

  try {
    const res = await fetch('/api/merge-audio/' + currentJobId, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Audio merge failed');
    }

    mergeStatus.textContent = '✅ Merged in 0.5s!';
    currentJobData.mergedVideoPath = data.mergedVideoUrl;
    currentJobData.mergedDownloadUrl = data.downloadUrl;
    currentJobData.mergedSizeMb = data.sizeMb;

    tabMerged.style.display = 'inline-block';
    tabMerged.className = 'video-tab-btn active';
    tabOriginal.className = 'video-tab-btn';
    mergedSizeDisplay.textContent = data.sizeMb;

    downloadMergedBtn.style.display = 'inline-flex';
    downloadMergedBtn.href = data.downloadUrl;

    setVideoSource(data.mergedVideoUrl);

  } catch (err) {
    mergeStatus.textContent = '❌ ' + err.message;
    mergeAudioBtn.disabled = false;
  }
});

// Clean up and start new render
renderAnotherBtn.addEventListener('click', () => {
  if (currentJobId) {
    fetch('/api/cleanup/' + currentJobId, { method: 'POST' }).catch(() => {});
    currentJobId = null;
  }
  fileInput.value = '';
  resultSection.className = 'section-hidden';
  uploadSection.className = 'section-active';
});
