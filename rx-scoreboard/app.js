(() => {
  'use strict';
  const YEAR_MIN = 2018;
  const DATA_PREFIX = 'data/medicare_drugs_';
  const NHE_PATH = 'data/nhe_retail_rx.json';
  const svgNS = 'http://www.w3.org/2000/svg';

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
  };

  const elements = {
    yearSelect: document.getElementById('yearSelect'),
    partToggle: document.getElementById('partToggle'),
    glp1: document.getElementById('glp1Only'),
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
    const discoveredYears = await discoverYears();
    if (discoveredYears.length === 0) {
      showEmptyState(true);
      await loadNhe();
      return;
    }
    state.years = discoveredYears;
    state.year = discoveredYears[0];
    populateYearSelect();
    bindControls();
    await loadNhe();
    update();
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
    select.value = String(state.year);
  }

  function bindControls() {
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

  async function discoverYears() {
    const years = [];
    const currentYear = new Date().getFullYear();
    for (let year = currentYear; year >= YEAR_MIN; year -= 1) {
      const url = `${DATA_PREFIX}${year}.json`;
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        if (Array.isArray(data)) {
          state.dataByYear.set(year, data);
          years.push(year);
        }
      } catch (error) {
        // ignore network errors for discovery
      }
    }
    years.sort((a, b) => b - a);
    return years;
  }

  async function loadNhe() {
    try {
      const response = await fetch(NHE_PATH, { cache: 'no-cache' });
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (payload && typeof payload === 'object') {
        state.nhe = payload;
      }
    } catch (error) {
      // swallow fetch errors so UI can still render
    }
  }

  function update() {
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
      let initial = total;
      if (timeContext.yearSeconds > 0) {
        initial = timeContext.isCurrent
          ? Math.min(total, rate * timeContext.elapsedSeconds)
          : total;
      }
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
      const li = document.createElement('li');
      li.textContent = 'No drugs match the current filters yet.';
      li.style.color = 'var(--muted)';
      list.appendChild(li);
      return;
    }
    const sorted = [...filtered].sort(
      (a, b) => (b.spend_total_usd || 0) - (a.spend_total_usd || 0),
    );
    const topFive = sorted.slice(0, 5);
    topFive.forEach((row) => {
      const li = document.createElement('li');
      const nameWrap = document.createElement('div');
      nameWrap.className = 'drug-name';
      nameWrap.appendChild(createPartPill(row.part));
      const nameSpan = document.createElement('span');
      nameSpan.textContent = row.display_name;
      nameWrap.appendChild(nameSpan);
      if (row.is_glp1) {
        const glpTag = document.createElement('span');
        glpTag.className = 'pill glp1';
        glpTag.textContent = 'GLP-1';
        nameWrap.appendChild(glpTag);
      }
      const metrics = document.createElement('div');
      metrics.className = 'drug-metrics';
      const valueSpan = document.createElement('span');
      valueSpan.className = 'drug-value';
      valueSpan.setAttribute('data-counter', '');
      valueSpan.title = `${USD_FULL.format(row.spend_total_usd)} in ${state.year}`;
      const perSecond = timeContext.yearSeconds > 0 && timeContext.isCurrent
        ? row.spend_total_usd / timeContext.yearSeconds
        : 0;
      let initial = row.spend_total_usd;
      if (timeContext.yearSeconds > 0) {
        initial = timeContext.isCurrent
          ? Math.min(row.spend_total_usd, perSecond * timeContext.elapsedSeconds)
          : row.spend_total_usd;
      }
      const counter = getCounter(valueSpan, (value) => USD_COMPACT.format(value));
      counter.update({ value: initial, rate: perSecond, limit: row.spend_total_usd });
      metrics.appendChild(valueSpan);
      const rateText = document.createElement('small');
      rateText.className = 'drug-rate';
      if (perSecond > 0) {
        rateText.textContent = `≈ ${USD_PER_SECOND.format(perSecond)} per sec`;
      } else {
        rateText.textContent = `${USD_FULL.format(row.spend_total_usd)} full-year`;
      }
      metrics.appendChild(rateText);
      li.appendChild(nameWrap);
      li.appendChild(metrics);
      list.appendChild(li);
    });
  }

  function renderMovers(filtered) {
    const list = elements.moversList;
    clearContainer(list);
    if (!filtered.length) {
      const li = document.createElement('li');
      li.textContent = 'No matching data to compare yet.';
      li.style.color = 'var(--muted)';
      list.appendChild(li);
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
      .sort((a, b) => (b.spend_total_usd || 0) - (a.spend_total_usd || 0));
    const combined = [...withPrev.map((item) => item.row), ...withoutPrev].slice(0, 10);
    combined.forEach((row) => {
      const li = document.createElement('li');
      const top = document.createElement('div');
      top.className = 'row-top';
      const name = document.createElement('div');
      name.className = 'name';
      name.appendChild(createPartPill(row.part));
      const nameText = document.createElement('span');
      nameText.textContent = row.display_name;
      name.appendChild(nameText);
      if (row.is_glp1) {
        const glp = document.createElement('span');
        glp.className = 'pill glp1';
        glp.textContent = 'GLP-1';
        name.appendChild(glp);
      }
      top.appendChild(name);
      const deltaBadge = document.createElement('span');
      const delta = row.prev_spend_total_usd != null
        ? row.spend_total_usd - row.prev_spend_total_usd
        : null;
      if (delta != null) {
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
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }
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
      const message = document.createElementNS(svgNS, 'text');
      message.setAttribute('x', String(width / 2));
      message.setAttribute('y', String(height / 2));
      message.setAttribute('text-anchor', 'middle');
      message.setAttribute('fill', 'var(--muted)');
      message.setAttribute('font-size', '16');
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

    const axisGroup = document.createElementNS(svgNS, 'g');
    svg.appendChild(axisGroup);

    const xAxis = document.createElementNS(svgNS, 'line');
    xAxis.setAttribute('x1', String(margin.left));
    xAxis.setAttribute('y1', String(height - margin.bottom));
    xAxis.setAttribute('x2', String(width - margin.right));
    xAxis.setAttribute('y2', String(height - margin.bottom));
    xAxis.setAttribute('stroke', 'currentColor');
    xAxis.setAttribute('stroke-opacity', '0.2');
    axisGroup.appendChild(xAxis);

    const yAxis = document.createElementNS(svgNS, 'line');
    yAxis.setAttribute('x1', String(margin.left));
    yAxis.setAttribute('y1', String(margin.top));
    yAxis.setAttribute('x2', String(margin.left));
    yAxis.setAttribute('y2', String(height - margin.bottom));
    yAxis.setAttribute('stroke', 'currentColor');
    yAxis.setAttribute('stroke-opacity', '0.2');
    axisGroup.appendChild(yAxis);

    const xStep = Math.max(1, Math.ceil(niceStep(maxClaims)));
    let xTicks = 0;
    let lastXValue = 0;
    for (let value = 0; value <= maxClaims && xTicks < 8; value += xStep) {
      const x = xScale(value);
      const tick = document.createElementNS(svgNS, 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('x2', String(x));
      tick.setAttribute('y1', String(height - margin.bottom));
      tick.setAttribute('y2', String(height - margin.bottom + 8));
      tick.setAttribute('stroke', 'currentColor');
      tick.setAttribute('stroke-opacity', '0.3');
      axisGroup.appendChild(tick);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(height - margin.bottom + 24));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', 'currentColor');
      label.setAttribute('font-size', '12');
      label.textContent = value === 0 ? '0' : INT_COMPACT.format(value);
      axisGroup.appendChild(label);
      xTicks += 1;
      lastXValue = value;
    }
    if (Math.abs(lastXValue - maxClaims) > xStep * 0.25) {
      const x = xScale(maxClaims);
      const tick = document.createElementNS(svgNS, 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('x2', String(x));
      tick.setAttribute('y1', String(height - margin.bottom));
      tick.setAttribute('y2', String(height - margin.bottom + 8));
      tick.setAttribute('stroke', 'currentColor');
      tick.setAttribute('stroke-opacity', '0.3');
      axisGroup.appendChild(tick);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(height - margin.bottom + 24));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', 'currentColor');
      label.setAttribute('font-size', '12');
      label.textContent = INT_COMPACT.format(maxClaims);
      axisGroup.appendChild(label);
    }

    const yStep = niceStep(maxUnitCost);
    let yTicks = 0;
    let lastYValue = 0;
    for (let value = 0; value <= maxUnitCost && yTicks < 8; value += yStep) {
      const y = yScale(value);
      const tick = document.createElementNS(svgNS, 'line');
      tick.setAttribute('x1', String(margin.left - 8));
      tick.setAttribute('x2', String(margin.left));
      tick.setAttribute('y1', String(y));
      tick.setAttribute('y2', String(y));
      tick.setAttribute('stroke', 'currentColor');
      tick.setAttribute('stroke-opacity', '0.3');
      axisGroup.appendChild(tick);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(margin.left - 12));
      label.setAttribute('y', String(y + 4));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('fill', 'currentColor');
      label.setAttribute('font-size', '12');
      label.textContent = value === 0 ? '0' : USD_COMPACT.format(value);
      axisGroup.appendChild(label);
      yTicks += 1;
      lastYValue = value;
    }
    if (Math.abs(lastYValue - maxUnitCost) > yStep * 0.25) {
      const y = yScale(maxUnitCost);
      const tick = document.createElementNS(svgNS, 'line');
      tick.setAttribute('x1', String(margin.left - 8));
      tick.setAttribute('x2', String(margin.left));
      tick.setAttribute('y1', String(y));
      tick.setAttribute('y2', String(y));
      tick.setAttribute('stroke', 'currentColor');
      tick.setAttribute('stroke-opacity', '0.3');
      axisGroup.appendChild(tick);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(margin.left - 12));
      label.setAttribute('y', String(y + 4));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('fill', 'currentColor');
      label.setAttribute('font-size', '12');
      label.textContent = USD_COMPACT.format(maxUnitCost);
      axisGroup.appendChild(label);
    }

    const xLabel = document.createElementNS(svgNS, 'text');
    xLabel.setAttribute('x', String(margin.left + innerWidth / 2));
    xLabel.setAttribute('y', String(height - 16));
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('fill', 'currentColor');
    xLabel.setAttribute('font-size', '13');
    xLabel.textContent = 'Claims (count)';
    axisGroup.appendChild(xLabel);

    const yLabel = document.createElementNS(svgNS, 'text');
    yLabel.setAttribute('transform', `rotate(-90 ${margin.left - 50} ${margin.top + innerHeight / 2})`);
    yLabel.setAttribute('x', String(margin.left - 50));
    yLabel.setAttribute('y', String(margin.top + innerHeight / 2));
    yLabel.setAttribute('text-anchor', 'middle');
    yLabel.setAttribute('fill', 'currentColor');
    yLabel.setAttribute('font-size', '13');
    yLabel.textContent = 'Spend per claim (USD)';
    axisGroup.appendChild(yLabel);

    const legend = document.createElementNS(svgNS, 'g');
    legend.setAttribute('transform', `translate(${width - margin.right - 140}, ${margin.top - 20})`);
    const legendItems = [
      { label: 'Part D', color: 'var(--part-d)' },
      { label: 'Part B', color: 'var(--part-b)' },
    ];
    legendItems.forEach((item, index) => {
      const group = document.createElementNS(svgNS, 'g');
      group.setAttribute('transform', `translate(0, ${index * 20})`);
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', '8');
      circle.setAttribute('cy', '8');
      circle.setAttribute('r', '6');
      circle.setAttribute('fill', item.color);
      group.appendChild(circle);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', '18');
      label.setAttribute('y', '12');
      label.setAttribute('fill', 'currentColor');
      label.setAttribute('font-size', '12');
      label.textContent = item.label;
      group.appendChild(label);
      legend.appendChild(group);
    });
    svg.appendChild(legend);

    const bubblesGroup = document.createElementNS(svgNS, 'g');
    svg.appendChild(bubblesGroup);

    points.forEach((point) => {
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', String(xScale(point.claims)));
      circle.setAttribute('cy', String(yScale(point.unitCost)));
      circle.setAttribute('r', String(radiusScale(point.spend)));
      circle.setAttribute('fill', point.row.part === 'D' ? 'var(--part-d)' : 'var(--part-b)');
      circle.setAttribute('fill-opacity', '0.7');
      circle.setAttribute('stroke', 'rgba(0,0,0,0.08)');
      circle.setAttribute('tabindex', '0');
      circle.setAttribute('role', 'graphics-symbol');
      circle.setAttribute('aria-label', `${point.row.display_name}: ${USD_FULL.format(point.row.spend_total_usd)} total, ${formatInt(point.row.claims)} claims`);
      const show = (event) => {
        const coords = event
          ? { x: event.clientX + 12, y: event.clientY + 12 }
          : rectCenter(circle.getBoundingClientRect());
        showTooltip(
          `<strong>${escapeHtml(point.row.display_name)}</strong>`
            + `<div>${USD_FULL.format(point.row.spend_total_usd)} total</div>`
            + `<div>${formatInt(point.row.claims)} claims</div>`
            + `<div>${formatInt(point.row.beneficiaries)} beneficiaries</div>`,
          coords,
        );
      };
      circle.addEventListener('pointerenter', show);
      circle.addEventListener('pointermove', show);
      circle.addEventListener('pointerleave', hideTooltip);
      circle.addEventListener('focus', () => show());
      circle.addEventListener('blur', hideTooltip);
      circle.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          hideTooltip();
        }
      });
      bubblesGroup.appendChild(circle);
    });
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

  function createPartPill(part) {
    const span = document.createElement('span');
    span.className = `pill part-${part === 'D' ? 'd' : 'b'}`;
    span.textContent = part === 'D' ? 'Part D' : 'Part B';
    return span;
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
