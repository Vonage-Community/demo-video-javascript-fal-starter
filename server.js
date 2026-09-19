import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Vonage } from '@vonage/server-sdk';
import path from 'path';
import { fileURLToPath } from 'url';

// Reconstruct __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const codespaceUrl = process.env.CODESPACE_URL;

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Check for required env vars
if (!process.env.VONAGE_APPLICATION_ID || !process.env.VONAGE_PRIVATE_KEY || !process.env.FAL_KEY) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

// Initialize Vonage SDK
const vonage = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_PRIVATE_KEY
});

// In-memory store for room sessions (for hackathon simplicity)
const roomToSessionIdDictionary = {};
const sessionState = {};

// Endpoint to generate/retrieve Vonage Sessions and Tokens
app.get('/room/:name', async (req, res) => {
  const roomName = req.params.name;

  try {
    let sessionId;
    if (roomToSessionIdDictionary[roomName]) {
      sessionId = roomToSessionIdDictionary[roomName];
    } else {
      const session = await vonage.video.createSession({ mediaMode: 'routed' });
      sessionId = session.sessionId;
      roomToSessionIdDictionary[roomName] = sessionId;
      sessionState[sessionId] = {};
    }

    const token = vonage.video.generateClientToken(sessionId, { role: 'publisher' });

    res.json({
      applicationId: process.env.VONAGE_APPLICATION_ID,
      sessionId,
      token
    });
  } catch (err) {
    console.error("Error generating session:", err);
    res.status(500).json({ error: 'Error generating Vonage session' });
  }
});

// Redirect /session to a specific room named "session"
app.get('/session', function (req, res) {
  res.redirect('/room/session');
});

// fal.ai Token Endpoint
app.post('/api/fal/token', express.json(), async (req, res) => {
  // Read the requested app from the frontend, default to Lucy if missing
  const targetApp = req.body.app || 'decart/lucy-2-5/realtime';
  console.log("Requested target app:", targetApp);

  try {
    const response = await fetch('https://rest.fal.ai/tokens/realtime', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app: targetApp,
        duration: 120
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("FAL API 422 Error Details:", errorText);
      throw new Error(`fal API returned ${response.status}`);
    }

    const data = await response.json();
    console.log("Fetched token data:", data);
    res.json({ token: data });
  } catch (error) {
    console.error("Token error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});


// Broadcast Endpoints
app.post('/api/broadcast/start', express.json(), async (req, res) => {
  const { sessionId } = req.body;
  try {
    const broadcast = await vonage.video.startBroadcast(sessionId, {
      resolution: "1280x720",
      outputs: {
        hls: {
          // dvr: true,
          // lowLatency: true
        },
        rtmp: [
          {
            id: "youtube_stream",
            serverUrl: "rtmp://a.rtmp.youtube.com/live2",
            streamName: "YOUR_YOUTUBE_STREAM_KEY"
          },
          {
            id: "facebook_stream",
            serverUrl: "rtmps://live-api-s.facebook.com:443/rtmp/",
            streamName: "YOUR_FACEBOOK_STREAM_KEY"
          },
          {
            id: "linkedin_stream",
            serverUrl: "rtmps://ingest.linkedin.com:443/rtmp/",
            streamName: "YOUR_LINKEDIN_STREAM_KEY"
          },
          {
            id: "twitch_stream",
            serverUrl: "rtmp://live.twitch.tv/app",
            streamName: "YOUR_TWITCH_STREAM_KEY"
          }
        ]
      }
    });

    // Save active broadcast ID to state
    if (!sessionState[sessionId]) sessionState[sessionId] = {};
    sessionState[sessionId].broadcastId = broadcast.id;
    sessionState[sessionId].hlsUrl = broadcast.broadcastUrls.hls;

    console.log("Broadcast started:", broadcast);
    res.json(broadcast);
  } catch (error) {
    console.error("Broadcast Error:", error);
    res.status(500).json({ error: "Failed to start Broadcast" });
  }
});

app.post('/api/broadcast/stop', express.json(), async (req, res) => {
  try {
    await vonage.video.stopBroadcast(req.body.broadcastId);
    sessionState[req.body.sessionId].broadcastId = null;
    sessionState[req.body.sessionId].hlsUrl = null;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to stop broadcast" });
  }
});

// Endpoint for the Watch page to fetch the active HLS URL
app.get('/api/broadcast/hls/:roomName', (req, res) => {
  const sessionId = roomToSessionIdDictionary[req.params.roomName];
  if (sessionId && sessionState[sessionId] && sessionState[sessionId].hlsUrl) {
    res.json({ hlsUrl: sessionState[sessionId].hlsUrl });
  } else {
    res.status(404).json({ error: "Broadcast is not currently live." });
  }
});

// Archive Endpoints (Manual Mode)
app.post('/api/archive/start', express.json(), async (req, res) => {
  console.log("Starting archive for session:", req.body.sessionId);
  try {
    const archive = await vonage.video.startArchive(req.body.sessionId, {
      name: 'Hackbarna Archive',
      // streamMode: 'manual' 
    });
    // Save active archive ID to state
    if (!sessionState[req.body.sessionId]) sessionState[req.body.sessionId] = {};
    sessionState[req.body.sessionId].archiveId = archive.id;

    console.log("Archive Data:", archive);
    res.json(archive);
  } catch (error) {
    console.log("Archive Error:", error);
    res.status(500).json({ error: "Failed to start archive" });
  }
});

app.post('/api/archive/stop', express.json(), async (req, res) => {
  console.log("Stopping archive for archiveId:", req.body);
  try {
    const archive = await vonage.video.stopArchive(req.body.archiveId);
    sessionState[req.body.sessionId].archiveId = null;
    console.log("Stopped archive:", archive);
    res.json({ success: true, archive });
  } catch (error) {
    console.log("Failed to stop archive:", error);
    res.status(500).json({ error: "Failed to stop archive" });
  }
});

// Archive Status Webhook (Triggered by Vonage)
app.post('/api/archive/status', express.json(), async (req, res) => {
  res.status(200).send('OK'); // Acknowledge instantly so Vonage doesn't retry

  const archiveEvent = req.body;
  if (archiveEvent.status === 'available') {
    try {
      // Send a signal directly to the broadcaster's UI containing the download link [INDEX]
      await vonage.video.sendSignal({
        type: 'archiveAvailable',
        data: archiveEvent.url
      },
        archiveEvent.sessionId
      );
      console.log("Sent archive download signal to broadcaster.");
    } catch (err) {
      console.error("Failed to send archive signal:", err);
    }
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});