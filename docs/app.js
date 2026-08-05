// ── Configuration ──
var BACKEND_URL = null;

async function loadBackendUrl() {
  try {
    var resp = await fetch('tunnel-url.json?t=' + Date.now());
    if (resp.ok) {
      var data = await resp.json();
      if (data && data.url) { BACKEND_URL = data.url; console.log('Backend (tunnel):', BACKEND_URL); return; }
    }
  } catch (e) {}
  BACKEND_URL = 'http://localhost:3000';
  console.log('Backend (local):', BACKEND_URL);
}

// ── Main App ──
async function initApp() {
  await loadBackendUrl();
  configureICEServers(BACKEND_URL);

  var nickIn = document.getElementById('tokenInput'),
      joinBtn = document.getElementById('joinBtn'),
      loginOv = document.getElementById('loginOverlay'),
      loginErr = document.getElementById('loginError'),
      statusBar = document.getElementById('statusBar'),
      mainCt = document.getElementById('mainContainer'),
      video = document.getElementById('videoPlayer'),
      ppBtn = document.getElementById('playPauseBtn'),
      playI = document.getElementById('playIcon'),
      pauseI = document.getElementById('pauseIcon'),
      fsBtn = document.getElementById('fullscreenBtn'),
      timeD = document.getElementById('timeDisplay'),
      progC = document.getElementById('progressContainer'),
      progF = document.getElementById('progressFill'),
      audSel = document.getElementById('audioSelect'),
      subSel = document.getElementById('subtitleSelect'),
      curVidLbl = document.getElementById('currentVideoLabel'),
      ctrlB = document.getElementById('controlsBar'),
      userStatusBar = document.getElementById('userStatusBar'),
      chatToggle = document.getElementById('chatToggleBtn'),
      chatBadge = document.getElementById('chatBadge'),
      chatPanel = document.getElementById('chatPanel'),
      chatClose = document.getElementById('chatCloseBtn'),
      chatMs = document.getElementById('chatMessages'),
      chatIn = document.getElementById('chatInput'),
      sendBtn = document.getElementById('sendBtn'),
      mediaToggle = document.getElementById('mediaToggleBtn'),
      mediaOverlay = document.getElementById('mediaOverlay'),
      mediaClose = document.getElementById('mediaCloseBtn'),
      mediaList = document.getElementById('mediaList'),
      fileInput = document.getElementById('fileInput'),
      mediaProgress = document.getElementById('mediaProgress'),
      mediaProgressText = document.getElementById('mediaProgressText'),
      mediaProgressBar = document.getElementById('mediaProgressBar'),
      toastCt = document.getElementById('toastContainer'),
      liveIndicator = document.getElementById('liveIndicator'),
      modalScreenShareBtn = document.getElementById('modalScreenShareBtn'),
      modalScreenShareText = document.getElementById('modalScreenShareText'),
      modalScreenShareHint = document.getElementById('modalScreenShareHint'),
      micBtn = document.getElementById('micBtn'),
      videoBtn = document.getElementById('videoBtn'),
      cameraCircles = document.getElementById('cameraCircles');

  var socket = null;
  var myId = null, myNick = '', currentVideoName = '', chatOpen = false, unread = 0, userListData = [];
  var MAX_TOASTS = 3;
  var activeToasts = [];
  var authToken = null;
  var joined = false;

  // ── Device detection ──
  var isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || 
                 (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
  var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  var isAndroid = /Android/i.test(navigator.userAgent);
  var hasGetDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  var canScreenShare = hasGetDisplayMedia;
  var canOnlyCamera = !canScreenShare && hasGetUserMedia;

  console.log('[Capabilities]', JSON.stringify({
    userAgent: navigator.userAgent,
    isMobile: isMobile,
    isAndroid: isAndroid,
    isIOS: isIOS,
    hasGetDisplayMedia: hasGetDisplayMedia,
    hasGetUserMedia: hasGetUserMedia,
    canScreenShare: canScreenShare,
    canOnlyCamera: canOnlyCamera,
    mediaDevices: !!navigator.mediaDevices,
    getDisplayMediaType: typeof (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
  }));

  // ── WebRTC state ──
  var isScreenSharing = false;
  var screenStream = null;
  var peerConnections = {};
  var receivingPeer = null;
  var currentMediaType = 'file';
  var screenSharerId = null;
  var screenSharerName = null;

  // ── Mic state ──
  var micMuted = false;
  var micStream = null;
  var micAudioTrack = null;

  // ── Camera state ──
  var cameraActive = false;
  var cameraStream = null;
  var cameraPeerMap = {}; // targetId -> RTCPeerConnection

  // ── Remote camera feeds ──
  var remoteCameras = {}; // userId -> { stream, muted }

  // ICE Servers
  var ICE_SERVERS = { 
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ] 
  };

  function configureICEServers(backendUrl) {
    try {
      var url = new URL(backendUrl);
      var turnHost = url.hostname;
      if (turnHost !== 'localhost' && turnHost !== '127.0.0.1') {
        ICE_SERVERS.iceServers.push({
          urls: [
            'turn:' + turnHost + ':3478?transport=tcp',
            'turn:' + turnHost + ':3478?transport=udp'
          ],
          username: 'assistir',
          credential: 'junt0s-w3brtc'
        });
      } else {
        ICE_SERVERS.iceServers.push({
          urls: [
            'turn:localhost:3478?transport=tcp',
            'turn:localhost:3478?transport=udp'
          ],
          username: 'assistir',
          credential: 'junt0s-w3brtc'
        });
      }
      console.log('ICE Servers configured:', ICE_SERVERS.iceServers.length, 'servers');
    } catch (e) {
      console.warn('Failed to configure TURN server:', e);
    }
  }

  function fmt(s) { if (isNaN(s)) return '00:00'; var m = Math.floor(s / 60), sec = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') }
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML }

  // ── UI visibility ──
  var hideTimer;
  function showAllUI() {
    ctrlB.classList.add('visible');
    chatToggle.classList.add('visible');
    mediaToggle.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideAllUI, 3500);
  }
  function hideAllUI() {
    ctrlB.classList.remove('visible');
    chatToggle.classList.remove('visible');
    mediaToggle.classList.remove('visible');
  }

  // ── UI mode switching ──
  function setMediaMode(mode) {
    currentMediaType = mode;
    if (mode === 'screen') {
      video.pause();
      video.src = '';
      video.removeAttribute('src');
      video.srcObject = null;
      ppBtn.style.display = 'none';
      progC.style.display = 'none';
      timeD.textContent = 'AO VIVO';
      liveIndicator.classList.add('show');
      video.controls = false;
      audSel.disabled = true;
      subSel.disabled = true;
      audSel.classList.add('hidden');
      subSel.classList.add('hidden');
    } else {
      ppBtn.style.display = '';
      progC.style.display = '';
      liveIndicator.classList.remove('show');
      audSel.disabled = false;
      subSel.disabled = false;
    }
  }

  // ── Update the screen share button in the media modal ──
  function updateModalScreenShareButton() {
    if (isScreenSharing) {
      modalScreenShareBtn.style.background = '#dc2626';
      modalScreenShareText.textContent = '⏹️ Parar Compartilhamento';
      modalScreenShareHint.style.display = 'block';
      modalScreenShareHint.textContent = 'Compartilhando: feche este modal e continue navegando';
    } else {
      if (isIOS) {
        modalScreenShareText.textContent = '📱 Compartilhar Câmera';
        modalScreenShareHint.textContent = 'iPhone/iPad não permite compartilhamento de tela via navegador.';
      } else {
        modalScreenShareText.textContent = isMobile ? '📱 Compartilhar Tela' : '🖥️ Compartilhar Tela';
        modalScreenShareHint.textContent = 'Seu navegador tentará compartilhar a tela. Se não for compatível, abrirá a câmera automaticamente.';
      }
      modalScreenShareBtn.style.background = '#166534';
      modalScreenShareHint.style.display = 'block';
    }
    modalScreenShareBtn.style.display = '';
  }

  // ── Track population ──
  var knownAudioTracks = [];
  var knownTextTracks = [];

  function trackLabel(track, index) {
    if (track.label && track.label.trim() !== '') return track.label;
    if (track.language && track.language.trim() !== '') {
      var langMap = {
        'pt': 'Português', 'pt-BR': 'Português (BR)', 'pt-PT': 'Português (PT)',
        'en': 'Inglês', 'es': 'Espanhol', 'fr': 'Francês', 'de': 'Alemão',
        'it': 'Italiano', 'ja': 'Japonês', 'ko': 'Coreano', 'zh': 'Chinês',
        'ru': 'Russo', 'ar': 'Árabe', 'hi': 'Hindi', 'nl': 'Holandês',
        'pl': 'Polonês', 'tr': 'Turco', 'sv': 'Sueco', 'no': 'Norueguês'
      };
      var code = track.language;
      if (langMap[code]) return langMap[code];
      return code.toUpperCase();
    }
    return 'Faixa ' + (index + 1);
  }

  function updateAudioSelect() {
    var currentVal = audSel.value;
    audSel.innerHTML = '';
    if (knownAudioTracks.length <= 1) { audSel.classList.add('hidden'); return; }
    for (var i = 0; i < knownAudioTracks.length; i++) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = '🎵 ' + trackLabel(knownAudioTracks[i], i);
      audSel.appendChild(opt);
    }
    audSel.classList.remove('hidden');
    if (currentVal && parseInt(currentVal) < knownAudioTracks.length) { audSel.value = currentVal; }
  }

  function updateSubtitleSelect() {
    var currentVal = subSel.value;
    subSel.innerHTML = '';
    if (knownTextTracks.length === 0) { subSel.classList.add('hidden'); return; }
    for (var i = 0; i < knownTextTracks.length; i++) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = '💬 ' + trackLabel(knownTextTracks[i], i);
      subSel.appendChild(opt);
    }
    var offOpt = document.createElement('option');
    offOpt.value = '-1';
    offOpt.textContent = '💬 Desligado';
    subSel.appendChild(offOpt);
    subSel.classList.remove('hidden');
    if (currentVal && (parseInt(currentVal) < knownTextTracks.length || currentVal === '-1')) {
      subSel.value = currentVal;
    } else {
      subSel.value = '-1';
      var tr = video.textTracks;
      for (var j = 0; j < tr.length; j++) tr[j].mode = 'hidden';
    }
  }

  function resetTrackState() {
    knownAudioTracks = [];
    knownTextTracks = [];
    audSel.classList.add('hidden');
    subSel.classList.add('hidden');
    audSel.innerHTML = '';
    subSel.innerHTML = '';
  }

  function scanTracks() {
    var at = video.audioTracks;
    if (at) {
      knownAudioTracks = [];
      for (var i = 0; i < at.length; i++) {
        knownAudioTracks.push({ label: at[i].label || '', language: at[i].language || '', id: at[i].id || '' });
      }
    }
    var tt = video.textTracks;
    if (tt) {
      knownTextTracks = [];
      for (var j = 0; j < tt.length; j++) {
        knownTextTracks.push({ label: tt[j].label || '', language: tt[j].language || '', kind: tt[j].kind || '' });
      }
    }
    console.log('[Tracks] Audio:', knownAudioTracks.length, 'Text:', knownTextTracks.length);
  }

  // ── Start sharing (screen or camera) ──
  async function startScreenShare() {
    if (isScreenSharing) return;

    var stream = null;
    var shareType = 'screen';

    // Step 1: Try screen sharing via getDisplayMedia
    try {
      var dm = navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia;
      if (typeof dm === 'function') {
        var gdmOpts = isMobile ? { video: true } : { video: true, audio: true };
        stream = await dm.call(navigator.mediaDevices, gdmOpts);
        if (stream && stream.getVideoTracks().length > 0) {
          console.log('[ScreenShare] getDisplayMedia OK. Video tracks:', stream.getVideoTracks().length);
        } else {
          if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
          stream = null;
          console.warn('[ScreenShare] getDisplayMedia returned no video track');
        }
      } else {
        console.warn('[ScreenShare] getDisplayMedia is not a function');
      }
    } catch (e) {
      console.error('[ScreenShare] getDisplayMedia error:', e.name, e.message || e);
      if (e.name === 'AbortError') return;
      stream = null;
    }

    // Step 2: Fall back to camera if screen sharing failed or is unavailable
    if (!stream) {
      shareType = 'camera';
      try {
        var gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
        if (typeof gum === 'function') {
          stream = await gum.call(navigator.mediaDevices, {
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
            audio: { echoCancellation: true, noiseSuppression: true }
          });
          console.log('[ScreenShare] getUserMedia (camera) OK');
          if (shareType !== 'screen') {
            showToast('Aviso', 'Captura de tela indisponivel. Compartilhando camera.');
          }
        }
      } catch (e) {
        console.error('[ScreenShare] getUserMedia error:', e.name, e.message || e);
        if (e.name === 'NotAllowedError') {
          showToast('Permissao Negada', 'Permita o acesso a camera/microfone nas configuracoes do navegador.');
        } else if (e.name !== 'AbortError') {
          showToast('Erro', 'Falha ao capturar midia: ' + (e.message || e.name));
        }
        return;
      }
    }

    // Step 3: Validate the stream
    if (!stream || stream.getVideoTracks().length === 0) {
      showToast('Erro', 'Nao foi possivel obter video. Verifique as permissoes do navegador.');
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
      return;
    }

    // All good — wire it up
    screenStream = stream;
    screenStream.getVideoTracks()[0].addEventListener('ended', function () { stopScreenShare(); });

    socket.emit('startScreenShare');

    isScreenSharing = true;
    updateModalScreenShareButton();
    setMediaMode('screen');
    screenSharerName = myNick;

    video.srcObject = screenStream;
    video.muted = true;
    video.play().catch(function () {});

    console.log('[ScreenShare] Started as', shareType,
                'Video:', screenStream.getVideoTracks().length,
                'Audio:', screenStream.getAudioTracks().length);

    closeMedia();

    // Set up peer connections for existing users
    if (userListData.length > 0) {
      userListData.forEach(function (u) {
        if (u.id !== myId && !peerConnections[u.id]) {
          createPeerConnectionForViewer(u.id);
        }
      });
    }
  }

  // ── WebRTC: Stop Screen Share ──
  function stopScreenShare() {
    if (!isScreenSharing) return;
    if (screenStream) {
      screenStream.getTracks().forEach(function (track) { track.stop(); });
      screenStream = null;
    }
    Object.values(peerConnections).forEach(function (pc) { pc.close(); });
    peerConnections = {};
    isScreenSharing = false;
    screenSharerId = null;
    screenSharerName = null;
    updateModalScreenShareButton();
    setMediaMode('file');
    video.srcObject = null;
    video.src = '';
    video.removeAttribute('src');
    socket.emit('stopScreenShare');
  }

  // ── WebRTC: Create a peer connection to a specific viewer ──
  function createPeerConnectionForViewer(targetId) {
    if (!screenStream) return;
    var pc = new RTCPeerConnection(ICE_SERVERS);
    screenStream.getTracks().forEach(function (track) { pc.addTrack(track, screenStream); });
    pc.onicecandidate = function (e) {
      if (e.candidate) { socket.emit('webrtc-ice-candidate', { target: targetId, candidate: e.candidate }); }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close();
        delete peerConnections[targetId];
      }
    };
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { socket.emit('webrtc-offer', { target: targetId, sdp: pc.localDescription }); })
      .catch(function (err) { console.error('Error creating offer:', err); });
    peerConnections[targetId] = pc;
    return pc;
  }

  // ── WebRTC: Receive a stream as a viewer ──
  function handleReceivedOffer(data) {
    if (isScreenSharing) return;
    if (receivingPeer) { receivingPeer.close(); receivingPeer = null; }
    var pc = new RTCPeerConnection(ICE_SERVERS);
    receivingPeer = pc;
    pc.ontrack = function (event) {
      if (event.streams && event.streams[0]) {
        video.srcObject = event.streams[0];
        video.muted = false;
        video.play().catch(function () { });
        setMediaMode('screen');
      }
    };
    pc.onicecandidate = function (e) {
      if (e.candidate) { socket.emit('webrtc-ice-candidate', { target: data.from, candidate: e.candidate }); }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close();
        receivingPeer = null;
      }
    };
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { socket.emit('webrtc-answer', { target: data.from, sdp: pc.localDescription }); })
      .catch(function (err) { console.error('Error handling offer:', err); });
  }

  function handleReceivedAnswer(data) {
    var pc = peerConnections[data.from];
    if (!pc) return;
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .catch(function (err) { console.error('Error setting remote description:', err); });
  }

  function handleReceivedIceCandidate(data) {
    var pc = peerConnections[data.from] || receivingPeer || cameraPeerMap[data.from];
    if (!pc) return;
    try {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate))
        .catch(function (err) { console.error('Error adding ICE candidate:', err); });
    } catch (e) { console.error('ICE candidate error:', e); }
  }

  // ── Camera Circle rendering ──
  function updateCameraCircle(userId, nickname, hasCamera, isMuted) {
    if (hasCamera) {
      if (!remoteCameras[userId]) {
        remoteCameras[userId] = { nickname: nickname, muted: false };
      }
      remoteCameras[userId].muted = !!isMuted;
    } else {
      delete remoteCameras[userId];
    }
    renderCameraCircles();
  }

  function renderCameraCircles() {
    var userIds = Object.keys(remoteCameras);
    if (userIds.length === 0) { cameraCircles.innerHTML = ''; return; }

    var existingEls = {};
    cameraCircles.querySelectorAll('.camera-circle').forEach(function (el) {
      existingEls[el.getAttribute('data-userid')] = el;
    });

    cameraCircles.innerHTML = '';
    userIds.forEach(function (uid) {
      var cam = remoteCameras[uid];
      var el;
      if (existingEls[uid] && existingEls[uid].videoEl && existingEls[uid].videoEl.srcObject === cam.stream) {
        el = existingEls[uid];
      } else {
        el = document.createElement('div');
        el.className = 'camera-circle';
        el.setAttribute('data-userid', uid);
        var vid = document.createElement('video');
        vid.autoplay = true;
        vid.playsinline = true;
        vid.muted = true;
        vid.setAttribute('playsinline', '');
        if (cam.stream) { vid.srcObject = cam.stream; }
        vid.addEventListener('loadedmetadata', function () { vid.play().catch(function () {}); });
        el.appendChild(vid);
        el.videoEl = vid;
        var label = document.createElement('div');
        label.className = 'cam-label';
        label.textContent = cam.nickname;
        el.appendChild(label);
        var mutedIcon = document.createElement('div');
        mutedIcon.className = 'cam-muted-icon';
        mutedIcon.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M3 18v-6a9 9 0 0 1 18 0v6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
        el.appendChild(mutedIcon);
        el.mutedIconEl = mutedIcon;
      }

      // Update stream if changed
      if (cam.stream && el.videoEl && el.videoEl.srcObject !== cam.stream) {
        el.videoEl.srcObject = cam.stream;
        el.videoEl.play().catch(function () {});
      }

      // Muted icon
      if (el.mutedIconEl) {
        if (cam.muted) { el.mutedIconEl.classList.add('show'); }
        else { el.mutedIconEl.classList.remove('show'); }
      }

      // Animation
      el.classList.add('show');
      cameraCircles.appendChild(el);
    });
  }

  // ── Mic Toggle ──
  async function toggleMic() {
    if (micMuted) {
      // Unmute
      if (micAudioTrack) {
        micAudioTrack.enabled = true;
      }
      micMuted = false;
      micBtn.classList.remove('muted');
      micBtn.title = 'Microfone ligado';
      socket.emit('micStateChanged', { muted: false });
      console.log('[Mic] Unmuted');
    } else {
      if (!micStream) {
        // First time — acquire mic
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          if (micStream.getAudioTracks().length > 0) {
            micAudioTrack = micStream.getAudioTracks()[0];
          }
          console.log('[Mic] Stream acquired');
        } catch (e) {
          console.error('[Mic] Error:', e);
          if (e.name === 'NotAllowedError') {
            showToast('Microfone', 'Permissao de microfone negada.');
          }
          return;
        }
      }
      // Mute
      if (micAudioTrack) {
        micAudioTrack.enabled = false;
      }
      micMuted = true;
      micBtn.classList.add('muted');
      micBtn.title = 'Microfone desligado';
      socket.emit('micStateChanged', { muted: true });
      console.log('[Mic] Muted');
    }
  }

  // Listen for remote mic state
  socket && socket.on && socket.on('micStateChanged', function (data) {
    // Update the camera circle muted icon for this user
    if (remoteCameras[data.id]) {
      remoteCameras[data.id].muted = data.muted;
      renderCameraCircles();
    }
    if (data.muted) {
      showToast(data.nickname, '🔇 Microfone desligado');
    } else {
      showToast(data.nickname, '🎤 Microfone ligado');
    }
  });

  // ── Camera Toggle ──
  async function toggleCamera() {
    if (cameraActive) {
      // Stop camera
      stopMyCamera();
    } else {
      // Start camera
      await startMyCamera();
    }
  }

  async function startMyCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      if (!cameraStream || cameraStream.getVideoTracks().length === 0) {
        showToast('Camera', 'Nao foi possivel acessar a camera.');
        return;
      }
      cameraActive = true;
      videoBtn.classList.add('active');
      videoBtn.title = 'Videochamada ativa';
      socket.emit('cameraStateChanged', { active: true });
      console.log('[Camera] Started');

      // Create peer connections for all existing users
      if (userListData.length > 0) {
        userListData.forEach(function (u) {
          if (u.id !== myId && !cameraPeerMap[u.id]) {
            createCameraPeerConnection(u.id);
          }
        });
      }
    } catch (e) {
      console.error('[Camera] Error:', e);
      if (e.name === 'NotAllowedError') {
        showToast('Camera', 'Permissao de camera negada.');
      } else if (e.name !== 'AbortError') {
        showToast('Camera', 'Erro: ' + (e.message || e.name));
      }
    }
  }

  function stopMyCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (t) { t.stop(); });
      cameraStream = null;
    }
    Object.values(cameraPeerMap).forEach(function (pc) { pc.close(); });
    cameraPeerMap = {};
    cameraActive = false;
    videoBtn.classList.remove('active');
    videoBtn.title = 'Videochamada';
    socket.emit('cameraStateChanged', { active: false });
    console.log('[Camera] Stopped');

    // Also clean up mic if we had one from camera stream
    if (micStream && micStream.getAudioTracks()[0] === micAudioTrack) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
      micAudioTrack = null;
      micMuted = false;
      micBtn.classList.remove('muted');
      micBtn.title = 'Microfone';
      socket.emit('micStateChanged', { muted: false });
    }
  }

  function createCameraPeerConnection(targetId) {
    if (!cameraStream || cameraPeerMap[targetId]) return;
    var pc = new RTCPeerConnection(ICE_SERVERS);
    cameraStream.getTracks().forEach(function (track) { pc.addTrack(track, cameraStream); });
    pc.onicecandidate = function (e) {
      if (e.candidate) { socket.emit('webrtc-ice-candidate', { target: targetId, candidate: e.candidate }); }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close();
        delete cameraPeerMap[targetId];
      }
    };
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { socket.emit('camera-webrtc-offer', { target: targetId, sdp: pc.localDescription }); })
      .catch(function (err) { console.error('[Camera] Error creating offer:', err); });
    cameraPeerMap[targetId] = pc;
  }

  function handleCameraOffer(data) {
    var pc = new RTCPeerConnection(ICE_SERVERS);
    pc.ontrack = function (event) {
      if (event.streams && event.streams[0]) {
        var stream = event.streams[0];
        if (!remoteCameras[data.from]) {
          remoteCameras[data.from] = { stream: stream, nickname: data.nickname || 'User', muted: false };
        } else {
          remoteCameras[data.from].stream = stream;
        }
        renderCameraCircles();
        console.log('[Camera] Received remote stream from', data.from);
      }
    };
    pc.onicecandidate = function (e) {
      if (e.candidate) { socket.emit('webrtc-ice-candidate', { target: data.from, candidate: e.candidate }); }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close();
        delete remoteCameras[data.from];
        renderCameraCircles();
      }
    };
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { socket.emit('camera-webrtc-answer', { target: data.from, sdp: pc.localDescription }); })
      .catch(function (err) { console.error('[Camera] Error handling offer:', err); });
    // Store the PC so we can add ICE candidates
    // Use cameraPeerMap temporarily for the receiving side
    cameraPeerMap[data.from] = pc;
  }

  function handleCameraAnswer(data) {
    var pc = cameraPeerMap[data.from];
    if (!pc) return;
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .catch(function (err) { console.error('[Camera] Error setting remote description:', err); });
  }

  // ── Connect with auth ──
  function connectWithToken(token) {
    statusBar.textContent = '⏳ Conectando...';
    socket = io(BACKEND_URL, {
      transports: ['polling', 'websocket'],
      auth: { token: token }
    });

    socket.on('connect', function () {
      myId = socket.id;
      authToken = token;
      socket.emit('join', 'sala-principal');
      loginOv.style.display = 'none';
      mainCt.style.display = 'flex';
      joined = true;
      socket.emit('requestSync');
      showAllUI();
    });

    socket.on('connect_error', function (err) {
      console.error('Socket error:', err.message);
      loginErr.style.display = 'block';
      loginErr.textContent = err.message.includes('Token') ? 'Token invalido.' : 'Erro: ' + err.message;
      statusBar.textContent = '❌ Falha na conexao';
      socket = null;
    });

    socket.on('disconnect', function () { });

    socket.on('roomState', function (st) {
      myId = st.myId || myId;
      if (st.mediaType === 'screen' && st.screenSharer) {
        screenSharerId = st.screenSharer;
        screenSharerName = st.screenSharerName;
        setMediaMode('screen');
        closeMedia();
        curVidLbl.textContent = 'Tela de ' + (st.screenSharerName || 'alguem');
      } else if (st.currentVideo) {
        setMediaMode('file');
        var src = st.currentVideo.startsWith('http') ? st.currentVideo : BACKEND_URL + st.currentVideo;
        if (video.getAttribute('src') !== src) { video.src = src; video.load(); }
        video.currentTime = st.currentTime || 0;
        if (st.paused) video.pause(); else { video.muted = false; video.play().catch(function () { }) }
        if (st.currentVideoName) { currentVideoName = st.currentVideoName; curVidLbl.textContent = currentVideoName.replace(/\.[^.]+$/, '') }
      } else {
        setMediaMode('file');
        setTimeout(function() { openMedia(); }, 400);
      }
    });

    socket.on('sync', function (st) {
      myId = st.myId || myId;
      if (st.mediaType === 'screen' && st.screenSharer) {
        screenSharerId = st.screenSharer;
        screenSharerName = st.screenSharerName;
        setMediaMode('screen');
        closeMedia();
        curVidLbl.textContent = 'Tela de ' + (st.screenSharerName || 'alguem');
      } else if (st.currentVideo) {
        setMediaMode('file');
        var src = st.currentVideo.startsWith('http') ? st.currentVideo : BACKEND_URL + st.currentVideo;
        if (video.getAttribute('src') !== src) { video.src = src; video.load(); }
      }
      video.currentTime = st.currentTime || 0;
      if (st.paused && st.mediaType !== 'screen') video.pause(); else if (st.mediaType !== 'screen') { video.muted = false; video.play().catch(function () { }) }
      if (st.currentVideoName) { currentVideoName = st.currentVideoName; curVidLbl.textContent = currentVideoName.replace(/\.[^.]+$/, '') }
    });

    socket.on('videoSwitch', function (data) {
      setMediaMode('file');
      var src = data.src.startsWith('http') ? data.src : BACKEND_URL + data.src;
      video.src = src; video.load();
      currentVideoName = data.name; curVidLbl.textContent = data.name.replace(/\.[^.]+$/, '');
      video.muted = true;
      resetTrackState();
    });

    socket.on('remotePlay', function (time) { if (currentMediaType !== 'screen') rPlay(time); });
    socket.on('remotePause', function (time) { if (currentMediaType !== 'screen') rPause(time); });
    socket.on('remoteSeek', function (time) { if (currentMediaType !== 'screen') rSeek(time); });

    socket.on('userList', function (users) {
      userListData = users || [];
      renderUserStatusBar();
      if (isScreenSharing && screenStream) {
        var userIds = userListData.map(function (u) { return u.id; });
        userIds.forEach(function (uid) {
          if (uid !== myId && !peerConnections[uid]) { createPeerConnectionForViewer(uid); }
        });
        Object.keys(peerConnections).forEach(function (pid) {
          if (userIds.indexOf(pid) === -1) { peerConnections[pid].close(); delete peerConnections[pid]; }
        });
      }
      // Camera peer connections
      if (cameraActive && cameraStream) {
        var camUserIds = userListData.map(function (u) { return u.id; });
        camUserIds.forEach(function (uid) {
          if (uid !== myId && !cameraPeerMap[uid]) { createCameraPeerConnection(uid); }
        });
        Object.keys(cameraPeerMap).forEach(function (pid) {
          if (camUserIds.indexOf(pid) === -1) {
            cameraPeerMap[pid].close();
            delete cameraPeerMap[pid];
          }
        });
      }
    });

    socket.on('webrtc-offer', function (data) {
      if (isScreenSharing) return;
      handleReceivedOffer(data);
    });

    socket.on('webrtc-answer', function (data) { handleReceivedAnswer(data); });
    socket.on('webrtc-ice-candidate', function (data) { handleReceivedIceCandidate(data); });

    // Camera WebRTC events
    socket.on('camera-webrtc-offer', function (data) {
      handleCameraOffer(data);
    });
    socket.on('camera-webrtc-answer', function (data) {
      handleCameraAnswer(data);
    });

    socket.on('screenShareStarted', function (data) {
      screenSharerId = data.screenSharer;
      screenSharerName = data.screenSharerName;
      curVidLbl.textContent = 'Tela de ' + data.screenSharerName;
      setMediaMode('screen');
      closeMedia();
    });

    socket.on('screenShareStopped', function (data) {
      screenSharerId = null;
      screenSharerName = null;
      if (receivingPeer) { receivingPeer.close(); receivingPeer = null; }
      video.srcObject = null;
      video.src = '';
      video.removeAttribute('src');
      setMediaMode('file');
      curVidLbl.textContent = 'Nenhum video selecionado';
    });

    socket.on('screenShareError', function (data) {
      showToast('Erro', data.message || 'Erro no compartilhamento.');
    });

    socket.on('chatMessage', function (msg) {
      if (msg.id === myId) return;
      addChatMsg(msg.from, msg.text, msg.system);
      if (!chatOpen) showToast(msg.from, msg.text);
    });

    // Re-register mic/camera event listeners since socket is recreated
    socket.on('micStateChanged', function (data) {
      if (remoteCameras[data.id]) {
        remoteCameras[data.id].muted = data.muted;
        renderCameraCircles();
      }
      if (data.muted) {
        showToast(data.nickname, '🔇 Microfone desligado');
      } else {
        showToast(data.nickname, '🎤 Microfone ligado');
      }
    });

    socket.on('cameraStateChanged', function (data) {
      updateCameraCircle(data.id, data.nickname, data.active, false);
    });
  }

  // ── Join ──
  joinBtn.addEventListener('click', function () { var t = nickIn.value.trim(); if (!t) return; loginErr.style.display = 'none'; connectWithToken(t); });
  nickIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') joinBtn.click() });

  // ── User Status Bar ──
  function renderUserStatusBar() {
    if (!userListData.length) { userStatusBar.innerHTML = '<span class="empty">Nenhum participante</span>'; return }
    var statusOrder = { online: 0, reconnecting: 1, disconnected: 2 };
    var sorted = userListData.slice().sort(function (a, b) { return (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0); });
    userStatusBar.innerHTML = sorted.map(function (u) {
      var isMe = u.id === myId;
      var sharing = (u.id === screenSharerId && screenSharerId) ? ' 🖥️' : '';
      return '<span class="user-chip"><span class="dot ' + esc(u.status || 'online') + '"></span>' + esc(u.nickname) + sharing + (isMe ? ' (voce)' : '') + '</span>';
    }).join('');
  }

  // ── Play/Pause/Seek ──
  function iPlay() { if (currentMediaType === 'screen') return; video.muted = false; video.play().catch(function () { }); socket.emit('play', video.currentTime) }
  function iPause() { if (currentMediaType === 'screen') return; video.pause(); socket.emit('pause', video.currentTime) }
  function iSeek(t) { if (currentMediaType === 'screen') return; video.currentTime = t; socket.emit('seek', t) }
  function rPlay(time) { if (Math.abs(video.currentTime - time) > 1) video.currentTime = time; video.muted = false; video.play().catch(function () { }) }
  function rPause(time) { if (Math.abs(video.currentTime - time) > 1) video.currentTime = time; video.pause() }
  function rSeek(time) { video.currentTime = time }

  // ── Video events ──
  video.addEventListener('play', function () { playI.style.display = 'none'; pauseI.style.display = '' });
  video.addEventListener('pause', function () { playI.style.display = ''; pauseI.style.display = 'none' });
  video.addEventListener('timeupdate', function () {
    if (currentMediaType === 'screen') { timeD.textContent = 'AO VIVO'; progF.style.width = '100%'; return; }
    if (video.duration) { progF.style.width = (video.currentTime / video.duration * 100) + '%'; timeD.textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration); }
  });
  
  video.audioTracks && video.audioTracks.addEventListener('addtrack', function () {
    scanTracks(); updateAudioSelect();
    var at = video.audioTracks; if (at && at.length === 1) at[0].enabled = true;
  });
  video.audioTracks && video.audioTracks.addEventListener('removetrack', function () { scanTracks(); updateAudioSelect(); });
  video.audioTracks && video.audioTracks.addEventListener('change', function () { scanTracks(); updateAudioSelect(); });

  video.textTracks && video.textTracks.addEventListener('addtrack', function () {
    scanTracks(); updateSubtitleSelect();
    setTimeout(function () {
      var ix = parseInt(subSel.value), tr = video.textTracks;
      if (ix === -1) { for (var i = 0; i < tr.length; i++) tr[i].mode = 'hidden'; }
      else if (!isNaN(ix) && ix < tr.length) { for (var j = 0; j < tr.length; j++) tr[j].mode = (j === ix ? 'showing' : 'hidden'); }
    }, 50);
  });
  video.textTracks && video.textTracks.addEventListener('removetrack', function () { scanTracks(); updateSubtitleSelect(); });
  video.textTracks && video.textTracks.addEventListener('change', function () { scanTracks(); updateSubtitleSelect(); });

  video.addEventListener('loadedmetadata', function () {
    if (currentMediaType === 'screen') return;
    timeD.textContent = '00:00 / ' + fmt(video.duration);
    scanTracks(); updateAudioSelect(); updateSubtitleSelect();
    var at = video.audioTracks;
    if (at && at.length > 0) { for (var i = 0; i < at.length; i++) at[i].enabled = (i === 0); }
    var tt = video.textTracks;
    if (tt) { for (var j = 0; j < tt.length; j++) tt[j].mode = 'hidden'; }
    subSel.value = '-1';
  });

  // ── Mouse/Touch → show/hide ──
  video.addEventListener('mousemove', showAllUI);
  video.addEventListener('touchstart', function () { showAllUI() });
  video.addEventListener('mouseleave', function () { hideTimer = setTimeout(hideAllUI, 1200) });
  ctrlB.addEventListener('mouseenter', function () { clearTimeout(hideTimer) });
  ctrlB.addEventListener('mouseleave', function () { hideTimer = setTimeout(hideAllUI, 1200) });
  chatToggle.addEventListener('mouseenter', function () { clearTimeout(hideTimer) });
  mediaToggle.addEventListener('mouseenter', function () { clearTimeout(hideTimer) });
  document.addEventListener('mousemove', function (e) { if (document.fullscreenElement) showAllUI(); });

  // ── Controls ──
  ppBtn.addEventListener('click', function () { if (currentMediaType === 'screen') return; video.paused ? iPlay() : iPause() });
  fsBtn.addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); else document.body.requestFullscreen().catch(function () { }); });
  document.addEventListener('fullscreenchange', function () { document.body.classList.toggle('fullscreen', !!document.fullscreenElement); showAllUI(); });
  progC.addEventListener('click', function (e) { if (currentMediaType === 'screen') return; var r = progC.getBoundingClientRect(); iSeek(((e.clientX - r.left) / r.width) * video.duration) });
  audSel.addEventListener('change', function () { var ix = parseInt(audSel.value); if (video.audioTracks) for (var i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = (i === ix) });
  subSel.addEventListener('change', function () { var ix = parseInt(subSel.value), tr = video.textTracks; for (var i = 0; i < tr.length; i++) tr[i].mode = (ix === -1) ? 'hidden' : (i === ix ? 'showing' : 'hidden') });

  document.addEventListener('keydown', function (e) {
    var tg = e.target.tagName;
    if (tg === 'INPUT' && e.target !== nickIn && e.target !== chatIn) return;
    if (e.target === chatIn) return;
    if (e.key === ' ') { e.preventDefault(); if (currentMediaType === 'screen') return; video.paused ? iPlay() : iPause(); showAllUI() }
    else if (e.key === 'f' && tg !== 'INPUT') { fsBtn.click() }
    else if (e.key === 'ArrowLeft' && currentMediaType !== 'screen') { iSeek(Math.max(0, video.currentTime - 5)) }
    else if (e.key === 'ArrowRight' && currentMediaType !== 'screen') { iSeek(Math.min(video.duration || 0, video.currentTime + 5)) }
  });

  // ── Modal Screen Share Button ──
  modalScreenShareBtn.addEventListener('click', function () {
    if (isScreenSharing) { stopScreenShare(); } else { startScreenShare(); }
  });

  // ── Chat ──
  function openChat() { chatPanel.classList.add('open'); chatOpen = true; unread = 0; chatBadge.classList.remove('show'); chatBadge.textContent = '0'; chatIn.focus(); dismissAllToasts(); showAllUI(); }
  function closeChat() { chatPanel.classList.remove('open'); chatOpen = false }
  chatToggle.addEventListener('click', function () { chatOpen ? closeChat() : openChat(); showAllUI() });
  chatClose.addEventListener('click', function () { closeChat(); showAllUI() });

  // ── Swipe gesture to close chat panel ──
  (function setupChatSwipe() {
    var touchStartX = 0, touchStartY = 0, hasSwipe = false, swipeThreshold = 60;
    chatPanel.addEventListener('touchstart', function (e) {
      if (!chatOpen) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      hasSwipe = false;
    }, { passive: true });
    chatPanel.addEventListener('touchmove', function (e) {
      if (!chatOpen) return;
      var dx = e.touches[0].clientX - touchStartX;
      var dy = e.touches[0].clientY - touchStartY;
      // Only horizontal swipe to the right
      if (dx > swipeThreshold && Math.abs(dx) > Math.abs(dy)) {
        hasSwipe = true;
      }
    }, { passive: true });
    chatPanel.addEventListener('touchend', function (e) {
      if (hasSwipe && chatOpen) {
        closeChat();
        showAllUI();
      }
      hasSwipe = false;
    });
  })();

  function addChatMsg(from, txt, sys) {
    var d = document.createElement('div'); d.className = 'msg' + (sys ? ' system' : '');
    if (!sys && from === myNick) d.className += ' own';
    if (!sys) { var s = document.createElement('span'); s.className = 'author'; s.textContent = from; d.appendChild(s) }
    d.appendChild(document.createTextNode(txt)); chatMs.appendChild(d); chatMs.scrollTop = chatMs.scrollHeight;
  }
  function sendM() { var t = chatIn.value.trim(); if (!t) return; socket.emit('chatMessage', t); addChatMsg(myNick, t, false); chatIn.value = '' }
  sendBtn.addEventListener('click', sendM);
  chatIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendM() });

  // ── Toasts ──
  function showToast(from, txt) {
    unread++; if (unread > 99) unread = 99; chatBadge.textContent = unread > 99 ? '99+' : unread; chatBadge.classList.add('show');
    while (activeToasts.length >= MAX_TOASTS) { var oldest = activeToasts.shift(); if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest); }
    var toast = document.createElement('div'); toast.className = 'toast';
    toast.innerHTML = '<div class="toast-avatar">' + esc(from.charAt(0).toUpperCase()) + '</div><div class="toast-body"><div class="toast-from">' + esc(from) + '</div><div class="toast-text">' + esc(txt) + '</div></div>';
    toast.addEventListener('click', function () { openChat() });
    toastCt.appendChild(toast); activeToasts.push(toast);
  }
  function dismissAllToasts() { while (activeToasts.length) { var t = activeToasts.shift(); if (t && t.parentNode) t.parentNode.removeChild(t) } }

  // ── Media Modal ──
  function openMedia() { mediaOverlay.classList.add('open'); loadMediaList(); updateModalScreenShareButton(); showAllUI() }
  function closeMedia() { mediaOverlay.classList.remove('open') }
  mediaToggle.addEventListener('click', function () { openMedia(); showAllUI() });
  mediaClose.addEventListener('click', closeMedia);
  mediaOverlay.addEventListener('click', function (e) { if (e.target === mediaOverlay) closeMedia() });
  fileInput.addEventListener('change', function () { if (fileInput.files.length) doUpload(fileInput.files[0]) });

  function doUpload(file) {
    mediaProgress.classList.add('show'); mediaProgressText.textContent = 'Enviando: 0%'; mediaProgressBar.style.width = '0%';
    var fd = new FormData(); fd.append('video', file);
    var xhr = new XMLHttpRequest(); xhr.open('POST', BACKEND_URL + '/upload?token=' + encodeURIComponent(authToken)); xhr.timeout = 600000;
    xhr.upload.onprogress = function (e) { if (e.lengthComputable) { var p = Math.round((e.loaded / e.total) * 100); mediaProgressText.textContent = 'Enviando: ' + p + '% (' + (e.loaded / 1024 / 1024).toFixed(1) + ' MB)'; mediaProgressBar.style.width = p + '%' } };
    xhr.onload = function () { mediaProgress.classList.remove('show'); fileInput.value = ''; if (xhr.status === 200) { var r = JSON.parse(xhr.responseText); loadMediaList() } else { alert('Erro no upload.'); } };
    xhr.onerror = function () { mediaProgress.classList.remove('show'); fileInput.value = ''; alert('Erro de rede.') };
    xhr.ontimeout = function () { mediaProgress.classList.remove('show'); fileInput.value = ''; alert('Timeout.') };
    xhr.send(fd);
  }

  function loadMediaList() {
    var xhr = new XMLHttpRequest(); xhr.open('GET', BACKEND_URL + '/api/videos'); xhr.timeout = 8000;
    xhr.onload = function () {
      if (xhr.status !== 200) { mediaList.innerHTML = '<div class="empty">Erro ao carregar.</div>'; return }
      try {
        var files = JSON.parse(xhr.responseText);
        if (!Array.isArray(files) || !files.length) {
          mediaList.innerHTML = '<div class="empty">Nenhuma midia disponivel.<br><br>Clique em <b>Enviar</b> para adicionar um video.</div>';
        } else {
          mediaList.innerHTML = files.map(function (f) {
            var sm = (f.size / 1024 / 1024).toFixed(1);
            var dn = f.filename.replace(/^\d+-/, '');
            var delBtn = '';
            if (myNick === 'Admin') {
              delBtn = '<button class="btn btn-sm" style="background:#dc2626;margin-left:4px" onclick="deleteVid(\'' + esc(f.filename) + '\')" title="Deletar">🗑</button>';
            }
            return '<div class="vidRow"><span><svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="#a78bfa"/></svg>' + esc(dn) + ' (' + sm + ' MB)</span><div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="selectVid(\'' + esc(f.filename) + '\',\'' + esc(dn) + '\')">▶ Assistir</button>' + delBtn + '</div></div>';
          }).join('');
        }
      } catch (ex) { mediaList.innerHTML = '<div class="empty">Erro ao processar.</div>' }
    };
    xhr.onerror = function () { mediaList.innerHTML = '<div class="empty">Erro de rede.</div>' };
    xhr.ontimeout = function () { mediaList.innerHTML = '<div class="empty">Tempo esgotado.</div>' };
    xhr.send();
  }

  window.selectVid = function (fn, dn) {
    setMediaMode('file');
    socket.emit('switchVideo', { src: '/media/' + fn, name: dn || fn });
    video.src = BACKEND_URL + '/media/' + fn; video.load();
    currentVideoName = dn || fn; curVidLbl.textContent = (dn || fn).replace(/\.[^.]+$/, '');
    video.muted = true;
    resetTrackState();
    closeMedia();
  };

  // ── Mic button ──
  micBtn.addEventListener('click', toggleMic);

  // ── Video button ──
  videoBtn.addEventListener('click', toggleCamera);

  // ── Pre-fill token from URL ──
  var urlParams = new URLSearchParams(window.location.search);
  var tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) { nickIn.value = tokenFromUrl; connectWithToken(tokenFromUrl); }

  statusBar.textContent = '✅ Pronto. Insira seu token.';
}

initApp();