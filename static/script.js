
const form = document.getElementById("command-form");
const input = document.getElementById("command-input");
const predictBtn = document.getElementById("predict-btn");
const executeBtn = document.getElementById("execute-btn");
const predictionOutput = document.getElementById("prediction-output");
const executionResult = document.getElementById("execution-result");
const historyPanel = document.getElementById("history");
const objectCount = document.getElementById("object-count");
const canvas = document.getElementById("cad-canvas");
const ctx = canvas.getContext("2d");

let pendingCommand = null;
let objects = [];
let viewport = null;
let tool = "select";
let dragStart = null;
let dragEnd = null;
let drawingBusy = false;
let selectedObjectId = null;
let snapMarker = null;
let moveDrag = null;
let selectionBusy = false;
const snapToggle = document.getElementById("grid-snap");

const suggestionsPanel = document.getElementById("command-suggestions");
const shuffleBtn = document.getElementById("shuffle-suggestions");
let selectedSuggestion = null;
let requestToken = 0;

function sample(items, count) {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
}

function item(text, command, category, targetType = null) { return { text, command, category, targetType }; }
function makeSuggestions() {
    // Keep sentences close to the model's training dataset, with familiar small integers.
    const draw = [
        item("Please draw a line from (1,2) to (6,2).", {command:"CREATE_LINE",x1:1,y1:2,x2:6,y2:2}, "Draw"),
        item("Could you draw a line from (-3,0) to (5,4).", {command:"CREATE_LINE",x1:-3,y1:0,x2:5,y2:4}, "Draw"),
        item("Could you add a circle of radius 4 at center (-3,0).", {command:"CREATE_CIRCLE",radius:4,x:-3,y:0}, "Draw"),
        item("Please add a circle of radius 3 at center (2,2).", {command:"CREATE_CIRCLE",radius:3,x:2,y:2}, "Draw"),
        item("add a rectangle of width 4 and height 6 anchored at (1,2).", {command:"CREATE_RECTANGLE",width:4,height:6,x:1,y:2}, "Draw"),
        item("add a rectangle of width 2 and height 3 anchored at (-3,4).", {command:"CREATE_RECTANGLE",width:2,height:3,x:-3,y:4}, "Draw"),
        item("Please add a point at (3,5).", {command:"CREATE_POINT",x:3,y:5}, "Draw"),
        item("Please add a point at (0,2).", {command:"CREATE_POINT",x:0,y:2}, "Draw")
    ];
    const edits = [];
    for (const obj of objects) {
        if (!Number.isInteger(obj.id) || obj.id < 1 || !["line", "circle", "rectangle", "point"].includes(obj.type)) continue;
        const id = obj.id, type = obj.type;
        edits.push(item(`Please move object ${id} by dx 2 and dy 1.`, {command:"MOVE_OBJECT",id,dx:2,dy:1}, "Move", type));
        edits.push(item(`duplicate object ${id} by dx 3 and dy 2.`, {command:"DUPLICATE_OBJECT",id,dx:3,dy:2}, "Duplicate", type));
        if (obj.color !== "red") edits.push(item(`Could you change object ${id} to red.`, {command:"SET_COLOR",id,color:"red"}, "Style", type));
        edits.push(item(`Please set the width of object ${id} to 3.`, {command:"SET_WIDTH",id,value:3}, "Style", type));
        edits.push(item(`delete object ${id}.`, {command:"DELETE_OBJECT",id}, "Delete", type));
        if (type === "line" && Math.hypot(obj.x2-obj.x1,obj.y2-obj.y1) > 0.00001) {
            edits.push(item(`Could you set the length of object ${id} to 8.`, {command:"SET_LENGTH",id,value:8}, "Modify", type));
            edits.push(item(`Please rotate object ${id} by 30 degrees counterclockwise about its anchor.`, {command:"ROTATE_OBJECT",id,angle:30}, "Rotate", type));
        }
    }
    // Choose different operations instead of flooding the demo with duplicate variations.
    const choices = [];
    if (objects.length === 0) {
        for (const name of ["CREATE_LINE", "CREATE_CIRCLE", "CREATE_RECTANGLE", "CREATE_POINT"]) {
            choices.push(sample(draw.filter(x => x.command.command === name), 1)[0]);
        }
        choices.push(...sample(draw.filter(x => !choices.includes(x)), 2));
    } else {
        choices.push(...sample(draw, 3));
        const preferred = ["Move", "Duplicate", "Modify", "Style", "Rotate", "Delete"];
        const categories = sample(preferred.filter(category => edits.some(x => x.category === category)), 3);
        for (const category of categories) choices.push(sample(edits.filter(x => x.category === category), 1)[0]);
        if (choices.length < 6) choices.push(...sample(draw.filter(x => !choices.includes(x)), 6 - choices.length));
    }
    suggestionsPanel.replaceChildren();
    for (const suggestion of sample(choices, 6)) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "suggestion-card";
        card.textContent = suggestion.text;
        card.title = suggestion.targetType ? `${suggestion.category} · ${suggestion.targetType} #${suggestion.command.id}` : suggestion.category;
        card.disabled = predictBtn.disabled;
        card.addEventListener("click", () => {
            selectedSuggestion = suggestion;
            input.value = suggestion.text;
            form.requestSubmit();
        });
        suggestionsPanel.appendChild(card);
    }
}

function sameCommand(a, b) {
    if (!a || !b || Object.keys(a).length !== Object.keys(b).length) return false;
    return Object.keys(b).every(key => Object.hasOwn(a, key) &&
        (typeof b[key] === "number" ? typeof a[key] === "number" && Math.abs(a[key]-b[key]) < 1e-6 : a[key] === b[key]));
}

function objectStillMatches(suggestion) {
    const id = suggestion?.command?.id;
    if (id === undefined) return true;
    const target = objects.find(obj => obj.id === id);
    return Boolean(target && (!suggestion.targetType || target.type === suggestion.targetType));
}

shuffleBtn.addEventListener("click", makeSuggestions);
input.addEventListener("input", () => { selectedSuggestion = null; });

async function api(path, payload = null) {
    const response = await fetch(path, {
        method: payload === null ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: payload === null ? undefined : JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(typeof data.detail === "string"
            ? data.detail : JSON.stringify(data.detail || data));
    }
    return data;
}

function drawCanvas() {
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Determine bounds from the current geometry.
    const points = [{ x: 0, y: 0 }];

    for (const obj of objects) {
        if (obj.type === "line") {
            points.push({ x: obj.x1, y: obj.y1 });
            points.push({ x: obj.x2, y: obj.y2 });
        } else if (obj.type === "circle") {
            const x = obj.x ?? obj.cx ?? 0;
            const y = obj.y ?? obj.cy ?? 0;
            points.push({ x: x - obj.radius, y: y - obj.radius });
            points.push({ x: x + obj.radius, y: y + obj.radius });
        } else if (obj.type === "rectangle") {
            points.push({ x: obj.x, y: obj.y });
            points.push({ x: obj.x + (obj.geometry_width ?? obj.width), y: obj.y + obj.height });
        } else if (obj.type === "point") {
            points.push({ x: obj.x, y: obj.y });
        }
    }

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const rangeX = Math.max(10, maxX - minX);
    const rangeY = Math.max(10, maxY - minY);
    const scale = Math.min((width - 100) / rangeX, (height - 100) / rangeY);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    viewport = {scale, centerX, centerY, width, height};

    function screen(x, y) {
        return {
            x: width / 2 + (x - centerX) * scale,
            y: height / 2 - (y - centerY) * scale
        };
    }

    // Grid.
    ctx.strokeStyle = "#edf0f5";
    ctx.lineWidth = 1;
    const gridStep = Math.max(1, Math.ceil(40 / scale));

    const left = centerX - width / (2 * scale);
    const right = centerX + width / (2 * scale);
    const bottom = centerY - height / (2 * scale);
    const top = centerY + height / (2 * scale);

    for (let x = Math.ceil(left / gridStep) * gridStep; x <= right; x += gridStep) {
        const p = screen(x, 0);
        ctx.beginPath();
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, height);
        ctx.stroke();
    }

    for (let y = Math.ceil(bottom / gridStep) * gridStep; y <= top; y += gridStep) {
        const p = screen(0, y);
        ctx.beginPath();
        ctx.moveTo(0, p.y);
        ctx.lineTo(width, p.y);
        ctx.stroke();
    }

    // Axes.
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    const origin = screen(0, 0);
    ctx.beginPath();
    ctx.moveTo(origin.x, 0);
    ctx.lineTo(origin.x, height);
    ctx.moveTo(0, origin.y);
    ctx.lineTo(width, origin.y);
    ctx.stroke();

    // Objects.
    for (const obj of objects) {
        ctx.strokeStyle = obj.color || "#2563eb";
        ctx.fillStyle = obj.color || "#2563eb";
        ctx.lineWidth = Math.max(1, obj.width || 1);

        let labelPoint = null;

        if (obj.type === "line") {
            const a = screen(obj.x1, obj.y1);
            const b = screen(obj.x2, obj.y2);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            labelPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

        } else if (obj.type === "circle") {
            const p = screen(obj.x ?? obj.cx ?? 0, obj.y ?? obj.cy ?? 0);
            ctx.beginPath();
            ctx.arc(p.x, p.y, obj.radius * scale, 0, Math.PI * 2);
            ctx.stroke();
            labelPoint = p;

        } else if (obj.type === "rectangle") {
            const a = screen(obj.x, obj.y);
            ctx.strokeRect(a.x, a.y - obj.height * scale,
                (obj.geometry_width ?? obj.width) * scale, obj.height * scale);
            labelPoint = a;

        } else if (obj.type === "point") {
            const p = screen(obj.x, obj.y);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();
            labelPoint = p;
        }

        if (labelPoint !== null) {
            if (obj.id === selectedObjectId) {
                ctx.beginPath(); ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2;
                ctx.strokeRect(labelPoint.x - 6, labelPoint.y - 6, 12, 12);
            }
            ctx.fillStyle = "#334155";
            ctx.font = "12px Arial";
            ctx.fillText(`#${obj.id}`, labelPoint.x + 8, labelPoint.y - 8);
        }
    }

    if (moveDrag && moveDrag.moved) {
        const obj=objects.find(o=>o.id===moveDrag.id);
        if (obj) {
            const dx=moveDrag.current.x-moveDrag.start.x, dy=moveDrag.current.y-moveDrag.start.y;
            ctx.save(); ctx.strokeStyle="#f59e0b"; ctx.lineWidth=2; ctx.setLineDash([5,3]);
            const p=(x,y)=>screen(x+dx,y+dy);
            if (obj.type==="line") { const a=p(obj.x1,obj.y1),b=p(obj.x2,obj.y2);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke(); }
            else if (obj.type==="circle") {const a=p(obj.x,obj.y);ctx.beginPath();ctx.arc(a.x,a.y,obj.radius*scale,0,Math.PI*2);ctx.stroke();}
            else if (obj.type==="rectangle") {const a=p(obj.x,obj.y);ctx.strokeRect(a.x,a.y-obj.height*scale,(obj.geometry_width??obj.width)*scale,obj.height*scale);}
            else if (obj.type==="point") {const a=p(obj.x,obj.y);ctx.beginPath();ctx.arc(a.x,a.y,6,0,Math.PI*2);ctx.stroke();}
            ctx.restore();
        }
    }
    if (dragStart && dragEnd) drawPreview();
    if (snapMarker && tool !== "select") {
        const p = screen(snapMarker.x, snapMarker.y);
        ctx.save(); ctx.strokeStyle = "#16a34a"; ctx.lineWidth = 2;
        ctx.strokeRect(p.x - 5, p.y - 5, 10, 10); ctx.restore();
    }
    objectCount.textContent = `${objects.length} Objects` + (selectedObjectId === null ? "" : ` · Selected #${selectedObjectId}`);
}

async function refreshState() {
    const state = await api("/state");
    objects = state.objects || [];
    if (!objects.some(o => o.id === selectedObjectId)) selectedObjectId = null;
    drawCanvas();
    updateSelectionPanel();
    makeSuggestions();
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;

    const activeSuggestion = selectedSuggestion && input.value.trim() === selectedSuggestion.text ? selectedSuggestion : null;
    const token = ++requestToken;
    pendingCommand = null;
    executeBtn.disabled = true;
    predictBtn.disabled = true;
    suggestionsPanel.querySelectorAll("button").forEach(card => { card.disabled = true; });
    predictionOutput.value = "Generating command...";

    try {
        const data = await api("/predict", { text: input.value.trim() });
        if (token !== requestToken) return;
        pendingCommand = data.command;
        predictionOutput.value = JSON.stringify(pendingCommand, null, 2);
        if (activeSuggestion && !sameCommand(pendingCommand, activeSuggestion.command)) {
            executionResult.textContent = "Model output differs from this example. Execution blocked to protect the demo.";
            pendingCommand = null;
            executeBtn.disabled = true;
        } else {
            executionResult.textContent = activeSuggestion ? "Prediction verified against suggested command." : "Prediction ready for review.";
            executeBtn.disabled = false;
        }
    } catch (error) {
        predictionOutput.value = `Prediction error: ${error.message}`;
    } finally {
        predictBtn.disabled = false;
        suggestionsPanel.querySelectorAll("button").forEach(card => { card.disabled = false; });
    }
});

executeBtn.addEventListener("click", async () => {
    if (!pendingCommand) return;

    let editedCommand;

    try {
        editedCommand = JSON.parse(predictionOutput.value);
    } catch (error) {
        executionResult.textContent = "Invalid JSON: " + error.message;
        return;
    }

    if (!editedCommand || typeof editedCommand !== "object"
        || Array.isArray(editedCommand)
        || typeof editedCommand.command !== "string") {
        executionResult.textContent = "Invalid CAD command.";
        return;
    }

    if (selectedSuggestion && !sameCommand(editedCommand, selectedSuggestion.command)) {
        executionResult.textContent = "Suggested command was changed or predicted incorrectly. Execution blocked.";
        return;
    }
    executeBtn.disabled = true;

    try {
        if (selectedSuggestion) {
            await refreshState();
            if (!objectStillMatches(selectedSuggestion)) throw new Error("Target object changed. Please choose another example.");
        }
        const data = await api("/execute", { command: editedCommand });
        executionResult.textContent = typeof data.result === "string"
            ? data.result : JSON.stringify(data.result);

        const entry = document.createElement("div");
        entry.textContent = `${input.value.trim()} → ${executionResult.textContent}`;
        historyPanel.prepend(entry);

        objects = data.objects || [];
        if (!objects.some(o => o.id === selectedObjectId)) selectedObjectId = null;
        drawCanvas();
        updateSelectionPanel();
        makeSuggestions();
        pendingCommand = null;
        selectedSuggestion = null;
    } catch (error) {
        executionResult.textContent = `Execution error: ${error.message}`;
        executeBtn.disabled = false;
    }
});

document.getElementById("undo-btn").addEventListener("click", async () => {
    try {
        await api("/execute", { command: { command: "UNDO" } });
        await refreshState();
        executionResult.textContent = "Undo completed.";
    } catch (error) {
        executionResult.textContent = error.message;
    }
});

document.getElementById("reset-btn").addEventListener("click", async () => {
    if (!window.confirm("Clear the entire canvas?")) return;

    try {
        await api("/execute", { command: { command: "CLEAR_CANVAS" } });
        await refreshState();
        executionResult.textContent = "Canvas cleared.";
    } catch (error) {
        executionResult.textContent = error.message;
    }
});

refreshState().catch(error => {
    executionResult.textContent = `Connection error: ${error.message}`;
});


document.getElementById("export-dxf-btn").addEventListener("click", () => {
    window.location.href = "/export/dxf";
});



// Manual drawing uses the same /execute endpoint as NLP commands.
const toolButtons = [...document.querySelectorAll(".draw-tool")];
function chooseTool(name) {
    tool = name;
    dragStart = dragEnd = snapMarker = null;
    toolButtons.forEach(b => { b.classList.toggle("active", b.dataset.tool === name); b.setAttribute("aria-pressed", String(b.dataset.tool === name)); });
    canvas.classList.toggle("drawing", tool !== "select");
    drawCanvas();
    updateSelectionPanel();
}
toolButtons.forEach(button => button.addEventListener("click", () => chooseTool(button.dataset.tool)));

function mouseWorld(event) {
    const rect = canvas.getBoundingClientRect();
    const sx = (event.clientX - rect.left) * canvas.width / rect.width;
    const sy = (event.clientY - rect.top) * canvas.height / rect.height;
    const v = viewport;
    return { x: v.centerX + (sx-v.width/2)/v.scale, y: v.centerY - (sy-v.height/2)/v.scale };
}
// Snap only near an actual visible grid intersection (12 screen pixels).
// The grid and snap use exactly the same spacing and origin.
function gridStep() { return Math.max(1, Math.ceil(40 / viewport.scale)); }
function snapWorld(point) {
    snapMarker = null;
    if (!snapToggle.checked || tool === "select" || !viewport) return point;
    const step = gridStep();
    const candidate = {x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step};
    const distancePx = Math.hypot(candidate.x - point.x, candidate.y - point.y) * viewport.scale;
    if (distancePx > 12) return point;
    snapMarker = candidate;
    return candidate;
}
snapToggle.addEventListener("change", () => { snapMarker = null; drawCanvas(); });
function toScreen(point) {
    const v = viewport;
    return {x: v.width/2+(point.x-v.centerX)*v.scale, y: v.height/2-(point.y-v.centerY)*v.scale};
}
function roundCoord(n) { return Math.round(n * 100) / 100; }
function drawPreview() {
    const a=toScreen(dragStart), b=toScreen(dragEnd);
    ctx.save(); ctx.strokeStyle="#2563eb"; ctx.lineWidth=2; ctx.setLineDash([6,4]);
    ctx.beginPath();
    if (tool === "line") {ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);}
    else if (tool === "rectangle") {ctx.rect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y));}
    else if (tool === "circle") {ctx.arc(a.x,a.y,Math.hypot(b.x-a.x,b.y-a.y),0,Math.PI*2);}
    ctx.stroke(); ctx.restore();
}
function drawingCommand(a,b) {
    if (tool === "point") return {command:"CREATE_POINT",x:roundCoord(a.x),y:roundCoord(a.y)};
    if (tool === "line") {
        if (Math.hypot(b.x-a.x,b.y-a.y) < .05) return null;
        return {command:"CREATE_LINE",x1:roundCoord(a.x),y1:roundCoord(a.y),x2:roundCoord(b.x),y2:roundCoord(b.y)};
    }
    if (tool === "rectangle") {
        const x=roundCoord(Math.min(a.x,b.x)),y=roundCoord(Math.min(a.y,b.y));
        const width=roundCoord(Math.abs(b.x-a.x)),height=roundCoord(Math.abs(b.y-a.y));
        return width>=.05 && height>=.05 ? {command:"CREATE_RECTANGLE",x,y,width,height} : null;
    }
    if (tool === "circle") {
        const radius=roundCoord(Math.hypot(b.x-a.x,b.y-a.y));
        return radius>=.05 ? {command:"CREATE_CIRCLE",x:roundCoord(a.x),y:roundCoord(a.y),radius} : null;
    }
    return null;
}
// Hit testing uses screen pixels so selecting is reliable at any zoom level.
function segmentDistance(p, a, b) {
    const dx=b.x-a.x, dy=b.y-a.y, d=dx*dx+dy*dy;
    const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
    return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
function pickObject(event) {
    const rect=canvas.getBoundingClientRect();
    const p={x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
    let best=null, bestDistance=12;
    for (const obj of objects) {
        let distance=Infinity;
        if (obj.type === "line") distance=segmentDistance(p,toScreen({x:obj.x1,y:obj.y1}),toScreen({x:obj.x2,y:obj.y2}));
        else if (obj.type === "circle") {
            const c=toScreen({x:obj.x,y:obj.y});
            distance=Math.abs(Math.hypot(p.x-c.x,p.y-c.y)-obj.radius*viewport.scale);
        } else if (obj.type === "rectangle") {
            const a=toScreen({x:obj.x,y:obj.y});
            const w=(obj.geometry_width ?? obj.width)*viewport.scale, h=obj.height*viewport.scale;
            const v=[{x:a.x,y:a.y},{x:a.x+w,y:a.y},{x:a.x+w,y:a.y-h},{x:a.x,y:a.y-h}];
            distance=Math.min(...v.map((q,i)=>segmentDistance(p,q,v[(i+1)%4])));
        } else if (obj.type === "point") {
            const c=toScreen({x:obj.x,y:obj.y}); distance=Math.hypot(p.x-c.x,p.y-c.y);
        }
        if (distance <= bestDistance) { best=obj; bestDistance=distance; }
    }
    return best;
}
// Pointer selection is managed on pointerdown so drag-to-move works.
function updateSelectionPanel() {
    const panel=document.getElementById("selection-panel");
    const obj=objects.find(o=>o.id===selectedObjectId);
    panel.hidden=!obj;
    if (!obj) return;
    document.getElementById("selected-label").textContent=`${obj.type[0].toUpperCase()+obj.type.slice(1)} #${obj.id}`;
    document.getElementById("object-color").value=obj.color||"black";
    document.getElementById("object-width").value=obj.width||1;
    const lengthField=document.getElementById("length-field");
    lengthField.hidden=obj.type!=="line";
    if (obj.type==="line") document.getElementById("object-length").value=Math.hypot(obj.x2-obj.x1,obj.y2-obj.y1).toFixed(2);
}
function showSelection(id) {
    selectedObjectId=id;
    drawCanvas(); updateSelectionPanel();
    executionResult.textContent=id===null?"Selection cleared.":`Selected object #${id}. Drag to move, or edit properties below.`;
}
async function editSelected(commands, description) {
    if (selectionBusy || selectedObjectId===null) return;
    const id=selectedObjectId; selectionBusy=true;
    try {
        await refreshState();
        if (!objects.some(o=>o.id===id)) throw Error("The selected object no longer exists.");
        for (const command of commands) {
            const result=await api("/execute",{command});
            objects=result.objects||[];
        }
        if (!objects.some(o=>o.id===selectedObjectId)) selectedObjectId=null;
        const entry=document.createElement("div");entry.textContent=description;historyPanel.prepend(entry);
        executionResult.textContent=description;
        drawCanvas(); updateSelectionPanel(); makeSuggestions();
    } catch(error) { executionResult.textContent=`Edit error: ${error.message}`; await refreshState(); }
    finally { selectionBusy=false; }
}
document.getElementById("deselect-btn").addEventListener("click",()=>showSelection(null));
document.getElementById("delete-selected-btn").addEventListener("click",()=>{
    if (selectedObjectId!==null) editSelected([{command:"DELETE_OBJECT",id:selectedObjectId}],`Deleted object #${selectedObjectId}.`);
});
document.getElementById("duplicate-selected-btn").addEventListener("click",()=>{
    if (selectedObjectId!==null) editSelected([{command:"DUPLICATE_OBJECT",id:selectedObjectId,dx:2,dy:2}],`Duplicated object #${selectedObjectId}.`);
});
document.getElementById("apply-properties-btn").addEventListener("click",()=>{
    const obj=objects.find(o=>o.id===selectedObjectId);if(!obj)return;
    const color=document.getElementById("object-color").value;
    const width=Number(document.getElementById("object-width").value);
    if (!Number.isFinite(width)||width<=0||width>30) { executionResult.textContent="Invalid stroke width.";return; }
    const commands=[];
    if (obj.color!==color) commands.push({command:"SET_COLOR",id:obj.id,color});
    if (obj.width!==width) commands.push({command:"SET_WIDTH",id:obj.id,value:width});
    if(obj.type==="line") {
        const length=Number(document.getElementById("object-length").value);
        if(!Number.isFinite(length)||length<=0||length>1000000) { executionResult.textContent="Invalid line length.";return; }
        if (Math.hypot(obj.x2-obj.x1,obj.y2-obj.y1)===0 && Math.abs(length)>0) {executionResult.textContent="Cannot resize zero-length line.";return;}
        if (Math.abs(Math.hypot(obj.x2-obj.x1,obj.y2-obj.y1)-length)>0.001)commands.push({command:"SET_LENGTH",id:obj.id,value:length});
    }
    if(commands.length) editSelected(commands,`Updated properties of object #${obj.id}.`);
});
// Avoid deleting while editing text or numeric fields.
document.addEventListener("keydown",event=>{
    if (event.key!=="Delete"&&event.key!=="Backspace") return;
    if (event.target.closest("input,textarea,select,[contenteditable]")) return;
    if(tool!=="select"||selectedObjectId===null)return;
    event.preventDefault();editSelected([{command:"DELETE_OBJECT",id:selectedObjectId}],`Deleted selected object.`);
});
canvas.addEventListener("pointerdown", event => {
    if (event.button!==0 || drawingBusy || selectionBusy) return;
    if (tool==="select") {
        const obj=pickObject(event);
        showSelection(obj?.id??null);
        if(obj) { moveDrag={id:obj.id,start:mouseWorld(event),current:mouseWorld(event),moved:false};canvas.setPointerCapture(event.pointerId); }
        return;
    }
    // Freeze viewport during pointer interaction. Drawing refreshes after releasing the pointer.
    dragStart=snapWorld(mouseWorld(event)); dragEnd={...dragStart};
    canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", event => {
    if (moveDrag && !drawingBusy) {
        moveDrag.current=mouseWorld(event);
        moveDrag.moved=Math.hypot((moveDrag.current.x-moveDrag.start.x)*viewport.scale,(moveDrag.current.y-moveDrag.start.y)*viewport.scale)>3;
        drawCanvas();return;
    }
    if (!dragStart || drawingBusy) return;
    dragEnd=snapWorld(mouseWorld(event));
    drawCanvas();
});
canvas.addEventListener("pointerup", async event => {
    if (moveDrag) {
        const drag=moveDrag;moveDrag=null;
        if (drag.moved) {
            const end=mouseWorld(event),dx=roundCoord(end.x-drag.start.x),dy=roundCoord(end.y-drag.start.y);
            if(dx!==0||dy!==0) await editSelected([{command:"MOVE_OBJECT",id:drag.id,dx,dy}],`Moved object #${drag.id} by (${dx}, ${dy}).`);
        } else {
            try {await api("/execute",{command:{command:"SELECT_OBJECT",id:drag.id}});}catch(error){executionResult.textContent=error.message;}
        }
        drawCanvas();return;
    }
    if (!dragStart || drawingBusy) return;
    const a=dragStart,b=snapWorld(mouseWorld(event));
    dragStart=dragEnd=snapMarker=null;
    drawCanvas();
    const command=drawingCommand(a,b);
    if (!command) { executionResult.textContent="Draw a larger shape to create it."; return; }
    drawingBusy=true;
    try {
        const data=await api("/execute",{command});
        objects=data.objects || [];
        // A hand-drawn shape changes the context of generated command suggestions.
        selectedSuggestion=null; pendingCommand=null; executeBtn.disabled=true;
        predictionOutput.value="No prediction yet.";
        const entry=document.createElement("div");
        entry.textContent=`Manual ${command.command.replace("CREATE_", "").toLowerCase()} → ${data.result}`;
        historyPanel.prepend(entry);
        executionResult.textContent=data.result;
        drawCanvas(); makeSuggestions();
    } catch(error) { executionResult.textContent=`Drawing error: ${error.message}`; }
    finally { drawingBusy=false; }
});
canvas.addEventListener("pointercancel", () => {moveDrag=null;dragStart=dragEnd=snapMarker=null; drawCanvas();});
document.addEventListener("keydown", event => {if (event.key === "Escape") {moveDrag=null;dragStart=dragEnd=snapMarker=null;if(tool==="select")showSelection(null);else drawCanvas();}});
