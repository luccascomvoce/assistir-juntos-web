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
      modalScreenShareHint = document.getElementById('modalScreenShareHint');

  var socket = null;
  var myId = null, myNick = '', currentVideoName = '', chatOpen = false, unread = 0, userListData = [];
  var MAX_TOASTS = 3;
  var activeToasts = [];
  var authToken = null;
  var joined = false;

  // ── WebRTC state ──
  // ── Device detection ──
  var isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || 
                 (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
  var hasGetDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // ── WebRTC state ──
  var isScreenSharing = false;         // true if I am the screen sharer
  var screenStream = null;             // my local MediaStream when sharing
  var peerConnections = {};            // map of peerId → RTCPeerConnection (only used by sharer)
  var receivingPeer = null;            // RTCPeerConnection used by viewers to receive
  var currentMediaType = 'file';       // 'file' or 'screen'
  var screenSharerId = null;           // socket id of current screen sharer
  var screenSharerName = null;         // name of current screen sharer

  var ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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
      // Disable play/pause/seek — live stream
      ppBtn.style.display = 'none';
      progC.style.display = 'none';
      timeD.textContent = 'AO VIVO';
      liveIndicator.classList.add('show');
      // Clear video src and detach any file source
      video.src = '';
      video.removeAttribute('src');
      video.controls = false;
      audSel.disabled = true;
      subSel.disabled = true;
    } else {
      ppBtn.style.display = '';
      progC.style.display = '';
      liveIndicator.classList.remove('show');
      audSel.disabled = false;
      subSel.disabled = false;
    }
  }

  function updateModalScreenShareButton() {
    if (isScreenSharing) {
      modalScreenShareBtn.style.background = '#dc2626';
      modalScreenShareText.textContent = '⏹️ Parar Compartilhamento';
      modalScreenShareHint.style.display = 'block';
      modalScreenShareHint.textContent = 'Compartilhando: feche este modal e continue navegando';
    } else {
      modalScreenShareBtn.style.background = '#166534';
      modalScreenShareText.textContent = isMobile ? '📱 Compartilhar Câmera' : '🖥️ Compartilhar Tela';
      modalScreenShareHint.style.display = isMobile ? 'block' : 'none';
      modalScreenShareHint.textContent = isMobile ? 'Em dispositivos móveis, apenas a câmera pode ser compartilhada.' : '';
    }
    if (!hasGetDisplayMedia && !hasGetUserMedia) {
      modalScreenShareBtn.style.display = 'none';
      modalScreenShareHint.style.display = 'block';
      modalScreenShareHint.textContent = 'Seu dispositivo/navegador não suporta compartilhamento de tela ou câmera.';
    } else {
      modalScreenShareBtn.style.display = '';
    }
  }

  // ── WebRTC: Start Screen/Camera Share ──
  async function startScreenShare() {
    if (isScreenSharing) return;

    try {
      if (!isMobile && hasGetDisplayMedia) {
        // Desktop: capture screen/window/tab
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: true
        });
      } else if (hasGetUserMedia) {
        // Mobile or fallback: capture camera + mic
        var constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }, audio: true };
        screenStream = await navigator.mediaDevices.getUserMedia(constraints);
      } else {
        showToast('Erro', 'Seu dispositivo não suporta captura de mídia.');
        return;
      }
    } catch (e) {
      console.error('Media capture error:', e);
      if (e.name !== 'AbortError') {
        showToast('Erro', 'Não foi possível iniciar: ' + (e.message || 'erro desconhecido'));
      }
      return;
    }

    screenStream.getVideoTracks()[0].addEventListener('ended', function () {
      stopScreenShare();
    });

    socket.emit('startScreenShare');

    isScreenSharing = true;
    updateModalScreenShareButton();
    setMediaMode('screen');
    screenSharerName = myNick;

    video.srcObject = screenStream;
    video.muted = true;
    video.play().catch(function () { });

    // Close the media modal after starting
    closeMedia();

    // Create peer connections for existing peers
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

    // Stop all tracks
    if (screenStream) {
      screenStream.getTracks().forEach(function (track) { track.stop(); });
      screenStream = null;
    }

    // Close all peer connections
    Object.values(peerConnections).forEach(function (pc) { pc.close(); });
    peerConnections = {};

    isScreenSharing = false;
    screenSharerId = null;
    screenSharerName = null;
    updateModalScreenShareButton();
    setMediaMode('file');

    // Clear video
    video.srcObject = null;
    video.src = '';
    video.removeAttribute('src');

    socket.emit('stopScreenShare');
  }

  // ── WebRTC: Create a peer connection to a specific viewer ──
  function createPeerConnectionForViewer(targetId) {
    if (!screenStream) return;
    var pc = new RTCPeerConnection(ICE_SERVERS);

    // Add local tracks
    screenStream.getTracks().forEach(function (track) {
      pc.addTrack(track, screenStream);
    });

    pc.onicecandidate = function (e) {
      if (e.candidate) {
        socket.emit('webrtc-ice-candidate', { target: targetId, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close();
        delete peerConnections[targetId];
      }
    };

    // Create and send offer
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () {
        socket.emit('webrtc-offer', { target: targetId, sdp: pc.localDescription });
      })
      .catch(function (err) { console.error('Error creating offer:', err); });

    peerConnections[targetId] = pc;
    return pc;
  }

  // ── WebRTC: Receive a stream as a viewer ──
  function handleReceivedOffer(data) {
    if (isScreenSharing) return; // I'm the sharer, don't receive

    // Close previous receiving connection if exists
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
      if (e.candidate) {
        socket.emit('webrtc-ice-candidate', { target: data.from, candidate: e.candidate });
      }
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
      .then(function () {
        socket.emit('webrtc-answer', { target: data.from, sdp: pc.localDescription });
      })
      .catch(function (err) { console.error('Error handling offer:', err); });
  }

  function handleReceivedAnswer(data) {
    var pc = peerConnections[data.from];
    if (!pc) return;
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .catch(function (err) { console.error('Error setting remote description:', err); });
  }

  function handleReceivedIceCandidate(data) {
    // Could be from a peer connection as viewer or as sharer
    var pc = peerConnections[data.from] || receivingPeer;
    if (!pc) return;
    try {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate))
        .catch(function (err) { console.error('Error adding ICE candidate:', err); });
    } catch (e) { console.error('ICE candidate error:', e); }
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
      loginErr.textContent = err.message.includes('Token') ? 'Token inválido.' : 'Erro: ' + err.message;
      statusBar.textContent = '❌ Falha na conexão';
      socket = null;
    });

    socket.on('disconnect', function () { });

    socket.on('roomState', function (st) {
      myId = st.myId || myId;
      if (st.mediaType === 'screen' && st.screenSharer) {
        // There is an active screen share — wait for WebRTC offer from sharer
        screenSharerId = st.screenSharer;
        screenSharerName = st.screenSharerName;
        setMediaMode('screen');
        curVidLbl.textContent = 'Tela de ' + (st.screenSharerName || 'alguém');
        // The sharer will send WebRTC offers to new joiners
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
        curVidLbl.textContent = 'Tela de ' + (st.screenSharerName || 'alguém');
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
      video.muted = true; subSel.value = '0';
    });

    socket.on('remotePlay', function (time) { if (currentMediaType !== 'screen') rPlay(time); });
    socket.on('remotePause', function (time) { if (currentMediaType !== 'screen') rPause(time); });
    socket.on('remoteSeek', function (time) { if (currentMediaType !== 'screen') rSeek(time); });

    socket.on('userList', function (users) {
      userListData = users || [];
      renderUserStatusBar();

      // If I'm screen sharing, create peer connections for new users
      if (isScreenSharing && screenStream) {
        var userIds = userListData.map(function (u) { return u.id; });
        // Create peer connections for users that don't have one yet
        userIds.forEach(function (uid) {
          if (uid !== myId && !peerConnections[uid]) {
            createPeerConnectionForViewer(uid);
          }
        });
        // Clean up connections for users who left
        Object.keys(peerConnections).forEach(function (pid) {
          if (userIds.indexOf(pid) === -1) {
            peerConnections[pid].close();
            delete peerConnections[pid];
          }
        });
      }
    });

    // ── WebRTC Signaling Events ──
    socket.on('webrtc-offer', function (data) {
      if (isScreenSharing) return; // I'm the sharer, not a receiver
      handleReceivedOffer(data);
    });

    socket.on('webrtc-answer', function (data) {
      handleReceivedAnswer(data);
    });

    socket.on('webrtc-ice-candidate', function (data) {
      handleReceivedIceCandidate(data);
    });

    // ── Screen Share Events ──
    socket.on('screenShareStarted', function (data) {
      screenSharerId = data.screenSharer;
      screenSharerName = data.screenSharerName;
      curVidLbl.textContent = 'Tela de ' + data.screenSharerName;
      setMediaMode('screen');
    });

    socket.on('screenShareStopped', function (data) {
      screenSharerId = null;
      screenSharerName = null;
      // Close receiving peer connection
      if (receivingPeer) { receivingPeer.close(); receivingPeer = null; }
      // Clear video
      video.srcObject = null;
      video.src = '';
      video.removeAttribute('src');
      setMediaMode('file');
      curVidLbl.textContent = 'Nenhum vídeo selecionado';
    });

    socket.on('screenShareError', function (data) {
      showToast('Erro', data.message || 'Erro no compartilhamento.');
    });

    socket.on('chatMessage', function (msg) {
      if (msg.id === myId) return;
      addChatMsg(msg.from, msg.text, msg.system);
      if (!chatOpen) showToast(msg.from, msg.text);
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
      return '<span class="user-chip"><span class="dot ' + esc(u.status || 'online') + '"></span>' + esc(u.nickname) + sharing + (isMe ? ' (você)' : '') + '</span>';
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
  video.addEventListener('loadedmetadata', function () {
    if (currentMediaType === 'screen') return;
    timeD.textContent = '00:00 / ' + fmt(video.duration);
    if (video.audioTracks && video.audioTracks.length > 1) for (var i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = (i === 0);
  });
  video.addEventListener('waiting', function () {});
  video.addEventListener('playing', function () {});

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
    if (isScreenSharing) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  });

  // ── Chat ──
  function openChat() { chatPanel.classList.add('open'); chatOpen = true; unread = 0; chatBadge.classList.remove('show'); chatBadge.textContent = '0'; chatIn.focus(); dismissAllToasts(); showAllUI(); }
  function closeChat() { chatPanel.classList.remove('open'); chatOpen = false }
  chatToggle.addEventListener('click', function () { chatOpen ? closeChat() : openChat(); showAllUI() });
  chatClose.addEventListener('click', function () { closeChat(); showAllUI() });

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
          mediaList.innerHTML = '<div class="empty">Nenhuma mídia disponível.<br><br>Clique em <b>Enviar</b> para adicionar um vídeo.</div>';
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
    video.muted = true; subSel.value = '0'; closeMedia();
  };

  // ── Pre-fill token from URL ──
  var urlParams = new URLSearchParams(window.location.search);
  var tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) { nickIn.value = tokenFromUrl; connectWithToken(tokenFromUrl); }

  statusBar.textContent = '✅ Pronto. Insira seu token.';
}

initApp();