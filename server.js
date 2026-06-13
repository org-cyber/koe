const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");

const app = express();

app.use(cors());
app.use(express.json());

// ---------------- STORAGE ----------------
const OUTPUT_DIR = path.join(__dirname, "output");
const JOBS_FILE = path.join(__dirname, "jobs.json");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, "[]");

// ---------------- HELPERS ----------------
function loadJobs() {
  return JSON.parse(fs.readFileSync(JOBS_FILE));
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function splitText(text) {
  return text
    .split(/\n+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function runDockerTTS({ text, voice, filePath }) {
  return new Promise((resolve, reject) => {
    const cmd = `
docker run --rm \
  -v ${OUTPUT_DIR}:/app/output \
  edge-tts \
  --voice ${voice} \
  --text "${text.replace(/"/g, '\\"')}" \
  --write-media ${filePath}
`;

    exec(cmd, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------- ROUTES ----------------

// CREATE JOB (returns jobId immediately)
app.post("/tts", async (req, res) => {
  const text = req.body.text;
  const voice = req.body.voice || "en-US-GuyNeural";

  if (!text) return res.status(400).send("No text provided");

  const jobId = Date.now().toString();

  const job = {
    id: jobId,
    status: "processing",
    voice,
    createdAt: new Date().toISOString()
  };

  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);

  res.json({ jobId });

  // async processing (don’t block request)
  setImmediate(async () => {
    try {
      const parts = splitText(text);

      // clear old files
      fs.readdirSync(OUTPUT_DIR).forEach(f =>
        fs.unlinkSync(path.join(OUTPUT_DIR, f))
      );

      job.status = "generating";
      saveJobs(loadJobs());

      // generate audio
      for (let i = 0; i < parts.length; i++) {
        const filePath = `/app/output/${jobId}_part_${i + 1}.mp3`;

        await runDockerTTS({
          text: parts[i],
          voice,
          filePath
        });
      }

      job.status = "zipping";
      saveJobs(loadJobs());

      // create ZIP
      const zipPath = path.join(__dirname, `${jobId}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip");

      archive.pipe(output);
      archive.directory(OUTPUT_DIR, false);

      await archive.finalize();

      output.on("close", () => {
        job.status = "done";
        job.file = `${jobId}.zip`;
        saveJobs(loadJobs());
      });

    } catch (err) {
      console.error(err);
      job.status = "failed";
      saveJobs(loadJobs());
    }
  });
});

// CHECK JOB STATUS
app.get("/job/:id", (req, res) => {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === req.params.id);

  if (!job) return res.status(404).send("Not found");

  res.json(job);
});

// DOWNLOAD RESULT
app.get("/download/:id", (req, res) => {
  const filePath = path.join(__dirname, `${req.params.id}.zip`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not ready");
  }

  res.download(filePath);
});

// VOICE PREVIEW
app.post("/tts-preview", (req, res) => {
  const voice = req.body.voice || "en-US-GuyNeural";

  const cmd = `
docker run --rm \
  -v ${__dirname}:/app \
  edge-tts \
  --voice ${voice} \
  --text "This is a preview of your selected voice." \
  --write-media /app/preview.mp3
`;

  exec(cmd, (err) => {
    if (err) return res.status(500).send("Preview failed");

    res.download(path.join(__dirname, "preview.mp3"));
  });
});

// ---------------- ST[118;1:3uART ----------------
app.listen(3000, () => {
  console.log("SaaS TTS running on http://localhost:3000");
});
