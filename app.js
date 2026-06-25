const state = {
  products: [],
  orders: [],
  thuChiRows: [],
  image: null,
  photoFingerprint: null,
  redLabelRects: [],
  ocrText: '',
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
const OFFLINE_OCR_NOTICE = 'Không đọc được chữ tự động, có thể nhập yêu cầu bên dưới.';

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

function imageUrlOf(product) {
  const url = product?.image_url || product?.imageURL || product?.image || '';
  return /^https?:\/\//i.test(url) || /^data:/i.test(url) || /^blob:/i.test(url) ? url : '';
}

function scoreProduct(product, query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return -1;
  const hay = norm([
    productName(product), product?.material, product?.stone, product?.stone_size, product?.image_alt,
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

function selectedSuggestions(zone) {
  return state.suggestions.filter(s => s.checked && (s.zone || 'top') === zone).map(s => s.text);
}

function renderAnnotated() {
  drawBase();
  eraseOldLabels();
  const topRect = state.redLabelRects.find(rect => rect.zone === 'top');
  const bottomRect = state.redLabelRects.find(rect => rect.zone === 'bottom');
  drawLabel(selectedSuggestions('top'), state.placement, topRect);
  drawLabel(selectedSuggestions('bottom'), 'bottom', bottomRect);
}

function drawLabel(sourceLines, placement, detectedRect = null) {
  const text = sourceLines.filter(Boolean).join('\n');
  if (!text) return;
  const canvas = el.previewCanvas;
  const isBottom = placement === 'bottom';
  let labelRect;
  if (detectedRect) {
    labelRect = expandRect(detectedRect, canvas.width * 0.012, canvas.width, canvas.height);
  }
  let fontSize = Math.max(isBottom ? 30 : 28, Math.round(canvas.width * (isBottom ? 0.044 : 0.044)));
  const padX = canvas.width * 0.034;
  const padY = canvas.width * 0.025;
  let font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  let maxWidth = labelRect ? Math.max(120, labelRect.width - padX * 2) : canvas.width * (isBottom ? 0.74 : 0.78);
  let lines = wrapLines(text, maxWidth, font);
  let lineHeight = fontSize * 1.12;

  if (labelRect) {
    while ((lines.length * lineHeight + padY * 2 > labelRect.height || Math.max(...lines.map(line => ctx.measureText(line).width), 0) > maxWidth) && fontSize > 22) {
      fontSize -= 2;
      font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      lineHeight = fontSize * 1.12;
      lines = wrapLines(text, maxWidth, font);
    }
  } else {
    const textWidth = Math.min(maxWidth, Math.max(...lines.map(line => ctx.measureText(line).width), 120));
    const boxW = textWidth + padX * 2;
    const boxH = lines.length * lineHeight + padY * 2;
    const x = (canvas.width - boxW) / 2;
    let y = canvas.height * 0.09;
    if (placement === 'center') y = (canvas.height - boxH) / 2;
    if (placement === 'bottom') y = canvas.height - boxH - canvas.height * 0.07;
    labelRect = { x, y, width: boxW, height: boxH };
  }

  roundedRect(labelRect.x, labelRect.y, labelRect.width, labelRect.height, canvas.width * 0.018);
  ctx.fillStyle = 'rgba(229, 27, 45, .95)';
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const totalTextHeight = lines.length * lineHeight;
  const firstY = labelRect.y + (labelRect.height - totalTextHeight) / 2 + lineHeight / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, labelRect.x + labelRect.width / 2, firstY + index * lineHeight);
  });
}

function eraseOldLabels() {
  for (const rect of state.redLabelRects) {
    const expanded = expandRect(rect, el.previewCanvas.width * 0.018, el.previewCanvas.width, el.previewCanvas.height);
    const color = sampleBorderColor(expanded);
    ctx.fillStyle = color;
    ctx.fillRect(expanded.x, expanded.y, expanded.width, expanded.height);
  }
}

function expandRect(rect, pad, maxWidth, maxHeight) {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const x2 = Math.min(maxWidth, rect.x + rect.width + pad);
  const y2 = Math.min(maxHeight, rect.y + rect.height + pad);
  return { ...rect, x, y, width: x2 - x, height: y2 - y };
}

function sampleBorderColor(rect) {
  const canvas = el.previewCanvas;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let r = 0, g = 0, b = 0, count = 0;
  const x1 = Math.max(0, Math.floor(rect.x));
  const y1 = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(canvas.width - 1, Math.ceil(rect.x + rect.width));
  const y2 = Math.min(canvas.height - 1, Math.ceil(rect.y + rect.height));
  const band = Math.max(4, Math.floor(canvas.width * 0.008));
  for (let y = Math.max(0, y1 - band); y <= Math.min(canvas.height - 1, y2 + band); y += 3) {
    for (let x = Math.max(0, x1 - band); x <= Math.min(canvas.width - 1, x2 + band); x += 3) {
      const onBorder = x < x1 || x > x2 || y < y1 || y > y2;
      if (!onBorder) continue;
      const i = (y * canvas.width + x) * 4;
      const rr = data[i], gg = data[i + 1], bb = data[i + 2];
      if (isLabelRed(rr, gg, bb)) continue;
      r += rr; g += gg; b += bb; count += 1;
    }
  }
  if (!count) return 'rgba(235, 232, 224, 1)';
  return `rgb(${Math.round(r/count)}, ${Math.round(g/count)}, ${Math.round(b/count)})`;
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

function addSuggestion(text, source, checked = true, zone = 'top') {
  const clean = normalizeDesignText(text);
  if (!clean) return;
  if (state.suggestions.some(item => norm(item.text) === norm(clean))) return;
  state.suggestions.push({ id: crypto.randomUUID(), text: clean, source, checked, zone });
}

function addWeightSuggestion(text, source) {
  addSuggestion(text, source, false, 'top');
}

function parsedRequestParts(text) {
  const clean = normalizeDesignText(text);
  const parts = { productStone: '', ringSize: '', material: '' };
  parts.ringSize = parseRingSize(clean);
  parts.material = parseMaterial(clean);
  let main = clean
    .replace(/\b(?:tay|size)\s*\d+(?:[,.]\d+)?(?:mm)?\b/ig, '')
    .replace(/\b(vàng vàng|vàng trắng|vàng hồng|vàng|bạc|bac)\s*(10K|14K|18K)?\b/ig, '')
    .replace(/\b(10K|14K|18K)\b/ig, '')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .replace(/\s+/g, ' ');
  parts.productStone = main;
  return parts;
}

function normalizeDesignText(text) {
  let clean = String(text || '').trim().replace(/\s+/g, ' ');
  clean = clean.replace(/\b(tay|size)\s*(\d+(?:[,.]\d+)?)(?:\s*mm)?\b/ig, (_, label, value) => {
    return `${label[0].toUpperCase()}${label.slice(1).toLowerCase()} ${value.replace(',', '.')}mm`;
  });
  clean = clean.replace(/\b(\d+(?:[,.]\d+)?)\s*mm\b/ig, (_, value) => `${value.replace(',', '.')}mm`);
  clean = clean.replace(/\b(10|14|18)\s*k\b/ig, '$1K');
  clean = clean.replace(/\bkhoảng\s+(?=\d)/ig, '');
  return clean;
}

function parseRingSize(text) {
  const match = String(text || '').match(/(?:tay|size)\s*(\d+(?:[,.]\d+)?)(?:\s*mm)?/i);
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
  const request = (el.requestInput.value.trim() || state.ocrText.trim());
  state.suggestions = [];
  const parsed = parsedRequestParts(request);
  addSuggestion(parsed.productStone, state.ocrText && !el.requestInput.value.trim() ? 'Đọc từ ảnh' : 'Yêu cầu khách');
  const ringSize = parsed.ringSize;
  if (ringSize && !state.selectedOrder?.ringSize) addSuggestion(`Tay ${ringSize}mm`, 'Tự nhận từ yêu cầu');
  const material = parsed.material;
  if (material && !state.selectedProduct && !state.selectedOrder) addSuggestion(material, 'Tự nhận từ yêu cầu');

  const order = state.selectedOrder;
  if (order) {
    addSuggestion(order.product, `Order ${order.orderId || ''}`);
    addSuggestion(order.material, 'Chất liệu từ order');
    if (order.ringSize) addSuggestion(`Tay ${order.ringSize}mm`, 'Size từ order');
    addSuggestion([order.stone, order.stoneSize || order.stone_size].filter(Boolean).join(' '), 'Đá từ order');
    addSuggestion(order.notes, 'Ghi chú order');
  }

  const product = state.selectedProduct;
  if (product) {
    addSuggestion(productName(product), 'Tên từ Product DB', false);
    addSuggestion(materialOf(product), 'Chất liệu từ Product DB', !material);
    if (product.gold_weight_raw) addWeightSuggestion(`TL vàng tham khảo ${product.gold_weight_raw}`, 'Trọng lượng từ Product DB');
    addSuggestion(stoneLine(product), 'Đá từ Product DB', false);
  }

  const avg = similarAverageWeight();
  if (avg && !product?.gold_weight_raw) addWeightSuggestion(`TL vàng tham khảo ${avg}`, 'Trung bình đơn cũ');
  addSuggestion('Thân nhẫn 1.4mm', 'Chuẩn Petite Gem', true, 'bottom');
  renderSuggestions();
}

function renderSuggestions() {
  el.suggestions.innerHTML = state.suggestions.map(item => `
    <label class="suggestion">
      <input type="checkbox" data-id="${item.id}" ${item.checked ? 'checked' : ''}>
      <span><strong>${escapeHtml(item.text)}</strong><span>${escapeHtml(item.source)}${item.zone === 'bottom' ? ' · nhãn dưới' : ''}</span></span>
    </label>
  `).join('');
  el.suggestions.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      const item = state.suggestions.find(s => s.id === input.dataset.id);
      if (item) item.checked = input.checked;
      state.lastBlob = null;
      el.shareBtn.disabled = true;
    });
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderResults(queryOverride = '') {
  const query = (queryOverride || el.searchInput.value || searchQueryFromRequest()).trim();
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
        <span>${imageUrlOf(product) ? 'DB ảnh' : 'DB'}</span>
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
  state.redLabelRects = detectRedLabelRects();
  state.photoFingerprint = await imageFingerprint(img);
  URL.revokeObjectURL(url);
  state.lastBlob = null;
  el.shareBtn.disabled = true;
  autoSearchFromPhoto(file);
  readTextFromPhoto();
}

async function imageFingerprint(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const imageCtx = canvas.getContext('2d', { willReadFrequently: true });
  imageCtx.drawImage(img, 0, 0, 8, 8);
  let data;
  try {
    data = imageCtx.getImageData(0, 0, 8, 8).data;
  } catch (error) {
    return null;
  }
  const values = [];
  for (let i = 0; i < data.length; i += 4) {
    values.push(Math.round((data[i] + data[i + 1] + data[i + 2]) / 3));
  }
  return values;
}

function isLabelRed(r, g, b) {
  return r > 160 && g < 90 && b < 115 && r > g * 1.7 && r > b * 1.45;
}

function detectRedLabelRects() {
  const canvas = el.previewCanvas;
  const width = canvas.width;
  const height = canvas.height;
  const data = ctx.getImageData(0, 0, width, height).data;
  const step = Math.max(2, Math.floor(Math.min(width, height) / 420));
  const gridW = Math.ceil(width / step);
  const gridH = Math.ceil(height / step);
  const red = new Uint8Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const x = Math.min(width - 1, gx * step);
      const y = Math.min(height - 1, gy * step);
      const i = (y * width + x) * 4;
      red[gy * gridW + gx] = isLabelRed(data[i], data[i + 1], data[i + 2]) ? 1 : 0;
    }
  }
  const seen = new Uint8Array(red.length);
  const rects = [];
  const queue = [];
  for (let idx = 0; idx < red.length; idx += 1) {
    if (!red[idx] || seen[idx]) continue;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0, count = 0;
    queue.length = 0;
    queue.push(idx);
    seen[idx] = 1;
    while (queue.length) {
      const current = queue.pop();
      const gx = current % gridW;
      const gy = Math.floor(current / gridW);
      count += 1;
      minX = Math.min(minX, gx);
      minY = Math.min(minY, gy);
      maxX = Math.max(maxX, gx);
      maxY = Math.max(maxY, gy);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
        const next = ny * gridW + nx;
        if (red[next] && !seen[next]) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    const rect = {
      x: minX * step,
      y: minY * step,
      width: (maxX - minX + 1) * step,
      height: (maxY - minY + 1) * step,
      area: count * step * step
    };
    if (rect.area > width * height * 0.006 && rect.width > width * 0.2 && rect.height > height * 0.035) {
      rects.push(rect);
    }
  }
  return mergeRects(rects, width, height)
    .sort((a, b) => a.y - b.y)
    .map(rect => ({ ...rect, zone: rect.y + rect.height / 2 > height * 0.58 ? 'bottom' : 'top' }))
    .slice(0, 3);
}

function mergeRects(rects, width, height) {
  const merged = [];
  for (const rect of rects.sort((a, b) => a.y - b.y)) {
    const expanded = expandRect(rect, Math.max(width, height) * 0.025, width, height);
    const hit = merged.find(existing => rectsOverlap(expanded, existing));
    if (hit) {
      const x1 = Math.min(hit.x, rect.x);
      const y1 = Math.min(hit.y, rect.y);
      const x2 = Math.max(hit.x + hit.width, rect.x + rect.width);
      const y2 = Math.max(hit.y + hit.height, rect.y + rect.height);
      hit.x = x1; hit.y = y1; hit.width = x2 - x1; hit.height = y2 - y1;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function fingerprintDistance(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum / a.length);
}

async function loadImageForFingerprint(src) {
  return await new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => resolve(await imageFingerprint(img));
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function autoSearchFromPhoto(file) {
  const imageProducts = state.products.filter(product => imageUrlOf(product));
  if (imageProducts.length && state.photoFingerprint) {
    el.dbStatus.textContent = 'Đang tự search DB theo ảnh...';
    const scored = [];
    for (const product of imageProducts.slice(0, 80)) {
      const fp = await loadImageForFingerprint(imageUrlOf(product));
      const distance = fingerprintDistance(state.photoFingerprint, fp);
      if (Number.isFinite(distance)) scored.push({ product, index: state.products.indexOf(product), distance });
    }
    scored.sort((a, b) => a.distance - b.distance);
    const best = scored[0];
    if (best) {
      state.selectedProduct = best.product;
      state.selectedOrder = null;
      el.selectedRef.hidden = false;
      el.selectedRef.textContent = `Tự chọn theo ảnh: ${productName(best.product)} · TL ${best.product.gold_weight_raw || '-'}`;
      el.results.innerHTML = scored.slice(0, 8).map(({ product, index }) => `
        <button class="result" type="button" data-kind="product" data-index="${index}">
          <span><strong>${escapeHtml(productName(product))}</strong><small>${escapeHtml([materialOf(product), product.gold_weight_raw ? `TL ${product.gold_weight_raw}` : '', stoneLine(product), product.productId].filter(Boolean).join(' · '))}</small></span>
          <span>Ảnh</span>
        </button>`).join('');
      el.results.querySelectorAll('.result').forEach(button => {
        button.addEventListener('click', () => selectReference(button.dataset.kind, Number(button.dataset.index)));
      });
      el.dbStatus.textContent = `Tự search ảnh: ${scored.length} kết quả`;
      rebuildSuggestions();
      return;
    }
  }

  const fallbackQuery = searchQueryFromRequest() || state.ocrText || file?.name?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') || '';
  if (fallbackQuery) {
    el.searchInput.value = fallbackQuery;
    renderResults(fallbackQuery);
    const firstProduct = searchProducts(fallbackQuery)[0];
    if (firstProduct) {
      state.selectedProduct = firstProduct.product;
      el.selectedRef.hidden = false;
      el.selectedRef.textContent = `Tự chọn theo yêu cầu: ${productName(firstProduct.product)} · TL ${firstProduct.product.gold_weight_raw || '-'}`;
    }
    rebuildSuggestions();
    el.dbStatus.textContent = imageProducts.length ? 'Tự search theo yêu cầu' : 'DB chưa có ảnh, tự search theo yêu cầu';
  }
}

async function readTextFromPhoto() {
  if (!window.Tesseract || !state.image) {
    return;
  }
  try {
    el.dbStatus.textContent = 'Đang đọc chữ trên ảnh...';
    const result = await window.Tesseract.recognize(el.previewCanvas, 'vie+eng');
    const text = normalizeOcrText(result?.data?.text || '');
    if (text) {
      state.ocrText = text;
      if (!el.requestInput.value.trim()) {
        el.requestInput.value = text;
      }
      const query = searchQueryFromRequest();
      if (query) renderResults(query);
      rebuildSuggestions();
      el.dbStatus.textContent = 'Đã đọc yêu cầu từ ảnh';
    } else {
      el.dbStatus.textContent = OFFLINE_OCR_NOTICE;
    }
  } catch (error) {
    el.dbStatus.textContent = OFFLINE_OCR_NOTICE;
  }
}

function normalizeOcrText(text) {
  return normalizeDesignText(String(text || '')
    .replace(/\n+/g, ', ')
    .replace(/[|_]+/g, ' ')
    .replace(/\b1O[Kk]\b/g, '10K')
    .replace(/\bI0[Kk]\b/g, '10K')
    .replace(/\s+/g, ' ')
    .trim());
}

function searchQueryFromRequest() {
  return normalizeDesignText(el.requestInput.value)
    .replace(/\bTay\s*\d+(?:\.\d+)?mm\b/ig, '')
    .replace(/\b(vàng vàng|vàng trắng|vàng hồng|vàng|bac|bạc)\s*(10K|14K|18K)?\b/ig, '')
    .replace(/\b(10K|14K|18K)\b/ig, '')
    .replace(/[,.]/g, ' ')
    .trim();
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
  state.photoFingerprint = null;
  state.redLabelRects = [];
  state.ocrText = '';
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
  el.requestInput._timer = setTimeout(() => {
    const query = searchQueryFromRequest();
    if (query) renderResults(query);
    rebuildSuggestions();
  }, 160);
});
el.rebuildBtn.addEventListener('click', rebuildSuggestions);
el.addCustomBtn.addEventListener('click', () => {
  const zone = norm(el.customInput.value).includes('than nhan') ? 'bottom' : 'top';
  addSuggestion(el.customInput.value, 'Thêm tay', true, zone);
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
