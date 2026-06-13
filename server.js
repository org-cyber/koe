const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");
const PIPER_IMAGE = "piper-tts";
const PIPER_MODEL = "en_US-lessac-medium.onnx";
const PIPER_ROOT = path.join(process.env.HOME, "piper-docker");
const PIPER_MODELS_DIR = path.join(PIPER_ROOT, "models");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─────────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, "output");
const JOBS_FILE  = path.join(__dirname, "jobs.json");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(JOBS_FILE))  fs.writeFileSync(JOBS_FILE, "[]");

// ─────────────────────────────────────────────
//  JOB STORE HELPERS
// ─────────────────────────────────────────────

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveJob(updatedJob) {
  const jobs = loadJobs();
  const idx  = jobs.findIndex(j => j.id === updatedJob.id);
  if (idx !== -1) jobs[idx] = updatedJob;
  else jobs.push(updatedJob);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function getJob(id) {
  return loadJobs().find(j => j.id === id) || null;
}

// ─────────────────────────────────────────────
//  TEXT SPLITTING
// ─────────────────────────────────────────────

function splitText(text) {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const parts = [];
  for (const para of paragraphs) {
    if (para.length <= 3000) {
      parts.push(para);
    } else {
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      let chunk = "";
      for (const s of sentences) {
        if ((chunk + s).length > 3000) {
          if (chunk) parts.push(chunk.trim());
          chunk = s;
        } else {
          chunk += s;
        }
      }
      if (chunk.trim()) parts.push(chunk.trim());
    }
  }
  return parts;
}

// ─────────────────────────────────────────────
//  EDGE-TTS VIA DOCKER
// ─────────────────────────────────────────────

function formatRate(rate) {
  const pct = Math.round((parseFloat(rate) - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function formatPitch(pitch) {
  const hz = parseInt(pitch, 10);
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

function runDockerTTS({ text, voice, hostOutputDir, containerFilePath, rate = 1, pitch = 0 }) {
  return new Promise((resolve, reject) => {
    const safeText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const rateFlag  = `--rate "${formatRate(rate)}"`;
    const pitchFlag = `--pitch "${formatPitch(pitch)}"`;

    const cmd = [
      "docker run --rm",
      `-v "${hostOutputDir}:/app/output"`,
      "edge-tts",
      `--voice ${voice}`,
      rateFlag,
      pitchFlag,
      `--text "${safeText}"`,
      `--write-media "${containerFilePath}"`,
    ].join(" \\");

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[TTS ERROR] voice=${voice}\n${stderr}`);
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
  });
}

function runPiperTTS({ text, hostOutputDir, containerFilePath }) {
  return new Promise((resolve, reject) => {
    const safeText = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$");

    const cmd = [
      `echo "${safeText}" |`,
      "docker run --rm -i",
      `-v "${PIPER_MODELS_DIR}:/models"`,
      `-v "${hostOutputDir}:/output"`,
      PIPER_IMAGE,
      `--model /models/${PIPER_MODEL}`,
      `--output_file ${containerFilePath}`,
    ].join(" \\");

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        console.error("[PIPER ERROR]", stderr);
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
  });
}

// ─────────────────────────────────────────────
//  ZIP HELPER
// ─────────────────────────────────────────────

function createZip(sourceDir, destPath) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// POST /tts
app.post("/tts", async (req, res) => {
  const {
    text,
    voice = "en-US-GuyNeural",
    rate = 1,
    pitch = 0,
    engine = "edge"
  } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  const jobId      = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir     = path.join(OUTPUT_DIR, jobId);
  const zipPath    = path.join(__dirname, `${jobId}.zip`);
  const parts      = splitText(text);
  const wordCount  = text.trim().split(/\s+/).length;

  fs.mkdirSync(jobDir, { recursive: true });

  const job = {
    id:         jobId,
    status:     "processing",
    voice,
    engine,
    rate:       parseFloat(rate),
    pitch:      parseInt(pitch, 10),
    parts:      parts.length,
    wordCount,
    createdAt:  new Date().toISOString(),
    completedAt: null,
    file:       null,
    error:      null,
  };

  saveJob(job);
  res.json({ jobId, parts: parts.length, wordCount });

  setImmediate(async () => {
    try {
      for (let i = 0; i < parts.length; i++) {
        let containerFile;

        if (engine === "edge") {
          containerFile = `/app/output/part_${String(i + 1).padStart(3, "0")}.mp3`;
          await runDockerTTS({
            text: parts[i],
            voice,
            hostOutputDir: jobDir,
            containerFilePath: containerFile,
            rate,
            pitch,
          });
        } else if (engine === "piper") {
          containerFile = `/output/part_${String(i + 1).padStart(3, "0")}.wav`;
          await runPiperTTS({
            text: parts[i],
            hostOutputDir: jobDir,
            containerFilePath: containerFile,
          });
        } else {
          throw new Error("Invalid engine");
        }

        job.status = `generating (${i + 1}/${parts.length})`;
        job.progress = Math.round(((i + 1) / parts.length) * 100);
        saveJob(job);
      }

      await createZip(jobDir, zipPath);
      fs.rmSync(jobDir, { recursive: true, force: true });

      job.status      = "done";
      job.file        = `${jobId}.zip`;
      job.completedAt = new Date().toISOString();
      job.progress    = 100;
      saveJob(job);

    } catch (err) {
      console.error(`[JOB ${jobId}] failed:`, err.message);
      job.status = "failed";
      job.error  = err.message;
      saveJob(job);
      if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  });
});

// GET /job/:id
app.get("/job/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// GET /jobs
app.get("/jobs", (req, res) => {
  const jobs = loadJobs().reverse();
  res.json(jobs);
});

// GET /download/:id
app.get("/download/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "Job not ready", status: job.status });

  const filePath = path.join(__dirname, `${req.params.id}.zip`);
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: "File no longer available" });
  }

  res.download(filePath, `tts-${req.params.id}.zip`);
});

// DELETE /job/:id
app.delete("/job/:id", (req, res) => {
  const jobs    = loadJobs();
  const job     = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });

  const zipPath = path.join(__dirname, `${req.params.id}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const updated = jobs.filter(j => j.id !== req.params.id);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(updated, null, 2));

  res.json({ deleted: req.params.id });
});

// POST /tts-preview — Edge only, streams MP3 directly
app.post("/tts-preview", (req, res) => {
  const {
    voice = "en-US-GuyNeural",
    text  = "This is a preview of your selected voice.",
    rate  = 1,
    pitch = 0,
  } = req.body;

  const previewPath = path.join(__dirname, `preview-${Date.now()}.mp3`);
  const safeText    = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const cmd = [
    "docker run --rm",
    `-v "${__dirname}:/app"`,
    "edge-tts",
    `--voice ${voice}`,
    `--rate "${formatRate(rate)}"`,
    `--pitch "${formatPitch(pitch)}"`,
    `--text "${safeText}"`,
    `--write-media "/app/${path.basename(previewPath)}"`,
  ].join(" \\");

  exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
    if (err) {
      console.error("[PREVIEW ERROR]", stderr);
      return res.status(500).json({ error: "Preview generation failed", detail: stderr });
    }

    if (!fs.existsSync(previewPath)) {
      return res.status(500).json({ error: "Preview file not written" });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", "inline; filename=preview.mp3");

    const stream = fs.createReadStream(previewPath);
    stream.pipe(res);
    stream.on("close", () => { fs.unlink(previewPath, () => {}); });
    stream.on("error", () => { fs.unlink(previewPath, () => {}); });
  });
});

// POST /tts-preview-piper — Piper only, streams WAV directly
app.post("/tts-preview-piper", (req, res) => {
  const {
    voice = "en_US-lessac-medium",
    text  = "This is a preview of your selected Piper voice.",
  } = req.body;

  const previewPath = path.join(__dirname, `preview-piper-${Date.now()}.wav`);
  const safeText    = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$");

  const cmd = [
    `echo "${safeText}" |`,
    "docker run --rm -i",
    `-v "${PIPER_MODELS_DIR}:/models"`,
    `-v "${__dirname}:/output"`,
    PIPER_IMAGE,
    `--model /models/${voice}.onnx`,
    `--output_file /output/${path.basename(previewPath)}`,
  ].join(" \\");

  exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
    if (err) {
      console.error("[PIPER PREVIEW ERROR]", stderr);
      return res.status(500).json({ error: "Piper preview generation failed", detail: stderr });
    }

    if (!fs.existsSync(previewPath)) {
      return res.status(500).json({ error: "Piper preview file not written" });
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", "inline; filename=preview.wav");

    const stream = fs.createReadStream(previewPath);
    stream.pipe(res);
    stream.on("close", () => { fs.unlink(previewPath, () => {}); });
    stream.on("error", () => { fs.unlink(previewPath, () => {}); });
  });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    uptime:  Math.round(process.uptime()),
    jobs:    loadJobs().length,
    time:    new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TTS Studio server running → http://localhost:${PORT}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
});