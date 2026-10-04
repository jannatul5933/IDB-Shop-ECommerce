require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');

const Product = require('./src/models/Product');
const User = require('./src/models/User');
const Cart = require('./src/models/Cart');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/idb_shop';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const uploadDir = path.join(__dirname, 'public', 'uploads');

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-z0-9.]/gi, '-').toLowerCase();
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  }
});

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'class-project-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/jquery', express.static(path.join(__dirname, 'node_modules/jquery/dist')));

io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  if (userId) {
    socket.join(`user:${userId}`);
  }
});

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Please login first.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ message: 'Admin login required.' });
  }
  next();
}

function cleanUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email
  };
}

async function getCartForUser(userId) {
  let cart = await Cart.findOne({ user: userId }).populate('items.product');
  if (!cart) {
    cart = await Cart.create({ user: userId, items: [] });
    cart = await cart.populate('items.product');
  }

  cart.items = cart.items.filter((item) => item.product);
  await cart.save();

  const items = cart.items.map((item) => ({
    product: item.product,
    quantity: item.quantity,
    lineTotal: item.quantity * item.product.price
  }));

  return {
    items,
    total: items.reduce((sum, item) => sum + item.lineTotal, 0)
  };
}

async function normalizeCartStock(userId) {
  const cart = await Cart.findOne({ user: userId }).populate('items.product');
  if (!cart) {
    return;
  }

  cart.items = cart.items
    .filter((item) => item.product && item.product.stock > 0)
    .map((item) => {
      item.quantity = Math.min(item.quantity, item.product.stock);
      return item;
    });

  await cart.save();
}

async function emitCart(userId) {
  const cart = await getCartForUser(userId);
  io.to(`user:${userId}`).emit('cart:updated', cart);
}

async function removeUploadedImage(imagePath) {
  if (!imagePath || !imagePath.startsWith('/uploads/')) {
    return;
  }

  await fs.promises.unlink(path.join(__dirname, 'public', imagePath)).catch(() => {});
}

function parseStock(value) {
  const stock = Number(value);
  return Number.isInteger(stock) && stock >= 0 ? stock : null;
}

function parsePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

app.get('/api/me', async (req, res) => {
  const result = {
    user: null,
    isAdmin: Boolean(req.session.isAdmin)
  };

  if (req.session.userId) {
    const user = await User.findById(req.session.userId);
    if (user) {
      result.user = cleanUser(user);
    }
  }

  res.json(result);
});

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ message: 'This email already has an account.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    email: email.toLowerCase(),
    passwordHash
  });

  req.session.userId = user._id.toString();
  res.status(201).json({ user: cleanUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email || '').toLowerCase() });

  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ message: 'Wrong email or password.' });
  }

  req.session.userId = user._id.toString();
  res.json({ user: cleanUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out.' });
  });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Wrong admin password.' });
  }

  req.session.isAdmin = true;
  res.json({ message: 'Admin logged in.' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ message: 'Admin logged out.' });
});

app.get('/api/products', async (req, res) => {
  const products = await Product.find().sort({ createdAt: -1 });
  res.json(products);
});

app.post('/api/products', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, price, stock, description } = req.body;
  const parsedPrice = parsePrice(price);
  const parsedStock = parseStock(stock);

  if (!name || parsedPrice === null || parsedStock === null) {
    return res.status(400).json({ message: 'Product name, valid price, and valid stock are required.' });
  }

  const product = await Product.create({
    name,
    price: parsedPrice,
    stock: parsedStock,
    image: req.file ? `/uploads/${req.file.filename}` : '',
    description
  });

  io.emit('products:changed');
  res.status(201).json(product);
});

app.put('/api/products/:id', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, price, stock, description } = req.body;
  const parsedPrice = parsePrice(price);
  const parsedStock = parseStock(stock);
  const existingProduct = await Product.findById(req.params.id);
  if (!existingProduct) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  if (!name || parsedPrice === null || parsedStock === null) {
    return res.status(400).json({ message: 'Product name, valid price, and valid stock are required.' });
  }

  const update = {
    name,
    price: parsedPrice,
    stock: parsedStock,
    description
  };

  if (req.file) {
    update.image = `/uploads/${req.file.filename}`;
  }

  const product = await Product.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true
  });

  if (req.file) {
    await removeUploadedImage(existingProduct.image);
  }

  if (product.stock < existingProduct.stock) {
    const carts = await Cart.find({ 'items.product': product._id });
    await Promise.all(carts.map((cart) => normalizeCartStock(cart.user)));
    io.emit('cart:refresh');
  }

  io.emit('products:changed');
  res.json(product);
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  await removeUploadedImage(product.image);
  await Cart.updateMany({}, { $pull: { items: { product: req.params.id } } });
  io.emit('products:changed');
  io.emit('cart:refresh');
  res.json({ message: 'Product deleted.' });
});

app.get('/api/cart', requireUser, async (req, res) => {
  res.json(await getCartForUser(req.session.userId));
});

app.post('/api/cart/:productId', requireUser, async (req, res) => {
  const product = await Product.findById(req.params.productId);
  if (!product) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  if (product.stock <= 0) {
    return res.status(400).json({ message: 'This product is out of stock.' });
  }

  const change = Number(req.body.change || 1);
  let cart = await Cart.findOne({ user: req.session.userId });
  if (!cart) {
    cart = await Cart.create({ user: req.session.userId, items: [] });
  }

  const item = cart.items.find((entry) => entry.product.toString() === req.params.productId);
  if (item) {
    item.quantity += change;
  } else if (change > 0) {
    cart.items.push({ product: req.params.productId, quantity: change });
  }

  const updatedItem = cart.items.find((entry) => entry.product.toString() === req.params.productId);
  if (updatedItem && updatedItem.quantity > product.stock) {
    updatedItem.quantity = product.stock;
  }

  cart.items = cart.items.filter((entry) => entry.quantity > 0);
  await cart.save();
  await emitCart(req.session.userId);

  res.json(await getCartForUser(req.session.userId));
});

app.post('/api/buy/:productId', requireUser, async (req, res) => {
  const product = await Product.findById(req.params.productId);
  if (!product) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  if (product.stock < 1) {
    return res.status(400).json({ message: 'This product is out of stock.' });
  }

  product.stock -= 1;
  await product.save();

  await normalizeCartStock(req.session.userId);
  await emitCart(req.session.userId);
  io.emit('products:changed');
  io.emit('cart:refresh');

  res.json({ message: `You bought ${product.name}.`, product });
});

app.post('/api/checkout', requireUser, async (req, res) => {
  const cart = await Cart.findOne({ user: req.session.userId }).populate('items.product');
  if (!cart || !cart.items.length) {
    return res.status(400).json({ message: 'Your cart is empty.' });
  }

  for (const item of cart.items) {
    if (!item.product) {
      return res.status(400).json({ message: 'One product in your cart is no longer available.' });
    }

    if (item.quantity > item.product.stock) {
      return res.status(400).json({
        message: `${item.product.name} has only ${item.product.stock} left in stock.`
      });
    }
  }

  const purchasedItems = [];
  for (const item of cart.items) {
    item.product.stock -= item.quantity;
    await item.product.save();
    purchasedItems.push({
      name: item.product.name,
      quantity: item.quantity
    });
  }

  cart.items = [];
  await cart.save();

  await emitCart(req.session.userId);
  io.emit('products:changed');
  io.emit('cart:refresh');

  res.json({
    message: 'Purchase completed.',
    items: purchasedItems
  });
});

async function start() {
  await mongoose.connect(MONGO_URI);
  await Product.updateMany({ stock: { $exists: false } }, { $set: { stock: 10 } });

  server.listen(PORT, () => {
    console.log(`IDB Shop running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
