"use strict";

/*
 * Chữ ký lưu sẵn — the renderer half (v0.2.72).
 *
 * Set up once (Cài đặt → Chữ ký của tôi, or the picker's "Quản lý chữ ký…"), then:
 *   · right-click a page → "Chèn chữ ký: <tên>" → placed CENTRED on that spot, at once;
 *   · or the signature button on the Chú thích bar → pick → click a page.
 * The placed signature is an ordinary live image annotation — drag, resize, "Áp nhiều
 * trang" — and "Xong" is the confirmation that writes it into the file. On that bake
 * editor.js remembers the width it ended up at, so next time it comes out that size.
 *
 * WHERE THINGS LIVE, so this file stays the thin part:
 *   · storage, encryption (DPAPI), validation → src/signatures.js via window.desktop.signatures
 *   · white-background removal, trimming      → renderer/sig-image.js (pure, node-tested)
 *   · placement                               → Editor.placeSignature (editor.js)
 *   · menus                                   → Capture.showMenu (capture.js) — ONE menu widget
 * Classic script sharing app.js's global scope; reads its globals (state, $, toast,
 * uiConfirm, gateProFeature) and never writes them.
 */

(function () {
  const api = window.desktop && window.desktop.signatures;
  const SI = window.SigImage;
  const byId = (id) => document.getElementById(id);
  const tr = (vi, p) => (window.t ? window.t(vi, p) : vi);

  const MENU_MAX = 6; // signatures listed directly in a right-click menu
  const WORK_MAX_PX = 1600; // long side of a stored signature — sharp at ~5 cm when printed at 600 dpi… and small
  const STORE_MAX_BYTES = 3.5 * 1024 * 1024; // stay under src/signatures.js MAX_PNG_BYTES (4 MB) with margin

  // Last list() answer. Menus are built synchronously on right-click, so they read this
  // cache; it is refreshed at start-up and whenever ANY tab changes the store.
  let cache = { items: [], unreadable: false, encryption: true, max: 24 };

  async function refresh() {
    if (!api) return cache;
    try {
      const r = await api.list();
      if (r && r.ok) cache = r;
    } catch (_) {
      /* keep the last good list */
    }
    if (!byId("sig-modal").hidden) renderManager();
    return cache;
  }

  const REASON = {
    "no-encryption": "Máy này không mã hoá được (Windows DPAPI không sẵn sàng) nên không lưu chữ ký.",
    unreadable: "Không đọc được kho chữ ký hiện có — bấm “Tạo kho mới” trước.",
    full: "Đã đủ số chữ ký tối đa — xoá bớt một chữ ký trước.",
    "too-big": "Ảnh quá lớn — thử ảnh nhỏ hơn.",
    "not-png": "Không đọc được ảnh này — thử PNG hoặc JPG.",
    "empty-name": "Tên không được để trống.",
    "not-found": "Chữ ký này không còn nữa.",
    "write-failed": "Không ghi được kho chữ ký.",
  };
  const why = (r) => tr(REASON[r && r.reason] || "Không thực hiện được.");

  // ---- placing ---------------------------------------------------------------

  function licenseBlocked() {
    return typeof gateProFeature === "function" && gateProFeature();
  }

  async function insertAt(sig, pageIndex, pt, before) {
    if (licenseBlocked()) return;
    if (!window.Editor || !window.Editor.placeSignature) return;
    if (typeof before === "function") before();
    await window.Editor.placeSignature(sig, pageIndex, pt);
  }

  // Entries for a right-click menu on page `pageIndex` at client (cx, cy). The page
  // point is taken NOW, while the menu opens — that is the spot the user pointed at.
  // `before` lets capture.js leave its own mode before the editor takes over.
  function menuEntries(pageIndex, cx, cy, before) {
    if (!api || !state.bytes) return [];
    const pt = window.Editor && window.Editor.pagePointFromClient
      ? window.Editor.pagePointFromClient(pageIndex, cx, cy)
      : null;
    const out = [{ separator: true }];
    if (!cache.items.length) {
      out.push({ label: tr("Thêm chữ ký lưu sẵn…"), onClick: () => openManager() });
      return out;
    }
    for (const s of cache.items.slice(0, MENU_MAX)) {
      out.push({
        label: tr("Chèn chữ ký: {name}", { name: s.name }),
        icon: s.dataUrl,
        onClick: () => insertAt(s, pageIndex, pt, before),
      });
    }
    if (cache.items.length > MENU_MAX) {
      out.push({ label: tr("Chữ ký khác…"), onClick: () => openManager() });
    }
    return out;
  }

  // The Chú thích-bar button: a menu of signatures under the button; picking one arms
  // placement (the next click on a page puts it there).
  function openPicker(btn) {
    if (!window.Capture || !window.Capture.showMenu) return;
    const r = btn.getBoundingClientRect();
    const entries = [{ header: tr("Chèn chữ ký") }];
    if (!cache.items.length) {
      entries.push({ label: tr("Chưa có chữ ký nào — thêm chữ ký…"), onClick: () => openManager() });
    } else {
      for (const s of cache.items) {
        entries.push({ label: s.name, icon: s.dataUrl, onClick: () => insertAt(s, null, null) });
      }
      entries.push({ separator: true }, { label: tr("Quản lý chữ ký…"), onClick: () => openManager() });
    }
    window.Capture.showMenu(r.left, r.bottom + 4, entries);
  }

  // ---- manager dialog --------------------------------------------------------

  function setStatus(msg, kind) {
    const el = byId("sig-status");
    el.textContent = msg || "";
    el.className = "set-status" + (kind ? " " + kind : "");
  }

  function renderManager() {
    const list = byId("sig-list");
    list.innerHTML = "";
    const editing = !byId("sig-edit").hidden;
    byId("sig-reset").hidden = !cache.unreadable;
    byId("sig-add").disabled = editing || !cache.encryption || cache.unreadable || cache.items.length >= cache.max;
    if (!cache.encryption) setStatus(tr(REASON["no-encryption"]), "bad");
    else if (cache.unreadable)
      setStatus(
        tr("Không đọc được kho chữ ký (có thể do tài khoản Windows khác tạo ra). “Tạo kho mới” sẽ bắt đầu lại — file cũ được giữ nguyên bên cạnh, không bị xoá."),
        "bad"
      );
    else if (!editing) setStatus(cache.items.length ? "" : tr("Chưa có chữ ký nào. Bấm “+ Thêm chữ ký…”."));
    list.hidden = editing;
    for (const s of cache.items) {
      const row = document.createElement("div");
      row.className = "sig-row";
      const thumb = document.createElement("div");
      thumb.className = "sig-thumb sig-checker";
      const img = document.createElement("img");
      img.alt = "";
      img.src = s.dataUrl;
      thumb.appendChild(img);
      const name = document.createElement("input");
      name.type = "text";
      name.maxLength = 60;
      name.value = s.name;
      name.title = tr("Đổi tên — gõ rồi bấm Enter");
      name.onkeydown = (e) => {
        if (e.key === "Enter") name.blur();
      };
      name.onchange = async () => {
        const r = await api.rename(s.id, name.value);
        if (!r || !r.ok) {
          toast(why(r), "bad");
          name.value = s.name;
        }
      };
      const size = document.createElement("span");
      size.className = "cmp-note sig-size";
      size.textContent = `${Math.round((s.wPt * 25.4) / 72)} mm`;
      size.title = tr("Bề rộng khi chèn — tự nhớ theo lần dùng gần nhất");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost";
      del.textContent = tr("Xoá");
      del.onclick = async () => {
        if (!(await window.uiConfirm(tr("Xoá chữ ký “{name}”?", { name: s.name }), { okText: tr("Xoá"), cancelText: tr("Hủy") })))
          return;
        const r = await api.remove(s.id);
        if (!r || !r.ok) toast(why(r), "bad");
      };
      row.append(thumb, name, size, del);
      list.appendChild(row);
    }
  }

  async function openManager() {
    if (!api) return;
    closeEditor();
    byId("sig-modal").hidden = false;
    renderManager();
    await refresh();
  }

  // ---- adding one: pick → clean up → preview → save ---------------------------

  // The picked image, drawn once at working size; every option change re-derives the
  // output from THIS, never from the previous output (so toggling back is lossless).
  let src = null; // { data: ImageData, w, h }
  let outCanvas = null;

  function closeEditor() {
    src = null;
    outCanvas = null;
    byId("sig-edit").hidden = true;
    byId("sig-list").hidden = false;
  }

  function loadImage(dataUrl) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("decode"));
      img.src = dataUrl;
    });
  }

  async function beginAdd(file) {
    let img;
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(file);
      });
      img = await loadImage(dataUrl);
    } catch (_) {
      toast(tr(REASON["not-png"]), "bad");
      return;
    }
    const k = SI.fitScale(img.naturalWidth, img.naturalHeight, WORK_MAX_PX);
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    src = { data: g.getImageData(0, 0, w, h), w, h };
    // A PNG that already has a transparent background has no paper to remove.
    byId("sig-rmbg").checked = !SI.hasTransparency(src.data.data);
    byId("sig-trim").checked = true;
    byId("sig-level").value = "50";
    byId("sig-name").value = String(file.name || "").replace(/\.[^.]+$/, "").slice(0, 60);
    byId("sig-edit").hidden = false;
    renderManager();
    setStatus(tr("Xem trước trên nền caro — phần caro là trong suốt."));
    renderPreview();
  }

  function renderPreview() {
    if (!src) return;
    const rm = byId("sig-rmbg").checked;
    byId("sig-level-row").hidden = !rm;
    const px = new Uint8ClampedArray(src.data.data); // copy — src stays pristine
    if (rm) SI.removeWhiteBg(px, src.w, src.h, +byId("sig-level").value);
    let box = { x: 0, y: 0, w: src.w, h: src.h };
    if (byId("sig-trim").checked) {
      const t = SI.trimBounds(px, src.w, src.h, 2);
      if (t) box = t;
    }
    const full = document.createElement("canvas");
    full.width = src.w;
    full.height = src.h;
    full.getContext("2d").putImageData(new ImageData(px, src.w, src.h), 0, 0);
    outCanvas = document.createElement("canvas");
    outCanvas.width = box.w;
    outCanvas.height = box.h;
    outCanvas.getContext("2d").drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    const view = byId("sig-canvas");
    view.width = box.w;
    view.height = box.h;
    view.getContext("2d").drawImage(outCanvas, 0, 0);
    byId("sig-dims").textContent = `${box.w} × ${box.h} px`;
    // Nothing visible left = the strength ate the signature; say so before it is saved.
    const empty = rm && !SI.trimBounds(px, src.w, src.h, 0);
    byId("sig-edit-save").disabled = empty;
    if (empty) setStatus(tr("Độ mạnh quá cao — không còn nét nào. Kéo thanh Độ mạnh sang trái."), "bad");
    else setStatus(tr("Xem trước trên nền caro — phần caro là trong suốt."));
  }

  // PNG bytes of the output, shrunk until they fit the store's size bound. A photo of a
  // colourful stamp can exceed it at full working size; a signature never does.
  function outputDataUrl() {
    let c = outCanvas;
    let url = c.toDataURL("image/png");
    while (url.length * 0.75 > STORE_MAX_BYTES && c.width > 200) {
      const n = document.createElement("canvas");
      n.width = Math.round(c.width * 0.75);
      n.height = Math.max(1, Math.round(c.height * 0.75));
      n.getContext("2d").drawImage(c, 0, 0, n.width, n.height);
      c = n;
      url = c.toDataURL("image/png");
    }
    return url;
  }

  async function saveNew() {
    if (!outCanvas) return;
    const btn = byId("sig-edit-save");
    btn.disabled = true;
    try {
      const r = await api.add({ name: byId("sig-name").value, dataUrl: outputDataUrl() });
      if (!r || !r.ok) {
        setStatus(why(r), "bad");
        return;
      }
      closeEditor();
      await refresh();
      toast(tr("Đã lưu chữ ký. Chuột phải lên trang → Chèn chữ ký để dùng."), "good");
    } finally {
      btn.disabled = false;
    }
  }

  // ---- wiring -----------------------------------------------------------------

  if (!api || !SI) return; // bridge absent (split view, tests) — the feature simply isn't there

  byId("ed-sig").onclick = (e) => openPicker(e.currentTarget);
  byId("set-signatures").onclick = () => openManager();
  byId("sig-add").onclick = () => {
    const f = byId("sig-file");
    f.value = "";
    f.click();
  };
  byId("sig-file").onchange = () => {
    const f = byId("sig-file").files && byId("sig-file").files[0];
    if (f) beginAdd(f);
  };
  byId("sig-rmbg").onchange = renderPreview;
  byId("sig-trim").onchange = renderPreview;
  // The slider fires per pixel of travel; one frame per repaint is plenty.
  let raf = 0;
  byId("sig-level").oninput = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderPreview();
    });
  };
  byId("sig-edit-save").onclick = saveNew;
  byId("sig-edit-cancel").onclick = () => {
    closeEditor();
    renderManager();
  };
  // Closing the dialog (Đóng / ✕ / Esc / backdrop all click #sig-close) drops a
  // half-finished add rather than leaving it for the next open.
  byId("sig-close").onclick = () => {
    closeEditor();
    byId("sig-modal").hidden = true;
  };
  byId("sig-reset").onclick = async () => {
    const ok = await window.uiConfirm(
      tr("Tạo kho chữ ký mới? File cũ không đọc được sẽ được giữ nguyên bên cạnh (không xoá)."),
      { okText: tr("Tạo kho mới"), cancelText: tr("Hủy") }
    );
    if (!ok) return;
    const r = await api.reset();
    if (!r || !r.ok) toast(why(r), "bad");
    await refresh();
  };

  api.onChanged(() => refresh());
  refresh();

  window.Signatures = { menuEntries, openManager, openPicker, refresh };
})();
