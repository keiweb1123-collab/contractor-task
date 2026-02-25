// One-Tap Reporter - app.js

// =============================================================
// DATA CONFIGURATION
// =============================================================
const units = [
    "Unit1", "Unit2", "Unit3A", "Unit3B", "Unit5", "Unit6", "Unit7",
    "Unit8", "Unit9", "Unit10", "Unit11", "Unit12A", "Unit12B",
    "Unit14", "Unit15", "Unit16", "Unit17", "Unit18", "Unit19"
];

const assignments = {
    "IADECCO": ["Unit1", "Unit8", "Unit9", "Unit10", "Unit11", "Unit14", "Unit15"],
    "YAMATO": ["Unit2", "Unit3A", "Unit12A", "Unit12B", "Unit16", "Unit17", "Unit18", "Unit19"],
    "INITI INDAH": ["Unit3B", "Unit5", "Unit6", "Unit7"]
};

const STORAGE_KEY = "construction_log_data";
const DB_NAME = "ConstructionLogDB";
const DB_VERSION = 2;
const DB_STORE = "reports";
const IMG_STORE = "images";

// =============================================================
// STATE
// =============================================================
let currentReport = {};
let selectedUnit = null;
let currentTaskList = [];
let selectedPhotoFloor = null;
let cameraStream = null;
let pendingOptions = new Set();
let pendingTaskName = "";
let pendingTaskCategory = "";
let cameraDevices = [];
let currentDeviceIndex = 0;
let normalCameraIndex = -1;
let wideCameraIndex = -1;
let isWideActive = false;
let currentFacingMode = "environment";
let manualRotation = 0; // 0, 90, 180, 270

// =============================================================
// INIT
// =============================================================
document.addEventListener("DOMContentLoaded", async () => {
    await loadLocalData();
    initGrid();
    renderAllReports();
});

function initGrid() {
    const grid = document.getElementById("unit-grid");
    grid.innerHTML = "";
    units.forEach(unit => {
        const contractor = getContractor(unit);
        const btn = document.createElement("button");
        btn.className = "unit-btn";
        btn.innerHTML = `<strong>${unit}</strong> <span>${contractor === "Unassigned" ? "" : contractor.substring(0, 3)}</span>`;
        btn.style.backgroundColor = getContractorColor(contractor);
        btn.onclick = () => openInput(unit, contractor);
        grid.appendChild(btn);
    });
}

function getContractor(unit) {
    for (const [contractor, unitList] of Object.entries(assignments)) {
        if (unitList.includes(unit)) return contractor;
    }
    return "Unassigned";
}

function getContractorColor(contractor) {
    switch (contractor) {
        case "IADECCO": return "var(--color-iadecco)";
        case "YAMATO": return "var(--color-yamato)";
        case "INITI INDAH": return "var(--color-initi)";
        default: return "var(--color-unassigned)";
    }
}

// =============================================================
// UI
// =============================================================
function openInput(unit, contractor) {
    selectedUnit = unit;
    selectedPhotoFloor = null;

    if (currentReport[contractor] && currentReport[contractor][unit]) {
        currentTaskList = [...currentReport[contractor][unit].tasks.map(t => t.text)];
    } else {
        currentTaskList = [];
    }

    document.body.style.overflow = "hidden";
    document.getElementById("input-section").classList.remove("hidden");
    document.getElementById("selected-unit-display").textContent = unit;
    document.getElementById("preview-gallery").innerHTML = "";
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
    document.getElementById("custom-task-input").value = "";
    renderTaskList();
    updateTaskCount();
    renderPhotoPreview();
    switchTab('photo');
}

function resetSelection() {
    document.body.style.overflow = "auto";
    document.getElementById("input-section").classList.add("hidden");
    selectedUnit = null;
    currentTaskList = [];
    pendingOptions.clear();
    pendingTaskName = "";
    document.getElementById("custom-task-input").value = "";
    document.getElementById("task-list-display").innerHTML = "";
    stopCamera();
    renderAllReports();
}

function switchTab(tab) {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));

    if (tab === 'photo') {
        document.querySelector(".tab-btn:nth-child(1)").classList.add("active");
        document.getElementById("photo-tab").classList.remove("hidden");
    } else {
        document.querySelector(".tab-btn:nth-child(2)").classList.add("active");
        document.getElementById("task-tab").classList.remove("hidden");
        stopCamera();
    }
}

// =============================================================
// TASK MODAL
// =============================================================
function openTaskOption(taskName, type) {
    pendingTaskName = taskName;
    pendingTaskCategory = type;
    pendingOptions.clear();

    const modal = document.getElementById("option-modal");
    const grid = document.getElementById("modal-options");
    const title = document.getElementById("modal-title");
    grid.innerHTML = "";

    let options = [];
    if (type === 'floor' || type === 'floor_lift_rebar') options = ["GF", "1F", "2F", "3F", "RF"];
    else if (type === 'floor_lift_gf') options = ["GF", "1F", "2F", "3F", "RF", "Lift"];
    else if (type === 'floor_lift') options = ["1F", "2F", "3F", "RF", "Lift"];
    else if (type === 'excavation_targets') options = ["Pile cap", "Retaining wall", "Septic tank", "Ground tank"];
    else if (type === 'rebar_struct_targets') options = ["Pile cap", "Retaining wall", "Beam", "Slab", "Column", "Stairs"];
    else if (type === 'rebar_fab_targets') options = ["Pile cap", "Beam", "Slab", "Retaining wall", "Column"];
    else if (type === 'casting_targets') options = ["Slab", "Beam", "Pile cap", "Retaining wall", "Column", "Car port slope", "Stairs"];
    else if (type === 'formwork_targets') options = ["Pile cap", "Beam", "Slab", "Retaining wall", "Column", "Stairs"];
    else if (type === 'demolishing_targets') options = ["Beam", "Slab", "Retaining wall", "Column", "Stairs"];
    else if (type === 'lean_concrete_targets') options = ["Retaining wall", "Beam", "Pile cap", "Slab"];

    title.textContent = `${taskName} for...`;

    options.forEach(opt => {
        const btn = document.createElement("button");
        btn.className = "modal-option-btn";
        btn.textContent = opt;
        btn.onclick = () => toggleOption(btn, opt);
        grid.appendChild(btn);
    });

    modal.classList.remove("hidden");
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function toggleOption(btn, value) {
    if (pendingOptions.has(value)) {
        pendingOptions.delete(value);
        btn.classList.remove("selected");
    } else {
        pendingOptions.add(value);
        btn.classList.add("selected");
    }
}

function confirmModalSelection() {
    if (pendingOptions.size === 0) { closeModal(); return; }

    const selectedArray = Array.from(pendingOptions);
    const joinedSelection = selectedArray.join(", ");

    if (pendingTaskCategory === 'rebar_struct_targets' || pendingTaskCategory === 'casting_targets' || pendingTaskCategory === 'formwork_targets' || pendingTaskCategory === 'demolishing_targets') {
        if (pendingTaskCategory === 'casting_targets') pendingTaskName = `Casting concrete for ${joinedSelection}`;
        else if (pendingTaskCategory === 'formwork_targets') pendingTaskName = `Form work installation for ${joinedSelection}`;
        else if (pendingTaskCategory === 'demolishing_targets') pendingTaskName = `Demolishing formwork for ${joinedSelection}`;
        else pendingTaskName = `Rebar Installation for ${joinedSelection}`;

        pendingTaskCategory = 'floor_lift_rebar';
        pendingOptions.clear();
        const grid = document.getElementById("modal-options");
        const title = document.getElementById("modal-title");
        grid.innerHTML = "";
        title.textContent = `${pendingTaskName} on...`;
        ["GF", "1F", "2F", "3F", "RF"].forEach(f => {
            const btn = document.createElement("button");
            btn.className = "modal-option-btn";
            btn.textContent = f;
            btn.onclick = () => toggleOption(btn, f);
            grid.appendChild(btn);
        });
        return;
    }

    if (pendingTaskCategory === 'excavation_targets' || pendingTaskCategory === 'rebar_fab_targets' || pendingTaskCategory === 'lean_concrete_targets') {
        let prefix;
        if (pendingTaskCategory === 'lean_concrete_targets') prefix = 'Lean concrete for';
        else if (pendingTaskCategory === 'rebar_fab_targets') prefix = 'Rebar fabrication for';
        else prefix = `${pendingTaskName} for`;
        addTaskDirect(`${prefix} ${joinedSelection}`);
        closeModal();
        return;
    }

    let finalText = pendingTaskCategory.includes('floor')
        ? `${pendingTaskName} on ${joinedSelection}`
        : `${pendingTaskName} for ${joinedSelection}`;

    addTaskDirect(finalText);
    closeModal();
}

function closeModal() {
    document.getElementById("option-modal").classList.add("hidden");
}

// =============================================================
// TASK LIST
// =============================================================
function addTaskDirect(text) {
    currentTaskList.push(text);
    renderTaskList();
    updateTaskCount();
    syncCurrentUnitData();
    saveLocalData();
}

function addCustomTask() {
    const input = document.getElementById("custom-task-input");
    const val = input.value.trim();
    if (val) { addTaskDirect(val); input.value = ""; }
}

function removeTask(index) {
    currentTaskList.splice(index, 1);
    renderTaskList();
    updateTaskCount();
    syncCurrentUnitData();
    saveLocalData();
}

function syncCurrentUnitData() {
    if (!selectedUnit) return;
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor]) currentReport[contractor] = {};
    if (!currentReport[contractor][selectedUnit]) currentReport[contractor][selectedUnit] = { tasks: [], photos: [] };
    const existingPhotos = currentReport[contractor][selectedUnit].photos;
    currentReport[contractor][selectedUnit] = {
        tasks: currentTaskList.map(t => ({ text: t })),
        photos: existingPhotos
    };
}

function renderTaskList() {
    const display = document.getElementById("task-list-display");
    display.innerHTML = "";
    if (currentTaskList.length === 0) {
        display.innerHTML = '<p class="empty-msg">No tasks yet.</p>';
        return;
    }
    currentTaskList.forEach((task, index) => {
        const div = document.createElement("div");
        div.className = "task-item-removable";
        div.innerHTML = `<span>• ${task}</span> <button onclick="removeTask(${index})">×</button>`;
        display.appendChild(div);
    });
}

function updateTaskCount() {
    document.getElementById("task-count").textContent = currentTaskList.length;
}

// =============================================================
// CAMERA
// =============================================================
// =============================================================
// CAMERA
// =============================================================
// =============================================================
// CAMERA
// =============================================================
function cycleManualRotation() {
    manualRotation = (manualRotation + 90) % 360;
    const btn = document.getElementById("btn-manual-rotate");
    if (btn) btn.innerHTML = `⟳ ${manualRotation}°`;
}

async function startCamera() {
    if (cameraStream) return;

    // Non-iOS: start orientation listener immediately (only if we need it, but screen.orientation handles most)
    // Removed the global window listener for 'deviceorientation' to rely on system defaults.


    try {
        let constraints = {
            video: { facingMode: { ideal: "environment" }, aspectRatio: { ideal: 1.333 }, width: { ideal: 2560 }, height: { ideal: 1920 } },
            audio: false
        };

        try {
            cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e1) {
            try {
                cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
            } catch (e2) {
                cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            }
        }

        const video = document.getElementById("camera-stream");
        video.srcObject = cameraStream;
        video.style.filter = "contrast(1.005) saturate(1.01) brightness(1.002)";
        document.getElementById("camera-overlay").classList.remove("hidden");

        if (cameraDevices.length === 0) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            cameraDevices = devices.filter(d => d.kind === 'videoinput');
            populateCameraSelect();

            const track = cameraStream.getVideoTracks()[0];
            const settings = track.getSettings();
            const currentId = settings.deviceId;
            const currentIdx = cameraDevices.findIndex(d => d.deviceId === currentId);
            if (currentIdx >= 0) normalCameraIndex = currentIdx;

            wideCameraIndex = cameraDevices.findIndex(d =>
                (/0\.5|ultra|wide/i.test(d.label)) && d.deviceId !== currentId
            );

            const btnWide = document.getElementById("btn-wide-toggle");
            if (wideCameraIndex >= 0 && normalCameraIndex >= 0) {
                btnWide.classList.remove("hidden");
                btnWide.textContent = "0.5x";
            } else {
                btnWide.classList.add("hidden");
            }
        }
    } catch (err) {
        console.error(err);
        alert("Camera Error: " + err.message);
    }
}

async function requestOrientationPermission() {
    // Only needed if we wanted to listen to DeviceOrientationEvent for other reasons,
    // but sticking to screen.orientation is safer for now.
    // Keeping the function to avoid errors if button is clicked.
    const btn = document.getElementById('btn-orientation');
    if (btn) btn.style.display = 'none';
}

function populateCameraSelect() {
    const select = document.getElementById("camera-select");
    if (!select) return;
    select.innerHTML = "";
    cameraDevices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = index;
        option.text = device.label || `Camera ${index + 1}`;
        select.appendChild(option);
    });
    select.value = currentDeviceIndex;
}

async function manualSelectCamera() {
    const select = document.getElementById("camera-select");
    const idx = parseInt(select.value);
    if (isNaN(idx)) return;

    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    currentDeviceIndex = idx;

    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: cameraDevices[currentDeviceIndex].deviceId }, aspectRatio: { ideal: 1.333 }, width: { ideal: 2560 }, height: { ideal: 1920 } },
            audio: false
        });
        const video = document.getElementById("camera-stream");
        video.srcObject = cameraStream;
    } catch (err) {
        alert("Failed to switch: " + err.message);
    }
}

async function switchCameraFace() {
    if (!cameraStream) return;
    stopCameraStreamOnly();
    currentFacingMode = (currentFacingMode === "environment") ? "user" : "environment";
    const btnWide = document.getElementById("btn-wide-toggle");
    if (currentFacingMode === "user") btnWide.classList.add("hidden");

    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: currentFacingMode }, width: { ideal: 2560 }, height: { ideal: 1920 }, aspectRatio: { ideal: 1.333 } },
            audio: false
        });
        const video = document.getElementById("camera-stream");
        video.srcObject = cameraStream;
        if (currentFacingMode === "environment") {
            const devices = await navigator.mediaDevices.enumerateDevices();
            cameraDevices = devices.filter(d => d.kind === 'videoinput');
            wideCameraIndex = cameraDevices.findIndex(d => /0\.5|ultra|wide/i.test(d.label));
            if (wideCameraIndex >= 0) { btnWide.classList.remove("hidden"); btnWide.textContent = "0.5x"; isWideActive = false; }
        }
    } catch (err) {
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: currentFacingMode } }, audio: false });
            const video = document.getElementById("camera-stream");
            video.srcObject = cameraStream;
        } catch (e) { alert("Camera Switch Failed: " + e.message); }
    }
}

async function toggleWideMode() {
    if (!cameraStream || wideCameraIndex === -1) return;
    stopCameraStreamOnly();
    isWideActive = !isWideActive;
    const targetIdx = isWideActive ? wideCameraIndex : normalCameraIndex;
    let deviceId = cameraDevices[targetIdx]?.deviceId;
    if (!deviceId && !isWideActive) {
        const normal = cameraDevices.find(d => !/0\.5|ultra|wide/i.test(d.label) && /back/i.test(d.label));
        if (normal) deviceId = normal.deviceId;
    }
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: deviceId ? { exact: deviceId } : undefined, facingMode: deviceId ? undefined : "environment", width: { ideal: 2560 }, height: { ideal: 1920 }, aspectRatio: { ideal: 1.333 } },
            audio: false
        });
        const video = document.getElementById("camera-stream");
        video.srcObject = cameraStream;
        const btn = document.getElementById("btn-wide-toggle");
        btn.textContent = isWideActive ? "1x" : "0.5x";
    } catch (e) {
        alert("Toggle Wide Failed: " + e.message);
        isWideActive = !isWideActive;
    }
}

function stopCameraStreamOnly() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
}

function closeCameraOverlay() { stopCamera(); }

function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    document.getElementById("camera-overlay").classList.add("hidden");
}

function capturePhoto() {
    const video = document.getElementById("camera-stream");
    const canvas = document.getElementById("camera-canvas");
    if (!cameraStream) return;

    const maxWidth = 2560;
    let w = video.videoWidth;
    let h = video.videoHeight;
    // Determine rotation based on MANUAL override
    let targetW = w;
    let targetH = h;

    // If manual rotation implies swapping W/H (90 or 270 degrees)
    if (manualRotation === 90 || manualRotation === 270) {
        targetW = h;
        targetH = w;
    }

    if (targetW > maxWidth) {
        const scale = maxWidth / targetW;
        targetW = maxWidth;
        targetH = Math.round(targetH * scale);
    }

    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");

    ctx.save();
    ctx.filter = "contrast(1.005) saturate(1.01) brightness(1.002)";

    // Apply manual rotation
    ctx.translate(targetW / 2, targetH / 2);
    ctx.rotate(manualRotation * Math.PI / 180);

    // Draw image centered in rotated context
    // If rotated 90/270, we draw video with original w/h but centered
    ctx.drawImage(video, -w / 2, -h / 2, w, h);

    ctx.restore();
    ctx.filter = "none";

    const includeFloor = document.getElementById("watermark-floor-check").checked;
    const floorText = includeFloor && selectedPhotoFloor ? selectedPhotoFloor : "";
    addWatermark(ctx, canvas, selectedUnit, floorText);

    const dataUrl = canvas.toDataURL("image/jpeg", 9.6); // Slightly better quality
    savePhoto(dataUrl);
    closeCameraOverlay();
}

function addWatermark(ctx, canvas, unitText, floorText) {
    const fontSize = canvas.width * 0.05;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const dateStr = new Date().toLocaleDateString('en-GB');
    const margin = canvas.width * 0.03;
    const padding = fontSize * 0.4;
    const lineHeight = fontSize * 1.2;

    const lines = [dateStr, unitText];
    if (floorText) lines.push(floorText);

    let maxW = 0;
    lines.forEach(line => { const w = ctx.measureText(line).width; if (w > maxW) maxW = w; });

    const boxWidth = maxW + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2 - (lineHeight - fontSize);

    // POSITIONING LOGIC -- ALWAYS TOP LEFT AS REQUESTED
    const posX = margin - padding; // Left
    const posY = margin - padding; // Top

    ctx.save();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.beginPath();
    ctx.roundRect(posX, posY, boxWidth, boxHeight, fontSize * 0.3);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "white";
    ctx.font = `bold ${fontSize}px sans-serif`; // Ensure font set
    ctx.shadowColor = "black"; ctx.shadowBlur = 2; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;

    let textX = posX + padding;
    let textY = posY + padding + fontSize * 0.8;

    lines.forEach(line => {
        ctx.fillText(line, textX, textY);
        textY += lineHeight;
    });
}

function selectPhotoFloor(floor) {
    selectedPhotoFloor = floor;
    document.querySelector("#photo-tab .chip-group").querySelectorAll(".chip").forEach(c => {
        if (c.textContent === floor) c.classList.add("selected");
        else c.classList.remove("selected");
    });
}

function removePhoto(index) {
    const contractor = getContractor(selectedUnit);
    if (currentReport[contractor] && currentReport[contractor][selectedUnit]) {
        currentReport[contractor][selectedUnit].photos.splice(index, 1);
        renderPhotoPreview();
        saveLocalData();
    }
}

function saveAndClose() {
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor]) currentReport[contractor] = {};
    if (!currentReport[contractor][selectedUnit]) currentReport[contractor][selectedUnit] = { tasks: [], photos: [] };
    currentReport[contractor][selectedUnit].tasks = currentTaskList.map(t => ({ text: t }));
    saveLocalData();
    resetSelection();
}

function naturalSort(a, b) {
    const numA = parseInt(a.replace(/\D/g, '')) || 0;
    const numB = parseInt(b.replace(/\D/g, '')) || 0;
    if (numA === numB) return a.localeCompare(b);
    return numA - numB;
}

function copyText(btn, text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    const originalText = btn.innerHTML;
    btn.innerHTML = "✅ Copied!";
    setTimeout(() => btn.innerHTML = originalText, 1500);
}

// =============================================================
// INDEXEDDB
// =============================================================
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
            if (!db.objectStoreNames.contains(IMG_STORE)) db.createObjectStore(IMG_STORE);
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveImageToDB(id, blob) {
    const db = await openDB();
    const tx = db.transaction(IMG_STORE, "readwrite");
    tx.objectStore(IMG_STORE).put(blob, id);
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

async function getImageFromDB(id) {
    const db = await openDB();
    const tx = db.transaction(IMG_STORE, "readonly");
    const req = tx.objectStore(IMG_STORE).get(id);
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

async function saveLocalData() {
    try {
        const dateKey = new Date().toISOString().split('T')[0];
        const payload = { id: STORAGE_KEY, date: dateKey, data: currentReport };
        const db = await openDB();
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(payload);
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
    } catch (e) { console.error("Failed to save:", e); }
}

async function loadLocalData() {
    try {
        const db = await openDB();
        const tx = db.transaction(DB_STORE, "readonly");
        const request = tx.objectStore(DB_STORE).get(STORAGE_KEY);
        const result = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        db.close();
        if (result) {
            const todayKey = new Date().toISOString().split('T')[0];
            if (result.date === todayKey) {
                currentReport = result.data || {};
            } else {
                currentReport = {};
                await saveLocalData();
            }
        }
    } catch (e) { console.error("IndexedDB load failed:", e); }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (selectedUnit) syncCurrentUnitData(); saveLocalData(); }
});
window.addEventListener("beforeunload", () => { if (selectedUnit) syncCurrentUnitData(); });

function savePhoto(dataUrl) {
    fetch(dataUrl)
        .then(res => res.blob())
        .then(async blob => {
            const id = crypto.randomUUID();
            await saveImageToDB(id, blob);
            const contractor = getContractor(selectedUnit);
            if (!currentReport[contractor]) currentReport[contractor] = {};
            if (!currentReport[contractor][selectedUnit]) currentReport[contractor][selectedUnit] = { tasks: [], photos: [] };
            currentReport[contractor][selectedUnit].photos.push({ type: 'db_ref', id: id, timestamp: Date.now() });
            renderPhotoPreview();
            saveLocalData();
        })
        .catch(err => console.error("Save failed:", err));
}

async function renderPhotoPreview() {
    const gallery = document.getElementById("preview-gallery");
    gallery.innerHTML = "";
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor] || !currentReport[contractor][selectedUnit]) return;

    const photos = currentReport[contractor][selectedUnit].photos;
    for (let i = 0; i < photos.length; i++) {
        const item = photos[i];
        let src = "";
        if (typeof item === 'string') src = item;
        else if (item.type === 'db_ref') {
            const blob = await getImageFromDB(item.id);
            if (blob) src = URL.createObjectURL(blob);
        }
        if (!src) continue;

        const wrapper = document.createElement("div");
        wrapper.style.cssText = "position:relative; display:inline-block;";
        const img = document.createElement("img");
        img.src = src;
        img.className = "preview-img";
        const delBtn = document.createElement("button");
        delBtn.textContent = "×";
        delBtn.style.cssText = "position:absolute; top:2px; right:2px; background:rgba(0,0,0,0.7); color:white; border:none; border-radius:50%; width:24px; height:24px; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1;";
        delBtn.onclick = () => removePhoto(i);
        wrapper.appendChild(img);
        wrapper.appendChild(delBtn);
        gallery.appendChild(wrapper);
    }
}

// =============================================================
// REPORTS
// =============================================================
let _renderGeneration = 0;
async function renderAllReports() {
    const thisGen = ++_renderGeneration;
    const container = document.getElementById("reports-container");
    container.innerHTML = "";
    const activeContractors = Object.keys(currentReport);

    if (activeContractors.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#94a3b8; margin-top:20px;">No reports yet.</p>`;
        return;
    }

    // Sort contractors by specific order: IADECCO, YAMATO, INITI INDAH
    const priorityOrder = ["IADECCO", "YAMATO", "INITI INDAH"];
    activeContractors.sort((a, b) => {
        const idxA = priorityOrder.indexOf(a);
        const idxB = priorityOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
    });

    for (const contractor of activeContractors) {
        const { text, photoData } = await generateContractorReportData(contractor);
        if (thisGen !== _renderGeneration) return; // newer render started, abort this one
        const card = document.createElement("div");
        card.className = "report-card";
        card.style.borderLeftColor = getContractorColor(contractor);

        let imagesHtml = `<div class="preview-gallery">`;
        if (photoData) {
            photoData.forEach((item, idx) => {
                const url = item.url;
                const unit = item.unit;
                const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
                const filename = `${dateStr}_${unit}_${idx + 1}.jpg`;
                imagesHtml += `<a href="${url}" download="${filename}"><img src="${url}" class="preview-img"></a>`;
            });
        }
        imagesHtml += `</div>`;

        card.innerHTML = `
            <div class="report-header"><h3>${contractor}</h3></div>
            <div class="report-content">${text}</div>
            <div class="action-row" style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                <button class="copy-btn" onclick="copyText(this, \`${text.replace(/`/g, "\\`")}\`)">📋 Copy Text</button>
                <button class="copy-btn" onclick="shareToWhatsApp('${contractor}')" style="background:#25D366; color:white;">💬 Share to WA</button>
            </div>
            <div style="margin-top:10px">${imagesHtml}</div>
        `;
        container.appendChild(card);
    }
}

async function generateContractorReportData(contractor) {
    const data = currentReport[contractor];
    const units = Object.keys(data).sort(naturalSort);
    let allPhotoData = [];
    let body = "";

    for (const unit of units) {
        const unitData = data[unit];
        for (const photo of unitData.photos) {
            let url = "";
            if (typeof photo === 'string') url = photo;
            else if (photo.type === 'db_ref') {
                const blob = await getImageFromDB(photo.id);
                if (blob) url = URL.createObjectURL(blob);
            }
            if (url) allPhotoData.push({ url, unit });
        }
        if (unitData.tasks.length > 0) {
            body += `${unit}:\n`;
            unitData.tasks.forEach(t => { body += `-${t.text}\n`; });
            body += `\n`;
        }
    }

    const fullText = `${contractor}\n${body}`.trim();
    return { text: fullText, photoData: allPhotoData };
}

async function shareToWhatsApp(contractor) {
    const { text, photoData } = await generateContractorReportData(contractor);
    const files = [];
    for (let i = 0; i < photoData.length; i++) {
        try {
            const res = await fetch(photoData[i].url);
            const blob = await res.blob();
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const filename = `${dateStr}_${photoData[i].unit}_${i + 1}.jpg`;
            files.push(new File([blob], filename, { type: 'image/jpeg' }));
        } catch (e) { console.error('Photo convert failed:', e); }
    }

    if (navigator.share) {
        const shareData = { title: 'Construction Report', text };
        if (files.length > 0 && navigator.canShare && navigator.canShare({ files })) shareData.files = files;
        try { await navigator.share(shareData); return; } catch (err) { }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}
