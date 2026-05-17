// === CONSTANTS & CONFIG ===
const DOT_SPACING = 24;

// === STATE MANAGEMENT ===
let state = {
  currentView: 'dashboard', // 'dashboard' | 'canvas'
  activeNoteId: null,
  notes: {}, // record of Note objects
  isSelectionMode: false,
  selectedNotes: new Set(),
  editor: {
    activeTool: 'pointer',
    selectedObjectId: null,
    isSnapEnabled: true,
    strokeWidth: 2,
    strokeStyle: 'solid',
    color: '#1A1A1A',
    zoom: 1,
    panX: 0,
    panY: 0,
    currentPageIndex: 0,
    isDrawing: false,
    startX: 0,
    startY: 0,
    currentPath: null
  }
};

/*
Note Object Structure:
{
  id: string,
  title: string,
  lastModified: number,
  pages: [
    {
      id: string,
      objects: [
        { id, type: 'rect'|'circle'|'line'|'path'|'text', x, y, width, height, color, strokeWidth, strokeStyle, content, points }
      ]
    }
  ]
}
*/

// === STORAGE SYNC ===
const StorageManager = {
  async load() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(['notes'], (result) => {
          resolve(result.notes || {});
        });
      } else {
        const data = localStorage.getItem('jotdot_notes');
        resolve(data ? JSON.parse(data) : {});
      }
    });
  },
  async save(notes) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ notes }, () => resolve());
      } else {
        localStorage.setItem('jotdot_notes', JSON.stringify(notes));
        resolve();
      }
    });
  }
};

// === DOM ELEMENTS ===
const els = {
  views: {
    dashboard: document.getElementById('dashboard-view'),
    canvas: document.getElementById('canvas-view')
  },
  dash: {
    mostRecent: document.getElementById('most-recent-container'),
    notesGrid: document.getElementById('notes-grid'),
    newNoteBtn: document.getElementById('new-note-btn'),
    deleteModal: document.getElementById('delete-modal'),
    deleteModalText: document.getElementById('delete-modal-text'),
    cancelDeleteBtn: document.getElementById('cancel-delete-btn'),
    confirmDeleteBtn: document.getElementById('confirm-delete-btn')
  },
  canvas: {
    backBtn: document.getElementById('back-to-dashboard-btn'),
    titleInput: document.getElementById('note-title-input'),
    container: document.getElementById('dot-grid-container'),
    prevPageBtn: document.getElementById('prev-page-btn'),
    nextPageBtn: document.getElementById('next-page-btn'),
    pageIndicator: document.getElementById('page-indicator'),
    addPageBtn: document.getElementById('add-page-btn'),
    toggleToolsBtn: document.getElementById('toggle-tools-btn')
  },
  tools: {
    menu: document.getElementById('tool-menu'),
    properties: document.getElementById('properties-toolbar'),
    btns: document.querySelectorAll('.tool-btn'),
    snapToggle: document.getElementById('snap-toggle'),
    strokeWidth: document.getElementById('stroke-width'),
    strokeStyleBtn: document.getElementById('stroke-style-btn'),
    colorPicker: document.getElementById('color-picker')
  }
};

// === INITIALIZATION ===
async function init() {
  state.notes = await StorageManager.load();
  bindEvents();
  renderDashboard();
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// === EVENT BINDING ===
function bindEvents() {
  // Dashboard
  els.dash.newNoteBtn.addEventListener('click', () => {
    if (state.isSelectionMode) {
      openBulkDeleteModal();
    } else {
      createNewNote();
    }
  });
  if (els.dash.cancelDeleteBtn) els.dash.cancelDeleteBtn.addEventListener('click', closeDeleteModal);
  if (els.dash.confirmDeleteBtn) els.dash.confirmDeleteBtn.addEventListener('click', confirmDeleteNote);

  // Exit selection mode when clicking outside note cards on dashboard
  // Exclude the FAB and delete modal so they don't accidentally clear the selection
  els.views.dashboard.addEventListener('click', (e) => {
    if (state.isSelectionMode
      && !e.target.closest('.note-card')
      && !e.target.closest('.global-fab')
      && !e.target.closest('#delete-modal')) {
      exitSelectionMode();
    }
  });
  
  // Canvas Nav
  els.canvas.backBtn.addEventListener('click', async () => {
    els.canvas.backBtn.classList.add('animating');
    
    await new Promise(r => setTimeout(r, 250));

    renderDashboard();
    els.views.dashboard.classList.add('animating-in-top-left');

    await new Promise(r => setTimeout(r, 600));

    els.views.dashboard.classList.remove('animating-in-top-left');
    els.canvas.backBtn.classList.remove('animating');
    switchView('dashboard');
  });
  els.canvas.titleInput.addEventListener('blur', updateNoteTitle);
  els.canvas.prevPageBtn.addEventListener('click', () => switchPage(-1));
  els.canvas.nextPageBtn.addEventListener('click', () => switchPage(1));
  els.canvas.addPageBtn.addEventListener('click', addPage);
  
  // Tools
  els.canvas.toggleToolsBtn.addEventListener('click', toggleToolMenu);
  els.tools.btns.forEach(btn => {
    btn.addEventListener('click', (e) => selectTool(e.currentTarget.dataset.tool));
  });
  els.tools.snapToggle.addEventListener('change', (e) => state.editor.isSnapEnabled = e.target.checked);
  els.tools.strokeWidth.addEventListener('input', (e) => state.editor.strokeWidth = parseInt(e.target.value));
  els.tools.colorPicker.addEventListener('input', (e) => state.editor.color = e.target.value);
  els.tools.strokeStyleBtn.addEventListener('click', () => {
    state.editor.strokeStyle = state.editor.strokeStyle === 'solid' ? 'dashed' : 'solid';
    els.tools.strokeStyleBtn.textContent = state.editor.strokeStyle === 'solid' ? 'Solid' : 'Dashed';
  });

  // Canvas Interactions
  els.canvas.container.addEventListener('pointerdown', handlePointerDown);
  els.canvas.container.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  
  // Mobile Touch specific for zoom/pan
  els.canvas.container.addEventListener('touchstart', handleTouchStart, {passive: false});
  els.canvas.container.addEventListener('touchmove', handleTouchMove, {passive: false});
  els.canvas.container.addEventListener('touchend', handleTouchEnd);
}

// === VIEW LOGIC ===
function switchView(viewName) {
  state.currentView = viewName;
  Object.values(els.views).forEach(v => v.classList.remove('active'));
  els.views[viewName].classList.add('active');
  
  if (viewName === 'dashboard') {
    renderDashboard();
    state.activeNoteId = null;
  } else if (viewName === 'canvas') {
    renderCanvas();
  }
}

// === DASHBOARD LOGIC ===
function renderDashboard() {
  const notesArray = Object.values(state.notes).sort((a, b) => b.lastModified - a.lastModified);
  
  els.dash.mostRecent.innerHTML = '';
  els.dash.notesGrid.innerHTML = '';

  if (notesArray.length === 0) {
    els.dash.mostRecent.innerHTML = '<p>No notes yet. Create one!</p>';
    return;
  }

  // Most Recent
  const recent = notesArray[0];
  
  const infoContainer = document.createElement('div');
  infoContainer.className = 'most-recent-info';
  
  const titleEl = document.createElement('div');
  titleEl.className = 'most-recent-title';
  titleEl.textContent = 'Most Recent';
  
  const dateEl = document.createElement('div');
  dateEl.className = 'most-recent-date';
  const dateObj = new Date(recent.lastModified);
  dateEl.textContent = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  
  infoContainer.appendChild(titleEl);
  infoContainer.appendChild(dateEl);
  
  const recentCard = createNoteCard(recent, true);
  
  els.dash.mostRecent.appendChild(infoContainer);
  els.dash.mostRecent.appendChild(recentCard);

  // Grid — all notes appear here, including the most recent
  notesArray.forEach(note => {
    els.dash.notesGrid.appendChild(createNoteCard(note, false));
  });
}

function createNoteCard(note, isRecent) {
  const card = document.createElement('div');
  card.className = 'note-card elevation-2' + (isRecent ? ' most-recent-card' : '');
  
  if (state.isSelectionMode) {
    if (isRecent) {
      // Most Recent card is not selectable during selection mode
      card.classList.add('selection-disabled');
    } else {
      card.classList.add('wiggling');
      if (state.selectedNotes.has(note.id)) {
        card.classList.add('selected');
      }
    }
  }
  
  const title = document.createElement('div');
  title.className = 'note-title h2';
  title.textContent = note.title || 'Untitled';
  title.addEventListener('click', (e) => {
    if (title.contentEditable === 'true') e.stopPropagation();
  });
  
  const preview = document.createElement('div');
  preview.className = 'note-preview body-text';
  // simple preview based on text objects
  const texts = note.pages[0]?.objects.filter(o => o.type === 'text').map(o => o.content) || [];
  preview.textContent = texts.join(' ') || 'Blank page...';

  card.appendChild(title);
  card.appendChild(preview);
  
  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'card-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'action-btn';
  editBtn.innerHTML = '✏️';
  editBtn.title = 'Edit Title';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.isSelectionMode) {
      toggleNoteSelection(note.id, card);
      return;
    }
    title.contentEditable = 'true';
    title.focus();
    
    // Select all text
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(title);
    selection.removeAllRanges();
    selection.addRange(range);

    const saveTitle = async () => {
      title.contentEditable = 'false';
      note.title = title.textContent.trim();
      await StorageManager.save(state.notes);
      title.removeEventListener('blur', saveTitle);
    };

    title.addEventListener('blur', saveTitle);
    title.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') {
        ke.preventDefault();
        title.blur();
      }
    });
  });
  
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'action-btn';
  deleteBtn.innerHTML = '&#x2715;'; // X symbol
  deleteBtn.title = 'Delete Note';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent opening note
    if (state.isSelectionMode) {
      toggleNoteSelection(note.id, card);
      return;
    }
    openDeleteModal(note);
  });
  
  actionsContainer.appendChild(editBtn);
  actionsContainer.appendChild(deleteBtn);
  card.appendChild(actionsContainer);
  
  let longPressTimeout;
  const startLongPress = (e) => {
    if (!state.isSelectionMode) {
      longPressTimeout = setTimeout(() => {
        enterSelectionMode(note.id);
      }, 1500);
    }
  };
  const cancelLongPress = () => clearTimeout(longPressTimeout);

  card.addEventListener('mousedown', startLongPress);
  card.addEventListener('touchstart', startLongPress, {passive: true});
  card.addEventListener('mouseup', cancelLongPress);
  card.addEventListener('mouseleave', cancelLongPress);
  card.addEventListener('touchend', cancelLongPress);
  card.addEventListener('touchcancel', cancelLongPress);

  card.addEventListener('click', (e) => {
    if (state.isSelectionMode) {
      e.stopPropagation();
      toggleNoteSelection(note.id, card);
    } else {
      openNote(note.id);
    }
  });
  return card;
}

let noteToDeleteId = null;
let isBulkDelete = false;

function enterSelectionMode(firstNoteId) {
  state.isSelectionMode = true;
  state.selectedNotes.clear();
  state.selectedNotes.add(firstNoteId);

  // Darken background
  els.views.dashboard.classList.add('selection-mode');

  // Turn FAB red with minus icon
  els.dash.newNoteBtn.classList.add('delete-mode');
  els.dash.newNoteBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round">
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>`;

  renderDashboard();
}

function exitSelectionMode() {
  state.isSelectionMode = false;
  state.selectedNotes.clear();

  // Restore background
  els.views.dashboard.classList.remove('selection-mode');

  // Restore FAB to plus
  els.dash.newNoteBtn.classList.remove('delete-mode');
  els.dash.newNoteBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>`;

  renderDashboard();
}

function toggleNoteSelection(noteId, card) {
  if (state.selectedNotes.has(noteId)) {
    state.selectedNotes.delete(noteId);
    card.classList.remove('selected');
  } else {
    state.selectedNotes.add(noteId);
    card.classList.add('selected');
  }
}

function openDeleteModal(note) {
  isBulkDelete = false;
  noteToDeleteId = note.id;
  const title = note.title || 'Untitled';
  if (els.dash.deleteModalText) els.dash.deleteModalText.textContent = `Delete "${title}" permanently?`;
  if (els.dash.deleteModal) els.dash.deleteModal.classList.remove('hidden');
}

function openBulkDeleteModal() {
  if (state.selectedNotes.size === 0) return;
  isBulkDelete = true;
  noteToDeleteId = null;
  const count = state.selectedNotes.size;
  const label = count === 1 ? 'Note' : 'Notes';
  if (els.dash.deleteModalText) els.dash.deleteModalText.textContent = `Delete ${count} ${label} permanently?`;
  if (els.dash.deleteModal) els.dash.deleteModal.classList.remove('hidden');
}

function closeDeleteModal() {
  noteToDeleteId = null;
  isBulkDelete = false;
  if (els.dash.deleteModal) els.dash.deleteModal.classList.add('hidden');
}

async function confirmDeleteNote() {
  if (isBulkDelete) {
    // Snapshot IDs before clearing state
    const toDelete = [...state.selectedNotes];
    toDelete.forEach(id => delete state.notes[id]);
    await StorageManager.save(state.notes);
    closeDeleteModal();
    exitSelectionMode();
  } else if (noteToDeleteId && state.notes[noteToDeleteId]) {
    delete state.notes[noteToDeleteId];
    await StorageManager.save(state.notes);
    closeDeleteModal();
    renderDashboard();
  } else {
    closeDeleteModal();
  }
}

// === NOTE LOGIC ===
async function createNewNote() {
  const newNote = {
    id: generateId(),
    title: '',
    lastModified: Date.now(),
    pages: [{ id: generateId(), objects: [] }]
  };
  state.notes[newNote.id] = newNote;
  await StorageManager.save(state.notes);

  // Play elastic animation on FAB
  els.dash.newNoteBtn.classList.add('animating');
  
  await new Promise(r => setTimeout(r, 250));

  // Pre-render canvas
  state.activeNoteId = newNote.id;
  state.editor.currentPageIndex = 0;
  els.canvas.titleInput.value = '';
  renderCanvas();

  // Trigger circular wipe
  els.views.canvas.classList.add('animating-in');

  await new Promise(r => setTimeout(r, 600));

  // Complete transition
  switchView('canvas');
  els.views.canvas.classList.remove('animating-in');
  els.dash.newNoteBtn.classList.remove('animating');
}

function openNote(id) {
  state.activeNoteId = id;
  state.editor.currentPageIndex = 0;
  els.canvas.titleInput.value = state.notes[id].title;
  switchView('canvas');
}

function updateNoteTitle() {
  if (state.activeNoteId) {
    state.notes[state.activeNoteId].title = els.canvas.titleInput.value;
    saveCurrentNote();
  }
}

async function saveCurrentNote() {
  if (state.activeNoteId) {
    state.notes[state.activeNoteId].lastModified = Date.now();
    await StorageManager.save(state.notes);
  }
}

// === PAGE LOGIC ===
function switchPage(dir) {
  const note = state.notes[state.activeNoteId];
  if (!note) return;
  const newIdx = state.editor.currentPageIndex + dir;
  if (newIdx >= 0 && newIdx < note.pages.length) {
    state.editor.currentPageIndex = newIdx;
    renderCanvas();
  }
}

function addPage() {
  const note = state.notes[state.activeNoteId];
  if (!note) return;
  note.pages.push({ id: generateId(), objects: [] });
  state.editor.currentPageIndex = note.pages.length - 1;
  saveCurrentNote();
  renderCanvas();
}

// === CANVAS RENDER ===
function renderCanvas() {
  const note = state.notes[state.activeNoteId];
  if (!note) return;
  
  els.canvas.pageIndicator.textContent = `${state.editor.currentPageIndex + 1} / ${note.pages.length}`;
  els.canvas.container.innerHTML = '';
  
  const page = note.pages[state.editor.currentPageIndex];
  page.objects.forEach(obj => {
    els.canvas.container.appendChild(createDomFromObject(obj));
  });
}

function createDomFromObject(obj) {
  let el;
  if (obj.type === 'text') {
    el = document.createElement('textarea');
    el.className = 'canvas-object canvas-text-input';
    el.value = obj.content;
    el.style.left = obj.x + 'px';
    el.style.top = obj.y + 'px';
    el.style.width = obj.width + 'px';
    el.style.height = obj.height + 'px';
    el.style.color = obj.color;
    
    // Auto-save on blur
    el.addEventListener('blur', () => {
      obj.content = el.value;
      obj.width = el.offsetWidth;
      obj.height = el.offsetHeight;
      saveCurrentNote();
    });
  } else {
    // For shapes, create an SVG wrapper
    el = document.createElement('div');
    el.className = 'canvas-object';
    el.style.left = obj.x + 'px';
    el.style.top = obj.y + 'px';
    el.style.width = obj.width + 'px';
    el.style.height = obj.height + 'px';
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.overflow = 'visible';
    
    const shape = document.createElementNS('http://www.w3.org/2000/svg', obj.type === 'path' ? 'path' : obj.type);
    shape.setAttribute('stroke', obj.color);
    shape.setAttribute('stroke-width', obj.strokeWidth);
    shape.setAttribute('fill', 'transparent');
    if (obj.strokeStyle === 'dashed') shape.setAttribute('stroke-dasharray', '5,5');
    
    if (obj.type === 'rect') {
      shape.setAttribute('width', '100%');
      shape.setAttribute('height', '100%');
    } else if (obj.type === 'circle') {
      shape.setAttribute('cx', obj.width / 2);
      shape.setAttribute('cy', obj.height / 2);
      shape.setAttribute('r', Math.min(obj.width, obj.height) / 2);
    } else if (obj.type === 'line') {
      shape.setAttribute('x1', 0);
      shape.setAttribute('y1', 0);
      shape.setAttribute('x2', obj.width);
      shape.setAttribute('y2', obj.height);
    } else if (obj.type === 'path') {
      shape.setAttribute('d', obj.points);
    }
    
    svg.appendChild(shape);
    el.appendChild(svg);
  }
  
  el.dataset.id = obj.id;
  if (state.editor.selectedObjectId === obj.id) {
    el.classList.add('selected');
    addResizeHandles(el);
  }
  
  return el;
}

function addResizeHandles(el) {
  ['nw', 'ne', 'sw', 'se'].forEach(pos => {
    const handle = document.createElement('div');
    handle.className = `resize-handle ${pos}`;
    el.appendChild(handle);
  });
}

// === TOOL LOGIC ===
function toggleToolMenu() {
  els.tools.menu.classList.toggle('hidden');
  els.tools.properties.classList.toggle('hidden');
  els.canvas.toggleToolsBtn.classList.toggle('active');
}

function selectTool(tool) {
  state.editor.activeTool = tool;
  state.editor.selectedObjectId = null; // deselect on tool change
  els.tools.btns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  renderCanvas(); // re-render to remove selection
}

function snap(val) {
  return state.editor.isSnapEnabled ? Math.round(val / DOT_SPACING) * DOT_SPACING : val;
}

// === DRAWING / INTERACTION LOGIC ===
let currentObj = null;
let currentEl = null;

function getCoords(e) {
  const rect = els.canvas.container.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function handlePointerDown(e) {
  // If clicking on an existing object and using pointer tool
  if (state.editor.activeTool === 'pointer') {
    const targetId = e.target.closest('.canvas-object')?.dataset.id;
    state.editor.selectedObjectId = targetId || null;
    renderCanvas();
    return;
  }

  const coords = getCoords(e);
  let startX = coords.x;
  let startY = coords.y;
  
  if (state.editor.isSnapEnabled && state.editor.activeTool !== 'draw' && state.editor.activeTool !== 'text') {
    startX = snap(startX);
    startY = snap(startY);
  }

  state.editor.isDrawing = true;
  state.editor.startX = startX;
  state.editor.startY = startY;

  const note = state.notes[state.activeNoteId];
  const page = note.pages[state.editor.currentPageIndex];

  if (state.editor.activeTool === 'text') {
    // Spawns text area immediately
    const obj = {
      id: generateId(),
      type: 'text',
      x: snap(startX),
      y: snap(startY),
      width: 100,
      height: 40,
      color: state.editor.color,
      content: ''
    };
    page.objects.push(obj);
    renderCanvas();
    const el = document.querySelector(`[data-id="${obj.id}"]`);
    if (el) el.focus();
    state.editor.isDrawing = false;
    saveCurrentNote();
    return;
  }

  // Init shape
  currentObj = {
    id: generateId(),
    type: state.editor.activeTool,
    x: startX,
    y: startY,
    width: 0,
    height: 0,
    color: state.editor.color,
    strokeWidth: state.editor.strokeWidth,
    strokeStyle: state.editor.strokeStyle,
    points: state.editor.activeTool === 'draw' ? `M ${startX} ${startY}` : ''
  };
  
  page.objects.push(currentObj);
  currentEl = createDomFromObject(currentObj);
  els.canvas.container.appendChild(currentEl);
}

function handlePointerMove(e) {
  if (!state.editor.isDrawing || !currentObj || !currentEl) return;
  e.preventDefault();

  const coords = getCoords(e);
  let currentX = coords.x;
  let currentY = coords.y;

  if (state.editor.activeTool === 'draw') {
    currentObj.points += ` L ${currentX} ${currentY}`;
    // Re-render just this path
    const path = currentEl.querySelector('path');
    if (path) path.setAttribute('d', currentObj.points);
    // update bounding box roughly
    currentObj.width = Math.max(currentObj.width, currentX - currentObj.x);
    currentObj.height = Math.max(currentObj.height, currentY - currentObj.y);
    currentEl.style.width = currentObj.width + 'px';
    currentEl.style.height = currentObj.height + 'px';
    return;
  }

  if (state.editor.isSnapEnabled) {
    currentX = snap(currentX);
    currentY = snap(currentY);
  }

  const width = currentX - state.editor.startX;
  const height = currentY - state.editor.startY;

  currentObj.x = width < 0 ? currentX : state.editor.startX;
  currentObj.y = height < 0 ? currentY : state.editor.startY;
  currentObj.width = Math.abs(width);
  currentObj.height = Math.abs(height);

  currentEl.style.left = currentObj.x + 'px';
  currentEl.style.top = currentObj.y + 'px';
  currentEl.style.width = currentObj.width + 'px';
  currentEl.style.height = currentObj.height + 'px';

  const shape = currentEl.querySelector('svg').firstElementChild;
  if (currentObj.type === 'circle') {
      shape.setAttribute('cx', currentObj.width / 2);
      shape.setAttribute('cy', currentObj.height / 2);
      shape.setAttribute('r', Math.min(currentObj.width, currentObj.height) / 2);
  } else if (currentObj.type === 'line') {
      // Logic for line direction based on drag direction
      if (width < 0 && height < 0) {
        shape.setAttribute('x1', currentObj.width); shape.setAttribute('y1', currentObj.height);
        shape.setAttribute('x2', 0); shape.setAttribute('y2', 0);
      } else if (width < 0) {
        shape.setAttribute('x1', currentObj.width); shape.setAttribute('y1', 0);
        shape.setAttribute('x2', 0); shape.setAttribute('y2', currentObj.height);
      } else if (height < 0) {
        shape.setAttribute('x1', 0); shape.setAttribute('y1', currentObj.height);
        shape.setAttribute('x2', currentObj.width); shape.setAttribute('y2', 0);
      } else {
        shape.setAttribute('x1', 0); shape.setAttribute('y1', 0);
        shape.setAttribute('x2', currentObj.width); shape.setAttribute('y2', currentObj.height);
      }
  }
}

function handlePointerUp(e) {
  if (state.editor.isDrawing) {
    state.editor.isDrawing = false;
    if (currentObj) {
      if (currentObj.width === 0 && currentObj.height === 0 && currentObj.type !== 'text') {
        // Remove empty object
        const note = state.notes[state.activeNoteId];
        const page = note.pages[state.editor.currentPageIndex];
        page.objects.pop();
        if (currentEl && currentEl.parentNode) currentEl.parentNode.removeChild(currentEl);
      } else {
        saveCurrentNote();
      }
    }
    currentObj = null;
    currentEl = null;
    renderCanvas(); // normalize
  }
}

// === MULTI-TOUCH ZOOM/PAN ===
let initialDist = 0;
let initialZoom = 1;

function handleTouchStart(e) {
  if (e.touches.length === 2) {
    e.preventDefault();
    initialDist = Math.hypot(
      e.touches[0].pageX - e.touches[1].pageX,
      e.touches[0].pageY - e.touches[1].pageY
    );
    initialZoom = state.editor.zoom;
    state.editor.isDrawing = false; // cancel drawing on two fingers
  }
}

function handleTouchMove(e) {
  if (e.touches.length === 2) {
    e.preventDefault();
    const currentDist = Math.hypot(
      e.touches[0].pageX - e.touches[1].pageX,
      e.touches[0].pageY - e.touches[1].pageY
    );
    const zoomDelta = currentDist / initialDist;
    state.editor.zoom = Math.max(0.5, Math.min(3, initialZoom * zoomDelta));
    els.canvas.container.style.transform = `scale(${state.editor.zoom})`;
  } else if (e.touches.length === 1 && state.editor.activeTool !== 'pointer' && state.editor.isDrawing) {
    // Only prevent default if drawing to stop scrolling
    e.preventDefault();
  }
}

function handleTouchEnd(e) {
  // handled by pointerup mostly, but reset touch vars if needed
}

// Boot
document.addEventListener('DOMContentLoaded', init);
