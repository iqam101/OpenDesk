// OpenDesk for Android. Loaded before app.js inside the app's WebView.
// It stands in for the Windows backend (settings, login proof, files, clipboard) and adds
// touch and on-screen-keyboard input. A phone can control PCs; it cannot be controlled.
(() => {
  'use strict';
  const N = window.OpenDeskNative || null;  // Java bridge; absent when the page is opened in a desktop browser for testing
  const $ = s => document.querySelector(s);
  const enc = new TextEncoder();
  const KEY = 'opendesk.config', VERSION = '2.0.0';
  const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const QUALITY = ['quality', 'balanced', 'speed'];
  const LOCAL_DIR = 'Download/OpenDesk (this device)';

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const unhex = s => Uint8Array.from(String(s).match(/../g) || [], x => parseInt(x, 16));
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
  }
  function toast(text, ms = 4000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms);
  }
  function saveBlob(parts, name, type) {  // browser fallback only
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(parts, { type: type || 'application/octet-stream' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // ------------------------------------------------------------ settings
  let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { data = {}; }
  if (!/^\d{9}$/.test(data.id)) data.id = String(100000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000000);
  if (!data.name) data.name = (N && N.deviceName()) || 'Android device';
  data.display = Object.assign({ quality: 'balanced', show_cursor: true }, data.display, { view: 'fit' });
  data.network = Object.assign({ brokers: DEFAULT_BROKERS, ice: DEFAULT_ICE }, data.network);
  if (!Array.isArray(data.recents)) data.recents = [];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} };
  save();
  const pub = () => ({
    version: VERSION, id: data.id, name: data.name, config_dir: 'App storage on this device',
    security: { interactive: 'never', has_password: false, perms: { control: true, clipboard: true, files: true } },
    display: { ...data.display }, network: { brokers: [...data.network.brokers], ice: [...data.network.ice] },
    general: { autostart: false },
    recents: data.recents.map(r => ({ id: r.id, name: r.name || '', alias: r.alias || '', last: r.last || 0, saved: !!r.key })),
  });
  function recent(id, create) {
    id = String(id).replace(/\D/g, '').slice(0, 12);
    let r = data.recents.find(x => x.id === id);
    if (!r && create && id) data.recents.unshift(r = { id });
    return r || null;
  }

  // Same login proof as server.py: PBKDF2-SHA256 (150k) key, HMAC over nonce and both DTLS fingerprints.
  async function deriveKey(password, salt) {
    const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 150000 }, k, 256));
  }
  async function makeProof(keyHex, nonce, fps) {
    const msg = enc.encode(nonce + '|' + fps.map(f => String(f).toUpperCase()).sort().join('|'));
    const k = await crypto.subtle.importKey('raw', unhex(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', k, msg));
  }

  // ------------------------------------------------------------ files being received
  const writes = new Map();  // handle -> { native } | { parts, name }
  let nextHandle = 1;
  const cleanName = n => String(n || 'file').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file';

  let backend = null, lastClip = null;
  const rpc = {
    get_state: () => pub(),
    set_config({ patch }) {
      if ('name' in patch) data.name = String(patch.name).trim().slice(0, 64) || (N && N.deviceName()) || 'Android device';
      const d = patch.display || {};
      if (QUALITY.includes(d.quality)) data.display.quality = d.quality;
      if ('show_cursor' in d) data.display.show_cursor = !!d.show_cursor;
      const net = patch.network || {};
      if (Array.isArray(net.brokers)) {
        const b = net.brokers.map(x => String(x).trim()).filter(x => x.startsWith('wss://')).slice(0, 8);
        data.network.brokers = b.length ? b : DEFAULT_BROKERS;
      }
      if (Array.isArray(net.ice)) {
        const ice = [];
        for (const s of net.ice.slice(0, 8)) {
          const urls = String(s.urls || '').trim();
          if (!/^(stun|turns?):/.test(urls)) continue;
          ice.push(s.username ? { urls, username: String(s.username), credential: String(s.credential || '') } : { urls });
        }
        data.network.ice = ice.length ? ice : DEFAULT_ICE;
      }
      save();
      return pub();
    },
    set_password() { throw new Error('This device cannot be controlled, so it needs no password.'); },
    recent_touch({ id, name }) {
      const r = recent(id, true);
      if (r) {
        if (name) r.name = String(name).slice(0, 64);
        r.last = Math.floor(Date.now() / 1000);
        data.recents = [r, ...data.recents.filter(x => x !== r)].slice(0, 40);
        save();
      }
      return pub();
    },
    recent_edit({ id, alias, remove, forget }) {
      const r = recent(id);
      if (r) {
        if (remove) data.recents = data.recents.filter(x => x !== r);
        if (alias != null) r.alias = String(alias).slice(0, 64);
        if (forget) { delete r.key; delete r.salt; }
        save();
      }
      return pub();
    },
    async auth_proof({ id, salt, nonce, fps, password, remember }) {
      const r = recent(id, true);
      let key;
      if (password != null) {
        key = await deriveKey(password, salt);
        if (remember && r) { r.key = key; r.salt = salt; }
      } else if (r && r.key && r.salt === salt) key = r.key;
      else { save(); return { proof: null }; }
      save();
      return { proof: await makeProof(key, nonce, fps) };
    },
    incoming_reply: () => true, session_end: () => true, chat_send: () => true,
    clip_watch({ on }) { if (N) N.clipWatch(!!on); return true; },
    clip_set({ text }) {
      lastClip = String(text);
      if (N) N.clipSet(lastClip);
      else if (navigator.clipboard) navigator.clipboard.writeText(lastClip).catch(() => {});
      return true;
    },
    clip_begin() { throw new Error('Copying files through the clipboard is not available on Android.'); },
    clip_set_files() { throw new Error('Copying files through the clipboard is not available on Android.'); },
    fullscreen() { if (N) { N.fullscreen(); return { native: true }; } return { native: false }; },
    save_screenshot({ b64: png }) {
      const name = 'OpenDesk-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png';
      if (N) {
        const path = N.saveImage(png, name);
        if (!path) throw new Error('Could not save the screenshot.');
        return { path };
      }
      saveBlob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], name, 'image/png');
      return { path: name };
    },
    fs_list: () => ({ path: LOCAL_DIR, parent: null, entries: [] }),
    fopen_r() { throw new Error('Use "Send files" to pick files on this device.'); },
    fread: () => ({ b64: '' }),
    fopen_w({ name, rel }) {
      const clean = cleanName(rel || name), h = nextHandle++;
      if (N) {
        const native = N.fileOpen(clean);
        if (native < 0) throw new Error('Could not create the file on this device.');
        writes.set(h, { native });
      } else writes.set(h, { parts: [], name: clean });
      return { h };
    },
    fclose({ h, ok }) {
      const w = writes.get(h);
      if (!w) return true;
      writes.delete(h);
      if (N) {
        const path = N.fileClose(w.native, !!ok && !w.failed);
        if (ok && path) toast('Saved to ' + path, 5000);
        else if (ok) throw new Error('Could not save the file on this device.');
      } else if (ok) saveBlob(w.parts, w.name);
      return true;
    },
  };

  const M = window.OpenDeskMobile = {
    connect(b) { backend = b; return Promise.resolve(); },
    rpc(m, a) {
      return new Promise((res, rej) => {
        if (!rpc[m]) return rej(new Error('Not available on Android: ' + m));
        try { Promise.resolve(rpc[m](a || {})).then(res, rej); } catch (e) { rej(e); }
      });
    },
    send(o) { if (o && o.op === 'log') console.warn('[opendesk]', o.msg); },
    sendBin(u8) {  // [255][handle u32 LE][file data]
      if (u8[0] !== 255) return;
      const w = writes.get(new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, true));
      if (!w) return;
      const body = u8.subarray(5);
      if (w.parts) w.parts.push(body.slice());
      else if (!w.failed && !N.fileWrite(w.native, b64(body))) w.failed = true;
    },
    pickFiles() {
      return new Promise(res => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = () => res([...input.files]);
        input.click();
      });
    },
    onClip(text) {  // called from Java when this device's clipboard text changed
      text = String(text);
      if (!text || text === lastClip || text.length > 200000) return;
      lastClip = text;
      if (backend && backend.on.clipboard) backend.on.clipboard({ text });
    },
    onBack() {  // Android back button; true = handled
      const closers = { 'dlg-files': '#files-close', 'dlg-settings': '#set-cancel', 'dlg-password': '#pw-cancel', 'dlg-auth': '#auth-cancel' };
      for (const [id, btn] of Object.entries(closers)) if (!$('#' + id).classList.contains('hidden')) { $(btn).click(); return true; }
      if (document.activeElement === kb) { kb.blur(); return true; }
      if (!$('#chat').classList.contains('hidden')) { $('#chat-close').click(); return true; }
      if (session()) { toast('Tap Disconnect to end the session.'); return true; }
      return false;
    },
  };

  // ------------------------------------------------------------ page tweaks
  document.documentElement.classList.add('mobile');
  const hide = el => el && el.classList.add('hidden');
  hide($('.this-desk'));
  hide($('#set-nav [data-tab=security]'));
  hide($('#set-autostart').closest('.check'));
  hide($('#set-view').closest('.field'));
  hide($('#s-view'));
  $('#set-name').closest('.field').firstChild.textContent = 'Device name (shown to people you connect to)';
  $('#recents-empty').textContent = 'Enter the address shown in OpenDesk on the PC you want to control, then tap Connect.';
  $('#btn-upload').textContent = 'Send files from this device…';
  $('#btn-download').textContent = 'Save selected here';
  $('#dlg-files .tip').textContent = 'Tap a folder to open it and tap files to select them. Received files are saved to Download/OpenDesk on this device; sent files go to the folder shown above (or the remote Desktop).';
  $('#fatal p').textContent = 'Please close and reopen OpenDesk.';

  // ------------------------------------------------------------ touch input
  const canvas = $('#screen'), stage = $('#stage'), vp = $('#viewport');
  const session = () => { const o = window.__opendesk, s = o && o.session; return s && s.state === 'active' ? s : null; };
  const controls = s => s && s.control && s.perms.control;
  const send = o => { const s = session(); if (controls(s)) s.peer.sendJSON(o); };
  const clamp01 = v => Math.min(1, Math.max(0, v));
  function norm(p) {
    const r = canvas.getBoundingClientRect();
    return { x: clamp01((p.x - r.left) / r.width), y: clamp01((p.y - r.top) / r.height) };
  }
  const click = (b, p) => { const n = norm(p); send({ t: 'b', b, d: 1, ...n }); send({ t: 'b', b, d: 0, ...n }); };

  // Local zoom (pinch) and pan of the remote picture.
  let zoom = 1, tx = 0, ty = 0, zoomFor = null;
  function basePos() {  // where the stage sits inside the viewport before our transform
    const r = stage.getBoundingClientRect(), v = vp.getBoundingClientRect();
    return { x: r.left - tx - v.left, y: r.top - ty - v.top, vx: v.left, vy: v.top };
  }
  function applyView() {
    const b = basePos(), W = vp.clientWidth, H = vp.clientHeight, w = stage.offsetWidth * zoom, h = stage.offsetHeight * zoom;
    tx = w <= W ? (W - w) / 2 - b.x : Math.min(-b.x, Math.max(W - w - b.x, tx));
    ty = h <= H ? (H - h) / 2 - b.y : Math.min(-b.y, Math.max(H - h - b.y, ty));
    stage.style.transformOrigin = '0 0';
    stage.style.transform = zoom === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${zoom})`;
  }
  const resetView = () => { zoom = 1; tx = ty = 0; stage.style.transform = ''; };
  addEventListener('resize', () => setTimeout(applyView, 50));

  const pts = new Map();
  let g = null, lastTap = { t: 0, x: 0, y: 0 }, lastSent = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const two = () => { const [a, b] = [...pts.values()]; return { d: dist(a, b), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };
  function endOne(p) {
    if (!g || g.mode !== 'one') return;
    clearTimeout(g.timer);
    if (g.dragging) send({ t: 'b', b: 0, d: 0, ...norm(p) });
  }
  function onDown(e) {
    if (e.pointerType !== 'touch') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const s = session();
    if (!s) return;
    if (zoomFor !== s) { zoomFor = s; resetView(); }
    const p = { x: e.clientX, y: e.clientY }, now = performance.now();
    pts.set(e.pointerId, p);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    if (pts.size === 1) {
      const dbl = now - lastTap.t < 350 && dist(lastTap, p) < 40;
      const mine = g = { mode: 'one', start: { ...p }, t: now, moved: false, dbl, dragging: false, long: false };
      send({ t: 'm', ...norm(p) });
      if (!dbl) g.timer = setTimeout(() => {  // long press = right click
        if (g !== mine || mine.moved) return;
        mine.long = true;
        click(2, mine.start);
        if (navigator.vibrate) navigator.vibrate(25);
      }, 550);
    } else if (pts.size === 2) {
      endOne(p);
      const t = two();
      g = { mode: 'two', kind: null, d0: t.d, c0: t.c, last: t.c, z0: zoom, t: now, ax: 0, ay: 0 };
    } else g = { mode: 'none' };
  }
  function onMove(e) {
    if (e.pointerType !== 'touch') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const p = pts.get(e.pointerId);
    if (!p || !g) return;
    p.x = e.clientX; p.y = e.clientY;
    const now = performance.now();
    if (g.mode === 'one') {
      if (!g.moved && dist(g.start, p) > 10) {
        g.moved = true;
        clearTimeout(g.timer);
        if (g.dbl && !g.long) { g.dragging = true; send({ t: 'b', b: 0, d: 1, ...norm(g.start) }); }  // double-tap and drag
      }
      if (g.moved && now - lastSent > 14) { lastSent = now; send({ t: 'm', ...norm(p) }); }
    } else if (g.mode === 'two' && pts.size === 2) {
      const t = two();
      if (!g.kind) {
        if (Math.abs(t.d - g.d0) > 24) g.kind = 'zoom';
        else if (dist(t.c, g.c0) > 10) g.kind = 'scroll';
      }
      if (g.kind === 'zoom') {  // pinch zooms around the fingers; moving both fingers pans
        const b = basePos();
        const cx = (g.last.x - b.vx - b.x - tx) / zoom, cy = (g.last.y - b.vy - b.y - ty) / zoom;
        zoom = Math.min(6, Math.max(1, g.z0 * t.d / g.d0));
        tx = t.c.x - b.vx - b.x - cx * zoom;
        ty = t.c.y - b.vy - b.y - cy * zoom;
        applyView();
      } else if (g.kind === 'scroll') {  // two-finger drag = mouse wheel, content follows the fingers
        g.ax += g.last.x - t.c.x; g.ay += g.last.y - t.c.y;
        if (now - lastSent > 30 && (Math.abs(g.ax) > 2 || Math.abs(g.ay) > 2)) {
          lastSent = now;
          send({ t: 'w', dx: Math.abs(g.ax) > Math.abs(g.ay) ? g.ax * 4 : 0, dy: Math.abs(g.ay) >= Math.abs(g.ax) ? g.ay * 4 : 0 });
          g.ax = g.ay = 0;
        }
      }
      g.last = t.c;
    }
  }
  function onUp(e) {
    if (e.pointerType !== 'touch') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    const now = performance.now();
    if (g && g.mode === 'one') {
      endOne(p);
      if (e.type === 'pointerup' && !g.moved && !g.long && now - g.t < 500) { click(0, p); lastTap = { t: now, x: p.x, y: p.y }; }
      else lastTap.t = 0;
    } else if (g && g.mode === 'two') {
      if (!g.kind && now - g.t < 300 && e.type === 'pointerup') click(2, g.c0);  // two-finger tap = right click
      g = { mode: 'none' };
    }
    if (!pts.size) g = null;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  // Stops the browser's own synthetic mouse events and keeps the on-screen keyboard open while touching the screen.
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });

  // ------------------------------------------------------------ on-screen keyboard
  // A hidden text box collects what the Android keyboard produces; each change is replayed
  // on the PC as backspaces plus the new characters, so autocorrect and swipe typing work.
  const SENT = '\n'.repeat(8);
  const kb = document.createElement('textarea');
  kb.id = 'kb-input';
  for (const [k, v] of Object.entries({ autocapitalize: 'none', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Remote keyboard' })) kb.setAttribute(k, v);
  const bar = document.createElement('div');
  bar.id = 'kb-bar';
  bar.className = 'hidden';
  document.body.append(kb, bar);
  let prev = SENT, composing = false;
  const mods = { ControlLeft: false, AltLeft: false, ShiftLeft: false };
  const tap = code => { send({ t: 'k', c: code, k: null, d: 1 }); send({ t: 'k', c: code, k: null, d: 0 }); };
  function withMods(fn) {
    const on = Object.keys(mods).filter(k => mods[k]);
    on.forEach(c => send({ t: 'k', c, k: null, d: 1 }));
    fn();
    on.reverse().forEach(c => send({ t: 'k', c, k: null, d: 0 }));
    if (on.length) { on.forEach(c => { mods[c] = false; }); paintMods(); }
  }
  function typeChar(ch) {
    if (ch === '\n') return withMods(() => tap('Enter'));
    const anyMod = mods.ControlLeft || mods.AltLeft;
    const code = /^[a-z]$/i.test(ch) ? 'Key' + ch.toUpperCase() : /^\d$/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : '';
    if (anyMod && code) return withMods(() => tap(code));  // shortcuts such as Ctrl+C need real key codes
    withMods(() => { send({ t: 'k', c: '', k: ch, d: 1 }); send({ t: 'k', c: '', k: ch, d: 0 }); });
  }
  function resetKb() { kb.value = prev = SENT; try { kb.setSelectionRange(SENT.length, SENT.length); } catch (e) {} }
  kb.addEventListener('compositionstart', () => { composing = true; });
  kb.addEventListener('compositionend', () => { composing = false; if (kb.value.length > 300 || kb.value.length < 4) resetKb(); });
  kb.addEventListener('input', () => {
    const v = kb.value;
    let i = 0;
    while (i < prev.length && i < v.length && prev[i] === v[i]) i++;
    for (let n = prev.length - i; n > 0; n--) tap('Backspace');
    for (const ch of v.slice(i).split('')) typeChar(ch);
    prev = v;
    if (!composing && (v.length > 300 || v.length < 4)) resetKb();
  });
  const HARD = /^(Arrow(Left|Right|Up|Down)|Escape|Tab|Delete|Home|End|PageUp|PageDown|Insert|F\d{1,2})$/;
  kb.addEventListener('keydown', e => {  // physical keyboards: keys that produce no text
    if (!HARD.test(e.code)) return;
    e.preventDefault();
    withMods(() => tap(e.code));
  });
  const showKb = () => { resetKb(); bar.classList.remove('hidden'); };
  kb.value = SENT;
  kb.addEventListener('focus', showKb);
  kb.addEventListener('blur', () => {
    bar.classList.add('hidden');
    const s = session();
    if (s) s.peer.sendJSON({ t: 'relk' });
    Object.keys(mods).forEach(k => { mods[k] = false; });
    paintMods();
  });
  const KEYS = [['Esc', 'Escape'], ['Tab', 'Tab'], ['Ctrl', 'ControlLeft', 1], ['Alt', 'AltLeft', 1], ['Shift', 'ShiftLeft', 1], ['Win', 'MetaLeft'],
    ['Del', 'Delete'], ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'], ['Home', 'Home'], ['End', 'End'],
    ['PgUp', 'PageUp'], ['PgDn', 'PageDown'], ['F5', 'F5'], ['F11', 'F11']];
  function paintMods() { for (const b of bar.children) if (b.dataset.mod) b.classList.toggle('on', !!mods[b.dataset.code]); }
  for (const [label, code, mod] of KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.code = code;
    if (mod) b.dataset.mod = '1';
    // pointerdown + preventDefault keeps the keyboard open
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (mod) { mods[code] = !mods[code]; paintMods(); } else withMods(() => tap(code));
    });
    bar.append(b);
  }
  const kbBtn = document.createElement('button');
  kbBtn.className = 'tb-btn';
  kbBtn.id = 's-keyboard';
  kbBtn.textContent = 'Keyboard';
  kbBtn.onclick = () => {
    if (!controls(session())) return toast('This session is view only.');
    if (document.activeElement === kb) kb.blur(); else { kb.focus(); showKb(); }
  };
  $('#s-control').before(kbBtn);

  // First session: explain the gestures once.
  new MutationObserver(() => {
    if ($('#session').classList.contains('hidden') || data.tipped) return;
    data.tipped = true; save();
    toast('Tap = click · hold = right click · double-tap and drag = drag · two fingers = scroll · pinch = zoom', 9000);
  }).observe($('#session'), { attributes: true, attributeFilter: ['class'] });
})();
