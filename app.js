// Main JS - V3
// Data Configuration
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

// ... (skipping unchanged parts) ...

function generateContractorReportData(contractor) {
    const data = currentReport[contractor];
    let units = Object.keys(data).sort(naturalSort);
    let allPhotoUrls = [];
    let body = "";

    units.forEach(unit => {
        const unitData = data[unit];
        allPhotoUrls = allPhotoUrls.concat(unitData.photos);

        if (unitData.tasks.length > 0) {
            body += `${unit}\n`; // Unit Name on new line
            unitData.tasks.forEach(t => {
                body += `${t.text}\n`; // Task on new line (no bullet for cleaner copy)
            });
            body += `\n`; // Empty line between units
        }
    });

    const fullText = `${contractor}\n\n${body}`.trim(); // Contractor Name + 2 newlines
    return { text: fullText, photoUrls: allPhotoUrls };
}

// State
let currentReport = {};
let selectedUnit = null;
let currentTaskList = [];
let selectedPhotoFloor = null;
let cameraStream = null;
let pendingOptions = new Set(); // For multi-select in modal
let pendingTaskName = "";
let pendingTaskCategory = "";
// Camera
let cameraDevices = [];
let currentDeviceIndex = 0;

const STORAGE_KEY = "construction_log_data";

document.addEventListener("DOMContentLoaded", async () => {
    await loadLocalData();
    initGrid();
    renderAllReports();
});

// Init
function initGrid() {
    const grid = document.getElementById("unit-grid");
    grid.innerHTML = "";
    units.forEach(unit => {
        const contractor = getContractor(unit);
        const btn = document.createElement("button");
        btn.className = "unit-btn";
        // Modern Pop Style HTML
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
        case "IADECCO": return "var(--color-iadecco)"; // Red
        case "YAMATO": return "var(--color-yamato)";   // Blue
        case "INITI INDAH": return "var(--color-initi)"; // Green
        default: return "var(--color-unassigned)";
    }
}

// UI Opening
function openInput(unit, contractor) {
    selectedUnit = unit;
    selectedPhotoFloor = null;

    // Load existing tasks if any, or start clean
    if (currentReport[contractor] && currentReport[contractor][unit]) {
        // Clone to avoid reference issues
        currentTaskList = [...currentReport[contractor][unit].tasks.map(t => t.text)];
    } else {
        currentTaskList = [];
    }

    // Full screen Overlay
    document.body.style.overflow = "hidden"; // Prevent background scroll
    document.getElementById("input-section").classList.remove("hidden");

    document.getElementById("selected-unit-display").textContent = unit;
    // Badge removed

    // Reset contents
    document.getElementById("preview-gallery").innerHTML = "";
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
    document.getElementById("custom-task-input").value = "";
    renderTaskList();
    updateTaskCount();

    // Load existing photos for preview
    renderPhotoPreview();

    switchTab('photo');
}

function resetSelection() {
    document.body.style.overflow = "auto";
    document.getElementById("input-section").classList.add("hidden");

    // Hard reset of all temporary state
    selectedUnit = null;
    currentTaskList = [];
    pendingOptions.clear();
    pendingTaskName = "";
    document.getElementById("custom-task-input").value = "";
    document.getElementById("task-list-display").innerHTML = ""; // Visually clear immediately

    stopCamera();
    renderAllReports();
}

// ... (skip unchanged) ...

// ---------------------------------------------------------
// SAVING & REPORTING
// ---------------------------------------------------------
// [Deleted duplicate saveAndClose function from here]

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

// ---------------------------------------------------------
// SMART TASK MODAL (MULTI-SELECT)
// ---------------------------------------------------------
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
    else if (type === 'rebar_struct_targets') options = ["Pile cap", "Retaining wall", "Beam", "Slab", "Column"];
    else if (type === 'rebar_fab_targets') options = ["Pile cap", "Beam", "Slab", "Retaining wall", "Column"];
    else if (type === 'casting_targets') options = ["Slab", "Beam", "Pile cap", "Retaining wall", "Column", "Car port slope"];
    else if (type === 'formwork_targets') options = ["Pile cap", "Beam", "Slab", "Retaining wall", "Column"];
    else if (type === 'demolishing_targets') options = ["Beam", "Slab", "Retaining wall", "Column"];
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

    // Add click listener to background
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeModal();
        }
    };
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
    if (pendingOptions.size === 0) {
        closeModal();
        return;
    }

    const selectedArray = Array.from(pendingOptions);
    const joinedSelection = selectedArray.join(", "); // "GF, 1F"

    // 2-Step Flow for Rebar (Struct), Casting, Form work, Demolishing
    if (pendingTaskCategory === 'rebar_struct_targets' || pendingTaskCategory === 'casting_targets' || pendingTaskCategory === 'formwork_targets' || pendingTaskCategory === 'demolishing_targets') {
        // Step 2: Now ask for floor for these items
        if (pendingTaskCategory === 'casting_targets') {
            pendingTaskName = `Casting concrete for ${joinedSelection}`;
        } else if (pendingTaskCategory === 'formwork_targets') {
            pendingTaskName = `Form work installation for ${joinedSelection}`;
        } else if (pendingTaskCategory === 'demolishing_targets') {
            pendingTaskName = `Demolishing formwork for ${joinedSelection}`;
        } else {
            pendingTaskName = `Rebar Installation for ${joinedSelection}`;
        }

        pendingTaskCategory = 'floor_lift_rebar'; // Reuse existing floor options

        // Clear modal for Step 2
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
        return; // Don't close, wait for floor selection
    }

    // Single-step target flows (no floor selection)
    if (pendingTaskCategory === 'excavation_targets' || pendingTaskCategory === 'rebar_fab_targets' || pendingTaskCategory === 'lean_concrete_targets') {
        let prefix;
        if (pendingTaskCategory === 'lean_concrete_targets') {
            prefix = 'Lean concrete for';
        } else if (pendingTaskCategory === 'rebar_fab_targets') {
            prefix = 'Rebar fabrication for';
        } else {
            prefix = `${pendingTaskName} for`;
        }
        addTaskDirect(`${prefix} ${joinedSelection}`);
        closeModal();
        return;
    }

    // Default text generation
    let finalText = "";
    if (pendingTaskCategory.includes('floor')) {
        finalText = `${pendingTaskName} on ${joinedSelection}`;
    } else {
        finalText = `${pendingTaskName} for ${joinedSelection}`;
    }

    addTaskDirect(finalText);
    closeModal();
}

function closeModal() {
    document.getElementById("option-modal").classList.add("hidden");
}

// ---------------------------------------------------------
// TASK LIST MANAGEMENT
// ---------------------------------------------------------
function addTaskDirect(text) {
    currentTaskList.push(text);
    renderTaskList();
    updateTaskCount();
    // Aggressive Save
    syncCurrentUnitData();
    saveLocalData();
}

function addCustomTask() {
    const input = document.getElementById("custom-task-input");
    const val = input.value.trim();
    if (val) {
        addTaskDirect(val);
        input.value = "";
    }
}

function removeTask(index) {
    currentTaskList.splice(index, 1);
    renderTaskList();
    updateTaskCount();
    // Aggressive Save
    syncCurrentUnitData();
    saveLocalData();
}

function syncCurrentUnitData() {
    if (!selectedUnit) return;
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor]) currentReport[contractor] = {};
    if (!currentReport[contractor][selectedUnit]) currentReport[contractor][selectedUnit] = { tasks: [], photos: [] };

    // Preserve photos, update tasks
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

// ---------------------------------------------------------
// CAMERA
// ---------------------------------------------------------
// Camera
async function startCamera() {
    if (cameraStream) return;
    try {
        let constraints;

        // Base constraints for 4:3 aspect ratio (portrait-ish)
        // Note: In landscape, 4:3 is width > height. In portrait, height > width.
        // We'll ask for an ideal resolution that matches 4:3.
        const baseConstraints = {
            aspectRatio: { ideal: 1.333 }, // 4:3
            width: { ideal: 1920 }, // Requesting high res
            height: { ideal: 1440 }
        };

        if (cameraDevices.length > 0 && cameraDevices[currentDeviceIndex]?.deviceId) {
            constraints = {
                video: {
                    deviceId: { exact: cameraDevices[currentDeviceIndex].deviceId },
                    ...baseConstraints
                },
                audio: false
            };
        } else {
            constraints = {
                video: {
                    facingMode: { ideal: "environment" },
                    ...baseConstraints
                },
                audio: false
            };
        }

        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        const video = document.getElementById("camera-stream");
        video.srcObject = cameraStream;

        // Apply WEAKER, more natural HDR-like filter
        // Old: contrast(1.15) saturate(1.3) brightness(1.05)
        video.style.filter = "contrast(1.05) saturate(1.1) brightness(1.02)";

        document.getElementById("camera-overlay").classList.remove("hidden");

        if (cameraDevices.length === 0) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            cameraDevices = devices.filter(d => d.kind === 'videoinput');

            // Try to find ULTRA wide angle camera (0.5x)
            // Keywords: "0.5", "ultra", "wide". 
            // Often back camera ID 2 or similar on phones.
            // We prioritize finding one that isn't the current one.
            const ultraWideIdx = cameraDevices.findIndex(d =>
                /0\.5|ultra|wide/i.test(d.label) ||
                (d.getCapabilities && d.getCapabilities().zoom?.min < 1) // logical check if available
            );

            if (ultraWideIdx >= 0 && ultraWideIdx !== currentDeviceIndex) {
                // Switch to ultra-wide
                cameraStream.getTracks().forEach(t => t.stop());
                cameraStream = null;
                currentDeviceIndex = ultraWideIdx;

                const wideConstraints = {
                    video: {
                        deviceId: { exact: cameraDevices[ultraWideIdx].deviceId },
                        ...baseConstraints
                    },
                    audio: false
                };
                cameraStream = await navigator.mediaDevices.getUserMedia(wideConstraints);
                video.srcObject = cameraStream;
            }
        }
    } catch (err) {
        console.error(err);
        alert("Camera Error: " + err.message);
    }
}

async function switchCamera() {
    if (!cameraStream) return;
    if (cameraDevices.length < 2) {
        alert("No other camera found.");
        return;
    }

    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    currentDeviceIndex = (currentDeviceIndex + 1) % cameraDevices.length;

    try {
        const constraints = {
            video: {
                deviceId: { exact: cameraDevices[currentDeviceIndex].deviceId },
                aspectRatio: { ideal: 1.333 },
                width: { ideal: 1920 },
                height: { ideal: 1440 }
            },
            audio: false
        };

        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        const video = document.getElementById("camera-stream");
        video.srcObject = cameraStream;
    } catch (err) {
        console.error("Switch camera failed:", err);
        // Try to restart with default
        cameraStream = null;
        currentDeviceIndex = 0;
        await startCamera();
    }
}

function closeCameraOverlay() {
    stopCamera();
}
function stopCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    document.getElementById("camera-overlay").classList.add("hidden");
}
function capturePhoto() {
    const video = document.getElementById("camera-stream");
    const canvas = document.getElementById("camera-canvas");
    if (!cameraStream) return;

    // Limit photo size
    const maxWidth = 1920;
    let w = video.videoWidth;
    let h = video.videoHeight;

    // Ensure we process with correct aspect ratio if the stream doesn't match
    // But usually we just take the stream size.

    if (w > maxWidth) {
        const scale = maxWidth / w;
        w = maxWidth;
        h = Math.round(h * scale);
    }

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    // Apply WEAKER, natural HDR-like filter to the captured image
    ctx.filter = "contrast(1.05) saturate(1.1) brightness(1.02)";
    ctx.drawImage(video, 0, 0, w, h);
    ctx.filter = "none";

    const includeFloor = document.getElementById("watermark-floor-check").checked;
    const floorText = includeFloor && selectedPhotoFloor ? selectedPhotoFloor : "";
    addWatermark(ctx, canvas, selectedUnit, floorText);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    savePhoto(dataUrl);

    // Auto-close camera after capture
    closeCameraOverlay();
}
function addWatermark(ctx, canvas, unitText, floorText) {
    const fontSize = canvas.width * 0.05;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const dateStr = new Date().toLocaleDateString('en-GB');
    const margin = canvas.width * 0.03;
    const padding = fontSize * 0.4;
    const lineHeight = fontSize * 1.2;

    // Calculate text lines and box size
    const lines = [dateStr, unitText];
    if (floorText) lines.push(floorText);

    let maxWidth = 0;
    lines.forEach(line => {
        const w = ctx.measureText(line).width;
        if (w > maxWidth) maxWidth = w;
    });

    const boxWidth = maxWidth + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2 - (lineHeight - fontSize);
    const boxX = margin - padding;
    const boxY = margin - padding;

    // Draw dark background box
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.beginPath();
    const r = fontSize * 0.3; // border radius
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, r);
    ctx.fill();
    ctx.restore();

    // Draw text
    ctx.fillStyle = "white";
    ctx.shadowColor = "black";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    let yPos = margin + fontSize;
    lines.forEach(line => {
        ctx.fillText(line, margin, yPos);
        yPos += lineHeight;
    });
}
function selectPhotoFloor(floor) {
    selectedPhotoFloor = floor;
    document.querySelector("#photo-tab .chip-group").querySelectorAll(".chip").forEach(c => {
        if (c.textContent === floor) c.classList.add("selected");
        else c.classList.remove("selected");
    });
}
function savePhoto(dataUrl) {
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor]) currentReport[contractor] = {};
    if (!currentReport[contractor][selectedUnit]) currentReport[contractor][selectedUnit] = { tasks: [], photos: [] };
    currentReport[contractor][selectedUnit].photos.push(dataUrl);

    renderPhotoPreview();
    saveLocalData();
}

function renderPhotoPreview() {
    const gallery = document.getElementById("preview-gallery");
    gallery.innerHTML = "";
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor] || !currentReport[contractor][selectedUnit]) return;

    currentReport[contractor][selectedUnit].photos.forEach((url, idx) => {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "position:relative; display:inline-block;";

        const img = document.createElement("img");
        img.src = url;
        img.className = "preview-img";

        const delBtn = document.createElement("button");
        delBtn.textContent = "×";
        delBtn.style.cssText = "position:absolute; top:2px; right:2px; background:rgba(0,0,0,0.7); color:white; border:none; border-radius:50%; width:24px; height:24px; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1;";
        delBtn.onclick = () => removePhoto(idx);

        wrapper.appendChild(img);
        wrapper.appendChild(delBtn);
        gallery.appendChild(wrapper);
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

// ---------------------------------------------------------
// SAVING & REPORTING
// ---------------------------------------------------------
function saveAndClose() {
    const contractor = getContractor(selectedUnit);
    if (!currentReport[contractor]) currentReport[contractor] = {};
    if (!currentReport[contractor][selectedUnit]) currentReport[contractor][selectedUnit] = { tasks: [], photos: [] };

    // Overwrite tasks with current list
    currentReport[contractor][selectedUnit].tasks = currentTaskList.map(t => ({ text: t }));

    resetSelection();
    saveLocalData();
}

function renderAllReports() {
    const container = document.getElementById("reports-container");
    container.innerHTML = "";
    const activeContractors = Object.keys(currentReport);

    if (activeContractors.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#94a3b8; margin-top:20px;">No reports yet.</p>`;
        return;
    }

    activeContractors.forEach(contractor => {
        const { text, photoUrls } = generateContractorReportData(contractor);
        const card = document.createElement("div");
        card.className = "report-card";
        card.style.borderLeftColor = getContractorColor(contractor);

        let imagesHtml = `<div class="preview-gallery">`;
        photoUrls.forEach((url, idx) => {
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const filename = `${dateStr}_${contractor}_${contractor === 'Unassigned' ? 'img' : contractor.substring(0, 3)}_${idx + 1}.jpg`;
            imagesHtml += `<a href="${url}" download="${filename}"><img src="${url}" class="preview-img"></a>`;
        });
        imagesHtml += `</div>`;

        card.innerHTML = `
            <div class="report-header">
                <h3>${contractor}</h3>
            </div>
            <div class="report-content">${text}</div>
            
            <div class="action-row" style="display:flex; gap:10px; margin-top:10px;">
                <button class="copy-btn" onclick="copyText(this, \`${text.replace(/`/g, "\\`")}\`)">
                    📋 Copy Text
                </button>
                <button class="copy-btn" style="background-color:#25D366; color:white;" onclick="shareToWhatsApp('${contractor}')">
                    💬 Share WA
                </button>
            </div>
            <div style="margin-top:10px">${imagesHtml}</div>
        `;
        container.appendChild(card);
    });
}

async function shareToWhatsApp(contractor) {
    const { text, photoUrls } = generateContractorReportData(contractor);

    // Convert dataURLs to File objects
    const files = [];
    for (let i = 0; i < photoUrls.length; i++) {
        try {
            const res = await fetch(photoUrls[i]);
            const blob = await res.blob();
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const file = new File([blob], `${dateStr}_${contractor}_${i + 1}.jpg`, { type: 'image/jpeg' });
            files.push(file);
        } catch (e) {
            console.error('Failed to convert photo', e);
        }
    }

    // Try native share with files
    if (navigator.share) {
        const shareData = {
            title: 'Construction Report',
            text: text
        };

        // Add files if supported
        if (files.length > 0 && navigator.canShare && navigator.canShare({ files })) {
            shareData.files = files;
        }

        try {
            await navigator.share(shareData);
            return;
        } catch (err) {
            console.log("Share failed or canceled", err);
        }
    }

    // Fallback to WhatsApp URL (text only)
    const encoded = encodeURIComponent(text);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
}

function generateContractorReportData(contractor) {
    const data = currentReport[contractor];
    let units = Object.keys(data).sort(naturalSort);
    let allPhotoUrls = [];
    let body = "";

    units.forEach(unit => {
        const unitData = data[unit];
        allPhotoUrls = allPhotoUrls.concat(unitData.photos);

        if (unitData.tasks.length > 0) {
            body += `${unit}:\n`;
            unitData.tasks.forEach(t => {
                body += `-${t.text}\n`;
            });
            body += `\n`;
        }
    });

    const fullText = `${contractor}\n${body}`.trim();
    return { text: fullText, photoUrls: allPhotoUrls };
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

// ---------------------------------------------------------
// INDEXEDDB PERSISTENCE (replaces localStorage for larger storage)
// ---------------------------------------------------------
const DB_NAME = "ConstructionLogDB";
const DB_VERSION = 1;
const DB_STORE = "reports";

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
                db.createObjectStore(DB_STORE, { keyPath: "id" });
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveLocalData() {
    try {
        const dateKey = new Date().toISOString().split('T')[0];
        const payload = {
            id: STORAGE_KEY,
            date: dateKey,
            data: currentReport
        };

        const db = await openDB();
        const tx = db.transaction(DB_STORE, "readwrite");
        const store = tx.objectStore(DB_STORE);
        store.put(payload);
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (e) {
        console.error("Failed to save data:", e);
        // Fallback: try localStorage for task text only (no photos)
        try {
            const dateKey = new Date().toISOString().split('T')[0];
            const taskOnly = {};
            for (const [c, units] of Object.entries(currentReport)) {
                taskOnly[c] = {};
                for (const [u, data] of Object.entries(units)) {
                    taskOnly[c][u] = { tasks: data.tasks, photos: [] };
                }
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: dateKey, data: taskOnly }));
        } catch (e2) {
            console.error("Fallback save also failed:", e2);
        }
    }
}

async function loadLocalData() {
    try {
        const db = await openDB();
        const tx = db.transaction(DB_STORE, "readonly");
        const store = tx.objectStore(DB_STORE);
        const request = store.get(STORAGE_KEY);

        const result = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();

        if (result) {
            const todayKey = new Date().toISOString().split('T')[0];
            if (result.date === todayKey) {
                currentReport = result.data || {};
                console.log("Data loaded from IndexedDB for today.");
            } else {
                console.log("New day detected, clearing old data.");
                currentReport = {};
                await saveLocalData(); // Clear old data
            }
            return;
        }
    } catch (e) {
        console.error("IndexedDB load failed, trying localStorage fallback:", e);
    }

    // Fallback: try loading from old localStorage
    try {
        // Check main key
        let json = localStorage.getItem(STORAGE_KEY);
        // Check backup key  
        if (!json) json = localStorage.getItem(STORAGE_KEY + "_backup");

        if (json) {
            const parsed = JSON.parse(json);
            const todayKey = new Date().toISOString().split('T')[0];
            if (parsed.date === todayKey) {
                currentReport = parsed.data || {};
                console.log("Data loaded from localStorage fallback.");
                // Migrate to IndexedDB
                await saveLocalData();
            }
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(STORAGE_KEY + "_backup");
        }
    } catch (e) {
        console.error("localStorage fallback also failed:", e);
    }
}

// Auto-save when user switches away from the app
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        // Sync any unsaved task data before app goes to background
        if (selectedUnit) {
            syncCurrentUnitData();
        }
        saveLocalData();
    }
});

// Auto-save before page unload
window.addEventListener("beforeunload", () => {
    if (selectedUnit) {
        syncCurrentUnitData();
    }
    // Use synchronous localStorage as last resort (IndexedDB may not complete)
    try {
        const dateKey = new Date().toISOString().split('T')[0];
        const payload = { date: dateKey, data: currentReport };
        localStorage.setItem(STORAGE_KEY + "_backup", JSON.stringify(payload));
    } catch (e) {
        // Best effort only
    }
});
