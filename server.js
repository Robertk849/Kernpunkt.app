// Kernpunkt Transkriptions-Dienst
// Nimmt eine Audiodatei entgegen, komprimiert sie mit FFmpeg auf 16 kHz Mono,
// teilt sie bei Bedarf in Segmente unter dem OpenAI-25-MB-Limit, transkribiert
// jedes Segment mit gpt-4o-transcribe-diarize und gibt den zusammengefuegten Text zurueck.

import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import OpenAI from "openai";

const app = express();

// ---- Konfiguration ueber Umgebungsvariablen ----
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERVICE_SECRET = process.env.SERVICE_SECRET; // gemeinsames Geheimnis zum Schutz des Endpunkts
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // z.B. https://kernpunkt.app
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe-diarize";
const SEGMENT_SECONDS = parseInt(process.env.SEGMENT_SECONDS || "600", 10); // 10-Minuten-Segmente

if (!OPENAI_API_KEY) {
  console.error("FEHLER: Umgebungsvariable OPENAI_API_KEY fehlt.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Upload in ein temporaeres Verzeichnis, max. 200 MB Rohdatei
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ---- CORS ----
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Service-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Direkter OpenAI-Transkriptionsaufruf (SDK-unabhaengig) ----
// Sendet das Audiosegment per multipart/form-data direkt an die API.
// Dadurch sind chunking_strategy und response_format garantiert dabei,
// egal welche openai-SDK-Version installiert ist.
async function transcribeSegment(segPath, isDiarize) {
  const fileBuffer = await fsp.readFile(segPath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: "audio/mpeg" }), path.basename(segPath));
  form.append("model", TRANSCRIBE_MODEL);
  form.append("language", "de");
  if (isDiarize) {
    form.append("chunking_strategy", "auto");
    form.append("response_format", "diarized_json");
  }

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + OPENAI_API_KEY },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(resp.status + " " + errText);
  }
  return resp.json();
}

// ---- Hilfsfunktion: Transkriptions-Ergebnis in Text umwandeln ----
// Unterstuetzt sowohl das Standard-Format (.text) als auch das diarisierte
// Format (Segmente mit Sprecher-Labels). Faellt bei Bedarf auf reinen Text zurueck.
function formatTranscriptResult(result) {
  if (!result) return "";

  // Diarisiertes Format: Array von Segmenten mit "speaker" und "text"
  const segs = result.segments || result.diarized_segments;
  if (Array.isArray(segs) && segs.length > 0 && segs[0] && segs[0].text !== undefined) {
    const lines = [];
    let lastSpeaker = null;
    for (const s of segs) {
      const speaker = s.speaker !== undefined && s.speaker !== null ? String(s.speaker) : null;
      const segText = (s.text || "").trim();
      if (!segText) continue;
      if (speaker && speaker !== lastSpeaker) {
        lines.push(`\nSprecher ${speaker}: ${segText}`);
        lastSpeaker = speaker;
      } else {
        lines.push(segText);
      }
    }
    const joined = lines.join(" ").replace(/\n /g, "\n").trim();
    if (joined) return joined;
  }

  // Standard-Format
  return (result.text ? result.text : "").trim();
}

// ---- Hilfsfunktion: FFmpeg ausfuehren ----
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg fehlgeschlagen: " + stderr.slice(-500)));
    });
  });
}

// ---- Health-Check ----
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "kernpunkt-transcribe" });
});

// ---- Transkriptions-Endpunkt ----
app.post("/transcribe", upload.single("file"), async (req, res) => {
  // Optionaler Schutz: gemeinsames Geheimnis pruefen
  if (SERVICE_SECRET) {
    const provided = req.header("X-Service-Secret");
    if (provided !== SERVICE_SECRET) {
      return res.status(401).json({ error: "Nicht autorisiert" });
    }
  }

  if (!req.file) {
    return res.status(400).json({ error: "Keine Datei empfangen" });
  }

  const workDir = path.join(os.tmpdir(), "kp-" + randomUUID());
  const inputPath = req.file.path;

  try {
    await fsp.mkdir(workDir, { recursive: true });

    // Schritt 1: Auf 16 kHz Mono 32 kbps komprimieren UND in Segmente teilen.
    // FFmpeg erzeugt eigenstaendige, gueltige MP3-Dateien pro Segment.
    const segmentPattern = path.join(workDir, "seg_%03d.mp3");
    await runFfmpeg([
      "-i", inputPath,
      "-ac", "1",            // Mono
      "-ar", "16000",        // 16 kHz (optimal fuer Sprache)
      "-b:a", "32k",         // niedrige Bitrate, fuer Sprache ausreichend
      "-f", "segment",
      "-segment_time", String(SEGMENT_SECONDS),
      "-reset_timestamps", "1",
      "-loglevel", "error",
      segmentPattern,
    ]);

    // Segmentdateien einsammeln und sortieren
    const files = (await fsp.readdir(workDir))
      .filter((f) => f.startsWith("seg_") && f.endsWith(".mp3"))
      .sort();

    if (files.length === 0) {
      throw new Error("Keine Audiosegmente erzeugt - Datei evtl. beschaedigt oder leer.");
    }

    // Schritt 2: Jedes Segment einzeln transkribieren.
    // Wir rufen die OpenAI-Schnittstelle DIREKT per multipart/form-data auf,
    // unabhaengig von der installierten SDK-Version. So kommen chunking_strategy
    // und response_format garantiert mit an.
    const isDiarize = TRANSCRIBE_MODEL.includes("diarize");
    const parts = [];
    for (const f of files) {
      const segPath = path.join(workDir, f);
      const result = await transcribeSegment(segPath, isDiarize);
      const text = formatTranscriptResult(result);
      if (text) parts.push(text);
    }

    const transcript = parts.join("\n\n").trim();
    res.json({ text: transcript, segments: files.length });
  } catch (err) {
    console.error("[transcribe] Fehler:", err.message);
    res.status(500).json({ error: err.message || "Transkription fehlgeschlagen" });
  } finally {
    // Aufraeumen
    fsp.rm(inputPath, { force: true }).catch(() => {});
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log("Kernpunkt-Transkriptions-Dienst laeuft auf Port " + PORT);
});
