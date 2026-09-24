/**
 * Affinity Mapping Studio — NBL 425/625
 * Methods in Human Neuroimaging
 *
 * Privacy Invariant:
 * Strictly client-side only. Zero network requests, zero CDNs, zero telemetry.
 * Safe for student FERPA data and unfiled patent concepts.
 */

(function () {
  'use strict';

  // -------------------------------------------------------------
  // Default Demo Dataset (Synthetic & Unattributed Ideas)
  // -------------------------------------------------------------
  const DEMO_DATASET = {
    id: "demo-neuroimaging-patents",
    title: "Quiz 7: What would you invent? (Demo Data)",
    prompt: "An idea related to neuroimaging you could patent",
    withheld: 1,
    withheldNote: "1 demo idea held back pending IP review.",
    cards: [
      {
        id: 1,
        section: "425",
        text: "Ultra-low-field portable head MRI scanner mounted on an athletic transport cart for on-field acute concussion triage in youth sports."
      },
      {
        id: 2,
        section: "425",
        text: "Active optical-feedforward acoustic noise cancelling headphones integrated directly into high-density RF head receive coils."
      },
      {
        id: 3,
        section: "625",
        text: "Real-time diffusion tractography guidance pipeline for stereotactic robotic transcranial magnetic stimulation (TMS) coil positioning."
      },
      {
        id: 4,
        section: "425",
        text: "Zero-TE synthetic CT reconstruction neural network yielding bulk bone density maps for MR-only PET attenuation correction."
      },
      {
        id: 5,
        section: "625",
        text: "Wireless dual-wavelength wearable fNIRS headband monitoring bilateral prefrontal oxygenation fatigue indices during complex neurosurgery."
      },
      {
        id: 6,
        section: "425",
        text: "Fiber-optic MR-compatible haptic joystick and sensorized glove enabling sensorimotor closed-loop feedback paradigms at 7 Tesla."
      },
      {
        id: 7,
        section: "625",
        text: "Physics-informed self-supervised deep learning model performing prospective motion unwarping during pediatric structural MRI."
      },
      {
        id: 8,
        section: "425",
        text: "Spherical annular transducer array for MR-guided focused ultrasound (MRgFUS) with embedded hydrophone cavitation feedback."
      },
      {
        id: 9,
        section: "625",
        text: "Deep learning automated population arterial input function (AIF) estimator for pharmacokinetic deconvolution in DSC-MRI."
      }
    ]
  };

  // -------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------
  let currentDataset = null;
  let clusters = []; // Array of { id: string, name: string, cardIds: number[] }
  let trayCardIds = []; // Array of number (card IDs)
  let selectedCardId = null;

  // Timer State
  let timerDuration = 15 * 60; // default 15 minutes in seconds
  let timerRemaining = timerDuration;
  let timerRunning = false;
  let timerInterval = null;

  // DOM Elements
  const datasetTitleEl = document.getElementById('datasetTitle');
  const datasetPromptEl = document.getElementById('datasetPrompt');
  const withheldInfoEl = document.getElementById('withheldInfo');
  const demoBadgeEl = document.getElementById('demoBadge');
  const datasetIdBadgeEl = document.getElementById('datasetIdBadge');
  const trayCountBadgeEl = document.getElementById('trayCountBadge');
  const trayCardsEl = document.getElementById('trayCards');
  const clustersContainerEl = document.getElementById('clustersContainer');
  const totalClustersBadgeEl = document.getElementById('totalClustersBadge');
  const selectionBannerEl = document.getElementById('selectionBanner');
  const selectionTextEl = document.getElementById('selectionText');
  const sectionLegendEl = document.getElementById('sectionLegend');
  const legendBadgesEl = document.getElementById('legendBadges');
  const toggleSectionColorsEl = document.getElementById('toggleSectionColors');
  const toggleBigTextEl = document.getElementById('toggleBigText');
  const printCardsAreaEl = document.getElementById('printCardsArea');

  // Timer Elements
  const timerWidgetEl = document.getElementById('timerWidget');
  const timerDisplayEl = document.getElementById('timerDisplay');
  const btnTimerToggleEl = document.getElementById('btnTimerToggle');
  const btnTimerResetEl = document.getElementById('btnTimerReset');
  const btnTimerEditEl = document.getElementById('btnTimerEdit');
  const timerDialogEl = document.getElementById('timerDialog');
  const timerMinutesInputEl = document.getElementById('timerMinutesInput');

  // Dialogs
  const pasteDialogEl = document.getElementById('pasteDialog');
  const pasteTextareaEl = document.getElementById('pasteTextarea');
  const pasteErrorEl = document.getElementById('pasteError');
  const shareDialogEl = document.getElementById('shareDialog');
  const shareUrlInputEl = document.getElementById('shareUrlInput');
  const shareCopyFeedbackEl = document.getElementById('shareCopyFeedback');
  const summaryDialogEl = document.getElementById('summaryDialog');
  const summaryPreEl = document.getElementById('summaryPre');
  const summaryCopyFeedbackEl = document.getElementById('summaryCopyFeedback');
  const stateDialogEl = document.getElementById('stateDialog');
  const stateErrorEl = document.getElementById('stateError');
  const stateSuccessEl = document.getElementById('stateSuccess');
  const importStateTextareaEl = document.getElementById('importStateTextarea');
  const confirmResetDialogEl = document.getElementById('confirmResetDialog');
  const helpDialogEl = document.getElementById('helpDialog');
  const fileInputEl = document.getElementById('fileInput');
  const stateFileInputEl = document.getElementById('stateFileInput');

  // -------------------------------------------------------------
  // Data Validation & Sanitization
  // -------------------------------------------------------------
  function validateDataset(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Dataset must be a valid JSON object.');
    }
    if (!Array.isArray(data.cards) || data.cards.length === 0) {
      throw new Error('Dataset must contain a non-empty "cards" array.');
    }

    // Validate cards
    const seenIds = new Set();
    const sanitizedCards = [];
    data.cards.forEach((card, index) => {
      if (!card || typeof card !== 'object') {
        throw new Error(`Card at index ${index} is not an object.`);
      }
      if (card.id === undefined || card.id === null) {
        throw new Error(`Card at index ${index} is missing an "id".`);
      }
      if (seenIds.has(card.id)) {
        throw new Error(`Duplicate card id detected: ${card.id}.`);
      }
      seenIds.add(card.id);
      if (typeof card.text !== 'string' || card.text.trim() === '') {
        throw new Error(`Card ${card.id} is missing "text".`);
      }
      sanitizedCards.push({
        id: card.id,
        section: card.section ? String(card.section).trim() : undefined,
        text: String(card.text).trim()
      });
    });

    // Validate themes (optional)
    let sanitizedThemes = [];
    if (Array.isArray(data.themes)) {
      sanitizedThemes = data.themes.map((theme, i) => {
        if (!theme || typeof theme !== 'object') {
          throw new Error(`Theme at index ${i} is not an object.`);
        }
        return {
          name: theme.name ? String(theme.name).trim() : `Theme ${i + 1}`,
          cards: Array.isArray(theme.cards) ? theme.cards.map(Number) : [],
          note: theme.note ? String(theme.note).trim() : undefined
        };
      });
    }

    return {
      id: data.id ? String(data.id).trim() : 'custom-dataset-' + Date.now(),
      title: data.title ? String(data.title).trim() : 'Class Ideas Affinity Map',
      prompt: data.prompt ? String(data.prompt).trim() : '',
      withheld: typeof data.withheld === 'number' ? data.withheld : undefined,
      withheldNote: data.withheldNote ? String(data.withheldNote).trim() : undefined,
      cards: sanitizedCards,
      themes: sanitizedThemes
    };
  }

  // -------------------------------------------------------------
  // Storage & State Persistence
  // -------------------------------------------------------------
  function getStorageKey(datasetId) {
    return 'affinity_board_' + datasetId;
  }

  function saveBoardState() {
    if (!currentDataset || !currentDataset.id) return;
    try {
      const state = {
        datasetId: currentDataset.id,
        clusters: clusters.map(c => ({ id: c.id, name: c.name, cardIds: c.cardIds })),
        trayCardIds: trayCardIds,
        updatedAt: Date.now()
      };
      localStorage.setItem(getStorageKey(currentDataset.id), JSON.stringify(state));
    } catch (e) {
      console.warn('localStorage save failed:', e);
    }
  }

  function loadBoardState(dataset) {
    let savedState = null;
    try {
      const raw = localStorage.getItem(getStorageKey(dataset.id));
      if (raw) savedState = JSON.parse(raw);
    } catch (e) {
      console.warn('localStorage read failed:', e);
    }

    const allCardIds = new Set(dataset.cards.map(c => c.id));

    if (savedState && Array.isArray(savedState.clusters) && Array.isArray(savedState.trayCardIds)) {
      // Reconcile saved state with dataset cards
      const assignedCardIds = new Set();
      clusters = savedState.clusters.map((c, i) => {
        const validIds = (c.cardIds || []).filter(id => allCardIds.has(id) && !assignedCardIds.has(id));
        validIds.forEach(id => assignedCardIds.add(id));
        return {
          id: c.id || 'c_' + (i + 1) + '_' + Date.now(),
          name: c.name || `Cluster ${i + 1}`,
          cardIds: validIds
        };
      });

      // Filter tray
      trayCardIds = savedState.trayCardIds.filter(id => allCardIds.has(id) && !assignedCardIds.has(id));
      trayCardIds.forEach(id => assignedCardIds.add(id));

      // Any card in dataset not yet assigned goes to tray
      dataset.cards.forEach(card => {
        if (!assignedCardIds.has(card.id)) {
          trayCardIds.push(card.id);
        }
      });
    } else {
      // Default clean layout: 3 empty starting clusters, all cards in tray
      clusters = [
        { id: 'c_1_' + Date.now(), name: 'Cluster 1', cardIds: [] },
        { id: 'c_2_' + Date.now(), name: 'Cluster 2', cardIds: [] },
        { id: 'c_3_' + Date.now(), name: 'Cluster 3', cardIds: [] }
      ];
      trayCardIds = dataset.cards.map(c => c.id);
      saveBoardState();
    }
  }

  // -------------------------------------------------------------
  // Dataset Switching & Initialization
  // -------------------------------------------------------------
  function loadDataset(dataset) {
    currentDataset = dataset;
    selectedCardId = null;

    loadBoardState(dataset);
    renderHeader();
    renderBoard();
  }

  // -------------------------------------------------------------
  // Compression & URL Fragment Encoding
  // -------------------------------------------------------------
  async function streamToUint8Array(readableStream) {
    const reader = readableStream.getReader();
    const chunks = [];
    let totalLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  async function decompressStreamToString(readableStream) {
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  async function encodeDatasetToFragment(data) {
    const jsonStr = JSON.stringify(data);
    if (typeof CompressionStream !== 'undefined') {
      try {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        writer.write(new TextEncoder().encode(jsonStr));
        writer.close();
        const bytes = await streamToUint8Array(cs.readable);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return 'z:' + b64;
      } catch (err) {
        console.warn('CompressionStream failed, using raw fallback', err);
      }
    }
    // Fallback: UTF-8 to base64url
    const utf8Bytes = new TextEncoder().encode(jsonStr);
    let binary = '';
    for (let i = 0; i < utf8Bytes.byteLength; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    return 'r:' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function decodeFragmentToDataset(hashStr) {
    if (!hashStr) return null;
    let decodedHash = '';
    try {
      decodedHash = decodeURIComponent(hashStr);
    } catch (e) {
      decodedHash = hashStr;
    }
    let payload = decodedHash.startsWith('#') ? decodedHash.slice(1) : decodedHash;
    if (!payload.startsWith('data=')) return null;
    payload = payload.slice(5);

    const isCompressed = payload.startsWith('z:');
    const isRaw = payload.startsWith('r:');
    let b64 = (isCompressed || isRaw) ? payload.slice(2) : payload;

    // Restore base64 padding
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    let jsonStr = '';
    if (isCompressed && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        jsonStr = await decompressStreamToString(ds.readable);
      } catch (e) {
        console.warn('DecompressionStream failed, fallback to TextDecoder', e);
        jsonStr = new TextDecoder().decode(bytes);
      }
    } else {
      jsonStr = new TextDecoder().decode(bytes);
    }

    return validateDataset(JSON.parse(jsonStr));
  }

  // -------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------
  function getCardById(id) {
    return currentDataset.cards.find(c => c.id === id);
  }

  function renderHeader() {
    datasetTitleEl.textContent = currentDataset.title;
    datasetPromptEl.textContent = currentDataset.prompt || '';

    // Withheld info
    if (typeof currentDataset.withheld === 'number' && currentDataset.withheld > 0) {
      withheldInfoEl.hidden = false;
      if (currentDataset.withheldNote) {
        withheldInfoEl.textContent = `${currentDataset.cards.length} ideas shown. ${currentDataset.withheldNote}`;
      } else {
        withheldInfoEl.textContent = `${currentDataset.cards.length} ideas shown, ${currentDataset.withheld} held back pending IP review.`;
      }
    } else {
      withheldInfoEl.hidden = true;
    }

    // Demo badge
    const isDemo = currentDataset.id.startsWith('demo');
    demoBadgeEl.hidden = !isDemo;
    if (!isDemo) {
      datasetIdBadgeEl.hidden = false;
      datasetIdBadgeEl.textContent = currentDataset.id;
    } else {
      datasetIdBadgeEl.hidden = true;
    }

    // Sections legend
    const sections = new Set();
    currentDataset.cards.forEach(c => {
      if (c.section) sections.add(c.section);
    });

    legendBadgesEl.innerHTML = '';
    if (sections.size > 0) {
      sections.forEach(sec => {
        const badge = document.createElement('span');
        badge.className = `badge badge-section badge-section-${sec}`;
        badge.textContent = `Section ${sec}`;
        legendBadgesEl.appendChild(badge);
      });
      sectionLegendEl.hidden = !toggleSectionColorsEl.checked;
    } else {
      sectionLegendEl.hidden = true;
    }

    updateSelectionBanner();
  }

  function renderCardElement(card) {
    const cardEl = document.createElement('div');
    cardEl.className = 'card';
    cardEl.setAttribute('data-id', card.id);
    if (card.section) cardEl.setAttribute('data-section', card.section);
    cardEl.setAttribute('tabindex', '0');
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('aria-label', `Card ${card.id}: ${card.text}`);

    if (selectedCardId === card.id) {
      cardEl.classList.add('selected');
    }

    // Top Row (Number + Section Badge)
    const topRow = document.createElement('div');
    topRow.className = 'card-top';

    const numSpan = document.createElement('span');
    numSpan.className = 'card-number';
    numSpan.textContent = `#${card.id}`;
    topRow.appendChild(numSpan);

    if (card.section) {
      const secTag = document.createElement('span');
      secTag.className = `badge badge-section badge-section-${card.section} card-section-tag`;
      secTag.textContent = `Sec ${card.section}`;
      topRow.appendChild(secTag);
    }
    cardEl.appendChild(topRow);

    // Text
    const textP = document.createElement('p');
    textP.className = 'card-text';
    textP.textContent = card.text;
    cardEl.appendChild(textP);

    // Pointer events for drag and click
    attachCardPointerListeners(cardEl, card.id);

    return cardEl;
  }

  function renderBoard() {
    // Render Tray
    trayCardsEl.innerHTML = '';
    trayCountBadgeEl.textContent = trayCardIds.length;

    trayCardIds.forEach(id => {
      const card = getCardById(id);
      if (card) {
        trayCardsEl.appendChild(renderCardElement(card));
      }
    });

    // Render Clusters
    clustersContainerEl.innerHTML = '';
    totalClustersBadgeEl.textContent = clusters.length;

    clusters.forEach((cluster, index) => {
      const clusterBox = document.createElement('div');
      clusterBox.className = 'cluster-container';
      clusterBox.setAttribute('data-cluster-id', cluster.id);

      // Header
      const header = document.createElement('div');
      header.className = 'cluster-header';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'cluster-title-wrap';

      // Keyboard index badge (1 to 9)
      if (index < 9) {
        const keyBadge = document.createElement('span');
        keyBadge.className = 'cluster-key-badge';
        keyBadge.textContent = `${index + 1}`;
        keyBadge.title = `Press ${index + 1} to drop selected card here`;
        titleWrap.appendChild(keyBadge);
      }

      // Title input
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'cluster-title-input';
      titleInput.value = cluster.name;
      titleInput.setAttribute('aria-label', `Cluster ${index + 1} name`);
      titleInput.addEventListener('change', () => {
        cluster.name = titleInput.value.trim() || `Cluster ${index + 1}`;
        titleInput.value = cluster.name;
        saveBoardState();
      });
      titleWrap.appendChild(titleInput);
      header.appendChild(titleWrap);

      // Actions / Count
      const actions = document.createElement('div');
      actions.className = 'cluster-header-actions';

      const countSpan = document.createElement('span');
      countSpan.className = 'cluster-count';
      countSpan.textContent = `(${cluster.cardIds.length})`;
      actions.appendChild(countSpan);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-delete-cluster';
      deleteBtn.innerHTML = '&times;';
      deleteBtn.title = 'Delete cluster (returns cards to tray)';
      deleteBtn.setAttribute('aria-label', `Delete cluster ${cluster.name}`);
      deleteBtn.addEventListener('click', () => {
        deleteCluster(cluster.id);
      });
      actions.appendChild(deleteBtn);

      header.appendChild(actions);
      clusterBox.appendChild(header);

      // Dropzone Area
      const dropzone = document.createElement('div');
      dropzone.className = 'cluster-dropzone';
      dropzone.setAttribute('data-dropzone', 'cluster');
      dropzone.setAttribute('data-cluster-id', cluster.id);

      if (cluster.cardIds.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'cluster-empty-hint';
        emptyHint.textContent = selectedCardId !== null 
          ? `Click here to place Card #${selectedCardId}` 
          : 'Drop cards here or click after selecting';
        dropzone.appendChild(emptyHint);
      } else {
        cluster.cardIds.forEach(id => {
          const card = getCardById(id);
          if (card) {
            dropzone.appendChild(renderCardElement(card));
          }
        });
      }

      // Allow clicking on cluster dropzone to move selected card
      dropzone.addEventListener('click', (e) => {
        if (e.target.closest('.card')) return; // let card handler deal with clicks on card
        if (selectedCardId !== null) {
          moveCard(selectedCardId, 'cluster', cluster.id);
          selectedCardId = null;
          updateSelectionBanner();
          renderBoard();
        }
      });

      clusterBox.appendChild(dropzone);
      clustersContainerEl.appendChild(clusterBox);
    });

    // Tray click handler for moving selected card back to tray
    trayCardsEl.onclick = (e) => {
      if (e.target.closest('.card')) return;
      if (selectedCardId !== null) {
        moveCard(selectedCardId, 'tray');
        selectedCardId = null;
        updateSelectionBanner();
        renderBoard();
      }
    };
  }

  // -------------------------------------------------------------
  // Card Movement & Actions
  // -------------------------------------------------------------
  function moveCard(cardId, targetType, targetClusterId) {
    // Remove cardId from tray
    trayCardIds = trayCardIds.filter(id => id !== cardId);

    // Remove cardId from all clusters
    clusters.forEach(c => {
      c.cardIds = c.cardIds.filter(id => id !== cardId);
    });

    if (targetType === 'tray') {
      trayCardIds.push(cardId);
    } else if (targetType === 'cluster') {
      const cluster = clusters.find(c => c.id === targetClusterId);
      if (cluster) {
        cluster.cardIds.push(cardId);
      } else {
        trayCardIds.push(cardId);
      }
    }

    saveBoardState();
  }

  function deleteCluster(clusterId) {
    const cluster = clusters.find(c => c.id === clusterId);
    if (!cluster) return;

    // Return all cards to tray
    cluster.cardIds.forEach(id => {
      if (!trayCardIds.includes(id)) {
        trayCardIds.push(id);
      }
    });

    // Remove cluster
    clusters = clusters.filter(c => c.id !== clusterId);
    saveBoardState();
    renderBoard();
  }

  function shuffleTray() {
    // Fisher-Yates shuffle on trayCardIds
    for (let i = trayCardIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [trayCardIds[i], trayCardIds[j]] = [trayCardIds[j], trayCardIds[i]];
    }
    saveBoardState();
    renderBoard();
  }

  function resetBoard() {
    // Move all cards from clusters back to tray
    clusters.forEach(c => {
      c.cardIds.forEach(id => {
        if (!trayCardIds.includes(id)) {
          trayCardIds.push(id);
        }
      });
      c.cardIds = [];
    });
    // Sort tray by natural card order in dataset
    const originalOrder = new Map(currentDataset.cards.map((c, i) => [c.id, i]));
    trayCardIds.sort((a, b) => (originalOrder.get(a) || 0) - (originalOrder.get(b) || 0));

    selectedCardId = null;
    saveBoardState();
    renderBoard();
  }

  function updateSelectionBanner() {
    if (selectedCardId !== null) {
      selectionBannerEl.hidden = false;
      selectionTextEl.textContent = `Card #${selectedCardId} selected`;
    } else {
      selectionBannerEl.hidden = true;
    }
  }

  // -------------------------------------------------------------
  // Pointer Events: Smooth Drag & Drop + Click-to-Move
  // -------------------------------------------------------------
  let activePointerDrag = null;

  function attachCardPointerListeners(cardEl, cardId) {
    let startX = 0;
    let startY = 0;
    let isDragging = false;
    let ghostEl = null;

    cardEl.addEventListener('pointerdown', (e) => {
      // Don't drag if secondary button or typing in input
      if (e.button !== 0 || e.target.tagName === 'INPUT') return;

      startX = e.clientX;
      startY = e.clientY;
      isDragging = false;

      function onPointerMove(moveEvent) {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        if (!isDragging && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          isDragging = true;
          cardEl.classList.add('is-dragging');

          // Create ghost
          ghostEl = document.createElement('div');
          ghostEl.className = 'drag-ghost';
          ghostEl.innerHTML = `<strong>#${cardId}</strong>: ${cardEl.querySelector('.card-text').textContent}`;
          document.body.appendChild(ghostEl);
        }

        if (isDragging && ghostEl) {
          ghostEl.style.left = `${moveEvent.clientX}px`;
          ghostEl.style.top = `${moveEvent.clientY}px`;

          // Drop target highlighting
          updateDropTargetHighlights(moveEvent.clientX, moveEvent.clientY);
        }
      }

      function onPointerUp(upEvent) {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);

        if (isDragging) {
          cardEl.classList.remove('is-dragging');
          if (ghostEl) {
            ghostEl.remove();
            ghostEl = null;
          }

          // Identify drop zone under pointer
          const dropTarget = getDropZoneUnderPoint(upEvent.clientX, upEvent.clientY);
          clearDropTargetHighlights();

          if (dropTarget) {
            if (dropTarget.type === 'tray') {
              moveCard(cardId, 'tray');
            } else if (dropTarget.type === 'cluster') {
              moveCard(cardId, 'cluster', dropTarget.clusterId);
            }
            selectedCardId = null;
            renderBoard();
          }
        } else {
          // It was a click!
          handleCardClick(cardId);
        }
      }

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    });

    // Keyboard support on card
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCardClick(cardId);
      }
    });
  }

  function handleCardClick(cardId) {
    if (selectedCardId === cardId) {
      selectedCardId = null;
    } else {
      selectedCardId = cardId;
    }
    updateSelectionBanner();
    renderBoard();
  }

  function getDropZoneUnderPoint(x, y) {
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
      const dropzone = el.closest('[data-dropzone]');
      if (dropzone) {
        const type = dropzone.getAttribute('data-dropzone');
        if (type === 'tray') {
          return { type: 'tray' };
        } else if (type === 'cluster') {
          return { type: 'cluster', clusterId: dropzone.getAttribute('data-cluster-id') };
        }
      }
    }
    return null;
  }

  function updateDropTargetHighlights(x, y) {
    clearDropTargetHighlights();
    const target = getDropZoneUnderPoint(x, y);
    if (target) {
      if (target.type === 'tray') {
        trayCardsEl.classList.add('drop-target-active');
      } else if (target.type === 'cluster') {
        const clusterBox = document.querySelector(`.cluster-container[data-cluster-id="${target.clusterId}"]`);
        if (clusterBox) clusterBox.classList.add('drop-target-active');
      }
    }
  }

  function clearDropTargetHighlights() {
    trayCardsEl.classList.remove('drop-target-active');
    document.querySelectorAll('.cluster-container').forEach(c => c.classList.remove('drop-target-active'));
  }

  // -------------------------------------------------------------
  // Keyboard Shortcuts (0-9 for Clusters/Tray, Esc, Arrow navigation)
  // -------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    // Ignore if typing in an input, textarea or dialog is active
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (document.querySelector('dialog[open]')) return;

    // Arrow keys navigation between cards
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      const cards = Array.from(document.querySelectorAll('.card'));
      if (cards.length > 0) {
        let currentIdx = cards.findIndex(c => c === document.activeElement);
        if (currentIdx === -1 && selectedCardId !== null) {
          currentIdx = cards.findIndex(c => c.getAttribute('data-id') === String(selectedCardId));
        }

        if (currentIdx === -1) {
          currentIdx = 0;
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          currentIdx = (currentIdx + 1) % cards.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          currentIdx = (currentIdx - 1 + cards.length) % cards.length;
        }

        cards[currentIdx].focus();
        if (selectedCardId !== null) {
          // If a card is already picked up, arrow moves selection to new card
          selectedCardId = parseInt(cards[currentIdx].getAttribute('data-id'), 10);
          updateSelectionBanner();
          renderBoard();
        }
        e.preventDefault();
        return;
      }
    }

    if (selectedCardId !== null) {
      // 1 to 9 -> move to cluster 1 to 9
      if (e.key >= '1' && e.key <= '9') {
        const index = parseInt(e.key, 10) - 1;
        if (index < clusters.length) {
          moveCard(selectedCardId, 'cluster', clusters[index].id);
          selectedCardId = null;
          updateSelectionBanner();
          renderBoard();
          e.preventDefault();
        }
      } else if (e.key === '0') {
        // 0 -> move to tray
        moveCard(selectedCardId, 'tray');
        selectedCardId = null;
        updateSelectionBanner();
        renderBoard();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        selectedCardId = null;
        updateSelectionBanner();
        renderBoard();
        e.preventDefault();
      }
    }
  });

  // -------------------------------------------------------------
  // Countdown Timer
  // -------------------------------------------------------------
  function formatTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function updateTimerDisplay() {
    timerDisplayEl.textContent = formatTime(timerRemaining);
  }

  function startTimer() {
    if (timerRunning) return;
    timerRunning = true;
    btnTimerToggleEl.textContent = 'Pause';
    timerWidgetEl.classList.remove('timer-expired');

    timerInterval = setInterval(() => {
      if (timerRemaining > 0) {
        timerRemaining--;
        updateTimerDisplay();
        if (timerRemaining === 0) {
          pauseTimer();
          timerWidgetEl.classList.add('timer-expired');
        }
      }
    }, 1000);
  }

  function pauseTimer() {
    timerRunning = false;
    btnTimerToggleEl.textContent = 'Start';
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function resetTimer() {
    pauseTimer();
    timerRemaining = timerDuration;
    timerWidgetEl.classList.remove('timer-expired');
    updateTimerDisplay();
  }

  // -------------------------------------------------------------
  // Summary View
  // -------------------------------------------------------------
  function generateSummaryText() {
    const lines = [];
    clusters.forEach(c => {
      const sortedIds = [...c.cardIds].sort((a, b) => a - b);
      lines.push(`${c.name} (${c.cardIds.length}): ${sortedIds.join(', ')}`);
    });
    if (trayCardIds.length > 0) {
      const sortedTray = [...trayCardIds].sort((a, b) => a - b);
      lines.push(`Unclustered Tray (${trayCardIds.length}): ${sortedTray.join(', ')}`);
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------
  // Print Cards Layout
  // -------------------------------------------------------------
  function setupPrintArea() {
    printCardsAreaEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'print-header';

    const title = document.createElement('h1');
    title.className = 'print-title';
    title.textContent = currentDataset.title;
    header.appendChild(title);

    const prompt = document.createElement('p');
    prompt.className = 'print-prompt';
    prompt.textContent = currentDataset.prompt || '';
    header.appendChild(prompt);

    printCardsAreaEl.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'print-grid';

    // Sort cards numerically
    const sortedCards = [...currentDataset.cards].sort((a, b) => a.id - b.id);
    sortedCards.forEach(c => {
      const cardBox = document.createElement('div');
      cardBox.className = 'print-card';

      const top = document.createElement('div');
      top.className = 'print-card-top';

      const idSpan = document.createElement('span');
      idSpan.className = 'print-card-id';
      idSpan.textContent = `#${c.id}`;
      top.appendChild(idSpan);

      if (c.section) {
        const secSpan = document.createElement('span');
        secSpan.className = 'print-card-section';
        secSpan.textContent = `Section ${c.section}`;
        top.appendChild(secSpan);
      }
      cardBox.appendChild(top);

      const textP = document.createElement('p');
      textP.className = 'print-card-text';
      textP.textContent = c.text;
      cardBox.appendChild(textP);

      grid.appendChild(cardBox);
    });

    printCardsAreaEl.appendChild(grid);
  }

  // -------------------------------------------------------------
  // Event Listeners & Setup
  // -------------------------------------------------------------
  function attachEventHandlers() {
    // Toolbar: New Cluster
    document.getElementById('btnNewCluster').addEventListener('click', () => {
      const newCluster = {
        id: 'c_' + Date.now(),
        name: `Cluster ${clusters.length + 1}`,
        cardIds: []
      };
      clusters.push(newCluster);
      saveBoardState();
      renderBoard();

      // Focus the new cluster's title input
      setTimeout(() => {
        const input = document.querySelector(`.cluster-container[data-cluster-id="${newCluster.id}"] .cluster-title-input`);
        if (input) {
          input.focus();
          input.select();
        }
      }, 50);
    });

    // Toolbar: Shuffle Tray
    document.getElementById('btnShuffleTray').addEventListener('click', shuffleTray);

    // Toolbar: Reset Board
    document.getElementById('btnResetBoard').addEventListener('click', () => {
      confirmResetDialogEl.showModal();
    });

    document.getElementById('btnCancelReset').addEventListener('click', () => {
      confirmResetDialogEl.close();
    });

    document.getElementById('btnConfirmReset').addEventListener('click', () => {
      resetBoard();
      confirmResetDialogEl.close();
    });

    // Section Colors Toggle
    toggleSectionColorsEl.addEventListener('change', () => {
      if (toggleSectionColorsEl.checked) {
        document.body.classList.add('show-sections');
      } else {
        document.body.classList.remove('show-sections');
      }
      renderHeader();
    });

    // Big Text Toggle
    toggleBigTextEl.addEventListener('change', () => {
      if (toggleBigTextEl.checked) {
        document.body.classList.add('big-text');
      } else {
        document.body.classList.remove('big-text');
      }
    });

    // Selection Cancel
    document.getElementById('btnCancelSelection').addEventListener('click', () => {
      selectedCardId = null;
      updateSelectionBanner();
      renderBoard();
    });

    // Timer Controls
    btnTimerToggleEl.addEventListener('click', () => {
      if (timerRunning) {
        pauseTimer();
      } else {
        startTimer();
      }
    });

    btnTimerResetEl.addEventListener('click', resetTimer);

    btnTimerEditEl.addEventListener('click', () => {
      timerMinutesInputEl.value = Math.round(timerDuration / 60);
      timerDialogEl.showModal();
    });

    timerDisplayEl.addEventListener('click', () => {
      timerMinutesInputEl.value = Math.round(timerDuration / 60);
      timerDialogEl.showModal();
    });

    document.getElementById('btnCancelTimerDialog').addEventListener('click', () => {
      timerDialogEl.close();
    });

    document.getElementById('timerForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const mins = parseInt(timerMinutesInputEl.value, 10);
      if (!isNaN(mins) && mins > 0) {
        timerDuration = mins * 60;
        resetTimer();
      }
      timerDialogEl.close();
    });

    // Open File
    document.getElementById('btnOpenFile').addEventListener('click', () => {
      fileInputEl.click();
    });

    fileInputEl.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          const sanitized = validateDataset(parsed);
          window.location.hash = ''; // clear hash
          loadDataset(sanitized);
        } catch (err) {
          alert('Error loading JSON file:\n' + err.message);
        }
      };
      reader.readAsText(file);
      fileInputEl.value = '';
    });

    // Paste JSON
    document.getElementById('btnPaste').addEventListener('click', () => {
      pasteTextareaEl.value = '';
      pasteErrorEl.hidden = true;
      pasteDialogEl.showModal();
    });

    document.getElementById('btnCancelPaste').addEventListener('click', () => {
      pasteDialogEl.close();
    });

    document.getElementById('pasteForm').addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const text = pasteTextareaEl.value.trim();
        if (!text) throw new Error('Please paste JSON text before submitting.');
        const parsed = JSON.parse(text);
        const sanitized = validateDataset(parsed);
        window.location.hash = '';
        loadDataset(sanitized);
        pasteDialogEl.close();
      } catch (err) {
        pasteErrorEl.hidden = false;
        pasteErrorEl.textContent = 'JSON Error: ' + err.message;
      }
    });

    // Share Link
    document.getElementById('btnShare').addEventListener('click', async () => {
      shareCopyFeedbackEl.hidden = true;
      shareDialogEl.showModal();
      shareUrlInputEl.value = 'Generating link...';
      try {
        const fragment = await encodeDatasetToFragment(currentDataset);
        const url = window.location.origin + window.location.pathname + '#data=' + fragment;
        shareUrlInputEl.value = url;
        shareUrlInputEl.select();
      } catch (err) {
        shareUrlInputEl.value = 'Failed to generate link: ' + err.message;
      }
    });

    document.getElementById('btnCopyShareUrl').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareUrlInputEl.value);
        shareCopyFeedbackEl.hidden = false;
      } catch (err) {
        shareUrlInputEl.select();
        document.execCommand('copy');
        shareCopyFeedbackEl.hidden = false;
      }
    });

    document.getElementById('btnCloseShareDialog').addEventListener('click', () => {
      shareDialogEl.close();
    });

    // Summary View
    document.getElementById('btnSummary').addEventListener('click', () => {
      summaryPreEl.textContent = generateSummaryText();
      summaryCopyFeedbackEl.hidden = true;
      summaryDialogEl.showModal();
    });

    document.getElementById('btnCopySummary').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(summaryPreEl.textContent);
        summaryCopyFeedbackEl.hidden = false;
      } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = summaryPreEl.textContent;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        summaryCopyFeedbackEl.hidden = false;
      }
    });

    document.getElementById('btnCloseSummary').addEventListener('click', () => {
      summaryDialogEl.close();
    });

    // State Export / Import
    document.getElementById('btnExportImport').addEventListener('click', () => {
      stateErrorEl.hidden = true;
      stateSuccessEl.hidden = true;
      importStateTextareaEl.value = '';
      stateDialogEl.showModal();
    });

    document.getElementById('btnDownloadState').addEventListener('click', () => {
      const state = {
        datasetId: currentDataset.id,
        clusters: clusters.map(c => ({ id: c.id, name: c.name, cardIds: c.cardIds })),
        trayCardIds: trayCardIds,
        exportedAt: new Date().toISOString()
      };
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentDataset.id}_board_state.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('btnCopyState').addEventListener('click', async () => {
      const state = {
        datasetId: currentDataset.id,
        clusters: clusters.map(c => ({ id: c.id, name: c.name, cardIds: c.cardIds })),
        trayCardIds: trayCardIds,
        exportedAt: new Date().toISOString()
      };
      const text = JSON.stringify(state, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        stateSuccessEl.hidden = false;
        stateSuccessEl.textContent = 'Board state JSON copied to clipboard!';
      } catch (e) {
        stateErrorEl.hidden = false;
        stateErrorEl.textContent = 'Could not access clipboard.';
      }
    });

    document.getElementById('btnImportStateFile').addEventListener('click', () => {
      stateFileInputEl.click();
    });

    stateFileInputEl.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        applyImportedState(evt.target.result);
      };
      reader.readAsText(file);
      stateFileInputEl.value = '';
    });

    document.getElementById('btnApplyStatePaste').addEventListener('click', () => {
      applyImportedState(importStateTextareaEl.value);
    });

    function applyImportedState(jsonText) {
      try {
        stateErrorEl.hidden = true;
        stateSuccessEl.hidden = true;
        const parsed = JSON.parse(jsonText);
        if (!parsed || !Array.isArray(parsed.clusters)) {
          throw new Error('State must be an object with a "clusters" array.');
        }
        // Save to current dataset localStorage
        localStorage.setItem(getStorageKey(currentDataset.id), JSON.stringify(parsed));
        loadBoardState(currentDataset);
        renderBoard();
        stateSuccessEl.hidden = false;
        stateSuccessEl.textContent = 'Board arrangement applied successfully!';
      } catch (err) {
        stateErrorEl.hidden = false;
        stateErrorEl.textContent = 'Import error: ' + err.message;
      }
    }

    document.getElementById('btnCloseStateDialog').addEventListener('click', () => {
      stateDialogEl.close();
    });

    // Print Cards
    document.getElementById('btnPrint').addEventListener('click', () => {
      setupPrintArea();
      window.print();
    });

    // Help Dialog
    document.getElementById('btnHelp').addEventListener('click', () => {
      helpDialogEl.showModal();
    });

    document.getElementById('btnCloseHelp').addEventListener('click', () => {
      helpDialogEl.close();
    });
  }

  // -------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------
  async function init() {
    attachEventHandlers();
    updateTimerDisplay();

    // Check URL fragment for shared dataset
    if (window.location.hash) {
      try {
        const datasetFromHash = await decodeFragmentToDataset(window.location.hash);
        if (datasetFromHash) {
          loadDataset(datasetFromHash);
          return;
        }
      } catch (err) {
        console.warn('Failed to parse dataset from URL fragment:', err);
      }
    }

    // Default to synthetic demo dataset
    loadDataset(DEMO_DATASET);
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
