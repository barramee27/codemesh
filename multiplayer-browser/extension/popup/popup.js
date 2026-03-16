const SERVER_URL = 'http://localhost:4000';
let roomId = null;
let userName = null;

const port = chrome.runtime.connect({ name: 'popup' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'chat-message') appendChat(msg.data);
  if (msg.type === 'user-joined') {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    chip.style.borderLeft = '3px solid ' + (msg.data?.color || '#6C5CE7');
    chip.textContent = msg.data?.name || 'Unknown';
    document.getElementById('usersList').appendChild(chip);
  }
  if (msg.type === 'user-left') {
    document.querySelectorAll('.user-chip').forEach(c => {
      if (c.textContent === msg.data?.name) c.remove();
    });
  }
});

document.getElementById('btnCreate').onclick = async () => {
  const res = await fetch(SERVER_URL + '/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const { roomId: id } = await res.json();
  document.getElementById('roomId').value = id;
  navigator.clipboard.writeText(id);
  alert('Room created! ID copied: ' + id);
};

document.getElementById('btnJoin').onclick = () => {
  roomId = document.getElementById('roomId').value.trim();
  userName = document.getElementById('userName').value.trim() || 'Guest';
  if (!roomId) return alert('Enter a room ID');
  chrome.runtime.sendMessage({ type: 'JOIN', roomId, userName }, (res) => {
    if (res?.error) return alert(res.error);
    showInRoom(res);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'mp-init', roomId, myId: res.myId }).catch(() => {});
      }
    });
  });
};

document.getElementById('btnLeave').onclick = () => {
  chrome.runtime.sendMessage({ type: 'LEAVE' });
  roomId = null;
  document.getElementById('inRoomSection').style.display = 'none';
  document.getElementById('chatSection').style.display = 'none';
  document.getElementById('voiceSection').style.display = 'none';
};

function showInRoom(data) {
  document.getElementById('inRoomSection').style.display = 'block';
  document.getElementById('chatSection').style.display = 'block';
  document.getElementById('voiceSection').style.display = 'block';
  const users = data.users || [];
  document.getElementById('usersList').innerHTML = users.map(u => 
    `<span class="user-chip" style="border-left:3px solid ${u.color}">${escapeHtml(u.name)}</span>`
  ).join('');
  const chatArea = document.getElementById('chatArea');
  (data.messages || []).forEach(m => appendChat(m));
  if (data.currentUrl) {
    chrome.tabs.query({ active: true }, tabs => {
      if (tabs[0]?.id && tabs[0].url !== data.currentUrl) {
        chrome.tabs.update(tabs[0].id, { url: data.currentUrl });
      }
    });
  }
}

function appendChat(m) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const time = new Date(m.ts).toLocaleTimeString();
  el.innerHTML = `<span class="name" style="color:${m.userColor}">${escapeHtml(m.userName)}</span><span class="time">${time}</span><br>${escapeHtml(m.text)}`;
  document.getElementById('chatArea').appendChild(el);
  el.scrollIntoView();
}

document.getElementById('chatInput').onkeydown = (e) => {
  if (e.key === 'Enter') {
    const text = document.getElementById('chatInput').value.trim();
    if (text) {
      chrome.runtime.sendMessage({ type: 'CHAT', text });
      document.getElementById('chatInput').value = '';
    }
  }
};


function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let voiceStream = null;
let voiceEnabled = false;
document.getElementById('btnVoice').onclick = () => {
  voiceEnabled = !voiceEnabled;
  const btn = document.getElementById('btnVoice');
  btn.textContent = voiceEnabled ? 'Mute' : 'Unmute';
  btn.classList.toggle('muted', !voiceEnabled);
  if (voiceEnabled) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      voiceStream = stream;
    }).catch(() => alert('Microphone access denied'));
  } else {
    voiceStream?.getTracks().forEach(t => t.stop());
    voiceStream = null;
  }
};
