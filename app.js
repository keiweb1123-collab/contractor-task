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
    "INTI INDAH": ["Unit3B", "Unit5", "Unit6", "Unit7"]
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
let isFlashOn = false;
let yesterdayReport = null; // { date, data } — text-only snapshot
let previewObjectUrls = []; // legacy — kept so older callers don't crash, no longer pushed to
let reportObjectUrls = [];  // legacy — kept so older callers don't crash, no longer pushed to
let overtimeData = {};  // { "IADECCO": "◯"|"×", "YAMATO": "◯"|"×", "INTI INDAH": "◯"|"×" }

// Cache: photoId → { url, blob }. Each saved image gets exactly one Object URL
// for its entire lifetime, so re-renders don't re-fetch from IndexedDB and
// don't churn URLs (which would otherwise pile up or get prematurely revoked
// by a concurrent render).
const photoUrlCache = new Map();

async function getPhotoUrl(photoId) {
    const cached = photoUrlCache.get(photoId);
    if (cached) return cached;
    // getImageFromDB now returns a detached, memory-only Blob (see comment
    // there). No further detach work needed here.
    const blob = await getImageFromDB(photoId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const entry = { url, blob };
    photoUrlCache.set(photoId, entry);
    return entry;
}

function evictPhotoUrl(photoId) {
    const entry = photoUrlCache.get(photoId);
    if (entry) {
        try { URL.revokeObjectURL(entry.url); } catch (_) { }
        photoUrlCache.delete(photoId);
    }
}

function clearPhotoUrlCache() {
    for (const entry of photoUrlCache.values()) {
        try { URL.revokeObjectURL(entry.url); } catch (_) { }
    }
    photoUrlCache.clear();
}

function getDateKey(d) {
    d = d || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Retained as no-ops so any future caller doesn't crash. The new photoUrlCache
// owns URL lifetimes per-photo, so per-render revoke is unnecessary.
function revokePreviewUrls() { previewObjectUrls = []; }
function revokeReportUrls()  { reportObjectUrls  = []; }

function stripPhotos(data) {
    const copy = {};
    if (!data) return copy;
    for (const contractor of Object.keys(data)) {
        copy[contractor] = {};
        for (const unit of Object.keys(data[contractor])) {
            copy[contractor][unit] = {
                tasks: (data[contractor][unit] && data[contractor][unit].tasks) ? data[contractor][unit].tasks : [],
                photos: []
            };
        }
    }
    return copy;
}

async function clearAllStoredImages() {
    // Cached Object URLs reference the same Blobs we're about to wipe — revoke
    // them in lockstep so the cache doesn't hand out stale URLs afterwards.
    clearPhotoUrlCache();
    try {
        const db = await openDB();
        const tx = db.transaction(IMG_STORE, "readwrite");
        tx.objectStore(IMG_STORE).clear();
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (e) {
        console.error("Image cleanup failed:", e);
    }
}

// =============================================================
// INIT
// =============================================================
document.addEventListener("DOMContentLoaded", async () => {
    await loadLocalData();
    initGrid();
    renderAllReports();
    renderShareDiag();
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
        case "INTI INDAH": return "var(--color-initi)";
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
    refreshCopyYesterdayBtn();
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
    document.getElementById("preview-gallery").innerHTML = "";
    revokePreviewUrls();
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
    else if (type === 'excavation_targets') options = ["Pile cap", "Retaining wall", "Septic tank", "Ground tank", "Beam"];
    else if (type === 'rebar_struct_targets') options = ["Pile cap", "Retaining wall", "Beam", "Slab", "Column", "Stairs", "Carport slope area"];
    else if (type === 'rebar_fab_targets') options = ["Pile cap", "Beam", "Slab", "Retaining wall", "Column"];
    else if (type === 'casting_targets') options = ["Slab", "Beam", "Pile cap", "Retaining wall", "Column", "Carport slope area", "Stairs"];
    else if (type === 'formwork_targets') options = ["Pile cap", "Beam", "Slab", "Retaining wall", "Column", "Stairs"];
    else if (type === 'demolishing_targets') options = ["Beam", "Slab", "Retaining wall", "Column", "Stairs"];
    else if (type === 'lean_concrete_targets') options = ["Retaining wall", "Beam", "Pile cap", "Slab", "Carport slope area"];
    else if (type === 'plastering_targets') options = ["GF", "1F", "2F", "3F", "RF", "Lift", "outside wall", "Facade"];
    else if (type === 'skim_coat_targets') options = ["GF", "1F", "2F", "3F", "RF", "Lift", "Outside wall", "Facade"];
    else if (type === 'waterproofing_targets') options = ["Roof", "Bathroom", "Pit Lift", "Balcony"];
    else if (type === 'opening_targets') options = ["Making door opening", "Making window opening", "Making lift opening"];
    else if (type === 'repair_targets') options = ["Roof slope", "Door opening", "Window opening"];
    else if (type === 'wall_tile_targets') options = ["Wall tile installation", "Facade"];
    else if (type === 'painting_targets') options = ["Wall", "Ceiling", "Parapet"];
    else if (type === 'painting_type') options = ["Painting", "Primer painting"];
    else if (type === 'finishing_repair_targets') options = ["Repair Window opening", "Repair Door Opening", "Repair roof slope"];
    else if (type === 'screeding_targets') options = ["Screeding floor for SPC"];
    else if (type === 'canopy_targets') options = ["Canopy frame installation", "Canopy tempered glass installation"];
    else if (type === 'canopy_area_targets') options = ["Entrance area", "Balcony area"];
    else if (type === 'door_install_targets') options = ["Door frame installation", "Door installation"];
    else if (type === 'window_install_targets') options = ["Installation of window frame", "Installation of window"];
    else if (type === 'pool_targets') options = ["Installation of pool", "Casting concrete for pool", "Tile installation for pool area"];
    else if (type === 'dike_targets') options = ["Making railing dike", "Making balcony dike"];

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

function formatList(arr) {
    if (arr.length === 0) return "";
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr.join(" and ");
    return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

function confirmModalSelection() {
    // If nothing selected, and it's a 2nd step (floor/area), we might allow adding as-is 
    // especially for Waterproofing as requested.
    if (pendingOptions.size === 0) {
        if (pendingTaskCategory.includes('floor') || pendingTaskCategory.includes('area')) {
            addTaskDirect(pendingTaskName); // Add without suffix
            closeModal();
            return;
        }
        closeModal();
        return;
    }

    const selectedArray = Array.from(pendingOptions);
    const joinedSelection = formatList(selectedArray);



    if (pendingTaskCategory === 'wall_tile_targets') {
        if (pendingOptions.has("Facade")) {
            addTaskDirect("Wall tile for Facade");
            closeModal();
            return;
        }
        // If "Wall tile installation" is selected, transition to floor selection
        pendingTaskName = "Wall tile installation";
        pendingTaskCategory = "floor_lift_gf";
        const grid = document.getElementById("modal-options");
        const title = document.getElementById("modal-title");
        grid.innerHTML = "";
        title.textContent = `${pendingTaskName} on...`;
        ["GF", "1F", "2F", "3F", "RF", "Lift"].forEach(f => {
            const btn = document.createElement("button");
            btn.className = "modal-option-btn";
            btn.textContent = f;
            btn.onclick = () => toggleOption(btn, f);
            grid.appendChild(btn);
        });
        pendingOptions.clear();
        return;
    }

    if (pendingTaskCategory === 'pool_targets') {
        addTaskDirect(joinedSelection);
        closeModal();
        return;
    }

    if (pendingTaskCategory === 'painting_type') {
        pendingTaskName = joinedSelection;
        pendingTaskCategory = "painting_targets";
        const grid = document.getElementById("modal-options");
        const title = document.getElementById("modal-title");
        grid.innerHTML = "";
        title.textContent = `${pendingTaskName} for...`;
        ["Wall", "Ceiling", "Parapet"].forEach(opt => {
            const btn = document.createElement("button");
            btn.className = "modal-option-btn";
            btn.textContent = opt;
            btn.onclick = () => toggleOption(btn, opt);
            grid.appendChild(btn);
        });
        pendingOptions.clear();
        return;
    }

    if (pendingTaskCategory === 'painting_targets' || pendingTaskCategory === 'screeding_targets' || pendingTaskCategory === 'door_install_targets' || pendingTaskCategory === 'window_install_targets') {
        let prefix = "";
        if (pendingTaskCategory === 'painting_targets') prefix = `${pendingTaskName} `;
        else if (pendingTaskCategory === 'door_install_targets' || pendingTaskCategory === 'window_install_targets') prefix = "";
        else prefix = "";

        pendingTaskName = prefix ? `${prefix}${joinedSelection}` : joinedSelection;
        pendingTaskCategory = "floor_lift_gf";
        const grid = document.getElementById("modal-options");
        const title = document.getElementById("modal-title");
        grid.innerHTML = "";
        title.textContent = `${pendingTaskName} on...`;
        ["GF", "1F", "2F", "3F", "RF", "Lift"].forEach(f => {
            const btn = document.createElement("button");
            btn.className = "modal-option-btn";
            btn.textContent = f;
            btn.onclick = () => toggleOption(btn, f);
            grid.appendChild(btn);
        });
        pendingOptions.clear();
        return;
    }

    if (pendingTaskCategory === 'canopy_targets') {
        pendingTaskName = joinedSelection;
        pendingTaskCategory = "canopy_area_targets";
        const grid = document.getElementById("modal-options");
        const title = document.getElementById("modal-title");
        grid.innerHTML = "";
        title.textContent = `${pendingTaskName} at...`;
        ["Entrance area", "Balcony area"].forEach(opt => {
            const btn = document.createElement("button");
            btn.className = "modal-option-btn";
            btn.textContent = opt;
            btn.onclick = () => toggleOption(btn, opt);
            grid.appendChild(btn);
        });
        pendingOptions.clear();
        return;
    }

    if (pendingTaskCategory === 'finishing_repair_targets') {
        selectedArray.forEach(opt => addTaskDirect(opt));
        closeModal();
        return;
    }

    if (pendingTaskCategory === 'excavation_targets' || pendingTaskCategory === 'rebar_fab_targets' || pendingTaskCategory === 'lean_concrete_targets' || pendingTaskCategory === 'opening_targets' || pendingTaskCategory === 'repair_targets' || pendingTaskCategory === 'waterproofing_targets' || pendingTaskCategory === 'dike_targets') {
        let prefix;
        if (pendingTaskCategory === 'lean_concrete_targets') prefix = 'Lean concrete for';
        else if (pendingTaskCategory === 'rebar_fab_targets') prefix = 'Rebar fabrication for';
        else if (pendingTaskCategory === 'opening_targets') prefix = '';
        else if (pendingTaskCategory === 'repair_targets') prefix = '';
        else if (pendingTaskCategory === 'waterproofing_targets') prefix = 'Waterproofing for';
        else if (pendingTaskCategory === 'dike_targets') prefix = '';
        else prefix = `${pendingTaskName} for`;

        let finalStr = prefix ? `${prefix} ${joinedSelection}` : joinedSelection;
        if (pendingTaskCategory === 'repair_targets') finalStr = `Repairing ${joinedSelection}`;

        if (pendingTaskCategory === 'waterproofing_targets') {
            pendingTaskName = finalStr;
            pendingTaskCategory = "floor_lift_gf";
            const grid = document.getElementById("modal-options");
            const title = document.getElementById("modal-title");
            grid.innerHTML = "";
            title.textContent = `${pendingTaskName} on...`;
            ["GF", "1F", "2F", "3F", "RF", "Lift"].forEach(f => {
                const btn = document.createElement("button");
                btn.className = "modal-option-btn";
                btn.textContent = f;
                btn.onclick = () => toggleOption(btn, f);
                grid.appendChild(btn);
            });
            pendingOptions.clear();
            return;
        }

        addTaskDirect(finalStr);
        closeModal();
        return;
    }

    if (pendingTaskCategory === 'canopy_area_targets') {
        addTaskDirect(`${pendingTaskName} at ${joinedSelection}`);
        closeModal();
        return;
    }

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

    if (pendingTaskCategory === 'plastering_targets' || pendingTaskCategory === 'skim_coat_targets') {
        const specialItems = [];
        if (pendingOptions.has("outside wall") || pendingOptions.has("Outside wall")) specialItems.push("Outside wall");
        if (pendingOptions.has("Facade")) specialItems.push("Facade");

        if (pendingOptions.has("Lift")) {
            addTaskDirect(`${pendingTaskName} for Inside of the lift`);
        }

        const floors = ["GF", "1F", "2F", "3F", "RF"];
        const validFloors = selectedArray.filter(v => floors.includes(v));

        const allSelected = [...validFloors, ...specialItems];
        if (allSelected.length > 0) {
            let connector = (specialItems.length === 0 && validFloors.length > 0) ? "on" : "for";
            addTaskDirect(`${pendingTaskName} ${connector} ${formatList(allSelected)}`);
        }

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

function copyYesterdayTasks() {
    if (!selectedUnit) return;
    const contractor = getContractor(selectedUnit);
    const yTasks = (yesterdayReport
        && yesterdayReport.data
        && yesterdayReport.data[contractor]
        && yesterdayReport.data[contractor][selectedUnit]
        && yesterdayReport.data[contractor][selectedUnit].tasks) || [];

    if (yTasks.length === 0) {
        alert("No tasks from yesterday for this Unit.");
        return;
    }

    const existing = new Set(currentTaskList);
    let added = 0;
    yTasks.forEach(t => {
        const text = (t && t.text) ? t.text : "";
        if (text && !existing.has(text)) {
            currentTaskList.push(text);
            existing.add(text);
            added++;
        }
    });

    renderTaskList();
    updateTaskCount();
    syncCurrentUnitData();
    saveLocalData();

    if (added === 0) {
        alert("All yesterday's tasks are already in today's list.");
    }
}

function refreshCopyYesterdayBtn() {
    const btn = document.getElementById("copy-yesterday-btn");
    if (!btn) return;
    if (!selectedUnit) { btn.classList.add("hidden"); return; }
    const contractor = getContractor(selectedUnit);
    const yTasks = (yesterdayReport
        && yesterdayReport.data
        && yesterdayReport.data[contractor]
        && yesterdayReport.data[contractor][selectedUnit]
        && yesterdayReport.data[contractor][selectedUnit].tasks) || [];
    if (yTasks.length > 0) {
        btn.textContent = `📋 Copy Yesterday's Tasks (${yTasks.length})`;
        btn.classList.remove("hidden");
    } else {
        btn.classList.add("hidden");
    }
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
        // Build via DOM API so custom task text is treated as plain text
        // (innerHTML interpolation would let "<script>" etc. execute).
        const div = document.createElement("div");
        div.className = "task-item-removable";
        const span = document.createElement("span");
        span.textContent = `• ${task}`;
        const btn = document.createElement("button");
        btn.textContent = "×";
        btn.addEventListener("click", () => removeTask(index));
        div.appendChild(span);
        div.appendChild(document.createTextNode(" "));
        div.appendChild(btn);
        display.appendChild(div);
    });
}

// Utility: HTML-escape a string so it can be safely embedded in innerHTML.
function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function updateTaskCount() {
    document.getElementById("task-count").textContent = currentTaskList.length;
}

// =============================================================
// CAMERA
// =============================================================
function checkFlashCapability() {
    const btnFlash = document.getElementById("btn-flash-toggle");
    if (!btnFlash) return;

    // Always keep the flash button visible as requested, 
    // it will show an alert if not supported upon clicking.
    isFlashOn = false;
    btnFlash.style.background = "rgba(0,0,0,0.5)";
    btnFlash.innerHTML = "<div style='position:relative;'>⚡<div style='position:absolute; top:50%; left:50%; width:2px; height:24px; background:white; transform:translate(-50%, -50%) rotate(45deg);'></div></div>";
}

async function toggleFlash() {
    if (!cameraStream) return;
    const track = cameraStream.getVideoTracks()[0];
    try {
        isFlashOn = !isFlashOn;
        await track.applyConstraints({
            advanced: [{ torch: isFlashOn }]
        });
        const btn = document.getElementById("btn-flash-toggle");
        if (btn) {
            btn.style.background = isFlashOn ? "rgba(255,215,0,0.8)" : "rgba(0,0,0,0.5)";
            btn.innerHTML = isFlashOn ? "⚡" : "<div style='position:relative;'>⚡<div style='position:absolute; top:50%; left:50%; width:2px; height:24px; background:white; transform:translate(-50%, -50%) rotate(45deg);'></div></div>";
        }
    } catch (err) {
        isFlashOn = !isFlashOn;
        console.error("Flash error:", err);
        alert("Failed to toggle flash: " + err.message);
    }
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

        checkFlashCapability();

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
        checkFlashCapability();
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
        checkFlashCapability();
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
            checkFlashCapability();
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
        checkFlashCapability();
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

    // Reduce maxWidth to avoid OS-level payload limits when sharing many photos
    const maxWidth = 1280;
    let w = video.videoWidth;
    let h = video.videoHeight;

    let targetW = w;
    let targetH = h;

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

    ctx.drawImage(video, 0, 0, targetW, targetH);

    ctx.restore();
    ctx.filter = "none";

    const includeFloor = document.getElementById("watermark-floor-check").checked;
    const floorText = includeFloor && selectedPhotoFloor ? selectedPhotoFloor : "";
    addWatermark(ctx, canvas, selectedUnit, floorText);

    // Compress more to ensure sharing many photos at once doesn't crash the OS intent
    const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
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
        const removed = currentReport[contractor][selectedUnit].photos.splice(index, 1)[0];
        // Also drop the underlying Blob from IndexedDB so deleted photos don't
        // accumulate until the next day rollover. Fire-and-forget — UI doesn't
        // need to wait, and a failure here is non-fatal.
        if (removed && removed.type === 'db_ref' && removed.id) {
            evictPhotoUrl(removed.id); // revoke cached Object URL
            deleteImageFromDB(removed.id).catch(e => console.warn('Image cleanup failed:', e));
        }
        renderPhotoPreview();
        saveLocalData();
    }
}

async function deleteImageFromDB(id) {
    const db = await openDB();
    const tx = db.transaction(IMG_STORE, "readwrite");
    tx.objectStore(IMG_STORE).delete(id);
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
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

    // The stored value is either:
    //   - (v59+) a `data:image/jpeg;base64,...` string. Strings have no IDB
    //     binding so they survive any transaction commit and can't be
    //     "neutered" by the long-standing iOS Safari WebKit bug.
    //   - (legacy) a Blob written by older builds. Blobs read from IDB on
    //     Safari can lose their backing bytes once the transaction commits
    //     (the "neuter" bug), which silently broke navigator.share({files}).
    //     For legacy entries we eagerly copy the bytes via arrayBuffer()
    //     inside the success handler — i.e. before the txn commits — so the
    //     returned Blob is fully detached from IndexedDB.
    const result = await new Promise((resolve, reject) => {
        req.onsuccess = () => {
            const value = req.result;
            if (!value) { resolve(null); return; }

            if (typeof value === 'string') {
                // v59+ data URL path — convert to a memory-only Blob.
                fetch(value)
                    .then(r => r.blob())
                    .then(b => resolve(b))
                    .catch(e => { console.warn('data URL → Blob failed:', e); resolve(null); });
                return;
            }

            // Legacy Blob path — eager-detach.
            value.arrayBuffer().then(
                ab => resolve(new Blob([ab], { type: value.type || 'image/jpeg' })),
                e => { console.warn('IDB Blob detach failed; using raw blob:', e); resolve(value); }
            );
        };
        req.onerror = () => reject(req.error);
    });

    // Close the connection. Returned value is memory-only and no longer
    // needs the database handle.
    try { db.close(); } catch (_) { }
    return result;
}

async function saveLocalData() {
    try {
        const todayKey = getDateKey();
        const payload = {
            id: STORAGE_KEY,
            today: { date: todayKey, data: currentReport },
            yesterday: yesterdayReport,
            overtime: overtimeData
        };
        const db = await openDB();
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(payload);
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
    } catch (e) { console.error("Failed to save:", e); }
}

async function loadLocalData() {
    try {
        const todayKey = getDateKey();
        const db = await openDB();
        const tx = db.transaction(DB_STORE, "readonly");
        const request = tx.objectStore(DB_STORE).get(STORAGE_KEY);
        const result = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        db.close();

        if (!result) {
            currentReport = {};
            yesterdayReport = null;
            return;
        }

        // Migration: old format had {id, date, data}
        if (result.data && !result.today && !result.yesterday) {
            if (result.date === todayKey) {
                currentReport = result.data || {};
                yesterdayReport = null;
            } else {
                // Old data is from a previous day — keep as yesterday (text only), wipe photos
                yesterdayReport = { date: result.date, data: stripPhotos(result.data) };
                currentReport = {};
                await clearAllStoredImages();
            }
            await saveLocalData();
            return;
        }

        // New format
        const todayRec = result.today || null;
        const yRec = result.yesterday || null;

        if (todayRec && todayRec.date === todayKey) {
            currentReport = todayRec.data || {};
            yesterdayReport = yRec;
            overtimeData = result.overtime || {};
        } else if (todayRec && todayRec.date && todayRec.date !== todayKey) {
            // Day rolled over — promote today's text to yesterday, drop photos, start fresh today
            yesterdayReport = { date: todayRec.date, data: stripPhotos(todayRec.data) };
            currentReport = {};
            overtimeData = {};
            await clearAllStoredImages();
            await saveLocalData();
        } else {
            currentReport = {};
            yesterdayReport = yRec;
            overtimeData = result.overtime || {};
        }

        // Migration: unify contractor key "INITI INDAH" → "INTI INDAH"
        // Older builds stored the third contractor under the misspelled key
        // "INITI INDAH". Rename it in place so saved tasks/photos keep working.
        const migrated = migrateContractorKey(currentReport, "INITI INDAH", "INTI INDAH")
            || (yesterdayReport && yesterdayReport.data && migrateContractorKey(yesterdayReport.data, "INITI INDAH", "INTI INDAH"));
        if (migrated) await saveLocalData();
    } catch (e) { console.error("IndexedDB load failed:", e); }
}

function migrateContractorKey(report, oldKey, newKey) {
    if (!report || !Object.prototype.hasOwnProperty.call(report, oldKey)) return false;
    const oldEntry = report[oldKey] || {};
    const newEntry = report[newKey] || {};
    // Merge unit-level entries; if the same unit exists under both, prefer the new key.
    report[newKey] = { ...oldEntry, ...newEntry };
    delete report[oldKey];
    return true;
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (selectedUnit) syncCurrentUnitData(); saveLocalData(); }
});
window.addEventListener("beforeunload", () => {
    if (selectedUnit) syncCurrentUnitData();
    // Best-effort save before unload. IndexedDB transactions started here are
    // not guaranteed to commit, but most browsers will let an already-started
    // transaction finish. `visibilitychange` above is the primary save path.
    saveLocalData();
});

function savePhoto(dataUrl) {
    // Snapshot the target unit at capture time. If the user closes the input
    // section before the async save completes, `selectedUnit` would be
    // null, which previously made `getContractor(null)` fall through to
    // "Unassigned" and silently create a phantom contractor entry.
    const targetUnit = selectedUnit;
    if (!targetUnit) {
        console.warn("savePhoto called with no selected unit — discarding capture.");
        return;
    }
    const contractor = getContractor(targetUnit);
    if (contractor === "Unassigned") {
        console.warn("savePhoto: unit has no contractor mapping — discarding capture.", targetUnit);
        return;
    }

    // Save the data URL STRING directly to IndexedDB instead of converting it
    // to a Blob first. Storing strings sidesteps the long-standing iOS Safari
    // bug where Blobs read from IndexedDB get "neutered" after the originating
    // transaction commits — neutered Blobs silently break navigator.share({files}).
    // Strings have no transaction binding, so they stay valid forever.
    (async () => {
        try {
            const id = crypto.randomUUID();
            await saveImageToDB(id, dataUrl);
            if (!currentReport[contractor]) currentReport[contractor] = {};
            if (!currentReport[contractor][targetUnit]) currentReport[contractor][targetUnit] = { tasks: [], photos: [] };
            currentReport[contractor][targetUnit].photos.push({ type: 'db_ref', id: id, timestamp: Date.now() });
            // Only refresh the in-screen preview if the user is still on the
            // same unit they captured for.
            if (selectedUnit === targetUnit) renderPhotoPreview();
            saveLocalData();
        } catch (err) {
            console.error("Save failed:", err);
        }
    })();
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
            const entry = await getPhotoUrl(item.id);
            if (entry) src = entry.url;
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
function priorityContractorSort(arr) {
    const priorityOrder = ["IADECCO", "YAMATO", "INTI INDAH"];
    return arr.slice().sort((a, b) => {
        const idxA = priorityOrder.indexOf(a);
        const idxB = priorityOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
    });
}

let _renderGeneration = 0;
async function renderAllReports() {
    const thisGen = ++_renderGeneration;
    const container = document.getElementById("reports-container");
    container.innerHTML = "";

    // Object URLs are managed centrally by photoUrlCache (one URL per photo,
    // alive until the photo is deleted or images are wiped). Render-level URL
    // bucket management is therefore no longer needed — leaving these stubs
    // here lets the existing abort/cleanup call sites compile cleanly.
    const myUrls = [];
    const cleanupOnAbort = () => {};

    const activeContractors = priorityContractorSort(Object.keys(currentReport));

    if (activeContractors.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#94a3b8; margin-top:20px;">No reports yet.</p>`;
    } else {
        // Print header (only shown when printing)
        const printHdr = document.createElement("div");
        printHdr.id = "print-header";
        printHdr.textContent = `Construction Log — ${getDateKey()}`;
        container.appendChild(printHdr);

        // Export bar
        const bar = document.createElement("div");
        bar.className = "export-bar";
        bar.style.cssText = "display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;";
        bar.innerHTML = `
            <button class="copy-btn" onclick="exportCSV()" style="background:#10b981; color:white; flex:1; min-width:140px; border:none;">📊 Export CSV</button>
            <button class="copy-btn" onclick="exportPDF()" style="background:#ef4444; color:white; flex:1; min-width:140px; border:none;">📄 Save as PDF</button>
        `;
        container.appendChild(bar);

        for (const contractor of activeContractors) {
            const { text, photoData, unitBreakdown } = await generateContractorReportData(contractor, myUrls);
            if (thisGen !== _renderGeneration) { cleanupOnAbort(); return; } // newer render started, abort this one

            // Pre-compute how many share groups this contractor needs. If the OS
            // rejects all photos at once (typical for IADECCO/YAMATO which have
            // many units), we split into multiple Share-to-WA buttons.
            const shareGroups = chunkUnitsForShare(contractor, unitBreakdown);

            const card = document.createElement("div");
            card.className = "report-card";
            card.style.borderLeftColor = getContractorColor(contractor);

            const dateStr = getDateKey().replace(/-/g, '');
            let imagesHtml = `<div class="preview-gallery">`;
            if (photoData) {
                photoData.forEach((item, idx) => {
                    const filename = `${dateStr}_${item.unit}_${idx + 1}.jpg`;
                    imagesHtml += `<a href="${item.url}" download="${filename}"><img src="${item.url}" class="preview-img"></a>`;
                });
            }
            imagesHtml += `</div>`;

            // Build one Share-to-WA button per group. Single-group case keeps
            // the original label "💬 Share to WA" so nothing changes for
            // contractors whose payload already fits (e.g. INTI INDAH).
            let shareButtonsHtml = '';
            if (shareGroups.length <= 1) {
                shareButtonsHtml = `<button class="copy-btn" data-share-idx="0" style="background:#25D366; color:white;">💬 Share to WA</button>`;
            } else {
                for (let g = 0; g < shareGroups.length; g++) {
                    shareButtonsHtml += `<button class="copy-btn" data-share-idx="${g}" style="background:#25D366; color:white;">💬 Share to WA (${g + 1}/${shareGroups.length})</button>`;
                }
            }

            // Build card HTML without embedding text into onclick attributes
            // (text with newlines/quotes/backticks was breaking HTML attribute parsing).
            // Report text is escaped because custom task names are user-controlled
            // — without escaping, "<script>" in a task would execute on render.
            card.innerHTML = `
                <div class="report-header"><h3>${escapeHtml(contractor)}</h3></div>
                <div class="report-content">${escapeHtml(text)}</div>
                <div class="action-row" style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                    <button class="copy-btn" data-action="copy">📋 Copy Text</button>
                    ${shareButtonsHtml}
                    <button class="copy-btn" data-action="save-photos" style="background:#4f46e5; color:white;">📥 Save Photos</button>
                </div>
                <div style="margin-top:10px">${imagesHtml}</div>
            `;

            // Attach event listeners safely via DOM (avoids inline onclick text-escaping bugs)
            const copyBtn = card.querySelector('[data-action="copy"]');
            const saveBtn = card.querySelector('[data-action="save-photos"]');

            copyBtn.addEventListener('click', function () { copyText(this, text); });
            saveBtn.addEventListener('click', function () { saveAllPhotos(photoData); });

            // Wire up Share-to-WA buttons (one per group)
            card.querySelectorAll('[data-share-idx]').forEach(btn => {
                const idx = parseInt(btn.getAttribute('data-share-idx'), 10);
                const group = shareGroups[idx];
                btn.addEventListener('click', function () {
                    if (group) {
                        shareToWhatsApp(group.text, group.photoData);
                    } else {
                        shareToWhatsApp(text, []);
                    }
                });
            });

            container.appendChild(card);
        }
    }

    renderOvertimeSection(container);
    renderYesterdaySection(container);
    // No per-render URL cleanup needed: photoUrlCache owns those URLs and
    // releases them on photo delete / day rollover.
}

// =============================================================
// OVERTIME SECTION
// =============================================================
function renderOvertimeSection(container) {
    const contractors = ["IADECCO", "YAMATO", "INTI INDAH"];

    const section = document.createElement("div");
    section.className = "overtime-section";
    section.style.cssText = "margin-top:24px; padding:20px; background:linear-gradient(135deg, #1e293b, #334155); border-radius:16px; box-shadow:0 4px 16px rgba(0,0,0,0.2);";

    let togglesHtml = '';
    contractors.forEach(c => {
        const current = overtimeData[c] || null;
        const isYes = current === '◯';
        const isNo = current === '×';
        togglesHtml += `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.1);">
                <span style="color:#e2e8f0; font-weight:700; font-size:1rem;">${c}</span>
                <div style="display:flex; gap:8px;">
                    <button class="ot-btn" data-contractor="${c}" data-value="◯"
                        style="width:44px; height:44px; border-radius:50%; border:2px solid ${isYes ? '#22c55e' : '#475569'}; background:${isYes ? 'rgba(34,197,94,0.25)' : 'transparent'}; color:${isYes ? '#22c55e' : '#94a3b8'}; font-size:20px; font-weight:900; cursor:pointer; transition:all 0.2s;">◯</button>
                    <button class="ot-btn" data-contractor="${c}" data-value="×"
                        style="width:44px; height:44px; border-radius:50%; border:2px solid ${isNo ? '#ef4444' : '#475569'}; background:${isNo ? 'rgba(239,68,68,0.25)' : 'transparent'}; color:${isNo ? '#ef4444' : '#94a3b8'}; font-size:20px; font-weight:900; cursor:pointer; transition:all 0.2s;">×</button>
                </div>
            </div>
        `;
    });

    section.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
            <h3 style="color:white; font-weight:900; font-size:1.2rem; margin:0;">⏰ Overtime</h3>
        </div>
        <div class="overtime-toggles">${togglesHtml}</div>
        <div style="margin-top:14px; display:flex; gap:8px;">
            <button class="copy-btn" data-action="ot-copy" style="flex:1; background:rgba(255,255,255,0.1); color:white; border:1px solid rgba(255,255,255,0.2);">📋 Copy</button>
            <button class="copy-btn" data-action="ot-wa" style="flex:1; background:#25D366; color:white;">💬 Share to WA</button>
        </div>
    `;

    // Attach toggle event listeners (update styles in-place, no full re-render)
    section.querySelectorAll('.ot-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const contractor = this.dataset.contractor;
            const value = this.dataset.value;
            // Toggle: if already selected, deselect; otherwise set
            if (overtimeData[contractor] === value) {
                delete overtimeData[contractor];
            } else {
                overtimeData[contractor] = value;
            }
            saveLocalData();
            // Update all buttons in this section in-place (no page re-render)
            section.querySelectorAll('.ot-btn').forEach(b => {
                const c = b.dataset.contractor;
                const v = b.dataset.value;
                const cur = overtimeData[c] || null;
                if (v === '◯') {
                    const active = cur === '◯';
                    b.style.borderColor = active ? '#22c55e' : '#475569';
                    b.style.background = active ? 'rgba(34,197,94,0.25)' : 'transparent';
                    b.style.color = active ? '#22c55e' : '#94a3b8';
                } else {
                    const active = cur === '×';
                    b.style.borderColor = active ? '#ef4444' : '#475569';
                    b.style.background = active ? 'rgba(239,68,68,0.25)' : 'transparent';
                    b.style.color = active ? '#ef4444' : '#94a3b8';
                }
            });
        });
    });

    // Copy button
    const copyBtn = section.querySelector('[data-action="ot-copy"]');
    copyBtn.addEventListener('click', function () {
        const text = generateOvertimeText();
        copyText(this, text);
    });

    // WA share button
    const waBtn = section.querySelector('[data-action="ot-wa"]');
    waBtn.addEventListener('click', function () {
        shareOvertimeToWA();
    });

    container.appendChild(section);
}

function generateOvertimeText() {
    const contractors = ["IADECCO", "YAMATO", "INTI INDAH"];
    let lines = ["Overtime"];
    contractors.forEach(c => {
        const val = overtimeData[c] || '-';
        lines.push(`${c}：${val}`);
    });
    return lines.join('\n');
}

function openWhatsAppWithText(text) {
    const a = document.createElement('a');
    a.href = `whatsapp://send?text=${encodeURIComponent(text)}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function shareOvertimeToWA() {
    const text = generateOvertimeText();
    openWhatsAppWithText(text);
}

function renderYesterdaySection(container) {
    if (!yesterdayReport || !yesterdayReport.data) return;
    const yContractors = priorityContractorSort(Object.keys(yesterdayReport.data));
    if (yContractors.length === 0) return;

    const section = document.createElement("div");
    section.style.cssText = "margin-top:32px; padding-top:16px; border-top:2px dashed #cbd5e1;";
    section.innerHTML = `<h3 style="color:#6b7280; text-align:center; margin-bottom:16px; font-weight:800;">📅 Yesterday (${yesterdayReport.date})</h3>`;

    for (const contractor of yContractors) {
        const cdata = yesterdayReport.data[contractor];
        const units = Object.keys(cdata).sort(naturalSort);
        let body = "";
        for (const unit of units) {
            const tasks = (cdata[unit] && cdata[unit].tasks) ? cdata[unit].tasks : [];
            if (tasks.length > 0) {
                body += `${unit}:\n`;
                tasks.forEach(t => { body += `-${t.text}\n`; });
                body += `\n`;
            }
        }
        if (!body) continue;
        const fullText = `${contractor}\n${body}`.trim();

        const card = document.createElement("div");
        card.className = "report-card";
        card.style.borderLeftColor = getContractorColor(contractor);
        card.style.opacity = "0.85";
        card.innerHTML = `
            <div class="report-header"><h3>${escapeHtml(contractor)}</h3></div>
            <div class="report-content">${escapeHtml(fullText)}</div>
            <div class="action-row" style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                <button class="copy-btn" data-action="copy">📋 Copy Text</button>
            </div>
        `;
        const copyBtn = card.querySelector('[data-action="copy"]');
        copyBtn.addEventListener('click', function () { copyText(this, fullText); });
        section.appendChild(card);
    }
    container.appendChild(section);
}

async function generateContractorReportData(contractor, urlSink) {
    // urlSink is kept for backward compatibility with callers from older builds.
    // The new photoUrlCache owns Object URL lifetimes, so we no longer push
    // per-render URLs into a sink that gets revoked on the next render.
    void urlSink;
    const data = currentReport[contractor];
    const units = Object.keys(data).sort(naturalSort);
    let allPhotoData = [];
    let body = "";
    const unitBreakdown = []; // [{ unit, taskText, photos: [{url, unit, blob}, ...] }]

    for (const unit of units) {
        const unitData = data[unit];
        const unitPhotos = [];
        for (const photo of unitData.photos) {
            let url = "";
            let fileBlob = null;
            if (typeof photo === 'string') {
                url = photo;
                try {
                    fileBlob = await (await fetch(url)).blob();
                } catch(e) {}
            }
            else if (photo.type === 'db_ref') {
                const entry = await getPhotoUrl(photo.id);
                if (entry) {
                    url = entry.url;
                    fileBlob = entry.blob;
                }
            }
            if (url) {
                const item = { url, unit, blob: fileBlob };
                allPhotoData.push(item);
                unitPhotos.push(item);
            }
        }
        let taskText = "";
        if (unitData.tasks.length > 0) {
            taskText = `${unit}:\n`;
            unitData.tasks.forEach(t => { taskText += `-${t.text}\n`; });
            body += taskText + `\n`;
        }
        unitBreakdown.push({ unit, taskText, photos: unitPhotos });
    }

    const fullText = `${contractor}\n${body}`.trim();
    return { text: fullText, photoData: allPhotoData, unitBreakdown };
}

// =============================================================
// SHARE CHUNKING
// =============================================================
// Background: navigator.canShare({files}) returns true at the OS layer even
// when the actual share() will reject, and on Chrome Android PWA the
// failure mode for "too many files OR too many total bytes" is a
// NotAllowedError ("Permission denied"). User confirmed sharing 1 photo
// succeeds; sharing 12 photos in one group fails. The most common cause is
// total payload size, so we now chunk by BOTH:
//   - file count (kept at 20 — user explicitly asked not to lower)
//   - total bytes (4 MB per group — leaves headroom under the common
//     ~10 MB practical limit observed for Chrome Android Web Share API)
const MAX_FILES_PER_SHARE = 20;
const MAX_BYTES_PER_SHARE = 4 * 1024 * 1024;

function chunkUnitsForShare(contractor, unitBreakdown) {
    const dateStr = getDateKey().replace(/-/g, '');

    // Build File objects per unit up front
    const unitsWithFiles = unitBreakdown.map(ub => {
        const files = ub.photos
            .filter(p => p.blob)
            .map((p, i) => new File([p.blob], `${dateStr}_${p.unit}_${i + 1}.jpg`, { type: 'image/jpeg' }));
        return { unit: ub.unit, taskText: ub.taskText, photos: ub.photos.filter(p => p.blob), files };
    });

    const canShareSet = (files) => {
        if (!files || files.length === 0) return true;
        if (!navigator.canShare) return true;
        try { return navigator.canShare({ files }); } catch { return false; }
    };
    const totalBytes = (files) => files.reduce((s, f) => s + (f.size || 0), 0);
    // A group is acceptable only if it passes ALL three checks:
    //   1. OS-level canShare returns true
    //   2. file count ≤ MAX_FILES_PER_SHARE
    //   3. total bytes ≤ MAX_BYTES_PER_SHARE
    // canShare alone is not sufficient — see the comment block above.
    const fitsLimit = (files) =>
        files.length <= MAX_FILES_PER_SHARE
        && totalBytes(files) <= MAX_BYTES_PER_SHARE
        && canShareSet(files);

    const buildGroup = (units) => {
        const lines = [contractor];
        for (const u of units) {
            if (u.taskText) lines.push(u.taskText.trimEnd());
        }
        return {
            text: lines.join('\n').trim(),
            files: units.flatMap(u => u.files),
            photoData: units.flatMap(u => u.photos)
        };
    };

    const groups = [];
    let currentUnits = [];
    let currentFiles = [];

    const flushCurrent = () => {
        if (currentUnits.length > 0) groups.push(buildGroup(currentUnits));
        currentUnits = [];
        currentFiles = [];
    };

    for (const ub of unitsWithFiles) {
        if (ub.files.length === 0) {
            // Unit with no photos — keep its task text bundled with the current group
            currentUnits.push(ub);
            continue;
        }
        const tentative = currentFiles.concat(ub.files);
        if (fitsLimit(tentative)) {
            currentUnits.push(ub);
            currentFiles = tentative;
        } else {
            flushCurrent();
            if (fitsLimit(ub.files)) {
                currentUnits = [ub];
                currentFiles = ub.files.slice();
            } else {
                // A single unit's photos already exceed the cap. Split that
                // unit's photos into sub-chunks of MAX_FILES_PER_SHARE each.
                // The unit's task text rides on the first sub-chunk only so
                // the recipient doesn't see the same task list repeated.
                for (let start = 0; start < ub.files.length; start += MAX_FILES_PER_SHARE) {
                    const end = Math.min(start + MAX_FILES_PER_SHARE, ub.files.length);
                    groups.push(buildGroup([{
                        unit: ub.unit,
                        taskText: start === 0 ? ub.taskText : "",
                        photos: ub.photos.slice(start, end),
                        files: ub.files.slice(start, end)
                    }]));
                }
            }
        }
    }
    flushCurrent();

    if (groups.length === 0) {
        // No units at all — produce one text-only group so the UI still
        // renders a Share-to-WA button.
        groups.push({ text: contractor, files: [], photoData: [] });
    }
    return groups;
}

// Share to WhatsApp.
//
// CRITICAL: navigator.share() consumes user activation, so the Web Share API
// can only be invoked ONCE per click. v59/v60 tried files-first then text on
// failure, but the second call always threw NotAllowedError ("must be handling
// a user gesture") on Android — and that NotAllowedError overwrote the real
// reason for the first failure in our diagnostic display. v61 calls
// navigator.share() exactly once, decides the payload up front from canShare,
// and falls back to the whatsapp:// deep link (which doesn't need a gesture)
// if that one call fails.
//
// We also avoid async/await on the gesture-bearing path. Some browser builds
// schedule the body of an `async function` as a microtask instead of running
// it synchronously when called — if that happens, the user gesture is gone by
// the time navigator.share() is invoked. Plain promise chains keep share() in
// the synchronous portion of the click handler.
function shareToWhatsApp(text, photoData) {
    if (!navigator.share) {
        // Desktop or unsupported browser fallback
        openWhatsAppWithText(text);
        return;
    }

    // Build files. Caller (renderAllReports) has already capped photoData to
    // MAX_FILES_PER_SHARE via chunkUnitsForShare.
    const files = [];
    if (photoData && photoData.length > 0) {
        const dateStr = getDateKey().replace(/-/g, '');
        for (let i = 0; i < photoData.length; i++) {
            if (photoData[i].blob) {
                const filename = `${dateStr}_${photoData[i].unit}_${i + 1}.jpg`;
                files.push(new File([photoData[i].blob], filename, { type: 'image/jpeg' }));
            }
        }
    }

    const hasFiles = files.length > 0 && navigator.canShare && navigator.canShare({ files });
    const payload = hasFiles
        ? { title: 'Construction Report', text, files }
        : { title: 'Construction Report', text };

    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);

    navigator.share(payload).then(
        () => {
            recordShareDiag(null); // clear previous diagnostic on success
        },
        (err) => {
            if (err && err.name === 'AbortError') return; // user cancelled
            recordShareDiag({
                stage: hasFiles ? 'files' : 'text',
                name: err && err.name,
                message: err && err.message,
                fileCount: files.length,
                totalBytes: totalBytes,
                textLength: (text || '').length,
                ts: Date.now()
            });
            console.warn('navigator.share failed:', err && err.name, err && err.message);
            // Single-shot share failed. Open WhatsApp via deep link so at least
            // the text reaches the recipient. We do NOT call navigator.share
            // again — the gesture has been consumed.
            openWhatsAppWithText(text);
        }
    );
}

// =============================================================
// SHARE DIAGNOSTICS
// =============================================================
// When navigator.share({files}) silently fails on iOS, the only signal is
// in console — which mobile users can't see. We persist the most recent
// share error to localStorage so renderShareDiag() can surface it as a
// small footer line under the version label.
const SHARE_DIAG_KEY = 'construction_log_share_diag';

function getEnvSnapshot() {
    // Collected at runtime so the diagnostic line includes enough context
    // to tell whether the failure is browser / WebView / in-app related.
    const ua = (navigator.userAgent || '').slice(0, 200);
    let mode = 'browser';
    try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) mode = 'standalone-pwa';
        else if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) mode = 'minimal-ui';
    } catch (_) {}
    const hasShare = !!navigator.share;
    const hasCanShare = !!(navigator.canShare);
    // Brave exposes navigator.brave with an isBrave() method. Detecting it
    // synchronously is enough — the mere presence of navigator.brave means
    // the user is on Brave, which restricts Web Share for files via Shields.
    const isBrave = !!(navigator.brave && typeof navigator.brave.isBrave === 'function');
    return { ua, mode, hasShare, hasCanShare, isBrave };
}

function recordShareDiag(info) {
    try {
        if (info === null) {
            localStorage.removeItem(SHARE_DIAG_KEY);
        } else {
            // Always attach the env snapshot so we know the runtime context
            // any failure happened in.
            info.env = getEnvSnapshot();
            localStorage.setItem(SHARE_DIAG_KEY, JSON.stringify(info));
        }
        renderShareDiag();
    } catch (_) { /* localStorage may be unavailable */ }
}

function renderShareDiag() {
    const el = document.getElementById('share-diag');
    if (!el) return;
    let raw;
    try { raw = localStorage.getItem(SHARE_DIAG_KEY); } catch (_) { raw = null; }
    if (!raw) { el.innerHTML = ''; return; }
    try {
        const info = JSON.parse(raw);
        const when = new Date(info.ts).toLocaleTimeString();
        let line1 = `[${when}] share(${info.stage}) failed: ${info.name || 'unknown'}`;
        if (info.message) line1 += ` — ${info.message}`;
        if (info.fileCount != null) {
            line1 += ` (files=${info.fileCount}`;
            if (info.totalBytes != null) line1 += `, bytes=${(info.totalBytes / 1024 / 1024).toFixed(2)}MB`;
            line1 += `, text=${info.textLength})`;
        }

        let line2 = '';
        if (info.env) {
            line2 = `env: ${info.env.mode}, share=${info.env.hasShare}, canShare=${info.env.hasCanShare}`;
            if (info.env.isBrave) line2 += ', brave=true';
            if (info.env.ua) line2 += `\nUA: ${info.env.ua}`;
        }

        let braveNote = '';
        if (info.env && info.env.isBrave) {
            braveNote = 'Brave detected: Shields はファイル共有をブロックします。アドレスバーのライオン🦁 → Shields を「Down」にしてリロードしてください。';
        }

        // Rebuild the diagnostic block from scratch.
        el.innerHTML = '';

        const top = document.createElement('div');
        top.textContent = line1;
        el.appendChild(top);

        if (braveNote) {
            const note = document.createElement('div');
            note.style.color = '#b45309';      // amber
            note.style.background = '#fef3c7';
            note.style.padding = '6px 8px';
            note.style.borderRadius = '6px';
            note.style.marginTop = '6px';
            note.style.fontSize = '0.72rem';
            note.textContent = braveNote;
            el.appendChild(note);
        }

        const bottom = document.createElement('div');
        bottom.style.color = '#6b7280';
        bottom.style.fontSize = '0.65rem';
        bottom.style.marginTop = '4px';
        bottom.style.whiteSpace = 'pre-wrap';
        bottom.textContent = line2;
        el.appendChild(bottom);

        // Copy-to-clipboard button so the user doesn't have to retype the
        // long diagnostic when reporting it back.
        const actionRow = document.createElement('div');
        actionRow.style.marginTop = '6px';
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 診断をコピー';
        copyBtn.style.cssText = 'background:#f3f4f6; color:#374151; border:1px solid #d1d5db; padding:6px 12px; border-radius:6px; font-size:0.7rem; cursor:pointer;';
        copyBtn.addEventListener('click', function () {
            const full = `${line1}\n${braveNote ? braveNote + '\n' : ''}${line2}`;
            copyText(this, full);
        });
        actionRow.appendChild(copyBtn);
        el.appendChild(actionRow);
    } catch (_) {
        el.innerHTML = '';
    }
}

function exportCSV() {
    const dateKey = getDateKey();
    const rows = [["Date", "Contractor", "Unit", "Task"]];
    const sortedContractors = priorityContractorSort(Object.keys(currentReport));
    for (const contractor of sortedContractors) {
        const cdata = currentReport[contractor] || {};
        const units = Object.keys(cdata).sort(naturalSort);
        for (const unit of units) {
            const tasks = (cdata[unit] && cdata[unit].tasks) ? cdata[unit].tasks : [];
            for (const t of tasks) {
                rows.push([dateKey, contractor, unit, (t && t.text) ? t.text : ""]);
            }
        }
    }
    if (rows.length === 1) {
        alert("No tasks to export.");
        return;
    }
    const csv = rows.map(r => r.map(cell => {
        const s = String(cell);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\r\n");
    // Prepend BOM so Excel reads UTF-8 correctly
    const blob = new Blob(["﻿" + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `construction_log_${dateKey.replace(/-/g, '')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { } }, 5000);
}

function exportPDF() {
    // Use the browser's native Print → "Save as PDF" — works on iOS/Android/Desktop without external libs
    window.print();
}

async function saveAllPhotos(photoData) {
    if (!photoData || photoData.length === 0) {
        alert("No photos to save.");
        return;
    }

    const dateStr = getDateKey().replace(/-/g, '');

    // Always use direct download — never navigator.share (which opens WhatsApp)
    const tempUrls = [];
    for (let i = 0; i < photoData.length; i++) {
        try {
            const res = await fetch(photoData[i].url);
            const blob = await res.blob();
            const filename = `${dateStr}_${photoData[i].unit}_${i + 1}.jpg`;
            const url = URL.createObjectURL(blob);
            tempUrls.push(url);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            await new Promise(r => setTimeout(r, 300));
        } catch (e) {
            console.error('Photo save failed:', e);
        }
    }
    setTimeout(() => {
        tempUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) { } });
    }, 5000);
}


