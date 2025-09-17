(() => {
  'use strict';
  const YEAR_MIN = 2018;
  const DATA_PREFIX = 'data/medicare_drugs_';
  const NHE_PATH = 'data/nhe_retail_rx.json';
  const svgNS = 'http://www.w3.org/2000/svg';

  const storage = createStorage();

  function createStorage() {
    const DB_NAME = 'rx-scoreboard-data';
    const STORE_NAME = 'files';
    let dbPromise = null;

    const isSupported = () => typeof indexedDB !== 'undefined';

    async function openDb() {
      if (!isSupported()) {
        return null;
      }
      if (dbPromise) {
        return dbPromise;
      }
      dbPromise = new Promise((resolve, reject) => {
        try {
          const request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              db.createObjectStore(STORE_NAME, { keyPath: 'name' });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
              db.close();
            };
            resolve(db);
          };
          request.onerror = () => {
            reject(request.error || new Error('Failed to open storage'));
          };
        } catch (error) {
          reject(error);
        }
      }).catch((error) => {
        console.error('Storage unavailable', error);
        return null;
      });
      return dbPromise;
    }

    async function save(name, contents, type = 'application/json') {
      const db = await openDb();
      if (!db) {
        return false;
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        const store = tx.objectStore(STORE_NAME);
        store.put({ name, contents, type, updated: Date.now() });
      }).catch((error) => {
        console.error('Failed to save data', error);
        return false;
      });
    }

    async function load(name) {
      const db = await openDb();
      if (!db) {
        return null;
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(name);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        console.error('Failed to read data', error);
        return null;
      });
    }

    async function list() {
      const db = await openDb();
      if (!db) {
        return [];
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        console.error('Failed to list stored data', error);
        return [];
      });
    }

    async function remove(name) {
      const db = await openDb();
      if (!db) {
        return false;
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        tx.objectStore(STORE_NAME).delete(name);
      }).catch((error) => {
        console.error('Failed to delete stored data', error);
        return false;
      });
    }

    async function clearAll() {
      const db = await openDb();
      if (!db) {
        return false;
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        tx.objectStore(STORE_NAME).clear();
      }).catch((error) => {
        console.error('Failed to clear stored data', error);
        return false;
      });
    }

    return {
      isSupported,
      save,
      load,
      list,
      remove,
      clear: clearAll,
    };
  }

  const USD_FULL = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  const USD_COMPACT = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 1,
    notation: 'compact',
  });
  const USD_PER_SECOND = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
  const INT_COMPACT = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const INT_FULL = new Intl.NumberFormat('en-US');

  const state = {
    dataByYear: new Map(),
    years: [],
    year: null,
    part: 'both',
    glp1Only: false,
    nhe: null,
    dataSources: new Map(),
    nheSource: null,
  };

  const elements = {
    yearSelect: document.getElementById('yearSelect'),
    partToggle: document.getElementById('partToggle'),
    glp1: document.getElementById('glp1Only'),
    dataManager: document.getElementById('dataManager'),
    dataStatus: document.getElementById('dataStatus'),
    uploadButton: document.getElementById('uploadDataButton'),
    clearDataButton: document.getElementById('clearDataButton'),
    dataFileInput: document.getElementById('dataFileInput'),
    heroSection: document.getElementById('hero'),
    heroTotal: document.getElementById('heroTotal'),
    heroRate: document.getElementById('heroRate'),
    heroContext: document.getElementById('heroContext'),
    topList: document.getElementById('topDrugsList'),
    moversList: document.getElementById('moversList'),
    scatter: document.getElementById('scatterPlot'),
    panels: document.querySelector('.panels'),
    emptyState: document.getElementById('emptyState'),
    tooltipLayer: document.getElementById('tooltip'),
  };

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let filtersBound = false;
  let dataControlsBound = false;
  let tooltipBubble = null;
  let rafId = null;
  let lastFrame = null;

  class AnimatedNumber {
    constructor(el, formatter) {
      this.el = el;
      this.formatter = formatter;
      this.value = 0;
      this.rate = 0;
      this.limit = Infinity;
      this.lastText = '';
    }

    update({ value, rate, limit }) {
      if (!Number.isFinite(value)) {
        value = 0;
      }
      this.limit = Number.isFinite(limit) ? limit : Infinity;
      this.value = Math.min(value, this.limit);
      this.rate = Number.isFinite(rate) ? rate : 0;
      this.render();
      scheduleAnimation();
    }

    stop() {
      this.rate = 0;
    }

    shouldAnimate() {
      return (
        !prefersReducedMotion.matches &&
        !document.hidden &&
        this.rate !== 0 &&
        this.value < this.limit
      );
    }

    tick(delta) {
      if (!this.shouldAnimate()) {
        return this.shouldAnimate();
      }
      const next = Math.min(this.limit, this.value + this.rate * delta);
      this.value = next;
      if (this.value >= this.limit) {
        this.value = this.limit;
      }
      this.render();
      return this.shouldAnimate();
    }

    render() {
      const text = this.formatter(this.value);
      if (text !== this.lastText) {
        this.el.textContent = text;
        this.lastText = text;
      }
    }
  }

  const counterRegistry = new Map();
  const animatedNumbers = new Set();

  function getCounter(el, formatter) {
    if (counterRegistry.has(el)) {
      const existing = counterRegistry.get(el);
      existing.formatter = formatter;
      return existing;
    }
    const counter = new AnimatedNumber(el, formatter);
    counterRegistry.set(el, counter);
    animatedNumbers.add(counter);
    return counter;
  }

  function releaseCounter(el) {
    const counter = counterRegistry.get(el);
    if (counter) {
      counter.stop();
      animatedNumbers.delete(counter);
      counterRegistry.delete(el);
    }
  }

  function hasActiveCounters() {
    for (const counter of animatedNumbers) {
      if (counter.shouldAnimate()) {
        return true;
      }
    }
    return false;
  }

  function scheduleAnimation() {
    if (rafId !== null) {
      return;
    }
    if (!hasActiveCounters()) {
      return;
    }
    rafId = requestAnimationFrame(step);
  }

  function step(timestamp) {
    rafId = null;
    if (prefersReducedMotion.matches || document.hidden) {
      lastFrame = null;
      return;
    }
    if (lastFrame === null) {
      lastFrame = timestamp;
    }
    const delta = (timestamp - lastFrame) / 1000;
    lastFrame = timestamp;
    let active = false;
    for (const counter of animatedNumbers) {
      if (counter.tick(delta)) {
        active = true;
      }
    }
    if (active) {
      scheduleAnimation();
    } else {
      lastFrame = null;
    }
  }

  const handleMotionChange = () => {
    lastFrame = null;
    if (!prefersReducedMotion.matches) {
      scheduleAnimation();
    }
  };

  if (typeof prefersReducedMotion.addEventListener === 'function') {
    prefersReducedMotion.addEventListener('change', handleMotionChange);
  } else if (typeof prefersReducedMotion.addListener === 'function') {
    prefersReducedMotion.addListener(handleMotionChange);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastFrame = null;
      scheduleAnimation();
    }
  });

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindControls();
    bindDataControls();
    await hydrateFromStorage();
    updateDataStatus();
    const hasData = await refreshData({ fetchMissing: true, runUpdate: false });
    await loadNhe();
    if (hasData) {
      update();
    }
    updateDataStatus();
  }

  function showEmptyState(show) {
    elements.emptyState.hidden = !show;
    elements.heroSection.style.display = show ? 'none' : '';
    elements.panels.style.display = show ? 'none' : '';
  }

  function populateYearSelect() {
    const select = elements.yearSelect;
    select.innerHTML = '';
    state.years.forEach((year) => {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      select.appendChild(option);
    });
    if (state.year != null) {
      select.value = String(state.year);
    } else {
      select.value = '';
    }
    select.disabled = state.years.length === 0;
  }

  function bindControls() {
    if (filtersBound) {
      return;
    }
    filtersBound = true;
    elements.yearSelect.addEventListener('change', (event) => {
      const value = Number.parseInt(event.target.value, 10);
      if (!Number.isNaN(value)) {
        state.year = value;
        update();
      }
    });
    elements.partToggle.addEventListener('change', (event) => {
      if (event.target && event.target.name === 'part') {
        state.part = event.target.value;
        update();
      }
    });
    elements.glp1.addEventListener('change', (event) => {
      state.glp1Only = Boolean(event.target.checked);
      update();
    });
  }

  function bindDataControls() {
    if (dataControlsBound) {
      return;
    }
    dataControlsBound = true;
    const { uploadButton, dataFileInput, clearDataButton } = elements;
    if (uploadButton && dataFileInput) {
      uploadButton.addEventListener('click', () => {
        dataFileInput.click();
      });
      dataFileInput.addEventListener('change', async (event) => {
        const { files } = event.target;
        if (files && files.length > 0) {
          await handleDataUpload(files);
        }
        dataFileInput.value = '';
      });
    }
    if (clearDataButton) {
      clearDataButton.addEventListener('click', async () => {
        const hasStored = getStoredMedicareYears().length > 0 || state.nheSource === 'storage';
        const hasSessionUploads = [...state.dataSources.values()].some((value) => value === 'session')
          || state.nheSource === 'session';
        if (!hasStored && !hasSessionUploads && !state.nhe) {
          updateDataStatus('No saved data to clear.');
          return;
        }
        if (hasStored || hasSessionUploads) {
          const confirmed = window.confirm('Remove locally saved data from this browser?');
          if (!confirmed) {
            return;
          }
        }
        await forgetStoredData();
      });
    }
  }

  async function hydrateFromStorage() {
    if (!storage.isSupported()) {
      return;
    }
    try {
      const records = await storage.list();
      records.forEach((record) => {
        if (!record || typeof record.name !== 'string') {
          return;
        }
        if (record.name.startsWith('medicare_drugs_')) {
          const match = record.name.match(/medicare_drugs_(\d{4})\.json$/i);
          if (!match) {
            return;
          }
          const year = Number.parseInt(match[1], 10);
          try {
            const payload = typeof record.contents === 'string' ? JSON.parse(record.contents) : record.contents;
            if (Array.isArray(payload)) {
              state.dataByYear.set(year, payload);
              state.dataSources.set(year, 'storage');
            } else {
              storage.remove(record.name);
            }
          } catch (error) {
            console.error('Failed to parse stored Medicare data', error);
            storage.remove(record.name);
          }
        } else if (record.name === 'nhe_retail_rx.json') {
          try {
            const payload = typeof record.contents === 'string' ? JSON.parse(record.contents) : record.contents;
            if (payload && typeof payload === 'object') {
              state.nhe = payload;
              state.nheSource = 'storage';
            } else {
              storage.remove(record.name);
            }
          } catch (error) {
            console.error('Failed to parse stored NHE data', error);
            storage.remove(record.name);
          }
        }
      });
    } catch (error) {
      console.error('Unable to hydrate stored data', error);
    }
  }

  async function refreshData({ fetchMissing = true, runUpdate = true } = {}) {
    let years;
    if (fetchMissing) {
      years = await discoverYears();
    } else {
      years = [...state.dataByYear.keys()].sort((a, b) => b - a);
    }
    state.years = years;
    if (!state.years.length) {
      state.year = null;
      populateYearSelect();
      showEmptyState(true);
      return false;
    }
    if (state.year == null || !state.years.includes(state.year)) {
      state.year = state.years[0];
    }
    populateYearSelect();
    showEmptyState(false);
    if (runUpdate) {
      update();
    }
    return true;
  }

  async function handleDataUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) {
      updateDataStatus('No files selected.');
      return;
    }
    const savedPersistent = [];
    const savedSession = [];
    const skipped = [];
    const failed = [];
    for (const file of files) {
      const canonicalName = normalizeDataFileName(file.name);
      if (!canonicalName) {
        skipped.push(file.name);
        continue;
      }
      let text;
      try {
        text = await file.text();
      } catch (error) {
        console.error('Failed to read uploaded file', file.name, error);
        failed.push(file.name);
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        if (canonicalName.startsWith('medicare_drugs_')) {
          if (!Array.isArray(parsed)) {
            throw new Error('Expected an array of Medicare rows.');
          }
          const match = canonicalName.match(/medicare_drugs_(\d{4})\.json$/);
          if (!match) {
            throw new Error('Unable to determine year from filename.');
          }
          const year = Number.parseInt(match[1], 10);
          state.dataByYear.set(year, parsed);
          state.dataSources.set(year, 'session');
          let persisted = false;
          if (storage.isSupported()) {
            persisted = await storage.save(canonicalName, text, file.type || 'application/json');
            if (persisted) {
              state.dataSources.set(year, 'storage');
            }
          }
          if (persisted) {
            savedPersistent.push(`Medicare ${year}`);
          } else {
            savedSession.push(`Medicare ${year}`);
          }
        } else if (canonicalName === 'nhe_retail_rx.json') {
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('Expected an object payload for NHE.');
          }
          state.nhe = parsed;
          state.nheSource = 'session';
          let persisted = false;
          if (storage.isSupported()) {
            persisted = await storage.save(canonicalName, text, file.type || 'application/json');
            if (persisted) {
              state.nheSource = 'storage';
            }
          }
          if (persisted) {
            savedPersistent.push('NHE Table 01');
          } else {
            savedSession.push('NHE Table 01');
          }
        }
      } catch (error) {
        console.error('Failed to process uploaded file', file.name, error);
        failed.push(file.name);
      }
    }
    const hasData = await refreshData({ fetchMissing: false, runUpdate: false });
    if (hasData) {
      update();
    }
    const messages = [];
    if (savedPersistent.length) {
      messages.push(`Saved ${savedPersistent.join(', ')}.`);
    }
    if (savedSession.length) {
      messages.push(`Loaded for this session: ${savedSession.join(', ')}.`);
    }
    if (skipped.length) {
      messages.push(`Skipped unrecognized files: ${skipped.join(', ')}.`);
    }
    if (failed.length) {
      messages.push(`Failed to import: ${failed.join(', ')}.`);
    }
    if (!messages.length) {
      messages.push('No recognized files were uploaded.');
    }
    updateDataStatus(messages.join(' '));
  }

  async function forgetStoredData() {
    const hadStored = getStoredMedicareYears().length > 0 || state.nheSource === 'storage';
    const hadSession = [...state.dataSources.values()].some((value) => value === 'session')
      || state.nheSource === 'session';
    if (storage.isSupported()) {
      await storage.clear();
    }
    [...state.dataSources.entries()].forEach(([year, source]) => {
      if (source === 'storage' || source === 'session') {
        state.dataSources.delete(year);
        state.dataByYear.delete(year);
      }
    });
    if (state.nheSource === 'storage' || state.nheSource === 'session') {
      state.nhe = null;
      state.nheSource = null;
    }
    const hasData = await refreshData({ fetchMissing: true, runUpdate: false });
    await loadNhe();
    if (hasData) {
      update();
    }
    const message = hadStored || hadSession ? 'Saved data cleared.' : 'No saved data to clear.';
    updateDataStatus(message);
  }

  function updateDataStatus(feedback = '') {
    const statusEl = elements.dataStatus;
    if (!statusEl) {
      return;
    }
    let summary;
    if (!storage.isSupported()) {
      summary = 'This browser cannot store files locally; uploaded data will only persist for this session.';
    } else {
      const storedYears = getStoredMedicareYears();
      const parts = [];
      if (storedYears.length) {
        parts.push(`Medicare: ${storedYears.join(', ')}`);
      }
      if (state.nheSource === 'storage' && state.nhe) {
        const yearLabel = state.nhe.latest_year != null ? ` ${state.nhe.latest_year}` : '';
        parts.push(`NHE${yearLabel}`.trim());
      }
      summary = parts.length ? `Saved locally — ${parts.join('; ')}.` : 'No data saved locally yet.';
    }
    const text = feedback ? `${feedback.trim()} ${summary}`.trim() : summary;
    statusEl.textContent = text;
  }

  function getStoredMedicareYears() {
    return [...state.dataSources.entries()]
      .filter(([, source]) => source === 'storage')
      .map(([year]) => year)
      .sort((a, b) => b - a)
      .map((year) => String(year));
  }

  function normalizeDataFileName(name) {
    if (!name) {
      return null;
    }
    const sanitized = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/\(\d+\)/g, '');
    const medicareMatch = sanitized.match(/medicare[_-]?drugs[_-]?(\d{4})\.json$/);
    if (medicareMatch) {
      return `medicare_drugs_${medicareMatch[1]}.json`;
    }
    if (sanitized === 'nhe_retail_rx.json') {
      return 'nhe_retail_rx.json';
    }
    return null;
  }

  async function discoverYears() {
    const years = new Set([...state.dataByYear.keys()]);
    const currentYear = new Date().getFullYear();
    for (let year = currentYear; year >= YEAR_MIN; year -= 1) {
      if (state.dataByYear.has(year)) {
        years.add(year);
        continue;
      }
      const url = `${DATA_PREFIX}${year}.json`;
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        if (Array.isArray(data)) {
          state.dataByYear.set(year, data);
          state.dataSources.set(year, 'fetch');
          years.add(year);
        }
      } catch (error) {
        // ignore network errors for discovery
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }

  async function loadNhe() {
    if (state.nhe) {
      return;
    }
    try {
      const response = await fetch(NHE_PATH, { cache: 'no-cache' });
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (payload && typeof payload === 'object') {
        state.nhe = payload;
        state.nheSource = 'fetch';
      }
    } catch (error) {
      // swallow fetch errors so UI can still render
    }
  }

  function update() {
    if (state.year == null) {
      showEmptyState(true);
      return;
    }
    const yearData = state.dataByYear.get(state.year) || [];
    if (!yearData.length) {
      showEmptyState(true);
      return;
    }
    showEmptyState(false);
    const filtered = yearData.filter((row) => {
      const partMatch = state.part === 'both' || row.part === state.part;
      const glpMatch = !state.glp1Only || row.is_glp1;
      return partMatch && glpMatch;
    });
    const timeContext = computeTimeContext(state.year);
    renderHero(filtered, timeContext);
    renderTopDrugs(filtered, timeContext);
    renderMovers(filtered);
    renderScatter(filtered);
  }

  function computeTimeContext(year) {
    const start = Date.UTC(year, 0, 1, 0, 0, 0);
    const end = Date.UTC(year + 1, 0, 1, 0, 0, 0);
    const yearSeconds = (end - start) / 1000;
    const now = Date.now();
    let elapsedSeconds = yearSeconds;
    const currentYear = new Date().getFullYear();
    if (year === currentYear) {
      elapsedSeconds = Math.max(0, Math.min(yearSeconds, (now - start) / 1000));
    } else if (year > currentYear) {
      elapsedSeconds = 0;
    }
    return {
      yearSeconds,
      elapsedSeconds,
      isCurrent: year === currentYear && elapsedSeconds < yearSeconds,
    };
  }

  function renderHero(filtered, timeContext) {
    const total = filtered.reduce((sum, row) => sum + (row.spend_total_usd || 0), 0);
    const heroRateEl = elements.heroRate;
    const heroContextEl = elements.heroContext;
    if (total <= 0) {
      releaseCounter(elements.heroTotal);
      elements.heroTotal.textContent = '—';
      heroRateEl.textContent = 'No spend data for this selection';
    } else {
      const rate = timeContext.yearSeconds > 0 && timeContext.isCurrent
        ? total / timeContext.yearSeconds
        : 0;
      const initial = computeInitialValue(total, rate, timeContext);
      const heroCounter = getCounter(elements.heroTotal, (value) => USD_FULL.format(value));
      heroCounter.update({ value: initial, rate, limit: total });
      if (rate > 0) {
        heroRateEl.textContent = `≈ ${USD_PER_SECOND.format(rate)} per second`;
      } else {
        heroRateEl.textContent = `${USD_FULL.format(total)} full-year total`;
      }
    }
    if (state.nhe && state.nhe.value_usd) {
      heroContextEl.textContent = `NHE retail RX ${state.nhe.latest_year}: ${USD_FULL.format(state.nhe.value_usd)}`;
    } else {
      heroContextEl.textContent = '';
    }
  }

  function renderTopDrugs(filtered, timeContext) {
    const list = elements.topList;
    clearContainer(list);
    if (!filtered.length) {
      renderMutedMessage(list, 'No drugs match the current filters yet.');
      return;
    }
    const sorted = [...filtered].sort(
      (a, b) => (b.spend_total_usd || 0) - (a.spend_total_usd || 0),
    );
    const topFive = sorted.slice(0, 5);
    topFive.forEach((row) => {
      const li = document.createElement('li');
      li.appendChild(buildDrugName(row));
      const metrics = document.createElement('div');
      metrics.className = 'drug-metrics';
      const valueSpan = document.createElement('span');
      valueSpan.className = 'drug-value';
      valueSpan.dataset.counter = 'true';
      const total = row.spend_total_usd || 0;
      const formattedTotal = USD_FULL.format(total);
      valueSpan.title = `${formattedTotal} in ${state.year}`;
      const perSecond = timeContext.yearSeconds > 0 && timeContext.isCurrent
        ? total / timeContext.yearSeconds
        : 0;
      const initial = computeInitialValue(total, perSecond, timeContext);
      const counter = getCounter(valueSpan, (value) => USD_COMPACT.format(value));
      counter.update({ value: initial, rate: perSecond, limit: total });
      metrics.appendChild(valueSpan);
      const rateText = document.createElement('small');
      rateText.className = 'drug-rate';
      if (perSecond > 0) {
        rateText.textContent = `≈ ${USD_PER_SECOND.format(perSecond)} per sec`;
      } else {
        rateText.textContent = `${formattedTotal} full-year`;
      }
      metrics.appendChild(rateText);
      li.appendChild(metrics);
      list.appendChild(li);
    });
  }

  function renderMovers(filtered) {
    const list = elements.moversList;
    clearContainer(list);
    if (!filtered.length) {
      renderMutedMessage(list, 'No matching data to compare yet.');
      return;
    }
    const withPrev = filtered
      .filter((row) => row.prev_spend_total_usd != null)
      .map((row) => ({
        row,
        delta: row.spend_total_usd - row.prev_spend_total_usd,
      }))
      .sort((a, b) => (b.delta || 0) - (a.delta || 0));
    const withoutPrev = filtered
      .filter((row) => row.prev_spend_total_usd == null)
      .sort((a, b) => (b.spend_total_usd || 0) - (a.spend_total_usd || 0))
      .map((row) => ({ row, delta: null }));
    const combined = [...withPrev, ...withoutPrev].slice(0, 10);
    if (!combined.length) {
      renderMutedMessage(list, 'No matching data to compare yet.');
      return;
    }
    combined.forEach(({ row, delta }) => {
      const li = document.createElement('li');
      const top = document.createElement('div');
      top.className = 'row-top';
      const name = buildDrugName(row, 'name');
      top.appendChild(name);
      if (delta != null) {
        const deltaBadge = document.createElement('span');
        deltaBadge.className = 'delta-badge';
        const sign = delta >= 0 ? '+' : '−';
        deltaBadge.textContent = `${sign}${USD_FULL.format(Math.abs(delta))}`;
        top.appendChild(deltaBadge);
      }
      li.appendChild(top);
      const bottom = document.createElement('div');
      bottom.className = 'row-bottom';
      bottom.appendChild(makeMetaSpan('Spend', USD_FULL.format(row.spend_total_usd || 0)));
      bottom.appendChild(makeMetaSpan('Claims', formatInt(row.claims)));
      bottom.appendChild(makeMetaSpan('Beneficiaries', formatInt(row.beneficiaries)));
      if (row.prev_spend_total_usd != null && row.prev_year != null) {
        bottom.appendChild(
          makeMetaSpan(
            `Prev ${row.prev_year}`,
            USD_FULL.format(row.prev_spend_total_usd),
          ),
        );
      }
      li.appendChild(bottom);
      list.appendChild(li);
    });
  }

  function renderScatter(filtered) {
    const svg = elements.scatter;
    hideTooltip();
    svg.replaceChildren();
    const width = 640;
    const height = 420;
    const margin = { top: 40, right: 30, bottom: 60, left: 80 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const points = filtered
      .map((row) => ({
        row,
        claims: Number(row.claims) || 0,
        spend: Number(row.spend_total_usd) || 0,
        unitCost: row.claims ? row.spend_total_usd / row.claims : 0,
      }))
      .filter((item) => item.claims > 0 && item.unitCost > 0 && item.spend > 0);

    if (!points.length) {
      const message = createSvg('text', {
        x: width / 2,
        y: height / 2,
        'text-anchor': 'middle',
        fill: 'var(--muted)',
        'font-size': 16,
      });
      message.textContent = 'Not enough claims data to plot yet.';
      svg.appendChild(message);
      return;
    }

    const maxClaims = niceCeil(Math.max(...points.map((p) => p.claims)));
    const maxUnitCost = niceCeil(Math.max(...points.map((p) => p.unitCost)));
    const maxSpend = Math.max(...points.map((p) => p.spend));
    const xScale = (value) => margin.left + (value / maxClaims) * innerWidth;
    const yScale = (value) => margin.top + (1 - value / maxUnitCost) * innerHeight;
    const radiusScale = (spend) => {
      const minRadius = 6;
      const maxRadius = 26;
      if (maxSpend <= 0) {
        return minRadius;
      }
      const ratio = Math.sqrt(spend / maxSpend);
      return minRadius + ratio * (maxRadius - minRadius);
    };

    const axisGroup = createSvg('g');
    svg.appendChild(axisGroup);

    axisGroup.appendChild(createSvg('line', {
      x1: margin.left,
      y1: height - margin.bottom,
      x2: width - margin.right,
      y2: height - margin.bottom,
      stroke: 'currentColor',
      'stroke-opacity': 0.2,
    }));

    axisGroup.appendChild(createSvg('line', {
      x1: margin.left,
      y1: margin.top,
      x2: margin.left,
      y2: height - margin.bottom,
      stroke: 'currentColor',
      'stroke-opacity': 0.2,
    }));

    const xStep = Math.max(1, Math.ceil(niceStep(maxClaims)));
    let xTicks = 0;
    let lastXValue = 0;
    for (let value = 0; value <= maxClaims && xTicks < 8; value += xStep) {
      const x = xScale(value);
      axisGroup.appendChild(createSvg('line', {
        x1: x,
        x2: x,
        y1: height - margin.bottom,
        y2: height - margin.bottom + 8,
        stroke: 'currentColor',
        'stroke-opacity': 0.3,
      }));
      const label = createSvg('text', {
        x,
        y: height - margin.bottom + 24,
        'text-anchor': 'middle',
        fill: 'currentColor',
        'font-size': 12,
      });
      label.textContent = value === 0 ? '0' : INT_COMPACT.format(value);
      axisGroup.appendChild(label);
      xTicks += 1;
      lastXValue = value;
    }
    if (Math.abs(lastXValue - maxClaims) > xStep * 0.25) {
      const x = xScale(maxClaims);
      axisGroup.appendChild(createSvg('line', {
        x1: x,
        x2: x,
        y1: height - margin.bottom,
        y2: height - margin.bottom + 8,
        stroke: 'currentColor',
        'stroke-opacity': 0.3,
      }));
      const label = createSvg('text', {
        x,
        y: height - margin.bottom + 24,
        'text-anchor': 'middle',
        fill: 'currentColor',
        'font-size': 12,
      });
      label.textContent = INT_COMPACT.format(maxClaims);
      axisGroup.appendChild(label);
    }

    const yStep = niceStep(maxUnitCost);
    let yTicks = 0;
    let lastYValue = 0;
    for (let value = 0; value <= maxUnitCost && yTicks < 8; value += yStep) {
      const y = yScale(value);
      axisGroup.appendChild(createSvg('line', {
        x1: margin.left - 8,
        x2: margin.left,
        y1: y,
        y2: y,
        stroke: 'currentColor',
        'stroke-opacity': 0.3,
      }));
      const label = createSvg('text', {
        x: margin.left - 12,
        y: y + 4,
        'text-anchor': 'end',
        fill: 'currentColor',
        'font-size': 12,
      });
      label.textContent = value === 0 ? '0' : USD_COMPACT.format(value);
      axisGroup.appendChild(label);
      yTicks += 1;
      lastYValue = value;
    }
    if (Math.abs(lastYValue - maxUnitCost) > yStep * 0.25) {
      const y = yScale(maxUnitCost);
      axisGroup.appendChild(createSvg('line', {
        x1: margin.left - 8,
        x2: margin.left,
        y1: y,
        y2: y,
        stroke: 'currentColor',
        'stroke-opacity': 0.3,
      }));
      const label = createSvg('text', {
        x: margin.left - 12,
        y: y + 4,
        'text-anchor': 'end',
        fill: 'currentColor',
        'font-size': 12,
      });
      label.textContent = USD_COMPACT.format(maxUnitCost);
      axisGroup.appendChild(label);
    }

    const xLabel = createSvg('text', {
      x: margin.left + innerWidth / 2,
      y: height - 16,
      'text-anchor': 'middle',
      fill: 'currentColor',
      'font-size': 13,
    });
    xLabel.textContent = 'Claims (count)';
    axisGroup.appendChild(xLabel);

    const yLabel = createSvg('text', {
      transform: `rotate(-90 ${margin.left - 50} ${margin.top + innerHeight / 2})`,
      x: margin.left - 50,
      y: margin.top + innerHeight / 2,
      'text-anchor': 'middle',
      fill: 'currentColor',
      'font-size': 13,
    });
    yLabel.textContent = 'Spend per claim (USD)';
    axisGroup.appendChild(yLabel);

    const legend = createSvg('g', {
      transform: `translate(${width - margin.right - 140}, ${margin.top - 20})`,
    });
    const legendItems = [
      { label: 'Part D', color: 'var(--part-d)' },
      { label: 'Part B', color: 'var(--part-b)' },
    ];
    legendItems.forEach((item, index) => {
      const group = createSvg('g', {
        transform: `translate(0, ${index * 20})`,
      });
      const circle = createSvg('circle', {
        cx: 8,
        cy: 8,
        r: 6,
        fill: item.color,
      });
      group.appendChild(circle);
      const label = createSvg('text', {
        x: 18,
        y: 12,
        fill: 'currentColor',
        'font-size': 12,
      });
      label.textContent = item.label;
      group.appendChild(label);
      legend.appendChild(group);
    });
    svg.appendChild(legend);

    const bubblesGroup = createSvg('g');
    svg.appendChild(bubblesGroup);

    points.forEach((point) => {
      const circle = createSvg('circle', {
        cx: xScale(point.claims),
        cy: yScale(point.unitCost),
        r: radiusScale(point.spend),
        fill: point.row.part === 'D' ? 'var(--part-d)' : 'var(--part-b)',
        'fill-opacity': 0.7,
        stroke: 'rgba(0,0,0,0.08)',
      });
      circle.setAttribute('tabindex', '0');
      circle.setAttribute('role', 'graphics-symbol');
      circle.setAttribute(
        'aria-label',
        `${point.row.display_name}: ${USD_FULL.format(point.row.spend_total_usd)} total, ${formatInt(point.row.claims)} claims`,
      );
      bindTooltip(circle, () => (
        `<strong>${escapeHtml(point.row.display_name)}</strong>`
        + `<div>${USD_FULL.format(point.row.spend_total_usd)} total</div>`
        + `<div>${formatInt(point.row.claims)} claims</div>`
        + `<div>${formatInt(point.row.beneficiaries)} beneficiaries</div>`
      ));
      bubblesGroup.appendChild(circle);
    });
  }

  function computeInitialValue(total, rate, timeContext) {
    if (timeContext.yearSeconds <= 0 || !timeContext.isCurrent || rate <= 0) {
      return total;
    }
    return Math.min(total, rate * timeContext.elapsedSeconds);
  }

  function niceCeil(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return 1;
    }
    const exponent = Math.floor(Math.log10(value));
    const factor = 10 ** exponent;
    return Math.ceil(value / factor) * factor;
  }

  function niceStep(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return 1;
    }
    const exponent = Math.floor(Math.log10(value));
    const fraction = value / 10 ** exponent;
    let niceFraction;
    if (fraction <= 1) {
      niceFraction = 0.2;
    } else if (fraction <= 2) {
      niceFraction = 0.5;
    } else if (fraction <= 5) {
      niceFraction = 1;
    } else {
      niceFraction = 2;
    }
    return niceFraction * 10 ** exponent;
  }

  function makeMetaSpan(label, value) {
    const span = document.createElement('span');
    span.textContent = `${label}: ${value}`;
    return span;
  }

  function renderMutedMessage(list, text) {
    const li = document.createElement('li');
    li.textContent = text;
    li.style.color = 'var(--muted)';
    list.appendChild(li);
  }

  function formatInt(value) {
    if (value == null || Number.isNaN(value)) {
      return '—';
    }
    return INT_FULL.format(value);
  }

  function clearContainer(container) {
    const counters = container.querySelectorAll('[data-counter]');
    counters.forEach((el) => releaseCounter(el));
    container.innerHTML = '';
  }

  function buildDrugName(row, className = 'drug-name') {
    const container = document.createElement('div');
    container.className = className;
    container.appendChild(createPartPill(row.part));
    const nameSpan = document.createElement('span');
    nameSpan.textContent = row.display_name;
    container.appendChild(nameSpan);
    if (row.is_glp1) {
      const glpTag = document.createElement('span');
      glpTag.className = 'pill glp1';
      glpTag.textContent = 'GLP-1';
      container.appendChild(glpTag);
    }
    return container;
  }

  function createPartPill(part) {
    const span = document.createElement('span');
    span.className = `pill part-${part === 'D' ? 'd' : 'b'}`;
    span.textContent = part === 'D' ? 'Part D' : 'Part B';
    return span;
  }

  function setAttributes(element, attributes) {
    Object.entries(attributes).forEach(([key, value]) => {
      if (value != null) {
        element.setAttribute(key, String(value));
      }
    });
    return element;
  }

  function createSvg(tag, attributes = {}) {
    return setAttributes(document.createElementNS(svgNS, tag), attributes);
  }

  function bindTooltip(target, renderHtml) {
    const show = (event) => {
      const coords = event
        ? { x: event.clientX + 12, y: event.clientY + 12 }
        : rectCenter(target.getBoundingClientRect());
      showTooltip(renderHtml(), coords);
    };
    target.addEventListener('pointerenter', show);
    target.addEventListener('pointermove', show);
    target.addEventListener('pointerleave', hideTooltip);
    target.addEventListener('focus', () => show());
    target.addEventListener('blur', hideTooltip);
    target.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideTooltip();
      }
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showTooltip(html, coords) {
    if (!tooltipBubble) {
      tooltipBubble = document.createElement('div');
      tooltipBubble.className = 'bubble';
      elements.tooltipLayer.appendChild(tooltipBubble);
    }
    tooltipBubble.innerHTML = html;
    elements.tooltipLayer.hidden = false;
    positionTooltip(coords);
  }

  function positionTooltip(coords) {
    if (!tooltipBubble) return;
    const bubble = tooltipBubble;
    requestAnimationFrame(() => {
      const rect = bubble.getBoundingClientRect();
      let left = coords.x;
      let top = coords.y;
      if (left + rect.width + 16 > window.innerWidth) {
        left = Math.max(12, window.innerWidth - rect.width - 16);
      }
      if (top + rect.height + 16 > window.innerHeight) {
        top = Math.max(12, window.innerHeight - rect.height - 16);
      }
      bubble.style.left = `${left}px`;
      bubble.style.top = `${top}px`;
    });
  }

  function rectCenter(rect) {
    return {
      x: rect.left + rect.width + 12,
      y: rect.top + rect.height / 2,
    };
  }

  function hideTooltip() {
    if (tooltipBubble) {
      tooltipBubble.innerHTML = '';
    }
    elements.tooltipLayer.hidden = true;
  }
})();
