// The reference's interaction is rebuilt here: aligned image layers revealed by
// a grid brush. No reference JavaScript, external animation runtime, or map API.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = src;
});
const layers = Promise.all([loadImage('/images/vault-mesh.webp'), loadImage('/images/vault-xray.webp')]);
let paused = reducedMotion.matches;
const scannerUpdates: Array<() => void> = [];

function initialiseScanner(section: HTMLElement) {
  const canvas = section.querySelector<HTMLCanvasElement>('canvas')!;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  section.tabIndex = 0;
  section.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
  section.setAttribute('aria-description', 'Move the pointer or touch to reveal image layers. When focused, use the arrow keys to move the scanner.');
  let width = 0, height = 0, cellSize = 60, frame = 0, visible = false;
  let pointer = { x: 0, y: 0 }, lastCell = '';
  let prepared: HTMLCanvasElement[] = [];
  let sourceImages: HTMLImageElement[] = [];
  let demoShown = false;
  type Cell = { x: number; y: number; layer: number; frameOnly: boolean; born: number; touched: number };
  const cells = new Map<string, Cell>();
  const hash = (x: number, y: number) => Math.abs(Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1;

  function prepareLayers() {
    prepared = sourceImages.map(image => {
      const buffer = document.createElement('canvas');
      buffer.width = Math.ceil(width); buffer.height = Math.ceil(height);
      const context = buffer.getContext('2d')!;
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      context.drawImage(image, (width - image.naturalWidth * scale) / 2, (height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
      return buffer;
    });
    if (!prepared[1]) return;
    // False-colour intensity layer, derived from the aligned X-ray image.
    const thermal = document.createElement('canvas');
    thermal.width = Math.ceil(width); thermal.height = Math.ceil(height);
    const thermalContext = thermal.getContext('2d')!;
    thermalContext.drawImage(prepared[1], 0, 0);
    const pixels = thermalContext.getImageData(0, 0, thermal.width, thermal.height);
    const palette = [[13,22,84],[27,105,210],[20,208,208],[149,233,93],[254,208,45],[244,64,31]];
    for (let index = 0; index < pixels.data.length; index += 4) {
      const intensity = (pixels.data[index] * .3 + pixels.data[index + 1] * .59 + pixels.data[index + 2] * .11) / 255;
      const position = Math.min(4.999, intensity * 5);
      const low = Math.floor(position), blend = position - low;
      for (let channel = 0; channel < 3; channel++) pixels.data[index + channel] = palette[low][channel] * (1 - blend) + palette[low + 1][channel] * blend;
    }
    thermalContext.putImageData(pixels, 0, 0);
    prepared.push(thermal);
  }
  function resize() {
    const rect = section.getBoundingClientRect();
    width = rect.width; height = rect.height;
    cellSize = width < 700 ? 42 : 60;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    pointer = { x: width * .64, y: height * .39 };
    cells.clear(); lastCell = '';
    prepareLayers();
  }
  function brush(x: number, y: number, force = false) {
    if (paused || !visible || !prepared.length) return;
    const col = Math.floor(x / cellSize), row = Math.floor(y / cellSize);
    const key = col + ':' + row;
    if (lastCell === key && !force) return;
    lastCell = key; pointer = { x, y };
    const now = performance.now();
    const layer = hash(col, row) < .62 ? 0 : hash(col, row) < .8 ? 1 : 2;
    // Two-by-two image patch, satellite pixels, and unfilled measurement boxes.
    const offsets = [[0,0],[1,0],[0,1],[1,1],[-1,0],[1,-1],[2,1],[0,2],[-1,1],[2,0]];
    offsets.forEach(([dx,dy], index) => {
      const cx = col + dx, cy = row + dy;
      if (cx < 0 || cy < 0 || cx * cellSize >= width || cy * cellSize >= height) return;
      const id = cx + ':' + cy, old = cells.get(id);
      cells.set(id, { x:cx * cellSize, y:cy * cellSize, layer:index < 4 ? layer : (layer + index) % 3, frameOnly:index > 5, born:old?.born ?? now, touched:now });
    });
    // A hard bound avoids retaining an unbounded pointer history.
    while (cells.size > 90) cells.delete(cells.keys().next().value!);
    start();
  }
  function diamond(x: number, y: number, radius: number) {
    ctx!.beginPath(); ctx!.moveTo(x, y - radius); ctx!.lineTo(x + radius, y);
    ctx!.lineTo(x, y + radius); ctx!.lineTo(x - radius, y); ctx!.closePath(); ctx!.fill();
  }
  function draw(now: number) {
    frame = 0;
    ctx!.clearRect(0, 0, width, height);
    if (!visible || paused || document.hidden) return;
    for (const [key, cell] of cells) {
      const age = now - cell.touched;
      if (age > 1250) { cells.delete(key); continue; }
      const alpha = Math.min(1, (now - cell.born) / 160) * Math.max(0, 1 - Math.max(0, age - 320) / 930);
      ctx!.globalAlpha = alpha;
      if (!cell.frameOnly) {
        const w = Math.min(cellSize, width - cell.x), h = Math.min(cellSize, height - cell.y);
        ctx!.drawImage(prepared[cell.layer], cell.x, cell.y, w, h, cell.x, cell.y, w, h);
      } else {
        ctx!.fillStyle = '#ffffff07'; ctx!.fillRect(cell.x, cell.y, cellSize, cellSize);
      }
      ctx!.strokeStyle = cell.frameOnly ? '#ffffff40' : '#ffffff80';
      ctx!.lineWidth = .65; ctx!.strokeRect(cell.x + .5, cell.y + .5, cellSize - 1, cellSize - 1);
      ctx!.fillStyle = '#f9f9f5';
      for (const [dx, dy] of [[0,0],[1,0],[0,1],[1,1]]) diamond(cell.x + dx * cellSize, cell.y + dy * cellSize, 2.6);
    }
    // Connected corner points track the same grid as the photographic reveal.
    if (cells.size) {
      const cx = Math.floor(pointer.x / cellSize) * cellSize, cy = Math.floor(pointer.y / cellSize) * cellSize;
      const recent = Math.max(...Array.from(cells.values(), cell => cell.touched));
      ctx!.globalAlpha = Math.max(0, 1 - (now - recent) / 1250) * .65;
      ctx!.strokeStyle = '#d8e6ff'; ctx!.lineWidth = .7;
      ctx!.beginPath(); ctx!.moveTo(cx - cellSize, cy); ctx!.lineTo(cx, cy + cellSize);
      ctx!.lineTo(cx + cellSize * 2, cy); ctx!.lineTo(cx + cellSize * 2, cy + cellSize * 2); ctx!.stroke();
      ctx!.save(); ctx!.translate(pointer.x, pointer.y); ctx!.rotate(Math.PI / 4);
      ctx!.strokeStyle='#ffffff'; ctx!.strokeRect(-8,-8,16,16);ctx!.strokeRect(-12,-12,24,24); ctx!.restore();
    }
    ctx!.globalAlpha = 1;
    if (cells.size) start();
  }
  function start() { if (!frame && visible && !paused && !document.hidden) frame = requestAnimationFrame(draw); }
  function clear() { cancelAnimationFrame(frame); frame = 0; cells.clear(); lastCell = ''; ctx!.clearRect(0, 0, width, height); }
  scannerUpdates.push(() => { clear(); if (!paused) brush(width * .64, height * .39, true); });
  section.addEventListener('pointermove', event => {
    if ((event.target as Element).closest('a,button')) return;
    const rect = section.getBoundingClientRect();
    brush(event.clientX - rect.left, event.clientY - rect.top);
  }, {passive:true});
  section.addEventListener('pointerdown', event => {
    if ((event.target as Element).closest('a,button')) return;
    const rect = section.getBoundingClientRect();
    brush(event.clientX - rect.left, event.clientY - rect.top, true);
  }, {passive:true});
  section.addEventListener('pointerleave', () => { lastCell = ''; });
  section.addEventListener('keydown', event => {
    if (event.target !== section || !event.key.startsWith('Arrow')) return;
    event.preventDefault();
    const dx = event.key === 'ArrowRight' ? cellSize : event.key === 'ArrowLeft' ? -cellSize : 0;
    const dy = event.key === 'ArrowDown' ? cellSize : event.key === 'ArrowUp' ? -cellSize : 0;
    brush(Math.max(0, Math.min(width - cellSize * 2, pointer.x + dx)), Math.max(0, Math.min(height - cellSize * 2, pointer.y + dy)), true);
  });
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible) clear();
    else if (prepared.length && !demoShown) { demoShown = true; brush(width * .64, height * .39, true); }
  }, {threshold:.12});
  observer.observe(section);
  new ResizeObserver(resize).observe(section);
  layers.then(images => {
    sourceImages = images; resize();
    if (visible && !demoShown) { demoShown = true; brush(width * .64, height * .39, true); }
    section.dataset.scanReady = 'true';
  }).catch(() => {
    section.dataset.scanReady = 'false';
    const button = section.querySelector<HTMLButtonElement>('.scan-toggle');
    if (button) { button.disabled = true; button.querySelector('span')!.textContent = 'Image view'; }
  });
}
document.querySelectorAll<HTMLElement>('[data-scanner]').forEach(initialiseScanner);
const pauseButton = document.querySelector<HTMLButtonElement>('.scan-toggle')!;
function syncPauseButton() {
  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.querySelector('span')!.textContent = paused ? 'Enable scan' : 'Pause scan';
}
pauseButton.addEventListener('click', () => { paused = !paused; syncPauseButton(); scannerUpdates.forEach(update => update()); });
reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; syncPauseButton(); scannerUpdates.forEach(update => update()); });
document.addEventListener('visibilitychange', () => { if (document.hidden) scannerUpdates.forEach(update => update()); });
syncPauseButton();

const navigation = document.querySelector('.navigation')!;
const menu = document.querySelector<HTMLButtonElement>('.menu-toggle')!;
function closeMenu() { navigation.classList.remove('menu-open'); menu.setAttribute('aria-expanded','false'); }
menu.addEventListener('click', () => { const open = navigation.classList.toggle('menu-open'); menu.setAttribute('aria-expanded',String(open)); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && navigation.classList.contains('menu-open')) { closeMenu(); menu.focus(); } });
document.querySelectorAll('.nav-links a').forEach(link => link.addEventListener('click', closeMenu));
const navObserver = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    document.querySelectorAll<HTMLAnchorElement>('.nav-links a').forEach(link => {
      const current = link.hash === '#' + entry.target.id;
      link.classList.toggle('active', current);
      if (current) link.setAttribute('aria-current','location'); else link.removeAttribute('aria-current');
    });
  }
}, {rootMargin:'-20% 0px -50% 0px'});
['home','about','platform','assets'].forEach(id => navObserver.observe(document.getElementById(id)!));

document.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach(pin => pin.addEventListener('click', () => {
  const expanded = pin.getAttribute('aria-expanded') === 'true';
  document.querySelectorAll('[data-stage]').forEach(other => other.setAttribute('aria-expanded','false'));
  pin.setAttribute('aria-expanded',String(!expanded));
}));
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'));
function activateTab(selected: HTMLButtonElement) {
  tabs.forEach(tab => {
    const active = tab === selected; tab.setAttribute('aria-selected',String(active)); tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')!)!.hidden = !active;
  });
}
tabs.forEach((tab,index) => {
  tab.addEventListener('click',()=>activateTab(tab));
  tab.addEventListener('keydown',event => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index+1)%tabs.length;
    else if (event.key === 'ArrowLeft') next = (index+tabs.length-1)%tabs.length;
    else if (event.key === 'Home') next=0;
    else if (event.key === 'End') next=tabs.length-1;
    else return;
    event.preventDefault(); activateTab(tabs[next]); tabs[next].focus();
  });
});
let step = 0;
const descriptions = [
  'Start with lender-defined repo terms published on Creditcoin.',
  'The borrower escrows the asset on its own chain and the registry emits one event.',
  'Attestors cover the block; a proof binds that event to an attested source chain.',
  'The desk verified the proof itself, so principal is now drawable on Creditcoin.',
];
const actions = ['Pledge collateral','Wait for attestation','Draw principal','Start again'];
function updateDemo() {
  document.querySelectorAll<HTMLElement>('[data-demo-step]').forEach((row,index) => {
    row.classList.toggle('current',index===step);row.classList.toggle('done',index<step);
    row.querySelector('.step-state')!.textContent = index<step ? 'Complete' : index===step ? 'Ready' : 'Upcoming';
  });
  document.getElementById('demo-description')!.textContent = descriptions[step];
  document.querySelector('#demo-advance span')!.textContent = actions[step];
}
document.getElementById('demo-advance')!.addEventListener('click',()=>{step=(step+1)%4;updateDemo();});
document.getElementById('demo-reset')!.addEventListener('click',()=>{step=0;updateDemo();});
