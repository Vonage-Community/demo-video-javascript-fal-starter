import { fal } from "https://esm.sh/@fal-ai/client";

const ui = {
    roomName: document.getElementById('roomName'),
    cameraBtn: document.getElementById('cameraBtn'),
    toggleAIBtn: document.getElementById('toggleAIBtn'),
    startBroadcastBtn: document.getElementById('startBroadcastBtn'),
    startArchiveBtn: document.getElementById('startArchiveBtn'),
    actionBar: document.getElementById('actionBar'),
    statusMsg: document.getElementById('statusMsg'),
    chatHistory: document.getElementById('chatHistory'),
    chatInput: document.getElementById('chatInput'),
    sendChatBtn: document.getElementById('sendChatBtn'),
    avatarBtns: document.querySelectorAll('.avatar-btn'),
    shareLinkContainer: document.getElementById('shareLinkContainer'),
    shareLinkText: document.getElementById('shareLinkText'),
    copyLinkBtn: document.getElementById('copyLinkBtn'),
    archiveLinkContainer: document.getElementById('archiveLinkContainer'),
    archiveDownloadLink: document.getElementById('archiveDownloadLink'),
    archiveTimer: document.getElementById('archiveTimer')
};

let vonageSession, vonagePublisher, falConnection, localStream, peerConnection;
let activeBroadcastId = null, activeArchiveId = null;
let isCameraRunning = false;
let isAIArmed = false;     // Tracks if the buttons are unlocked
let isGenerating = false;  // Tracks if fal.ai is actively billing/streaming
let aiCountdownInterval = null;

// Canvas Proxy Loop
const canvas = document.createElement('canvas');
canvas.width = 1280;
canvas.height = 720;
const ctx = canvas.getContext('2d');

const rawVideo = document.createElement('video');
rawVideo.autoplay = true;
rawVideo.playsInline = true;
rawVideo.muted = true;

let aiVideo = document.createElement('video');
aiVideo.autoplay = true;
aiVideo.playsInline = true;
aiVideo.muted = true;

// let renderTimeoutId;

let renderLoopId;
let isUsingVideoCallback = false;

function renderLoop() {
    if (isGenerating && aiVideo.readyState >= 2) {
        ctx.drawImage(aiVideo, 0, 0, canvas.width, canvas.height);
    } else if (isCameraRunning && rawVideo.readyState >= 2) {
        ctx.drawImage(rawVideo, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.fillStyle = '#111111';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Determine which video is actively receiving WebRTC frames
    const activeVideo = (isGenerating && aiVideo.readyState >= 2) ? aiVideo : 
                        (isCameraRunning && rawVideo.readyState >= 2) ? rawVideo : null;

    // clearTimeout(renderTimeoutId);

    // Use the native video frame callback if available (bypasses most background throttling)
    if (activeVideo && 'requestVideoFrameCallback' in activeVideo) {
        isUsingVideoCallback = true;
        renderLoopId = activeVideo.requestVideoFrameCallback(renderLoop);

        // SAFETY NET: If the video stops (e.g., timer expires and src is nulled), 
        // the callback won't fire. This 100ms timeout forces the loop to continue
        // and switch back to the raw camera.
        // renderTimeoutId = setTimeout(renderLoop, 100); 
    } else {
        isUsingVideoCallback = false;
        // Fallback for idle states or older browsers
        renderLoopId = setTimeout(renderLoop, 1000 / 30); 
    }
    // requestAnimationFrame(renderLoop);
}
renderLoop();

function setStatus(msg, error = false) {
    ui.statusMsg.innerText = msg;
    ui.statusMsg.style.color = error ? '#ff4757' : '#00ff88';
}

function appendChat(sender, message) {
    const msgEl = document.createElement('div');
    const senderEl = document.createElement('strong');
    senderEl.textContent = `${sender}: `;
    const textNode = document.createTextNode(message);
    msgEl.appendChild(senderEl);
    msgEl.appendChild(textNode);
    ui.chatHistory.appendChild(msgEl);
    ui.chatHistory.scrollTop = ui.chatHistory.scrollHeight;
}

// Controls whether avatar buttons are clickable (and signals the Watch page)
function setAvatarButtonsEnabled(enabled) {
    ui.avatarBtns.forEach(btn => btn.disabled = !enabled);
    if (vonageSession) {
        vonageSession.signal({
            type: 'aiState',
            data: JSON.stringify({ active: enabled })
        });
    }
}

// 1. Camera Toggle
ui.cameraBtn.addEventListener('click', async () => {
    if (isCameraRunning) {
        // --- STOP CAMERA ---
        if (isAIArmed) {
            isAIArmed = false;
            setAvatarButtonsEnabled(false);
            ui.toggleAIBtn.innerText = "Enable AI Features";
            ui.toggleAIBtn.classList.remove('danger');
        }
        if (isGenerating) stopAIFilter();

        if (vonagePublisher && vonageSession) {
            vonageSession.unpublish(vonagePublisher);
            vonagePublisher.destroy();
            vonagePublisher = null;
        }

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        rawVideo.srcObject = null;

        isCameraRunning = false;
        ui.cameraBtn.innerText = "Start Camera";
        ui.cameraBtn.classList.remove('danger');
        ui.toggleAIBtn.disabled = true;
        setStatus("Camera stopped.");
    } else {
        // --- START CAMERA ---
        ui.cameraBtn.disabled = true;
        const room = ui.roomName.value.trim();

        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
            rawVideo.srcObject = localStream;
            await rawVideo.play();

            const rawAudioTrack = localStream.getAudioTracks()[0];

            const proxyStream = canvas.captureStream(30);
            const proxyVideoTrack = proxyStream.getVideoTracks()[0];

            if (!vonageSession) {
                const vonageRes = await fetch(`/room/${room}`);
                const vonageData = await vonageRes.json();
                await connectVonage(vonageData, proxyVideoTrack, rawAudioTrack);
            } else {
                publishToSession(proxyVideoTrack, rawAudioTrack);
            }

            isCameraRunning = true;
            ui.cameraBtn.innerText = "Stop Camera";
            ui.cameraBtn.classList.add('danger');
            ui.cameraBtn.disabled = false;
            
            ui.toggleAIBtn.innerText = "Enable AI Features";
            ui.toggleAIBtn.disabled = false;
            ui.actionBar.style.display = 'flex';
            setStatus("Camera active.");
        } catch (err) {
            console.error(err);
            setStatus("Failed to access camera: " + err.message, true);
            ui.cameraBtn.disabled = false;
        }
    }
});

function connectVonage(data, videoTrack, audioTrack) {
    return new Promise((resolve) => {
        vonageSession = OT.initSession(data.applicationId, data.sessionId);

        vonageSession.on('signal:chat', (event) => {
            const msgData = JSON.parse(event.data);
            appendChat(msgData.sender, msgData.text);
        });

        // Listen for Viewers clicking an avatar button
        vonageSession.on('signal:avatar', (event) => {
            if (isAIArmed) {
                handleAvatarRequest(event.data, "Viewer");
            }
        });

        vonageSession.on('signal:archiveAvailable', (event) => {
            ui.archiveDownloadLink.href = event.data;
            ui.archiveLinkContainer.style.display = 'flex';
            let timeLeft = 600;
            const countdown = setInterval(() => {
                timeLeft--;
                const min = Math.floor(timeLeft / 60);
                const sec = timeLeft % 60;
                ui.archiveTimer.innerText = `Expires in: ${min}:${sec.toString().padStart(2, '0')}`;
                if (timeLeft <= 0) {
                    clearInterval(countdown);
                    ui.archiveLinkContainer.style.display = 'none';
                }
            }, 1000);
        });

        vonageSession.connect(data.token, (err) => {
            if (!err) {
                publishToSession(videoTrack, audioTrack);
                resolve();
            }
        });
    });
}

function publishToSession(videoTrack, audioTrack) {
    const customStream = new MediaStream([videoTrack, audioTrack]);
    vonagePublisher = OT.initPublisher('publisher', {
        videoSource: customStream.getVideoTracks()[0],
        audioSource: customStream.getAudioTracks()[0],
        insertMode: 'append', width: '100%', height: '100%'
    });
    vonageSession.publish(vonagePublisher);
}

// 2. AI Armed Toggle (No Billing Yet)
ui.toggleAIBtn.addEventListener('click', () => {
    if (isAIArmed) {
        // Disarm the system
        isAIArmed = false;
        ui.toggleAIBtn.innerText = "Enable AI Features";
        ui.toggleAIBtn.classList.remove('danger');
        setAvatarButtonsEnabled(false);
        
        // If an avatar is currently generating, kill it
        if (isGenerating) stopAIFilter();
        setStatus("AI Features disabled.");
    } else {
        // Arm the system (unlocks buttons)
        isAIArmed = true;
        ui.toggleAIBtn.innerText = "Disable AI Features";
        ui.toggleAIBtn.classList.add('danger');
        setAvatarButtonsEnabled(true);
        setStatus("AI Features armed. Select an avatar to apply the filter.");
    }
});

// Avatar Buttons (Broadcaster)
ui.avatarBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (!isAIArmed) return;
        const prompt = e.target.getAttribute('data-prompt');
        handleAvatarRequest(prompt, "Broadcaster");
    });
});

// Central logic for handling avatar requests (from Broadcaster OR Viewers)
function handleAvatarRequest(prompt, source) {
    if (isGenerating && falConnection) {
        // AI is already running, just swap the prompt and reset the timer
        falConnection.send({ prompt: prompt, enable_prompt_expansion: true });
        startAITimer(5);
        setStatus(`${source} changed avatar.`);
    } else {
        // Start a fresh AI connection
        startAIFilter(prompt, source);
    }
}

// The 5-second countdown logic
function startAITimer(durationSeconds = 5) {
    if (aiCountdownInterval) clearInterval(aiCountdownInterval);
    let remaining = durationSeconds;
    
    setStatus(`AI Avatar active (${remaining}s remaining)`);

    aiCountdownInterval = setInterval(() => {
        remaining--;
        if (remaining > 0) {
            setStatus(`AI Avatar active (${remaining}s remaining)`);
        } else {
            clearInterval(aiCountdownInterval);
            stopAIFilter(); // Times up, shut it down
        }
    }, 1000);
}

// Establish WebRTC & Start Billing
function startAIFilter(prompt, source) {
    isGenerating = true;
    setStatus(`${source} requested avatar. Connecting to fal.ai...`);

    falConnection = fal.realtime.connect("decart/lucy-2-5/realtime", {
        tokenProvider: async (app) => {
            const res = await fetch('/api/fal/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app }) });
            return (await res.json()).token;
        },
        onResult: async (result) => {
            if (result.type === 'ready') {
                peerConnection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
                localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

                peerConnection.ontrack = async (event) => {
                    const aiVideoTrack = event.streams[0].getVideoTracks()[0];
                    if (aiVideoTrack) {
                        // Completely recreate the video element to prevent browser state-lock
                        aiVideo = document.createElement('video');
                        aiVideo.autoplay = true;
                        aiVideo.playsInline = true;
                        aiVideo.muted = true;

                        aiVideo.srcObject = new MediaStream([aiVideoTrack]);

                        aiVideo.play().catch(err => {
                            if (err.name !== 'AbortError') console.error("Video play error:", err);
                        });

                        // Wait until the video actually arrives to start the 5-second timer
                        startAITimer(5); 
                    }
                };

                peerConnection.onicecandidate = (event) => {
                    if (event.candidate) falConnection.send({ type: 'candidate', candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex });
                };

                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                falConnection.send({ type: 'offer', sdp: offer.sdp });
            }
            if (result.type === 'answer' && result.sdp) await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: result.sdp }));
            if (result.type === 'candidate' && result.candidate) await peerConnection.addIceCandidate(new RTCIceCandidate({ candidate: result.candidate, sdpMid: result.sdpMid, sdpMLineIndex: result.sdpMLineIndex }));
        },
        onError: (err) => {
            setStatus("AI error: " + err.message, true);
            stopAIFilter();
        }
    });

    falConnection.send({ prompt: prompt, enable_prompt_expansion: true });
}

// Kill WebRTC & Stop Billing
function stopAIFilter() {
    if (aiCountdownInterval) clearInterval(aiCountdownInterval);
    isGenerating = false;

    // Disconnecting instantly stops the fal.ai billing meter
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (falConnection) {
        falConnection.close();
        falConnection = null;
    }

    // Explicitly stop remote tracks to free up the browser's decoders
    if (aiVideo && aiVideo.srcObject) {
        aiVideo.srcObject.getTracks().forEach(track => track.stop());
    }

    // Cancel the pending render loop to prevent orphans or double-loops
    if (renderLoopId) {
        if (isUsingVideoCallback) {
            if ('cancelVideoFrameCallback' in aiVideo) aiVideo.cancelVideoFrameCallback(renderLoopId);
            if ('cancelVideoFrameCallback' in rawVideo) rawVideo.cancelVideoFrameCallback(renderLoopId);
        } else {
            clearTimeout(renderLoopId);
        }
    }

    aiVideo.srcObject = null;

    // Restart the render loop so it safely attaches back to the raw camera
    renderLoop();

    if (isAIArmed) {
        setStatus("AI session ended. Ready for next avatar.");
    }
}

// Chat Outgoing
ui.sendChatBtn.addEventListener('click', () => {
    if (vonageSession && ui.chatInput.value.trim()) {
        vonageSession.signal({ type: 'chat', data: JSON.stringify({ sender: 'Broadcaster', text: ui.chatInput.value.trim() }) });
        ui.chatInput.value = '';
    }
});

// 3. Broadcast Controls
ui.startBroadcastBtn.addEventListener('click', async () => {
    if (activeBroadcastId) {
        await fetch('/api/broadcast/stop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ broadcastId: activeBroadcastId, sessionId: vonageSession.sessionId })
        });
        ui.startBroadcastBtn.innerText = "Start HLS Broadcast";
        ui.startBroadcastBtn.classList.remove('danger');
        activeBroadcastId = null;
        ui.shareLinkContainer.style.display = 'none';
        setStatus("Broadcast stopped.");
    } else {
        const res = await fetch('/api/broadcast/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: vonageSession.sessionId })
        });
        const data = await res.json();
        activeBroadcastId = data.id;

        ui.startBroadcastBtn.innerText = "Stop Broadcast";
        ui.startBroadcastBtn.classList.add('danger');

        const watchUrl = `${window.location.origin}/watch.html?room=${ui.roomName.value.trim()}`;
        ui.shareLinkText.innerText = watchUrl;
        ui.shareLinkText.href = watchUrl;
        ui.shareLinkContainer.style.display = 'flex';

        ui.copyLinkBtn.onclick = () => {
            navigator.clipboard.writeText(watchUrl);
            ui.copyLinkBtn.innerText = "Copied!";
            setTimeout(() => ui.copyLinkBtn.innerText = "Copy", 2000);
        };
        setStatus("HLS Broadcast live!");
    }
});

// 4. Archive Controls
ui.startArchiveBtn.addEventListener('click', async () => {
    if (activeArchiveId) {
        await fetch('/api/archive/stop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archiveId: activeArchiveId, sessionId: vonageSession.sessionId })
        });
        ui.startArchiveBtn.innerText = "Start Recording";
        ui.startArchiveBtn.classList.remove('danger');
        activeArchiveId = null;
        setStatus("Recording stopped. Generating archive...");
    } else {
        const res = await fetch('/api/archive/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: vonageSession.sessionId })
        });
        const data = await res.json();
        activeArchiveId = data.id;
        ui.startArchiveBtn.innerText = "Stop Recording";
        ui.startArchiveBtn.classList.add('danger');
        setStatus("Recording started.");
    }
});