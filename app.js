// === CONSTANTS & CONFIG ===
const DOT_SPACING   = 20;
const GRID_MARGIN_X = 15;
const GRID_MARGIN_Y = 15;
const PAGE_WIDTH    = 330; // 300px grid span + 30px padding (16 dots wide)
const PAGE_HEIGHT   = 650; // 620px grid span + 30px padding (32 dots tall, 15px even margins)
const PAGE_GAP     = 24;               // gap between pages
const VIEWPORT_PAD = 24;               // side breathing room

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
    fitScale: 1.0,
    panX: 0,
    panY: 0,
    currentPageIndex: 0,  // leftmost visible page index
    activePageIndex: 0,   // page currently being drawn on
    activePageEl: null,   // DOM element of the active page
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
    pagesViewport: document.getElementById('pages-viewport'),
    pagesTrack: document.getElementById('pages-track'),
    prevPageBtn: document.getElementById('prev-page-btn'),
    nextPageBtn: document.getElementById('next-page-btn'),
    pageIndicator: document.getElementById('page-indicator'),
    addPageBtn: document.getElementById('add-page-btn'),
    toggleToolsBtn: document.getElementById('toggle-tools-btn'),
    zoomInBtn: document.getElementById('zoom-in-btn'),
    zoomOutBtn: document.getElementById('zoom-out-btn'),
    zoomResetBtn: document.getElementById('zoom-reset-btn')
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
  els.canvas.backBtn.addEventListener('click', async (e) => {
    if (document.activeElement === els.canvas.titleInput) {
      els.canvas.titleInput.blur();
    }

    els.canvas.backBtn.classList.add('animating');
    
    await new Promise(r => setTimeout(r, 250));

    renderDashboard();
    els.views.dashboard.classList.add('animating-in-top-left');

    await new Promise(r => setTimeout(r, 600));

    els.views.dashboard.classList.remove('animating-in-top-left');
    els.canvas.backBtn.classList.remove('animating');
    switchView('dashboard');
  });
  // Banner Tab Title Editing & Mobile Expand
  const bannerTab = document.getElementById('note-banner-tab');
  
  function enableTitleEditing() {
    els.canvas.titleInput.removeAttribute('readonly');
    els.canvas.titleInput.classList.add('editing');
    els.canvas.titleInput.focus();
    els.canvas.titleInput.select();
  }

  function disableTitleEditing() {
    els.canvas.titleInput.setAttribute('readonly', 'true');
    els.canvas.titleInput.classList.remove('editing');
  }

  if (bannerTab) {
    // Click-to-toggle banner tab
    bannerTab.addEventListener('click', (e) => {
      // If clicking the back button or inside an active edit, don't toggle
      if (e.target.closest('#back-to-dashboard-btn') || els.canvas.titleInput.classList.contains('editing')) {
        return;
      }
      
      if (bannerTab.classList.contains('expanded')) {
        // Toggle collapse if clicking the ribbon itself
        if (e.target.closest('#banner-ribbon')) {
          bannerTab.classList.remove('expanded');
          disableTitleEditing();
        }
      } else {
        bannerTab.classList.add('expanded');
      }
      e.stopPropagation();
    });

    // Collapse when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#note-banner-tab')) {
        bannerTab.classList.remove('expanded');
        disableTitleEditing();
      }
    });
  }

  // Double click on title input to edit
  els.canvas.titleInput.addEventListener('dblclick', (e) => {
    enableTitleEditing();
    e.stopPropagation();
  });

  // Double tap on mobile to edit
  let lastTitleTap = 0;
  els.canvas.titleInput.addEventListener('touchend', (e) => {
    // If not expanded, let the tap expand the banner tab first
    if (bannerTab && !bannerTab.classList.contains('expanded')) {
      return;
    }
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTitleTap;
    if (tapLength < 300 && tapLength > 0) {
      enableTitleEditing();
      e.preventDefault();
    }
    lastTitleTap = currentTime;
  });

  // Finish editing on Enter
  els.canvas.titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.canvas.titleInput.blur();
    }
  });

  // Restore readonly and save title on blur
  els.canvas.titleInput.addEventListener('blur', () => {
    disableTitleEditing();
    updateNoteTitle();
  });
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

  // Canvas Interactions — pointerdown is bound per-page in renderCanvas()
  // pointermove & pointerup stay on window so dragging outside a page still works
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);

  // Touch events for drawing (bound to pages-track for delegation)
  els.canvas.pagesTrack.addEventListener('touchstart', handleTouchStart, { passive: false });
  els.canvas.pagesTrack.addEventListener('touchmove', handleTouchMove, { passive: false });
  els.canvas.pagesTrack.addEventListener('touchend', handleTouchEnd);

  // Recompute visible page count when window resizes
  window.addEventListener('resize', handleResize);

  // Zoom Controls Event Listeners
  if (els.canvas.zoomInBtn) {
    els.canvas.zoomInBtn.addEventListener('click', () => {
      state.editor.zoom = Math.min(2.0, (state.editor.zoom || 1.0) + 0.25);
      applyZoomAndPan();
    });
  }
  if (els.canvas.zoomOutBtn) {
    els.canvas.zoomOutBtn.addEventListener('click', () => {
      state.editor.zoom = Math.max(1.0, (state.editor.zoom || 1.0) - 0.25);
      applyZoomAndPan();
    });
  }
  if (els.canvas.zoomResetBtn) {
    els.canvas.zoomResetBtn.addEventListener('click', () => {
      state.editor.zoom = 1.0;
      state.editor.panX = 0;
      state.editor.panY = 0;
      applyZoomAndPan();
    });
  }

  // Desktop Trackpad Gestures & Mouse Wheels (Pinch-to-zoom + Canvas Scrolling)
  els.views.canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault(); // Stop native browser scaling!
      
      const zoomSpeed = 0.01;
      const zoomDelta = -e.deltaY * zoomSpeed;
      const currentZoom = state.editor.zoom || 1.0;
      // Enforce zoom bounds: [1.0, 2.0]
      state.editor.zoom = Math.max(1.0, Math.min(2.0, currentZoom + zoomDelta));
      applyZoomAndPan();
    } else {
      e.preventDefault(); // Prevent default browser viewport scrolling
      
      const zoom = state.editor.zoom || 1.0;
      // Subtract scroll values to translate 1:1 on-screen motion
      state.editor.panX = (state.editor.panX || 0) - e.deltaX / zoom;
      state.editor.panY = (state.editor.panY || 0) - e.deltaY / zoom;
      applyZoomAndPan();
    }
  }, { passive: false });

  // Prevent browser native scroll/zoom gestures inside the canvas view
  window.addEventListener('touchstart', (e) => {
    if (state.currentView !== 'canvas') return;
    
    // Always prevent multi-touch (2+ fingers) to ensure pinch-to-zoom is purely ours
    if (e.touches.length > 1) {
      e.preventDefault();
      return;
    }

    // For single-touch, block native scroll/zoom only if we are interacting with the canvas drawing area itself
    const onUI = e.target.closest('.page-navigator') || 
                 e.target.closest('.back-btn') || 
                 e.target.closest('.tool-menu') || 
                 e.target.closest('.fab-cluster') || 
                 e.target.closest('.properties-toolbar');
    
    if (!onUI) {
      e.preventDefault();
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (state.currentView !== 'canvas') return;

    if (e.touches.length > 1) {
      e.preventDefault();
      return;
    }

    const onUI = e.target.closest('.page-navigator') || 
                 e.target.closest('.back-btn') || 
                 e.target.closest('.tool-menu') || 
                 e.target.closest('.fab-cluster') || 
                 e.target.closest('.properties-toolbar');
    
    if (!onUI) {
      e.preventDefault();
    }
  }, { passive: false });

  // Unified Direct Multi-Touch Gestures (Direct screen single-finger panning and two-finger pinch zooming)
  const activePointers = new Map(); // pointerId -> { clientX, clientY }
  let startPinchDist = 0;
  let startPinchZoom = 1.0;
  let isPanning = false;
  let startPanClientX = 0;
  let startPanClientY = 0;
  let startPanX = 0;
  let startPanY = 0;

  window.addEventListener('pointerdown', (e) => {
    if (state.currentView !== 'canvas') return;
    // Only handle touch/pen gestures, or primary mouse click (button === 0)
    if (e.button !== 0 && e.pointerType !== 'touch') return;

    // Track active pointer contacts
    activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Multi-finger pinch-to-zoom setup
    if (activePointers.size === 2) {
      isPanning = false; // Cancel single-finger panning
      state.editor.isDrawing = false; // Cancel any active drawing strokes

      const pointers = Array.from(activePointers.values());
      startPinchDist = Math.hypot(
        pointers[0].clientX - pointers[1].clientX,
        pointers[0].clientY - pointers[1].clientY
      );
      startPinchZoom = state.editor.zoom || 1.0;
      return;
    }

    // Single-finger touch panning (Mobile)
    if (e.pointerType === 'touch' && activePointers.size === 1) {
      const isToolPointer = state.editor.activeTool === 'pointer';
      const onObject = e.target.closest('.canvas-object');
      const onResizeHandle = e.target.closest('.resize-handle');
      const onUI = e.target.closest('.page-navigator') || 
                   e.target.closest('.back-btn') || 
                   e.target.closest('.tool-menu') || 
                   e.target.closest('.fab-cluster') || 
                   e.target.closest('.properties-toolbar');

      if (onUI) return;

      // Only pan if we are using the pointer tool, and not dragging shapes or resize handles
      if (isToolPointer && !onObject && !onResizeHandle) {
        isPanning = true;
        startPanClientX = e.clientX;
        startPanClientY = e.clientY;
        startPanX = state.editor.panX || 0;
        startPanY = state.editor.panY || 0;
        
        // Prevent default browser touch operations (like scrolling / swipe navigation)
        e.preventDefault();
      }
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;

    // Update tracked pointer coordinates
    activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Multi-finger pinch-to-zoom execution
    if (activePointers.size === 2 && startPinchDist > 0) {
      const pointers = Array.from(activePointers.values());
      const currentDist = Math.hypot(
        pointers[0].clientX - pointers[1].clientX,
        pointers[0].clientY - pointers[1].clientY
      );
      const ratio = currentDist / startPinchDist;
      
      // Enforce zoom bounds: [1.0, 2.0]
      state.editor.zoom = Math.max(1.0, Math.min(2.0, startPinchZoom * ratio));
      applyZoomAndPan();
      return;
    }

    // Single-finger touch panning execution
    if (isPanning && activePointers.size === 1) {
      const dx = e.clientX - startPanClientX;
      const dy = e.clientY - startPanClientY;
      const zoom = state.editor.zoom || 1.0;
      
      state.editor.panX = startPanX + dx / zoom;
      state.editor.panY = startPanY + dy / zoom;
      applyZoomAndPan();
    }
  });

  const cleanPointer = (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      startPinchDist = 0;
    }
    if (isPanning && activePointers.size === 0) {
      isPanning = false;
    }
  };

  window.addEventListener('pointerup', cleanPointer);
  window.addEventListener('pointercancel', cleanPointer);
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
    if (state.editor.activeTool === 'pointer') {
      els.views.canvas.classList.add('tool-pointer');
    } else {
      els.views.canvas.classList.remove('tool-pointer');
    }
    const bannerTab = document.getElementById('note-banner-tab');
    if (bannerTab) {
      bannerTab.classList.remove('expanded');
    }
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

  if (!isRecent) {
    const dateEl = document.createElement('div');
    dateEl.className = 'note-edited-date';
    const dateObj = new Date(note.lastModified);
    dateEl.textContent = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    card.appendChild(dateEl);
  }

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
  state.editor.zoom = 1.0;
  state.editor.panX = 0;
  state.editor.panY = 0;
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
  state.editor.selectedObjectId = null; // start clean with no active selection
  state.editor.currentPageIndex = 0;
  state.editor.zoom = 1.0;
  state.editor.panX = 0;
  state.editor.panY = 0;
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

// === PAGE HELPERS ===

// How many pages fit side-by-side given the current window width and dynamic page scale.
function computeVisibleCount() {
  const fitScale = state.editor.fitScale || 1.0;
  const scaledWidth = PAGE_WIDTH * fitScale;
  const scaledGap = PAGE_GAP * fitScale;
  return Math.max(1, Math.floor((window.innerWidth - 2 * VIEWPORT_PAD + scaledGap) / (scaledWidth + scaledGap)));
}

// Set viewport dimensions + track offset. Pass animate=true for the slide transition.
function updateViewport(animate) {
  const note = state.notes[state.activeNoteId];
  if (!note) return;

  // Dynamically calculate page height fit scale leaving exactly 10px vertical margin at the top and bottom
  const canvasHeight = els.views.canvas.clientHeight || window.innerHeight;
  const fitScale = Math.min(2.0, (canvasHeight - 20) / PAGE_HEIGHT);
  state.editor.fitScale = fitScale;

  const maxCanFit = computeVisibleCount();
  // Cap the visible count by actual page count to center less pages
  const vc = Math.min(note.pages.length, maxCanFit);
  const vpW = vc * PAGE_WIDTH + (vc - 1) * PAGE_GAP;

  // Set physically scaled dimensions of the pages viewport so browser layout & flex-centering matches correctly
  els.canvas.pagesViewport.style.width  = (vpW * fitScale) + 'px';
  els.canvas.pagesViewport.style.height = (PAGE_HEIGHT * fitScale) + 'px';

  // Clamp leftmost index so we never show empty space past the last page
  const maxIdx = Math.max(0, note.pages.length - maxCanFit);
  if (state.editor.currentPageIndex > maxIdx) state.editor.currentPageIndex = maxIdx;

  const offset = state.editor.currentPageIndex * (PAGE_WIDTH + PAGE_GAP);
  els.canvas.pagesTrack.style.transition = animate
    ? 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)'
    : 'none';
  els.canvas.pagesTrack.style.transformOrigin = '0 0';
  els.canvas.pagesTrack.style.transform = `scale(${fitScale}) translateX(-${offset}px)`;

  // Indicator: show rightmost visible page / total
  const rightmost = Math.min(state.editor.currentPageIndex + maxCanFit, note.pages.length);
  els.canvas.pageIndicator.textContent = `${rightmost} / ${note.pages.length}`;
  applyZoomAndPan();
}

function handleResize() {
  if (state.currentView === 'canvas') updateViewport(false);
}

// === CANVAS RENDER ===
// Rebuilds all .note-page elements in the track from scratch.
function renderCanvas() {
  const note = state.notes[state.activeNoteId];
  if (!note) return;

  // Manage properties toolbar visibility strictly driven by active selection
  if (state.editor.selectedObjectId) {
    els.tools.properties.classList.remove('hidden');
  } else {
    els.tools.properties.classList.add('hidden');
  }

  els.canvas.pagesTrack.innerHTML = '';

  note.pages.forEach((page, idx) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'note-page';
    pageEl.dataset.pageIndex = idx;

    page.objects.forEach(obj => pageEl.appendChild(createDomFromObject(obj)));

    if (state.editor.justAddedPageIndex === idx) {
      pageEl.classList.add('newly-added-page');
      state.editor.justAddedPageIndex = null; // Clear flag
    }

    // Each page handles its own pointerdown so we know which page is being drawn on
    pageEl.addEventListener('pointerdown', (e) => {
      state.editor.activePageIndex = idx;
      state.editor.activePageEl    = pageEl;
      handlePointerDown(e);
    });

    els.canvas.pagesTrack.appendChild(pageEl);
  });

  // Restore activePageEl reference after DOM rebuild
  const activeEl = els.canvas.pagesTrack.querySelector(
    `.note-page[data-page-index="${state.editor.activePageIndex}"]`
  );
  state.editor.activePageEl = activeEl ||
    els.canvas.pagesTrack.querySelector('.note-page');

  updateViewport(false);
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

// === PAGE LOGIC ===
function switchPage(dir) {
  const note = state.notes[state.activeNoteId];
  if (!note) return;
  const vc = computeVisibleCount();
  const maxIdx = Math.max(0, note.pages.length - vc);
  const newIdx = Math.max(0, Math.min(maxIdx, state.editor.currentPageIndex + dir));
  if (newIdx !== state.editor.currentPageIndex) {
    state.editor.currentPageIndex = newIdx;
    state.editor.activePageIndex  = newIdx;
    updateViewport(true);
    // Update activePageEl after transition (DOM already exists)
    const el = els.canvas.pagesTrack.querySelector(
      `.note-page[data-page-index="${newIdx}"]`
    );
    state.editor.activePageEl = el || state.editor.activePageEl;
  }
}

function addPage() {
  const note = state.notes[state.activeNoteId];
  if (!note) return;
  note.pages.push({ id: generateId(), objects: [] });
  const newIdx = note.pages.length - 1;
  state.editor.justAddedPageIndex = newIdx; // Set animation flag

  const vc = computeVisibleCount();
  // Show the new page: scroll so it is the rightmost visible page
  state.editor.currentPageIndex = Math.max(0, newIdx - vc + 1);
  state.editor.activePageIndex  = newIdx;
  saveCurrentNote();
  renderCanvas();
  
  // Force horizontal slide transition to animate
  setTimeout(() => {
    updateViewport(true);
  }, 0);
}

// === TOOL LOGIC ===
function toggleToolMenu() {
  const isHidden = els.tools.menu.classList.contains('hidden');
  if (isHidden) {
    els.tools.menu.classList.remove('hidden');
    selectTool('draw');
  } else {
    els.tools.menu.classList.add('hidden');
    selectTool('draw');
  }
}

function selectTool(tool) {
  state.editor.activeTool = tool;
  state.editor.selectedObjectId = null; // deselect on tool change
  els.tools.btns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  
  if (els.views.canvas) {
    if (tool === 'pointer') {
      els.views.canvas.classList.add('tool-pointer');
    } else {
      els.views.canvas.classList.remove('tool-pointer');
    }
  }
  
  renderCanvas(); // re-render to remove selection
}

function snapX(val) {
  if (!state.editor.isSnapEnabled) return val;
  const snapped = GRID_MARGIN_X + Math.round((val - GRID_MARGIN_X) / DOT_SPACING) * DOT_SPACING;
  return Math.max(GRID_MARGIN_X, Math.min(PAGE_WIDTH - GRID_MARGIN_X, snapped));
}

function snapY(val) {
  if (!state.editor.isSnapEnabled) return val;
  const snapped = GRID_MARGIN_Y + Math.round((val - GRID_MARGIN_Y) / DOT_SPACING) * DOT_SPACING;
  return Math.max(GRID_MARGIN_Y, Math.min(PAGE_HEIGHT - GRID_MARGIN_Y, snapped));
}

function applyZoomAndPan() {
  let zoom = state.editor.zoom || 1.0;
  // Enforce zoom bounds: [1.0, 2.0]
  zoom = Math.max(1.0, Math.min(2.0, zoom));
  state.editor.zoom = zoom;

  // Calculate panning limits based on zoom level: (zoom - 1.0) * dimension / 2
  const limitX = PAGE_WIDTH * (zoom - 1.0) / 2;
  const limitY = PAGE_HEIGHT * (zoom - 1.0) / 2;

  let panX = state.editor.panX || 0;
  let panY = state.editor.panY || 0;

  // Clamp panning values
  panX = Math.max(-limitX, Math.min(limitX, panX));
  panY = Math.max(-limitY, Math.min(limitY, panY));

  state.editor.panX = panX;
  state.editor.panY = panY;

  if (els.canvas.pagesViewport) {
    els.canvas.pagesViewport.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`;
    // Force reset native browser auto-scroll offsets to prevent dynamic shifting
    els.canvas.pagesViewport.scrollTop = 0;
    els.canvas.pagesViewport.scrollLeft = 0;
  }
  
  if (els.views.canvas) {
    els.views.canvas.scrollTop = 0;
    els.views.canvas.scrollLeft = 0;
  }
  
  if (els.canvas.zoomResetBtn) {
    els.canvas.zoomResetBtn.textContent = Math.round(zoom * 100) + '%';
  }
}

// === DRAWING / INTERACTION LOGIC ===
let currentObj = null;
let currentEl = null;

function getCoords(e) {
  const pageEl = state.editor.activePageEl;
  if (!pageEl) return { x: 0, y: 0 };
  const rect = pageEl.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  
  // Normalize coordinates back to original unscaled page space (330x650) using combined scale factor
  const fitScale = state.editor.fitScale || 1.0;
  const zoom = state.editor.zoom || 1.0;
  const totalScale = fitScale * zoom;
  
  return { 
    x: (clientX - rect.left) / totalScale, 
    y: (clientY - rect.top) / totalScale 
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
    startX = snapX(startX);
    startY = snapY(startY);
  }

  state.editor.isDrawing = true;
  state.editor.startX = startX;
  state.editor.startY = startY;

  const note = state.notes[state.activeNoteId];
  const page = note.pages[state.editor.activePageIndex];

  if (state.editor.activeTool === 'text') {
    // Spawns text area immediately
    const obj = {
      id: generateId(),
      type: 'text',
      x: snapX(startX),
      y: snapY(startY),
      width: 100,
      height: 40,
      color: state.editor.color,
      content: ''
    };
    page.objects.push(obj);
    renderCanvas();
    const el = state.editor.activePageEl?.querySelector(`[data-id="${obj.id}"]`);
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
  // Append to the active page element, not the global container
  if (state.editor.activePageEl) state.editor.activePageEl.appendChild(currentEl);
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
    currentX = snapX(currentX);
    currentY = snapY(currentY);
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
        const page = note.pages[state.editor.activePageIndex];
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

// === MULTI-TOUCH ===
// Pinch-to-zoom is removed in the fixed-page layout.
// These stubs remain so old bindings don't throw.
function handleTouchStart(e) {
  if (e.touches.length === 2) {
    state.editor.isDrawing = false; // cancel drawing on two fingers
  }
}

function handleTouchMove(e) {
  if (e.touches.length === 1 && state.editor.isDrawing) {
    e.preventDefault();
  }
}

function handleTouchEnd(e) {
  // handled by pointerup
}

// Boot
document.addEventListener('DOMContentLoaded', init);
