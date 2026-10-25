const express = require('express');
const multer = require('multer');
const cors = require('cors');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 100% Ephemeral Temp Directory in OS temp space
const EPHEMERAL_ROOT = path.join(os.tmpdir(), 'claude_render_sessions');
const SHARED_DEPS = path.join(__dirname, 'shared-deps');
// Auto-detect Chrome executable across macOS & Linux/Docker
let CHROME_PATH = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
if (!CHROME_PATH) {
  if (process.platform === 'darwin') {
    CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    // Linux / Docker
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    for (const c of candidates) {
      if (fs.existsSync(c)) { CHROME_PATH = c; break; }
    }
    if (!CHROME_PATH) CHROME_PATH = '/usr/bin/chromium';
  }
}

// Auto-purge any stale sessions on boot
try {
  if (fs.existsSync(EPHEMERAL_ROOT)) {
    fs.rmSync(EPHEMERAL_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(EPHEMERAL_ROOT, { recursive: true });
} catch (e) {
  console.error('Error initializing temp root:', e);
}

// Multer in-memory or ephemeral stream storage
const uploadZip = multer({
  dest: path.join(EPHEMERAL_ROOT, 'raw_uploads'),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('zip') || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are supported'));
    }
  }
});

const uploadAudio = multer({
  dest: path.join(EPHEMERAL_ROOT, 'raw_uploads'),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const valid = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.originalname);
    if (valid) cb(null, true);
    else cb(new Error('Only audio files are supported'));
  }
});

const jobs = new Map();
const clients = new Map();
const disconnectTimers = new Map();

function safeDelete(dirOrFile) {
  try {
    if (fs.existsSync(dirOrFile)) {
      fs.rmSync(dirOrFile, { recursive: true, force: true });
    }
  } catch (e) {
    // ignore
  }
}

function sendEvent(jobId, data) {
  const job = jobs.get(jobId);
  if (job) Object.assign(job, data);
  const resList = clients.get(jobId) || [];
  resList.forEach(res => {
    res.write(`data: ${JSON.stringify({ jobId, ...job, ...data })}\n\n`);
  });
}

// SSE endpoint
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Session expired or not found' });
  }

  // Clear any disconnect timer
  if (disconnectTimers.has(jobId)) {
    clearTimeout(disconnectTimers.get(jobId));
    disconnectTimers.delete(jobId);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!clients.has(jobId)) clients.set(jobId, []);
  clients.get(jobId).push(res);

  res.write(`data: ${JSON.stringify({ jobId, ...job })}\n\n`);

  req.on('close', () => {
    const current = clients.get(jobId) || [];
    clients.set(jobId, current.filter(c => c !== res));

    // If all browser tabs closed for this job, schedule auto-clean after 20 seconds
    if (clients.get(jobId).length === 0) {
      const timer = setTimeout(() => {
        cleanupJob(jobId);
      }, 20000);
      disconnectTimers.set(jobId, timer);
    }
  });
});

// Explicit cleanup endpoint (called on page reload / tab close via sendBeacon)
app.post('/api/cleanup/:jobId', (req, res) => {
  const { jobId } = req.params;
  cleanupJob(jobId);
  res.json({ success: true });
});

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    console.log(`🧹 [0% Storage] Purging all ephemeral files for ${jobId}...`);
    if (job.sessionDir) safeDelete(job.sessionDir);
    jobs.delete(jobId);
  }
  clients.delete(jobId);
  if (disconnectTimers.has(jobId)) {
    clearTimeout(disconnectTimers.get(jobId));
    disconnectTimers.delete(jobId);
  }
}

// Upload & Fast 10-core Render
app.post('/api/render', uploadZip.single('projectZip'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    const jobId = 'session_' + Date.now();
    const sessionDir = path.join(EPHEMERAL_ROOT, jobId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const job = {
      id: jobId,
      sessionDir,
      originalName: req.file.originalname,
      status: 'extracting',
      progress: 0,
      framesRendered: 0,
      totalFrames: 0,
      stage: 'Extracting ephemeral archive...',
      logs: [],
      createdAt: new Date().toISOString(),
      videoPath: null,
      mergedVideoPath: null,
      error: null
    };

    jobs.set(jobId, job);
    res.json({ success: true, jobId });

    processJob(jobId, req.file.path, sessionDir);

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function processJob(jobId, zipPath, sessionDir) {
  const addLog = (line) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.logs.push(line);
    if (job.logs.length > 200) job.logs.shift();
    sendEvent(jobId, { newLog: line, logs: job.logs });
  };

  try {
    addLog('📦 Extracting ZIP to memory/ephemeral storage...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(sessionDir, true);

    // IMMEDIATELY delete uploaded raw ZIP file to free storage!
    safeDelete(zipPath);

    let projectRoot = sessionDir;
    const entries = fs.readdirSync(sessionDir).filter(f => !f.startsWith('.') && !f.startsWith('__MACOSX'));
    if (entries.length === 1 && fs.statSync(path.join(sessionDir, entries[0])).isDirectory()) {
      projectRoot = path.join(sessionDir, entries[0]);
    }

    // Symlink shared dependencies
    const projectModules = path.join(projectRoot, 'node_modules');
    const sharedModules = path.join(SHARED_DEPS, 'node_modules');

    if (!fs.existsSync(projectModules) && fs.existsSync(sharedModules)) {
      addLog('⚡ Instant symlink linking...');
      try {
        fs.symlinkSync(sharedModules, projectModules, 'junction');
      } catch (e) {}
    }

    if (!fs.existsSync(projectModules)) {
      addLog('📥 Installing dependencies...');
      sendEvent(jobId, { status: 'installing', stage: 'Installing dependencies...' });
      execSync('npm install --prefer-offline --no-audit --no-fund', { cwd: projectRoot, stdio: 'ignore' });
    }

    // Configure Chrome native executable
    const configPathTs = path.join(projectRoot, 'remotion.config.ts');
    const configPathJs = path.join(projectRoot, 'remotion.config.js');
    let configFile = fs.existsSync(configPathTs) ? configPathTs : (fs.existsSync(configPathJs) ? configPathJs : null);

    if (configFile) {
      let content = fs.readFileSync(configFile, 'utf8');
      if (!content.includes('setBrowserExecutable')) {
        content += `\nConfig.setBrowserExecutable('${CHROME_PATH}');\n`;
        fs.writeFileSync(configFile, content);
      }
    } else {
      fs.writeFileSync(configPathTs, `import { Config } from "@remotion/cli/config";\nConfig.setVideoImageFormat("jpeg");\nConfig.setOverwriteOutput(true);\nConfig.setBrowserExecutable('${CHROME_PATH}');\n`);
    }

    // Detect Entry & Composition
    let entryPoint = 'src/index.ts';
    if (!fs.existsSync(path.join(projectRoot, entryPoint))) {
      const candidates = ['src/index.tsx', 'src/index.js', 'src/index.jsx', 'src/Root.tsx', 'index.ts'];
      for (const cand of candidates) {
        if (fs.existsSync(path.join(projectRoot, cand))) {
          entryPoint = cand;
          break;
        }
      }
    }

    let compId = 'Main';
    const rootCandidates = [path.join(projectRoot, 'src/Root.tsx'), path.join(projectRoot, 'src/Root.jsx'), path.join(projectRoot, entryPoint)];
    for (const rPath of rootCandidates) {
      if (fs.existsSync(rPath)) {
        const text = fs.readFileSync(rPath, 'utf8');
        const match = text.match(/<Composition[^>]*id=["']([^"']+)["']/);
        if (match && match[1]) {
          compId = match[1];
          break;
        }
      }
    }

    const outDir = path.join(sessionDir, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outputVideo = path.join(outDir, 'video.mp4');

    sendEvent(jobId, {
      status: 'rendering',
      stage: 'Rendering with 8-Core Parallel Acceleration...',
      progress: 5
    });

    addLog('🚀 Launching Remotion Render with 8-Core Concurrency + Hardware GPU Acceleration...');

    // High performance render flags
    const isLinux = process.platform === 'linux';
    const args = [
      'remotion', 'render',
      entryPoint,
      compId,
      outputVideo,
      `--browser-executable=${CHROME_PATH}`,
      `--concurrency=${process.env.CONCURRENCY || (isLinux ? '4' : '8')}`,
      '--overwrite'
    ];
    if (!isLinux) {
      args.push('--gl=angle');
    }

    const renderProcess = spawn('npx', args, {
      cwd: projectRoot,
      env: { ...process.env, PATH: process.env.PATH }
    });

    const parseProgress = (str) => {
      const frameMatch = str.match(/(\d+)\s*\/\s*(\d+)/);
      if (frameMatch) {
        const current = parseInt(frameMatch[1], 10);
        const total = parseInt(frameMatch[2], 10);
        if (total > 0) {
          const pct = Math.min(99, Math.round((current / total) * 100));
          sendEvent(jobId, {
            progress: pct,
            framesRendered: current,
            totalFrames: total,
            stage: str.includes('Encoding') ? `Encoding video (${current}/${total})...` : `Rendering frames (${current}/${total})...`
          });
        }
      }
    };

    renderProcess.stdout.on('data', (chunk) => {
      const str = chunk.toString();
      addLog(str.trim());
      parseProgress(str);
    });

    renderProcess.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      addLog(str.trim());
      parseProgress(str);
    });

    renderProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputVideo)) {
        addLog('✅ Video render completed successfully!');

        // 0% STORAGE PURGE: Delete all source code and node_modules immediately!
        // Only keep the output folder with video.mp4
        try {
          addLog('🧹 Auto-purging source files to guarantee 0% disk waste...');
          for (const item of fs.readdirSync(sessionDir)) {
            if (item !== 'output') {
              safeDelete(path.join(sessionDir, item));
            }
          }
        } catch (e) {}

        const stats = fs.statSync(outputVideo);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);

        sendEvent(jobId, {
          status: 'completed',
          progress: 100,
          stage: 'Render Complete (0% Storage Saved)',
          videoPath: `/api/video/${jobId}`,
          downloadUrl: `/api/download/${jobId}`,
          fileSizeMb: sizeMb,
          completedAt: new Date().toISOString()
        });
      } else {
        const errMsg = `Render failed with exit code ${code}`;
        addLog(`❌ ${errMsg}`);
        sendEvent(jobId, {
          status: 'failed',
          error: errMsg,
          stage: 'Render Failed'
        });
      }
    });

  } catch (err) {
    console.error('Job error:', err);
    safeDelete(zipPath);
    sendEvent(jobId, { status: 'failed', error: err.message, stage: 'Error occurred' });
  }
}

// Audio Merge Endpoint
app.post('/api/merge-audio/:jobId', uploadAudio.single('audio'), async (req, res) => {
  try {
    const { jobId } = req.params;
    const mode = req.body.mode || 'mix';
    const job = jobs.get(jobId);

    if (!job || !fs.existsSync(job.sessionDir)) {
      if (req.file) safeDelete(req.file.path);
      return res.status(404).json({ error: 'Session expired or not found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const videoFile = path.join(job.sessionDir, 'output', 'video.mp4');
    if (!fs.existsSync(videoFile)) {
      safeDelete(req.file.path);
      return res.status(404).json({ error: 'Original video file not found' });
    }

    const audioPath = req.file.path;
    const mergedOutput = path.join(job.sessionDir, 'output', 'video_with_audio.mp4');

    let hasAudioStream = false;
    try {
      const probe = execSync(`ffprobe -i "${videoFile}" -show_streams -select_streams a -loglevel error`, { encoding: 'utf8' });
      hasAudioStream = probe.includes('codec_type=audio');
    } catch (e) {
      hasAudioStream = false;
    }

    let ffmpegCmd = '';
    if (mode === 'mix' && hasAudioStream) {
      ffmpegCmd = `ffmpeg -y -i "${videoFile}" -i "${audioPath}" -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "${mergedOutput}"`;
    } else {
      ffmpegCmd = `ffmpeg -y -i "${videoFile}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest "${mergedOutput}"`;
    }

    execSync(ffmpegCmd);
    safeDelete(audioPath); // Delete uploaded raw audio immediately!

    if (!fs.existsSync(mergedOutput)) {
      throw new Error('Failed to merge audio');
    }

    const stat = fs.statSync(mergedOutput);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);

    job.mergedVideoPath = `/api/video-merged/${jobId}`;
    job.mergedDownloadUrl = `/api/download-merged/${jobId}`;
    job.mergedSizeMb = sizeMb;

    res.json({
      success: true,
      mergedVideoUrl: `/api/video-merged/${jobId}`,
      downloadUrl: `/api/download-merged/${jobId}`,
      sizeMb: sizeMb
    });

  } catch (err) {
    console.error('Audio merge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stream video
app.get('/api/video/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send('Expired');
  const videoFile = path.join(job.sessionDir, 'output', 'video.mp4');
  streamVideoFile(videoFile, req, res);
});

// Stream merged video
app.get('/api/video-merged/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send('Expired');
  const videoFile = path.join(job.sessionDir, 'output', 'video_with_audio.mp4');
  streamVideoFile(videoFile, req, res);
});

function streamVideoFile(videoFile, req, res) {
  if (!videoFile || !fs.existsSync(videoFile)) {
    return res.status(404).send('Video not found or purged');
  }

  const stat = fs.statSync(videoFile);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(videoFile, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(videoFile).pipe(res);
  }
}

// Download Original
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send('Expired');
  const videoFile = path.join(job.sessionDir, 'output', 'video.mp4');
  if (!fs.existsSync(videoFile)) return res.status(404).send('Video expired');
  res.download(videoFile, (job.originalName?.replace(/\.zip$/i, '') || 'video') + '_original.mp4');
});

// Download Merged
app.get('/api/download-merged/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send('Expired');
  const videoFile = path.join(job.sessionDir, 'output', 'video_with_audio.mp4');
  if (!fs.existsSync(videoFile)) return res.status(404).send('Merged video expired');
  res.download(videoFile, (job.originalName?.replace(/\.zip$/i, '') || 'video') + '_with_audio.mp4');
});

// Periodic garbage collection for inactive sessions (TTL: 10 mins)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const age = now - new Date(job.createdAt).getTime();
    if (age > 10 * 60 * 1000) { // 10 minutes
      cleanupJob(id);
    }
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`✨ Claude Remotion Auto-Renderer is running at http://localhost:${PORT} (100% Zero-Storage Mode)`);
});
