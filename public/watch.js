const urlParams = new URLSearchParams(window.location.search);
const room = urlParams.get('room') || 'hackbarna';
document.getElementById('displayRoomName').innerText = room;

const ui = {
    video: document.getElementById('hlsPlayer'),
    chatHistory: document.getElementById('chatHistory'),
    chatInput: document.getElementById('chatInput'),
    sendChatBtn: document.getElementById('sendChatBtn'),
    avatarBtns: document.querySelectorAll('.viewer-avatar-btn'),
    joinModal: document.getElementById('joinModal'),
    viewerNameInput: document.getElementById('viewerName')
};

let vonageSession;
let viewerName = 'Anonymous';

ui.joinModal.showModal();
ui.joinModal.addEventListener('cancel', (e) => e.preventDefault());

// Sanitized Chat Rendering (Prevents HTML / script injection)
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

ui.joinModal.addEventListener('close', async () => {
    viewerName = ui.viewerNameInput.value.trim() || 'Anonymous';
    
    // 1. Fetch HLS stream
    const hlsRes = await fetch(`/api/broadcast/hls/${room}`);
    if (hlsRes.ok) {
        const { hlsUrl } = await hlsRes.json();
        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(hlsUrl);
            hls.attachMedia(ui.video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => ui.video.play());
        } else if (ui.video.canPlayType('application/vnd.apple.mpegurl')) {
            ui.video.src = hlsUrl;
            ui.video.addEventListener('loadedmetadata', () => ui.video.play());
        }
    } else {
        appendChat('System', 'Broadcast is not currently live. Refresh once the broadcaster goes live.');
    }

    // 2. Connect Vonage Session for Chat & Signals
    const vonageRes = await fetch(`/room/${room}`);
    const vonageData = await vonageRes.json();
    
    vonageSession = OT.initSession(vonageData.applicationId, vonageData.sessionId);
    
    vonageSession.on('signal:chat', (event) => {
        const msgData = JSON.parse(event.data);
        appendChat(msgData.sender, msgData.text);
    });

    // Toggle avatar buttons based on Broadcaster AI state
    vonageSession.on('signal:aiState', (event) => {
        const { active } = JSON.parse(event.data);
        ui.avatarBtns.forEach(btn => btn.disabled = !active);
    });

    vonageSession.connect(vonageData.token, (err) => {
        if (!err) console.log("Connected to session for chat and signals.");
    });
});

ui.sendChatBtn.addEventListener('click', () => {
    if (vonageSession && ui.chatInput.value.trim()) {
        vonageSession.signal({ 
            type: 'chat', 
            data: JSON.stringify({ sender: viewerName, text: ui.chatInput.value.trim() }) 
        });
        ui.chatInput.value = '';
    }
});

ui.avatarBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (vonageSession && !btn.disabled) {
            vonageSession.signal({ type: 'avatar', data: e.target.getAttribute('data-prompt') });
        }
    });
});