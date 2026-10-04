const socket = io();
let productsById = {};

function showAdminMessage(text) {
  $('#adminMessage').text(text || '');
}

function formData($form) {
  return Object.fromEntries(new FormData($form[0]).entries());
}

function multipartData($form) {
  return new FormData($form[0]);
}

function request(url, options = {}) {
  const config = {
    url,
    method: options.method || 'GET'
  };

  if (options.multipart) {
    config.data = options.data;
    config.processData = false;
    config.contentType = false;
  } else {
    config.contentType = 'application/json';
    config.data = options.data ? JSON.stringify(options.data) : undefined;
  }

  return $.ajax(config);
}

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

function setAdmin(isAdmin) {
  $('#adminLoginPanel').toggleClass('is-hidden', isAdmin);
  $('#adminWorkPanel').toggleClass('is-hidden', !isAdmin);
  if (isAdmin) {
    loadProducts();
  }
}

function resetForm() {
  $('#productForm')[0].reset();
  $('#productForm [name="id"]').val('');
  $('#productForm [name="stock"]').val(10);
  $('#formTitle').text('Add Product');
}

function productThumb(product) {
  if (!product.image) {
    return '<div class="admin-thumb empty-thumb">No Image</div>';
  }

  return `<img class="admin-thumb" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">`;
}

function loadProducts() {
  request('/api/products').done((products) => {
    productsById = Object.fromEntries(products.map((product) => [product._id, product]));

    if (!products.length) {
      $('#adminProducts').html('<p class="muted">No products yet.</p>');
      return;
    }

    $('#adminProducts').html(products.map((product) => `
      <article class="admin-product">
        ${productThumb(product)}
        <div>
          <h3>${escapeHtml(product.name)}</h3>
          <div class="price">${money(product.price)}</div>
          <div class="stock-label">Stock: ${Number(product.stock || 0)}</div>
          <p class="muted">${escapeHtml(product.description || 'No description')}</p>
        </div>
        <div class="admin-actions">
          <button class="edit-product secondary" data-id="${product._id}">Edit</button>
          <button class="delete-product danger" data-id="${product._id}">Delete</button>
        </div>
      </article>
    `).join(''));
  });
}

$('#adminLoginForm').on('submit', function (event) {
  event.preventDefault();
  request('/api/admin/login', {
    method: 'POST',
    data: formData($(this))
  })
    .done(() => {
      this.reset();
      showAdminMessage('');
      setAdmin(true);
    })
    .fail((xhr) => showAdminMessage(xhr.responseJSON?.message || 'Admin login failed.'));
});

$('#adminLogoutBtn').on('click', () => {
  request('/api/admin/logout', { method: 'POST' }).done(() => {
    resetForm();
    setAdmin(false);
  });
});

$('#productForm').on('submit', function (event) {
  event.preventDefault();
  const id = $('#productForm [name="id"]').val();
  const data = multipartData($(this));
  data.delete('id');

  request(id ? `/api/products/${id}` : '/api/products', {
    method: id ? 'PUT' : 'POST',
    data,
    multipart: true
  })
    .done(() => {
      resetForm();
      showAdminMessage('Product saved.');
      loadProducts();
    })
    .fail((xhr) => showAdminMessage(xhr.responseJSON?.message || 'Product save failed.'));
});

$('#cancelEditBtn').on('click', resetForm);

$('#adminProducts').on('click', '.edit-product', function () {
  const product = productsById[$(this).data('id')];
  if (!product) {
    return;
  }

  $('#formTitle').text('Update Product');
  $('#productForm [name="id"]').val(product._id);
  $('#productForm [name="name"]').val(product.name);
  $('#productForm [name="price"]').val(product.price);
  $('#productForm [name="stock"]').val(product.stock || 0);
  $('#productForm [name="description"]').val(product.description || '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('#adminProducts').on('click', '.delete-product', function () {
  if (!confirm('Delete this product?')) {
    return;
  }

  request(`/api/products/${$(this).data('id')}`, { method: 'DELETE' })
    .done(() => {
      showAdminMessage('Product deleted.');
      loadProducts();
    })
    .fail((xhr) => showAdminMessage(xhr.responseJSON?.message || 'Delete failed.'));
});

socket.on('products:changed', loadProducts);

request('/api/me').done((data) => setAdmin(data.isAdmin));
