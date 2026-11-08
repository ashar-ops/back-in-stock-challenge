'use strict';

(() => {
  const grid = document.getElementById('product-grid');
  const message = document.getElementById('catalogue-message');
  const retry = document.getElementById('catalogue-retry');
  const count = document.getElementById('product-count');
  const frame = document.getElementById('alert-frame');
  const selectedTitle = document.getElementById('signup-title');
  const selectedDescription = document.getElementById('selection-description');
  const filters = [...document.querySelectorAll('[data-stock]')];
  let products = [];
  let stockFilter = 'all';
  let selectedSku = new URLSearchParams(window.location.search).get('sku')?.trim() || '';
  let loading = false;
  let loaded = false;
  selectedDescription.setAttribute('aria-live', 'polite');
  selectedTitle.tabIndex = -1;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function icon(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/assets/brand.svg#${name}`);
    svg.append(use);
    return svg;
  }

  // Artwork is selected from our authored local sprite, never from an API URL.
  function artwork(product) {
    const text = `${product.name} ${product.category}`.toLowerCase();
    if (/headphone|earbud|audio|speaker|electronic|tech/.test(text)) return ['headphones', 'lilac'];
    if (/sneaker|shoe|footwear|trainer|boot/.test(text)) return ['shoe', 'slate'];
    if (/weekender/.test(text)) return ['weekender', 'sand'];
    if (/bag|tote|backpack|satchel/.test(text)) return ['bag', 'sage'];
    if (/bottle|flask|tumbler/.test(text)) return ['bottle', 'sage'];
    if (/socks/.test(text)) return ['socks', 'sand'];
    if (/\bcap\b/.test(text)) return ['cap', 'sage'];
    if (/hoodie/.test(text)) return ['hoodie', 'slate'];
    if (/shirt|sweater|\btee\b|apparel|clothing|jacket|cotton|linen|fashion/.test(text)) return ['apparel', 'sand'];
    if (/mug/.test(text)) return ['mug', 'sage'];
    if (/knife/.test(text)) return ['knife', 'sand'];
    if (/skillet|\bpan\b/.test(text)) return ['pan', 'slate'];
    if (/grinder/.test(text)) return ['grinder', 'slate'];
    if (/beans/.test(text)) return ['beans', 'sand'];
    if (/kettle/.test(text)) return ['kettle', 'slate'];
    if (/candle/.test(text)) return ['candle', 'clay'];
    if (/throw|blanket/.test(text)) return ['throw', 'sand'];
    if (/monstera|plant/.test(text)) return ['plant', 'sage'];
    if (/fountain pen/.test(text)) return ['pen', 'slate'];
    if (/watch|jewelry|jewellery|accessor/.test(text)) return ['watch', 'sand'];
    if (/lamp|light/.test(text)) return ['lamp', 'sage'];
    if (/chair|furniture|stool/.test(text)) return ['chair', 'sand'];
    if (/book|journal|notebook|stationery/.test(text)) return ['book', 'sage'];
    if (/mug|cup|vase|ceramic|home|kitchen|pottery|decor/.test(text)) return ['ceramic', 'clay'];
    return ['generic', 'sand'];
  }

  function price(product) {
    if (product.price === null || product.price === '' || !Number.isFinite(Number(product.price))) return 'Price unavailable';
    const amount = Number(product.price);
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: String(product.currency) }).format(amount);
    } catch {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount);
    }
  }

  function updateSelection(product, moveToForm = false) {
    if (product) selectedSku = product.sku;
    const params = new URLSearchParams();
    if (selectedSku) params.set('sku', selectedSku);
    const nextSource = `/embed${params.size ? `?${params}` : ''}`;
    if (frame.getAttribute('src') !== nextSource) frame.setAttribute('src', nextSource);
    selectedTitle.textContent = product ? product.name : selectedSku ? 'Your chosen product' : 'Pick a piece, leave the rest to us.';
    selectedDescription.textContent = product
      ? `${product.sku} · ${product.in_stock ? 'Currently in stock; availability can change.' : 'We’ll watch for its return.'}`
      : selectedSku ? `SKU: ${selectedSku}` : 'Select a product, or enter a SKU below.';
    for (const card of grid.children) {
      const selected = card.dataset.sku === selectedSku;
      card.classList.toggle('is-selected', selected);
      const button = card.querySelector('.product-select');
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('span').textContent = selected ? 'Selected for alert' : 'Set a stock alert';
    }
    if (product) {
      const url = new URL(window.location.href);
      url.searchParams.set('sku', selectedSku);
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    if (moveToForm && window.matchMedia('(max-width: 760px)').matches) {
      selectedTitle.focus({ preventScroll: true });
      selectedTitle.closest('.signup-panel').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  }

  function productCard(product) {
    const card = element('article', 'product-card');
    card.dataset.sku = product.sku;
    const [symbol, theme] = artwork(product);
    const art = element('div', `product-art theme-${theme}`);
    const illustration = icon(symbol, 'product-illustration');
    illustration.setAttribute('viewBox', '0 0 320 260');
    art.append(illustration, element('span', `stock-badge${product.in_stock ? ' in-stock' : ''}`, product.in_stock ? 'In stock' : 'Out of stock'));
    const details = element('div', 'product-details');
    details.append(element('p', 'product-category', product.category || 'The Restock edit'), element('h3', 'product-title', product.name));
    const meta = element('div', 'product-meta');
    meta.append(element('span', 'product-price', price(product)), element('span', 'product-sku', product.sku));
    const button = element('button', 'product-select');
    button.type = 'button';
    button.setAttribute('aria-label', `Set a stock alert for ${product.name}, SKU ${product.sku}`);
    button.setAttribute('aria-pressed', String(product.sku === selectedSku));
    button.append(element('span', '', product.sku === selectedSku ? 'Selected for alert' : 'Set a stock alert'), icon('bell'));
    button.addEventListener('click', () => updateSelection(product, true));
    details.append(meta, button);
    card.append(art, details);
    card.classList.toggle('is-selected', product.sku === selectedSku);
    return card;
  }

  function showMessage(title, description) {
    message.replaceChildren(element('strong', '', title), element('p', '', description));
    message.hidden = false;
  }

  function render() {
    if (!loaded) return;
    const visible = products.filter(product => stockFilter === 'all' || (stockFilter === 'in' ? product.in_stock : !product.in_stock));
    const fragment = document.createDocumentFragment();
    visible.forEach(product => fragment.append(productCard(product)));
    grid.replaceChildren(fragment);
    count.textContent = `${visible.length} ${visible.length === 1 ? 'piece' : 'pieces'}`;
    message.hidden = visible.length > 0;
    if (!visible.length) showMessage(products.length ? 'Nothing in this view, for now.' : 'The collection is taking a little pause.', products.length ? 'Try another availability filter. You can still enter a product SKU in the alert form.' : 'If you already know your product SKU, the alert form is still ready for you.');
  }

  async function loadCatalogue() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    grid.setAttribute('aria-busy', 'true');
    count.textContent = 'Loading collection…';
    message.replaceChildren(element('span', 'loading-ring'), element('p', '', 'Finding your next favorite…'));
    message.firstElementChild.setAttribute('aria-hidden', 'true');
    message.hidden = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/catalog', { headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.products)) throw new Error('Catalogue unavailable');
      products = data.products.filter(product => product && typeof product.sku === 'string' && typeof product.name === 'string' && typeof product.in_stock === 'boolean');
      if (data.products.length && !products.length) throw new Error('Invalid catalogue');
      loaded = true;
      const requestedProduct = products.find(product => product.sku.toLowerCase() === selectedSku.toLowerCase());
      if (requestedProduct) selectedSku = requestedProduct.sku;
      render();
      updateSelection(requestedProduct);
    } catch {
      loaded = false;
      count.textContent = 'Collection unavailable';
      showMessage('A brief pause in browsing.', 'We couldn’t load the collection. Try again, or use the alert form with a product SKU you already know.');
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      loading = false;
      grid.setAttribute('aria-busy', 'false');
    }
  }

  filters.forEach(button => button.addEventListener('click', () => {
    stockFilter = button.dataset.stock;
    filters.forEach(filter => {
      const active = filter === button;
      filter.classList.toggle('is-active', active);
      filter.setAttribute('aria-pressed', String(active));
    });
    render();
  }));
  retry.addEventListener('click', loadCatalogue);
  updateSelection();
  loadCatalogue();
})();
