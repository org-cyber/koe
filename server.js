const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");

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

// Split on blank lines (paragraphs). Each paragraph becomes one MP3.
// Falls back to splitting on sentence boundaries if a paragraph is >3000 chars
// (edge-tts can struggle with very long single blocks).
function splitText(text) {
  const paragraphs = text
    .split(/\n\s*\n/)           // blank-line paragraph breaks
    .map(p => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const parts = [];
  for (const para of paragraphs) {
    if (para.length <= 3000) {
      parts.push(para);
    } else {
      // split on sentence boundaries
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
//
//  The Dockerfile is: python:3.11-slim + edge-tts, ENTRYPOINT ["edge-tts"]
//  So every `docker run edge-tts ...` just forwards args to the edge-tts CLI.
//
//  We use a per-job subdirectory inside ./output/ so concurrent jobs
//  never clobber each other's files.
//
//  The volume mount maps the host's absolute output dir → /app/output
//  inside the container, matching the WORKDIR set in the Dockerfile.
// ─────────────────────────────────────────────

function formatRate(rate) {
  // edge-tts --rate expects e.g. "+20%" or "-15%". Default is 1.0 (0%).
  const pct = Math.round((parseFloat(rate) - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function formatPitch(pitch) {
  // edge-tts --pitch expects e.g. "+5Hz" or "-10Hz". Default is 0.
  const hz = parseInt(pitch, 10);
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

function runDockerTTS({ text, voice, hostOutputDir, containerFilePath, rate = 1, pitch = 0 }) {
  return new Promise((resolve, reject) => {
    // Escape double-quotes inside the text for safe shell injection.
    const safeText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const rateFlag  = `--rate "${formatRate(rate)}"`;
    const pitchFlag = `--pitch "${formatPitch(pitch)}"`;

    // Mount the per-job host dir as /app/output inside the container.
    const cmd = [
      "docker run --rm",
      `-v "${hostOutputDir}:/app/output"`,
      "edge-tts",
      `--voice ${voice}`,
      rateFlag,
      pitchFlag,
      `--text "${safeText}"`,
      `--write-media "${containerFilePath}"`,
    ].join(" \\\n  ");

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[TTS ERROR] voice=${voice}\n${stderr}`);
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
    archive.directory(sourceDir, false);   // add all files in dir, no subfolder in zip
    archive.finalize();
  });
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// POST /tts  — submit a generation job, returns jobId immediately
app.post("/tts", async (req, res) => {
  const { text, voice = "en-US-GuyNeural", rate = 1, pitch = 0 } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  const jobId      = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir     = path.join(OUTPUT_DIR, jobId);   // per-job isolation
  const zipPath    = path.join(__dirname, `${jobId}.zip`);
  const parts      = splitText(text);
  const wordCount  = text.trim().split(/\s+/).length;

  fs.mkdirSync(jobDir, { recursive: true });

  const job = {
    id:         jobId,
    status:     "processing",
    voice,
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

  // ── Async generation (does not block the HTTP response) ──────────────
  setImmediate(async () => {
    try {
      for (let i = 0; i < parts.length; i++) {
        // Path *inside* the container. The container sees jobDir mounted as /app/output.
        const containerFile = `/app/output/part_${String(i + 1).padStart(3, "0")}.mp3`;

        await runDockerTTS({
          text:            parts[i],
          voice,
          hostOutputDir:   jobDir,          // mounted into container
          containerFilePath: containerFile,
          rate,
          pitch,
        });

        // Update progress
        job.status    = `generating (${i + 1}/${parts.length})`;
        job.progress  = Math.round(((i + 1) / parts.length) * 100);
        saveJob(job);
      }

      job.status = "zipping";
      saveJob(job);

      await createZip(jobDir, zipPath);

      // Clean up per-job MP3 dir (the zip is the deliverable)
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

      // clean up dir on failure too
      if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  });
});

// GET /job/:id  — poll job status
app.get("/job/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// GET /jobs  — list all jobs (newest first)
app.get("/jobs", (req, res) => {
  const jobs = loadJobs().reverse();
  res.json(jobs);
});

// GET /download/:id  — stream the ZIP
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

// DELETE /job/:id  — delete job and its zip
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

// POST /tts-preview  — generate a short voice sample, stream MP3 back directly
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
  ].join(" \\\n  ");

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
    stream.on("close", () => {
      // clean up preview file after sending
      fs.unlink(previewPath, () => {});
    });
    stream.on("error", () => {
      fs.unlink(previewPath, () => {});
    });
  });
});

// GET /health  — quick health check
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
