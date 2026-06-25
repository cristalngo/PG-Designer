const state = {
  products: [],
  orders: [],
  thuChiRows: [],
  image: null,
  selectedProduct: null,
  selectedOrder: null,
  suggestions: [],
  placement: 'top',
  lastBlob: null
};

const el = Object.fromEntries([
  'previewCanvas', 'emptyState', 'photoInput', 'renderBtn', 'shareBtn', 'clearBtn',
  'requestInput', 'searchInput', 'searchBtn', 'selectedRef', 'results', 'syncInput',
  'dbStatus', 'suggestions', 'rebuildBtn', 'customInput', 'addCustomBtn'
].map(id => [id, document.getElementById(id)]));

const ctx = el.previewCanvas.getContext('2d');

function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function money(value) {
  const n = Number(value || 0);
  return n ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(n) : '0';
}

function productName(product) {
  return product?.description || product?.product || '';
}

function stoneLine(product) {
  return [product?.stone, product?.stone_size || product?.stoneSize].filter(Boolean).join(' ');
}

function materialOf(product) {
  const text = norm([product?.material, productName(product), product?.gold_age].join(' '));
  const age = Number(product?.gold_age || product?.goldAge || 0);
  if (text.includes('bac') || text.includes('silver')) return 'Bạc';
  if (text.includes('18k') || age === 85) return 'Vàng 18K';
  if (text.includes('14k') || age === 68.5) return 'Vàng 14K';
  if (text.includes('10k') || age === 52) return 'Vàng 10K';
  if (text.includes('vang') || age > 0) return 'Vàng 10K';
  return product?.material || '';
}

function firstWeight(raw) {
  const match = String(raw || '').match(/\d+(?:[,.]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : 0;
}

function scoreProduct(product, query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return -1;
  const hay = norm([
    productName(product), product?.material, product?.stone, product?.stone_size,
    product?.searchKey, product?.productId
  ].join(' '));
  let score = 0;
  for (const token of tokens) {
    if (!hay.includes(token)) return -1;
    score += 5;
  }
  if (hay.includes(tokens.join(' '))) score += 20;
  return score;
}

function searchProducts(query) {
  return state.products
    .map((product, index) => ({ product, index, score: scoreProduct(product, query) }))
    .filter(row => row.score >= 0)
    .sort((a, b) => b.score - a.score || productName(a.product).localeCompare(productName(b.product), 'vi'))
    .slice(0, 24);
}

function searchOrders(query) {
  const q = norm(query);
  if (!q) return state.orders.slice(0, 8).map((order, index) => ({ order, index }));
  return state.orders
    .map((order, index) => ({ order, index }))
    .filter(({ order }) => norm([order.customer, order.product, order.material, order.ringSize, order.stone, order.notes].join(' ')).includes(q))
    .slice(0, 12);
}

async function loadDatabase() {
  try {
    const local = localStorage.getItem('pgDesignerSyncPackageV1');
    if (local) {
      applyPackage(JSON.parse(local), 'Local import');
      return;
    }
    const response = await fetch('./ProductDatabase.json', { cache: 'no-store' });
    const products = await response.json();
    state.products = Array.isArray(products) ? products : products.products || [];
    el.dbStatus.textContent = `${state.products.length} sản phẩm`;
  } catch (error) {
    el.dbStatus.textContent = 'Chưa tải được DB';
  }
}

function applyPackage(data, label = 'Import') {
  if (Array.isArray(data)) {
    state.products = data;
    state.orders = [];
    state.thuChiRows = [];
  } else {
    state.products = data.products || [];
    state.orders = data.orders || [];
    state.thuChiRows = data.thuChiRows || data.thu_chi_rows || [];
  }
  el.dbStatus.textContent = `${label}: ${state.products.length} sản phẩm, ${state.orders.length} orders`;
}

function renderEmptyCanvas() {
  ctx.fillStyle = '#e6e1da';
  ctx.fillRect(0, 0, el.previewCanvas.width, el.previewCanvas.height);
}

function drawBase() {
  const canvas = el.previewCanvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.image) {
    renderEmptyCanvas();
    el.emptyState.hidden = false;
    return;
  }
  el.emptyState.hidden = true;
  const img = state.image;
  const ratio = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
  const w = img.naturalWidth * ratio;
  const h = img.naturalHeight * ratio;
  const x = (canvas.width - w) / 2;
  const y = (canvas.height - h) / 2;
  ctx.fillStyle = '#e6e1da';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, x, y, w, h);
}

function wrapLines(text, maxWidth, font) {
  ctx.font = font;
  const lines = [];
  for (const sourceLine of text.split('\n')) {
    const words = sourceLine.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function selectedSuggestionText() {
  return state.suggestions.filter(s => s.checked).map(s => s.text).join('\n');
}

function renderAnnotated() {
  drawBase();
  const text = selectedSuggestionText();
  if (!text) return;

  const canvas = el.previewCanvas;
  const fontSize = Math.max(34, Math.round(canvas.width * 0.052));
  const font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const maxWidth = canvas.width * 0.78;
  const lines = wrapLines(text, maxWidth, font);
  const lineHeight = fontSize * 1.18;
  const padX = canvas.width * 0.034;
  const padY = canvas.width * 0.025;
  const textWidth = Math.min(maxWidth, Math.max(...lines.map(line => ctx.measureText(line).width), 120));
  const boxW = textWidth + padX * 2;
  const boxH = lines.length * lineHeight + padY * 2;
  const x = (canvas.width - boxW) / 2;
  let y = canvas.height * 0.09;
  if (state.placement === 'center') y = (canvas.height - boxH) / 2;
  if (state.placement === 'bottom') y = canvas.height - boxH - canvas.height * 0.09;

  roundedRect(x, y, boxW, boxH, canvas.width * 0.02);
  ctx.fillStyle = 'rgba(229, 27, 45, .95)';
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, y + padY + index * lineHeight);
  });
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function addSuggestion(text, source, checked = true) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (state.suggestions.some(item => norm(item.text) === norm(clean))) return;
  state.suggestions.push({ id: crypto.randomUUID(), text: clean, source, checked });
}

function parseRingSize(text) {
  const match = String(text || '').match(/(?:tay|size)\s*(\d+(?:[,.]\d+)?)/i);
  return match ? match[1].replace(',', '.') : '';
}

function parseMaterial(text) {
  const n = norm(text);
  if (n.includes('10k')) return n.includes('vang vang') ? 'Vàng vàng 10K' : 'Vàng 10K';
  if (n.includes('14k')) return n.includes('vang vang') ? 'Vàng vàng 14K' : 'Vàng 14K';
  if (n.includes('18k')) return n.includes('vang vang') ? 'Vàng vàng 18K' : 'Vàng 18K';
  if (n.includes('bac')) return 'Bạc';
  return '';
}

function similarAverageWeight() {
  const seed = norm([
    el.requestInput.value,
    productName(state.selectedProduct),
    state.selectedOrder?.product
  ].join(' '));
  const tokens = seed.split(/\s+/).filter(token => token.length >= 3);
  if (!tokens.length) return '';
  const weights = state.thuChiRows
    .filter(row => tokens.some(token => norm(row.description).includes(token)))
    .map(row => firstWeight(row.gold_weight_raw || row.goldWeightRaw))
    .filter(Boolean);
  if (!weights.length) return '';
  const avg = weights.reduce((sum, value) => sum + value, 0) / weights.length;
  return String(Math.round(avg * 10) / 10);
}

function rebuildSuggestions() {
  const request = el.requestInput.value.trim();
  state.suggestions = [];
  addSuggestion(request, 'Yêu cầu khách');
  const ringSize = parseRingSize(request);
  if (ringSize && !state.selectedOrder?.ringSize) addSuggestion(`Tay ${ringSize}`, 'Tự nhận từ yêu cầu');
  const material = parseMaterial(request);
  if (material && !state.selectedProduct && !state.selectedOrder) addSuggestion(material, 'Tự nhận từ yêu cầu');

  const order = state.selectedOrder;
  if (order) {
    addSuggestion(order.product, `Order ${order.orderId || ''}`);
    addSuggestion(order.material, 'Chất liệu từ order');
    if (order.ringSize) addSuggestion(`Tay ${order.ringSize}`, 'Size từ order');
    addSuggestion([order.stone, order.stoneSize || order.stone_size].filter(Boolean).join(' '), 'Đá từ order');
    addSuggestion(order.notes, 'Ghi chú order');
  }

  const product = state.selectedProduct;
  if (product) {
    addSuggestion(productName(product), 'Tên từ Product DB');
    addSuggestion(materialOf(product), 'Chất liệu từ Product DB');
    if (product.gold_weight_raw) addSuggestion(`TL vàng tham khảo ${product.gold_weight_raw}`, 'Trọng lượng từ Product DB');
    addSuggestion(stoneLine(product), 'Đá từ Product DB');
  }

  const avg = similarAverageWeight();
  if (avg && !product?.gold_weight_raw) addSuggestion(`TL vàng tham khảo ${avg}`, 'Trung bình đơn cũ');
  addSuggestion('Thân nhẫn mảnh khoảng 1.4mm', 'Chuẩn Petite Gem');
  addSuggestion('Làm thanh mảnh, sạch chấu, đúng tinh thần mẫu', 'Chuẩn Petite Gem');
  renderSuggestions();
}

function renderSuggestions() {
  el.suggestions.innerHTML = state.suggestions.map(item => `
    <label class="suggestion">
      <input type="checkbox" data-id="${item.id}" ${item.checked ? 'checked' : ''}>
      <span><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.source)}</span></span>
    </label>
  `).join('');
  el.suggestions.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      const item = state.suggestions.find(s => s.id === input.dataset.id);
      if (item) item.checked = input.checked;
    });
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderResults() {
  const query = el.searchInput.value.trim();
  const productRows = searchProducts(query);
  const orderRows = searchOrders(query);
  const html = [
    ...orderRows.map(({ order, index }) => `
      <button class="result" type="button" data-kind="order" data-index="${index}">
        <span><strong>${escapeHtml(order.product || 'Order chưa tên')}</strong><small>${escapeHtml([order.customer, order.material, order.ringSize ? `tay ${order.ringSize}` : '', order.stone].filter(Boolean).join(' · '))}</small></span>
        <span>Order</span>
      </button>`),
    ...productRows.map(({ product, index }) => `
      <button class="result" type="button" data-kind="product" data-index="${index}">
        <span><strong>${escapeHtml(productName(product))}</strong><small>${escapeHtml([materialOf(product), product.gold_weight_raw ? `TL ${product.gold_weight_raw}` : '', stoneLine(product), product.productId].filter(Boolean).join(' · '))}</small></span>
        <span>DB</span>
      </button>`)
  ].join('');
  el.results.innerHTML = html;
  el.results.querySelectorAll('.result').forEach(button => {
    button.addEventListener('click', () => selectReference(button.dataset.kind, Number(button.dataset.index)));
  });
}

function selectReference(kind, index) {
  if (kind === 'product') {
    state.selectedProduct = state.products[index];
    state.selectedOrder = null;
    el.selectedRef.hidden = false;
    el.selectedRef.textContent = `DB: ${productName(state.selectedProduct)} · ${materialOf(state.selectedProduct)} · TL ${state.selectedProduct.gold_weight_raw || '-'}`;
  } else {
    state.selectedOrder = state.orders[index];
    state.selectedProduct = null;
    el.selectedRef.hidden = false;
    el.selectedRef.textContent = `Order: ${state.selectedOrder.product} · ${state.selectedOrder.material || ''} · ${state.selectedOrder.ringSize ? `tay ${state.selectedOrder.ringSize}` : ''}`;
  }
  rebuildSuggestions();
}

async function loadPhoto(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  state.image = img;
  el.previewCanvas.width = img.naturalWidth;
  el.previewCanvas.height = img.naturalHeight;
  drawBase();
  URL.revokeObjectURL(url);
  state.lastBlob = null;
  el.shareBtn.disabled = true;
}

async function canvasBlob() {
  return await new Promise(resolve => el.previewCanvas.toBlob(resolve, 'image/png', .95));
}

async function renderAndPrepareShare() {
  renderAnnotated();
  state.lastBlob = await canvasBlob();
  el.shareBtn.disabled = !state.lastBlob;
}

async function shareImage() {
  if (!state.lastBlob) await renderAndPrepareShare();
  if (!state.lastBlob) return;
  const file = new File([state.lastBlob], `PG-Designer-${Date.now()}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: 'PG Designer' });
    return;
  }
  const url = URL.createObjectURL(state.lastBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearAll() {
  el.requestInput.value = '';
  el.searchInput.value = '';
  el.customInput.value = '';
  el.results.innerHTML = '';
  el.selectedRef.hidden = true;
  state.selectedProduct = null;
  state.selectedOrder = null;
  state.suggestions = [];
  renderSuggestions();
  drawBase();
  state.lastBlob = null;
  el.shareBtn.disabled = true;
}

document.querySelectorAll('.segmented button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    state.placement = button.dataset.placement;
  });
});

el.photoInput.addEventListener('change', () => loadPhoto(el.photoInput.files[0]));
el.renderBtn.addEventListener('click', renderAndPrepareShare);
el.shareBtn.addEventListener('click', shareImage);
el.clearBtn.addEventListener('click', clearAll);
el.searchBtn.addEventListener('click', renderResults);
el.searchInput.addEventListener('input', () => {
  clearTimeout(el.searchInput._timer);
  el.searchInput._timer = setTimeout(renderResults, 160);
});
el.requestInput.addEventListener('input', () => {
  clearTimeout(el.requestInput._timer);
  el.requestInput._timer = setTimeout(rebuildSuggestions, 160);
});
el.rebuildBtn.addEventListener('click', rebuildSuggestions);
el.addCustomBtn.addEventListener('click', () => {
  addSuggestion(el.customInput.value, 'Thêm tay');
  el.customInput.value = '';
  renderSuggestions();
});
el.syncInput.addEventListener('change', async () => {
  const file = el.syncInput.files[0];
  if (!file) return;
  const data = JSON.parse(await file.text());
  applyPackage(data);
  localStorage.setItem('pgDesignerSyncPackageV1', JSON.stringify(data));
  renderResults();
  rebuildSuggestions();
});

renderEmptyCanvas();
loadDatabase().then(rebuildSuggestions);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
}
