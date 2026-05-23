// === CONSTANTS & CONFIG ===
const firebaseConfig = {
  projectId: "dotjot-5d1ea",
  appId: "1:330735426355:web:f35729981c59e1eba27c46",
  storageBucket: "dotjot-5d1ea.firebasestorage.app",
  apiKey: "AIzaSyAHOOrmr1Yn4puMvXPf0rfJElTFxi0nr9w",
  authDomain: "dotjot-5d1ea.firebaseapp.com",
  messagingSenderId: "330735426355"
};

if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
}
const auth = typeof firebase !== 'undefined' ? firebase.auth() : null;
const db = typeof firebase !== 'undefined' ? firebase.firestore() : null;
const googleProvider = typeof firebase !== 'undefined' ? new firebase.auth.GoogleAuthProvider() : null;

const DOT_SPACING   = 20;
const GRID_MARGIN_X = 15;
const GRID_MARGIN_Y = 15;
const PAGE_WIDTH    = 330; // 300px grid span + 30px padding (16 dots wide)
const PAGE_HEIGHT   = 650; // 620px grid span + 30px padding (32 dots tall, 15px even margins)
const PAGE_GAP     = 24;               // gap between pages
const VIEWPORT_PAD = 24;               // side breathing room

// === STATE MANAGEMENT ===
let state = {
  user: null,
  isSyncEnabled: localStorage.getItem('jotdot_sync') === 'true',
  syncUnsubscribe: null,
  currentView: 'dashboard', // 'dashboard' | 'canvas'
  activeNoteId: null,
  notes: {}, // record of Note objects
  isSelectionMode: false,
  selectedNotes: new Set(),
  editor: {
    activeTool: 'default',
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
      let data = null;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(['notes'], (result) => {
          resolve(result.notes || {});
        });
        return;
      } else {
        const raw = localStorage.getItem('jotdot_notes');
        data = raw ? JSON.parse(raw) : {};
        resolve(data);
      }
    });
  },
  async save(notes) {
    // Local Save
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ notes });
    } else {
      localStorage.setItem('jotdot_notes', JSON.stringify(notes));
    }
    
    // Cloud Save (Fire and forget, don't block UI)
    if (state.user && state.isSyncEnabled && db) {
      db.collection('users').doc(state.user.uid).set({ notes })
        .catch(e => console.error("Firebase sync error: ", e));
    }
  }
};

async function setupCloudSync() {
  if (state.syncUnsubscribe) {
    state.syncUnsubscribe();
    state.syncUnsubscribe = null;
  }
  
  if (state.user && state.isSyncEnabled) {
    // 1. Safe Merge: Fetch cloud data first
    try {
      if (!db) return;
      const docRef = db.collection('users').doc(state.user.uid);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        const cloudData = docSnap.data().notes || {};
        // Merge cloud data into local data (cloud data takes precedence on conflict)
        state.notes = { ...state.notes, ...cloudData };
      }
      // Push merged data back to both local and cloud
      await StorageManager.save(state.notes);
      
      // Update UI with merged data
      if (state.currentView === 'dashboard') {
        renderDashboard();
      } else if (state.currentView === 'canvas') {
        if (state.notes[state.activeNoteId]) {
          renderCanvas();
        } else {
          switchView('dashboard');
        }
      }
    } catch (err) {
      console.error("Merge error:", err);
    }

    // 2. Attach Listener
    state.syncUnsubscribe = db.collection('users').doc(state.user.uid).onSnapshot((snapshot) => {
      if (snapshot.exists) {
        const cloudData = snapshot.data().notes;
        if (cloudData) {
          if (JSON.stringify(cloudData) !== JSON.stringify(state.notes)) {
             state.notes = cloudData;
             if (state.currentView === 'dashboard') {
               renderDashboard();
             } else if (state.currentView === 'canvas') {
               if (state.notes[state.activeNoteId]) {
                 renderCanvas();
               } else {
                 switchView('dashboard');
               }
             }
          }
        }
      }
    });
  }
}

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
    zoomResetBtn: document.getElementById('zoom-reset-btn'),
    pageNavigator: document.querySelector('.page-navigator')
  },
  tools: {
    menu: document.getElementById('tool-menu'),
    properties: document.getElementById('properties-toolbar'),
    btns: document.querySelectorAll('.tool-btn')
  },
  settings: {
    btn: document.getElementById('settings-btn'),
    modal: document.getElementById('settings-modal'),
    closeBtn: document.getElementById('close-settings-btn'),
    
    // Auth UI
    authStatus: document.getElementById('auth-status-text'),
    authLoggedOutView: document.getElementById('auth-logged-out-view'),
    authLoggedInView: document.getElementById('auth-logged-in-view'),
    authLogoutBtn: document.getElementById('auth-logout-btn'),
    showLoginBtn: document.getElementById('show-login-btn'),
    showSignupBtn: document.getElementById('show-signup-btn'),
    
    // Login Modal
    loginModal: document.getElementById('login-modal'),
    loginEmail: document.getElementById('login-email'),
    loginPass: document.getElementById('login-password'),
    loginConfirmBtn: document.getElementById('login-confirm-btn'),
    loginCancelBtn: document.getElementById('login-cancel-btn'),
    
    // Signup Modal
    signupModal: document.getElementById('signup-modal'),
    signupEmail: document.getElementById('signup-email'),
    signupPass: document.getElementById('signup-password'),
    signupConfirmBtn: document.getElementById('signup-confirm-btn'),
    signupCancelBtn: document.getElementById('signup-cancel-btn'),
    
    syncToggle: document.getElementById('sync-toggle')
  }
};

// === INIT ===
async function init() {
  state.notes = await StorageManager.load();
  renderDashboard();
  switchView('dashboard');

  setupAuthListeners();
  setupSettingsListeners();
  
  // Dashboard Listeners
  bindEvents();
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
    // Pointer-down-to-toggle banner tab (snappier on mobile)
    bannerTab.addEventListener('pointerdown', (e) => {
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

    // Collapse when interacting outside
    const collapseBanner = (e) => {
      if (!e.target.closest('#note-banner-tab')) {
        bannerTab.classList.remove('expanded');
        disableTitleEditing();
      }
    };
    document.addEventListener('click', collapseBanner);
    document.addEventListener('pointerdown', collapseBanner);
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
    if (btn.id === 'toggle-tools-btn') return; // Skip toggle button, handled by toggleToolMenu
    btn.addEventListener('click', (e) => selectTool(e.currentTarget.dataset.tool));
  });
  
  if (els.tools.drawColorPicker) {
    els.tools.drawColorPicker.addEventListener('input', (e) => state.editor.color = e.target.value);
  }

  const colorPopover = document.getElementById('color-popover');
  const colorGrid = colorPopover?.querySelector('.color-grid');
  const textColorBtn = document.getElementById('text-color-btn');
  const drawColorBtn = document.getElementById('draw-color-btn');
  const colors = [
    '#1A1A1A', '#8C8C8C', '#FFFFFF', '#FF3B30', '#FF9500', 
    '#FFCC00', '#4CD964', '#5AC8FA', '#007AFF', '#5856D6'
  ];

  if (colorGrid) {
    colors.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.backgroundColor = color;
      
      // Prevent focus stealing
      swatch.addEventListener('mousedown', e => e.preventDefault());
      swatch.addEventListener('touchstart', e => e.preventDefault());
      
      swatch.addEventListener('click', () => {
        state.editor.color = color;
        if (textColorBtn) textColorBtn.querySelector('.color-indicator').style.backgroundColor = color;
        if (drawColorBtn) drawColorBtn.querySelector('.color-indicator').style.backgroundColor = color;
        
        if (document.activeElement?.classList.contains('canvas-text-block')) {
          document.execCommand('foreColor', false, color);
          document.activeElement.style.color = color;
        }
        colorPopover.classList.add('hidden');
      });
      colorGrid.appendChild(swatch);
    });
  }

  const toggleColorPopover = () => {
    if (colorPopover) colorPopover.classList.toggle('hidden');
  };

  if (textColorBtn) textColorBtn.addEventListener('click', toggleColorPopover);
  if (drawColorBtn) drawColorBtn.addEventListener('click', toggleColorPopover);

  // Close popover when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (colorPopover && !colorPopover.classList.contains('hidden')) {
      if (!colorPopover.contains(e.target) && !e.target.closest('.color-toggle-btn')) {
        colorPopover.classList.add('hidden');
      }
    }
  });

  document.querySelectorAll('.toolbar-icon-btn').forEach(btn => {
    // Prevent buttons from stealing focus when clicked
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('touchstart', e => e.preventDefault());
    
    btn.addEventListener('click', (e) => {
      const command = btn.dataset.command;
      if (command) document.execCommand(command, false, null);
    });
  });

  const fontSizeBtn = document.getElementById('font-size-btn');
  const alignBtn = document.getElementById('align-btn');
  
  let currentSizeIndex = 1;
  const sizes = [
    { size: '1', label: '0.8rem', name: 'small' },
    { size: '3', label: '1.1rem', name: 'regular' },
    { size: '5', label: '1.5rem', name: 'large' }
  ];

  let currentAlignIndex = 0;
  const alignments = [
    { command: 'justifyLeft', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="15" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>' },
    { command: 'justifyCenter', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="6" y1="12" x2="18" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>' },
    { command: 'justifyRight', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="9" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>' }
  ];

  if (fontSizeBtn) {
    fontSizeBtn.style.fontSize = sizes[currentSizeIndex].label; // Set initial size
    
    fontSizeBtn.addEventListener('click', (e) => {
      currentSizeIndex = (currentSizeIndex + 1) % sizes.length;
      const newSize = sizes[currentSizeIndex];
      fontSizeBtn.style.fontSize = newSize.label;
      document.execCommand('fontSize', false, newSize.size);
    });
  }

  if (alignBtn) {
    alignBtn.addEventListener('click', (e) => {
      currentAlignIndex = (currentAlignIndex + 1) % alignments.length;
      const newAlign = alignments[currentAlignIndex];
      alignBtn.innerHTML = newAlign.icon;
      document.execCommand(newAlign.command, false, null);
    });
  }

  // Update toolbar state when selection changes (e.g. cursor moves into differently styled text)
  document.addEventListener('selectionchange', () => {
    if (document.activeElement?.classList.contains('canvas-text-block')) {
      if (fontSizeBtn) {
        const currentSize = document.queryCommandValue('fontSize');
        if (currentSize) {
          const matchedIndex = sizes.findIndex(s => s.size === currentSize.toString());
          if (matchedIndex !== -1 && matchedIndex !== currentSizeIndex) {
            currentSizeIndex = matchedIndex;
            fontSizeBtn.style.fontSize = sizes[currentSizeIndex].label;
          }
        }
      }
      
      if (alignBtn) {
        const alignState = alignments.findIndex(a => document.queryCommandState(a.command));
        if (alignState !== -1 && alignState !== currentAlignIndex) {
          currentAlignIndex = alignState;
          alignBtn.innerHTML = alignments[currentAlignIndex].icon;
        }
      }
    }
  });

  els.views.canvas.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('canvas-text-block')) {
      els.tools.properties.classList.remove('hidden');
      const drawProps = document.getElementById('prop-layout-draw');
      const textProps = document.getElementById('prop-layout-text');
      if (drawProps) drawProps.classList.add('hidden');
      if (textProps) textProps.classList.remove('hidden');
      if (els.canvas.pageNavigator) els.canvas.pageNavigator.classList.add('editor-tab-visible');
    }
  });

  els.views.canvas.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('canvas-text-block')) {
      // Use setTimeout so if focus moves to formatting buttons, we don't hide
      setTimeout(() => {
        if (state.editor.activeTool === 'default' && document.activeElement?.classList.contains('canvas-text-block') === false) {
          els.tools.properties.classList.add('hidden');
          if (els.canvas.pageNavigator) els.canvas.pageNavigator.classList.remove('editor-tab-visible');
        }
      }, 50);
    }
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
                 e.target.closest('.editor-sidebar-wrapper') || 
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
                 e.target.closest('.editor-sidebar-wrapper') || 
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

    // Single-finger touch is now handled natively (scrolling, text focus, etc.)
    // We only intercept if it's a specific tool drawing.
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

    // Single-finger panning removed in favor of native scrolling
    if (isPanning && activePointers.size === 1) {
      // no-op for now, let native scroll handle it
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

function setActivePage(index, el) {
  state.editor.activePageIndex = index;
  state.editor.activePageEl = el;
  // Visual highlight for the active page if needed
  document.querySelectorAll('.note-page').forEach(p => p.classList.remove('active-page'));
  if (el) el.classList.add('active-page');
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
    if (state.editor.activeTool === 'default') {
      els.views.canvas.classList.add('tool-default');
    } else {
      els.views.canvas.classList.remove('tool-default');
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
  // simple preview based on text objects and unified text layer
  const stripHtml = (html) => {
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html.replace(/<br\s*[\/]?>/gi, ' ').replace(/<div[^>]*>/gi, ' ').replace(/<\/div>/gi, ' ');
    return tmp.textContent || tmp.innerText || '';
  };
  const oldTexts = note.pages[0]?.objects.filter(o => o.type === 'text').map(o => stripHtml(o.content)) || [];
  let previewText = note.pages[0]?.textData ? stripHtml(note.pages[0].textData) : oldTexts.join(' ');
  preview.textContent = previewText.trim() || 'Blank page...';

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
let pageToDeleteIndex = null;
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
  pageToDeleteIndex = null;
  if (els.dash.deleteModal) els.dash.deleteModal.classList.add('hidden');
}

async function confirmDeleteNote() {
  if (pageToDeleteIndex !== null) {
    const note = state.notes[state.activeNoteId];
    if (note && note.pages.length > 1) {
      note.pages.splice(pageToDeleteIndex, 1);
      if (state.editor.activePageIndex >= note.pages.length) {
        state.editor.activePageIndex = Math.max(0, note.pages.length - 1);
      }
      await StorageManager.save(state.notes);
      closeDeleteModal();
      renderCanvas();
      updatePageIndicator();
    } else if (note && note.pages.length === 1) {
      note.pages[0].objects = [];
      await StorageManager.save(state.notes);
      closeDeleteModal();
      renderCanvas();
    }
  } else if (isBulkDelete) {
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
  state.editor.activeTool = 'default';
  if (els.tools.menu) els.tools.menu.classList.add('hidden');
  els.canvas.titleInput.value = '';
  renderCanvas();

  // Trigger circular wipe
  els.views.canvas.classList.add('animating-in');

  await new Promise(r => setTimeout(r, 600));

  // Complete transition
  switchView('canvas');
  els.views.canvas.classList.remove('animating-in');
  els.dash.newNoteBtn.classList.remove('animating');

  // Automatically start editing the title for a new note
  els.canvas.titleInput.removeAttribute('readonly');
  els.canvas.titleInput.classList.add('editing');
  els.canvas.titleInput.focus();
  els.canvas.titleInput.select();
}

function openNote(id) {
  state.activeNoteId = id;
  state.editor.selectedObjectId = null; // start clean with no active selection
  state.editor.currentPageIndex = 0;
  state.editor.zoom = 1.0;
  state.editor.panX = 0;
  state.editor.panY = 0;
  state.editor.activeTool = 'default';
  if (els.tools.menu) els.tools.menu.classList.add('hidden');
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

  // Manage properties toolbar visibility: auto-hide when typing (if activeTool is default)
  if (state.editor.activeTool !== 'default') {
    els.tools.properties.classList.remove('hidden');
    const drawProps = document.getElementById('prop-layout-draw');
    const textProps = document.getElementById('prop-layout-text');
    if (drawProps) drawProps.classList.remove('hidden');
    if (textProps) textProps.classList.add('hidden');
    if (els.canvas.pageNavigator) els.canvas.pageNavigator.classList.add('editor-tab-visible');
  } else {
    // If we are in default mode, keep it hidden UNLESS a text block is actively focused
    if (document.activeElement?.classList.contains('canvas-text-block') === false) {
      els.tools.properties.classList.add('hidden');
      if (els.canvas.pageNavigator) els.canvas.pageNavigator.classList.remove('editor-tab-visible');
    }
  }

  els.canvas.pagesTrack.innerHTML = '';

  note.pages.forEach((page, idx) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'note-page';
    pageEl.dataset.pageIndex = idx;
    page.objects.forEach(obj => pageEl.appendChild(createDomFromObject(obj)));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'page-close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.title = 'Close Page';
    
    // Prevent the canvas pointerdown from firing when interacting with the close button
    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pageToDeleteIndex = idx;
      if (page.objects.length === 0) {
        confirmDeleteNote(); // Delete immediately if empty
      } else {
        const modalText = document.getElementById('delete-modal-text');
        if (modalText) modalText.textContent = 'Delete page?';
        const deleteModal = document.getElementById('delete-modal');
        if (deleteModal) deleteModal.classList.remove('hidden');
      }
    });
    pageEl.appendChild(closeBtn);

    if (state.editor.justAddedPageIndex === idx) {
      pageEl.classList.add('newly-added-page');
      state.editor.justAddedPageIndex = null; // Clear flag
    }

    // Each page handles its own pointerdown so we know which page is being drawn on
    pageEl.addEventListener('pointerdown', (e) => {
      setActivePage(idx, pageEl);
      handlePointerDown(e);
    });

    // Native click listeners removed: tapping is handled directly via handlePointerDown for snappy mobile response

    els.canvas.pagesTrack.appendChild(pageEl);
  });

  // Restore activePageEl reference after DOM rebuild
  const activeEl = els.canvas.pagesTrack.querySelector(
    `.note-page[data-page-index="${state.editor.activePageIndex}"]`
  );
  setActivePage(
    state.editor.activePageIndex,
    activeEl || els.canvas.pagesTrack.querySelector('.note-page')
  );

  updateViewport(false);
}

function createDomFromObject(obj) {
  let el;
  if (obj.type === 'text') {
    el = document.createElement('div');
    el.contentEditable = true;
    el.className = 'canvas-object canvas-text-block';
    el.innerHTML = obj.content || '';
    el.style.left = obj.x + 'px';
    el.style.top = obj.y + 'px';
    // Max width to prevent expanding past the right grid margin (330px total width, 15px right margin = 315px max boundary)
    el.style.maxWidth = (315 - obj.x) + 'px';
    el.style.minWidth = '20px';
    el.style.color = obj.color;
    
    // Auto-save on blur
    el.addEventListener('blur', () => {
      obj.content = el.innerHTML;
      obj.width = el.offsetWidth;
      obj.height = el.offsetHeight;
      
      // If empty, delete it
      if (!el.innerText.trim()) {
        const note = state.notes[state.activeNoteId];
        const page = note.pages[state.editor.activePageIndex];
        page.objects = page.objects.filter(o => o.id !== obj.id);
        renderCanvas();
      }
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
    updateViewport(true);
    // Update activePageEl after transition (DOM already exists)
    const el = els.canvas.pagesTrack.querySelector(`.note-page[data-page-index="${newIdx}"]`);
    setActivePage(newIdx, el || state.editor.activePageEl);
    isPanning = false;
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
  } else {
    selectTool('default');
    state.editor.selectedObjectId = null;
    els.tools.menu.classList.add('hidden');
    renderCanvas();
  }
}

function selectTool(tool) {
  if (state.editor.activeTool === tool) {
    state.editor.activeTool = 'default';
  } else {
    state.editor.activeTool = tool;
  }
  
  els.tools.btns.forEach(b => b.classList.toggle('active', b.dataset.tool === state.editor.activeTool));
  
  if (els.views.canvas) {
    if (state.editor.activeTool === 'default') {
      els.views.canvas.classList.add('tool-default');
    } else {
      els.views.canvas.classList.remove('tool-default');
    }
  }
  
  renderCanvas(); // re-render to update UI
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

  // Calculate panning limits based on actual viewport size and zoom level
  // panX * zoom = layoutW * (zoom - 1) / 2  =>  panX = layoutW * (zoom - 1) / (2 * zoom)
  const layoutW = els.canvas.pagesViewport ? els.canvas.pagesViewport.offsetWidth : PAGE_WIDTH;
  const layoutH = els.canvas.pagesViewport ? els.canvas.pagesViewport.offsetHeight : PAGE_HEIGHT;
  
  const limitX = layoutW * (zoom - 1.0) / (2 * zoom);
  const limitY = layoutH * (zoom - 1.0) / (2 * zoom);

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

function handleCanvasClick(e) {
  // If clicking on a resize handle or an existing object while in default typing mode, let native events handle it
  const isResizeHandle = e.target.classList.contains('resize-handle');
  if (isResizeHandle) return;

  const targetObj = e.target.closest('.canvas-object');
  if (targetObj && state.editor.activeTool === 'default') {
    return;
  }

  const coords = getCoords(e);
  let startX = coords.x;
  let startY = coords.y;

  const note = state.notes[state.activeNoteId];
  const page = note.pages[state.editor.activePageIndex];

  state.editor.selectedObjectId = null;
  
  // Spawn an auto-expanding grid text block where the user clicked!
  const targetLine = Math.floor(Math.max(0, startY - 15) / 20);
  const targetCol = Math.floor(Math.max(0, startX - 15) / 20);
  
  const snapGridX = 15 + targetCol * 20;
  const snapGridY = 15 + targetLine * 20;
  
  const obj = {
    id: generateId(),
    type: 'text',
    x: snapGridX,
    y: snapGridY,
    width: 'auto', // dynamic width
    height: 'auto',
    color: state.editor.color,
    content: ''
  };
  page.objects.push(obj);
  
  // Directly create and append the DOM element without blowing away the canvas
  // This is critical for mobile so the browser doesn't block the virtual keyboard
  const el = createDomFromObject(obj);
  if (state.editor.activePageEl) {
    state.editor.activePageEl.appendChild(el);
  }
  
  // Focus immediately in the same synchronous execution block
  if (el) {
    el.focus();
    // Optionally place caret at the end
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  
  saveCurrentNote();
}

function handlePointerDown(e) {
  // If clicking on an existing object and using pointer tool
  if (state.editor.activeTool === 'pointer') {
    const targetId = e.target.closest('.canvas-object')?.dataset.id;
    state.editor.selectedObjectId = targetId || null;
    renderCanvas();
    return;
  }

  // If in default mode, handle typing instantly on pointerdown to fix mobile tapping
  if (state.editor.activeTool === 'default') {
    handleCanvasClick(e);
    return;
  }

  const coords = getCoords(e);
  let startX = coords.x;
  let startY = coords.y;

  const note = state.notes[state.activeNoteId];
  const page = note.pages[state.editor.activePageIndex];

  if (state.editor.isSnapEnabled && state.editor.activeTool !== 'draw' && state.editor.activeTool !== 'text') {
    startX = snapX(startX);
    startY = snapY(startY);
  }

  state.editor.isDrawing = true;
  state.editor.startX = startX;
  state.editor.startY = startY;

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

// === SETTINGS & AUTH LOGIC ===
function setupSettingsListeners() {
  els.settings.btn.addEventListener('click', () => {
    els.settings.modal.classList.remove('hidden');
  });

  els.settings.closeBtn.addEventListener('click', () => {
    els.settings.modal.classList.add('hidden');
  });

  [els.settings.modal, els.settings.loginModal, els.settings.signupModal].forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });

  els.settings.showLoginBtn.addEventListener('click', () => {
    els.settings.loginModal.classList.remove('hidden');
  });
  els.settings.loginCancelBtn.addEventListener('click', () => {
    els.settings.loginModal.classList.add('hidden');
  });

  els.settings.showSignupBtn.addEventListener('click', () => {
    els.settings.signupModal.classList.remove('hidden');
  });
  els.settings.signupCancelBtn.addEventListener('click', () => {
    els.settings.signupModal.classList.add('hidden');
  });

  els.settings.syncToggle.addEventListener('change', async (e) => {
    state.isSyncEnabled = e.target.checked;
    localStorage.setItem('jotdot_sync', state.isSyncEnabled ? 'true' : 'false');
    
    if (state.isSyncEnabled) {
      await setupCloudSync(); // This will handle merging and saving securely
    } else {
      if (state.syncUnsubscribe) {
        state.syncUnsubscribe();
        state.syncUnsubscribe = null;
      }
    }
  });
}

function setupAuthListeners() {
  if (!auth) return;
  auth.onAuthStateChanged((user) => {
    state.user = user;
    if (user) {
      els.settings.authStatus.value = user.email;
      els.settings.authLoggedOutView.classList.add('hidden');
      els.settings.authLoggedInView.classList.remove('hidden');
      els.settings.syncToggle.disabled = false;
      
      if (state.isSyncEnabled) {
        els.settings.syncToggle.checked = true;
        setupCloudSync();
      }
    } else {
      els.settings.authStatus.value = '';
      els.settings.authLoggedOutView.classList.remove('hidden');
      els.settings.authLoggedInView.classList.add('hidden');
      els.settings.syncToggle.disabled = true;
      els.settings.syncToggle.checked = false;
      
      if (state.syncUnsubscribe) {
        state.syncUnsubscribe();
        state.syncUnsubscribe = null;
      }
    }
  });

  els.settings.loginConfirmBtn.addEventListener('click', async () => {
    const email = els.settings.loginEmail.value;
    const pass = els.settings.loginPass.value;
    if (!email || !pass) return alert("Please enter email and password");
    try {
      await auth.signInWithEmailAndPassword(email, pass);
      els.settings.loginEmail.value = '';
      els.settings.loginPass.value = '';
      els.settings.loginModal.classList.add('hidden');
    } catch (err) {
      alert(err.message);
      console.error("Login Error", err);
    }
  });

  els.settings.signupConfirmBtn.addEventListener('click', async () => {
    const email = els.settings.signupEmail.value;
    const pass = els.settings.signupPass.value;
    if (!email || !pass) return alert("Please enter email and password");
    try {
      await auth.createUserWithEmailAndPassword(email, pass);
      els.settings.signupEmail.value = '';
      els.settings.signupPass.value = '';
      els.settings.signupModal.classList.add('hidden');
    } catch (err) {
      alert(err.message);
      console.error("Signup Error", err);
    }
  });

  els.settings.authLogoutBtn.addEventListener('click', async () => {
    if (state.user) {
      try {
        await auth.signOut();
      } catch (err) {
        console.error("Logout Error", err);
      }
    }
  });
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
