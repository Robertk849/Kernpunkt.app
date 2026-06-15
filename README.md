# Kernpunkt Transkriptions-Dienst

Kleiner Dienst, der Audiodateien per FFmpeg auf 16 kHz Mono komprimiert, bei
Bedarf in Segmente unter dem OpenAI-25-MB-Limit teilt und jedes Segment mit
`gpt-4o-transcribe-diarize` transkribiert. Gibt den zusammengefuegten Text zurueck.

Ablauf: App (kernpunkt.app) -> dieser Dienst -> OpenAI -> Text zurueck an die App.

## Dateien
- `server.js` - der Express-Server mit dem /transcribe-Endpunkt
- `Dockerfile` - installiert Node 20 + FFmpeg
- `package.json` - Abhaengigkeiten
- `.dockerignore`

## Deploy bei Railway (Schritt fuer Schritt)

1. Lege auf github.com ein neues, leeres Repository an (z.B. "kernpunkt-transcribe"), privat.
2. Lade die vier Dateien aus diesem Ordner in das Repo (per "Add file" -> "Upload files").
3. Gehe auf railway.com, logge dich ein, "New Project" -> "Deploy from GitHub repo" -> dein Repo waehlen.
4. Railway erkennt das Dockerfile automatisch und baut den Dienst.
5. Unter "Variables" folgende Umgebungsvariablen setzen:
   - `OPENAI_API_KEY`   = dein OpenAI-Schluessel
   - `SERVICE_SECRET`   = ein selbst ausgedachtes langes Passwort (schuetzt den Endpunkt)
   - `ALLOWED_ORIGIN`   = https://kernpunkt.app
   (optional: `SEGMENT_SECONDS` = 600, `TRANSCRIBE_MODEL` = gpt-4o-transcribe-diarize)
6. Unter "Settings" -> "Networking" eine oeffentliche Domain erzeugen ("Generate Domain").
   Du bekommst eine URL wie https://kernpunkt-transcribe-production.up.railway.app
7. Teste die URL im Browser: Aufruf der Basis-URL muss {"status":"ok",...} zeigen.

Diese oeffentliche URL und das SERVICE_SECRET brauchst du danach fuer die Horizons-Prompts.

## Hinweis zur Sprecher-Trennung (Diarisierung)
Der Code nutzt das Modell `gpt-4o-transcribe-diarize` und liest aktuell das
Standard-Textfeld `.text` aus. Falls du im Protokoll echte Sprecher-Labels
("Sprecher 1: ...") moechtest, muss das Antwortformat des Modells geprueft und
ggf. ausgewertet werden - das laesst sich nach dem ersten erfolgreichen Test
gezielt ergaenzen.

## Kosten (Stand Juni 2026, zur Orientierung)
- Transkription: ca. 0,006 $ pro Minute Audio
- Railway Hobby: 5 $ / Monat Grundgebuehr (inkl. 5 $ Nutzung)
