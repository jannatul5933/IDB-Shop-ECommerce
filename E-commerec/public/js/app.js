const socket = io();

let currentUser = null;

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showMessage(text) {
  $('#message').text(text || '');
}

function formData($form) {
  return Object.fromEntries(new FormData($form[0]).entries());
}

function request(url, options = {}) {
  return $.ajax({
    url,
    method: options.method || 'GET',
    contentType: 'application/json',
    data: options.data ? JSON.stringify(options.data) : undefined
  });
}

function setUser(user) {
  currentUser = user;
  if (user) {
    $('#authPanel').addClass('is-hidden');
    $('#userPanel').removeClass('is-hidden');
    $('#userName').text(user.name);
    loadCart();
    return;
  }

  $('#authPanel').removeClass('is-hidden');
  $('#userPanel').addClass('is-hidden');
  renderCart({ items: [], total: 0 });
}

function productImage(product) {
  if (product.image) {
    return `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">`;
  }

  return `<div class="product-image-fallback">${escapeHtml(product.name || 'Product')}</div>`;
}

function loadProducts() {
  request('/api/products')
    .done((products) => {
      $('#productCount').text(`${products.length} items`);
      if (!products.length) {
        $('#products').html('<div class="panel">No products yet. Add products from the admin panel.</div>');
        return;
      }

      $('#products').html(products.map((product) => `
        <article class="product-card">
          ${productImage(product)}
          <div class="product-body">
            <h3>${escapeHtml(product.name)}</h3>
            <p>${escapeHtml(product.description || 'Simple product for your shop.')}</p>
            <p class="price">${money(product.price)}</p>
            <p class="stock-label">${product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}</p>
            <div class="product-actions">
              <button class="add-cart" data-id="${product._id}" ${product.stock <= 0 ? 'disabled' : ''}>Add to Cart</button>
              <button class="buy-now secondary" data-id="${product._id}" ${product.stock <= 0 ? 'disabled' : ''}>Buy Now</button>
            </div>
          </div>
        </article>
      `).join(''));
    });
}

function loadCart() {
  if (!currentUser) {
    return;
  }

  request('/api/cart')
    .done(renderCart)
    .fail(() => renderCart({ items: [], total: 0 }));
}

function renderCart(cart) {
  $('#cartTotal').text(money(cart.total));

  if (!currentUser) {
    $('#cartItems').html('<p class="muted">Login to start shopping.</p>');
    $('#buyCartBtn').remove();
    return;
  }

  if (!cart.items.length) {
    $('#cartItems').html('<p class="muted">Your cart is empty.</p>');
    $('#buyCartBtn').remove();
    return;
  }

  $('#cartItems').html(cart.items.map((item) => `
    <div class="cart-line">
      <div>
        <strong>${escapeHtml(item.product.name)}</strong>
        <div class="muted">${money(item.product.price)} each</div>
        <div class="muted">Stock left: ${Number(item.product.stock || 0)}</div>
      </div>
      <div class="cart-controls">
        <button class="cart-change secondary" data-id="${item.product._id}" data-change="-1">-</button>
        <span>${item.quantity}</span>
        <button class="cart-change" data-id="${item.product._id}" data-change="1" ${item.quantity >= item.product.stock ? 'disabled' : ''}>+</button>
      </div>
    </div>
  `).join(''));

  if (!$('#buyCartBtn').length) {
    $('#cartItems').after('<button id="buyCartBtn" class="buy-cart">Buy Cart</button>');
  }
}

function changeCart(productId, change) {
  if (!currentUser) {
    showMessage('Please login before adding products to cart.');
    return;
  }

  request(`/api/cart/${productId}`, {
    method: 'POST',
    data: { change }
  })
    .done(renderCart)
    .fail((xhr) => showMessage(xhr.responseJSON?.message || 'Cart update failed.'));
}

$('#registerForm').on('submit', function (event) {
  event.preventDefault();
  request('/api/register', {
    method: 'POST',
    data: formData($(this))
  })
    .done((data) => {
      this.reset();
      showMessage('');
      setUser(data.user);
    })
    .fail((xhr) => showMessage(xhr.responseJSON?.message || 'Registration failed.'));
});

$('#loginForm').on('submit', function (event) {
  event.preventDefault();
  request('/api/login', {
    method: 'POST',
    data: formData($(this))
  })
    .done((data) => {
      this.reset();
      showMessage('');
      setUser(data.user);
    })
    .fail((xhr) => showMessage(xhr.responseJSON?.message || 'Login failed.'));
});

$('#logoutBtn').on('click', () => {
  request('/api/logout', { method: 'POST' }).done(() => {
    setUser(null);
    showMessage('');
  });
});

$('#products').on('click', '.add-cart', function () {
  changeCart($(this).data('id'), 1);
});

$('#products').on('click', '.buy-now', function () {
  if (!currentUser) {
    showMessage('Please login before buying products.');
    return;
  }

  request(`/api/buy/${$(this).data('id')}`, { method: 'POST' })
    .done((data) => {
      showMessage(data.message);
      loadProducts();
      loadCart();
    })
    .fail((xhr) => showMessage(xhr.responseJSON?.message || 'Purchase failed.'));
});

$('#cartItems').on('click', '.cart-change', function () {
  changeCart($(this).data('id'), Number($(this).data('change')));
});

$(document).on('click', '#buyCartBtn', function () {
  request('/api/checkout', { method: 'POST' })
    .done((data) => {
      showMessage(data.message);
      loadProducts();
      loadCart();
    })
    .fail((xhr) => showMessage(xhr.responseJSON?.message || 'Purchase failed.'));
});

socket.on('products:changed', loadProducts);
socket.on('cart:updated', renderCart);
socket.on('cart:refresh', loadCart);

request('/api/me').done((data) => {
  setUser(data.user);
  loadProducts();
});
