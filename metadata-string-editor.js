/*!
 * MetadataStringEditor (browser port)
 * Edit the string literals in a Unity il2cpp global-metadata.dat entirely client-side.
 * Port of https://github.com/JeremieCHN/MetaDataStringEditor/
 *
 * Usage:
 *   // Full UI inside any element
 *   const editor = MetadataStringEditor.mount(document.getElementById('host'));
 *
 *   // Or headless / use your own UI
 *   const meta = new MetadataStringEditor.MetadataFile(arrayBuffer);
 *   meta.count;                    // number of strings
 *   meta.getString(i);             // current text (edited if edited)
 *   meta.getOriginalString(i);
 *   meta.setString(i, 'new text'); // returns true if it differs from original
 *   meta.discard(i);               // revert one string
 *   const bytes = meta.build();    // Uint8Array of the patched file
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetadataStringEditor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAGIC = 0xFAB11BAF;
  const HEADER_MIN = 24; // magic, version, tableOffset, tableSize, dataOffset, dataSize
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();

  /* ------------------------------------------------------------------ *
   * Core: parse / edit / rebuild
   * ------------------------------------------------------------------ */
  class MetadataFile {
    /** @param {ArrayBuffer|Uint8Array} input */
    constructor(input) {
      let buf = input;
      if (ArrayBuffer.isView(buf)) {
        buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      if (buf.byteLength < HEADER_MIN) throw new Error('File is too small to be a metadata file.');

      this.orig = new Uint8Array(buf);
      const v = new DataView(buf);

      if (v.getUint32(0, true) !== MAGIC) {
        throw new Error('Magic check failed: not a global-metadata.dat file.');
      }
      this.version = v.getInt32(4, true);
      this.tableOffset = v.getUint32(8, true);   // string literal table position (never changes)
      this.tableSize = v.getUint32(12, true);    // table size in bytes (never changes)
      this.dataOffset = v.getUint32(16, true);   // string data position (may change)
      this.dataSize = v.getUint32(20, true);     // string data size (may change)

      const n = Math.floor(this.tableSize / 8);
      if (this.tableOffset + n * 8 > buf.byteLength) throw new Error('String table is out of range.');

      this.literals = new Array(n);
      for (let i = 0; i < n; i++) {
        const len = v.getUint32(this.tableOffset + i * 8, true);
        const off = v.getUint32(this.tableOffset + i * 8 + 4, true);
        const start = this.dataOffset + off;
        if (start + len > buf.byteLength) throw new Error('String #' + i + ' is out of range.');
        this.literals[i] = this.orig.subarray(start, start + len); // views, no copy
      }
      this.edits = new Map(); // index -> Uint8Array
    }

    get count() { return this.literals.length; }
    get editedCount() { return this.edits.size; }

    isEdited(i) { return this.edits.has(i); }
    getBytes(i) { return this.edits.get(i) || this.literals[i]; }
    getOriginalString(i) { return decoder.decode(this.literals[i]); }
    getString(i) { return decoder.decode(this.getBytes(i)); }

    /** Set new text for string i. Returns true if it is now different from the original. */
    setString(i, text) {
      const bytes = encoder.encode(String(text).replace(/\r/g, ''));
      const o = this.literals[i];
      let same = bytes.length === o.length;
      for (let k = 0; same && k < bytes.length; k++) if (bytes[k] !== o[k]) same = false;
      if (same) this.edits.delete(i); else this.edits.set(i, bytes);
      return !same;
    }

    discard(i) { this.edits.delete(i); }
    discardAll() { this.edits.clear(); }

    /** Build the patched file. Returns a Uint8Array. */
    build() {
      const n = this.literals.length;
      const orig = this.orig;

      let total = 0;
      for (let i = 0; i < n; i++) total += this.getBytes(i).length;

      // Align data size to 4 bytes (Unity does this)
      let dataOffset = this.dataOffset;
      let size = total;
      let pad = (dataOffset + size) % 4;
      if (pad) size += 4 - pad;

      // Not enough room? If something follows the data region we can't extend it,
      // so move the whole region to the end of the file. Otherwise extend in place.
      if (size > this.dataSize && this.dataOffset + this.dataSize < orig.length) {
        dataOffset = orig.length;
        const a = dataOffset % 4;
        if (a) dataOffset += 4 - a;
        size = total;
        pad = (dataOffset + size) % 4;
        if (pad) size += 4 - pad;
      }

      const out = new Uint8Array(Math.max(orig.length, dataOffset + size));
      out.set(orig);
      const v = new DataView(out.buffer);

      // Rewrite the literal table (length, offset) and the packed string data
      let cursor = 0;
      for (let i = 0; i < n; i++) {
        const b = this.getBytes(i);
        v.setUint32(this.tableOffset + i * 8, b.length, true);
        v.setUint32(this.tableOffset + i * 8 + 4, cursor, true);
        out.set(b, dataOffset + cursor);
        cursor += b.length;
      }
      // Zero any alignment padding we own
      out.fill(0, dataOffset + cursor, dataOffset + size);

      // Update header
      v.setUint32(16, dataOffset, true);
      v.setUint32(20, size, true);
      return out;
    }
  }

  /* ------------------------------------------------------------------ *
   * UI (optional): virtualized list + edit dialog
   * ------------------------------------------------------------------ */
  const CSS = `
.mse{display:flex;flex-direction:column;gap:8px;font:14px/1.4 system-ui,sans-serif;color:inherit;min-width:0}
.mse *{box-sizing:border-box}
.mse-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mse button,.mse input[type=text],.mse textarea{font:inherit;color:inherit;background:transparent;border:1px solid rgba(128,128,128,.5);border-radius:6px;padding:5px 10px}
.mse button{cursor:pointer}.mse button:hover:not(:disabled){background:rgba(128,128,128,.18)}
.mse button:disabled{opacity:.45;cursor:default}
.mse input[type=text]{flex:1;min-width:140px}
.mse-list{position:relative;height:480px;min-height:160px;overflow:auto;border:1px solid rgba(128,128,128,.5);border-radius:6px;outline:none;resize:vertical}
.mse-head,.mse-row{display:grid;grid-template-columns:70px 1fr 1fr 22px;gap:8px;padding:0 8px;align-items:center}
.mse-head{position:sticky;top:0;z-index:2;height:28px;font-weight:600;background:Canvas;border-bottom:1px solid rgba(128,128,128,.5)}
.mse-spacer{position:relative}
.mse-row{position:absolute;left:0;right:0;height:26px;cursor:default;white-space:nowrap}
.mse-row>span{overflow:hidden;text-overflow:ellipsis}
.mse-row:hover{background:rgba(128,128,128,.12)}
.mse-row.sel{background:rgba(70,130,255,.28)}
.mse-row.edited .mse-new{color:#2a9d4a}
.mse-idx{opacity:.6;font-variant-numeric:tabular-nums}
.mse-status{opacity:.75;font-size:13px;min-height:1.4em}
.mse-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:99999}
.mse-dialog{background:Canvas;color:CanvasText;border-radius:10px;padding:16px;width:min(720px,92vw);display:flex;flex-direction:column;gap:10px;font:14px system-ui,sans-serif}
.mse-dialog textarea{width:100%;height:240px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace}
.mse-dialog .row{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
`;

  function injectCSS() {
    if (document.getElementById('mse-style')) return;
    const s = document.createElement('style');
    s.id = 'mse-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') el.className = props[k];
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), props[k]);
      else el[k] = props[k];
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  }

  const oneLine = s => s.replace(/\r/g, '').replace(/\n/g, '\u21B5').replace(/\t/g, '\u2192');
  const ROW_H = 26, HEAD_H = 28, BUFFER = 6;

  /**
   * Mount the editor UI into a container element.
   * @param {HTMLElement} host
   * @param {{height?: string}} [opts]
   */
  function mount(host, opts) {
    opts = opts || {};
    injectCSS();

    let meta = null;
    let fileName = 'global-metadata.dat';
    let selected = -1;

    const fileInput = h('input', { type: 'file', style: 'display:none' });
    const btnOpen = h('button', { textContent: 'Open…', onclick: () => fileInput.click() });
    const btnSave = h('button', { textContent: 'Save as…', disabled: true, onclick: () => save() });
    const btnClear = h('button', { textContent: 'Revert all', disabled: true, onclick: () => {
      if (meta && meta.editedCount && confirm('Revert all edits?')) { meta.discardAll(); refresh(); }
    } });
    const search = h('input', { type: 'text', placeholder: 'Search strings…', onkeydown: e => { if (e.key === 'Enter') findNext(e.shiftKey ? -1 : 1); } });
    const btnFind = h('button', { textContent: 'Next', onclick: () => findNext(1) });
    const bar = h('div', { class: 'mse-bar' }, btnOpen, btnSave, btnClear, search, btnFind, fileInput);

    const head = h('div', { class: 'mse-head' },
      h('span', { textContent: '#' }), h('span', { textContent: 'Original' }),
      h('span', { textContent: 'Edited' }), h('span'));
    const spacer = h('div', { class: 'mse-spacer' });
    const list = h('div', { class: 'mse-list', tabIndex: 0 }, head, spacer);
    if (opts.height) list.style.height = opts.height;
    const status = h('div', { class: 'mse-status', textContent: 'Open a global-metadata.dat to begin. Double-click a row to edit.' });

    const root = h('div', { class: 'mse' }, bar, list, status);
    host.appendChild(root);

    const setStatus = m => { status.textContent = m; };

    function render() {
      spacer.textContent = '';
      if (!meta) return;
      const viewH = list.clientHeight;
      const top = Math.max(0, list.scrollTop - HEAD_H);
      const first = Math.max(0, Math.floor(top / ROW_H) - BUFFER);
      const last = Math.min(meta.count, Math.ceil((top + viewH) / ROW_H) + BUFFER);
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) {
        const ed = meta.isEdited(i);
        const row = h('div', {
          class: 'mse-row' + (ed ? ' edited' : '') + (i === selected ? ' sel' : ''),
          style: 'top:' + (i * ROW_H) + 'px',
          onclick: () => select(i),
          ondblclick: () => edit(i)
        },
          h('span', { class: 'mse-idx', textContent: String(i) }),
          h('span', { textContent: oneLine(meta.getOriginalString(i)) }),
          h('span', { class: 'mse-new', textContent: ed ? oneLine(meta.getString(i)) : '' }),
          h('span', { textContent: ed ? '*' : '' }));
        frag.appendChild(row);
      }
      spacer.appendChild(frag);
    }

    function refresh() {
      spacer.style.height = meta ? (meta.count * ROW_H) + 'px' : '0';
      btnSave.disabled = !meta;
      btnClear.disabled = !meta;
      render();
      if (meta) setStatus(meta.count + ' strings, ' + meta.editedCount + ' edited \u2014 ' + fileName);
    }

    function select(i) { selected = i; render(); }

    function reveal(i) {
      const y = HEAD_H + i * ROW_H;
      if (y < list.scrollTop + HEAD_H) list.scrollTop = y - HEAD_H;
      else if (y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_H - list.clientHeight;
    }

    function findNext(dir) {
      const kw = search.value.toLowerCase();
      if (!meta || !kw) return;
      const n = meta.count;
      for (let k = 1; k <= n; k++) {
        const i = (((selected + dir * k) % n) + n) % n;
        if (meta.getOriginalString(i).toLowerCase().includes(kw) ||
            (meta.isEdited(i) && meta.getString(i).toLowerCase().includes(kw))) {
          selected = i; reveal(i); render(); return;
        }
      }
      setStatus('Search string not found.');
    }

    function edit(i) {
      if (!meta) return;
      const ta = h('textarea', { value: meta.getString(i), spellcheck: false });
      const close = () => modal.remove();
      const modal = h('div', { class: 'mse-modal', onmousedown: e => { if (e.target === modal) close(); } },
        h('div', { class: 'mse-dialog' },
          h('div', { textContent: 'Edit string #' + i }),
          ta,
          h('div', { class: 'row' },
            h('button', { textContent: 'Revert this string', onclick: () => { meta.discard(i); close(); refresh(); } }),
            h('button', { textContent: 'Cancel', onclick: close }),
            h('button', { textContent: 'Save', onclick: () => { meta.setString(i, ta.value); close(); refresh(); } }))));
      modal.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { meta.setString(i, ta.value); close(); refresh(); }
      });
      document.body.appendChild(modal);
      ta.focus();
    }

    async function loadFile(file) {
      try {
        setStatus('Loading ' + file.name + '…');
        const buf = await file.arrayBuffer();
        meta = new MetadataFile(buf);
        fileName = file.name;
        selected = -1;
        list.scrollTop = 0;
        refresh();
      } catch (err) {
        meta = null;
        refresh();
        setStatus('Error: ' + err.message);
      }
    }

    function save() {
      if (!meta) return;
      const out = meta.build();
      const url = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
      const a = h('a', { href: url, download: fileName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus('Saved ' + fileName + ' (' + out.length + ' bytes).');
    }

    fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
    list.addEventListener('scroll', render);
    new ResizeObserver(render).observe(list);
    list.addEventListener('keydown', e => {
      if (!meta) return;
      if (e.key === 'ArrowDown') { selected = Math.min(meta.count - 1, selected + 1); reveal(selected); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { selected = Math.max(0, selected - 1); reveal(selected); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && selected >= 0) { edit(selected); e.preventDefault(); }
    });
    // drag & drop a file onto the list
    list.addEventListener('dragover', e => e.preventDefault());
    list.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

    return {
      get meta() { return meta; },
      loadFile,
      loadBuffer(buf, name) { meta = new MetadataFile(buf); fileName = name || fileName; selected = -1; refresh(); },
      save,
      destroy() { root.remove(); }
    };
  }

  return { MetadataFile, mount };
});
