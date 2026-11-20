// OpenDesk 2 - UI and network layer.
// Rendezvous: public MQTT brokers (WebSocket). Session: WebRTC data channel (P2P, DTLS).
// Native work (capture, input, files, clipboard, settings) is done by the local backend.
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const show = (e, on = true) => e.classList.toggle('hidden', !on);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const TOKEN = new URLSearchParams(location.search).get('t') || '';
  const fmtId = id => String(id).replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
  const cleanId = s => String(s).replace(/\D/g, '');
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Set by mobile.js in the Android app, where a JS shim replaces the Windows backend.
  const MOBILE = window.OpenDeskMobile || null;

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e[k] = v;
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  }
  function toast(text, ms = 3500) {
    const t = h('div', { class: 'toast', textContent: text });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms);
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function ask(title, value = '') {
    return new Promise(res => {
      const input = h('input', { value });
      const done = v => { ov.remove(); res(v); };
      const ov = h('div', { class: 'overlay' }, h('form', { class: 'dialog', onsubmit: e => { e.preventDefault(); done(input.value); } },
        h('h3', { textContent: title }), input,
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', textContent: 'Cancel', onclick: () => done(null) }),
          h('button', { class: 'btn primary', textContent: 'OK' }))));
      document.body.append(ov);
      input.focus(); input.select();
    });
  }

  // ---------------------------------------------------------------- backend
  const backend = {
    ws: null, seq: 0, pending: new Map(), on: {}, onbin: null,
    connect() {
      if (MOBILE) return MOBILE.connect(this);
      return new Promise((res, rej) => {
        const ws = this.ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = res;
        ws.onerror = rej;
        ws.onclose = () => show($('#fatal'));
        ws.onmessage = ev => {
          if (typeof ev.data !== 'string') return this.onbin && this.onbin(new Uint8Array(ev.data));
          const m = JSON.parse(ev.data);
          if (m.op === 'rpc_r') {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (p) m.e !== undefined ? p.rej(new Error(m.e)) : p.res(m.r);
          } else if (this.on[m.op]) this.on[m.op](m);
        };
      });
    },
    rpc(m, a = {}) {
      if (MOBILE) return MOBILE.rpc(m, a);
      return new Promise((res, rej) => {
        const id = ++this.seq;
        this.pending.set(id, { res, rej });
        this.ws.send(JSON.stringify({ op: 'rpc', id, m, a }));
      });
    },
    send(o) { if (MOBILE) return MOBILE.send(o); if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
    sendBin(u8) { if (MOBILE) return MOBILE.sendBin(u8); if (this.ws.readyState === 1) this.ws.send(u8); },
  };

  // UI errors go to the backend log file (the packaged app has no console).
  const logErr = msg => (backend.ws || MOBILE) && backend.send({ op: 'log', msg: String(msg).slice(0, 2000) });
  addEventListener('error', e => logErr(`${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener('unhandledrejection', e => logErr('unhandled: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

  // ------------------------------------------------- MQTT 3.1.1 (QoS 0 only)
  const mstr = s => { const b = enc.encode(s); return concat([Uint8Array.of(b.length >> 8, b.length & 255), b]); };
  function mpacket(first, ...parts) {
    const body = concat(parts.map(p => p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const len = [];
    let n = body.length;
    do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; len.push(b); } while (n);
    return concat([Uint8Array.of(first), Uint8Array.from(len), body]);
  }
  class Mqtt {
    constructor(url, topic, onmsg, onstate) {
      Object.assign(this, { url, topic, onmsg, onstate, up: false, dead: false, buf: new Uint8Array(0), retry: 1000 });
      this.open();
    }
    open() {
      if (this.dead) return;
      let ws;
      try { ws = this.ws = new WebSocket(this.url, 'mqtt'); } catch (e) { return this.again(); }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(mpacket(0x10, mstr('MQTT'), [4, 2, 0, 60], mstr('od-' + Math.random().toString(36).slice(2, 14))));
      ws.onmessage = ev => { this.buf = concat([this.buf, new Uint8Array(ev.data)]); this.parse(); };
      ws.onclose = () => { clearInterval(this.ping); if (this.up) { this.up = false; this.onstate(); } this.again(); };
      ws.onerror = () => {};
    }
    again() {
      if (this.dead) return;
      setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, 20000);
    }
    parse() {
      for (;;) {
        const b = this.buf;
        if (b.length < 2) return;
        let len = 0, mult = 1, i = 1;
        for (;;) {
          if (i >= b.length) return;
          const d = b[i++];
          len += (d & 127) * mult; mult *= 128;
          if (!(d & 128)) break;
          if (i > 4) { this.ws.close(); return; }
        }
        if (b.length < i + len) return;
        const body = b.subarray(i, i + len), type = b[0] >> 4;
        this.buf = b.slice(i + len);
        if (type === 2) {
          if (body[1] !== 0) { this.ws.close(); return; }
          this.ws.send(mpacket(0x82, [0, 1], mstr(this.topic), [0]));
          this.ping = setInterval(() => this.ws.readyState === 1 && this.ws.send(Uint8Array.of(0xC0, 0)), 25000);
        } else if (type === 9) {
          this.up = true; this.retry = 1000; this.onstate();
        } else if (type === 3) {
          const tl = body[0] << 8 | body[1], qos = b[0] >> 1 & 3;
          try { this.onmsg(JSON.parse(dec.decode(body.subarray(2 + tl + (qos ? 2 : 0))))); } catch (e) { /* not ours */ }
        }
      }
    }
    publish(topic, text) { if (this.up) this.ws.send(mpacket(0x30, mstr(topic), enc.encode(text))); }
    close() { this.dead = true; clearInterval(this.ping); try { this.ws.close(); } catch (e) {} }
  }

  // Rendezvous over several brokers at once; duplicates are dropped by message id.
  const TOPIC = id => `opendesk/v2/${id}`;
  const signal = {
    clients: [], seen: [], on: {},
    start() {
      this.clients.forEach(c => c.close());
      this.clients = cfg.network.brokers.map(url => new Mqtt(url, TOPIC(cfg.id), m => this.recv(m), () => this.state()));
      this.state();
    },
    state() {
      const n = this.clients.filter(c => c.up).length, el = $('#net');
      el.className = 'net ' + (n ? 'ok' : 'bad');
      $('#net-text').textContent = n ? 'Ready' : 'No connection to rendezvous servers';
      el.title = this.clients.map(c => `${c.up ? '●' : '○'} ${c.url}`).join('\n');
    },
    get up() { return this.clients.some(c => c.up); },
    recv(m) {
      if (!m || typeof m.mid !== 'string' || !/^\d{9}$/.test(m.from) || this.seen.includes(m.mid)) return;
      this.seen.push(m.mid);
      if (this.seen.length > 300) this.seen.shift();
      if (this.on[m.k]) this.on[m.k](m);
    },
    send(to, obj, mid) {
      const text = JSON.stringify({ ...obj, from: cfg.id, mid: mid || crypto.randomUUID() });
      this.clients.forEach(c => c.publish(TOPIC(to), text));
    },
  };

  // --------------------------------------------------------- peer transport
  // Logical messages are split into <=60 KB data-channel messages:
  // [1 byte: 1 = more follows][payload]. A logical message starting with 'J' is JSON.
  const MAXCHUNK = 60000;
  class Peer {
    constructor(pc) { this.pc = pc; this.dc = null; this.parts = []; this.closed = false; }
    attach(dc) {
      this.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 262144;
      dc.onmessage = ev => this.recv(new Uint8Array(ev.data));
      dc.onclose = () => this.close();
      if (dc.readyState === 'open') queueMicrotask(() => this.onopen && this.onopen());
      else dc.onopen = () => this.onopen && this.onopen();
    }
    recv(u8) {
      const more = u8[0] & 1, body = u8.subarray(1);
      if (more || this.parts.length) {
        this.parts.push(body);
        if (more) return;
      }
      const whole = this.parts.length ? concat(this.parts) : body;
      this.parts = [];
      if (whole[0] === 0x4A) {
        let m;
        try { m = JSON.parse(dec.decode(whole.subarray(1))); } catch (e) { return; }
        this.onjson && this.onjson(m);
      } else this.onbin && this.onbin(whole);
    }
    sendRaw(u8) {
      const dc = this.dc;
      if (!dc || dc.readyState !== 'open') return;
      try {
        for (let o = 0; o < u8.length || o === 0; o += MAXCHUNK) {
          const piece = u8.subarray(o, o + MAXCHUNK), f = new Uint8Array(piece.length + 1);
          f[0] = o + MAXCHUNK < u8.length ? 1 : 0;
          f.set(piece, 1);
          dc.send(f);
        }
      } catch (e) { this.close(); }
    }
    sendJSON(o) { const b = enc.encode(JSON.stringify(o)), u = new Uint8Array(b.length + 1); u[0] = 0x4A; u.set(b, 1); this.sendRaw(u); }
    async drain(limit = 1048576) {
      while (this.dc && this.dc.readyState === 'open' && this.dc.bufferedAmount > limit) {
        await new Promise(r => { this.dc.onbufferedamountlow = r; setTimeout(r, 200); });
      }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      try { this.dc && this.dc.close(); } catch (e) {}
      try { this.pc.close(); } catch (e) {}
      this.onclose && this.onclose();
    }
  }
  const rtcConfig = () => ({ iceServers: cfg.network.ice });
  const fingerprint = sdp => ((sdp || '').match(/a=fingerprint:\S+ (\S+)/) || [])[1] || '';
  const fingerprints = pc => [fingerprint(pc.localDescription.sdp), fingerprint(pc.remoteDescription.sdp)];
  function gathered(pc, ms = 2500) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }

  // ====================================================================
  // HOST ROLE: this desk is being viewed. The UI only pipes data between
  // the data channel and the backend, which enforces login and permissions.
  // ====================================================================
  const hostPeers = new Map();
  let cfg = null;

  signal.on.offer = async m => {
    if (typeof m.sdp !== 'string' || m.sdp.length > 20000 || typeof m.sid !== 'string') return;
    if (MOBILE) return signal.send(m.from, { k: 'reject', sid: m.sid, reason: 'That address is a phone or tablet. OpenDesk for Android can control PCs but cannot be controlled.' });
    if (hostPeers.size >= 4) return signal.send(m.from, { k: 'reject', sid: m.sid, reason: 'This desk has too many sessions.' });
    let sid = 1;
    while (hostPeers.has(sid)) sid++;
    const pc = new RTCPeerConnection(rtcConfig()), peer = new Peer(pc);
    hostPeers.set(sid, peer);
    const giveUp = setTimeout(() => peer.dc && peer.dc.readyState === 'open' || peer.close(), 40000);
    peer.onclose = () => { clearTimeout(giveUp); hostPeers.delete(sid); backend.send({ op: 'peer_close', sid }); };
    pc.ondatachannel = ev => peer.attach(ev.channel);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') peer.close(); };
    // The backend must learn about the session before its first message, whichever event fires first.
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      backend.send({ op: 'peer_open', sid, peer: { id: m.from, name: String(m.name || '').slice(0, 64) }, fp: fingerprints(pc) });
    };
    peer.onopen = open;
    peer.onjson = d => { open(); backend.send({ op: 'peer_msg', sid, d }); };
    peer.onbin = u8 => { const out = new Uint8Array(u8.length + 1); out[0] = sid; out.set(u8, 1); backend.sendBin(out); };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      signal.send(m.from, { k: 'answer', sid: m.sid, sdp: pc.localDescription.sdp });
    } catch (e) { peer.close(); }
  };
  backend.on.peer_send = m => { const p = hostPeers.get(m.sid); p && p.sendJSON(m.d); };
  backend.on.peer_kick = m => { const p = hostPeers.get(m.sid); p && p.close(); };
  backend.onbin = u8 => { const p = hostPeers.get(u8[0]); p && p.sendRaw(u8.subarray(1)); };

  // Incoming request dialog
  const incoming = new Map();
  function renderIncoming() {
    const first = incoming.values().next().value;
    show($('#dlg-incoming'), !!first);
    if (!first || $('#dlg-incoming').dataset.sid === String(first.sid)) return;
    $('#dlg-incoming').dataset.sid = first.sid;
    $('#inc-name').textContent = first.peer.name || 'Unknown';
    $('#inc-id').textContent = fmtId(first.peer.id);
    for (const k of ['control', 'clipboard', 'files']) $('#inc-' + k).checked = !!first.perms[k];
  }
  backend.on.incoming = m => { incoming.set(m.sid, m); renderIncoming(); };
  backend.on.incoming_end = m => { incoming.delete(m.sid); if ($('#dlg-incoming').dataset.sid === String(m.sid)) $('#dlg-incoming').dataset.sid = ''; renderIncoming(); };
  function replyIncoming(accept) {
    const sid = +$('#dlg-incoming').dataset.sid;
    const perms = {};
    for (const k of ['control', 'clipboard', 'files']) perms[k] = $('#inc-' + k).checked;
    backend.rpc('incoming_reply', { sid, accept, perms });
  }
  $('#inc-accept').onclick = () => replyIncoming(true);
  $('#inc-deny').onclick = () => replyIncoming(false);

  // Sessions connected to this desk + host-side chat
  let hostChatSid = 0;
  backend.on.sessions = m => {
    show($('#incoming-sessions'), m.items.length > 0);
    $('#incoming-list').replaceChildren(...m.items.map(s => h('div', { class: 'inc-item' },
      h('b', { textContent: `${s.name || 'Unknown'} (${fmtId(s.id)})`, title: Object.keys(s.perms).filter(k => s.perms[k]).join(', ') || 'view only' }),
      h('button', { class: 'btn small', textContent: 'Chat', onclick: () => openHostChat(s.sid, s.name) }),
      h('button', { class: 'btn small danger-text', textContent: 'End', onclick: () => backend.rpc('session_end', { sid: s.sid }) }))));
    if (!m.items.some(s => s.sid === hostChatSid)) show($('#host-chat'), false);
  };
  function addMsg(log, text, me, who) {
    log.append(h('div', { class: 'msg' + (me ? ' me' : '') }, who ? h('small', { textContent: who }) : null, text));
    log.scrollTop = log.scrollHeight;
  }
  function openHostChat(sid, name) {
    if (hostChatSid !== sid) $('#host-chat-log').replaceChildren();
    hostChatSid = sid;
    $('#host-chat-title').textContent = 'Chat with ' + (name || 'viewer');
    show($('#host-chat'));
  }
  backend.on.chat = m => { openHostChat(m.sid, m.name); addMsg($('#host-chat-log'), m.text, false); };
  $('#host-chat-close').onclick = () => show($('#host-chat'), false);
  $('#host-chat-form').onsubmit = e => {
    e.preventDefault();
    const text = $('#host-chat-input').value.trim();
    if (!text) return;
    $('#host-chat-input').value = '';
    backend.rpc('chat_send', { sid: hostChatSid, text });
    addMsg($('#host-chat-log'), text, true);
  };

  // ====================================================================
  // VIEWER ROLE
  // ====================================================================
  const canvas = $('#screen'), ctx = canvas.getContext('2d', { alpha: false });
  let V = null; // current outgoing session

  function connStatus(text, spin = true, err = false) {
    const box = $('#conn-status');
    show(box, !!text);
    box.classList.toggle('err', err);
    $('#conn-msg').textContent = text || '';
    show($('#conn-spinner'), spin);
    $('#conn-cancel').textContent = spin ? 'Cancel' : 'Close';
  }
  $('#conn-cancel').onclick = () => { if (V) endSession(); connStatus(''); };

  $('#connect-form').onsubmit = e => { e.preventDefault(); connectTo(cleanId($('#target-id').value)); };
  $('#target-id').oninput = e => { e.target.value = fmtId(e.target.value); };

  async function connectTo(id) {
    if (V) return;
    if (!/^\d{9}$/.test(id)) return toast('Enter the 9-digit address of the remote desk.');
    if (id === cfg.id) return toast('That is the address of this desk.');
    if (!signal.up) return toast('Not connected to the rendezvous servers yet. Check your internet connection.');
    const pc = new RTCPeerConnection(rtcConfig()), peer = new Peer(pc);
    const s = V = {
      id, peer, pc, sid: crypto.randomUUID(), name: '', state: 'connecting', perms: {}, chain: Promise.resolve(),
      control: true, view: cfg.display.view, quality: cfg.display.quality, waiters: new Map(), lists: new Map(),
      downloads: new Map(), xid: 0, rid: 0, frames: 0, bytes: 0, rtt: 0, route: '', lastMove: 0, timers: [],
    };
    peer.attach(pc.createDataChannel('opendesk'));
    peer.onclose = () => { if (V === s) endSession(s.state === 'active' ? 'The session has ended.' : s.error || 'Could not connect to the remote desk.'); };
    peer.onjson = m => onHostMsg(s, m);
    peer.onbin = u8 => (u8[0] === 0x46 ? onFrame(s, u8) : u8[0] === 0x44 && onFileChunk(s, u8));
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') peer.close(); };
    connStatus(`Connecting to ${fmtId(id)}…`);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (V !== s) return;
      const offer = { k: 'offer', sid: s.sid, sdp: pc.localDescription.sdp, name: cfg.name };
      const mid = crypto.randomUUID();
      signal.send(id, offer, mid);
      s.timers.push(setTimeout(() => s.state === 'connecting' && signal.send(id, offer, mid), 4000));
      s.timers.push(setTimeout(() => {
        if (s.state !== 'connecting') return;
        s.error = 'The remote desk is offline. Make sure OpenDesk is running there and the address is correct.';
        peer.close();
      }, 12000));
    } catch (e) { s.error = String(e.message || e); peer.close(); }
  }
  signal.on.answer = async m => {
    const s = V;
    if (!s || m.sid !== s.sid || m.from !== s.id || s.state !== 'connecting') return;
    s.state = 'ice';
    connStatus('Remote desk found. Establishing a secure connection…');
    try { await s.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch (e) { return s.peer.close(); }
    s.timers.push(setTimeout(() => {
      if (s.state !== 'ice') return;
      s.error = 'Both desks are online, but their networks block a direct connection. Add a TURN relay under Settings → Connection on both desks.';
      s.peer.close();
    }, 25000));
    s.peer.onopen = () => { s.state = 'hello'; s.peer.sendJSON({ t: 'hello', v: 2 }); };
    if (s.peer.dc.readyState === 'open') s.peer.onopen();
  };
  signal.on.reject = m => { const s = V; if (s && m.sid === s.sid) { s.error = String(m.reason || 'The remote desk refused the connection.'); s.peer.close(); } };

  function endSession(message) {
    const s = V;
    if (!s) return;
    V = null;
    s.timers.forEach(clearTimeout);
    clearInterval(s.tick);
    for (const w of s.waiters.values()) w.rej(new Error('Session ended'));
    for (const w of s.lists.values()) w.rej(new Error('Session ended'));
    try { s.peer.sendJSON({ t: 'relk' }); } catch (e) {}
    s.peer.onclose = null;
    s.peer.close();
    backend.rpc('clip_watch', { on: false });
    if (document.fullscreenElement) document.exitFullscreen();
    else if (s.full) backend.rpc('fullscreen');
    for (const id of ['#session', '#dlg-auth', '#dlg-files', '#chat']) show($(id), false);
    show($('#home'));
    connStatus(message || '', false, !!message && s.state !== 'active');
  }
  $('#s-end').onclick = () => endSession();

  async function onHostMsg(s, m) {
    if (V !== s) return;
    switch (m.t) {
      case 'auth': {
        s.auth = m; s.name = m.name || '';
        s.state = 'auth';
        connStatus(`Waiting for ${s.name || fmtId(s.id)}…`);
        if (m.pw) {
          const r = await backend.rpc('auth_proof', { id: s.id, salt: m.salt, nonce: m.nonce, fps: fingerprints(s.pc) });
          if (r.proof) { s.usedSaved = true; return s.peer.sendJSON({ t: 'auth_pw', proof: r.proof }); }
        }
        return showAuth(s, '');
      }
      case 'auth_fail':
        if (s.usedSaved || s.remembered) backend.rpc('recent_edit', { id: s.id, forget: true }).then(setCfg);
        s.usedSaved = false;
        return showAuth(s, m.reason || 'Login failed.');
      case 'denied': s.error = m.reason || 'Access denied.'; return;
      case 'granted': return startViewing(s, m);
      case 'cur': s.cur = m; return drawCursor(s);
      case 'pong': s.rtt = Math.round(performance.now() - m.ts); return;
      case 'chat': show($('#chat')); addMsg($('#chat-log'), String(m.text), false); layout(); return;
      case 'clip': if (s.perms.clipboard) backend.rpc('clip_set', { text: String(m.text) }); return;
      case 'clip_files': if (!MOBILE && s.perms.clipboard && s.perms.files && Array.isArray(m.items)) clipReceive(s, m.items); return;
      case 'notice': toast(String(m.text), 7000); return;
      case 'bye': s.state = 'ended'; return endSession('The remote desk ended the session.');
      case 'fs_list_r': { const w = s.lists.get(m.rid); s.lists.delete(m.rid); w && w.res(m); return; }
      case 'fs_err': {
        const err = new Error(m.err || 'File operation failed');
        if (m.rid != null) { const w = s.lists.get(m.rid); s.lists.delete(m.rid); w && w.rej(err); }
        if (m.xid != null) for (const [k, w] of s.waiters) if (k.endsWith(':' + m.xid)) { s.waiters.delete(k); w.rej(err); }
        return;
      }
      case 'get_info': { const d = s.downloads.get(m.xid); if (d) d.job.size = m.size; return; }
      case 'put_ok': case 'put_done': case 'get_end': {
        const k = m.t + ':' + m.xid, w = s.waiters.get(k);
        s.waiters.delete(k); w && w.res(m);
        return;
      }
    }
  }
  const waitFor = (s, type, xid) => new Promise((res, rej) => s.waiters.set(type + ':' + xid, { res, rej }));

  // ---- login dialog
  function showAuth(s, error) {
    const a = s.auth;
    $('#auth-title').textContent = `Connect to ${s.name || fmtId(s.id)}`;
    show($('#auth-wait'), !!a.prompt);
    show($('#auth-pw'), !!a.pw);
    show($('#auth-ok'), !!a.pw);
    show($('#auth-pw-hint'), !!a.prompt);
    $('#auth-error').textContent = error;
    $('#auth-password').value = '';
    show($('#dlg-auth'));
    if (a.pw) $('#auth-password').focus();
  }
  $('#auth-cancel').onclick = () => endSession();
  $('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const s = V, pw = $('#auth-password').value;
    if (!s || !s.auth || !pw) return;
    s.remembered = $('#auth-remember').checked;
    $('#auth-error').textContent = 'Logging in…';
    const r = await backend.rpc('auth_proof', { id: s.id, salt: s.auth.salt, nonce: s.auth.nonce, fps: fingerprints(s.pc), password: pw, remember: s.remembered });
    s.peer.sendJSON({ t: 'auth_pw', proof: r.proof });
  };

  // ---- session view
  function startViewing(s, m) {
    s.state = 'active'; s.perms = m.perms; s.name = m.name || s.name;
    s.control = !!m.perms.control;
    show($('#dlg-auth'), false); connStatus('');
    show($('#home'), false); show($('#session'));
    $('#s-title').textContent = `${s.name} (${fmtId(s.id)})`;
    $('#s-monitor').replaceChildren(...m.monitors.map((mon, i) => h('option', { value: i, textContent: `Display ${i + 1} (${mon.w}×${mon.h})` })));
    show($('#s-monitor'), m.monitors.length > 1);
    $('#s-quality').value = s.quality; $('#s-view').value = s.view;
    $('#s-control').disabled = !m.perms.control;
    show($('#s-files'), !!m.perms.files);
    $('#chat-log').replaceChildren();
    canvas.width = canvas.height = 0;
    updateControl(s);
    s.peer.sendJSON({ t: 'start', monitor: 0, quality: s.quality });
    backend.rpc('recent_touch', { id: s.id, name: s.name }).then(setCfg);
    if (m.perms.clipboard) backend.rpc('clip_watch', { on: true });
    s.tick = setInterval(() => stats(s), 1000);
    $('#viewport').focus();
  }
  backend.on.clipboard = m => { if (V && V.state === 'active' && V.perms.clipboard) V.peer.sendJSON({ t: 'clip', text: m.text }); };

  function onFrame(s, u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const seq = dv.getUint32(1, true), sw = dv.getUint16(6, true), sh = dv.getUint16(8, true), n = dv.getUint8(10);
    const jobs = [];
    let off = 11;
    for (let i = 0; i < n; i++) {
      const x = dv.getUint16(off, true), y = dv.getUint16(off + 2, true), len = dv.getUint32(off + 8, true);
      off += 12;
      jobs.push(createImageBitmap(new Blob([u8.subarray(off, off + len)], { type: 'image/jpeg' })).then(bm => ({ x, y, bm })));
      off += len;
    }
    s.bytes += u8.length;
    s.chain = s.chain.then(async () => {
      const tiles = await Promise.all(jobs);
      if (V !== s) return;
      if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; layout(); }
      for (const t of tiles) { ctx.drawImage(t.bm, t.x, t.y); t.bm.close(); }
      s.frames++;
      s.peer.sendJSON({ t: 'ack', seq });
    }).catch(() => { s.peer.sendJSON({ t: 'ack', seq }); });
  }

  function layout() {
    const vp = $('#viewport'), st = $('#stage'), cw = canvas.width, ch = canvas.height;
    if (!V || !cw) return;
    vp.style.overflow = V.view === 'original' ? 'auto' : 'hidden';
    const W = vp.clientWidth, H = vp.clientHeight;
    let w, hh;
    if (V.view === 'original') { w = cw / devicePixelRatio; hh = ch / devicePixelRatio; }
    else if (V.view === 'stretch') { w = W; hh = H; }
    else { const k = Math.min(W / cw, H / ch); w = cw * k; hh = ch * k; }
    st.style.width = w + 'px'; st.style.height = hh + 'px';
    drawCursor(V);
  }
  addEventListener('resize', layout);

  function drawCursor(s) {
    const c = $('#rcursor'), cur = s.cur;
    // Hide the remote pointer while we are the ones moving it (our own pointer is already there).
    const mine = s.control && performance.now() - s.lastMove < 700;
    const on = cfg.display.show_cursor && cur && cur.x >= 0 && !mine;
    show(c, !!on);
    if (on) c.style.transform = `translate(${cur.x * canvas.clientWidth}px, ${cur.y * canvas.clientHeight}px)`;
  }

  async function stats(s) {
    s.peer.sendJSON({ t: 'ping', ts: performance.now() });
    try {
      const st = await s.pc.getStats();
      let pair = null;
      st.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
      const local = pair && st.get(pair.localCandidateId), remote = pair && st.get(pair.remoteCandidateId);
      if (local && remote) s.route = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'Relayed' : 'Direct';
    } catch (e) {}
    $('#s-stats').textContent = `${s.route} · ${s.frames} fps · ${(s.bytes * 8 / 1e6).toFixed(1)} Mbit/s · ${s.rtt} ms`;
    s.frames = s.bytes = 0;
    drawCursor(s);
  }

  // ---- toolbar
  function updateControl(s) {
    const b = $('#s-control');
    b.textContent = !s.perms.control ? 'View only' : s.control ? 'Control: on' : 'Control: off';
    b.classList.toggle('off', !s.control);
    canvas.style.cursor = s.control ? 'default' : 'not-allowed';
  }
  $('#s-control').onclick = () => { if (!V) return; V.control = !V.control; if (!V.control) V.peer.sendJSON({ t: 'relk' }); updateControl(V); };
  $('#s-monitor').onchange = e => V && V.peer.sendJSON({ t: 'set', monitor: +e.target.value });
  $('#s-quality').onchange = e => { if (V) { V.quality = e.target.value; V.peer.sendJSON({ t: 'set', quality: V.quality }); } };
  $('#s-view').onchange = e => { if (V) { V.view = e.target.value; layout(); } };
  $('#s-full').onclick = async () => {
    const r = await backend.rpc('fullscreen');
    if (r.native) { if (V) V.full = !V.full; }
    else if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
    setTimeout(layout, 300);
  };
  const COMBOS = {
    taskmgr: ['ControlLeft', 'ShiftLeft', 'Escape'], alttab: ['AltLeft', 'Tab'], win: ['MetaLeft'],
    winD: ['MetaLeft', 'KeyD'], winR: ['MetaLeft', 'KeyR'],
  };
  $('#s-actions').onchange = async e => {
    const v = e.target.value;
    e.target.value = '';
    if (!V) return;
    if (v === 'screenshot') {
      const r = await backend.rpc('save_screenshot', { b64: canvas.toDataURL('image/png').split(',')[1] });
      return toast('Screenshot saved to ' + r.path, 5000);
    }
    if (!V.perms.control) return toast('This session is view only.');
    if (v === 'lock') V.peer.sendJSON({ t: 'lock' });
    else if (COMBOS[v]) V.peer.sendJSON({ t: 'combo', keys: COMBOS[v] });
  };

  // ---- chat (viewer side)
  $('#s-chat').onclick = () => { $('#chat').classList.toggle('hidden'); layout(); };
  $('#chat-close').onclick = () => { show($('#chat'), false); layout(); };
  $('#chat-form').onsubmit = e => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text || !V) return;
    $('#chat-input').value = '';
    V.peer.sendJSON({ t: 'chat', text });
    addMsg($('#chat-log'), text, true);
  };

  // ---- remote input
  const canControl = () => V && V.state === 'active' && V.control && V.perms.control;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }
  canvas.addEventListener('pointermove', e => {
    if (!canControl()) return;
    const now = performance.now();
    if (now - V.lastMove < 14) return;
    V.lastMove = now;
    V.peer.sendJSON({ t: 'm', ...pos(e) });
  });
  canvas.addEventListener('pointerdown', e => {
    $('#viewport').focus();
    if (!canControl() || e.button > 2) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    V.lastMove = performance.now();
    V.peer.sendJSON({ t: 'b', b: e.button, d: 1, ...pos(e) });
  });
  canvas.addEventListener('pointerup', e => {
    if (!canControl() || e.button > 2) return;
    e.preventDefault();
    V.peer.sendJSON({ t: 'b', b: e.button, d: 0, ...pos(e) });
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    if (!canControl()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 33 : 1;
    V.peer.sendJSON({ t: 'w', dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });
  function onKey(e, down) {
    if (!canControl() || document.querySelector('.overlay:not(.hidden)')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    if (down && e.repeat && /^(Shift|Control|Alt|Meta)/.test(e.code)) return;
    V.peer.sendJSON({ t: 'k', c: e.code, k: e.key, d: down ? 1 : 0 });
  }
  addEventListener('keydown', e => onKey(e, true));
  addEventListener('keyup', e => onKey(e, false));
  addEventListener('blur', () => { if (V && V.state === 'active') V.peer.sendJSON({ t: 'relk' }); });

  // ====================================================================
  // File transfer (viewer side): two panes and a sequential queue
  // ====================================================================
  const panes = {};
  for (const which of ['local', 'remote']) {
    const root = $('#pane-' + which), p = panes[which] = { path: '', parent: null, sel: new Map(), root };
    $('[data-act=up]', root).onclick = () => p.parent != null && loadPane(which, p.parent);
    $('[data-act=refresh]', root).onclick = () => loadPane(which, p.path);
    $('[data-act=path]', root).onchange = e => loadPane(which, e.target.value.trim());
  }
  function remoteList(path) {
    const s = V, rid = ++s.rid;
    s.peer.sendJSON({ t: 'fs_list', rid, path });
    return new Promise((res, rej) => s.lists.set(rid, { res, rej }));
  }
  async function loadPane(which, path) {
    const p = panes[which], list = $('.list', p.root);
    let r;
    try { r = which === 'local' ? await backend.rpc('fs_list', { path }) : await remoteList(path); }
    catch (e) { return toast(e.message); }
    p.path = r.path; p.parent = r.parent; p.sel.clear();
    $('[data-act=path]', p.root).value = r.path;
    list.replaceChildren(...r.entries.map(f => {
      const row = h('div', { class: 'f' }, h('span', { textContent: f.d ? '📁' : '📄' }), h('span', { class: 'n', textContent: f.n, title: f.n }),
        h('span', { class: 's', textContent: f.d ? '' : fmtSize(f.s) }));
      row.ondblclick = () => {
        if (f.d) return loadPane(which, f.p);
        p.sel.clear(); p.sel.set(f.p, f);
        enqueue(which === 'local' ? 'up' : 'down');
      };
      row.onclick = e => {
        if (f.d) return MOBILE ? loadPane(which, f.p) : undefined;  // touch: one tap opens a folder
        if (!e.ctrlKey && !MOBILE) { p.sel.clear(); $$('.sel', list).forEach(x => x.classList.remove('sel')); }
        if (p.sel.has(f.p)) { p.sel.delete(f.p); row.classList.remove('sel'); } else { p.sel.set(f.p, f); row.classList.add('sel'); }
      };
      return row;
    }));
    if (!r.entries.length) list.append(h('div', { class: 'empty', textContent: 'Empty folder' }));
  }
  $('#s-files').onclick = () => { show($('#dlg-files')); if (!$('#pane-local .list').children.length) { loadPane('local', ''); loadPane('remote', ''); } };
  $('#files-close').onclick = () => show($('#dlg-files'), false);

  const queue = [];
  let queueBusy = false;
  // Queue one transfer; resolves when it finished. Job: {dir:'up'|'down', name, size, destDir, src | file, clip?, rel?}
  function addJob(job) {
    job.bar = h('progress', { max: 1, value: 0 });
    job.note = h('span', { textContent: 'waiting' });
    job.el = h('div', { class: 'xfer' }, h('span', { textContent: job.dir === 'up' ? '→' : '←' }), h('span', { class: 'n', textContent: job.rel || job.name }), job.bar, job.note);
    $('#xfers').prepend(job.el);
    const done = new Promise((res, rej) => { job.res = res; job.rej = rej; });
    queue.push(job);
    runQueue();
    return done;
  }
  function enqueue(dir) {
    const from = panes[dir === 'up' ? 'local' : 'remote'], to = panes[dir === 'up' ? 'remote' : 'local'];
    if (!from.sel.size) return toast('Select one or more files first (Ctrl+click for several).');
    if (!to.path) return toast('Open a destination folder on the other side first.');
    for (const f of from.sel.values()) {
      addJob({ dir, src: f.p, name: f.n, size: f.s, destDir: to.path })
        .then(() => V && loadPane(dir === 'up' ? 'remote' : 'local', to.path), () => {});
    }
  }
  $('#btn-upload').onclick = async () => {
    if (!MOBILE) return enqueue('up');
    const s = V, dest = panes.remote.path || '', files = await MOBILE.pickFiles();  // Android file picker
    if (!s || V !== s) return;
    for (const f of files) addJob({ dir: 'up', file: f, name: f.name, size: f.size, destDir: dest }).then(() => V === s && loadPane('remote', panes.remote.path), () => {});
  };
  $('#btn-download').onclick = () => enqueue('down');
  async function runQueue() {
    if (queueBusy) return;
    queueBusy = true;
    while (queue.length) {
      const job = queue.shift(), s = V;
      job.progress = n => { job.bar.value = job.size ? n / job.size : 0; job.note.textContent = `${fmtSize(n)} / ${fmtSize(job.size)}`; };
      try {
        if (!s || s.state !== 'active') throw new Error('Session ended');
        await (job.dir === 'up' ? upload(s, job) : download(s, job));
        job.bar.value = 1; job.note.textContent = 'done';
        job.res();
      } catch (e) { job.el.classList.add('err'); job.note.textContent = e.message; job.rej(e); }
    }
    queueBusy = false;
  }
  async function upload(s, job) {
    const xid = ++s.xid;
    s.peer.sendJSON({ t: 'put_start', xid, dir: job.destDir || '', name: job.name, size: job.size, clip: job.clip, rel: job.rel });
    await waitFor(s, 'put_ok', xid);
    let sent = 0, fh = null;
    const push = async bytes => {
      const msg = new Uint8Array(bytes.length + 5);
      msg[0] = 0x44;
      new DataView(msg.buffer).setUint32(1, xid, true);
      msg.set(bytes, 5);
      if (V !== s) throw new Error('Session ended');
      s.peer.sendRaw(msg);
      sent += bytes.length;
      job.progress(sent);
      await s.peer.drain();
    };
    try {
      if (job.file) {  // dropped onto the window: read through the browser File API
        for (let o = 0; o < job.file.size; o += 48000) await push(new Uint8Array(await job.file.slice(o, o + 48000).arrayBuffer()));
      } else {
        const r = await backend.rpc('fopen_r', { path: job.src });
        fh = r.h; job.size = r.size;
        for (;;) {
          const { b64 } = await backend.rpc('fread', { h: fh });
          if (!b64) break;
          const bin = atob(b64), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          await push(bytes);
        }
      }
    } catch (e) { s.peer.sendJSON({ t: 'xfer_cancel', xid }); throw e; }
    finally { if (fh != null) backend.rpc('fclose', { h: fh }); }
    s.peer.sendJSON({ t: 'put_end', xid });
    await waitFor(s, 'put_done', xid);
  }

  // ---- copy & paste of files between the two desks
  // Files copied (Ctrl+C) on one side are transferred to a private folder on the other side and
  // placed on its clipboard, so Ctrl+V there pastes them like any local copy.
  let stickyEl = null;
  function sticky(text, ms) {
    if (stickyEl) stickyEl.remove();
    stickyEl = text ? h('div', { class: 'toast', textContent: text }) : null;
    if (stickyEl) { $('#toasts').append(stickyEl); if (ms) { const el = stickyEl; setTimeout(() => el.remove(), ms); } }
  }
  const plural = n => `${n} file${n === 1 ? '' : 's'}`;
  async function clipSend(s, items) {  // copied here -> paste on the remote desk
    const batch = s.clipBatch = (s.clipBatch || 0) + 1;
    sticky(`Copying ${plural(items.length)} to the remote clipboard…`);
    try {
      await Promise.all(items.map(it => addJob({ dir: 'up', src: it.p, name: it.rel, size: it.s, clip: batch, rel: it.rel })));
      if (V !== s || s.clipBatch !== batch) return;
      s.peer.sendJSON({ t: 'clip_files_set', batch });
      sticky(`${plural(items.length)} ready — press Ctrl+V on the remote desk to paste.`, 6000);
    } catch (e) { sticky('Copy to the remote desk failed: ' + e.message, 6000); }
  }
  async function clipReceive(s, items) {  // copied on the remote desk -> paste here
    const batch = s.clipIn = (s.clipIn || 0) + 1;
    sticky(`Receiving ${plural(items.length)} from the remote clipboard…`);
    try {
      const { dir } = await backend.rpc('clip_begin');
      await Promise.all(items.map(it => addJob({ dir: 'down', src: it.p, name: it.rel, size: it.s, destDir: dir, rel: it.rel })));
      if (V !== s || s.clipIn !== batch) return;
      await backend.rpc('clip_set_files', { dir });
      sticky(`${plural(items.length)} ready — press Ctrl+V on this computer to paste.`, 6000);
    } catch (e) { sticky('Copy from the remote desk failed: ' + e.message, 6000); }
  }
  backend.on.clipboard_files = m => { if (V && V.state === 'active' && V.perms.clipboard && V.perms.files) clipSend(V, m.items); };
  backend.on.notice = m => toast(m.text, 7000);

  // ---- drag files onto the remote screen -> they land on the remote Desktop
  const canDrop = e => V && V.state === 'active' && V.perms.files && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragover', e => { e.preventDefault(); show($('#drop-hint'), !!canDrop(e)); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) show($('#drop-hint'), false); });
  addEventListener('drop', e => {
    e.preventDefault();
    show($('#drop-hint'), false);
    if (!canDrop(e)) return;
    const s = V, files = [...e.dataTransfer.items].filter(i => i.kind === 'file' && !(i.webkitGetAsEntry && i.webkitGetAsEntry() && i.webkitGetAsEntry().isDirectory)).map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return toast('Folders cannot be dropped. Copy the folder (Ctrl+C) and paste it on the remote desk instead.', 6000);
    sticky(`Sending ${plural(files.length)} to the remote Desktop…`);
    Promise.all(files.map(f => addJob({ dir: 'up', file: f, name: f.name, size: f.size, destDir: '' })))
      .then(() => V === s && sticky(`${plural(files.length)} placed on the remote Desktop.`, 5000), err => sticky('Sending failed: ' + err.message, 6000));
  });

  async function download(s, job) {
    const xid = ++s.xid;
    const { h: fh } = await backend.rpc('fopen_w', { dir: job.destDir, name: job.name, rel: job.rel });
    let ok = false;
    try {
      s.downloads.set(xid, { h: fh, n: 0, bytes: 0, job });
      s.peer.sendJSON({ t: 'get_start', xid, path: job.src });
      ok = !!(await waitFor(s, 'get_end', xid)).ok;
    } finally {
      s.downloads.delete(xid);
      await backend.rpc('fclose', { h: fh, ok });
    }
    if (!ok) throw new Error('Transfer failed');
  }
  function onFileChunk(s, u8) {
    const xid = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, true), d = s.downloads.get(xid);
    if (!d) return;
    const out = new Uint8Array(u8.length);
    out[0] = 255;
    new DataView(out.buffer).setUint32(1, d.h, true);
    out.set(u8.subarray(5), 5);
    backend.sendBin(out);
    d.bytes += u8.length - 5;
    if (++d.n % 8 === 0) { s.peer.sendJSON({ t: 'get_ack', xid, n: d.n }); d.job.progress(d.bytes); }
  }

  // ====================================================================
  // Home screen, recents, settings
  // ====================================================================
  function setCfg(c) {
    cfg = c;
    $('#my-id').textContent = fmtId(c.id);
    $('#my-name').textContent = c.name;
    $('#st-interactive').textContent = c.security.interactive === 'always' ? 'Ask me' : 'Disabled';
    $('#st-unattended').textContent = c.security.has_password ? 'Password set' : 'Off';
    $('#btn-set-password').textContent = c.security.has_password ? 'Change unattended-access password…' : 'Set password for unattended access…';
    show($('#recents-empty'), !c.recents.length);
    $('#recents').replaceChildren(...c.recents.map(r => {
      const label = r.alias || r.name || fmtId(r.id);
      return h('div', { class: 'tile', onclick: () => { $('#target-id').value = fmtId(r.id); connectTo(r.id); } },
        h('div', { class: 'thumb', textContent: label.slice(0, 2).toUpperCase() }),
        h('div', { class: 'meta' }, h('b', { textContent: label, title: label }), h('span', { class: 'muted', textContent: fmtId(r.id) + (r.saved ? ' · auto-login' : '') })),
        h('div', { class: 'tile-actions' },
          h('button', { textContent: 'Rename', onclick: async e => { e.stopPropagation(); const v = await ask('Name for ' + fmtId(r.id), label); if (v != null) setCfg(await backend.rpc('recent_edit', { id: r.id, alias: v })); } }),
          r.saved ? h('button', { textContent: 'Forget login', onclick: async e => { e.stopPropagation(); setCfg(await backend.rpc('recent_edit', { id: r.id, forget: true })); } }) : null,
          h('button', { textContent: 'Remove', onclick: async e => { e.stopPropagation(); setCfg(await backend.rpc('recent_edit', { id: r.id, remove: true })); } })));
    }));
  }
  $('#btn-copy-id').onclick = async () => {
    try { await navigator.clipboard.writeText(cfg.id); } catch (e) { await backend.rpc('clip_set', { text: cfg.id }); }
    toast('Address copied');
  };

  // password dialog
  function openPassword() {
    $('#pw-1').value = $('#pw-2').value = ''; $('#pw-error').textContent = '';
    show($('#pw-remove'), cfg.security.has_password);
    show($('#dlg-password'));
    $('#pw-1').focus();
  }
  $('#btn-set-password').onclick = openPassword;
  $('#set-pw-btn').onclick = openPassword;
  $('#pw-cancel').onclick = () => show($('#dlg-password'), false);
  $('#pw-remove').onclick = async () => { setCfg(await backend.rpc('set_password', { password: '' })); fillSettings(); show($('#dlg-password'), false); toast('Unattended access is off'); };
  $('#pw-form').onsubmit = async e => {
    e.preventDefault();
    if ($('#pw-1').value !== $('#pw-2').value) return void ($('#pw-error').textContent = 'The passwords do not match.');
    try { setCfg(await backend.rpc('set_password', { password: $('#pw-1').value })); } catch (err) { return void ($('#pw-error').textContent = err.message); }
    fillSettings(); show($('#dlg-password'), false); toast('Unattended-access password saved');
  };

  // settings dialog
  const iceToText = ice => ice.map(s => [s.urls, s.username, s.credential].filter(Boolean).join(' ')).join('\n');
  function fillSettings() {
    $('#set-name').value = cfg.name;
    $('#set-autostart').checked = cfg.general.autostart;
    $('#set-interactive').value = cfg.security.interactive;
    $('#set-pw-state').textContent = cfg.security.has_password ? 'password set' : 'off';
    for (const k of ['control', 'clipboard', 'files']) $('#set-p-' + k).checked = cfg.security.perms[k];
    $('#set-quality').value = cfg.display.quality;
    $('#set-view').value = cfg.display.view;
    $('#set-cursor').checked = cfg.display.show_cursor;
    $('#set-brokers').value = cfg.network.brokers.join('\n');
    $('#set-ice').value = iceToText(cfg.network.ice);
    $('#about-version').textContent = 'v' + cfg.version;
    $('#about-dir').textContent = cfg.config_dir;
    $('#set-error').textContent = '';
  }
  $('#btn-settings').onclick = () => { fillSettings(); show($('#dlg-settings')); };
  $('#set-cancel').onclick = () => show($('#dlg-settings'), false);
  $('#set-nav').onclick = e => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    $$('#set-nav button').forEach(b => b.classList.toggle('active', b === e.target));
    $$('.set-body section').forEach(s => show(s, s.dataset.tab === tab));
  };
  $('#set-net-reset').onclick = () => { $('#set-brokers').value = ''; $('#set-ice').value = ''; toast('Defaults are restored when you save.'); };
  $('#set-save').onclick = async () => {
    const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean);
    const patch = {
      name: $('#set-name').value,
      general: { autostart: $('#set-autostart').checked },
      security: { interactive: $('#set-interactive').value, perms: { control: $('#set-p-control').checked, clipboard: $('#set-p-clipboard').checked, files: $('#set-p-files').checked } },
      display: { quality: $('#set-quality').value, view: $('#set-view').value, show_cursor: $('#set-cursor').checked },
      network: { brokers: lines('#set-brokers'), ice: lines('#set-ice').map(l => { const [urls, username, credential] = l.split(/\s+/); return { urls, username, credential }; }) },
    };
    if (patch.general.autostart === cfg.general.autostart) delete patch.general;
    const before = JSON.stringify(cfg.network);
    try { setCfg(await backend.rpc('set_config', { patch })); } catch (e) { return void ($('#set-error').textContent = e.message); }
    if (JSON.stringify(cfg.network) !== before) signal.start();
    show($('#dlg-settings'), false);
    toast('Settings saved');
  };

  // ---------------------------------------------------------------- start
  (async () => {
    try { await backend.connect(); } catch (e) { return show($('#fatal')); }
    setCfg(await backend.rpc('get_state'));
    signal.start();
    if (!MOBILE) $('#target-id').focus();
    window.__opendesk = { get cfg() { return cfg; }, get session() { return V; }, signal, hostPeers };
  })();
})();
